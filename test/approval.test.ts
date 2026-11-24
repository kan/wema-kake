// 利用者の承認（設定の `approval`。issue #120）。初めて来た人は承認待ちになり、管理者が承認するまで、
// ページの中身、画像、WebSocket に届かない
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ERROR_NOT_APPROVED, type Session, type UserEntry } from '../src/shared/api';
import { CLOSE_NOT_APPROVED } from '../src/shared/protocol';
import { APPROVAL_META_NAME } from '../src/shared/site';
import { createApp } from '../src/worker/index';
import type { PageDO } from '../src/worker/page-do';
import { type Client, createNote, join } from './helpers';

const ADMIN = 'admin@example.com';
const app = createApp({ admins: [ADMIN], approval: true });

let count = 0;
const unique = (prefix: string) => `${prefix}-${++count}`;
/** テストごとに別の人にする（D1 の行が、テストの間で残ることがあるため） */
const newcomer = () => `${unique('user')}@example.com`;

const dev = (email: string) => ({ ...env, ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '', DEV_USER_EMAIL: email });

const call = (email: string, path: string, init: RequestInit = {}, target = app) =>
  target.request(`http://localhost${path}`, init, dev(email));
const json = (email: string, method: string, path: string, body?: unknown) =>
  call(email, path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const session = async (email: string, target = app) => (await (await call(email, '/api/session', {}, target)).json()) as Session;
const decide = (email: string, status: string, by = ADMIN) => json(by, 'PUT', `/api/users/${encodeURIComponent(email)}/status`, { status });
const users = async () => ((await (await call(ADMIN, '/api/users')).json()) as { users: UserEntry[] }).users;
/** index.html に入った承認の状態。入っていなければ null */
async function approvalMeta(email: string): Promise<string | null> {
  const text = await (await call(email, '/', { headers: { Accept: 'text/html' } })).text();
  return new RegExp(`<meta name="${APPROVAL_META_NAME}" content="([a-z]+)">`).exec(text)?.[1] ?? null;
}

describe('承認の関所', () => {
  it('初めて来た人は承認待ちになり、ページの中身、画像、WebSocket に届かない', async () => {
    const email = newcomer();
    expect(await session(email)).toEqual({ actor: `user:${email}`, admin: false, approval: 'pending' });

    for (const path of ['/api/index', '/api/pages', '/img/x.png', `/ws/${unique('p')}`]) {
      const res = await call(email, path, { headers: path.startsWith('/ws/') ? { Upgrade: 'websocket' } : {} });
      expect(res.status, path).toBe(403);
      expect(await res.json(), path).toEqual({ error: ERROR_NOT_APPROVED, approval: 'pending' });
    }
    expect(await approvalMeta(email)).toBe('pending');
  });

  it('管理者は、表にかかわらず承認済み。承認待ちの人数を知る', async () => {
    const email = newcomer();
    await session(email);
    const admin = await session(ADMIN);
    expect(admin).toMatchObject({ actor: `user:${ADMIN}`, admin: true, approval: 'approved' });
    expect(admin.pendingUsers).toBeGreaterThanOrEqual(1);
    expect((await call(ADMIN, '/api/index')).status).toBe(200);
    expect(await approvalMeta(ADMIN)).toBeNull();
    // 管理者は表に入れない（一覧には、設定から足して出す）
    expect(await env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(ADMIN).first()).toBeNull();
  });

  it('承認すると使えるようになり、拒否すると使えなくなる', async () => {
    const email = newcomer();
    await session(email);
    const res = await decide(email, 'approved');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect((await session(email)).approval).toBe('approved');
    expect((await call(email, '/api/index')).status).toBe(200);
    expect(await approvalMeta(email)).toBeNull();
    expect((await users()).find((u) => u.email === email)).toMatchObject({
      status: 'approved',
      decided_by: `user:${ADMIN}`,
      decided_at: expect.any(Number),
    });

    expect((await decide(email, 'rejected')).status).toBe(200);
    const denied = await call(email, '/api/index');
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: ERROR_NOT_APPROVED, approval: 'rejected' });
    expect(await approvalMeta(email)).toBe('rejected');
  });

  it('ほかの isolate で拒否されると、API はしばらく通るが、画面の読み込みと接続は通らない', async () => {
    const email = newcomer();
    await session(email);
    await decide(email, 'approved');
    expect((await call(email, '/api/index')).status).toBe(200);
    // ほかの isolate の decideUser（この isolate で覚えている結果は捨てない）
    await env.DB.prepare(`UPDATE users SET status = 'rejected' WHERE email = ?`).bind(email).run();

    expect((await call(email, '/api/index')).status).toBe(200);
    expect(await approvalMeta(email)).toBe('rejected');
    expect((await call(email, `/ws/${unique('p')}`, { headers: { Upgrade: 'websocket' } })).status).toBe(403);
    expect((await session(email)).approval).toBe('rejected');
  });

  it('email の大文字と小文字は区別しない', async () => {
    const email = newcomer();
    await session(email.toUpperCase());
    expect((await users()).find((u) => u.email === email)?.status).toBe('pending');
    expect((await decide(email.toUpperCase(), 'approved')).status).toBe(200);
    expect((await session(email)).approval).toBe('approved');
  });

  it('承認が無効なら、表を使わず、利用者の API は 404', async () => {
    const open = createApp({ admins: [ADMIN] });
    const email = newcomer();
    expect(await session(email, open)).toEqual({ actor: `user:${email}`, admin: false });
    expect((await call(email, '/api/index', {}, open)).status).toBe(200);
    expect((await call(ADMIN, '/api/users', {}, open)).status).toBe(404);
    expect(await env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first()).toBeNull();
  });
});

