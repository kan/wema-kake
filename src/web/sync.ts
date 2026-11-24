// wema のボードとサーバー（ページ DO）の同期。
// ボードの操作の確定（history:commit）を ops として送り、受信した ops を applyRemote() で反映する。
// DOM には依存しない（ボードとソケットは引数で受け取る）ので、テストからも動かせる。
import { type BoardData, type HistoryDelta, invertDeltas, type WemaNote } from '../shared/delta';
import { applyOpToInfos, type NoteInfo, type Reaction } from '../shared/note-info';
import {
  CLOSE_AUTH_EXPIRED,
  CLOSE_NOT_APPROVED,
  CLOSE_PAGE_DELETED,
  type ClientMsg,
  MAX_PREVIEW_NOTES,
  type OpsMsg,
  PING,
  PONG,
  PREVIEW_INTERVAL_MS,
  PREVIEW_KEYS,
  type PreviewKey,
  type PreviewNote,
  type PreviewValues,
  type ServerMsg,
} from '../shared/protocol';

/** 付箋の値のうち、同期が読むもの */
type SyncNote = Pick<WemaNote, 'id' | 'autoSize' | 'foldable' | PreviewKey>;

/** ボードの `note:update` のハンドラー */
export type NoteUpdateHandler = (payload: { note: SyncNote; prev: SyncNote; origin: 'local' | 'remote' }) => void;

/** 同期に使う、ボードの操作。WemaBoard がこの形を満たす */
export interface SyncBoard {
  applyRemote(deltas: HistoryDelta[]): void;
  /** 付箋の今の値。付箋の書き込み者を変えるかの判定（大きさの決まり方）と、途中の動きの反映に使う */
  getNote(id: string): SyncNote | undefined;
  importData(data: BoardData): void;
  on(event: 'history:commit', handler: (payload: { deltas: HistoryDelta[] }) => void): void;
  /** 手元（`local`）のドラッグと大きさの変更の途中の動きを、ほかの人へ送るのに使う */
  on(event: 'note:update', handler: NoteUpdateHandler): void;
  /** 参照モードでの移動は、その画面だけの一時的なものなので、ほかの人へ送らない */
  isViewOnly?(): boolean;
}

/**
 * ほかの人の途中の動きを当ててから、確定の ops が届かないまま、確定した値へ戻すまでの時間（ミリ秒）。
 * 送り主の接続が切れたときや、動かした付箋を元の位置で離したとき（確定の ops が出ない）に戻す
 */
export const PREVIEW_TIMEOUT_MS = 10_000;

/**
 * 手元で最後に動かしてから、この時間（ミリ秒）は、その付箋にほかの人の途中の動きを当てない。元の位置で
 * 離したとき（確定が出ず、動かし終えたと分からない）に、ほかの人の動きが長く止まらないよう、短くしてある
 */
const MOVING_HERE_MS = 2_000;

/** ほかの人の途中の動きを当てている付箋 */
interface ShownPreview {
  /** 動かしている接続。その接続の確定の ops が届いたら終わる */
  clientId: string;
  /** 当てる前の、確定している値（当てたキーだけ）。確定の ops が届いたら、その値に更新する */
  base: PreviewValues;
  /** 最後に途中の動きを受け取った時刻。`PREVIEW_TIMEOUT_MS` を過ぎたら戻す */
  at: number;
}

/** デルタが触る付箋の id */
const noteIdOf = (d: HistoryDelta): string | undefined =>
  d.type === 'note:update' ? d.noteId : d.type === 'note:create' || d.type === 'note:delete' ? d.note.id : undefined;

/**
 * 手元の付箋の変更から、途中の動きとして送る値を取り出す。中身に合わせて決まる大きさ（autoSize の幅と
 * 高さ、foldable の高さ）は、ほかの人の画面でも中身から決まるので送らない。変わっていなければ undefined
 */
