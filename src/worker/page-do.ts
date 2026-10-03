import { DurableObject } from 'cloudflare:workers';
import type { BoardContent, HistoryDelta, Snapshot } from '../shared/delta';
import type { OpsMsg, ServerMsg } from '../shared/protocol';
import { applyDeltas, readBoard, type Sanitized, sanitizeDeltas } from './apply-ops';
import { SanitizeError } from './sanitize';
import { exceedsBytes, MAX_OP_BYTES, parseDeltas, parseId, RejectError } from './validate';

const MAX_SUMMARY_LENGTH = 500;
/** 受信メッセージの上限（文字数）。1 回の ops に入る text の合計の上限より少し大きくしている */
const MAX_MESSAGE_LENGTH = 2_000_000;
/** 再接続時に差分で返す ops の数の上限。これより離れていたらスナップショットを返す */
const MAX_REPLAY_OPS = 500;
/** 同じく、差分の合計の大きさ（文字数）の上限。大きな text の更新が続いた場合に効く */
const MAX_REPLAY_LENGTH = 4_000_000;

/** Worker が WebSocket の接続要求を DO へ転送するときに、認証済みの主体を入れるヘッダー */
export const ACTOR_HEADER = 'X-Wema-Actor';
/** 同じく、認証の期限（UNIX 秒）を入れるヘッダー。期限がなければ付けない */
export const AUTH_EXPIRES_HEADER = 'X-Wema-Auth-Expires';

/** 認証の期限が切れた接続を閉じるときのコード。クライアントは再読み込みして認証し直す */
const CLOSE_AUTH_EXPIRED = 4401;

/** 接続ごとに持つ情報。Hibernation から復帰しても残る */
interface Attachment {
  actor: string;
  /**
   * 認証の期限（UNIX 秒）。接続は開いたままになるので、接続時の認証を期限なく使い続けないよう、
   * これを過ぎたら受信も配信もせずに閉じる
   */
  expiresAt?: number;
  /** hello を受けるまで未設定。未設定の接続には配信しない */
  clientId?: string;
}

function isExpired(attachment: Attachment): boolean {
  return attachment.expiresAt !== undefined && Date.now() >= attachment.expiresAt * 1000;
}

type OpsHead = Omit<OpsMsg, 'deltas' | 'fixups'>;

export interface ApplyInput {
  /** 'user:<email>' / 'agent:<client>'。呼び出し側（Worker）が認証結果から決める */
  actor: string;
  clientId: string;
  opId: string;
  /** 外から来た値をそのまま渡す。検証は applyOps が行う */
  deltas: unknown;
  summary?: string;
}

export type ApplyResult =
  | {
      ok: true;
      seq: number;
      /** 適用して記録したデルタ。全員に配信する。すべて捨てた場合は空で、seq は進まない */
      deltas: HistoryDelta[];
      /** 送信元だけが追加で適用するデルタ（サニタイズで変わった text など） */
      fixups: HistoryDelta[];
      /**
       * 接続中のクライアントへ配信したか。配信しないのは、同じ opId の再送（適用済み）と、
       * デルタをすべて捨てた場合。WebSocket の送信元には、このとき個別に確定を返す
       */
      broadcast: boolean;
    }
  | { ok: false; reason: string; current?: BoardContent };

const META_TABLE = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`;

/** 添字 + 1 がスキーマのバージョン。変更は末尾に足し、既存の要素は書き換えない */
const MIGRATIONS = [
  `
