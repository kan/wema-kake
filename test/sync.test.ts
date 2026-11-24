// ブラウザ側の同期（src/web/sync.ts）を、実際の Worker と DO に接続して確かめる。
// ボードは wema の代わりに、applyRemote と同じ規則でデルタを適用する簡単なモデルを使う。
import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import type { BoardData, HistoryDelta, WemaEdge, WemaNote } from '../src/shared/delta';
import type { PreviewValues } from '../src/shared/protocol';
import {
  BoardSync,
  type NoteUpdateHandler,
  type SyncBoard,
  type SyncHooks,
  type SyncSocket,
  type SyncStatus,
  toSyncSocket,
} from '../src/web/sync';
import { api, createNote, edge, join, note } from './helpers';

type Obj = Record<string, unknown>;

class FakeBoard implements SyncBoard {
  notes = new Map<string, WemaNote>();
  edges = new Map<string, WemaEdge>();
  private handlers: ((payload: { deltas: HistoryDelta[] }) => void)[] = [];
  private updateHandlers: NoteUpdateHandler[] = [];
  viewOnly = false;

  getNote(id: string) {
    return this.notes.get(id);
  }

  isViewOnly() {
    return this.viewOnly;
  }

  on(event: 'history:commit', handler: (payload: { deltas: HistoryDelta[] }) => void): void;
  on(event: 'note:update', handler: NoteUpdateHandler): void;
  // biome-ignore lint/suspicious/noExplicitAny: 上の 2 つの形の実装
  on(event: string, handler: any) {
    if (event === 'history:commit') this.handlers.push(handler);
    else this.updateHandlers.push(handler);
  }

  /**
   * ドラッグの途中（wema は、離すまで history:commit を出さずに、note:update を出し続ける）。
   * 手元の付箋を動かし、`local` の note:update を出す
   */
  drag(id: string, values: PreviewValues) {
    const prev = this.notes.get(id)!;
    const note = { ...prev, ...values };
    this.notes.set(id, note);
    for (const handler of this.updateHandlers) handler({ note, prev, origin: 'local' });
  }

  importData(data: BoardData) {
    this.notes = new Map(data.notes.map((n) => [n.id, n]));
    this.edges = new Map(data.edges.map((e) => [e.id, e]));
  }

  /** wema の applyRemote と同じ規則: 対象がなければ無視し、before にだけあるキーは未設定に戻す */
  applyRemote(deltas: HistoryDelta[]) {
    const patch = (target: Obj, before: Obj, after: Obj) => {
      for (const key of Object.keys(before)) if (!(key in after)) delete target[key];
      Object.assign(target, after);
    };
    for (const d of deltas) {
      switch (d.type) {
        case 'note:create':
          if (!this.notes.has(d.note.id)) this.notes.set(d.note.id, { ...d.note });
          break;
        case 'note:delete':
          this.notes.delete(d.note.id);
          for (const e of this.edges.values()) {
            if (e.from === d.note.id || e.to === d.note.id) this.edges.delete(e.id);
          }
          break;
        case 'note:update': {
          const n = this.notes.get(d.noteId);
          if (n) patch(n as unknown as Obj, d.before, d.after);
          break;
        }
        case 'edge:create':
          if (!this.edges.has(d.edge.id) && this.notes.has(d.edge.from) && this.notes.has(d.edge.to)) {
            this.edges.set(d.edge.id, { ...d.edge });
          }
          break;
        case 'edge:delete':
          this.edges.delete(d.edge.id);
          break;
        case 'edge:update': {
          const e = this.edges.get(d.edgeId);
          if (e) patch(e as unknown as Obj, d.before, d.after);
          break;
        }
      }
    }
  }

  /** このボードでの操作。手元に適用し、history:commit を発火する */
  act(deltas: unknown[]) {
    const typed = JSON.parse(JSON.stringify(deltas)) as HistoryDelta[];
    this.applyRemote(typed);
    for (const handler of this.handlers) handler({ deltas: typed });
  }

