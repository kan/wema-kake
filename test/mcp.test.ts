import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createExecutionContext, env, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { HistoryDelta } from '../src/shared/delta';
import { TOOLS, ToolError } from '../src/shared/tools';
import { ServerBoardAccess } from '../src/worker/mcp/board-access';
import { actorFromProps, mcpHandler } from '../src/worker/mcp/server';
import { createNote, edge } from './helpers';

const AGENT = 'agent:claude';
let pageCount = 0;
let opCount = 0;

/** ツールを、MCP を通さずに直接呼ぶ（入力の検証は通す） */
async function call(name: string, input: unknown, actor = AGENT): Promise<any> {
  const tool = TOOLS.find((t) => t.name === name)!;
  return tool.run(new ServerBoardAccess(env, actor), tool.input.parse(input));
}

/** 人が作ったページ。付箋を置いて返す */
async function newPage(notes: Record<string, unknown>[] = []) {
  const page = `mcp-${++pageCount}`;
  const stub = env.PAGE.getByName(page);
  await stub.createPage('MCP のテスト');
  if (notes.length > 0) {
    const res = await stub.applyOps({ actor: 'user:a', clientId: 'c1', opId: `op${++opCount}`, deltas: notes });
    expect(res.ok).toBe(true);
  }
  const notesOf = async () => (await stub.getSnapshot()).data.notes;
  const edgesOf = async () => (await stub.getSnapshot()).data.edges;
  return { page, stub, notesOf, edgesOf };
}

describe('読み取りのツール', () => {
  it('read_board は、付箋の本文をプレーンテキストにし、作成者を付けて返す', async () => {
    const { page } = await newPage([
      createNote('n1', { text: '<b>太字</b>と<br>改行 &amp; 記号' }),
      createNote('n2'),
      { type: 'edge:create', edge: edge('e1', 'n1', 'n2', { label: '関連' }) },
    ]);
    const board = await call('read_board', { page });
    expect(board.title).toBe('MCP のテスト');
    expect(board.notes[0]).toEqual({
      id: 'n1', text: '太字と\n改行 & 記号', x: 10, y: 20, width: 200, height: 150,
      color: '#FFF9C4', created_by: 'user:a',
    });
    expect(board.edges).toEqual([{ id: 'e1', from: 'n1', to: 'n2', label: '関連' }]);
  });

  it('list_pages と search_pages は、索引から返す', async () => {
    const { page, stub } = await newPage([createNote('n1', { text: 'MCP からしか探せない語 絵馬掛所' })]);
    await runDurableObjectAlarm(stub);
    const pages = await call('list_pages', { limit: 500 });
    expect(pages.find((p: any) => p.name === page)).toMatchObject({ title: 'MCP のテスト', note_count: 1 });
    const hits = await call('search_pages', { query: '絵馬掛所' });
    expect(hits.map((h: any) => h.name)).toContain(page);
  });

  it('存在しないページと不正なスラッグは断る', async () => {
    await expect(call('read_board', { page: 'mcp-no-such-page' })).rejects.toThrow(ToolError);
    await expect(call('read_board', { page: 'Bad_Slug' })).rejects.toThrow();
  });
});

