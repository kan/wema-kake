// ブラウザ側の同期（src/web/sync.ts）を、実際の Worker と DO に接続して確かめる。
// ボードは wema の代わりに、applyRemote と同じ規則でデルタを適用する簡単なモデルを使う。
import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import type { BoardData, HistoryDelta, WemaEdge, WemaNote } from '../src/shared/delta';
import {
  BoardSync,
  type SyncBoard,
  type SyncHooks,
  type SyncSocket,
  type SyncStatus,
  toSyncSocket,
} from '../src/web/sync';
import { api, createNote, edge, note } from './helpers';

type Obj = Record<string, unknown>;

class FakeBoard implements SyncBoard {
  notes = new Map<string, WemaNote>();
  edges = new Map<string, WemaEdge>();
  private handlers: ((payload: { deltas: HistoryDelta[] }) => void)[] = [];

  on(_event: 'history:commit', handler: (payload: { deltas: HistoryDelta[] }) => void) {
    this.handlers.push(handler);
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

  /** 比較用。autoSize の false と未設定、zIndex（同期しない）の違いは無視する */
  state() {
    const notes = [...this.notes.values()]
      .map(({ zIndex: _z, autoSize, ...rest }) => ({ ...rest, autoSize: autoSize === true }))
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

function newClient(slug: string, connect?: () => Promise<SyncSocket>): Client {
  const board = new FakeBoard();
  const client: Client = {
    board,
    statuses: [],
    titles: [],
    rejects: [],
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
    onAuthExpired: () => void (client.authExpired = true),
  };
  client.sync = new BoardSync(board, connect ?? (() => connectSocket(slug)), hooks);
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
});
