// ページの階層（docs/plan.md のフェーズ 6.6）。子ページの付箋を置くと子になり、消すとルートへ戻る。
import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { IndexLink, IndexPage, PageSummary, RootHit } from '../src/shared/api';
import { parseChildRejection } from '../src/shared/hierarchy';
import { TOOLS } from '../src/shared/tools';
import { ServerBoardAccess } from '../src/worker/mcp/board-access';
import { api, createNote } from './helpers';

let count = 0;
const unique = (prefix: string) => `${prefix}-${++count}`;
const page = (slug: string) => env.PAGE.getByName(slug);

/** デルタを適用する。opId は毎回変える */
const apply = (slug: string, deltas: unknown[], actor = 'user:a') =>
  page(slug).applyOps({ actor, clientId: 'c1', opId: unique('op'), deltas });

/** ページを作る。`text` があれば、付箋を 1 枚置く */
async function create(prefix: string, title?: string, text?: string): Promise<string> {
  const slug = unique(prefix);
  expect(await page(slug).createPage(title ?? slug)).toEqual({ ok: true });
  if (text !== undefined) expect((await apply(slug, [createNote('body', { text })])).ok).toBe(true);
  return slug;
}

/** 子ページの付箋（本文は持たない） */
const childNote = (id: string, child: string, over: Record<string, unknown> = {}) =>
  createNote(id, { text: '', meta: { page: child }, ...over });

/** `child` を `parent` の子として置く */
async function place(parent: string, child: string, id = `to-${child}`) {
  const res = await apply(parent, [childNote(id, child)]);
  expect(res).toMatchObject({ ok: true });
  return id;
}

const parentOf = async (slug: string) => (await page(slug).getPageRef())?.parent;
const reindex = async (...slugs: string[]) => {
  for (const slug of slugs) await runDurableObjectAlarm(page(slug));
};
const index = async () => (await (await api('/api/index')).json()) as { pages: IndexPage[]; links: IndexLink[] };

describe('付箋の meta', () => {
  it('作成、更新、取り除きができ、スナップショットに出る', async () => {
    const slug = await create('meta');
    await apply(slug, [createNote('n1', { meta: { b: '2', a: '1' } })]);
    const snapshot = async () => (await page(slug).getSnapshot()).data.notes[0];
    expect((await snapshot()).meta).toEqual({ a: '1', b: '2' });

    // 更新は、meta の全体を置き換える。記録には、置き換える前の値が入る
    const updated = await apply(slug, [
      { type: 'note:update', noteId: 'n1', before: {}, after: { meta: { c: '3' } } },
    ]);
    expect(updated).toMatchObject({
      ok: true,
      deltas: [{ type: 'note:update', noteId: 'n1', before: { meta: { a: '1', b: '2' } }, after: { meta: { c: '3' } } }],
    });
    expect((await snapshot()).meta).toEqual({ c: '3' });

    // 中身が同じ meta は、変更として記録しない
    expect(await apply(slug, [{ type: 'note:update', noteId: 'n1', before: {}, after: { meta: { c: '3' } } }]))
      .toMatchObject({ ok: true, deltas: [] });

    // after になく before にあれば、取り除く
    const removed = await apply(slug, [
      { type: 'note:update', noteId: 'n1', before: { meta: { c: '3' } }, after: {} },
    ]);
    expect(removed).toMatchObject({ ok: true, deltas: [{ before: { meta: { c: '3' } }, after: {} }] });
    expect(await snapshot()).not.toHaveProperty('meta');
  });

  it.each([
    ['文字列でない値', { a: 1 }],
    ['長すぎる値', { a: 'x'.repeat(257) }],
    ['不正なキー', { 'a b': '1' }],
    ['多すぎるキー', Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, '1']))],
    ['スラッグでない page', { page: 'Not A Slug' }],
    ['オブジェクトでない meta', 'text'],
  ])('%sは拒否する', async (_name, meta) => {
    const slug = await create('meta-bad');
    const res = await apply(slug, [createNote('n1', { meta })]);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.reason).toMatch(/^(invalid meta|meta must be an object)$/);
  });
});