describe('書き込みのツール', () => {
  it('add_notes は、プレーンテキストを付箋にし、agent の操作として 1 つにまとめて記録する', async () => {
    const { page, stub, notesOf, edgesOf } = await newPage([createNote('n1')]);
    const res = await call('add_notes', {
      page,
      notes: [
        { text: '助言です\n- 一つ目\n- 二つ目', connect_from: 'n1' },
        { text: '<b>HTML は書けない</b>', color: '#C8E6C9' },
      ],
      reason: '助言を追加',
    });
    expect(res.note_ids).toHaveLength(2);

    const notes = await notesOf();
    const [first, second] = res.note_ids.map((id: string) => notes.find((n) => n.id === id)!);
    expect(first.text).toBe('助言です<ul><li>一つ目</li><li>二つ目</li></ul>');
    expect(second.text).toBe('&lt;b&gt;HTML は書けない&lt;/b&gt;');
    expect(second.color).toBe('#C8E6C9');
    expect(await edgesOf()).toMatchObject([{ from: 'n1', to: first.id }]);

    const ops = await stub.listOps({ agentOnly: true });
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ seq: res.operation, actor: AGENT, summary: 'add_notes: 助言を追加' });
    const board = await stub.getBoardState();
    expect(board?.notes.find((n) => n.id === first.id)?.createdBy).toBe(AGENT);
  });

  it('add_notes は、位置を省略すると既存の付箋と重ならないように置く', async () => {
    const { page, notesOf } = await newPage([createNote('n1', { x: 40, y: 40 })]);
    await call('add_notes', {
      page,
      notes: [{ text: 'a', near: 'n1' }, { text: 'b', near: 'n1' }, { text: 'c' }, { text: 'd', x: 900, y: 900 }],
    });
    const notes = await notesOf();
    const overlap = notes.some((p) =>
      notes.some(
        (q) => p !== q && p.x < q.x + q.width && q.x < p.x + p.width && p.y < q.y + q.height && q.y < p.y + p.height,
      ),
    );
    expect(overlap).toBe(false);
    // near を指定した付箋は、その右に置く
    expect(notes.find((n) => n.text === 'a')!.x).toBeGreaterThan(40 + 200);
    expect(notes.find((n) => n.text === 'd')).toMatchObject({ x: 900, y: 900 });
  });

  it('update_notes は、指定した項目だけを変える', async () => {
    const { page, notesOf } = await newPage([createNote('n1', { text: '元の本文' })]);
    await call('update_notes', { page, notes: [{ id: 'n1', text: '新しい本文', color: '#BBDEFB', x: 300 }] });
    expect((await notesOf())[0]).toMatchObject({ text: '新しい本文', color: '#BBDEFB', x: 300, y: 20 });
  });

  it('delete_notes は、つながる接続線ごと消す', async () => {
    const { page, notesOf, edgesOf } = await newPage([
      createNote('n1'), createNote('n2'),
      { type: 'edge:create', edge: edge('e1', 'n1', 'n2') },
    ]);
    await call('delete_notes', { page, note_ids: ['n1'] });
    expect((await notesOf()).map((n) => n.id)).toEqual(['n2']);
    expect(await edgesOf()).toEqual([]);
  });

  it('connect_notes と disconnect_notes', async () => {
    const { page, edgesOf } = await newPage([createNote('n1'), createNote('n2')]);
    const res = await call('connect_notes', { page, connections: [{ from: 'n1', to: 'n2', label: '原因' }] });
    expect(await edgesOf()).toMatchObject([{ id: res.edge_ids[0], from: 'n1', to: 'n2', label: '原因' }]);
    await call('disconnect_notes', { page, edge_ids: res.edge_ids });
    expect(await edgesOf()).toEqual([]);
  });

  it('auto_layout は、接続線のつながりで付箋を並べ直す', async () => {
    const { page, notesOf } = await newPage([
      createNote('n1', { x: 500, y: 500 }), createNote('n2', { x: 500, y: 500 }),
      { type: 'edge:create', edge: edge('e1', 'n1', 'n2') },
    ]);
    const res = await call('auto_layout', { page });
    // 配置後の左上は、付箋が今占めている範囲の左上に合う（wema 0.8.0 以降）。重なっていた 2 枚の
    // うち、起点の n1 はその場に残り、n2 だけが下の段へ動く
    expect(res.moved).toBe(1);
    const at = Object.fromEntries((await notesOf()).map((n) => [n.id, n]));
    expect(at.n1).toMatchObject({ x: 500, y: 500 });
    expect(at.n2.y).toBeGreaterThanOrEqual(at.n1.y + at.n1.height);
  });

  it('存在しない付箋や、ページのないスラッグへの書き込みは断り、ページを作らない', async () => {
    const { page } = await newPage([createNote('n1')]);
    await expect(call('update_notes', { page, notes: [{ id: 'nope', x: 1 }] })).rejects.toThrow('note not found: nope');
    await expect(call('add_notes', { page: 'mcp-not-created', notes: [{ text: 'x' }] })).rejects.toThrow(
      'page not found: mcp-not-created',
    );
    expect((await env.PAGE.getByName('mcp-not-created').getSnapshot()).epoch).toBeNull();
  });

  it('何も変わらない操作は、他の操作の番号を返さずに断る', async () => {
    const { page, stub } = await newPage([createNote('n1')]);
    await expect(call('update_notes', { page, notes: [{ id: 'n1', x: 10 }] })).rejects.toThrow('nothing changed');
    expect(await stub.listOps({ agentOnly: true })).toEqual([]);
  });

  it('同じ id の重複と、x と y の片方だけの指定は断る', async () => {
    const { page } = await newPage([createNote('n1', { text: '元' })]);
    await expect(
      call('update_notes', { page, notes: [{ id: 'n1', text: 'a' }, { id: 'n1', text: 'b' }] }),
    ).rejects.toThrow('duplicate id: n1');
    await expect(call('delete_notes', { page, note_ids: ['n1', 'n1'] })).rejects.toThrow('duplicate id: n1');
    await expect(call('add_notes', { page, notes: [{ text: 'x だけ', x: 800 }] })).rejects.toThrow(
      'x and y must be given together',
    );
  });

  it('読んだ後に削除されたページには適用せず、作り直さない', async () => {
    const { page, stub } = await newPage([createNote('n1')]);
    await stub.deletePage();
    const outcome = await new ServerBoardAccess(env, AGENT).apply(page, [createNote('n2') as HistoryDelta], 'late');
    expect(outcome).toEqual({ ok: false, reason: 'page not found' });
    expect(await stub.getBoardState()).toBeNull();
  });

  it('人がその後に編集した付箋の本文は、古い内容を元にした更新では上書きできない', async () => {
    const { page, stub } = await newPage([createNote('n1', { text: 'v1' })]);
    // agent が読んだ後に、人が編集する。update_notes は読み直すので通る。古い before を直接渡す形を確かめる
    const access = new ServerBoardAccess(env, AGENT);
    await stub.applyOps({
      actor: 'user:a', clientId: 'c1', opId: 'human-edit',
      deltas: [{ type: 'note:update', noteId: 'n1', before: { text: 'v1' }, after: { text: 'v2' } }],
    });
    const stale = await access.apply(
      page,
      [{ type: 'note:update', noteId: 'n1', before: { text: 'v1' }, after: { text: 'agent' } }],
      'stale',
    );
    expect(stale).toEqual({ ok: false, reason: 'text conflict' });
  });
});

