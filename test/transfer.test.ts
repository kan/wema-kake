// 付箋を他のページへ移す（写す）。POST /api/pages/<slug>/transfer と、MCP の move_notes。
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { TOOLS, ToolError } from '../src/shared/tools';
import { CHILD_PAGE_KEY } from '../src/shared/hierarchy';
import { ServerBoardAccess } from '../src/worker/mcp/board-access';
import { api, createNote, edge, join } from './helpers';

let count = 0;
const unique = (prefix: string) => `${prefix}-${++count}`;
const page = (slug: string) => env.PAGE.getByName(slug);
/** 開発用の主体（localhost 宛てのリクエストは、この人として認証される） */
const DEV = 'user:dev@example.com';
const AGENT = 'agent:claude';

/** ページを作り、`deltas` を `actor` の操作として置く */
async function create(deltas: unknown[] = [], actor = 'user:a'): Promise<string> {
  const slug = unique('transfer');
  expect(await page(slug).createPage(slug)).toEqual({ ok: true });
  if (deltas.length > 0) {
    const res = await page(slug).applyOps({ actor, clientId: 'c0', opId: unique('op'), deltas });
    expect(res.ok).toBe(true);
  }
  return slug;
}

const transfer = (from: string, body: Record<string, unknown>) =>
  api(`/api/pages/${from}/transfer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: 'c1', opId: unique('op'), ...body }),
  });

const board = (slug: string) => page(slug).getBoardState();

async function call(name: string, input: unknown): Promise<any> {
  const tool = TOOLS.find((t) => t.name === name)!;
  return tool.run(new ServerBoardAccess(env, AGENT), tool.input.parse(input));
}

describe('POST /api/pages/:slug/transfer', () => {
  it('移すと、作成者を引き継いで送り先に置き、元のページから消す。送る付箋どうしの接続線だけを移す', async () => {
    const from = await create([
      createNote('a', { x: 900, y: 700, text: 'agent の付箋' }),
      createNote('b', { x: 1200, y: 760 }),
      createNote('c'),
      { type: 'edge:create', edge: edge('e1', 'a', 'b') },
      { type: 'edge:create', edge: edge('e2', 'a', 'c') },
    ], AGENT);
    const to = await create([createNote('old', { x: 100, y: 50, width: 200, height: 150 })]);

    const res = await transfer(from, { to, noteIds: ['a', 'b'], positions: { a: { x: 0, y: 0 } } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, page: { name: to, note_count: 3 } });

    const placed = (await board(to))!;
    const moved = placed.notes.filter((n) => n.id !== 'old');
    // 作成者は、移した人ではなく、元の作成者のまま
    expect(moved.map((n) => n.createdBy)).toEqual([AGENT, AGENT]);
    expect(moved[0]).toMatchObject({ text: 'agent の付箋' });
    // id は新しくなり、位置関係（positions で差し替えた a と、元の位置の b）を保って、今ある付箋の下に置く
    expect(moved.map((n) => n.id)).not.toContain('a');
    expect(moved.map(({ x, y }) => ({ x, y }))).toEqual([{ x: 100, y: 240 }, { x: 1300, y: 1000 }]);
    expect(placed.edges).toMatchObject([{ from: moved[0].id, to: moved[1].id }]);

    const left = (await board(from))!;
    expect(left.notes.map((n) => n.id)).toEqual(['c']);
    expect(left.edges).toEqual([]);
    // 両方のページの履歴に、相手のページが分かる要約で残る
    const [received] = await page(to).listOps({ limit: 1 });
    expect(received).toMatchObject({ actor: DEV, summary: `system:notes-received:${from}` });
    const [removed] = await page(from).listOps({ limit: 1 });
    expect(removed).toMatchObject({ actor: DEV, summary: `system:notes-sent:${to}` });
  });

  it('写すと、作成者は写した人になり、元のページに残す', async () => {
    const from = await create([createNote('a')], AGENT);
    const to = await create();
    expect((await transfer(from, { to, noteIds: ['a'], copy: true })).status).toBe(200);
    expect((await board(to))!.notes.map((n) => n.createdBy)).toEqual([DEV]);
    expect((await board(from))!.notes.map((n) => n.id)).toEqual(['a']);
  });

  it('同じ opId で送り直しても、二重には置かない', async () => {
    const from = await create([createNote('a'), createNote('b')]);
    const to = await create();
    const body = { to, noteIds: ['a'], opId: unique('op') };
    expect((await transfer(from, body)).status).toBe(200);
    // 元のページの付箋は、もう消えている
    expect((await transfer(from, body)).status).toBe(200);
    expect((await board(to))!.notes).toHaveLength(1);
    expect((await board(from))!.notes.map((n) => n.id)).toEqual(['b']);
  });

  it('元のページを開いている画面には、消したことが届く（送った画面にも）', async () => {
    const from = await create([createNote('a')]);
    const to = await create();
    const viewer = await join(from, 'c1');
    expect((await transfer(from, { to, noteIds: ['a'] })).status).toBe(200);
    expect(await viewer.next()).toMatchObject({ type: 'ops', deltas: [{ type: 'note:delete' }] });
    viewer.close();
  });

  it('読んだ後に元のページで変わった付箋は、消さずに残す（その間の変更を失わない）', async () => {
    const from = await create([createNote('a'), createNote('b')]);
    const to = await create();
    const sender = { actor: DEV, clientId: 'c1', opId: unique('op') };
    const taken = await page(to).takeNotes({
      ...sender, from, noteIds: ['a', 'b'], positions: new Map(), keepAuthors: true,
    });
    expect(taken.ok).toBe(true);
    if (!taken.ok) return;
    // 置いた後、消す前に、元のページで a が編集された
    await new Promise((resolve) => setTimeout(resolve, 2));
    const edited = await page(from).applyOps({
      actor: 'user:b', clientId: 'c2', opId: unique('op'),
      deltas: [{ type: 'note:update', noteId: 'a', before: { text: 'hello' }, after: { text: '編集した' } }],
    });
    expect(edited.ok).toBe(true);
    const removed = await page(from).removeNotes({
      ...sender, clientId: 'transfer', noteIds: ['a', 'b'], versions: taken.versions, to,
    });
    expect(removed).toMatchObject({ ok: true, kept: ['a'] });
    const left = (await board(from))!.notes;
    expect(left).toMatchObject([{ id: 'a', text: '編集した' }]);
  });

  it('ない付箋、ないページ、子ページの付箋、同じページへは移さない', async () => {
    const child = await create();
    const from = await create([createNote('a'), createNote('p', { meta: { [CHILD_PAGE_KEY]: child } })]);
    const to = await create();
    expect((await transfer(from, { to, noteIds: ['a', 'gone'] })).status).toBe(404);
    expect((await transfer(from, { to: unique('missing'), noteIds: ['a'] })).status).toBe(404);
    expect((await transfer(unique('missing'), { to, noteIds: ['a'] })).status).toBe(404);
    expect((await transfer(from, { to, noteIds: ['p'] })).status).toBe(400);
    expect((await transfer(from, { to: from, noteIds: ['a'] })).status).toBe(400);
    expect((await transfer(from, { to, noteIds: [] })).status).toBe(400);
    expect((await transfer(from, { to, noteIds: ['a'], positions: { a: { x: 'x' } } })).status).toBe(400);
    expect((await board(to))!.notes).toEqual([]);
    expect((await board(from))!.notes).toHaveLength(2);
  });
});

describe('MCP の move_notes', () => {
  it('作成者を引き継いで移し、両方のページの操作を返す。それぞれ取り消せる', async () => {
    const from = await create([createNote('a', { text: '人の付箋' }), createNote('b')], 'user:a');
    const to = await create();
    const result = await call('move_notes', { page: from, note_ids: ['a'], to, reason: '整理' });
    expect(result.note_ids).toHaveLength(1);
    expect(result.operations).toEqual([
      { page: to, operation: expect.any(Number) },
      { page: from, operation: expect.any(Number) },
    ]);
    const placed = (await board(to))!.notes;
    expect(placed).toMatchObject([{ id: result.note_ids[0], createdBy: 'user:a' }]);
    expect((await page(to).listOps({ limit: 1 }))[0]).toMatchObject({ actor: AGENT, summary: 'move_notes: 整理' });

    for (const { page: slug, operation } of result.operations) {
      await call('revert_operation', { page: slug, operation });
    }
    expect((await board(to))!.notes).toEqual([]);
    expect((await board(from))!.notes.map((n) => n.id).sort()).toEqual(['a', 'b']);
  });

  it('同じページ、重複した id、ない付箋は断る', async () => {
    const from = await create([createNote('a')]);
    const to = await create();
    await expect(call('move_notes', { page: from, note_ids: ['a'], to: from })).rejects.toThrow(ToolError);
    await expect(call('move_notes', { page: from, note_ids: ['a', 'a'], to })).rejects.toThrow(/duplicate/);
    await expect(call('move_notes', { page: from, note_ids: ['gone'], to })).rejects.toThrow(/note not found/);
    expect((await board(from))!.notes).toHaveLength(1);
  });
});