describe('/api/users', () => {
  it('管理者でなければ 403（承認済みの人でも）', async () => {
    const email = newcomer();
    await session(email);
    await decide(email, 'approved');
    expect((await call(email, '/api/users')).status).toBe(403);
    expect((await decide(newcomer(), 'approved', email)).status).toBe(403);
  });

  it('管理者も、承認待ちの後に出す（承認も拒否もできない）', async () => {
    await session(newcomer());
    const list = await users();
    const admin = list.findIndex((u) => u.email === ADMIN);
    expect(list[admin]).toEqual({ email: ADMIN, status: 'approved', admin: true, created_at: null, decided_by: null, decided_at: null });
    expect(list.filter((u) => u.email === ADMIN)).toHaveLength(1);
    expect(list.slice(0, admin).every((u) => u.status === 'pending')).toBe(true);
    expect(list.slice(admin + 1).every((u) => u.status !== 'pending')).toBe(true);
    expect((await decide(ADMIN.toUpperCase(), 'rejected')).status).toBe(400);
  });

  it('承認待ちを先に並べる', async () => {
    const waiting = newcomer();
    const approved = newcomer();
    await session(approved);
    await decide(approved, 'approved');
    await session(waiting);
    const list = await users();
    const firstDecided = list.findIndex((u) => u.status !== 'pending');
    expect(list.slice(firstDecided).every((u) => u.status !== 'pending')).toBe(true);
    expect(list.findIndex((u) => u.email === waiting)).toBeLessThan(firstDecided);
  });

  it('まだ来ていない人は 404、不正な状態は 400', async () => {
    expect((await decide(newcomer(), 'approved')).status).toBe(404);
    const email = newcomer();
    await session(email);
    for (const status of ['pending', 'yes', undefined]) expect((await decide(email, status as never)).status).toBe(400);
  });
});

describe('WebSocket', () => {
  /** `email` の人として接続して hello を送り、スナップショットを受け取る */
  const connect = (email: string, slug: string) =>
    join(slug, unique('c'), async (path, init) => call(email, path, init));
  const write = (client: Client) => client.send({ type: 'ops', opId: unique('op'), deltas: [createNote('n1')] });

  /** DO が覚えている「承認済みと確かめた結果」を消す（取り消しを、待たずに反映させる） */
  const forget = (slug: string) =>
    runInDurableObject(env.PAGE.getByName(slug), (instance: PageDO) => {
      (instance as unknown as { approvedAt: Map<string, number> }).approvedAt.clear();
    });

  it('承認を取り消された人の接続は、次の書き込みで閉じる', async () => {
    const email = newcomer();
    await session(email);
    await decide(email, 'approved');
    const slug = unique('ws');
    const client = await connect(email, slug);

    await decide(email, 'rejected');
    await forget(slug);
    write(client);
    expect((await client.closed).code).toBe(CLOSE_NOT_APPROVED);
    expect((await env.PAGE.getByName(slug).getSnapshot()).data.notes).toEqual([]);
  });

  it('見ているだけの人の接続は、ほかの人の変更を配信するときに閉じる', async () => {
    const viewer = newcomer();
    await session(viewer);
    await decide(viewer, 'approved');
    const slug = unique('ws');
    const watching = await connect(viewer, slug);
    const writer = await connect(ADMIN, slug);

    await decide(viewer, 'rejected');
    await forget(slug);
    write(writer);
    expect((await writer.next()).type).toBe('ops');
    expect((await watching.closed).code).toBe(CLOSE_NOT_APPROVED);
    writer.close();
  });

  it('管理者の接続は確かめない', async () => {
    const slug = unique('ws');
    const client = await connect(ADMIN, slug);
    await forget(slug);
    write(client);
    expect((await client.next()).type).toBe('ops');
    client.close();
  });
});