describe('子ページとして置く', () => {
  it('子ページの付箋を置くと子になり、付箋を消すとルートへ戻る', async () => {
    const parent = await create('parent');
    const child = await create('child');
    expect(await parentOf(child)).toBeNull();

    const id = await place(parent, child);
    expect(await parentOf(child)).toBe(parent);

    const [placed] = (await page(parent).getSnapshot()).data.notes;
    await apply(parent, [{ type: 'note:delete', note: placed }]);
    expect(await parentOf(child)).toBeNull();
    expect(id).toBe(placed.id);
  });

  it('付箋の本文を編集しても、リンクを足しても、階層は変わらない', async () => {
    const parent = await create('parent');
    const child = await create('child');
    const other = await create('other');
    const id = await place(parent, child);
    await apply(parent, [
      { type: 'note:update', noteId: id, before: { text: '' }, after: { text: `説明 <a href="/p/${other}">x</a>` } },
      createNote('link', { text: `<a href="/p/${other}">リンクだけ</a>` }),
    ]);
    expect(await parentOf(child)).toBe(parent);
    // リンクは、階層を作らない
    expect(await parentOf(other)).toBeNull();
  });

  it('付箋の meta を書き換えると、前の子はルートへ戻り、新しい子が置かれる', async () => {
    const parent = await create('parent');
    const first = await create('first');
    const second = await create('second');
    const id = await place(parent, first);
    const res = await apply(parent, [
      { type: 'note:update', noteId: id, before: { meta: { page: first } }, after: { meta: { page: second } } },
    ]);
    expect(res.ok).toBe(true);
    expect(await parentOf(first)).toBeNull();
    expect(await parentOf(second)).toBe(parent);
  });

  it.each([
    ['存在しないページ', async () => ({ parent: await create('p'), child: 'no-such-page-x' }), 'not-found'],
    ['自分自身', async () => { const p = await create('p'); return { parent: p, child: p }; }, 'self'],
    [
      'すでに別のページの子になっているページ',
      async () => {
        const child = await create('c');
        await place(await create('first-parent'), child);
        return { parent: await create('p'), child };
      },
      'other-parent',
    ],
    [
      '同じページにすでに置いてあるページ',
      async () => {
        const parent = await create('p');
        const child = await create('c');
        await place(parent, child);
        return { parent, child };
      },
      'duplicate',
    ],
    [
      '自分の親（輪になる）',
      async () => {
        const top = await create('top');
        const parent = await create('p');
        await place(top, parent);
        return { parent, child: top };
      },
      'ancestor',
    ],
    [
      '自分の先祖（輪になる）',
      async () => {
        const top = await create('top');
        const middle = await create('middle');
        const parent = await create('p');
        await place(top, middle);
        await place(middle, parent);
        return { parent, child: top };
      },
      'ancestor',
    ],
  ] as const)('%sは置けない', async (_name, setup, code) => {
    const { parent, child } = await setup();
    const before = (await page(parent).getSnapshot()).data.notes.length;
    const res = await apply(parent, [createNote('plain'), childNote('rejected', child)]);
    // 理由は、決まった形の文字列で返る。画面は、これを理由とページに分けて読む
    expect(res).toEqual({ ok: false, reason: `child page: ${code}: ${child}` });
    expect(parseChildRejection(`child page: ${code}: ${child}`)).toEqual({ code, page: child });
    // 一緒に送った他のデルタも適用しない
    expect((await page(parent).getSnapshot()).data.notes).toHaveLength(before);
  });

  it('1 回の操作で複数を置こうとして 1 つでも置けなければ、どれも子にしない', async () => {
    const parent = await create('parent');
    const ok = await create('ok');
    const taken = await create('taken');
    await place(await create('other-parent'), taken);
    const res = await apply(parent, [childNote('a', ok), childNote('b', taken)]);
    expect(res.ok).toBe(false);
    expect(await parentOf(ok)).toBeNull();
  });

  it('階層は 5 段まで。6 段目になる置き方は断る', async () => {
    const chain = [];
    for (let i = 0; i < 5; i++) chain.push(await create(`depth${i + 1}`));
    for (let i = 0; i < 4; i++) await place(chain[i], chain[i + 1]);
    // 5 段目のページの下には置けない
    const sixth = await create('depth6');
    const res = await apply(chain[4], [childNote('x', sixth)]);
    expect(res).toEqual({ ok: false, reason: `child page: too-deep: ${sixth}` });
    expect(await parentOf(sixth)).toBeNull();

    // 子孫を持つページを置くときは、置いた後の最も深い段で数える。子孫の深さは DO をたどって
    // 求めるので、索引への反映（数秒後）を待たずに、置いた直後でも正しく数える
    const top = await create('sub-top');
    const bottom = await create('sub-bottom');
    await place(top, bottom);
    // 4 段目の下に 2 段の部分木を置くと、6 段になる
    const deep = await apply(chain[3], [childNote('y', top)]);
    expect(!deep.ok && deep.reason).toContain('too-deep');
    // 3 段目の下なら、5 段に収まる
    expect((await apply(chain[2], [childNote('z', top)])).ok).toBe(true);
  });

  it('取り消し（revert）で子ページの付箋が戻ると、もう一度子になる', async () => {
    const parent = await create('parent');
    const child = await create('child');
    await place(parent, child);
    const [placed] = (await page(parent).getSnapshot()).data.notes;
    const deleted = await apply(parent, [{ type: 'note:delete', note: placed }], 'agent:test');
    expect(await parentOf(child)).toBeNull();

    const revert = (opId: string) =>
      page(parent).revert({ seq: (deleted as { seq: number }).seq, actor: 'user:a', clientId: 'c1', opId });
    expect(await revert('revert-1')).toMatchObject({ ok: true, applied: 1 });
    expect(await parentOf(child)).toBe(parent);
  });

  it('付箋を戻す取り消しは、その間に子ページが別の親に置かれていたら断る', async () => {
    const parent = await create('parent');
    const child = await create('child');
    await place(parent, child);
    const [placed] = (await page(parent).getSnapshot()).data.notes;
    const deleted = await apply(parent, [{ type: 'note:delete', note: placed }]);
    await place(await create('new-parent'), child);

    const res = await page(parent).revert({
      seq: (deleted as { seq: number }).seq, actor: 'user:a', clientId: 'c1', opId: 'revert-taken',
    });
    expect(res).toMatchObject({ ok: false, code: 'conflict' });
    expect((await page(parent).getSnapshot()).data.notes).toEqual([]);
  });
});

