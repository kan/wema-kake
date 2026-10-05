import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { api, createNote, edge, join, note } from './helpers';

let pageCount = 0;
let opCount = 0;

const AGENT = 'agent:claude';
const USER = 'user:a@example.com';

function newPage() {
  const slug = `revert-${++pageCount}`;
  const stub = env.PAGE.getByName(slug);
  /** 適用して seq を返す */
  const apply = async (deltas: unknown, actor = AGENT, summary?: string) => {
    const res = await stub.applyOps({ actor, clientId: 'c1', opId: `op${++opCount}`, deltas, summary });
    if (!res.ok) throw new Error(res.reason);
    return res.seq;
  };
  const revert = (seq: number, over: Record<string, unknown> = {}) =>
    stub.revert({ seq, actor: USER, clientId: 'c9', opId: `rv${++opCount}`, ...over });
  const board = async () => (await stub.getSnapshot()).data;
  return { slug, stub, apply, revert, board };
}

const update = (noteId: string, before: object, after: object) => ({
  type: 'note:update', noteId, before, after,
});

describe('revert', () => {
  it('複数の付箋と接続線を変更した操作を、1 つの操作として取り消す', async () => {
    const { stub, apply, revert, board } = newPage();
    await apply([createNote('n1'), createNote('n2', { text: 'keep' })], USER);
    const before = await board();

    const seq = await apply([
      createNote('n3', { text: 'advice' }),
      { type: 'edge:create', edge: edge('e1', 'n1', 'n3') },
      update('n1', {}, { x: 300, color: '#fff' }),
      { type: 'note:delete', note: note('n2') },
    ]);
    const res = await revert(seq);
    expect(res).toEqual({ ok: true, seq: seq + 1, applied: 4, skipped: [] });
    expect(await board()).toEqual(before);

    const ops = await stub.listOps();
    expect(ops[0]).toMatchObject({
      seq: seq + 1, actor: USER, summary: `system:revert:${seq}`, reverts: seq, revertedBy: null,
    });
    expect(ops[1]).toMatchObject({ seq, actor: AGENT, revertedBy: seq + 1 });
  });

  it('付箋の削除を取り消すと、一緒に消えた接続線も戻る', async () => {
    const { apply, revert, board } = newPage();
    await apply([createNote('n1'), createNote('n2'), { type: 'edge:create', edge: edge('e1', 'n1', 'n2', { label: 'L' }) }]);
    const before = await board();
    // 接続線を指定しない削除（MCP の delete_notes の形）
    const seq = await apply([{ type: 'note:delete', note: note('n1') }]);
    expect((await board()).edges).toEqual([]);

    expect(await revert(seq)).toMatchObject({ ok: true, applied: 2, skipped: [] });
    const after = await board();
    expect(after.edges).toEqual(before.edges);
    expect(after.notes).toEqual(expect.arrayContaining(before.notes));
  });

  it('その後に変更された付箋は戻さず、残りだけを取り消す', async () => {
    const { apply, revert, board } = newPage();
    await apply([createNote('n1'), createNote('n2'), createNote('n3')], USER);
    const seq = await apply([
      update('n1', {}, { x: 100 }),
      update('n2', {}, { x: 100 }),
      update('n3', {}, { x: 100, color: '#000' }),
    ]);
    // 人が n2 を動かし、n3 の色だけを変える
    await apply([update('n2', {}, { x: 555 }), update('n3', {}, { color: '#abc' })], USER);

    const res = await revert(seq);
    expect(res).toMatchObject({
      ok: true,
      applied: 2,
      skipped: [
        { target: 'note', id: 'n3', reason: 'modified' },
        { target: 'note', id: 'n2', reason: 'modified' },
      ],
    });
    const notes = Object.fromEntries((await board()).notes.map((n) => [n.id, n]));
    expect(notes.n1.x).toBe(10);
    expect(notes.n2.x).toBe(555);
    // n3 は、変更されていない x だけが戻る
    expect(notes.n3).toMatchObject({ x: 10, color: '#abc' });
  });

  it('agent が貼った付箋は、動かしただけなら消す。text を書き換えていたら残す', async () => {
    const { apply, revert, board } = newPage();
    const seq = await apply([createNote('moved'), createNote('edited', { text: 'v1' })]);
    await apply(
      [update('moved', {}, { x: 999, color: '#000' }), update('edited', { text: 'v1' }, { text: 'v2' })],
      USER,
    );
    expect(await revert(seq)).toMatchObject({
      ok: true,
      applied: 1,
      skipped: [{ target: 'note', id: 'edited', reason: 'modified' }],
    });
    expect((await board()).notes.map((n) => n.id)).toEqual(['edited']);
  });

  it('取り消す対象がすでにない場合と、戻す先がふさがっている場合', async () => {
    const { apply, revert, board } = newPage();
    await apply([createNote('n1'), createNote('n2')], USER);
    const created = await apply([createNote('n3')]);
    const updated = await apply([update('n1', {}, { x: 50 })]);
    await apply([{ type: 'edge:create', edge: edge('e1', 'n1', 'n2') }], USER);
    const deleted = await apply([{ type: 'edge:delete', edge: edge('e1', 'n1', 'n2') }]);

    // n3 と n1 と n2 を人が消す
    await apply(['n3', 'n1', 'n2'].map((id) => ({ type: 'note:delete', note: note(id) })), USER);

    // 作成の取り消し: 対象がもうないので、することがない（記録もしない）
    expect(await revert(created)).toEqual({ ok: true, seq: null, applied: 0, skipped: [] });
    // 更新の取り消し: 対象がない
    expect(await revert(updated)).toMatchObject({
      applied: 0, skipped: [{ target: 'note', id: 'n1', reason: 'deleted' }],
    });
    // 接続線の削除の取り消し: 両端がない
    expect(await revert(deleted)).toMatchObject({
      applied: 0, skipped: [{ target: 'edge', id: 'e1', reason: 'endpoint-missing' }],
    });
    expect((await board()).notes).toEqual([]);
  });

  it('同じ操作を二重には取り消さない。同じ opId の再送には記録済みの結果を返す', async () => {
    const { apply, revert, stub } = newPage();
    const seq = await apply([createNote('n1')]);
    const first = await revert(seq, { opId: 'same' });
    expect(first).toMatchObject({ ok: true, seq: seq + 1, applied: 1 });
    expect(await revert(seq, { opId: 'same' })).toMatchObject({ ok: true, seq: seq + 1, applied: 1 });
    expect(await revert(seq)).toEqual({ ok: false, code: 'conflict', reason: 'already reverted' });
    expect((await stub.getSnapshot()).seq).toBe(seq + 1);
  });

  it('取り消しを取り消すと、元の変更が戻る', async () => {
    const { stub, apply, revert, board } = newPage();
    const seq = await apply([createNote('n1', { text: 'advice' })]);
    const reverted = await revert(seq);
    expect((await board()).notes).toEqual([]);
    if (!reverted.ok || reverted.seq === null) throw new Error('revert failed');
    expect(await revert(reverted.seq)).toMatchObject({ ok: true, applied: 1 });
    expect((await board()).notes).toEqual([note('n1', { text: 'advice' })]);

    // 元の操作は内容が戻ったので、取り消し済みではなくなり、もう一度取り消せる
    const ops = Object.fromEntries((await stub.listOps()).map((o) => [o.seq, o.revertedBy]));
    expect(ops).toEqual({ [seq]: null, [reverted.seq]: reverted.seq + 1, [reverted.seq + 1]: null });
    expect(await revert(seq)).toMatchObject({ ok: true, applied: 1 });
    expect((await board()).notes).toEqual([]);
  });

  it('取り消さない接続線がつながっている付箋は、消さずに残す', async () => {
    const { apply, revert, board } = newPage();
    await apply([createNote('base'), createNote('other')], USER);
    const seq = await apply([
      createNote('advice-1'),
      { type: 'edge:create', edge: edge('e1', 'base', 'advice-1', { label: 'L' }) },
      createNote('advice-2'),
      createNote('advice-3'),
      { type: 'edge:create', edge: edge('e3', 'base', 'advice-3') },
    ]);
    // 人が e1 の label を変え、advice-2 に別の接続線をつなぐ
    await apply(
      [
        { type: 'edge:update', edgeId: 'e1', before: { label: 'L' }, after: { label: '変更後' } },
        { type: 'edge:create', edge: edge('e2', 'other', 'advice-2') },
      ],
      USER,
    );

    const res = await revert(seq);
    expect(res).toMatchObject({ ok: true, applied: 2 });
    if (!res.ok) throw new Error(res.reason);
    expect(res.skipped).toEqual(
      expect.arrayContaining([
        { target: 'edge', id: 'e1', reason: 'modified' },
        { target: 'note', id: 'advice-1', reason: 'connected' },
        { target: 'note', id: 'advice-2', reason: 'connected' },
      ]),
    );
    const after = await board();
    expect(after.notes.map((n) => n.id).sort()).toEqual(['advice-1', 'advice-2', 'base', 'other']);
    expect(after.edges.map((e) => e.id).sort()).toEqual(['e1', 'e2']);
  });

  it('同じ opId を別の操作の取り消しに使い回すと、成功ではなく拒否を返す', async () => {
    const { apply, revert, board } = newPage();
    const first = await apply([createNote('n1')]);
    const second = await apply([createNote('n2')]);
    expect(await revert(first, { opId: 'reused' })).toMatchObject({ ok: true, applied: 1 });
    expect(await revert(second, { opId: 'reused' })).toEqual({
      ok: false, code: 'invalid', reason: 'opId already used',
    });
    expect((await board()).notes.map((n) => n.id)).toEqual(['n2']);
  });

  it('ownOnly なら、他の主体の操作は取り消せない', async () => {
    const { stub, apply, revert } = newPage();
    const byUser = await apply([createNote('n1')], USER);
    const byAgent = await apply([createNote('n2')]);
    expect(await revert(byUser, { actor: AGENT, ownOnly: true })).toEqual({
      ok: false, code: 'forbidden', reason: 'not your operation',
    });
    expect(await revert(byAgent, { actor: AGENT, ownOnly: true, summary: 'revert_operation: やり直す' }))
      .toMatchObject({ ok: true, applied: 1 });
    expect((await stub.listOps({ actor: AGENT }))[0]).toMatchObject({
      actor: AGENT, summary: 'revert_operation: やり直す', reverts: byAgent,
    });
  });

  it('存在しない操作と、間引かれた操作は取り消せない', async () => {
    const { apply, revert, stub } = newPage();
    const notFound = { ok: false, code: 'not-found', reason: 'operation not found' };
    expect(await revert(1)).toEqual(notFound);
    const seq = await apply([createNote('n1')]);
    expect(await revert(99)).toEqual(notFound);
    expect(await revert(1.5)).toEqual(notFound);
    await runInDurableObject(stub, (_do, state) => void state.storage.sql.exec(`DELETE FROM ops`));
    expect(await revert(seq)).toEqual(notFound);
  });

  it('取り消しは、要求元の接続にも他の接続と同じ内容で配信する（reverts で見分けられる）', async () => {
    const { slug, apply, stub } = newPage();
    const seq = await apply([createNote('n1')]);
    const requester = await join(slug, 'browser-1');
    const other = await join(slug, 'browser-2');

    await stub.revert({ seq, actor: 'user:dev@example.com', clientId: 'browser-1', opId: 'rv' });
    const expected = {
      type: 'ops',
      seq: seq + 1,
      actor: 'user:dev@example.com',
      clientId: 'browser-1',
      opId: 'rv',
      summary: `system:revert:${seq}`,
      reverts: seq,
      deltas: [{ type: 'note:delete', note: note('n1') }],
    };
    expect(await requester.next()).toEqual(expected);
    expect(await other.next()).toEqual(expected);
    requester.close();
    other.close();
  });
});