CREATE TABLE notes (
  id         TEXT PRIMARY KEY,
  x REAL NOT NULL, y REAL NOT NULL,
  width REAL NOT NULL, height REAL NOT NULL,
  text       TEXT NOT NULL,
  color      TEXT NOT NULL,
  z_index    INTEGER NOT NULL,
  auto_size  INTEGER NOT NULL DEFAULT 0,
  extra      TEXT,
  created_by TEXT,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

CREATE TABLE edges (
  id         TEXT PRIMARY KEY,
  from_id    TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  to_id      TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  props      TEXT NOT NULL,
  created_by TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE ops (
  seq         INTEGER PRIMARY KEY,
  actor       TEXT NOT NULL,
  client_id   TEXT NOT NULL,
  op_id       TEXT NOT NULL,
  body        TEXT NOT NULL,
  fixups      TEXT,
  summary     TEXT,
  reverted_by INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE INDEX edges_from ON edges (from_id);
CREATE INDEX edges_to ON edges (to_id);
CREATE UNIQUE INDEX ops_client_op ON ops (actor, client_id, op_id);

INSERT INTO meta (key, value) VALUES ('seq', '0');
`,
];

/** ページ 1 つ分の付箋・接続線・操作履歴を持つ */
export class PageDO extends DurableObject<Env> {
  /** 適用済みのスキーマのバージョン。0 は一度も書き込まれていないページ */
  private version: number;

  /** 処理中の applyOps。次の呼び出しはこれが終わってから始める */
  private applyQueue: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // 接続維持の ping には DO を起こさずに応答する
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    this.version = this.readVersion();
    // 書き込みのないページには何も保存しない（存在しないスラッグを開いただけで
    // ストレージが残らないようにする）。スキーマは最初の書き込みで作る
    if (this.version > 0) this.migrate();
  }

  private get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  private readVersion(): number {
    const hasMeta = this.sql
      .exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'`)
      .toArray().length;
    if (!hasMeta) return 0;
    const row = this.sql.exec(`SELECT value FROM meta WHERE key = 'version'`).toArray()[0];
    return row ? Number(row.value) : 0;
  }

  private migrate(): void {
    if (this.version >= MIGRATIONS.length) return;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(META_TABLE);
      for (const migration of MIGRATIONS.slice(this.version)) {
        this.sql.exec(migration);
      }
      this.sql.exec(
        `INSERT OR REPLACE INTO meta (key, value) VALUES ('version', ?)`,
        String(MIGRATIONS.length),
      );
    });
    this.version = MIGRATIONS.length;
  }

  /** スキーマがある（version > 0）ときだけ呼ぶ */
  private getSeq(): number {
    return Number(this.sql.exec(`SELECT value FROM meta WHERE key = 'seq'`).one().value);
  }

  getSnapshot(): Snapshot {
    if (this.version === 0) return { seq: 0, data: { version: 1, notes: [], edges: [] } };
    return { seq: this.getSeq(), data: readBoard(this.sql) };
  }

  /**
   * 唯一の書き込み口。ブラウザ（WebSocket）からも MCP からも、これを通して変更する。
   *
   * サニタイズは非同期で、かかる時間が text によって違う。待っている間に後続の呼び出しが
   * 先に保存まで進むと、同じクライアントの操作が送信順に適用されなくなる（作成より先に
   * その付箋の更新が処理されるなど）ので、呼び出しを 1 つずつ順に処理する。
   */
  applyOps(input: ApplyInput): Promise<ApplyResult> {
    const result = this.applyQueue.then(() => this.applyOpsInOrder(input));
    // 結果（大きなデルタを含む）を次の呼び出しまで掴まないよう、値を捨てて繋ぐ
    this.applyQueue = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private async applyOpsInOrder(input: ApplyInput): Promise<ApplyResult> {
    let deltas: HistoryDelta[];
    let sanitized: Sanitized;
    try {
      parseId(input.clientId, 'clientId');
      parseId(input.opId, 'opId');
      deltas = parseDeltas(input.deltas);
      sanitized = await sanitizeDeltas(deltas);
    } catch (e) {
      if (e instanceof RejectError || e instanceof SanitizeError) {
        return { ok: false, reason: e.message };
      }
      throw e;
    }

    this.migrate();

    // 再接続後の再送。適用済みの結果をそのまま返す
    const done = this.sql
      .exec(
        // clientId はクライアントの自己申告なので、主体も合わせて同じ送信元かを判定する
        `SELECT seq, body, fixups FROM ops WHERE actor = ? AND client_id = ? AND op_id = ?`,
        input.actor, input.clientId, input.opId,
      )
      .toArray()[0];
    if (done) {
      return {
        ok: true,
        seq: done.seq as number,
        deltas: JSON.parse(done.body as string),
        fixups: done.fixups ? JSON.parse(done.fixups as string) : [],
        broadcast: false,
      };
    }

    const summary = input.summary?.slice(0, MAX_SUMMARY_LENGTH);
    let deliver: (() => void) | undefined;
    try {
      const result = this.ctx.storage.transactionSync((): ApplyResult => {
        const now = Date.now();
        const applied = applyDeltas(this.sql, deltas, input.actor, now, sanitized.cleanBefore);
        const fixups = [...sanitized.fixups, ...applied.fixups];
        if (applied.deltas.length === 0) {
          return { ok: true, seq: this.getSeq(), deltas: [], fixups, broadcast: false };
        }
        const body = JSON.stringify(applied.deltas);
        const fixupsJson = fixups.length > 0 ? JSON.stringify(fixups) : null;
        if (exceedsBytes(body + (fixupsJson ?? ''), MAX_OP_BYTES)) {
          throw new RejectError('operation too large');
        }
        const seq = this.getSeq() + 1;
        this.sql.exec(`UPDATE meta SET value = ? WHERE key = 'seq'`, String(seq));
        this.sql.exec(
          `INSERT INTO ops (seq, actor, client_id, op_id, body, fixups, summary, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          seq, input.actor, input.clientId, input.opId, body, fixupsJson, summary ?? null, now,
        );
        const head: OpsHead = {
          type: 'ops', seq, actor: input.actor, clientId: input.clientId, opId: input.opId, summary,
        };
        // fixups は送信元にだけ付ける
        deliver = () =>
          this.broadcast(opsJson(head, body, null), {
            actor: input.actor,
            clientId: input.clientId,
            toSender: opsJson(head, body, fixupsJson),
          });
        return { ok: true, seq, deltas: applied.deltas, fixups, broadcast: true };
      });
      // トランザクションが確定してから配信する。保存と同じ同期の区間なので、順序は seq の順になる
      deliver?.();
      return result;
    } catch (e) {
      if (e instanceof RejectError) return { ok: false, reason: e.message, current: e.current };
      throw e;
    }
  }

  // --- WebSocket ---

  /** Worker が認証を済ませ、主体を ACTOR_HEADER に入れて転送してくる */
  async fetch(request: Request): Promise<Response> {
    const actor = request.headers.get(ACTOR_HEADER);
    if (!actor) return new Response('missing actor', { status: 400 });

    const expires = request.headers.get(AUTH_EXPIRES_HEADER);
    const expiresAt = expires === null ? undefined : Number(expires);

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ actor, expiresAt } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string' || message.length > MAX_MESSAGE_LENGTH) {
      ws.close(1009, 'message too large');
      return;
    }
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(message);
    } catch {
      ws.close(1007, 'invalid json');
      return;
    }
    if (typeof msg !== 'object' || msg === null) return;

    const attachment = ws.deserializeAttachment() as Attachment;
    if (isExpired(attachment)) {
      ws.close(CLOSE_AUTH_EXPIRED, 'authentication expired');
      return;
    }
    if (msg.type === 'hello') {
      this.onHello(ws, attachment, msg);
    } else if (msg.type === 'ops') {
      await this.onOps(ws, attachment, msg);
    }
  }

  /** 接続直後の同期。`lastSeq` 以降の ops が残っていれば差分を、なければスナップショットを返す */
  private onHello(ws: WebSocket, attachment: Attachment, msg: Record<string, unknown>): void {
    let clientId: string;
    try {
      clientId = parseId(msg.clientId, 'clientId');
    } catch {
      ws.close(1008, 'invalid clientId');
      return;
    }
    // これ以降、この接続は配信の対象になる
    ws.serializeAttachment({ ...attachment, clientId } satisfies Attachment);

    const { lastSeq } = msg;
    if (!this.canReplay(lastSeq)) {
      send(ws, JSON.stringify({ type: 'snapshot', ...this.getSnapshot() } satisfies ServerMsg));
      return;
    }
    const rows = this.sql.exec(
      `SELECT seq, actor, client_id, op_id, body, fixups, summary FROM ops
       WHERE seq > ? ORDER BY seq`,
      lastSeq,
    );
    for (const row of rows) {
      const head: OpsHead = {
        type: 'ops',
        seq: row.seq as number,
        actor: row.actor as string,
        clientId: row.client_id as string,
        opId: row.op_id as string,
        summary: (row.summary as string | null) ?? undefined,
      };
      // 自分の操作の確定を受け取る前に切断していた場合は、fixups も返す
      const own = head.clientId === clientId && head.actor === attachment.actor;
      const fixups = own ? (row.fixups as string | null) : null;
      send(ws, opsJson(head, row.body as string, fixups));
    }
  }

  /** `lastSeq` 以降の変更を、差分（ops の再送）で返せるか */
  private canReplay(lastSeq: unknown): lastSeq is number {
    const seq = this.version === 0 ? 0 : this.getSeq();
    if (typeof lastSeq !== 'number' || !Number.isInteger(lastSeq) || lastSeq < 0 || lastSeq > seq) {
      return false;
    }
    const missed = seq - lastSeq;
    if (missed === 0) return true;
    if (missed > MAX_REPLAY_OPS) return false;
    const retained = this.sql
      .exec(
        `SELECT count(*) AS count, sum(length(body) + length(coalesce(fixups, ''))) AS size
         FROM ops WHERE seq > ?`,
        lastSeq,
      )
      .one();
    return retained.count === missed && (retained.size as number) <= MAX_REPLAY_LENGTH;
  }

  private async onOps(ws: WebSocket, attachment: Attachment, msg: Record<string, unknown>): Promise<void> {
    const { actor, clientId } = attachment;
    if (!clientId) {
      ws.close(1008, 'hello required');
      return;
    }
    const opId = typeof msg.opId === 'string' ? msg.opId : '';
    let result: ApplyResult;
    try {
      result = await this.applyOps({ actor, clientId, opId, deltas: msg.deltas });
    } catch (e) {
      // 想定外の失敗でも送信元に結果を返す（返さないと、その操作が未確定のまま残る）
      console.error('applyOps failed', e);
      result = { ok: false, reason: 'internal error' };
    }
    if (!result.ok) {
      const { reason, current } = result;
      send(ws, JSON.stringify({ type: 'reject', opId, reason, current } satisfies ServerMsg));
    } else if (!result.broadcast) {
      // 配信していない結果（再送、すべて捨てた操作）は、送信元にだけ確定を返す
      const { seq, deltas, fixups } = result;
      send(ws, JSON.stringify({ type: 'ops', seq, actor, clientId, opId, deltas, fixups } satisfies ServerMsg));
    }
  }

  /**
   * hello を済ませた全接続へ送る。`sender` を指定すると、その送信元の接続にだけ
   * `toSender` を送る（null なら送らない）。clientId はクライアントの自己申告なので、
   * 送信元かどうかは主体も合わせて判定する
   */
  private broadcast(
    json: string,
    sender?: { actor: string; clientId: string; toSender: string | null },
  ): void {
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment;
      if (isExpired(attachment)) {
        ws.close(CLOSE_AUTH_EXPIRED, 'authentication expired');
        continue;
      }
      if (!attachment.clientId) continue;
      const out =
        sender && attachment.clientId === sender.clientId && attachment.actor === sender.actor
          ? sender.toSender
          : json;
      if (out !== null) send(ws, out);
    }
  }
}

/** 保存済みの JSON（deltas、fixups）を解析し直さずに ops メッセージを組み立てる */
function opsJson(head: OpsHead, body: string, fixupsJson: string | null): string {
  const fixups = fixupsJson ? `,"fixups":${fixupsJson}` : '';
  return `${JSON.stringify(head).slice(0, -1)},"deltas":${body}${fixups}}`;
}

/** 閉じかけの接続への送信は失敗するが、相手は再接続時に差分を受け取るので無視してよい */
function send(ws: WebSocket, json: string): void {
  try {
    ws.send(json);
  } catch {
    // 無視する
  }
}
