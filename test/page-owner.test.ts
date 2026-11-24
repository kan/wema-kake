// ページを作った人と、ページの削除（issue #130）。消せるのは、作った人と管理者だけ
import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { IndexPage } from '../src/shared/api';
import { REASON_NOT_PAGE_OWNER } from '../src/shared/protocol';
import { TRASH_SLUG } from '../src/shared/trash';
import { createApp } from '../src/worker/index';
import { ServerBoardAccess } from '../src/worker/mcp/board-access';
import { createNote } from './helpers';

const ADMIN = 'admin@example.com';
const app = createApp({ admins: [ADMIN] });

let count = 0;
const unique = (prefix: string) => `${prefix}-${++count}`;
const person = () => `${unique('p')}@example.com`;

const dev = (email: string) => ({ ...env, ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '', DEV_USER_EMAIL: email });
const call = (email: string, path: string, init: RequestInit = {}) =>
  app.request(`http://localhost${path}`, init, dev(email));
const createPage = (email: string, slug: string) =>
  call(email, `/api/pages/${slug}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'x' }),
  });
const deletePage = (email: string, slug: string) => call(email, `/api/pages/${slug}`, { method: 'DELETE' });
const ownerOf = async (slug: string) => (await env.PAGE.getByName(slug).getSnapshot()).owner;
/** system が作るページ（最初のページ） */
const createSystemPage = (slug: string) =>
  env.PAGE.getByName(slug).createWithContent('最初のページ', [{ type: 'note:create', note: createNote('n1').note }]);

describe('ページの削除', () => {
  it('作った人と管理者は消せる。ほかの人は 403', async () => {
    const owner = person();
    const slug = unique('owned');
    expect((await createPage(owner, slug)).status).toBe(201);
    expect(await ownerOf(slug)).toBe(`user:${owner}`);

    const other = await deletePage(person(), slug);
    expect(other.status).toBe(403);
    expect(await other.json()).toEqual({ error: REASON_NOT_PAGE_OWNER });
    // email の大文字と小文字は区別しない
    expect((await deletePage(owner.toUpperCase(), slug)).status).toBe(200);

    const another = unique('owned');
    await createPage(owner, another);
    expect((await deletePage(ADMIN, another)).status).toBe(200);
  });

  it('付箋を書き込んでできたページは、書き込んだ人が作った人。agent なら委任した人', async () => {
    const slug = unique('written');
    await env.PAGE.getByName(slug).applyOps({ actor: 'user:writer@example.com', clientId: 'c', opId: 'o1', deltas: [createNote('n1')] });
    expect(await ownerOf(slug)).toBe('user:writer@example.com');
    // 後から書き込んだ人は、作った人にならない
    await env.PAGE.getByName(slug).applyOps({ actor: 'user:later@example.com', clientId: 'c', opId: 'o2', deltas: [createNote('n2')] });
    expect(await ownerOf(slug)).toBe('user:writer@example.com');

    const byAgent = unique('agent');
    await env.PAGE.getByName(byAgent).applyOps({
      actor: 'agent:claude.ai', delegate: 'user:boss@example.com', clientId: 'mcp', opId: 'o1', deltas: [createNote('n1')],
    });
    expect(await ownerOf(byAgent)).toBe('user:boss@example.com');

    const viaMcp = unique('mcp');
    await new ServerBoardAccess(env, { actor: 'agent:claude.ai', delegate: 'user:mcp@example.com' }).createPage(viaMcp, 'x');
    expect(await ownerOf(viaMcp)).toBe('user:mcp@example.com');
  });

  it('作った人のいないページ（system、ゴミ箱）は、管理者だけが消せる', async () => {
    const slug = unique('system');
    expect(await createSystemPage(slug)).toBe(true);
    expect(await ownerOf(slug)).toBeNull();
    expect((await deletePage(person(), slug)).status).toBe(403);
    expect((await deletePage(ADMIN, slug)).status).toBe(200);

    const writer = person();
    await env.PAGE.getByName(TRASH_SLUG).applyOps({ actor: `user:${writer}`, clientId: 'c', opId: unique('o'), deltas: [createNote(unique('t'))] });
    expect(await ownerOf(TRASH_SLUG)).toBeNull();
    expect((await deletePage(writer, TRASH_SLUG)).status).toBe(403);
  });

  it('作った人を記録する前のページは、履歴の最初の操作の主体を作った人とみなす', async () => {
    const legacy = async (actor: string, delegate?: string) => {
      const slug = unique('legacy');
      const stub = env.PAGE.getByName(slug);
      await stub.applyOps({ actor, delegate, clientId: 'c', opId: 'o1', deltas: [createNote('n1')] });
      // 作った人の記録が無い、ひとつ前のスキーマに戻して、DO を起こし直す（移行は、DO を起こしたときに走る）
      await runInDurableObject(stub, (_do, state) => {
        state.storage.sql.exec(`DELETE FROM meta WHERE key = 'created_by'`);
        state.storage.sql.exec(`UPDATE meta SET value = CAST(value - 1 AS TEXT) WHERE key = 'version'`);
      });
      await evictDurableObject(stub);
      return slug;
    };
    const old = await legacy('user:old@example.com');
    expect(await ownerOf(old)).toBe('user:old@example.com');
    // 編集されなくても、一覧の索引に写る（移行のときに、索引への反映を予約する）
    await env.DB.prepare(`UPDATE pages SET created_by = NULL WHERE name = ?`).bind(old).run();
    expect(await runDurableObjectAlarm(env.PAGE.getByName(old))).toBe(true);
    expect(await env.DB.prepare(`SELECT created_by FROM pages WHERE name = ?`).bind(old).first('created_by'))
      .toBe('user:old@example.com');
    expect(await ownerOf(await legacy('agent:claude.ai', 'user:delegator@example.com'))).toBe('user:delegator@example.com');
    expect(await ownerOf(await legacy('agent:claude.ai'))).toBeNull();
    expect(await ownerOf(await legacy('system'))).toBeNull();

    // 最初の操作が履歴から消えていれば、分からない
    const pruned = unique('legacy');
    const stub = env.PAGE.getByName(pruned);
    await stub.applyOps({ actor: 'user:first@example.com', clientId: 'c', opId: 'o1', deltas: [createNote('n1')] });
    await stub.applyOps({ actor: 'user:second@example.com', clientId: 'c', opId: 'o2', deltas: [createNote('n2')] });
    await runInDurableObject(stub, (_do, state) => {
      state.storage.sql.exec(`DELETE FROM meta WHERE key = 'created_by'`);
      state.storage.sql.exec(`DELETE FROM ops WHERE seq = 1`);
      state.storage.sql.exec(`UPDATE meta SET value = CAST(value - 1 AS TEXT) WHERE key = 'version'`);
    });
    await evictDurableObject(stub);
    expect(await ownerOf(pruned)).toBeNull();
  });
});

it('一覧（GET /api/index）に、作った人を出す。記録が無ければ空文字', async () => {
  const owner = person();
  const slug = unique('listed');
  await createPage(owner, slug);
  await runDurableObjectAlarm(env.PAGE.getByName(slug));
  const system = unique('listed-system');
  await createSystemPage(system);

  const { pages } = (await (await call(owner, '/api/index')).json()) as { pages: IndexPage[] };
  expect(pages.find((p) => p.name === slug)?.created_by).toBe(`user:${owner}`);
  expect(pages.find((p) => p.name === system)?.created_by).toBe('');
});