function previewOf(note: SyncNote, prev: SyncNote): PreviewValues | undefined {
  const values: PreviewValues = {};
  for (const key of PREVIEW_KEYS) {
    if (note.autoSize === true && (key === 'width' || key === 'height')) continue;
    if (note.foldable === true && key === 'height') continue;
    if (note[key] !== prev[key]) values[key] = note[key];
  }
  return Object.keys(values).length > 0 ? values : undefined;
}

/** 接続済みのソケット */
export interface SyncSocket {
  send(data: string): void;
  close(): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: (code: number) => void): void;
}

/** ブラウザと Workers の WebSocket に共通する部分 */
interface WebSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'close', listener: (event: { code: number }) => void): void;
}

/** 接続済みの WebSocket を、BoardSync が使う形に包む */
export function toSyncSocket(ws: WebSocketLike): SyncSocket {
  return {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    onMessage: (handler) => ws.addEventListener('message', (e) => handler(String(e.data))),
    onClose: (handler) => ws.addEventListener('close', (e) => handler(e.code)),
  };
}

/**
 * - connecting: 接続中、または最初の同期を待っている
 * - synced: サーバーと同期している（未確定の操作は `pending` 件）
 * - offline: 切断されていて、再接続を待っている。操作は手元にためておき、再接続後に送る
 */
export type SyncStatus = 'connecting' | 'synced' | 'offline';

export interface SyncHooks {
  onStatus?(status: SyncStatus, pending: number): void;
  /** 最初の同期が済み、ボードを編集できる状態になった */
  onReady?(): void;
  onTitle?(title: string | null): void;
  /** ページの色。付けていなければ null */
  onColor?(color: string | null): void;
  /** 古い付箋を自動で消すまでの日数。付けていなければ null */
  onExpireDays?(days: number | null): void;
  /**
   * ページのロック（編集の禁止）と、期限を数え始める時刻（最後にロックを外した時刻。なければ null）。
   * スナップショットと meta のたびに呼ぶ
   */
  onLock?(locked: boolean, expireSince: number | null): void;
  /** 認証の期限が切れた。再接続はできないので、ページを読み込み直して認証し直す */
  onAuthExpired?(): void;
  /**
   * 接続に失敗したときに、認証がまだ有効かを確かめる。WebSocket の接続の失敗からは理由が
   * 分からないので、切断中に認証が切れた場合をこれで見分ける。false なら `onAuthExpired` を呼ぶ
   */
  isAuthenticated?(): Promise<boolean>;
  /** ページが削除された。再接続はしない */
  onDeleted?(): void;
  /** 自分の操作がサーバーに拒否され、手元の変更を巻き戻した */
  onReject?(reason: string): void;
  /**
   * 付箋の付加情報（`noteInfo()`）が、確定した操作で変わった。`noteIds` には、削除された付箋も入る。
   * スナップショットで全体が入れ替わったときは呼ばない（ボードが、すべての付箋を描き直す）
   */
  onNoteInfo?(noteIds: Set<string>): void;
}

const PING_INTERVAL_MS = 30_000;
const MAX_RETRY_DELAY_MS = 30_000;

/** 送信済みで、まだサーバーから確定が返っていない操作 */
interface Pending {
  opId: string;
  deltas: HistoryDelta[];
  /**
   * 手元のボードに適用済みか。スナップショットで全体を入れ替えると false になる
   * （そのあと確定が返ってきたら、サーバーが適用した内容を手元にも適用する）
   */
  applied: boolean;
}

/** 更新のデルタが変える対象を表すキー */
function updateTarget(d: HistoryDelta): string | undefined {
  if (d.type === 'note:update') return `note:${d.noteId}`;
  if (d.type === 'edge:update') return `edge:${d.edgeId}`;
  return undefined;
}

/** デルタが触る付箋と接続線 */
function targetsOf(deltas: HistoryDelta[]): Set<string> {
  const targets = new Set<string>();
  for (const d of deltas) {
    if (d.type === 'note:update' || d.type === 'edge:update') targets.add(updateTarget(d)!);
    else if (d.type === 'note:create' || d.type === 'note:delete') targets.add(`note:${d.note.id}`);
    else targets.add(`edge:${d.edge.id}`);
  }
  return targets;
}