describe('ページの削除と階層', () => {
  it('子ページを削除すると、親ページにある子ページの付箋も消える', async () => {
    const parent = await create('parent');
    const child = await create('child');
    await place(parent, child);
    await apply(parent, [createNote('keep')]);

    expect((await api(`/api/pages/${child}`, { method: 'DELETE' })).status).toBe(200);
    const notes = (await page(parent).getSnapshot()).data.notes;
    expect(notes.map((n) => n.id)).toEqual(['keep']);
    // 付箋の削除として記録される
    const [op] = await page(parent).listOps();
    expect(op).toMatchObject({ actor: 'user:dev@example.com', summary: `system:child-removed:${child}` });
  });

  it('親ページを削除すると、子ページはルートへ戻る（子孫ごとは削除しない）', async () => {
    const parent = await create('parent');
    const child = await create('child', '残るページ', '本文');
    await place(parent, child);
    await page(parent).deletePage();
    expect(await parentOf(child)).toBeNull();
    expect((await page(child).getSnapshot()).data.notes).toHaveLength(1);
  });
});

describe('索引と API', () => {
  it('一覧にはルートのページだけが出て、子ページの数が付く', async () => {
    const parent = await create('idx-parent');
    const child = await create('idx-child');
    const grandchild = await create('idx-grandchild');
    await place(parent, child);
    await place(child, grandchild);
    await reindex(parent, child, grandchild);

    const { pages } = await index();
    const names = pages.map((p) => p.name);
    expect(names).toContain(parent);
    expect(names).not.toContain(child);
    expect(names).not.toContain(grandchild);
    // 数えるのは、直接の子だけ
    expect(pages.find((p) => p.name === parent)).toMatchObject({ child_count: 1 });

    // 子ページの付箋を消すと、一覧に戻る
    const [placed] = (await page(parent).getSnapshot()).data.notes;
    await apply(parent, [{ type: 'note:delete', note: placed }]);
    await reindex(parent, child);
    const after = await index();
    expect(after.pages.map((p) => p.name)).toContain(child);
    expect(after.pages.find((p) => p.name === parent)).toMatchObject({ child_count: 0 });
  });

  it('一覧の線は、ルート同士のリンクと、未作成のページへのリンクだけ', async () => {
    const child = await create('line-child');
    const target = await create('line-target');
    const root = await create('line-root', undefined, `<a href="/p/${target}">t</a> <a href="/p/${child}">c</a> <a href="/p/line-missing-x">m</a>`);
    const parent = await create('line-parent');
    await place(parent, child);
    await apply(child, [createNote('from-child', { text: `<a href="/p/${target}">t</a>` })]);
    await reindex(root, parent, child, target);

    const { links } = await index();
    const mine = links.filter((l) => l.from_page === root || l.from_page === child);
    expect(mine).toEqual(
      expect.arrayContaining([
        { from_page: root, to_page: target, missing: 0 },
        { from_page: root, to_page: 'line-missing-x', missing: 1 },
      ]),
    );
    // 子ページへのリンクと、子ページからのリンクは出さない
    expect(mine).toHaveLength(2);
  });

  it('pages-info は、子ページの付箋に出す概要（表示名、枚数、親、配置）を返す', async () => {
    const parent = await create('info-parent');
    const child = await create('info-child', '子の表示名');
    await apply(child, [createNote('a', { x: 10.4, y: 20.6 }), createNote('b', { x: 300, y: 40, color: '#C8E6C9' })]);
    await place(parent, child);
    await reindex(parent, child);

    const res = await api('/api/pages-info', {
      method: 'POST', body: JSON.stringify({ names: [child, 'info-no-such-page'] }),
    });
    const { pages } = (await res.json()) as { pages: PageSummary[] };
    // 索引にないページは、結果に入らない
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ name: child, title: '子の表示名', note_count: 2, parent });
    expect(JSON.parse(pages[0].layout!)).toEqual([
      [10, 21, 200, 150, '#FFF9C4'],
      [300, 40, 200, 150, '#C8E6C9'],
    ]);

    // 索引への反映を待たずに、作ったばかりのページも返す（配置は、索引ができるまで出ない）
    const fresh = await create('info-fresh', '作ったばかり', '本文');
    const early = await api('/api/pages-info', { method: 'POST', body: JSON.stringify({ names: [fresh] }) });
    expect(((await early.json()) as { pages: PageSummary[] }).pages).toEqual([
      { name: fresh, title: '作ったばかり', color: null, note_count: 1, parent: null, layout: null },
    ]);

    for (const names of [[], ['Bad Slug'], 'x', Array.from({ length: 201 }, (_, i) => `p${i}`)]) {
      const bad = await api('/api/pages-info', { method: 'POST', body: JSON.stringify({ names }) });
      expect(bad.status).toBe(400);
    }
  });

  it('付箋を動かしただけでも、配置は索引に反映される', async () => {
    const slug = await create('layout-move', undefined, '本文');
    await reindex(slug);
    await apply(slug, [{ type: 'note:update', noteId: 'body', before: {}, after: { x: 500 } }]);
    await reindex(slug);
    const row = await env.DB.prepare(`SELECT layout FROM pages WHERE name = ?`).bind(slug).first<{ layout: string }>();
    expect(JSON.parse(row!.layout)[0][0]).toBe(500);
  });

  it('ancestors は、ルートから順に先祖を返す', async () => {
    const top = await create('anc-top', '一番上');
    const middle = await create('anc-middle', '中');
    const bottom = await create('anc-bottom');
    await place(top, middle);
    await place(middle, bottom);
    const get = async (slug: string) => ((await (await api(`/api/pages/${slug}/ancestors`)).json()) as { ancestors: unknown }).ancestors;
    expect(await get(bottom)).toEqual([{ name: top, title: '一番上' }, { name: middle, title: '中' }]);
    expect(await get(top)).toEqual([]);
    expect(await get('anc-no-such-page')).toEqual([]);
  });

  it('絞り込みの検索は、一致したページと、そのルートを返す', async () => {
    const root = await create('find-root', undefined, '根だけにある語 ねっこ検索語');
    const child = await create('find-child');
    const grandchild = await create('find-grandchild', undefined, '孫だけにある語 まご検索語');
    await place(root, child);
    await place(child, grandchild);
    await reindex(root, child, grandchild);

    const search = async (q: string) =>
      ((await (await api(`/api/search?roots=1&q=${encodeURIComponent(q)}`)).json()) as { pages: RootHit[] }).pages;
    expect(await search('ねっこ検索語')).toEqual([{ name: root, root }]);
    // 子孫が一致したら、ルートを付けて返す
    expect(await search('まご検索語')).toEqual([{ name: grandchild, root }]);
    // スラッグでも探せる（2 文字の検索語は LIKE で探す）
    expect(await search(grandchild)).toEqual([{ name: grandchild, root }]);
    expect((await search('まご')).map((hit) => hit.root)).toContain(root);
    expect((await api('/api/search?roots=1&q=')).status).toBe(400);
  });

  it('親ページがなくなっているページは、索引の更新でルートへ戻る', async () => {
    const child = await create('orphan-child');
    // 親ページの削除のときに clearParent が届かなかった状態を作る（存在しないページを親にする）
    expect(await page(child).setParent('orphan-no-such-parent')).toBeNull();
    await reindex(child);
    expect(await parentOf(child)).toBeNull();
    // D1 には、次の索引の更新で反映される
    await reindex(child);
    const row = await env.DB.prepare(`SELECT parent FROM pages WHERE name = ?`).bind(child).first();
    expect(row).toEqual({ parent: null });
  });

  it('リンクの文字にエンティティがあっても、1 回だけ復号する', async () => {
    const slug = await create('entity', undefined, `<a href="/p/target-x">&amp;lt;b&amp;gt; と &lt;</a>`);
    const tool = TOOLS.find((t) => t.name === 'read_board')!;
    const board = (await tool.run(new ServerBoardAccess(env, 'agent:test'), { page: slug })) as any;
    expect(board.notes[0].text).toBe('&lt;b&gt; と < [[target-x]]');
  });

  it('子ページの付箋がないのに索引で子になっているページは、索引の更新でルートへ戻す', async () => {
    const parent = await create('heal-parent');
    const child = await create('heal-child');
    await place(parent, child);
    await reindex(parent, child);
    // 付箋を消した後の clearParent が失敗した状態を作る（子の側だけ、親が残っている）
    const [placed] = (await page(parent).getSnapshot()).data.notes;
    await apply(parent, [{ type: 'note:delete', note: placed }]);
    expect(await page(child).setParent(parent)).toBeNull();
    await reindex(child);
    expect(await parentOf(child)).toBe(parent);

    await apply(parent, [createNote('touch')]);
    await reindex(parent);
    expect(await parentOf(child)).toBeNull();
  });
});