describe('revert_operation', () => {
  it('直前の自分の操作を取り消す。人の操作と、他の agent の操作は取り消せない', async () => {
    const { page, stub, notesOf } = await newPage([createNote('n1')]);
    const added = await call('add_notes', { page, notes: [{ text: '1 回目' }] });
    const moved = await call('update_notes', { page, notes: [{ id: 'n1', x: 400 }] });

    const res = await call('revert_operation', { page, reason: 'やり直す' });
    expect(res).toMatchObject({ reverted: moved.operation, applied: 1, skipped: [] });
    expect((await notesOf()).find((n) => n.id === 'n1')!.x).toBe(10);

    // もう一度呼ぶと、その前の操作が対象になる（取り消しそのものは対象にしない）
    expect(await call('revert_operation', { page })).toMatchObject({ reverted: added.operation });
    expect(await notesOf()).toHaveLength(1);
    await expect(call('revert_operation', { page })).rejects.toThrow('no operation to revert');

    // 人の操作（seq 1）と、他の agent の操作は指定しても取り消せない
    await expect(call('revert_operation', { page, operation: 1 })).rejects.toThrow('not your operation');
    const other = await call('add_notes', { page, notes: [{ text: '他の agent' }] }, 'agent:chatgpt');
    await expect(call('revert_operation', { page, operation: other.operation })).rejects.toThrow('not your operation');
    expect((await stub.listOps({ actor: AGENT })).every((op) => op.actor === AGENT)).toBe(true);
  });

  it('人がその後に変更した付箋は戻さず、skipped で返す', async () => {
    const { page, stub } = await newPage([createNote('n1'), createNote('n2')]);
    const moved = await call('update_notes', { page, notes: [{ id: 'n1', x: 400 }, { id: 'n2', x: 400 }] });
    await stub.applyOps({
      actor: 'user:a', clientId: 'c1', opId: 'human-move',
      deltas: [{ type: 'note:update', noteId: 'n2', before: {}, after: { x: 777 } }],
    });
    expect(await call('revert_operation', { page, operation: moved.operation })).toMatchObject({
      applied: 1,
      skipped: [{ target: 'note', id: 'n2', reason: 'modified' }],
    });
  });

  it('何も戻せなかったときは、それより前の自分の操作の番号を返す', async () => {
    const { page, stub } = await newPage([createNote('n1')]);
    const first = await call('update_notes', { page, notes: [{ id: 'n1', y: 300 }] });
    await call('update_notes', { page, notes: [{ id: 'n1', x: 400 }] });
    await stub.applyOps({
      actor: 'user:a', clientId: 'c1', opId: 'human-move-x',
      deltas: [{ type: 'note:update', noteId: 'n1', before: {}, after: { x: 777 } }],
    });
    // 省略のまま呼び直しても同じ操作が選ばれるので、前の操作の番号を知らせる
    expect(await call('revert_operation', { page })).toMatchObject({
      applied: 0, operation: null, earlier_operations: [first.operation],
    });
    expect(await call('revert_operation', { page, operation: first.operation })).toMatchObject({ applied: 1 });
  });
});

