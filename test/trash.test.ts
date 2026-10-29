// ゴミ箱と、古い付箋を自動で消す設定（issue #27、src/shared/trash.ts）。
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { HistoryDelta } from '../src/shared/delta';
import { CHILD_PAGE_KEY, parseChildRejection } from '../src/shared/hierarchy';
import { DAY_MS, TRASH_SLUG } from '../src/shared/trash';
import { api, createNote, edge } from './helpers';

let count = 0;
const unique = (prefix: string) => `${prefix}-${++count}`;
const page = (slug: string) => env.PAGE.getByName(slug);
const trash = () => page(TRASH_SLUG);
const AGENT = 'agent:claude';

const apply = (slug: string, deltas: unknown[], actor = 'user:a') =>
  page(slug).applyOps({ actor, clientId: 'c1', opId: unique('op'), deltas });

/** ページを作り、`deltas` を `actor` の操作として置く */
async function create(deltas: unknown[] = [], actor = 'user:a'): Promise<string> {
  const slug = unique('trash-test');
  expect(await page(slug).createPage(slug)).toEqual({ ok: true });
  if (deltas.length > 0) expect((await apply(slug, deltas, actor)).ok).toBe(true);
  return slug;
}

/** ページの付箋を消す（ブラウザの削除と同じく、付箋の内容を付けて送る） */
async function remove(slug: string, ids: string[], actor = 'user:a') {
  const board = (await page(slug).getBoardState())!;
  const deltas: HistoryDelta[] = ids.map((id) => ({ type: 'note:delete', note: board.notes.find((n) => n.id === id)! }));
  const res = await apply(slug, deltas, actor);
  expect(res.ok).toBe(true);
  return res;
}

/** ゴミ箱にある、`text` の付箋 */
async function inTrash(text: string) {
  const board = await trash().getBoardState();
  return (board?.notes ?? []).filter((note) => note.text === text);
}

const restore = (noteIds: string[], opId = unique('op')) =>
  api('/api/trash/restore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: 'c1', opId, noteIds }),
  });

/** 付箋の最後の更新を、`days` 日前にする */
const age = (slug: string, days: number) =>
  runInDurableObject(page(slug), (_do, state) => {
    state.storage.sql.exec(`UPDATE notes SET updated_at = ?`, Date.now() - days * DAY_MS);
  });