describe('子ページの色と、その付箋の色', () => {
  const noteColor = async (parent: string, id: string) =>
    (await page(parent).getSnapshot()).data.notes.find((n) => n.id === id)?.color;
  const pageColor = async (slug: string) => (await page(slug).getPageRef())?.color;
  const recolor = (id: string, color: string) => ({ type: 'note:update', noteId: id, before: {}, after: { color } });

  it('付箋の色を変えると、子ページの色になる。ふつうの付箋の色は、ページの色にしない', async () => {
    const parent = await create('color-parent');
    const child = await create('color-child');
    const id = await place(parent, child);
    await apply(parent, [createNote('plain')]);

    expect((await apply(parent, [recolor(id, '#BBDEFB'), recolor('plain', '#FFCDD2')])).ok).toBe(true);
    expect(await pageColor(child)).toBe('#BBDEFB');
    expect(await pageColor(parent)).toBeNull();
  });

  it('子ページの色を変えると、親ページにある付箋の色になる。色を外すと、既定の色に戻る', async () => {
    const parent = await create('color-parent');
    const child = await create('color-child');
    const id = await place(parent, child);

    const res = await api(`/api/pages/${child}/color`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ color: '#C8E6C9' }),
    });
    expect(res.status).toBe(200);
    expect(await noteColor(parent, id)).toBe('#C8E6C9');
    // 親ページの履歴には、色を合わせた操作として残る
    const [op] = await page(parent).listOps({ limit: 1 });
    expect(op).toMatchObject({ actor: 'user:dev@example.com', summary: `system:child-recolored:${child}` });

    expect(await page(child).setColor(null)).toEqual({ ok: true, color: null });
    expect(await noteColor(parent, id)).toBe('#FFF9C4');
    expect(await pageColor(child)).toBeNull();
  });

  it('色の付いたページを子として置くと、付箋がその色になる', async () => {
    const parent = await create('color-parent');
    const child = await create('color-child');
    await page(child).setColor('#E1BEE7');
    const id = await place(parent, child);
    expect(await noteColor(parent, id)).toBe('#E1BEE7');
    expect(await pageColor(child)).toBe('#E1BEE7');
  });

  it('色の付いていないページを置いた付箋は、色を変えない操作では、ページの色にならない', async () => {
    const parent = await create('color-parent');
    const child = await create('color-child');
    const id = await apply(parent, [childNote('kid', child, { color: '#FFCDD2' })]).then(() => 'kid');
    expect(await pageColor(child)).toBeNull();

    // 今と同じ色への変更と、色のほかの変更
    await apply(parent, [recolor(id, '#FFCDD2')]);
    await apply(parent, [{ type: 'note:update', noteId: id, before: {}, after: { x: 500 } }]);
    expect(await noteColor(parent, id)).toBe('#FFCDD2');
    expect(await pageColor(child)).toBeNull();
  });

  it('ページに付けられない色を付箋に付けても、ページの色は変わらない', async () => {
    const parent = await create('color-parent');
    const child = await create('color-child');
    const id = await place(parent, child);
    await apply(parent, [recolor(id, '#BBDEFB')]);
    expect((await apply(parent, [recolor(id, '#123456')])).ok).toBe(true);
    expect(await pageColor(child)).toBe('#BBDEFB');
  });

  it('付箋の色が子ページの色と食い違っていたら、子ページの索引の更新で、付箋を合わせる', async () => {
    const parent = await create('color-parent');
    const child = await create('color-child');
    const id = await place(parent, child);
    // 色をそろえるようにする前の状態（ページにだけ色が付いている）を作る
    expect(await page(child).setOwnColor('#B2DFDB')).toEqual({ ok: true, color: '#B2DFDB' });
    expect(await noteColor(parent, id)).toBe('#FFF9C4');

    await reindex(child);
    expect(await noteColor(parent, id)).toBe('#B2DFDB');
  });

  it('付箋の色の変更を取り消すと、子ページの色も戻る', async () => {
    const parent = await create('color-parent');
    const child = await create('color-child');
    const id = await place(parent, child);
    await apply(parent, [recolor(id, '#BBDEFB')]);
    const changed = await apply(parent, [recolor(id, '#FFCDD2')]);
    expect(await pageColor(child)).toBe('#FFCDD2');

    const reverted = await page(parent).revert({
      actor: 'user:a', clientId: 'c1', opId: unique('op'), seq: (changed as { seq: number }).seq,
    });
    expect(reverted).toMatchObject({ ok: true });
    expect(await noteColor(parent, id)).toBe('#BBDEFB');
    expect(await pageColor(child)).toBe('#BBDEFB');
  });
});

describe('MCP', () => {
  const call = async (name: string, input: unknown): Promise<any> => {
    const tool = TOOLS.find((t) => t.name === name)!;
    return tool.run(new ServerBoardAccess(env, 'agent:test'), tool.input.parse(input));
  };

  it('read_board は子ページの付箋を child_page で返し、list_pages は親を返す', async () => {
    const parent = await create('mcp-parent');
    const child = await create('mcp-child');
    await place(parent, child);
    await apply(parent, [createNote('plain', { text: 'ふつうの付箋' })]);
    await reindex(parent, child);

    const board = await call('read_board', { page: parent });
    expect(board.notes.map((n: any) => n.child_page)).toEqual([child, undefined]);

    const pages = await call('list_pages', { limit: 500 });
    expect(pages.find((p: any) => p.name === child)).toMatchObject({ parent });
    expect(pages.find((p: any) => p.name === parent)).toMatchObject({ parent: null });
  });

  it('delete_notes で子ページの付箋を消すと、子ページはルートへ戻る', async () => {
    const parent = await create('mcp-del-parent');
    const child = await create('mcp-del-child');
    const id = await place(parent, child);
    await call('delete_notes', { page: parent, note_ids: [id] });
    expect(await parentOf(child)).toBeNull();
  });
});
