// ページのロック（issue #107）。ロック中は、管理者も含めて誰も編集できない
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { HistoryDelta } from '../src/shared/delta';
import { CHILD_PAGE_KEY } from '../src/shared/hierarchy';
import { REASON_PAGE_LOCKED } from '../src/shared/protocol';
import { TOOLS } from '../src/shared/tools';
import { DAY_MS, TRASH_SLUG } from '../src/shared/trash';
import { createApp } from '../src/worker/index';
import { ServerBoardAccess } from '../src/worker/mcp/board-access';
import { api, createNote, join } from './helpers';

let count = 0;
const unique = (prefix: string) => `${prefix}-${++count}`;
const page = (slug: string) => env.PAGE.getByName(slug);
const AGENT = 'agent:claude';

const apply = (slug: string, deltas: unknown[], actor = 'user:a') =>
  page(slug).applyOps({ actor, clientId: 'c1', opId: unique('op'), deltas });

async function create(deltas: unknown[] = []): Promise<string> {
  const slug = unique('lock');
  expect(await page(slug).createPage(slug)).toEqual({ ok: true });
  if (deltas.length > 0) expect((await apply(slug, deltas)).ok).toBe(true);
  return slug;
}

const json = (method: string, path: string, body?: unknown) =>
  api(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const lock = (slug: string, locked = true) => json('PUT', `/api/pages/${slug}/lock`, { locked });

async function call(name: string, input: unknown): Promise<any> {
  const tool = TOOLS.find((t) => t.name === name)!;
  return tool.run(new ServerBoardAccess(env, { actor: AGENT, delegate: 'user:admin@example.com' }), tool.input.parse(input));
}

describe('PUT /api/pages/:slug/lock', () => {
  it('ロックの設定と解除。スナップショットと meta で届く', async () => {
    const slug = await create([createNote('n1')]);
    const client = await join(slug, 'c1');
    const res = await lock(slug);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, locked: true });
    expect(await client.nextMeta()).toMatchObject({ type: 'meta', locked: true });
    expect((await page(slug).getSnapshot()).locked).toBe(true);

    expect((await lock(slug, false)).status).toBe(200);
    const meta = await client.nextMeta();
    expect(meta).toMatchObject({ type: 'meta', locked: false, expireSince: expect.any(Number) });
    expect((await apply(slug, [createNote('n2')])).ok).toBe(true);
    client.close();
  });

  it('管理者でなければ 403。ページがなければ 404、ゴミ箱と不正な値は 400', async () => {
    const slug = await create();
    const app = createApp({ admins: ['admin@example.com'] });
    const put = (e: object) =>
      app.request(
        `http://localhost/api/pages/${slug}/lock`,
        { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ locked: true }) },
        e,
      );
    const dev = { ...env, ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '' };
    expect((await put({ ...dev, DEV_USER_EMAIL: 'a@example.com' })).status).toBe(403);
    expect((await page(slug).getSnapshot()).locked).toBe(false);
    expect((await put({ ...dev, DEV_USER_EMAIL: 'admin@example.com' })).status).toBe(200);

    expect((await lock(unique('missing'))).status).toBe(404);
    expect((await lock(TRASH_SLUG)).status).toBe(400);
    expect((await json('PUT', `/api/pages/${slug}/lock`, { locked: 'yes' })).status).toBe(400);
  });
});

