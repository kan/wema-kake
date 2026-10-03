import { env, evictDurableObject, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { ServerMsg } from '../src/shared/protocol';
import { createNote, note } from './helpers';

let pageCount = 0;
const newSlug = () => `ws-${++pageCount}`;

interface Client {
  send(msg: unknown): void;
  /** 次に届くメッセージ。届かなければ失敗する */
  next(): Promise<ServerMsg>;
  /** しばらく待って、何も届いていないことを確かめる */
  expectSilent(): Promise<void>;
  closed: Promise<{ code: number; reason: string }>;
}

async function open(slug: string, headers: Record<string, string> = {}): Promise<Client> {
  const res = await SELF.fetch(`http://localhost/ws/${slug}`, {
    headers: { Upgrade: 'websocket', ...headers },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();

  const queue: ServerMsg[] = [];
  let wake: (() => void) | undefined;
  ws.addEventListener('message', (e) => {
    queue.push(JSON.parse(e.data as string));
    wake?.();
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.addEventListener('close', (e) => resolve({ code: e.code, reason: e.reason }));
  });
  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  return {
    closed,
    send: (msg) => ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)),
    async next() {
      if (queue.length === 0) await wait(2000);
      const msg = queue.shift();
      if (!msg) throw new Error('no message');
      return msg;
    },
    async expectSilent() {
      if (queue.length === 0) await wait(100);
      expect(queue).toEqual([]);
    },
  };
}

/** 接続して hello を送り、スナップショットを受け取る */
async function join(slug: string, clientId: string) {
  const c = await open(slug);
  c.send({ type: 'hello', clientId });
  const snapshot = await c.next();
  expect(snapshot.type).toBe('snapshot');
  return c;
}

describe('WebSocket', () => {
  it('hello にスナップショットを返す', async () => {
    const c = await open(newSlug());
    c.send({ type: 'hello', clientId: 'c1' });
    expect(await c.next()).toEqual({
      type: 'snapshot',
      seq: 0,
      title: null,
      data: { version: 1, notes: [], edges: [] },
    });
  });

  it('確定した変更を送信元も含めた全員に配信し、主体は認証結果から決める', async () => {
    const slug = newSlug();
    const a = await join(slug, 'ca');
    const b = await join(slug, 'cb');

    a.send({ type: 'ops', opId: 'o1', deltas: [createNote('n1')] });
    const expected = {
      type: 'ops',
      seq: 1,
      actor: 'user:dev@example.com',
      clientId: 'ca',
      opId: 'o1',
      deltas: [createNote('n1')],
    };
    expect(await a.next()).toEqual(expected);
    expect(await b.next()).toEqual(expected);
  });

  it('fixups は送信元にだけ付ける', async () => {
    const slug = newSlug();
    const a = await join(slug, 'ca');
    const b = await join(slug, 'cb');

    a.send({ type: 'ops', opId: 'o1', deltas: [createNote('n1', { text: '<b onclick="x()">a</b>' })] });
    const fixups = [{ type: 'note:update', noteId: 'n1', before: {}, after: { text: '<b>a</b>' } }];
    expect(await a.next()).toMatchObject({ type: 'ops', seq: 1, fixups });
    const toB = await b.next();
    expect(toB).toMatchObject({ type: 'ops', seq: 1, deltas: [{ note: { text: '<b>a</b>' } }] });
    expect(toB).not.toHaveProperty('fixups');
  });

  it('拒否は送信元にだけ返す', async () => {
    const slug = newSlug();
    const a = await join(slug, 'ca');
    const b = await join(slug, 'cb');
    a.send({ type: 'ops', opId: 'o1', deltas: [createNote('n1', { text: 'v1' })] });
    await a.next();
    await b.next();

    b.send({
      type: 'ops',
      opId: 'o2',
      deltas: [{ type: 'note:update', noteId: 'n1', before: { text: 'old' }, after: { text: 'v2' } }],
    });
    expect(await b.next()).toEqual({
      type: 'reject',
      opId: 'o2',
      reason: 'text conflict',
      current: { notes: [note('n1', { text: 'v1' })], edges: [] },
    });
    await a.expectSilent();
  });

  it('再送とすべて捨てた操作は、送信元にだけ確定を返す', async () => {
    const slug = newSlug();
    const a = await join(slug, 'ca');
    const b = await join(slug, 'cb');
    a.send({ type: 'ops', opId: 'o1', deltas: [createNote('n1')] });
    await a.next();
    await b.next();

    a.send({ type: 'ops', opId: 'o1', deltas: [createNote('n1')] });
    expect(await a.next()).toMatchObject({ type: 'ops', seq: 1, opId: 'o1', deltas: [createNote('n1')] });

    a.send({ type: 'ops', opId: 'o2', deltas: [{ type: 'note:delete', note: note('gone') }] });
    expect(await a.next()).toMatchObject({ type: 'ops', seq: 1, opId: 'o2', deltas: [] });
    await b.expectSilent();
  });

  it('再接続時、lastSeq 以降の変更を差分で返す。自分の操作には fixups を付ける', async () => {
    const slug = newSlug();
    const a = await join(slug, 'ca');
    a.send({ type: 'ops', opId: 'o1', deltas: [createNote('n1')] });
    await a.next();
    a.send({ type: 'ops', opId: 'o2', deltas: [createNote('n2', { text: '<b onclick="x()">a</b>' })] });
    await a.next();
    const stub = env.PAGE.getByName(slug);
    await stub.applyOps({ actor: 'agent:claude', clientId: 'mcp', opId: 'o3', deltas: [createNote('n3')], summary: 'add_notes' });
    await a.next();

    const again = await open(slug);
    again.send({ type: 'hello', clientId: 'ca', lastSeq: 1 });
    // 表示名は差分に出ないので、現在値が先に届く
    expect(await again.next()).toEqual({ type: 'meta', title: null });
    const second = await again.next();
    expect(second).toMatchObject({ type: 'ops', seq: 2, clientId: 'ca', opId: 'o2' });
    expect(second).toHaveProperty('fixups');
    expect(await again.next()).toEqual({
      type: 'ops',
      seq: 3,
      actor: 'agent:claude',
      clientId: 'mcp',
      opId: 'o3',
      summary: 'add_notes',
      deltas: [createNote('n3')],
    });

    // 最新まで受け取っていれば、表示名の現在値だけを返す（切断中に変わっていても追従できる）
    await stub.setTitle('変更後の表示名');
    const upToDate = await open(slug);
    upToDate.send({ type: 'hello', clientId: 'cc', lastSeq: 3 });
    expect(await upToDate.next()).toEqual({ type: 'meta', title: '変更後の表示名' });
    await upToDate.expectSilent();
  });

  it('書き込みのないページに lastSeq 付きで接続しても、空のスナップショットを返す', async () => {
    const c = await open(newSlug());
    c.send({ type: 'hello', clientId: 'c1', lastSeq: 0 });
    expect(await c.next()).toMatchObject({ type: 'snapshot', seq: 0 });
  });

  it('lastSeq がサーバーより進んでいる、または差分が残っていなければスナップショットを返す', async () => {
    const slug = newSlug();
    const a = await join(slug, 'ca');
    a.send({ type: 'ops', opId: 'o1', deltas: [createNote('n1')] });
    await a.next();
    a.send({ type: 'ops', opId: 'o2', deltas: [createNote('n2')] });
    await a.next();

    const ahead = await open(slug);
    ahead.send({ type: 'hello', clientId: 'cx', lastSeq: 99 });
    expect(await ahead.next()).toMatchObject({ type: 'snapshot', seq: 2 });

    await runInDurableObject(env.PAGE.getByName(slug), (_do, state) => {
      state.storage.sql.exec(`DELETE FROM ops WHERE seq = 1`);
    });
    const pruned = await open(slug);
    pruned.send({ type: 'hello', clientId: 'cy', lastSeq: 0 });
    expect(await pruned.next()).toMatchObject({ type: 'snapshot', seq: 2 });
  });

  it('差分の合計が大きいときは、件数が少なくてもスナップショットを返す', async () => {
    const slug = newSlug();
    const stub = env.PAGE.getByName(slug);
    const text = 'a'.repeat(450_000);
    for (let i = 1; i <= 10; i++) {
      const deltas = [createNote(`n${i}`, { text })];
      expect(await stub.applyOps({ actor: 'user:a', clientId: 'c0', opId: `o${i}`, deltas })).toMatchObject({ ok: true });
    }
    const c = await open(slug);
    c.send({ type: 'hello', clientId: 'c1', lastSeq: 0 });
    expect(await c.next()).toMatchObject({ type: 'snapshot', seq: 10 });
  });

  it('MCP など WebSocket 以外からの変更も、接続中のブラウザへ配信する', async () => {
    const slug = newSlug();
    const a = await join(slug, 'ca');
    await env.PAGE.getByName(slug).applyOps({
      actor: 'agent:claude', clientId: 'mcp', opId: 'o1', deltas: [createNote('n1')],
    });
    expect(await a.next()).toMatchObject({ type: 'ops', seq: 1, actor: 'agent:claude' });
  });

  it('Hibernation から復帰しても、接続と hello の状態を保って配信を続ける', async () => {
    const slug = newSlug();
    const a = await join(slug, 'ca');
    const b = await join(slug, 'cb');
    await evictDurableObject(env.PAGE.getByName(slug), { webSockets: 'hibernate' });

    a.send({ type: 'ops', opId: 'o1', deltas: [createNote('n1')] });
    expect(await a.next()).toMatchObject({ type: 'ops', seq: 1, clientId: 'ca' });
    expect(await b.next()).toMatchObject({ type: 'ops', seq: 1, clientId: 'ca' });
  });

  it('同じ clientId を名乗っても、主体が違えば送信元として扱わない', async () => {
    const slug = newSlug();
    const a = await join(slug, 'shared');
    const stub = env.PAGE.getByName(slug);
    const dirty = [createNote('n1', { text: '<b onclick="x()">a</b>' })];

    // 別の主体が、a と同じ clientId と opId で先に操作を記録する
    await stub.applyOps({ actor: 'user:other@example.com', clientId: 'shared', opId: 'o1', deltas: dirty });
    const fromOther = await a.next();
    expect(fromOther).toMatchObject({ type: 'ops', seq: 1, actor: 'user:other@example.com' });
    expect(fromOther).not.toHaveProperty('fixups');

    // a の同じ opId の操作は再送として扱われず、新しい操作として適用される
    a.send({ type: 'ops', opId: 'o1', deltas: [createNote('n2')] });
    expect(await a.next()).toMatchObject({
      type: 'ops', seq: 2, actor: 'user:dev@example.com', deltas: [createNote('n2')],
    });
  });

  it('認証の期限を過ぎた接続は、受信も配信もせずに閉じる', async () => {
    const slug = newSlug();
    const stub = env.PAGE.getByName(slug);
    const connect = async (expiresAt: number) => {
      const res = await stub.fetch('http://do/ws', {
        headers: { Upgrade: 'websocket', 'X-Wema-Actor': 'user:a@example.com', 'X-Wema-Auth-Expires': String(expiresAt) },
      });
      const ws = res.webSocket!;
      ws.accept();
      const closed = new Promise<number>((resolve) => ws.addEventListener('close', (e) => resolve(e.code)));
      return { ws, closed };
    };
    const now = Math.floor(Date.now() / 1000);

    // 期限内に hello を済ませ、その後に期限が切れた接続（期限を過去に書き換えて再現する）
    const stale = await connect(now + 3600);
    stale.ws.send(JSON.stringify({ type: 'hello', clientId: 'c1' }));
    const live = await join(slug, 'c2');
    await runInDurableObject(stub, (_do, state) => {
      for (const ws of state.getWebSockets()) {
        const attachment = ws.deserializeAttachment();
        if (attachment.clientId === 'c1') ws.serializeAttachment({ ...attachment, expiresAt: now - 1 });
      }
    });
    live.send({ type: 'ops', opId: 'o1', deltas: [createNote('n1')] });
    await live.next();
    expect(await stale.closed).toBe(4401);

    // 期限切れの状態で届いたメッセージ
    const expired = await connect(now - 1);
    expired.ws.send(JSON.stringify({ type: 'hello', clientId: 'c3' }));
    expect(await expired.closed).toBe(4401);
  });

  it('hello を済ませていない接続には配信せず、ops も受け付けない', async () => {
    const slug = newSlug();
    const a = await join(slug, 'ca');
    const silent = await open(slug);
    a.send({ type: 'ops', opId: 'o1', deltas: [createNote('n1')] });
    await a.next();
    await silent.expectSilent();

    silent.send({ type: 'ops', opId: 'o2', deltas: [createNote('n2')] });
    expect(await silent.closed).toMatchObject({ code: 1008 });
  });

  it('JSON でないメッセージと不正な clientId は接続を閉じる', async () => {
    const a = await open(newSlug());
    a.send('not json');
    expect(await a.closed).toMatchObject({ code: 1007 });

    const b = await open(newSlug());
    b.send({ type: 'hello', clientId: 'a b' });
    expect(await b.closed).toMatchObject({ code: 1008 });
  });

  it('クライアントが付けた主体のヘッダーは使わない', async () => {
    const slug = newSlug();
    const c = await open(slug, { 'X-Wema-Actor': 'user:evil@example.com' });
    c.send({ type: 'hello', clientId: 'c1' });
    await c.next();
    c.send({ type: 'ops', opId: 'o1', deltas: [createNote('n1')] });
    expect(await c.next()).toMatchObject({ actor: 'user:dev@example.com' });
  });

  it('他のオリジンからの接続、WebSocket でない要求、不正なスラッグを断る', async () => {
    const upgrade = { Upgrade: 'websocket' };
    const cross = await SELF.fetch('http://localhost/ws/memo', {
      headers: { ...upgrade, Origin: 'https://evil.example.com' },
    });
    expect(cross.status).toBe(403);
    const same = await SELF.fetch('http://localhost/ws/memo', {
      headers: { ...upgrade, Origin: 'http://localhost' },
    });
    expect(same.status).toBe(101);
    same.webSocket!.accept();
    same.webSocket!.close();

    expect((await SELF.fetch('http://localhost/ws/memo')).status).toBe(426);
    expect((await SELF.fetch('http://localhost/ws/Bad_Slug', { headers: upgrade })).status).toBe(400);
  });
});