describe('操作の一覧と取り消しの API', () => {
  it('最近の操作を新しい順に返し、agent の操作に絞れる', async () => {
    const { slug, apply } = newPage();
    await apply([createNote('n1')], USER);
    await apply([createNote('n2')], AGENT, 'add_notes: 助言を追加');
    await apply([createNote('n3')], 'agent:chatgpt', 'add_notes');

    const all = (await (await api(`/api/pages/${slug}/ops`)).json()) as { ops: Record<string, unknown>[] };
    expect(all.ops.map((o) => o.seq)).toEqual([3, 2, 1]);
    const agents = (await (await api(`/api/pages/${slug}/ops?agent=1&limit=1`)).json()) as { ops: unknown[] };
    expect(agents.ops).toEqual([
      {
        seq: 3, actor: 'agent:chatgpt', summary: 'add_notes',
        reverts: null, revertedBy: null, createdAt: expect.any(Number),
      },
    ]);
    expect(await (await api('/api/pages/revert-untouched/ops')).json()).toEqual({ ops: [] });
  });

  it('取り消しを実行し、認証した主体で記録する', async () => {
    const { slug, apply, stub } = newPage();
    const seq = await apply([createNote('n1')]);
    const post = (target: number | string, body: unknown = { clientId: 'c1', opId: 'rv1' }) =>
      api(`/api/pages/${slug}/ops/${target}/revert`, { method: 'POST', body: JSON.stringify(body) });

    const res = await post(seq);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, seq: seq + 1, applied: 1, skipped: [] });
    expect((await stub.listOps())[0]).toMatchObject({ actor: 'user:dev@example.com' });

    expect((await post(seq, { clientId: 'c1', opId: 'rv2' })).status).toBe(409);
    expect((await post(999, { clientId: 'c1', opId: 'rv3' })).status).toBe(404);
    expect((await post('abc', { clientId: 'c1', opId: 'rv4' })).status).toBe(404);
    // clientId と opId は必須
    expect((await post(seq, {})).status).toBe(400);
  });
});