export class BoardSync {
  readonly clientId = crypto.randomUUID();
  private lastSeq: number | undefined;
  /** 最後に受け取ったスナップショットの seq。これ以前の操作は、スナップショットに含まれている */
  private snapshotSeq = 0;
  /**
   * 最後に受け取ったスナップショットのページの epoch。再接続のときに送り、ページが削除されたか
   * 作り直されていたら、サーバーに接続を閉じてもらう（未確定の操作を送り直さないため）
   */
  private epoch: string | undefined;
  private pending: Pending[] = [];
  /** 付箋ごとの付加情報。自分が作って、まだ確定していない付箋のものは入っていない */
  private infos = new Map<string, NoteInfo>();
  private socket: SyncSocket | undefined;
  private status: SyncStatus = 'connecting';
  private ready = false;
  private stopped = false;
  private retries = 0;
  private stopPing: (() => void) | undefined;
  private stopRetry: (() => void) | undefined;
  /** まだ送っていない、手元の途中の動き（付箋ごとの最新の値）。`PREVIEW_INTERVAL_MS` ごとにまとめて送る */
  private outgoing = new Map<string, PreviewNote>();
  private outgoingTimer: ReturnType<typeof setTimeout> | undefined;
  /** 手元で動かしている付箋と、最後に動かした時刻。ほかの人の途中の動きを当てない */
  private movingHere = new Map<string, number>();
  /** ほかの人の途中の動きを当てている付箋 */
  private previews = new Map<string, ShownPreview>();
  /** 当てている途中の動きのうち、期限を過ぎたものを戻すタイマー（当てている間だけ 1 本動かす） */
  private sweepTimer: ReturnType<typeof setTimeout> | undefined;

  /** @param options.previewTimeoutMs `PREVIEW_TIMEOUT_MS` の代わり（テストで短くする） */
  constructor(
    private readonly board: SyncBoard,
    private readonly connect: () => Promise<SyncSocket>,
    private readonly hooks: SyncHooks = {},
    private readonly options: { previewTimeoutMs?: number } = {},
  ) {
    board.on('history:commit', ({ deltas }) => this.commit(deltas));
    board.on('note:update', ({ note, prev, origin }) => {
      if (origin === 'local') this.moveHere(note, prev);
    });
  }

  start(): void {
    this.setStatus('connecting');
    void this.open();
  }

  stop(): void {
    this.stopped = true;
    this.stopPing?.();
    this.stopRetry?.();
    this.cancelOutgoing();
    this.clearPreviews();
    this.socket?.close();
  }

  /** 未確定の操作の数 */
  get pendingCount(): number {
    return this.pending.length;
  }

  /** 付箋の付加情報（作成者、更新日時）。サーバーからまだ届いていなければ undefined */
  noteInfo(noteId: string): NoteInfo | undefined {
    return this.infos.get(noteId);
  }

  private setStatus(status: SyncStatus): void {
    this.status = status;
    this.hooks.onStatus?.(status, this.pending.length);
  }

  private send(msg: ClientMsg): void {
    this.socket?.send(JSON.stringify(msg));
  }

  private authExpired(): void {
    this.stopped = true;
    this.hooks.onAuthExpired?.();
  }