describe('ゴミ箱', () => {
  it('消した付箋は、作成者を引き継いでゴミ箱へ移る。消した付箋どうしの接続線も移る', async () => {
    const text = unique('消す付箋');
    const slug = await create([
      createNote('a', { text, x: 500, y: 600 }),
      createNote('b', { text: `${text}-b` }),
      createNote('c', { text: `${text}-c` }),
      { type: 'edge:create', edge: edge('ab', 'a', 'b') },
      { type: 'edge:create', edge: edge('ac', 'a', 'c') },
    ], AGENT);

    await remove(slug, ['a', 'b'], 'user:deleter');

    const [a] = await inTrash(text);
    const [b] = await inTrash(`${text}-b`);
    expect(a).toMatchObject({ createdBy: AGENT });
    expect(b).toMatchObject({ createdBy: AGENT });
    // 新しい id で置く
    expect(a.id).not.toBe('a');
    const edges = (await trash().getBoardState())!.edges.filter((e) => e.from === a.id || e.to === a.id);
    // 残った付箋 c との接続線は移らない
    expect(edges).toEqual([expect.objectContaining({ from: a.id, to: b.id })]);
    // 元のページと、元の id と位置を覚えている
    expect(await trash().trashOrigins([a.id])).toEqual([{ noteId: a.id, page: slug, originalId: 'a', x: 500, y: 600 }]);
    // 操作の履歴には、消した人の操作として、元のページの分かる符号で残る
    const [op] = await trash().listOps({ limit: 1, actor: 'user:deleter' });
    expect(op).toMatchObject({ summary: `system:trashed:${slug}` });
  });

  it('子ページの付箋は、ゴミ箱へ移らない', async () => {
    const child = await create();
    const slug = await create([createNote('to-child', { text: '', meta: { [CHILD_PAGE_KEY]: child } })]);
    const before = (await trash().getBoardState())?.notes.length ?? 0;
    await remove(slug, ['to-child']);
    expect((await trash().getBoardState())?.notes.length ?? 0).toBe(before);
  });

  it('他のページへ移した付箋は、ゴミ箱へ移らない', async () => {
    const text = unique('移す付箋');
    const from = await create([createNote('m', { text })]);
    const to = await create([createNote('x')]);
    const res = await api(`/api/pages/${from}/transfer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'c1', opId: unique('op'), to, noteIds: ['m'] }),
    });
    expect(res.status).toBe(200);
    expect(await inTrash(text)).toEqual([]);
  });

  it('ゴミ箱で消した付箋は、すぐに消える', async () => {
    const text = unique('二度消す');
    const slug = await create([createNote('a', { text })]);
    await remove(slug, ['a']);
    const [copy] = await inTrash(text);
    const before = (await trash().getBoardState())!.notes.length;
    await remove(TRASH_SLUG, [copy.id]);
    expect(await inTrash(text)).toEqual([]);
    expect((await trash().getBoardState())!.notes.length).toBe(before - 1);
  });

  it('Undo で付箋が戻ったら、ゴミ箱の写しを消す', async () => {
    const text = unique('Undo する付箋');
    const slug = await create([createNote('a', { text })]);
    await remove(slug, ['a']);
    expect(await inTrash(text)).toHaveLength(1);
    // ブラウザの Undo は、同じ id の付箋を作り直す
    expect((await apply(slug, [createNote('a', { text })])).ok).toBe(true);
    expect(await inTrash(text)).toEqual([]);
  });

  it('削除の操作を取り消したら、ゴミ箱の写しを消す', async () => {
    const text = unique('取り消す付箋');
    const slug = await create([createNote('a', { text })]);
    const removed = await remove(slug, ['a']);
    expect(await inTrash(text)).toHaveLength(1);
    const reverted = await page(slug).revert({
      seq: (removed as { seq: number }).seq, actor: 'user:a', clientId: 'c1', opId: unique('op'),
    });
    expect(reverted).toMatchObject({ ok: true, applied: 1 });
    expect(await inTrash(text)).toEqual([]);
  });

  it('元のページへ、元の id と位置で戻す。作成者は引き継ぐ', async () => {
    const text = unique('戻す付箋');
    const slug = await create([createNote('a', { text, x: 300, y: 400 }), createNote('keep')], AGENT);
    await remove(slug, ['a']);
    const [copy] = await inTrash(text);

    const res = await restore([copy.id]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, pages: [{ page: slug, noteIds: ['a'] }] });

    const board = (await page(slug).getBoardState())!;
    expect(board.notes.find((n) => n.id === 'a')).toMatchObject({ text, x: 300, y: 400, createdBy: AGENT });
    expect(await inTrash(text)).toEqual([]);
    // 戻した付箋をもう一度消すと、またゴミ箱へ移る
    await remove(slug, ['a']);
    expect(await inTrash(text)).toHaveLength(1);
  });

  it('同じ id の付箋が元のページにあれば、戻さずに 409 を返す', async () => {
    const text = unique('重なる付箋');
    const slug = await create([createNote('a', { text })]);
    await remove(slug, ['a']);
    const [copy] = await inTrash(text);
    // ゴミ箱の写しが消えないよう、Undo ではなく、別の経路で同じ id の付箋を置いたことにする
    await runInDurableObject(page(slug), (_do, state) => {
      state.storage.sql.exec(`DELETE FROM trashed`);
    });
    expect((await apply(slug, [createNote('a', { text: 'other' })])).ok).toBe(true);

    const res = await restore([copy.id]);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ pages: [{ page: slug, noteIds: [], error: expect.stringContaining('already exists') }] });
    expect(await inTrash(text)).toHaveLength(1);
  });

  it('戻した直後に同じ opId で送り直すと、記録済みの結果を返す', async () => {
    const text = unique('送り直す付箋');
    const slug = await create([createNote('a', { text })]);
    await remove(slug, ['a']);
    const [copy] = await inTrash(text);
    const opId = unique('op');
    expect((await restore([copy.id], opId)).status).toBe(200);
    const again = await restore([copy.id], opId);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, pages: [{ page: slug, noteIds: ['a'] }] });
    expect((await page(slug).getBoardState())!.notes.filter((n) => n.id === 'a')).toHaveLength(1);
  });

  it('記録のない付箋が混ざっていても、残りは戻す', async () => {
    const text = unique('混ざる付箋');
    const slug = await create([createNote('a', { text })]);
    await remove(slug, ['a']);
    const [copy] = await inTrash(text);
    const res = await restore([copy.id, 'no-such-note']);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      ok: true,
      pages: [
        { page: slug, noteIds: ['a'] },
        { page: null, noteIds: [], error: expect.stringContaining('no-such-note') },
      ],
    });
  });

  it('記録のない付箋は戻せない', async () => {
    const res = await restore(['no-such-note']);
    expect(res.status).toBe(404);
  });

  it('一覧、検索、リンクの索引に出さない', async () => {
    const text = unique('索引に出ない');
    const slug = await create([createNote('a', { text })]);
    await remove(slug, ['a']);
    await runDurableObjectAlarm(trash());
    expect(await env.DB.prepare(`SELECT 1 FROM pages WHERE name = ?`).bind(TRASH_SLUG).first()).toBeNull();
  });

  it('ゴミ箱は子ページにできず、ゴミ箱に子ページを置けない', async () => {
    const slug = await create();
    // ゴミ箱を作っておく
    await remove(await create([createNote('a', { text: unique('作る') })]), ['a']);

    const asChild = await apply(slug, [createNote('t', { text: '', meta: { [CHILD_PAGE_KEY]: TRASH_SLUG } })]);
    expect(asChild.ok).toBe(false);
    expect(parseChildRejection((asChild as { reason: string }).reason)).toEqual({ code: 'trash', page: TRASH_SLUG });

    const inside = await apply(TRASH_SLUG, [createNote('c', { text: '', meta: { [CHILD_PAGE_KEY]: slug } })]);
    expect(parseChildRejection((inside as { reason: string }).reason)).toEqual({ code: 'trash', page: slug });
  });
});

describe('古い付箋を自動で消す', () => {
  const setExpiry = (slug: string, days: unknown) =>
    api(`/api/pages/${slug}/expiry`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days }),
    });

  it('日数を検証する。ページがなければ 404、ゴミ箱の日数は変えられない', async () => {
    const slug = await create([createNote('a')]);
    expect((await setExpiry(slug, 5)).status).toBe(400);
    expect((await api(`/api/pages/${slug}/expiry`, { method: 'PUT', body: '{}' })).status).toBe(400);
    expect((await setExpiry(unique('none'), 30)).status).toBe(404);
    expect((await setExpiry(TRASH_SLUG, 7)).status).toBe(400);

    const res = await setExpiry(slug, 7);
    expect(await res.json()).toEqual({ ok: true, expireDays: 7 });
    expect((await page(slug).getSnapshot()).expireDays).toBe(7);
    expect((await setExpiry(slug, null)).status).toBe(200);
    expect((await page(slug).getSnapshot()).expireDays).toBeNull();
    expect((await trash().getSnapshot()).expireDays).toBe(30);
  });

  it('期限を過ぎた付箋をゴミ箱へ移す。子ページの付箋と、期限前の付箋は残す', async () => {
    const text = unique('古い付箋');
    const child = await create();
    const slug = await create([
      createNote('old', { text }),
      createNote('to-child', { text: '', meta: { [CHILD_PAGE_KEY]: child } }),
    ]);
    expect((await setExpiry(slug, 7)).status).toBe(200);
    await age(slug, 8);
    expect((await apply(slug, [createNote('new', { text: 'new' })])).ok).toBe(true);

    await runDurableObjectAlarm(page(slug));

    const ids = (await page(slug).getBoardState())!.notes.map((n) => n.id).sort();
    expect(ids).toEqual(['new', 'to-child']);
    expect(await inTrash(text)).toHaveLength(1);
    const [op] = await page(slug).listOps({ limit: 1 });
    expect(op).toMatchObject({ actor: 'system', summary: 'system:expired' });
  });

  it('期限を付けていなければ、古い付箋も消さない', async () => {
    const slug = await create([createNote('old')]);
    await age(slug, 400);
    await runDurableObjectAlarm(page(slug));
    expect((await page(slug).getBoardState())!.notes).toHaveLength(1);
  });

  it('ゴミ箱で期限を過ぎた付箋は、消える', async () => {
    const text = unique('ゴミ箱で古い付箋');
    const slug = await create([createNote('a', { text })]);
    await remove(slug, ['a']);
    const [copy] = await inTrash(text);
    await runInDurableObject(trash(), (_do, state) => {
      state.storage.sql.exec(`UPDATE notes SET updated_at = ? WHERE id = ?`, Date.now() - 31 * DAY_MS, copy.id);
    });
    await runDurableObjectAlarm(trash());
    expect(await inTrash(text)).toEqual([]);
    expect(await trash().trashOrigins([copy.id])).toEqual([]);
  });

  it('期限を付けると、最も古い付箋が期限を過ぎる時刻に alarm を設定する', async () => {
    const slug = await create([createNote('a')]);
    await runDurableObjectAlarm(page(slug));
    await age(slug, 3);
    expect((await setExpiry(slug, 7)).status).toBe(200);
    const alarm = await runInDurableObject(page(slug), (_do, state) => state.storage.getAlarm());
    expect(alarm).not.toBeNull();
    expect(Math.abs(alarm! - (Date.now() + 4 * DAY_MS))).toBeLessThan(60_000);
  });
});
