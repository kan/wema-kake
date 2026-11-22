// 付箋へのリアクション（issue #105）。付箋の変更ではないので、ops に積まず、書き込み者と更新日時も変えない
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { HistoryDelta } from '../src/shared/delta';
import { TOOLS } from '../src/shared/tools';
import { ServerBoardAccess } from '../src/worker/mcp/board-access';
import { api, createNote, join, note, open } from './helpers';

let count = 0;
const unique = (prefix: string) => `${prefix}-${++count}`;
const page = (slug: string) => env.PAGE.getByName(slug);
const DEV = 'user:dev@example.com';

async function create(deltas: unknown[] = [createNote('n1'), createNote('n2')]): Promise<string> {
  const slug = unique('reactions');
  expect(await page(slug).createPage(slug)).toEqual({ ok: true });
  const res = await page(slug).applyOps({ actor: 'user:a', clientId: 'c0', opId: unique('op'), deltas });
  expect(res.ok).toBe(true);
  return slug;
}

const like = (slug: string, noteId: string, on = true, kind = 'like') =>
  api(`/api/pages/${slug}/notes/${noteId}/reactions/${kind}`, { method: on ? 'PUT' : 'DELETE' });

async function call(name: string, input: unknown, delegate = 'user:admin@example.com'): Promise<any> {
  const tool = TOOLS.find((t) => t.name === name)!;
  return tool.run(new ServerBoardAccess(env, { actor: 'agent:claude.ai', delegate }), tool.input.parse(input));
}

describe('付箋へのリアクション', () => {
  it('付けて、外す。同じ人は 1 つだけ。ops に積まず、書き込み者と更新日時を変えない', async () => {
    const slug = await create();
    const before = await page(slug).getSnapshot();

    const res = await like(slug, 'n1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reactions: [{ kind: 'like', actor: DEV, at: expect.any(Number) }] });
    // もう一度付けても、増えない
    expect(((await (await like(slug, 'n1')).json()) as { reactions: unknown[] }).reactions).toHaveLength(1);

    const after = await page(slug).getSnapshot();
    expect(after.seq).toBe(before.seq);
    expect(after.info.n1).toEqual({ ...before.info.n1, reactions: [{ kind: 'like', actor: DEV, at: expect.any(Number) }] });
    expect(after.info.n2).toEqual(before.info.n2);

    expect(await (await like(slug, 'n1', false)).json()).toEqual({ reactions: [] });
    expect((await like(slug, 'n1', false)).status).toBe(200);
    expect((await page(slug).getSnapshot()).info.n1).toEqual(before.info.n1);
  });

  it('知らない種類は 400、ない付箋とページは 404', async () => {
    const slug = await create();
    expect((await like(slug, 'n1', true, 'heart')).status).toBe(400);
    expect((await like(slug, 'missing')).status).toBe(404);
    expect((await like(unique('none'), 'n1')).status).toBe(404);
  });

  it('接続中のブラウザに届く。再接続して差分で追いつくときは、全体を送り直す', async () => {
    const slug = await create();
    const a = await join(slug, 'ca');
    await like(slug, 'n1');
    expect(await a.next()).toEqual({
      type: 'reactions',
      reactions: { n1: [{ kind: 'like', actor: DEV, at: expect.any(Number) }] },
    });
    const { seq } = await page(slug).getSnapshot();
    a.close();

    await like(slug, 'n2');
    const b = await open(slug);
    b.send({ type: 'hello', clientId: 'ca', lastSeq: seq });
    expect(await b.next()).toEqual({
      type: 'reactions',
      replace: true,
      reactions: {
        n1: [{ kind: 'like', actor: DEV, at: expect.any(Number) }],
        n2: [{ kind: 'like', actor: DEV, at: expect.any(Number) }],
      },
    });
    b.close();
  });

  it('付箋を消すと、リアクションも消える（Undo で付箋が戻っても戻らない）', async () => {
    const slug = await create();
    await like(slug, 'n1');
    const del = await page(slug).applyOps({
      actor: 'user:a', clientId: 'c0', opId: unique('op'), deltas: [{ type: 'note:delete', note: note('n1') } as HistoryDelta],
    });
    expect(del.ok).toBe(true);
    await page(slug).applyOps({ actor: 'user:a', clientId: 'c0', opId: unique('op'), deltas: [createNote('n1')] });
    expect((await page(slug).getSnapshot()).info.n1.reactions).toBeUndefined();
  });

  it('MCP: 付けて外せる。agent は、委任者ごとに 1 つ。read_board に数が出る', async () => {
    const slug = await create();
    await like(slug, 'n1');
    expect(await call('add_reaction', { page: slug, note_id: 'n1' })).toEqual({ note_id: 'n1', reactions: { like: 2 } });
    expect(await call('add_reaction', { page: slug, note_id: 'n1' }, 'user:other@example.com')).toEqual({
      note_id: 'n1', reactions: { like: 3 },
    });
    const board = await call('read_board', { page: slug });
    expect(board.notes.find((n: { id: string }) => n.id === 'n1').reactions).toEqual({ like: 3 });
    // リアクションのない付箋には、キーごと出さない
    expect(board.notes.find((n: { id: string }) => n.id === 'n2').reactions).toBeUndefined();

    expect(await call('remove_reaction', { page: slug, note_id: 'n1' })).toEqual({ note_id: 'n1', reactions: { like: 2 } });
    const left = (await page(slug).getSnapshot()).info.n1.reactions!;
    expect(left.map((r) => [r.actor, r.delegate])).toEqual([
      [DEV, undefined],
      ['agent:claude.ai', 'user:other@example.com'],
    ]);
    await expect(call('add_reaction', { page: slug, note_id: 'missing' })).rejects.toThrow('note not found');
  });
});
