import { DurableObject } from 'cloudflare:workers';
import { MAX_TITLE_LENGTH, type OpSummary, type RevertOutcome } from '../shared/api';
import { type BoardContent, type HistoryDelta, invertDeltas, type Snapshot } from '../shared/delta';
import { systemSummary } from '../shared/op-summary';
import {
  CLOSE_AUTH_EXPIRED,
  CLOSE_PAGE_DELETED,
  type OpsMsg,
  PING,
  PONG,
  type ServerMsg,
} from '../shared/protocol';
import type { BoardState } from '../shared/tools';
import {
  type ChildRejectCode,
  childPageOf,
  childRejection,
  MAX_DEPTH,
  placedPages,
  touchesChildren,
} from '../shared/hierarchy';
import {
  applyDeltas,
  childPages,
  readBoard,
  readBoardWithAuthors,
  readNotes,
  type Sanitized,
  sanitizeDeltas,
  UNSET_FLAGS,
} from './apply-ops';
import {
  buildLayout,
  buildPageContent,
  contentHash,
  indexedChildren,
  type PageRow,
  removePage,
  touchPage,
  writePage,
} from './indexer';
import { applyRevert } from './revert';
import { SanitizeError } from './sanitize';
import {
  clampLimit,
  exceedsBytes,
  MAX_OP_BYTES,
  parseDeltas,
  parseId,
  RejectError,
} from './validate';

const MAX_SUMMARY_LENGTH = 500;
const DEFAULT_LIST_OPS = 50;
const MAX_LIST_OPS = 200;
/** 変更してから D1 へ反映するまでの時間 */
const INDEX_DELAY_MS = 5000;
/** ops を残す期間と件数。どちらかに収まっていれば残す（再接続時の差分、履歴、取り消しに使う） */
const OPS_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const OPS_RETENTION_COUNT = 1000;
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
  /** ページがまだ作られていなければ、適用せずに断る（MCP のツールはページを作らない） */
  mustExist?: boolean;
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

export interface RevertInput {
  /** 取り消す操作の seq */
  seq: number;
  /** 取り消しを行う主体。呼び出し側（Worker）が認証結果から決める */
  actor: string;
  clientId: string;
  opId: string;
  /** 自分（同じ主体）の操作だけを取り消せるようにする。MCP の revert_operation で使う */
  ownOnly?: boolean;
  /** 一覧に出す説明。省略すると、取り消しを表す符号（src/shared/op-summary.ts） */
  summary?: string;
}

/**
 * 取り消せなかった理由の分類。
 * - not-found: 対象の操作がない（間引かれた場合を含む）
 * - conflict: すでに取り消されている
 * - forbidden: `ownOnly` で、他の主体の操作を指定した
 * - invalid: 入力が不正
 */
export type RevertFailure = 'not-found' | 'conflict' | 'forbidden' | 'invalid';

export type RevertResult =
  | ({ ok: true } & RevertOutcome)
  | { ok: false; code: RevertFailure; reason: string };

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
  summary     TEXT,
  reverts     INTEGER,
  reverted_by INTEGER,
  created_at  INTEGER NOT NULL,
  -- 大きくなる列は最後に置く。一覧や取り消しの判定で手前の列だけを読むときに、
  -- これらの中身（最大 1.8MB）まで読まずに済む
  body        TEXT NOT NULL,
  fixups      TEXT
);

CREATE INDEX ops_reverted_by ON ops (reverted_by) WHERE reverted_by IS NOT NULL;

CREATE INDEX edges_from ON edges (from_id);
CREATE INDEX edges_to ON edges (to_id);
CREATE UNIQUE INDEX ops_client_op ON ops (actor, client_id, op_id);

