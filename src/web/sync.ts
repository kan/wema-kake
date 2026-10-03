// wema のボードとサーバー（ページ DO）の同期。
// ボードの操作の確定（history:commit）を ops として送り、受信した ops を applyRemote() で反映する。
// DOM には依存しない（ボードとソケットは引数で受け取る）ので、テストからも動かせる。
import { type BoardData, type HistoryDelta, invertDeltas } from '../shared/delta';
import {
  CLOSE_AUTH_EXPIRED,
  CLOSE_PAGE_DELETED,
  type ClientMsg,
  type OpsMsg,
  PING,
  PONG,
  type ServerMsg,
} from '../shared/protocol';

/** 同期に使う、ボードの操作。WemaBoard がこの形を満たす */
export interface SyncBoard {
  applyRemote(deltas: HistoryDelta[]): void;
  importData(data: BoardData): void;
  on(event: 'history:commit', handler: (payload: { deltas: HistoryDelta[] }) => void): void;
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
  private socket: SyncSocket | undefined;
  private status: SyncStatus = 'connecting';
  private ready = false;
  private stopped = false;
  private retries = 0;
  private stopPing: (() => void) | undefined;
  private stopRetry: (() => void) | undefined;

  constructor(
    private readonly board: SyncBoard,
    private readonly connect: () => Promise<SyncSocket>,
    private readonly hooks: SyncHooks = {},
  ) {
    board.on('history:commit', ({ deltas }) => this.commit(deltas));
  }

  start(): void {
    this.setStatus('connecting');
    void this.open();
  }

  stop(): void {
    this.stopped = true;
    this.stopPing?.();
    this.stopRetry?.();
    this.socket?.close();
  }

  /** 未確定の操作の数 */
  get pendingCount(): number {
    return this.pending.length;
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
      if (this.hooks.isAuthenticated && !(await this.hooks.isAuthenticated())) this.authExpired();
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
    if (code === CLOSE_AUTH_EXPIRED) {
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
        this.board.importData(msg.data);
        this.lastSeq = msg.seq;
        this.snapshotSeq = msg.seq;
        this.epoch = msg.epoch ?? undefined;
        // 全体を入れ替えたので、未確定の操作は手元から消えている
        for (const op of this.pending) op.applied = false;
        this.hooks.onTitle?.(msg.title);
        this.synced();
        break;
      case 'meta':
        this.epoch = msg.epoch ?? undefined;
        this.hooks.onTitle?.(msg.title);
        // 差分で追いつく場合は、最初に meta が届く
        this.synced();
        break;
      case 'ops':
        this.onOps(msg);
        break;
      case 'reject':
        this.onReject(msg.opId, msg.reason, msg.fixups ?? []);
        break;
    }
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

  private onOps(msg: OpsMsg): void {
    this.lastSeq = Math.max(this.lastSeq ?? 0, msg.seq);
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
    this.board.applyRemote([...rollback, ...fixups, ...later]);
    this.hooks.onReject?.(reason);
    this.setStatus(this.status);
  }
}
