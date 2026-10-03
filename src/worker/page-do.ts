import { DurableObject } from 'cloudflare:workers';
import type { BoardContent, HistoryDelta, Snapshot } from '../shared/delta';
import { applyDeltas, readBoard, type Sanitized, sanitizeDeltas } from './apply-ops';
import { SanitizeError } from './sanitize';
import { exceedsBytes, MAX_OP_BYTES, parseDeltas, parseId, RejectError } from './validate';

const MAX_SUMMARY_LENGTH = 500;

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
      /** 同じ opId の再送で、適用済みだった。送信元にだけ結果を返し、他へは配信しない */
      duplicate: boolean;
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
CREATE UNIQUE INDEX ops_client_op ON ops (client_id, op_id);

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
        `SELECT seq, body, fixups FROM ops WHERE client_id = ? AND op_id = ?`,
        input.clientId, input.opId,
      )
      .toArray()[0];
    if (done) {
      return {
        ok: true,
        seq: done.seq as number,
        deltas: JSON.parse(done.body as string),
        fixups: done.fixups ? JSON.parse(done.fixups as string) : [],
        duplicate: true,
      };
    }

    try {
      return this.ctx.storage.transactionSync(() => {
        const now = Date.now();
        const applied = applyDeltas(this.sql, deltas, input.actor, now, sanitized.cleanBefore);
        const fixups = [...sanitized.fixups, ...applied.fixups];
        if (applied.deltas.length === 0) {
          return { ok: true, seq: this.getSeq(), deltas: [], fixups, duplicate: false };
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
          seq, input.actor, input.clientId, input.opId, body, fixupsJson,
          input.summary?.slice(0, MAX_SUMMARY_LENGTH) ?? null, now,
        );
        return { ok: true, seq, deltas: applied.deltas, fixups, duplicate: false };
      });
    } catch (e) {
      if (e instanceof RejectError) return { ok: false, reason: e.message, current: e.current };
      throw e;
    }
  }
}