INSERT INTO meta (key, value) VALUES ('seq', '0');
`,
  // 長い本文を畳んで表示する付箋（wema 0.9.0 の WemaNote.foldable）
  `ALTER TABLE notes ADD COLUMN foldable INTEGER NOT NULL DEFAULT 0;`,
];

/** ページ 1 つ分の付箋・接続線・操作履歴を持つ */
export class PageDO extends DurableObject<Env> {
  /** 適用済みのスキーマのバージョン。0 は一度も書き込まれていないページ */
  private version: number;

  /** ページを削除するたびに増える。削除の前に受け付けた書き込みを、削除の後に実行しないために使う */
  private generation = 0;
  /** 実行中、または順番を待っている削除の数 */
  private deleting = 0;

  /** 今まさに子にしようとしているページ（adoptChildren の実行中）。互いを同時に子にするのを断る */
  private adopting = new Set<string>();

  /** 処理中の applyOps。次の呼び出しはこれが終わってから始める */
  private applyQueue: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // 接続維持の ping には DO を起こさずに応答する
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
    this.version = this.readVersion();
    // 書き込みのないページには何も保存しない（存在しないスラッグを開いただけで
    // ストレージが残らないようにする）。スキーマは最初の書き込みで作る
    if (this.version > 0) this.migrate();
  }

  private get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  /** スキーマがある（version > 0）ときだけ呼ぶ */
  private getMeta(key: string): string | null {
    const row = this.sql.exec(`SELECT value FROM meta WHERE key = ?`, key).toArray()[0];
    return row ? (row.value as string) : null;
  }

  private setMeta(key: string, value: string | null): void {
    if (value === null) this.sql.exec(`DELETE FROM meta WHERE key = ?`, key);
    else this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, key, value);
  }

  private readVersion(): number {
    const hasMeta = this.sql
      .exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'`)
      .toArray().length;
    return hasMeta ? Number(this.getMeta('version') ?? 0) : 0;
  }

  /** スキーマを最新にする。書き込みの前に呼ぶ */
  private migrate(): void {
    if (this.version >= MIGRATIONS.length) return;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(META_TABLE);
      // 自分のスラッグは、スキーマを作るとき（最初の書き込み）に保存する。D1 への反映（alarm）は
      // リクエストを伴わずに起動され、そこでは名前を取得できない可能性があるため
      if (this.version === 0) {
        if (this.ctx.id.name) this.setMeta('slug', this.ctx.id.name);
        // ページを作るたびに変わる値。削除して作り直したページを、前のページと見分けるのに使う
        this.setMeta('epoch', crypto.randomUUID());
      }
      for (const migration of MIGRATIONS.slice(this.version)) {
        this.sql.exec(migration);
      }
      this.setMeta('version', String(MIGRATIONS.length));
    });
    const created = this.version === 0;
    this.version = MIGRATIONS.length;
    // ページができたことを、開いているブラウザに知らせる（epoch を渡す）
    if (created) this.broadcast(this.metaJson());
  }

  /** 表示名と epoch を伝えるメッセージ。スキーマがある（version > 0）ときだけ呼ぶ */
  private metaJson(): string {
    return JSON.stringify({
      type: 'meta',
      title: this.getMeta('title'),
      epoch: this.getMeta('epoch'),
    } satisfies ServerMsg);
  }

  /** スキーマがある（version > 0）ときだけ呼ぶ */
  private getSeq(): number {
    return Number(this.getMeta('seq'));
  }

  getSnapshot(): Snapshot {
    if (this.version === 0) {
      return { seq: 0, title: null, epoch: null, data: { version: 1, notes: [], edges: [] } };
    }
    return {
      seq: this.getSeq(),
      title: this.getMeta('title'),
      epoch: this.getMeta('epoch'),
      data: readBoard(this.sql),
    };
  }

  /** agent（MCP）に渡すボード。付箋には作成者が付く。ページがまだ作られていなければ null */
  getBoardState(): BoardState | null {
    if (this.version === 0) return null;
    return { title: this.getMeta('title'), ...readBoardWithAuthors(this.sql) };
  }

  /**
   * 表示名を変える。空文字なら未設定に戻す（表示はスラッグになる）。
   * 付箋のデルタではないので ops には記録しない。
   *
   * まだ作られていないページに呼ぶと、ページができる。`mustExist` なら、作らずに断る
   * （一覧の画面からの変更。古い一覧に残っている削除済みのページを、作り直さないため）
   */
  setTitle(
    input: unknown,
    options: { mustExist?: boolean } = {},
  ): { ok: true; title: string | null } | { ok: false; reason: 'invalid title' | 'page not found' } {
    const title = parseTitle(input);
    if (title === undefined) return { ok: false, reason: 'invalid title' };
    if (options.mustExist && this.version === 0) return { ok: false, reason: 'page not found' };
    this.migrate();
    this.setMeta('title', title);
    this.broadcast(this.metaJson());
    this.scheduleIndexing();
    return { ok: true, title };
  }

  // --- 階層（src/shared/hierarchy.ts） ---
  //
  // 子ページの付箋は親ページの DO にあり、「親は誰か」は子ページの DO にある（meta の parent）。
  // 正とするのは、子ページの側。親ページの DO は、子ページの付箋を作るデルタを適用する前に、
  // 子ページの DO へ setParent を呼ぶ。断られたら、デルタを拒否する。
  //
  // setParent / clearParent / getPageRef は、書き込みの順番待ちに入れない。親ページの DO が
  // 順番待ちの中から呼ぶので、入れると、互いを待って止まることがある。

  /**
   * 親をたどるための情報と、付箋の数。ページがなければ null。
   * 索引（D1）への反映を待たずに読めるので、作ったばかりのページの概要にも使う
   */
  getPageRef(): { title: string | null; parent: string | null; noteCount: number } | null {
    if (this.version === 0) return null;
    const noteCount = this.sql.exec(`SELECT count(*) AS n FROM notes`).one().n as number;
    return { title: this.getMeta('title'), parent: this.getMeta('parent'), noteCount };
  }

  /** このページを `parent` の子にする。すでに別の親があるか、輪になるなら、理由を返す。置けたら null */
  setParent(parent: string): ChildRejectCode | null {
    if (this.version === 0 || this.deleting > 0) return 'not-found';
    const current = this.getMeta('parent');
    if (current !== null && current !== parent) return 'other-parent';
    // 相手を自分の子にしている（または、今まさに子にしようとしている）なら、輪になる
    if (this.adopting.has(parent) || childPages(this.sql).has(parent)) return 'ancestor';
    if (current === null) {
      this.setMeta('parent', parent);
      this.scheduleIndexing();
    }
    return null;
  }

  /** `parent` の子であれば、ルートへ戻す */
  clearParent(parent: string): void {
    if (this.version === 0 || this.getMeta('parent') !== parent) return;
    this.setMeta('parent', null);
    this.scheduleIndexing();
  }

  /** このページのスラッグ */
  private slug(): string {
    const slug = (this.version > 0 ? this.getMeta('slug') : null) ?? this.ctx.id.name;
    if (!slug) throw new Error('page slug is not available in the Durable Object');
    return slug;
  }

  /** 先祖のページ（親、その親、…の順）。上限を超えてたどらない。パンくずと、輪の検査に使う */
  async ancestors(): Promise<{ name: string; title: string | null }[]> {
    if (this.version === 0) return [];
    const found: { name: string; title: string | null }[] = [];
    for (let name = this.getMeta('parent'); name !== null && found.length < MAX_DEPTH; ) {
      const ref = await this.env.PAGE.getByName(name).getPageRef();
      found.push({ name, title: ref?.title ?? null });
      name = ref?.parent ?? null;
    }
    return found;
  }

  /**
   * `wanted`（新しく置こうとしている子ページ）を、このページの子にする。
   * 置けないものが 1 つでもあれば、すべて取りやめて、理由を返す。置けたら null を返す
   */
  private async adoptChildren(wanted: string[]): Promise<string | null> {
    const slug = this.slug();
    if (wanted.includes(slug)) return childRejection('self', slug);
    /** 先祖の中に、置こうとしているページがあれば、輪になる */
    const loop = (ancestors: { name: string }[]) => {
      const page = wanted.find((name) => ancestors.some((ancestor) => ancestor.name === name));
      return page === undefined ? null : childRejection('ancestor', page);
    };
    let done = false;
    wanted.forEach((page) => this.adopting.add(page));
    try {
      const ancestors = await this.ancestors();
      const looped = loop(ancestors);
      if (looped !== null) return looped;
      for (const page of wanted) {
        // 置いた後の最も深い段が、上限を超えないこと。置かれる側に、残りの段数に収まるかを聞く
        const fits = await this.env.PAGE.getByName(page).fitsWithin(MAX_DEPTH - ancestors.length - 1);
        if (!fits) return childRejection('too-deep', page);
      }
      for (const page of wanted) {
        const code = await this.env.PAGE.getByName(page).setParent(slug);
        if (code !== null) return childRejection(code, page);
      }
      // 子にした後で、先祖をたどり直す。上の検査の後に、他のページで同時に置く操作があると、
      // 3 ページ以上の輪ができることがある（相手も同じ検査をするので、少なくとも片方は取りやめる）
      const loopedNow = loop(await this.ancestors());
      if (loopedNow !== null) return loopedNow;
      done = true;
      return null;
    } finally {
      wanted.forEach((page) => this.adopting.delete(page));
      if (!done) {
        // 取りやめたら、すべて戻す。setParent が済んだのに応答が届かなかった分も含める
        // （clearParent は、親がこのページのときだけ消すので、済んでいない分に呼んでも害はない）
        await this.releaseOrphans(wanted);
        // 戻しきれなかった分は、次の索引の更新で直す
        this.scheduleIndexing();
      }
    }
  }

  /**
   * このページを根とする部分木が、`levels` 段に収まるか。子ページの DO を順にたどるので、
   * 直前の変更も反映される（D1 の索引は、変更の数秒後にしか反映されない）
   */
  async fitsWithin(levels: number): Promise<boolean> {
    if (levels < 1) return false;
    if (this.version === 0) return true;
    for (const child of childPages(this.sql)) {
      if (!(await this.env.PAGE.getByName(child).fitsWithin(levels - 1))) return false;
    }
    return true;
  }

  /**
   * `candidates` のうち、子ページの付箋がもうないページを、ルートへ戻す。
   * 失敗しても、書き込みは取り消さない。食い違いは、次の索引の更新（reconcileChildren）で直す
   */
  private async releaseOrphans(candidates: Iterable<string>): Promise<void> {
    if (this.version === 0) return;
    const placed = childPages(this.sql);
    const slug = this.slug();
    for (const page of new Set(candidates)) {
      if (placed.has(page)) continue;
      try {
        await this.env.PAGE.getByName(page).clearParent(slug);
      } catch (e) {
        console.error('failed to release a child page', page, e);
      }
    }
  }

  /**
   * 子ページの付箋の増減を伴う書き込みを行う。`run` の前に、新しく置く子ページを子にし、
   * 後に、付箋がなくなった子ページをルートへ戻す。置けなければ、`run` を呼ばずに `rejected` を返す
   */
  private async withChildren<T>(
    deltas: HistoryDelta[],
    run: () => T,
    rejected: (reason: string) => T,
  ): Promise<T> {
    // 付箋の移動、本文の編集、接続線の操作では、子ページの集合は変わらない。何も調べずに進める
    if (!touchesChildren(deltas)) return run();
    const before = childPages(this.sql);
    const wanted = placedPages(deltas).filter((page) => !before.has(page));
    const reason = wanted.length > 0 ? await this.adoptChildren(wanted) : null;
    if (reason !== null) return rejected(reason);
    try {
      return run();
    } finally {
      await this.releaseOrphans([...before, ...wanted]);
    }
  }

  /**
   * ページを削除する前に、階層から外す。親ページにある自分の付箋を消し、子ページはルートへ戻す
   * （子孫ごとの削除はしない）。失敗しても削除は続ける。残った食い違いは、付箋の側が
   * 「削除済み」と表示され、親ページの索引の更新（reconcileChildren）でも直る
   */
  private async detachFromHierarchy(slug: string, actor: string): Promise<void> {
    const parent = this.getMeta('parent');
    // 1 つの失敗で、残りを飛ばさない。子ページの側は、親がなくなっていれば、次の索引の更新で
    // 自分でルートへ戻る（healParent）
    const attempt = async (what: string, run: () => Promise<unknown>) => {
      try {
        await run();
      } catch (e) {
        console.error(`failed to detach a deleted page from the hierarchy (${what})`, slug, e);
      }
    };
    if (parent !== null) {
      await attempt(`parent ${parent}`, () => this.env.PAGE.getByName(parent).removeChildNotes(slug, actor));
    }
    for (const child of childPages(this.sql)) {
      await attempt(`child ${child}`, async () => {
        const stub = this.env.PAGE.getByName(child);
        await stub.clearParent(slug);
      });
    }
  }

  /**
   * 子ページ `page` の付箋を、このページから消す（子ページが削除されたとき）。
   * 付箋の削除として記録するので、開いているブラウザにも届く
   */
  removeChildNotes(page: string, actor: string): Promise<void> {
    // 付箋を読むのは、順番待ちに入ってから。置いている途中の付箋（setParent は済んだが、
    // まだ書き込んでいない）を取りこぼさないため
    return this.write(async () => {
      if (this.version === 0) return;
      const notes = readBoard(this.sql).notes.filter((note) => childPageOf(note) === page);
      if (notes.length === 0) return;
      await this.applyOpsInOrder({
        actor,
        clientId: 'system',
        opId: crypto.randomUUID(),
        deltas: notes.map((note): HistoryDelta => ({ type: 'note:delete', note })),
        summary: systemSummary.childRemoved(page),
      });
    }, undefined);
  }

  /**
   * ページを新しく作る。すでにあれば何もしない（既存のページの表示名を書き換えない）。
   * 付箋を書き込めばページはできるので、これは表示名だけのページを先に作るためのもの。
   */
  createPage(input: unknown): { ok: true } | { ok: false; reason: 'exists' | 'invalid title' } {
    const title = parseTitle(input ?? '');
    if (title === undefined) return { ok: false, reason: 'invalid title' };
    if (this.version > 0) return { ok: false, reason: 'exists' };
    this.migrate();
    this.setMeta('title', title);
    this.scheduleIndexing();
    return { ok: true };
  }

  /**
   * ページを、付箋と接続線を置いた状態で作り、D1 の索引にも反映する（最初のページ用。作った直後の
   * 一覧に出すため、索引への反映を待つ）。すでにあれば何もせず、false を返す
   */
  async createWithContent(title: string, deltas: HistoryDelta[]): Promise<boolean> {
    if (this.version > 0) return false;
    // 付箋を先に書く。断られたときに、表示名だけの空のページを残さない（残ると、作り直せない）
    const applied = await this.applyOps({
      actor: 'system',
      clientId: 'system',
      opId: crypto.randomUUID(),
      deltas,
      summary: systemSummary.pageCreated(),
    });
    if (!applied.ok) throw new Error(`could not create the page content: ${applied.reason}`);
    this.setTitle(title);
    await this.reindexInOrder(Date.now());
    return true;
  }

  /**
   * ページを削除する。付箋、接続線、履歴、表示名と、D1 の索引を消す。取り消しはできない。
   * 貼った画像は R2 に残る（どのページの画像かを記録していない）。
   */
  deletePage(actor = 'system'): Promise<void> {
    // 順番を待っている書き込みと、削除の途中で届く書き込みは、削除の後に実行させない
    // （実行すると、消したページが作り直されてしまう）
    this.deleting++;
    return this.inOrder(async () => {
      try {
        const slug = this.slug();
        // 索引を先に消す。ここで失敗したら、ページの内容は残っているので、やり直せる
        await removePage(this.env.DB, slug);
        if (this.version > 0) await this.detachFromHierarchy(slug, actor);
        await this.ctx.storage.deleteAlarm();
        await this.ctx.storage.deleteAll();
        this.version = 0;
        // 接続中のブラウザには再接続させない（再接続しても、hello の epoch が合わずに閉じられる）
        for (const ws of this.ctx.getWebSockets()) ws.close(CLOSE_PAGE_DELETED, 'page deleted');
      } finally {
        this.deleting--;
        this.generation++;
      }
    });
  }

  /**
   * 書き込みを順番待ちに入れる。待っている間にページの削除が始まるか済んでいたら、
   * 実行せずに `deleted` を返す。
   */
  private write<T>(run: () => Promise<T>, deleted: T): Promise<T> {
    if (this.deleting > 0) return Promise.resolve(deleted);
    const generation = this.generation;
    return this.inOrder(async () =>
      this.deleting === 0 && generation === this.generation ? run() : deleted,
    );
  }

  // --- D1 の索引への反映 ---

  /**
   * 変更から少し後に、まとめて D1 へ反映する（書き込みごとには反映しない）。
   * alarm が設定済みなら何もしない。alarm の実行中は未設定に見えるので、反映中に届いた変更は
   * 次の alarm で反映される。
   */
  private scheduleIndexing(): void {
    this.ctx.waitUntil(
      this.ctx.storage.getAlarm().then((alarm) => {
        if (alarm === null) return this.ctx.storage.setAlarm(Date.now() + INDEX_DELAY_MS);
      }),
    );
  }

  /** 失敗して例外で終わると、ランタイムが間隔を空けて再実行する */
  async alarm(): Promise<void> {
    if (this.version === 0) return;
    const now = Date.now();
    this.pruneOps(now);
    await this.reindexInOrder(now);
  }

  /**
   * D1 の索引へ反映する。書き込みや削除と同じ順番待ちに入れる（索引の書き込みが、ページの削除と
   * 前後しないようにする）
   */
  private reindexInOrder(now: number): Promise<void> {
    return this.inOrder(async () => {
      if (this.version > 0) await this.reindex(now);
    });
  }

  /** 保持期間を過ぎた ops を消す。直近の分は期間を過ぎていても残す */
  private pruneOps(now: number): void {
    this.sql.exec(
      `DELETE FROM ops WHERE created_at < ? AND seq <= ?`,
      now - OPS_RETENTION_MS,
      this.getSeq() - OPS_RETENTION_COUNT,
    );
  }

  private async reindex(now: number): Promise<void> {
    const slug = this.slug();
    const title = this.getMeta('title');
    const notes = readNotes(this.sql);
    const row: PageRow = {
      title,
      parent: this.getMeta('parent'),
      layout: buildLayout(notes),
      noteCount: notes.length,
      now,
    };

    const content = await buildPageContent(slug, notes.map((note) => note.text), this.env.SITE_ORIGIN);
    const hash = await contentHash(title, content);
    // 付箋の移動や色の変更では、検索とリンクに関わる内容は変わらない。そのときは全文検索と
    // リンクの索引を書き直さない（ページの行が D1 にないときは作り直す）
    const unchanged = hash === this.getMeta('index_hash');
    if (!unchanged || !(await touchPage(this.env.DB, slug, row))) {
      await writePage(this.env.DB, slug, content, row);
      this.setMeta('index_hash', hash);
    }
    const placed = new Set(notes.map(childPageOf).filter((page) => page !== undefined));
    await this.reconcileChildren(slug, placed);
    await this.healParent(row.parent);
  }

  /**
   * 親ページがもうなければ、ルートへ戻る。親ページの削除のときに、clearParent が届かなかった場合に
   * 効く（そのままだと、存在しない親を指したままで、一覧に出ない）。次の索引の更新で、D1 にも反映する
   */
  private async healParent(parent: string | null): Promise<void> {
    if (parent === null || (await this.env.PAGE.getByName(parent).getPageRef()) !== null) return;
    this.setMeta('parent', null);
    this.scheduleIndexing();
  }

  /**
   * 索引の上ではこのページの子なのに、子ページの付箋がないページを、ルートへ戻す。
   * 付箋を消した後の clearParent が失敗した場合の、食い違いを直す
   */
  private async reconcileChildren(slug: string, placed: Set<string>): Promise<void> {
    const stale = (await indexedChildren(this.env.DB, slug)).filter((page) => !placed.has(page));
    for (const page of stale) await this.env.PAGE.getByName(page).clearParent(slug);
  }

  /**
   * 唯一の書き込み口。ブラウザ（WebSocket）からも MCP からも、これを通して変更する。
   *
   * サニタイズは非同期で、かかる時間が text によって違う。待っている間に後続の呼び出しが
   * 先に保存まで進むと、同じクライアントの操作が送信順に適用されなくなる（作成より先に
   * その付箋の更新が処理されるなど）ので、呼び出しを 1 つずつ順に処理する。
   */
  applyOps(input: ApplyInput): Promise<ApplyResult> {
    return this.write(() => this.applyOpsInOrder(input), { ok: false, reason: REASON_PAGE_DELETED });
  }

  /** 前の書き込みが終わってから `run` を始める */
  private inOrder<T>(run: () => Promise<T>): Promise<T> {
    const result = this.applyQueue.then(run);
    // 結果（大きなデルタを含む）を次の呼び出しまで掴まないよう、値を捨てて繋ぐ
    this.applyQueue = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  /** 同じ送信元の同じ操作が記録済みなら、その行を返す */
  private findOp(actor: string, clientId: string, opId: string) {
    return this.sql
      .exec(
        // clientId はクライアントの自己申告なので、主体も合わせて同じ送信元かを判定する
        `SELECT seq, reverts, body, fixups FROM ops
         WHERE actor = ? AND client_id = ? AND op_id = ?`,
        actor, clientId, opId,
      )
      .toArray()[0];
  }

  /**
   * 適用したデルタを ops に記録し、seq を進める。`transactionSync` の中で呼ぶこと。
   * 戻り値の `deliver` は、トランザクションが確定してから呼ぶ（接続中のクライアントへの配信）。
   */
  private recordOp(
    op: { actor: string; clientId: string; opId: string; summary?: string; reverts?: number },
    deltas: HistoryDelta[],
    fixups: HistoryDelta[],
    now: number,
  ): { seq: number; deliver: () => void } {
    const body = JSON.stringify(deltas);
    const fixupsJson = fixups.length > 0 ? JSON.stringify(fixups) : null;
    if (exceedsBytes(body + (fixupsJson ?? ''), MAX_OP_BYTES)) {
      throw new RejectError('operation too large');
    }
    const summary = op.summary?.slice(0, MAX_SUMMARY_LENGTH);
    const seq = this.getSeq() + 1;
    this.setMeta('seq', String(seq));
    this.sql.exec(
      `INSERT INTO ops (seq, actor, client_id, op_id, summary, reverts, created_at, body, fixups)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      seq, op.actor, op.clientId, op.opId, summary ?? null, op.reverts ?? null, now, body, fixupsJson,
    );
    const head: OpsHead = {
      type: 'ops', seq, actor: op.actor, clientId: op.clientId, opId: op.opId, summary,
      reverts: op.reverts,
    };
    const deliver = () => {
      // fixups は送信元にだけ付ける
      this.broadcast(opsJson(head, body, null), {
        actor: op.actor,
        clientId: op.clientId,
        toSender: opsJson(head, body, fixupsJson),
      });
      this.scheduleIndexing();
    };
    return { seq, deliver };
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

    if (input.mustExist && this.version === 0) return { ok: false, reason: 'page not found' };
    this.migrate();

    // 再接続後の再送。適用済みの結果をそのまま返す
    const done = this.findOp(input.actor, input.clientId, input.opId);
    if (done) {
      return {
        ok: true,
        seq: done.seq as number,
        deltas: JSON.parse(done.body as string),
        fixups: done.fixups ? JSON.parse(done.fixups as string) : [],
        broadcast: false,
      };
    }

    const apply = (): ApplyResult => {
      let deliver: (() => void) | undefined;
      try {
        const result = this.ctx.storage.transactionSync((): ApplyResult => {
          const now = Date.now();
          const applied = applyDeltas(this.sql, deltas, input.actor, now, sanitized.cleanBefore);
          const fixups = [...sanitized.fixups, ...applied.fixups];
          if (applied.deltas.length === 0) {
            return { ok: true, seq: this.getSeq(), deltas: [], fixups, broadcast: false };
          }
          const recorded = this.recordOp(input, applied.deltas, fixups, now);
          deliver = recorded.deliver;
          return { ok: true, seq: recorded.seq, deltas: applied.deltas, fixups, broadcast: true };
        });
        // トランザクションが確定してから配信する。保存と同じ同期の区間なので、順序は seq の順になる
        deliver?.();
        return result;
      } catch (e) {
        if (e instanceof RejectError) return { ok: false, reason: e.message, current: e.current };
        throw e;
      }
    };
    return this.withChildren(deltas, apply, (reason) => ({ ok: false, reason }));
  }

  // --- 取り消しと履歴 ---

  /**
   * 最近の操作を新しい順に返す。`agentOnly` なら agent（MCP 経由）の操作に、
   * `actor` を指定するとその主体の操作に絞る。
   */
  listOps(options: { limit?: number; agentOnly?: boolean; actor?: string } = {}): OpSummary[] {
    if (this.version === 0) return [];
    return this.sql
      .exec(
        `SELECT seq, actor, summary, reverts, reverted_by, created_at FROM ops
         WHERE (?1 = 0 OR substr(actor, 1, 6) = 'agent:') AND (?2 IS NULL OR actor = ?2)
         ORDER BY seq DESC LIMIT ?3`,
        options.agentOnly ? 1 : 0, options.actor ?? null,
        clampLimit(options.limit, DEFAULT_LIST_OPS, MAX_LIST_OPS),
      )
      .toArray()
      .map((row) => ({
        seq: row.seq as number,
        actor: row.actor as string,
        summary: row.summary as string | null,
        reverts: row.reverts as number | null,
        revertedBy: row.reverted_by as number | null,
        createdAt: row.created_at as number,
      }));
  }

  /**
   * 記録済みの操作を取り消す。逆向きのデルタを新しい操作として適用する。
   * その後に変更された付箋や接続線は取り消さず、`skipped` で返す（部分適用）。
   */
  revert(input: RevertInput): Promise<RevertResult> {
    return this.write(() => this.revertInOrder(input), {
      ok: false, code: 'not-found', reason: REASON_PAGE_DELETED,
    });
  }

  private async revertInOrder(input: RevertInput): Promise<RevertResult> {
    const fail = (code: RevertFailure, reason: string): RevertResult => ({ ok: false, code, reason });
    const notFound = () => fail('not-found', 'operation not found');
    const { seq: target, actor, clientId, opId } = input;
    try {
      parseId(clientId, 'clientId');
      parseId(opId, 'opId');
      if (this.version === 0 || !Number.isInteger(target)) return notFound();

      const done = this.findOp(actor, clientId, opId);
      if (done) {
        // 同じ opId を別の操作に使い回した場合。成功として返すと、実行されていないのに
        // 取り消せたように見える
        if (done.reverts !== target) return fail('invalid', 'opId already used');
        // 再送。記録済みの結果を返す（skipped は残していない）
        const applied = this.sql
          .exec(`SELECT json_array_length(body) AS n FROM ops WHERE seq = ?`, done.seq)
          .one().n as number;
        return { ok: true, seq: done.seq as number, applied, skipped: [] };
      }

      // 記録済みの body は変わらないので、トランザクションの前に読んでよい
      const row = this.sql.exec(`SELECT body FROM ops WHERE seq = ?`, target).toArray()[0];
      if (!row) return notFound();
      const inverse = invertDeltas(JSON.parse(row.body as string));
      // 戻す text も、今のサニタイズの規則を通す
      await sanitizeDeltas(inverse, { cleanBefore: false });

      const apply = (): RevertResult => {
        let deliver: (() => void) | undefined;
        const result = this.ctx.storage.transactionSync((): RevertResult => {
          // 対象の状態は、サニタイズを待った後のここで確かめる
          const op = this.sql.exec(`SELECT actor, reverted_by FROM ops WHERE seq = ?`, target).toArray()[0];
          if (!op) return notFound();
          if (op.reverted_by !== null) return fail('conflict', 'already reverted');
          if (input.ownOnly && op.actor !== actor) return fail('forbidden', 'not your operation');

          const now = Date.now();
          const { deltas, skipped } = applyRevert(this.sql, inverse, actor, now);
          if (deltas.length === 0) return { ok: true, seq: null, applied: 0, skipped };

          const summary = input.summary ?? systemSummary.revert(target);
          const recorded = this.recordOp({ actor, clientId, opId, summary, reverts: target }, deltas, [], now);
          // 取り消しを取り消した場合は、元の操作の内容が戻るので、元の操作をもう一度取り消せるようにする
          this.sql.exec(`UPDATE ops SET reverted_by = NULL WHERE reverted_by = ?`, target);
          this.sql.exec(`UPDATE ops SET reverted_by = ? WHERE seq = ?`, recorded.seq, target);
          deliver = recorded.deliver;
          return { ok: true, seq: recorded.seq, applied: deltas.length, skipped };
        });
        deliver?.();
        return result;
      };
      // 取り消しで子ページの付箋が戻るなら、もう一度子にする。置けなければ、取り消しを断る
      return await this.withChildren(inverse, apply, (reason) => fail('conflict', reason));
    } catch (e) {
      if (e instanceof RejectError || e instanceof SanitizeError) return fail('invalid', e.message);
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
    // クライアントが前に見たページと、今のページが別物（削除された、または削除して作り直された）
    // なら、接続を閉じる。そのまま続けると、手元の未確定の操作で、消したページの内容が書き戻される
    const epoch = this.version > 0 ? this.getMeta('epoch') : null;
    if (typeof msg.epoch === 'string' && msg.epoch !== epoch) {
      ws.close(CLOSE_PAGE_DELETED, 'page deleted');
      return;
    }
    // これ以降、この接続は配信の対象になる
    ws.serializeAttachment({ ...attachment, clientId } satisfies Attachment);

    const { lastSeq } = msg;
    if (!this.canReplay(lastSeq)) {
      send(ws, JSON.stringify({ type: 'snapshot', ...this.getSnapshot() } satisfies ServerMsg));
      return;
    }
    // 表示名の変更は seq を進めないので、切断中に変わっていても差分には出ない。現在値を送る
    send(ws, this.metaJson());
    const rows = this.sql.exec(
      `SELECT seq, actor, client_id, op_id, summary, reverts, body, fixups FROM ops
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
        reverts: (row.reverts as number | null) ?? undefined,
      };
      // 自分の操作の確定を受け取る前に切断していた場合は、fixups も返す
      const own = head.clientId === clientId && head.actor === attachment.actor;
      const fixups = own ? (row.fixups as string | null) : null;
      send(ws, opsJson(head, row.body as string, fixups));
    }
  }

  /** `lastSeq` 以降の変更を、差分（ops の再送）で返せるか */
  private canReplay(lastSeq: unknown): lastSeq is number {
    // 書き込みのないページにはテーブルがない。空のスナップショットを返す
    if (this.version === 0) return false;
    const seq = this.getSeq();
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
      const fixups = current && contentToDeltas(current);
      send(ws, JSON.stringify({ type: 'reject', opId, reason, fixups } satisfies ServerMsg));
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

/** 順番を待っている間にページが削除された書き込みに返す理由 */
const REASON_PAGE_DELETED = 'page deleted';

/** 表示名を検証する。空文字は未設定（null）。不正なら undefined */
function parseTitle(input: unknown): string | null | undefined {
  if (typeof input !== 'string') return undefined;
  const title = input.trim();
  // 制御文字（改行を含む）は表示と一覧を崩すので受け付けない
  if (title.length > MAX_TITLE_LENGTH || /[\u0000-\u001f\u007f]/.test(title)) return undefined;
  return title || null;
}

/**
 * 付箋と接続線を、その内容に合わせるための更新デルタにする（拒否した操作の送信元に、
 * サーバーの現在値を伝えるのに使う）。同期しない zIndex と、変更できない from / to は含めない
 */
function contentToDeltas(content: BoardContent): HistoryDelta[] {
  return [
    ...content.notes.map(({ id, zIndex: _zIndex, ...after }): HistoryDelta => ({
      type: 'note:update', noteId: id, before: {}, after: { ...UNSET_FLAGS, ...after },
    })),
    ...content.edges.map(({ id, from: _from, to: _to, ...after }): HistoryDelta => ({
      type: 'edge:update', edgeId: id, before: {}, after,
    })),
  ];
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
