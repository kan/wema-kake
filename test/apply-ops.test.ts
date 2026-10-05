import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { PageDO } from '../src/worker/page-do';
import { createNote, edge, note } from './helpers';

let pageCount = 0;
let opCount = 0;

/** テストごとに別のページ（DO）を使う */
function newPage() {
  const stub = env.PAGE.getByName(`apply-ops-${++pageCount}`);
  const apply = (deltas: unknown, opId = `op${++opCount}`, actor = 'user:a@example.com') =>
    stub.applyOps({ actor, clientId: 'c1', opId, deltas });
  return { stub, apply };
}

describe('applyOps', () => {
  it('付箋と接続線を作成し、スナップショットで読める', async () => {
    const { stub, apply } = newPage();
    const res = await apply([
      createNote('n1'),
      createNote('n2', { autoSize: true }),
      { type: 'edge:create', edge: edge('e1', 'n1', 'n2', { label: 'L' }) },
    ]);
    expect(res).toMatchObject({ ok: true, seq: 1, fixups: [] });

    const snap = await stub.getSnapshot();
    expect(snap.seq).toBe(1);
    expect(snap.data.notes).toEqual([note('n1'), note('n2', { autoSize: true })]);
    expect(snap.data.edges).toEqual([edge('e1', 'n1', 'n2', { label: 'L' })]);
  });

  it('更新の before はサーバーの保存値で置き換え、変わらないキーは捨てる', async () => {
    const { stub, apply } = newPage();
    await apply([createNote('n1')]);
    const res = await apply([
      {
        type: 'note:update',
        noteId: 'n1',
        before: { x: 999, y: 20 },
        after: { x: 50, y: 20, color: '#fff' },
      },
    ]);
    expect(res).toMatchObject({
      ok: true,
      seq: 2,
      deltas: [
        {
          type: 'note:update',
          noteId: 'n1',
          before: { x: 10, color: '#FFF9C4' },
          after: { x: 50, color: '#fff' },
        },
      ],
    });
    expect((await stub.getSnapshot()).data.notes[0]).toMatchObject({ x: 50, y: 20, color: '#fff' });
  });

  it('zIndex だけの更新は保存せず、seq も進めない', async () => {
    const { stub, apply } = newPage();
    await apply([createNote('n1')]);
    const res = await apply([
      { type: 'note:update', noteId: 'n1', before: { zIndex: 1 }, after: { zIndex: 9 } },
    ]);
    expect(res).toEqual({ ok: true, seq: 1, deltas: [], fixups: [], broadcast: false });
    expect((await stub.getSnapshot()).data.notes[0].zIndex).toBe(1);
  });

  it('autoSize を切り替えられる', async () => {
    const { stub, apply } = newPage();
    await apply([createNote('n1')]);
    await apply([{ type: 'note:update', noteId: 'n1', before: {}, after: { autoSize: true } }]);
    expect((await stub.getSnapshot()).data.notes[0].autoSize).toBe(true);
    const res = await apply([
      { type: 'note:update', noteId: 'n1', before: { autoSize: true }, after: { autoSize: false } },
    ]);
    expect(res).toMatchObject({ deltas: [{ before: { autoSize: true }, after: { autoSize: false } }] });
    expect((await stub.getSnapshot()).data.notes[0].autoSize).toBeUndefined();

    // after にキーがなく before にだけある形（undefined が JSON で消えた場合）でも解除できる
    await apply([{ type: 'note:update', noteId: 'n1', before: {}, after: { autoSize: true } }]);
    await apply([{ type: 'note:update', noteId: 'n1', before: { autoSize: true }, after: {} }]);
    expect((await stub.getSnapshot()).data.notes[0].autoSize).toBeUndefined();
  });

  it('foldable を保存し、切り替えられる', async () => {
    const { stub, apply } = newPage();
    await apply([createNote('n1'), createNote('n2', { foldable: true })]);
    expect((await stub.getSnapshot()).data.notes).toEqual([note('n1'), note('n2', { foldable: true })]);

    // wema は、切り替えと一緒に、計測し直した高さを送ってくる
    const res = await apply([
      { type: 'note:update', noteId: 'n1', before: { height: 150 }, after: { foldable: true, height: 88 } },
    ]);
    expect(res).toMatchObject({
      deltas: [{ before: { height: 150, foldable: false }, after: { height: 88, foldable: true } }],
    });
    expect((await stub.getSnapshot()).data.notes[0]).toMatchObject({ foldable: true, height: 88 });

    // after にキーがなく before にだけある形（undefined が JSON で消えた場合）でも解除できる
    await apply([{ type: 'note:update', noteId: 'n1', before: { foldable: true }, after: {} }]);
    expect((await stub.getSnapshot()).data.notes[0].foldable).toBeUndefined();
  });

  it('foldable の列がないページ（スキーマのバージョン 1）を移行する', async () => {
    const { stub, apply } = newPage();
    await apply([createNote('n1')]);
    // バージョン 1 のスキーマに戻して、DO を起こし直す（移行は、DO を起こしたときに走る）
    await runInDurableObject(stub, (_do, state) => {
      state.storage.sql.exec(`ALTER TABLE notes DROP COLUMN foldable`);
      state.storage.sql.exec(`UPDATE meta SET value = '1' WHERE key = 'version'`);
    });
    await evictDurableObject(stub);

    expect((await stub.getSnapshot()).data.notes).toEqual([note('n1')]);
    await apply([{ type: 'note:update', noteId: 'n1', before: {}, after: { foldable: true } }]);
    expect((await stub.getSnapshot()).data.notes[0].foldable).toBe(true);
  });

  it('text をサニタイズして保存し、送信元向けの fixup を返す', async () => {
    const { stub, apply } = newPage();
    const dirty = '<b onclick="x()">a</b><script>y</script>';
    const res = await apply([createNote('n1', { text: dirty })]);
    expect(res).toMatchObject({
      ok: true,
      deltas: [{ type: 'note:create', note: { text: '<b>a</b>' } }],
      fixups: [
        { type: 'note:update', noteId: 'n1', before: {}, after: { text: '<b>a</b>' } },
      ],
    });
    expect((await stub.getSnapshot()).data.notes[0].text).toBe('<b>a</b>');
  });

  it('text の before が現在値と違えば全体を拒否し、何も保存しない', async () => {
    const { stub, apply } = newPage();
    await apply([createNote('n1', { text: 'v1' })]);
    await apply([
      { type: 'note:update', noteId: 'n1', before: { text: 'v1' }, after: { text: 'v2' } },
    ]);
    const res = await apply([
      createNote('n2'),
      { type: 'note:update', noteId: 'n1', before: { text: 'v1' }, after: { text: 'v3' } },
    ]);
    expect(res).toEqual({
      ok: false,
      reason: 'text conflict',
      current: { notes: [note('n1', { text: 'v2' })], edges: [] },
    });
    const snap = await stub.getSnapshot();
    expect(snap.seq).toBe(2);
    expect(snap.data.notes.map((n) => n.id)).toEqual(['n1']);
  });

  it('サニタイズの規則を変える前に保存した text も編集できる', async () => {
    const { stub, apply } = newPage();
    await apply([createNote('n1')]);
    // 今の規則なら除かれる属性を持つ text が、保存済みになっている状況を作る
    const old = '<b onclick="x()">old</b>';
    await runInDurableObject(stub, (_do, state) => {
      state.storage.sql.exec(`UPDATE notes SET text = ? WHERE id = 'n1'`, old);
    });
    const res = await apply([
      { type: 'note:update', noteId: 'n1', before: { text: old }, after: { text: 'new' } },
    ]);
    expect(res).toMatchObject({ ok: true, deltas: [{ before: { text: old }, after: { text: 'new' } }] });
  });

  it('送信元がサニタイズ前の text を持ったまま続けて編集しても競合にしない', async () => {
    const { apply } = newPage();
    const dirty = '<b onclick="x()">a</b>';
    await apply([createNote('n1', { text: dirty })]);
    const res = await apply([
      { type: 'note:update', noteId: 'n1', before: { text: dirty }, after: { text: '<b>ab</b>' } },
    ]);
    expect(res).toMatchObject({ ok: true, deltas: [{ before: { text: '<b>a</b>' } }] });
  });

  it('text 以外の更新は before が違っても後勝ちで適用する', async () => {
    const { apply } = newPage();
    await apply([createNote('n1')]);
    const res = await apply([
      { type: 'note:update', noteId: 'n1', before: { x: 0 }, after: { x: 70 } },
    ]);
    expect(res).toMatchObject({ ok: true, deltas: [{ before: { x: 10 }, after: { x: 70 } }] });
  });

  it('同じ opId の再送は fixups を含めて適用済みの結果を返し、二重に適用しない', async () => {
    const { stub, apply } = newPage();
    const deltas = [createNote('n1', { text: '<b onclick="x()">a</b>' })];
    const first = await apply(deltas, 'same');
    const again = await apply(deltas, 'same');
    expect(first).toMatchObject({ ok: true, broadcast: true });
    expect(first).toMatchObject({ fixups: [{ after: { text: '<b>a</b>' } }] });
    expect(again).toEqual({ ...first, broadcast: false });
    expect((await stub.getSnapshot()).seq).toBe(1);
  });

  it('待たずに続けて送った操作も送信順に適用する', async () => {
    const { stub } = newPage();
    // 1 つ目だけサニタイズを待つ（HTML を含む）。DO の中から続けて呼び、
    // 1 つ目が待っている間に 2 つ目以降が始まる状況を作る
    const results = await runInDurableObject(stub, (instance: PageDO) => {
      const apply = (opId: string, deltas: unknown) =>
        instance.applyOps({ actor: 'user:a@example.com', clientId: 'c1', opId, deltas });
      return Promise.all([
        apply('o1', [createNote('n1', { text: '<b>a</b>' }), createNote('n2')]),
        apply('o2', [{ type: 'edge:create', edge: edge('e1', 'n1', 'n2') }]),
        apply('o3', [{ type: 'note:update', noteId: 'n1', before: {}, after: { x: 77 } }]),
      ]);
    });
    expect(results.map((r) => r.ok && r.seq)).toEqual([1, 2, 3]);
    const snap = await stub.getSnapshot();
    expect(snap.data.edges).toHaveLength(1);
    expect(snap.data.notes[0].x).toBe(77);
  });

  it('上限いっぱいの text でも、作成した後に編集と削除ができる', async () => {
    const { apply } = newPage();
    const big = (ch: string) => ch.repeat(499_000);
    expect(await apply([createNote('n1', { text: big('a') })])).toMatchObject({ ok: true });
    expect(
      await apply([
        { type: 'note:update', noteId: 'n1', before: { text: big('a') }, after: { text: big('b') } },
      ]),
    ).toMatchObject({ ok: true, seq: 2 });
    expect(await apply([{ type: 'note:delete', note: note('n1') }])).toMatchObject({ ok: true, seq: 3 });
    expect(await apply([createNote('n2', { text: 'a'.repeat(500_000) })])).toEqual({
      ok: false,
      reason: 'text too large',
    });
  });

  it('付箋を消すと残っていた接続線も消し、その削除を記録と fixup に入れる', async () => {
    const { stub, apply } = newPage();
    await apply([
      createNote('n1'),
      createNote('n2'),
      { type: 'edge:create', edge: edge('e1', 'n1', 'n2') },
    ]);
    const res = await apply([{ type: 'note:delete', note: note('n1', { text: 'stale' }) }]);
    const del = { type: 'edge:delete', edge: edge('e1', 'n1', 'n2') };
    expect(res).toEqual({
      ok: true,
      seq: 2,
      deltas: [del, { type: 'note:delete', note: note('n1') }],
      fixups: [del],
      broadcast: true,
    });
    const snap = await stub.getSnapshot();
    expect(snap.data.notes.map((n) => n.id)).toEqual(['n2']);
    expect(snap.data.edges).toEqual([]);
  });

  it('対象がすでにない更新と削除は捨てる', async () => {
    const { apply } = newPage();
    await apply([createNote('n1')]);
    const res = await apply([
      { type: 'note:update', noteId: 'gone', before: {}, after: { x: 1 } },
      { type: 'note:delete', note: note('gone') },
      { type: 'edge:update', edgeId: 'gone', before: {}, after: { label: 'x' } },
      { type: 'edge:delete', edge: edge('gone', 'n1', 'n1') },
    ]);
    expect(res).toEqual({ ok: true, seq: 1, deltas: [], fixups: [], broadcast: false });
  });

  it('接続線の更新では from / to を無視し、before にだけあるキーは未設定に戻す', async () => {
    const { stub, apply } = newPage();
    await apply([
      createNote('n1'),
      createNote('n2'),
      { type: 'edge:create', edge: edge('e1', 'n1', 'n2') },
    ]);
    await apply([
      { type: 'edge:update', edgeId: 'e1', before: {}, after: { collapsed: true, from: 'n2', label: 'L' } },
    ]);
    expect((await stub.getSnapshot()).data.edges).toEqual([
      edge('e1', 'n1', 'n2', { collapsed: true, label: 'L' }),
    ]);

    const res = await apply([
      { type: 'edge:update', edgeId: 'e1', before: { collapsed: true }, after: {} },
    ]);
    expect(res).toMatchObject({
      ok: true,
      deltas: [{ type: 'edge:update', edgeId: 'e1', before: { collapsed: true }, after: {} }],
    });
    expect((await stub.getSnapshot()).data.edges).toEqual([edge('e1', 'n1', 'n2', { label: 'L' })]);
  });

  it.each([
    ['id が使用済みの付箋の作成', [createNote('n1')], 'note already exists: n1'],
    ['両端がない接続線の作成', [{ type: 'edge:create', edge: edge('e9', 'n1', 'nx') }], 'edge endpoint not found: e9'],
    ['数値でない座標', [createNote('n2', { x: '1' })], 'invalid x'],
    ['必須フィールドの欠落', [{ type: 'note:create', note: { id: 'n2' } }], 'note.x is required'],
    ['不正な id', [createNote('a b')], 'invalid note id'],
    ['不正な色', [createNote('n2', { color: 'red;background:url(x)' })], 'invalid color'],
    ['未知の種類', [{ type: 'note:move' }], 'unknown delta type'],
    ['空の配列', [], 'invalid deltas'],
    ['配列でない', { type: 'note:create' }, 'invalid deltas'],
  ])('%s は拒否する', async (_name, deltas, reason) => {
    const { stub, apply } = newPage();
    await apply([createNote('n1')]);
    expect(await apply(deltas)).toEqual({ ok: false, reason });
    expect((await stub.getSnapshot()).seq).toBe(1);
  });

  it('text の合計が記録できる大きさを超える操作は、サニタイズの前に拒否する', async () => {
    const { stub, apply } = newPage();
    const text = '<b>a</b>'.repeat(60_000); // 480KB
    const deltas = ['n1', 'n2', 'n3', 'n4'].map((id) => createNote(id, { text }));
    expect(await apply(deltas)).toEqual({ ok: false, reason: 'operation too large' });
    expect((await stub.getSnapshot()).seq).toBe(0);
  });

  it('作成者と操作を記録する', async () => {
    const { stub, apply } = newPage();
    await apply([createNote('n1')], 'op-a', 'agent:claude');
    const rows = await runInDurableObject(stub, (_do, state) => ({
      note: state.storage.sql.exec(`SELECT created_by, updated_by FROM notes`).one(),
      op: state.storage.sql.exec(`SELECT seq, actor, client_id, op_id FROM ops`).one(),
    }));
    expect(rows).toEqual({
      note: { created_by: 'agent:claude', updated_by: 'agent:claude' },
      op: { seq: 1, actor: 'agent:claude', client_id: 'c1', op_id: 'op-a' },
    });
  });
});