describe('MCP のハンドラ', () => {
  it('認証結果から、変更の主体を決める', () => {
    expect(actorFromProps({ client: 'Claude' })).toBe('agent:claude');
    expect(actorFromProps({ client: 'My Client / 日本語' })).toBe('agent:my-client');
    expect(actorFromProps({})).toBe('agent:unknown');
    expect(actorFromProps(undefined)).toBe('agent:unknown');
  });

  it('MCP のクライアントから、ツールの一覧を取得して呼び出せる', async () => {
    const { page, notesOf } = await newPage([createNote('n1')]);
    const ctx = Object.assign(createExecutionContext(), { props: { client: 'Claude' } });
    const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
      // テストではネットワークを通さず、ハンドラを直接呼ぶ。Host は実際のリクエストなら必ず付く
      fetch: async (input, init) => {
        const request = new Request(input as string, init as RequestInit);
        request.headers.set('Host', 'localhost');
        return mcpHandler.fetch(request, env, ctx);
      },
    });
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(transport);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS.map((t) => t.name).sort());
    expect(tools.find((t) => t.name === 'read_board')?.annotations?.readOnlyHint).toBe(true);

    const added = await client.callTool({
      name: 'add_notes',
      arguments: { page, notes: [{ text: 'MCP 経由' }], reason: 'e2e' },
    });
    expect(added.isError).toBeFalsy();
    expect((await notesOf()).map((n) => n.text)).toContain('MCP 経由');
    const board = await env.PAGE.getByName(page).getBoardState();
    expect(board?.notes.find((n) => n.text === 'MCP 経由')?.createdBy).toBe('agent:claude');

    // ツールが断った場合は、エラーの結果として返る
    const failed = await client.callTool({ name: 'read_board', arguments: { page: 'mcp-no-such-page' } });
    expect(failed.isError).toBe(true);
    expect(failed.content).toEqual([{ type: 'text', text: 'page not found: mcp-no-such-page' }]);
    await client.close();
  });
});