  private async open(): Promise<void> {
    if (this.stopped) return;
    let socket: SyncSocket;
    try {
      socket = await this.connect();
    } catch {
      // 接続を待っている間に止められていたら、何もしない（フックを呼ぶと、切り替えた先の画面を
      // 読み込み直したり、古い画面の表示を書き換えたりする）
      if (this.stopped) return;
      const expired = this.hooks.isAuthenticated !== undefined && !(await this.hooks.isAuthenticated());
      if (this.stopped) return;
      if (expired) this.authExpired();
      else this.scheduleReconnect();
      return;
    }
    if (this.stopped) {
      socket.close();
      return;
    }
    this.socket = socket;
    socket.onMessage((data) => this.onMessage(data));
    socket.onClose((code) => this.onClose(socket, code));

    this.send({ type: 'hello', clientId: this.clientId, lastSeq: this.lastSeq, epoch: this.epoch });
    // 確定を受け取っていない操作を送り直す。適用済みなら、サーバーは記録済みの結果を返す
    for (const { opId, deltas } of this.pending) this.send({ type: 'ops', opId, deltas });

    const timer = setInterval(() => this.socket?.send(PING), PING_INTERVAL_MS);
    this.stopPing = () => clearInterval(timer);
  }

  private onClose(socket: SyncSocket, code: number): void {
    if (this.socket !== socket) return;
    this.socket = undefined;
    this.stopPing?.();
    if (this.stopped) return;
    // 承認の取り消しも、読み込み直して、サーバーに状態を確かめ直してもらう（承認待ちの表示になる）
    if (code === CLOSE_AUTH_EXPIRED || code === CLOSE_NOT_APPROVED) {
      this.authExpired();
    } else if (code === CLOSE_PAGE_DELETED) {
      // 再接続すると、手元の未確定の操作でページが作り直されてしまう
      this.stopped = true;
      this.hooks.onDeleted?.();
    } else {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    this.setStatus(this.ready ? 'offline' : 'connecting');
    const delay = Math.min(1000 * 2 ** this.retries, MAX_RETRY_DELAY_MS);
    this.retries++;
    const timer = setTimeout(() => void this.open(), delay);
    this.stopRetry = () => clearTimeout(timer);
  }

  /** ボードで操作が確定した。手元にはすでに適用されている */
  private commit(deltas: HistoryDelta[]): void {
    // 確定した付箋の途中の動きは、もう送らない（確定の ops が、最後の値を運ぶ）。ドラッグ以外の変更
    // （整列、取り消しなど）は、変更と確定が同じ処理の中で続くので、途中の動きとしては送られない
    for (const d of deltas) {
      const id = noteIdOf(d);
      if (id === undefined) continue;
      this.outgoing.delete(id);
      this.movingHere.delete(id);
    }
    const op: Pending = { opId: crypto.randomUUID(), deltas, applied: true };
    this.pending.push(op);
    this.send({ type: 'ops', opId: op.opId, deltas });
    this.setStatus(this.status);
  }

  private onMessage(data: string): void {
    if (data === PONG) return;
    const msg = JSON.parse(data) as ServerMsg;
    switch (msg.type) {
      case 'snapshot':
        // 付箋を描く処理が読めるよう、ボードを入れ替える前に更新する
        // `info` を返さない古い Worker につながることがある（デプロイの途中）
        this.infos = new Map(Object.entries(msg.info ?? {}));
        // 入れ替えで、当てていた途中の動きは消える
        this.clearPreviews();
        this.board.importData(msg.data);
        this.lastSeq = msg.seq;
        this.snapshotSeq = msg.seq;
        this.epoch = msg.epoch ?? undefined;
        // 全体を入れ替えたので、未確定の操作は手元から消えている
        for (const op of this.pending) op.applied = false;
        this.hooks.onTitle?.(msg.title);
        this.hooks.onColor?.(msg.color);
        // 返さない古い Worker につながることがある（デプロイの途中）
        this.hooks.onExpireDays?.(msg.expireDays ?? null);
        this.hooks.onLock?.(msg.locked ?? false, msg.expireSince ?? null);
        this.synced();
        break;
      case 'meta':
        this.epoch = msg.epoch ?? undefined;
        this.hooks.onTitle?.(msg.title);
        this.hooks.onColor?.(msg.color);
        this.hooks.onExpireDays?.(msg.expireDays ?? null);
        this.hooks.onLock?.(msg.locked ?? false, msg.expireSince ?? null);
        // 差分で追いつく場合は、最初に meta が届く
        this.synced();
        break;
      case 'ops':
        this.onOps(msg);
        break;
      case 'reactions':
        this.onReactions(msg.reactions, msg.replace === true);
        break;
      case 'reject':
        this.onReject(msg.opId, msg.reason, msg.fixups ?? []);
        break;
      case 'preview':
        this.onPreview(msg.clientId, msg.notes);
        break;
    }
  }

  // --- ドラッグや大きさの変更の途中の動き（issue #123） ---

  /** 手元の付箋が動いた。確定（history:commit）しないまま続くものを、途中の動きとして送る */
  private moveHere(note: SyncNote, prev: SyncNote): void {
    if (this.board.isViewOnly?.()) return;
    const values = previewOf(note, prev);
    if (!values) return;
    this.movingHere.set(note.id, Date.now());
    // ほかの人の途中の動きを当てていた付箋を、自分で動かし始めた。戻さずに、自分の動きを優先する
    this.dropPreview(note.id);
    this.outgoing.set(note.id, { ...this.outgoing.get(note.id), ...values, id: note.id });
    this.outgoingTimer ??= setTimeout(() => this.flushPreview(), PREVIEW_INTERVAL_MS);
  }

  private cancelOutgoing(): void {
    if (this.outgoingTimer !== undefined) clearTimeout(this.outgoingTimer);
    this.outgoingTimer = undefined;
    this.outgoing.clear();
  }

  private flushPreview(): void {
    this.outgoingTimer = undefined;
    const notes = [...this.outgoing.values()].slice(0, MAX_PREVIEW_NOTES);
    for (const note of notes) this.outgoing.delete(note.id);
    // 1 回に入りきらなかった付箋は、次に送る
    if (this.outgoing.size > 0) this.outgoingTimer = setTimeout(() => this.flushPreview(), PREVIEW_INTERVAL_MS);
    // 切断中の途中の動きは、ためずに捨てる（確定の ops は、再接続の後に送る）
    if (notes.length > 0 && this.status === 'synced') this.send({ type: 'preview', notes });
  }

  private get previewTimeoutMs(): number {
    return this.options.previewTimeoutMs ?? PREVIEW_TIMEOUT_MS;
  }

  private isMovingHere(noteId: string): boolean {
    const at = this.movingHere.get(noteId);
    return at !== undefined && Date.now() - at < MOVING_HERE_MS;
  }

  /**
   * ほかの人の途中の動きを、手元の付箋に当てる。履歴には積まず、付加情報（書き込み者、更新日時）も
   * 変えない（`applyRemote` は history:commit を出さない）。手元で動かしている付箋には当てない
   */
  private onPreview(clientId: string, notes: PreviewNote[]): void {
    if (clientId === this.clientId) return;
    const deltas: HistoryDelta[] = [];
    const now = Date.now();
    for (const { id, ...values } of notes) {
      const note = this.board.getNote(id);
      if (!note || this.isMovingHere(id)) continue;
      let shown = this.previews.get(id);
      if (shown) Object.assign(shown, { clientId, at: now });
      else this.previews.set(id, (shown = { clientId, base: {}, at: now }));
      const before: PreviewValues = {};
      const after: PreviewValues = {};
      for (const key of PREVIEW_KEYS) {
        const value = values[key];
        if (value === undefined || typeof note[key] !== 'number') continue;
        before[key] = note[key];
        after[key] = value;
        if (!(key in shown.base)) shown.base[key] = note[key];
      }
      if (Object.keys(after).length > 0) deltas.push({ type: 'note:update', noteId: id, before, after });
    }
    if (deltas.length > 0) this.board.applyRemote(deltas);
    this.scheduleSweep();
  }

  /** 当てている途中の動きのうち、いちばん早く期限が来るものに合わせて、タイマーを掛ける */
  private scheduleSweep(): void {
    if (this.sweepTimer !== undefined || this.previews.size === 0) return;
    const oldest = Math.min(...[...this.previews.values()].map((s) => s.at));
    this.sweepTimer = setTimeout(() => this.sweep(), Math.max(0, oldest + this.previewTimeoutMs - Date.now()));
  }

  /** 確定の ops が `PREVIEW_TIMEOUT_MS` 届かなかった途中の動きを、確定している値に戻す */
  private sweep(): void {
    this.sweepTimer = undefined;
    const now = Date.now();
    for (const [id, shown] of [...this.previews]) {
      if (now - shown.at >= this.previewTimeoutMs) this.endPreview(id);
    }
    this.scheduleSweep();
  }

  /**
   * 新しく届いた確定の ops を、当てている途中の動きに反映する。確定した値を覚え直し、動かしていた接続の
   * 確定が届いたら、その付箋の途中の動きを終える（確定の ops に無いキーは、覚えていた値に戻す）
   */
  private settlePreviews(msg: OpsMsg): void {
    this.rebase(msg.deltas);
    for (const d of msg.deltas) {
      if (d.type === 'note:update' && msg.clientId === this.previews.get(d.noteId)?.clientId) this.endPreview(d.noteId);
    }
  }

  /** 途中の動きを当てている付箋の、確定している値として覚えた値を、`deltas` に合わせる */
  private rebase(deltas: HistoryDelta[]): void {
    if (this.previews.size === 0) return;
    for (const d of deltas) {
      if (d.type === 'note:delete') {
        this.dropPreview(d.note.id);
        continue;
      }
      if (d.type !== 'note:update') continue;
      const shown = this.previews.get(d.noteId);
      if (!shown) continue;
      const after = d.after as Record<string, unknown>;
      for (const key of PREVIEW_KEYS) {
        const value = after[key];
        if (typeof value === 'number') shown.base[key] = value;
      }
    }
  }

  /** 途中の動きを終え、付箋を確定している値に戻す */
  private endPreview(noteId: string): void {
    const shown = this.previews.get(noteId);
    if (!shown) return;
    this.dropPreview(noteId);
    const note = this.board.getNote(noteId);
    if (!note) return;
    const before: PreviewValues = {};
    for (const key of Object.keys(shown.base) as PreviewKey[]) before[key] = note[key];
    this.board.applyRemote([{ type: 'note:update', noteId, before, after: { ...shown.base } }]);
  }

  /** 途中の動きを、付箋を戻さずに忘れる（期限のタイマーは、残っていても空振りするだけ） */
  private dropPreview(noteId: string): void {
    this.previews.delete(noteId);
  }

  private clearPreviews(): void {
    this.previews.clear();
    if (this.sweepTimer !== undefined) clearTimeout(this.sweepTimer);
    this.sweepTimer = undefined;
  }

  /** サーバーから最初の応答が届いた。以降は同期している */
  private synced(): void {
    this.retries = 0;
    this.setStatus('synced');
    if (!this.ready) {
      this.ready = true;
      this.hooks.onReady?.();
    }
  }

  private takePending(opId: string): Pending | undefined {
    const index = this.pending.findIndex((op) => op.opId === opId);
    return index === -1 ? undefined : this.pending.splice(index, 1)[0];
  }

  /**
   * 手元に適用済みの未確定の操作のうち、`targets` を更新するデルタ。
   * サーバーの変更を手元に適用すると、同じ付箋や接続線への未確定の変更が上書きされる。
   * 未確定の操作はサーバーでは後から適用され、後勝ちで残るので、手元でも上に適用し直す。
   */
  private pendingUpdates(targets: Set<string>): HistoryDelta[] {
    return this.pending
      .filter((op) => op.applied)
      .flatMap((op) => op.deltas)
      .filter((d) => {
        const target = updateTarget(d);
        return target !== undefined && targets.has(target);
      });
  }

  /** サーバーで確定した変更を手元に反映する。同じ対象への未確定の変更は、その上に残す */
  private applyServer(deltas: HistoryDelta[]): void {
    if (deltas.length === 0) return;
    this.board.applyRemote([...deltas, ...this.pendingUpdates(targetsOf(deltas))]);
  }

  /**
   * 付箋のリアクションを、付加情報に反映する。`replace` なら、ここにない付箋のリアクションを消す。
   * 手元に付加情報のない付箋（まだ確定していない、もうない）は、無視する
   */
  private onReactions(reactions: Record<string, Reaction[]>, replace: boolean): void {
    const changed = new Set<string>();
    const set = (id: string, list: Reaction[]) => {
      const info = this.infos.get(id);
      if (!info) return;
      const { reactions: _, ...rest } = info;
      this.infos.set(id, list.length > 0 ? { ...rest, reactions: list } : rest);
      changed.add(id);
    };
    if (replace) {
      for (const [id, info] of this.infos) if (info.reactions && !Object.hasOwn(reactions, id)) set(id, []);
    }
    for (const [id, list] of Object.entries(reactions)) set(id, list);
    if (changed.size > 0) this.hooks.onNoteInfo?.(changed);
  }

  /** 付箋の今のリアクション（API の応答）を反映する。切断中で、配信が届かないときのため */
  setReactions(noteId: string, reactions: Reaction[]): void {
    this.onReactions({ [noteId]: reactions }, false);
  }

  private onOps(msg: OpsMsg): void {
    const fresh = msg.seq > (this.lastSeq ?? 0);
    // 古い操作（再送への応答など）の値で、確定している値を覚え直さない
    if (fresh) this.settlePreviews(msg);
    // すでに受け取った seq までの操作は、付加情報に反映してある（スナップショットに含まれていた操作、
    // 再送への応答）。もう一度反映すると、更新日時が古い値に戻る。
    // 付箋を描く処理が読めるよう、ボードに反映する前に更新する
    const changed =
      msg.createdAt !== undefined && fresh
        ? applyOpToInfos(this.infos, msg.actor, msg.createdAt, msg.deltas, msg.delegate ?? null, (id) =>
            this.board.getNote(id),
          )
        : undefined;
    this.lastSeq = Math.max(this.lastSeq ?? 0, msg.seq);
    this.applyOps(msg);
    if (changed?.size) this.hooks.onNoteInfo?.(changed);
  }

  private applyOps(msg: OpsMsg): void {
    // 取り消し（reverts）は API から行うので、自分の clientId でも手元には適用していない
    const own = msg.clientId === this.clientId && msg.reverts === undefined;
    if (!own) {
      this.applyServer(msg.deltas);
      return;
    }
    // 自分の操作の確定。再送に対する 2 回目の応答など、覚えのないものは無視する
    const op = this.takePending(msg.opId);
    if (!op) return;
    if (op.applied) {
      this.applyServer(msg.fixups ?? []);
    } else if (msg.seq > this.snapshotSeq) {
      // スナップショットで手元から消えた操作が、その後にサーバーで適用された
      this.applyServer(msg.deltas);
    }
    // それ以外（確定を受け取る前に切断していた操作）は、スナップショットにすでに含まれている。
    // 適用し直すと、その後の他の人の変更を古い値で上書きしてしまう
    this.setStatus(this.status);
  }

  private onReject(opId: string, reason: string, fixups: HistoryDelta[]): void {
    const op = this.takePending(opId);
    if (!op) return;
    // 手元に適用済みの変更を巻き戻し、サーバーの現在値（text が競合した付箋など）に合わせる。
    // その上に、後続の未確定の操作を適用し直す（巻き戻しと現在値の反映で打ち消されるため）
    const rollback = op.applied ? invertDeltas(op.deltas) : [];
    const later = this.pending.filter((p) => p.applied).flatMap((p) => p.deltas);
    // ほかの人の途中の動きを当てている付箋では、確定している値として覚えた値も、断られた変更の前に戻す
    this.rebase([...rollback, ...fixups]);
    this.board.applyRemote([...rollback, ...fixups, ...later]);
    this.hooks.onReject?.(reason);
    this.setStatus(this.status);
  }
}