describe('ロック中のページへの書き込み', () => {
  it('付箋の変更（WebSocket と applyOps）を断る', async () => {
    const slug = await create([createNote('n1')]);
    await lock(slug);
    expect(await apply(slug, [createNote('n2')])).toEqual({ ok: false, reason: REASON_PAGE_LOCKED });

    const client = await join(slug, 'c2');
    client.send({ type: 'ops', opId: 'o1', deltas: [{ type: 'note:update', noteId: 'n1', before: {}, after: { x: 5 } }] });
    expect(await client.next()).toMatchObject({ type: 'reject', opId: 'o1', reason: REASON_PAGE_LOCKED });
    client.close();
    expect((await page(slug).getBoardState())!.notes.map((n) => n.x)).toEqual([10]);
  });

  it('表示名、色、期限の変更と、削除を 423 で断る', async () => {
    const slug = await create([createNote('n1')]);
    await lock(slug);
    expect((await json('PUT', `/api/pages/${slug}/title`, { title: '新しい名前' })).status).toBe(423);
    expect((await json('PUT', `/api/pages/${slug}/color`, { color: '#BBDEFB' })).status).toBe(423);
    expect((await json('PUT', `/api/pages/${slug}/expiry`, { days: 7 })).status).toBe(423);
    const deleted = await json('DELETE', `/api/pages/${slug}`);
    expect(deleted.status).toBe(423);
    expect(await deleted.json()).toEqual({ error: REASON_PAGE_LOCKED });
    const snapshot = await page(slug).getSnapshot();
    expect(snapshot).toMatchObject({ title: slug, color: null, expireDays: null });
    expect(snapshot.data.notes).toHaveLength(1);
  });

  it('操作の取り消しを断る（画面と MCP）', async () => {
    const slug = await create();
    const added = await call('add_notes', { page: slug, notes: [{ text: 'agent' }] });
    await lock(slug);
    const res = await json('POST', `/api/pages/${slug}/ops/${added.operation}/revert`, { clientId: 'c1', opId: 'rv1' });
    expect(res.status).toBe(423);
    await expect(call('revert_operation', { page: slug })).rejects.toThrow(REASON_PAGE_LOCKED);
    expect((await page(slug).getBoardState())!.notes).toHaveLength(1);
  });

  it('付箋の移動は、送り先がロックなら断る。元のページがロックなら、写せるが移せない', async () => {
    const open = await create([createNote('a')]);
    const locked = await create([createNote('b')]);
    await lock(locked);
    const transfer = (from: string, to: string, ids: string[], copy = false) =>
      json('POST', `/api/pages/${from}/transfer`, { clientId: 'c1', opId: unique('op'), to, noteIds: ids, copy });

    expect((await transfer(open, locked, ['a'])).status).toBe(423);
    expect((await transfer(locked, open, ['b'])).status).toBe(423);
    expect((await page(open).getBoardState())!.notes.map((n) => n.id)).toEqual(['a']);
    expect((await page(locked).getBoardState())!.notes.map((n) => n.id)).toEqual(['b']);
    // 写すのは、元のページを変えない
    expect((await transfer(locked, open, ['b'], true)).status).toBe(200);
    expect((await page(open).getBoardState())!.notes).toHaveLength(2);
    await expect(call('move_notes', { page: locked, note_ids: ['b'], to: open })).rejects.toThrow(REASON_PAGE_LOCKED);
  });

  it('ゴミ箱から、ロックしたページへは戻せない', async () => {
    const text = unique('戻す付箋');
    const slug = await create([createNote('a', { text })]);
    const board = (await page(slug).getBoardState())!;
    expect((await apply(slug, [{ type: 'note:delete', note: board.notes[0] } as HistoryDelta])).ok).toBe(true);
    const copy = (await page(TRASH_SLUG).getBoardState())!.notes.find((n) => n.text === text)!;
    await lock(slug);
    const res = await json('POST', '/api/trash/restore', { clientId: 'c1', opId: unique('op'), noteIds: [copy.id] });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ pages: [{ page: slug, noteIds: [], error: expect.stringContaining(REASON_PAGE_LOCKED) }] });
    expect((await page(slug).getBoardState())!.notes).toEqual([]);
  });

  it('MCP: 読み取りは通し、書き込みのツールは理由を返して断る', async () => {
    const slug = await create([createNote('n1')]);
    await lock(slug);
    expect(await call('read_board', { page: slug })).toMatchObject({ locked: true, notes: [{ id: 'n1' }] });
    for (const [name, input] of [
      ['add_notes', { page: slug, notes: [{ text: 'x' }] }],
      ['update_notes', { page: slug, notes: [{ id: 'n1', x: 1 }] }],
      ['delete_notes', { page: slug, note_ids: ['n1'] }],
      ['auto_layout', { page: slug }],
    ] as const) {
      await expect(call(name, input), name).rejects.toThrow(`page locked: ${slug}`);
    }
    // 子ページを置く先と、今の親ページがロックされていても断る
    const name = unique('child');
    await expect(call('create_page', { name, parent: slug })).rejects.toThrow(`page locked: ${slug}`);
    expect(await page(name).getPageRef()).toBeNull();
    const child = await create();
    const parent = await create([createNote('c', { text: '', meta: { [CHILD_PAGE_KEY]: child } })]);
    await lock(parent);
    await expect(call('move_page', { name: child, parent: null })).rejects.toThrow(`page locked: ${parent}`);
    expect((await page(child).getPageRef())!.parent).toBe(parent);
    await expect(call('move_page', { name: (await create()), parent: slug })).rejects.toThrow(`page locked: ${slug}`);
  });

  it('ロックした子ページは、親ページから外せる（子ページのロックは、親ページの操作を止めない）', async () => {
    const child = await create();
    const parent = await create([createNote('c', { text: '', meta: { [CHILD_PAGE_KEY]: child } })]);
    await lock(child);
    expect((await call('move_page', { name: child, parent: null })).to).toBeNull();
    expect((await page(child).getPageRef())!.parent).toBeNull();
    expect((await page(parent).getBoardState())!.notes).toEqual([]);
  });
});

describe('ロックと期限による自動削除', () => {
  const age = (slug: string, days: number) =>
    runInDurableObject(page(slug), (_do, state) => {
      state.storage.sql.exec(`UPDATE notes SET updated_at = ?`, Date.now() - days * DAY_MS);
    });

  it('ロック中は消さない。外した後は、外した時刻から数える', async () => {
    const slug = await create([createNote('old')]);
    expect((await json('PUT', `/api/pages/${slug}/expiry`, { days: 7 })).status).toBe(200);
    await lock(slug);
    await age(slug, 30);
    await runDurableObjectAlarm(page(slug));
    expect((await page(slug).getBoardState())!.notes).toHaveLength(1);
    // ロック中は、期限の alarm を設定しない（索引の反映の分だけ）
    const alarm = await runInDurableObject(page(slug), (_do, state) => state.storage.getAlarm());
    expect(alarm === null || alarm < Date.now() + DAY_MS).toBe(true);

    await lock(slug, false);
    await runDurableObjectAlarm(page(slug));
    expect((await page(slug).getBoardState())!.notes).toHaveLength(1);
    const next = await runInDurableObject(page(slug), (_do, state) => state.storage.getAlarm());
    expect(Math.abs(next! - (Date.now() + 7 * DAY_MS))).toBeLessThan(60_000);
  });
});