  /** 比較用。autoSize と foldable の false と未設定、zIndex（同期しない）の違いは無視する */
  state() {
    const notes = [...this.notes.values()]
      .map(({ zIndex: _z, autoSize, foldable, ...rest }) => ({
        ...rest,
        autoSize: autoSize === true,
        foldable: foldable === true,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const edges = [...this.edges.values()].sort((a, b) => a.id.localeCompare(b.id));
    return { notes, edges };
  }
}

let pageCount = 0;
const clients: Client[] = [];

interface Client {
  board: FakeBoard;
  sync: BoardSync;
  statuses: SyncStatus[];
  titles: (string | null)[];
  rejects: string[];
  /** 付加情報が変わったと通知された付箋の id */
  infoChanges: string[];
  authExpired: boolean;
  /** 現在の接続をサーバー側から切る */
  drop(): Promise<void>;
}

const clientIdOf = (c: Client) => c.sync.clientId;

/** Workers の WebSocket は、使う前に accept() が要る */
function wrapSocket(ws: WebSocket): SyncSocket {
  ws.accept();
  return toSyncSocket(ws);
}

async function connectSocket(slug: string): Promise<SyncSocket> {
  const res = await api(`/ws/${slug}`, { headers: { Upgrade: 'websocket' } });
  return wrapSocket(res.webSocket!);
}

function newClient(slug: string, connect?: () => Promise<SyncSocket>, previewTimeoutMs?: number): Client {
  const board = new FakeBoard();
  const client: Client = {
    board,
    statuses: [],
    titles: [],
    rejects: [],
    infoChanges: [],
    authExpired: false,
    drop: () =>
      runInDurableObject(env.PAGE.getByName(slug), (_do, state) => {
        for (const ws of state.getWebSockets()) {
          if (ws.deserializeAttachment().clientId === clientIdOf(client)) ws.close(1012, 'test');
        }
      }),
    sync: undefined as unknown as BoardSync,
  };
  const hooks: SyncHooks = {
    onStatus: (status) => client.statuses.push(status),
    onTitle: (title) => client.titles.push(title),
    onReject: (reason) => client.rejects.push(reason),
    onNoteInfo: (ids) => client.infoChanges.push(...ids),
    onAuthExpired: () => void (client.authExpired = true),
  };
  client.sync = new BoardSync(board, connect ?? (() => connectSocket(slug)), hooks, { previewTimeoutMs });
  client.sync.start();
  clients.push(client);
  return client;
}

/** 条件を満たすまで待つ */
async function until(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const synced = (c: Client) => until(() => c.statuses.at(-1) === 'synced' && c.sync.pendingCount === 0);

async function serverState(slug: string) {
  const board = new FakeBoard();
  board.importData((await env.PAGE.getByName(slug).getSnapshot()).data);
  return board.state();
}

afterEach(() => {
  for (const c of clients.splice(0)) c.sync.stop();
});

describe('BoardSync', () => {
  it('2 つのクライアントの操作が相互に反映され、サーバーとも一致する', async () => {
    const slug = `sync-${++pageCount}`;
    const a = newClient(slug);
    const b = newClient(slug);
    await Promise.all([synced(a), synced(b)]);

    a.board.act([createNote('n1'), createNote('n2')]);
    a.board.act([{ type: 'edge:create', edge: edge('e1', 'n1', 'n2', { collapsed: true }) }]);
    await synced(a);
    await until(() => b.board.edges.size === 1);

    b.board.act([{ type: 'note:update', noteId: 'n1', before: { x: 10 }, after: { x: 300 } }]);
    // 折り畳みの解除（before にだけキーがある形）
    b.board.act([{ type: 'edge:update', edgeId: 'e1', before: { collapsed: true }, after: {} }]);
    await synced(b);
    await until(() => a.board.notes.get('n1')?.x === 300 && !('collapsed' in a.board.edges.get('e1')!));

    b.board.act([{ type: 'edge:delete', edge: edge('e1', 'n1', 'n2') }, { type: 'note:delete', note: note('n2') }]);
    await synced(b);
    await until(() => a.board.notes.size === 1);

    const server = await serverState(slug);
    expect(a.board.state()).toEqual(server);
    expect(b.board.state()).toEqual(server);
    expect(server.notes.map((n) => n.id)).toEqual(['n1']);
    // 付箋の付加情報も、サーバーの付箋の行と同じ値になっている
    const { info } = await env.PAGE.getByName(slug).getSnapshot();
    expect(Object.keys(info)).toEqual(['n1']);
    await until(() => a.sync.noteInfo('n1')?.updatedAt === info.n1.updatedAt);
    expect(a.sync.noteInfo('n1')).toEqual(info.n1);
    expect(b.sync.noteInfo('n1')).toEqual(info.n1);
    expect(a.sync.noteInfo('n2')).toBeUndefined();
  });

  it('サーバーがサニタイズで変えた text を、送信元の手元にも反映する', async () => {
    const slug = `sync-${++pageCount}`;
    const a = newClient(slug);
    await synced(a);
    a.board.act([createNote('n1', { text: '<b onclick="x()">a</b>' })]);
    await synced(a);
    expect(a.board.notes.get('n1')?.text).toBe('<b>a</b>');
  });

  it('text の競合で拒否されたら、手元の変更を巻き戻してサーバーの値に合わせる', async () => {
    const slug = `sync-${++pageCount}`;
    const a = newClient(slug);
    const b = newClient(slug);
    await Promise.all([synced(a), synced(b)]);
    a.board.act([createNote('n1', { text: 'v1' })]);
    await until(() => b.board.notes.has('n1'));

    // a の変更が b に届く前に、b が同じ付箋の text を書き換えた状況を作る
    await env.PAGE.getByName(slug).applyOps({
      actor: 'user:x', clientId: 'cx', opId: 'o1',
      deltas: [{ type: 'note:update', noteId: 'n1', before: { text: 'v1' }, after: { text: 'server' } }],
    });
    b.board.notes.get('n1')!.text = 'v1';
    b.board.act([{ type: 'note:update', noteId: 'n1', before: { text: 'v1' }, after: { text: 'mine', x: 500 } }]);

    await until(() => b.rejects.length === 1);
    expect(b.rejects).toEqual(['text conflict']);
    expect(b.board.notes.get('n1')).toMatchObject({ text: 'server', x: 10 });
    expect(b.board.state()).toEqual(await serverState(slug));
  });

  it('切断中の操作をためておき、再接続後に送る。切断中の他の人の変更も受け取る', async () => {
    const slug = `sync-${++pageCount}`;
    const a = newClient(slug);
    const b = newClient(slug);
    await Promise.all([synced(a), synced(b)]);
    a.board.act([createNote('n1')]);
    await until(() => b.board.notes.has('n1'));

    await a.drop();
    await until(() => a.statuses.at(-1) === 'offline');
    a.board.act([createNote('offline-1')]);
    a.board.act([{ type: 'note:update', noteId: 'n1', before: { x: 10 }, after: { x: 77 } }]);
    b.board.act([createNote('by-b')]);
    await synced(b);
    expect(a.sync.pendingCount).toBe(2);

    // 最初の再接続は 1 秒後
    await synced(a);
    await until(() => b.board.notes.size === 3 && a.board.notes.size === 3);
    const server = await serverState(slug);
    expect(a.board.state()).toEqual(server);
    expect(b.board.state()).toEqual(server);
    expect(server.notes.find((n) => n.id === 'n1')?.x).toBe(77);
    // 送り直しで二重に記録されていない
    expect((await env.PAGE.getByName(slug).getSnapshot()).seq).toBe(4);
  });

  it('拒否された操作の後に行った操作は、巻き戻しの後も手元に残る', async () => {
    const slug = `sync-${++pageCount}`;
    const a = newClient(slug);
    await synced(a);
    a.board.act([createNote('n1', { text: 'v1' })]);
    await synced(a);

    // 切断中に text を編集し、続けて同じ付箋を移動する。その間に他の人が text を変える
    await a.drop();
    await until(() => a.statuses.at(-1) === 'offline');
    a.board.act([{ type: 'note:update', noteId: 'n1', before: { text: 'v1' }, after: { text: 'mine' } }]);
    a.board.act([{ type: 'note:update', noteId: 'n1', before: { x: 10 }, after: { x: 400, color: '#000' } }]);
    await env.PAGE.getByName(slug).applyOps({
      actor: 'user:x', clientId: 'cx', opId: 'o1',
      deltas: [{ type: 'note:update', noteId: 'n1', before: { text: 'v1' }, after: { text: 'theirs' } }],
    });

    await until(() => a.rejects.length === 1);
    await synced(a);
    // text の編集は拒否されるが、移動と色の変更は受理され、手元にも残っている
    expect(a.board.notes.get('n1')).toMatchObject({ text: 'theirs', x: 400, color: '#000' });
    expect(a.board.state()).toEqual(await serverState(slug));
  });

  it('未確定の変更がある付箋に他の人の変更が届いても、手元の変更を残す（サーバーでは後勝ちになる）', async () => {
    const slug = `sync-${++pageCount}`;
    const a = newClient(slug);
    await synced(a);
    a.board.act([createNote('n1'), createNote('n2')]);
    await synced(a);

    await a.drop();
    await until(() => a.statuses.at(-1) === 'offline');
    a.board.act([{ type: 'note:update', noteId: 'n1', before: { x: 10 }, after: { x: 400 } }]);
    // 切断中に、他の人が同じ付箋の位置と色、別の付箋の位置を変える
    await env.PAGE.getByName(slug).applyOps({
      actor: 'user:x', clientId: 'cx', opId: 'o1',
      deltas: [
        { type: 'note:update', noteId: 'n1', before: {}, after: { x: 200, color: '#000' } },
        { type: 'note:update', noteId: 'n2', before: {}, after: { x: 200 } },
      ],
    });

    await synced(a);
    // 位置は自分の変更（後から適用される）、色と別の付箋は他の人の変更
    expect(a.board.notes.get('n1')).toMatchObject({ x: 400, color: '#000' });
    expect(a.board.notes.get('n2')).toMatchObject({ x: 200 });
    expect(a.board.state()).toEqual(await serverState(slug));
  });

  it('確定を受け取る前に切断した操作は、スナップショットに含まれていれば適用し直さない', async () => {
    const slug = `sync-${++pageCount}`;
    const a = newClient(slug);
    await synced(a);
    await a.drop();
    await until(() => a.statuses.at(-1) === 'offline');
    a.board.act([createNote('n1')]);

    // サーバーには届いて適用されたが、確定が返る前に切断した状況を作る。
    // その後、他の人がその付箋を消す
    const internals = a.sync as unknown as { pending: { opId: string; deltas: unknown }[]; lastSeq: number };
    const stub = env.PAGE.getByName(slug);
    const { opId, deltas } = internals.pending[0];
    await stub.applyOps({ actor: 'user:dev@example.com', clientId: clientIdOf(a), opId, deltas });
    await stub.applyOps({
      actor: 'user:x', clientId: 'cx', opId: 'o1', deltas: [{ type: 'note:delete', note: note('n1') }],
    });
    // 差分では追いつけず、スナップショットを受け取る状況にする
    internals.lastSeq = 999;

    await synced(a);
    expect(a.board.notes.has('n1')).toBe(false);
    expect(a.board.state()).toEqual(await serverState(slug));
  });

  it('接続に失敗し、認証が切れていたら、再接続せずに通知する', async () => {
    let attempts = 0;
    let expired = false;
    const sync = new BoardSync(
      new FakeBoard(),
      () => {
        attempts++;
        return Promise.reject(new Error('handshake failed'));
      },
      { isAuthenticated: async () => false, onAuthExpired: () => void (expired = true) },
    );
    sync.start();
    await until(() => expired);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(attempts).toBe(1);
    sync.stop();
  });

  it('自分の clientId で記録された取り消しも、リモートの変更として適用する', async () => {
    const slug = `sync-${++pageCount}`;
    const a = newClient(slug);
    await synced(a);
    const stub = env.PAGE.getByName(slug);
    await stub.applyOps({ actor: 'agent:claude', clientId: 'mcp', opId: 'o1', deltas: [createNote('advice')] });
    await until(() => a.board.notes.has('advice'));

    // 画面の取り消しボタンは、自分の clientId を付けて API を呼ぶ
    const clientId = clientIdOf(a);
    const res = await api(`/api/pages/${slug}/ops/1/revert`, {
      method: 'POST', body: JSON.stringify({ clientId, opId: 'rv1' }),
    });
    expect(res.status).toBe(200);
    await until(() => !a.board.notes.has('advice'));
  });

  it('切断中にページが削除されたら、再接続しても未確定の操作を送り直さない', async () => {
    const slug = `sync-${++pageCount}`;
    let deleted = false;
    const board = new FakeBoard();
    const sync = new BoardSync(board, () => connectSocket(slug), { onDeleted: () => void (deleted = true) });
    sync.start();
    await until(() => sync.pendingCount === 0);
    // ページを作る（このとき epoch を受け取る）
    board.act([createNote('n1')]);
    await until(() => sync.pendingCount === 0);

    // 切断し、切断中に付箋を足す。その間にページが削除され、別の人が作り直す
    const stub = env.PAGE.getByName(slug);
    await runInDurableObject(stub, (_do, state) => {
      for (const ws of state.getWebSockets()) ws.close(1012, 'test');
    });
    await until(() => sync.pendingCount === 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    board.act([createNote('written-offline')]);
    expect(sync.pendingCount).toBe(1);
    await api(`/api/pages/${slug}`, { method: 'DELETE' });
    await stub.applyOps({ actor: 'user:x', clientId: 'cx', opId: 'o1', deltas: [createNote('recreated')] });

    // 再接続（1 秒後）しても、前のページへの操作は書き込まれない
    await until(() => deleted);
    expect((await serverState(slug)).notes.map((n) => n.id)).toEqual(['recreated']);
    sync.stop();
  });

  it('表示名の変更を受け取る', async () => {
    const slug = `sync-${++pageCount}`;
    const a = newClient(slug);
    await synced(a);
    await env.PAGE.getByName(slug).setTitle('新しい表示名');
    await until(() => a.titles.at(-1) === '新しい表示名');
    // 最初のスナップショットと、ページができた通知では、表示名はまだない
    expect(a.titles.slice(0, -1).every((title) => title === null)).toBe(true);
  });

  it('認証の期限切れで閉じられたら、再接続せずに通知する', async () => {
    const slug = `sync-${++pageCount}`;
    const stub = env.PAGE.getByName(slug);
    let connections = 0;
    const expired = async (): Promise<SyncSocket> => {
      connections++;
      const res = await stub.fetch('http://do/ws', {
        headers: { Upgrade: 'websocket', 'X-Wema-Actor': 'user:a', 'X-Wema-Auth-Expires': '1' },
      });
      return wrapSocket(res.webSocket!);
    };
    const a = newClient(slug, expired);
    await until(() => a.authExpired);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(connections).toBe(1);
  });

  it('リアクションが付加情報に届き、付箋の更新では消えない', async () => {
    const slug = `sync-${++pageCount}`;
    const a = newClient(slug);
    await synced(a);
    a.board.act([createNote('n1')]);
    await synced(a);
    await until(() => a.sync.noteInfo('n1') !== undefined);

    await api(`/api/pages/${slug}/notes/n1/reactions/like`, { method: 'PUT' });
    await until(() => a.sync.noteInfo('n1')?.reactions?.length === 1);
    expect(a.infoChanges).toContain('n1');

    a.board.act([{ type: 'note:update', noteId: 'n1', before: { x: 10 }, after: { x: 300 } }]);
    await synced(a);
    expect(a.sync.noteInfo('n1')?.reactions).toHaveLength(1);
    // 手元の値は、サーバーのスナップショットと一致する
    const { info } = await env.PAGE.getByName(slug).getSnapshot();
    expect(a.sync.noteInfo('n1')).toEqual(info.n1);

    await api(`/api/pages/${slug}/notes/n1/reactions/like`, { method: 'DELETE' });
    await until(() => a.sync.noteInfo('n1')?.reactions === undefined);
  });

  it('付箋の作成者と更新日時が、操作の確定とスナップショットで届く', async () => {
    const slug = `sync-${++pageCount}`;
    const DEV = 'user:dev@example.com';
    const a = newClient(slug);
    const b = newClient(slug);
    await Promise.all([synced(a), synced(b)]);

    // 人が作った付箋。送信元にも、確定で届く
    a.board.act([createNote('n1')]);
    expect(a.sync.noteInfo('n1')).toBeUndefined();
    await synced(a);
    await until(() => b.sync.noteInfo('n1') !== undefined && a.sync.noteInfo('n1') !== undefined);
    expect(a.sync.noteInfo('n1')).toEqual(b.sync.noteInfo('n1'));
    expect(b.sync.noteInfo('n1')?.createdBy).toBe(DEV);

    // agent（MCP）が作った付箋を、人が動かす。作成者は agent のまま、時刻だけが進む
    const stub = env.PAGE.getByName(slug);
    await stub.applyOps({
      actor: 'agent:claude.ai', delegate: 'user:admin@example.com', clientId: 'mcp', opId: 'op1',
      deltas: [createNote('n2')],
    });
    await until(() => a.sync.noteInfo('n2') !== undefined);
    const created = a.sync.noteInfo('n2')!;
    expect(created.createdBy).toBe('agent:claude.ai');
    expect(created.delegate).toBe('user:admin@example.com');
    await new Promise((resolve) => setTimeout(resolve, 5));
    b.board.act([{ type: 'note:update', noteId: 'n2', before: { x: 10 }, after: { x: 300 } }]);
    await synced(b);
    await until(() => (a.sync.noteInfo('n2')?.updatedAt ?? 0) > created.updatedAt);
    expect(a.sync.noteInfo('n2')?.createdBy).toBe('agent:claude.ai');

    // 移動以外の変更（色）をすると、書き込み者がその人になる。委任者は消える
    b.board.act([{ type: 'note:update', noteId: 'n2', before: { color: '#FFF9C4' }, after: { color: '#BBDEFB' } }]);
    await synced(b);
    await until(() => a.sync.noteInfo('n2')?.createdBy === DEV);
    expect(a.sync.noteInfo('n2')?.delegate).toBeNull();

    // autoSize の付箋は、測った大きさが移動に載っても、書き込み者を変えない（wema が送る形）
    await stub.applyOps({
      actor: 'agent:claude.ai', clientId: 'mcp', opId: 'op2', deltas: [createNote('n3', { autoSize: true })],
    });
    await until(() => b.sync.noteInfo('n3') !== undefined);
    b.board.act([
      { type: 'note:update', noteId: 'n3', before: { x: 10, width: 200, height: 150 }, after: { x: 50, width: 240, height: 90 } },
    ]);
    await synced(b);
    await until(() => (a.sync.noteInfo('n3')?.updatedAt ?? 0) > 0 && a.board.notes.get('n3')?.x === 50);
    expect(a.sync.noteInfo('n3')?.createdBy).toBe('agent:claude.ai');

    // 変わった付箋を通知し、手元の値はサーバーのスナップショットと一致する
    expect(a.infoChanges).toEqual(expect.arrayContaining(['n1', 'n2']));
    const { info } = await stub.getSnapshot();
    expect(Object.keys(info).sort()).toEqual(['n1', 'n2', 'n3']);
    for (const id of ['n1', 'n2', 'n3']) {
      expect(a.sync.noteInfo(id)).toEqual(info[id]);
      expect(b.sync.noteInfo(id)).toEqual(info[id]);
    }

    // 後から開いたクライアントは、スナップショットで受け取る
    const c = newClient(slug);
    await synced(c);
    expect(c.sync.noteInfo('n2')).toEqual(info.n2);

    // 削除で消える
    a.board.act([{ type: 'note:delete', note: note('n1') }]);
    await synced(a);
    await until(() => b.sync.noteInfo('n1') === undefined && a.sync.noteInfo('n1') === undefined);
  });
});

// ドラッグや大きさの変更の途中の動き（issue #123）
describe('preview', () => {
  /** 付箋 n1（x: 10, y: 20, 200x150）と、autoSize の n2 があるページに、2 つのクライアントをつなぐ */
  async function setup(previewTimeoutMs?: number) {
    const slug = `preview-${++pageCount}`;
    const a = newClient(slug, undefined, previewTimeoutMs);
    const b = newClient(slug, undefined, previewTimeoutMs);
    await Promise.all([synced(a), synced(b)]);
    a.board.act([createNote('n1'), createNote('n2', { autoSize: true })]);
    await synced(a);
    await until(() => b.board.notes.size === 2 && b.sync.noteInfo('n1') !== undefined);
    return { slug, a, b };
  }

  it('ドラッグの途中の動きが、ほかの人の画面に届く。保存せず、付加情報も変えない。離すと確定の値になる', async () => {
    const { slug, a, b } = await setup();
    const seq = (await env.PAGE.getByName(slug).getSnapshot()).seq;
    const info = b.sync.noteInfo('n1');

    a.board.drag('n1', { x: 100 });
    a.board.drag('n1', { x: 150, y: 60 });
    await until(() => b.board.notes.get('n1')?.x === 150 && b.board.notes.get('n1')?.y === 60);
    // 大きさの変更も届く
    a.board.drag('n1', { width: 320 });
    await until(() => b.board.notes.get('n1')?.width === 320);
    expect(b.sync.noteInfo('n1')).toEqual(info);
    expect((await env.PAGE.getByName(slug).getSnapshot()).seq).toBe(seq);
    expect((await serverState(slug)).notes.find((n) => n.id === 'n1')?.x).toBe(10);

    // 離す（確定）。途中の動きは、確定の値で終わる
    a.board.act([{ type: 'note:update', noteId: 'n1', before: { x: 10, y: 20, width: 200 }, after: { x: 180, y: 70, width: 320 } }]);
    await synced(a);
    await until(() => b.board.notes.get('n1')?.x === 180);
    expect(b.board.notes.get('n1')).toMatchObject({ x: 180, y: 70, width: 320 });
  });

  it('確定の ops に無いキーは、確定している値に戻す（元の位置で離したキー）', async () => {
    const { a, b } = await setup();
    a.board.drag('n1', { x: 300, y: 300 });
    await until(() => b.board.notes.get('n1')?.x === 300);
    // x は元の位置で離し、y だけが変わった
    a.board.act([{ type: 'note:update', noteId: 'n1', before: { y: 20 }, after: { y: 90 } }]);
    await synced(a);
    await until(() => b.board.notes.get('n1')?.y === 90);
    expect(b.board.notes.get('n1')?.x).toBe(10);
  });

  it('確定の ops が届かなければ、しばらくして確定している値に戻す', async () => {
    const { a, b } = await setup(200);
    a.board.drag('n1', { x: 500 });
    await until(() => b.board.notes.get('n1')?.x === 500);
    await until(() => b.board.notes.get('n1')?.x === 10);
  });

  it('その間にほかの人が確定させた値に戻す', async () => {
    const { slug, a, b } = await setup(300);
    a.board.drag('n1', { x: 500 });
    await until(() => b.board.notes.get('n1')?.x === 500);
    // ほかの接続（MCP など）が、同じ付箋の x を確定させた
    await env.PAGE.getByName(slug).applyOps({
      actor: 'agent:claude.ai', clientId: 'mcp', opId: 'op-x', deltas: [{ type: 'note:update', noteId: 'n1', before: { x: 10 }, after: { x: 40 } }],
    });
    await until(() => b.board.notes.get('n1')?.x === 40);
    // a の途中の動きが続いていれば、また当てる。止まれば、確定した 40 に戻す
    a.board.drag('n1', { x: 520 });
    await until(() => b.board.notes.get('n1')?.x === 520);
    await until(() => b.board.notes.get('n1')?.x === 40);
  });

  it('1 回に入りきらない数の付箋を動かしても、残りは次に送る', async () => {
    const { a, b } = await setup();
    const ids = Array.from({ length: 120 }, (_, i) => `m${i}`);
    a.board.act(ids.map((id) => createNote(id)));
    await synced(a);
    await until(() => b.board.notes.size === 122);
    for (const id of ids) a.board.drag(id, { x: 700 });
    await until(() => ids.every((id) => b.board.notes.get(id)?.x === 700));
  });

  it('手元で動かしている付箋には、ほかの人の途中の動きを当てない', async () => {
    const { a, b } = await setup();
    b.board.drag('n1', { x: 77 });
    a.board.drag('n1', { x: 500 });
    a.board.drag('n2', { x: 600 });
    await until(() => b.board.notes.get('n2')?.x === 600);
    expect(b.board.notes.get('n1')?.x).toBe(77);
  });

  it('中身に合わせて決まる大きさ（autoSize）は送らない。参照モードの移動は送らない', async () => {
    const { a, b } = await setup();
    a.board.drag('n2', { x: 90, width: 999, height: 999 });
    await until(() => b.board.notes.get('n2')?.x === 90);
    expect(b.board.notes.get('n2')).toMatchObject({ width: 200, height: 150 });

    a.board.viewOnly = true;
    a.board.drag('n1', { x: 444 });
    a.board.drag('n2', { x: 95 });
    a.board.viewOnly = false;
    a.board.drag('n2', { x: 96 });
    await until(() => b.board.notes.get('n2')?.x === 96);
    expect(b.board.notes.get('n1')?.x).toBe(10);
  });

  it('操作の確定と同じ処理の中の変更（整列、取り消しなど）は、途中の動きとして送らない', async () => {
    const { a, b } = await setup();
    const sent: string[] = [];
    const socket = (a.sync as unknown as { socket: SyncSocket }).socket;
    const send = socket.send.bind(socket);
    socket.send = (data) => {
      sent.push(data);
      send(data);
    };
    a.board.drag('n1', { x: 30 });
    a.board.act([{ type: 'note:update', noteId: 'n1', before: { x: 10 }, after: { x: 30 } }]);
    await synced(a);
    await until(() => b.board.notes.get('n1')?.x === 30);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sent.filter((s) => s.includes('"preview"'))).toEqual([]);
  });

  it('サーバーは、送り主以外へ中継し、送り主の clientId を付ける。不正な内容とロック中のページは捨てる', async () => {
    const slug = `preview-${++pageCount}`;
    // ロックできるのは、あるページだけ
    expect(await env.PAGE.getByName(slug).createPage(slug)).toEqual({ ok: true });
    const a = await join(slug, 'pa');
    const b = await join(slug, 'pb');
    a.send({ type: 'preview', notes: [{ id: 'n1', x: 5, text: 'x' }] });
    expect(await b.next()).toEqual({ type: 'preview', clientId: 'pa', notes: [{ id: 'n1', x: 5 }] });

    for (const notes of [[], [{ id: 'n1', x: 'a' }], [{ id: 'n1', x: null }], [{ x: 1 }], 'n1']) a.send({ type: 'preview', notes });
    a.send({ type: 'preview', notes: Array.from({ length: 101 }, (_, i) => ({ id: `n${i}`, x: 1 })) });
    const locked = await api(`/api/pages/${slug}/lock`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ locked: true }),
    });
    expect(locked.status).toBe(200);
    await locked.arrayBuffer();
    a.send({ type: 'preview', notes: [{ id: 'n1', x: 6 }] });
    await b.expectSilent();
    await a.expectSilent();
    a.close();
    b.close();
  });

  it('1 つの接続から中継する数に、1 秒あたりの上限がある', async () => {
    const slug = `preview-${++pageCount}`;
    const a = await join(slug, 'pa');
    const b = await join(slug, 'pb');
    for (let i = 0; i < 50; i++) a.send({ type: 'preview', notes: [{ id: 'n1', x: i }] });
    for (let i = 0; i < 30; i++) expect(await b.next()).toMatchObject({ type: 'preview', notes: [{ x: i }] });
    await b.expectSilent();
    a.close();
    b.close();
  });
});
