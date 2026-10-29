import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createExecutionContext, env, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { HistoryDelta } from '../src/shared/delta';
import { TOOLS, ToolError, toolAnnotations } from '../src/shared/tools';
import { ServerBoardAccess } from '../src/worker/mcp/board-access';
import { readOnlyAccess } from '../src/worker/mcp/server';
import { createApp } from '../src/worker/index';
import { createNote, edge } from './helpers';

const app = createApp();

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
    const listed = pages.find((p: any) => p.name === page);
    expect(listed).toMatchObject({ title: 'MCP のテスト', note_count: 1 });
    // 更新日時は ISO 8601 の文字列で返し、同じ書式で絞り込める
    expect(listed.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const before = new Date(Date.parse(listed.updated_at) - 1000).toISOString();
    const after = new Date(Date.parse(listed.updated_at) + 1000).toISOString();
    const names = async (updated_after: string) =>
      (await call('list_pages', { limit: 500, updated_after })).map((p: any) => p.name);
    expect(await names(before)).toContain(page);
    expect(await names(after)).not.toContain(page);
    // 日付だけでも受ける。ISO 8601 でない書式と、数値は断る
    expect(await names(before.slice(0, 10))).toContain(page);
    await expect(call('list_pages', { updated_after: 'yesterday' })).rejects.toThrow();
    await expect(call('list_pages', { updated_after: Date.now() })).rejects.toThrow();
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

  it('ページへのリンクを [[slug]] で書け、read_board で同じ書式で読める', async () => {
    const { page, notesOf } = await newPage([createNote('n1', { text: '<a href="/p/design">設計メモ</a>' })]);
    await call('add_notes', { page, notes: [{ text: '関連: [[design]]' }] });
    expect((await notesOf()).map((n) => n.text)).toContain('関連: <a href="/p/design">design</a>');
    const board = await call('read_board', { page });
    expect(board.notes.map((n: any) => n.text)).toEqual(['設計メモ [[design]]', '関連: [[design]]']);
  });

  it('add_notes は、大きさを指定でき、省略すると高さを本文の量と幅から決める', async () => {
    const { page, notesOf } = await newPage([]);
    const long = 'あ'.repeat(260);
    await call('add_notes', {
      page,
      notes: [
        { text: '短い' },
        { text: long },
        { text: long, width: 400 },
        { text: '指定', width: 320, height: 90 },
      ],
    });
    const [short, tall, wide, fixed] = await notesOf();
    expect(short).toMatchObject({ width: 200, height: 150 });
    expect(tall!.width).toBe(200);
    expect(tall!.height).toBeGreaterThan(150);
    // 幅を広げると、同じ本文でも低くなる
    expect(wide!.width).toBe(400);
    expect(wide!.height).toBeLessThan(tall!.height);
    expect(fixed).toMatchObject({ width: 320, height: 90 });
    await expect(call('add_notes', { page, notes: [{ text: 'x', width: 5 }] })).rejects.toThrow();
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

describe('ツールの注釈', () => {
  /** ページの今の状態（操作の番号を含む）。操作が記録されれば seq が変わる */
  const snapshot = (page: string) => env.PAGE.getByName(page).getSnapshot();

  /** 同じ引数で 2 回呼び、2 回目で、関係するページが変わらないことを確かめる（断られてもよい） */
  async function expectIdempotent(name: string, input: unknown, pages: string[]) {
    await call(name, input);
    const before = await Promise.all(pages.map(snapshot));
    await call(name, input).catch((e) => expect(e, name).toBeInstanceOf(ToolError));
    expect(await Promise.all(pages.map(snapshot)), name).toEqual(before);
  }

  it('冪等と申告したツールは、2 回目でボードを変えない', async () => {
    const notes = [createNote('n1'), createNote('n2', { x: 400 }), { type: 'edge:create', edge: edge('e1', 'n1', 'n2') }];
    const a = await newPage(notes);
    // move_page の移す先
    const b = await newPage();
    const checked = new Set<string>();
    const check = async (name: string, input: unknown, pages: string[]) => {
      await expectIdempotent(name, input, pages);
      checked.add(name);
    };

    // 保存するときのサニタイズで本文が変わると、2 回目も「変更あり」になる。変わりやすい文字を入れておく
    const text = '<b>太字</b> & "引用" \'単\' <script>x</script>\n\n  行頭の空白\r\n末尾 ';
    await check('update_notes', { page: a.page, notes: [{ id: 'n1', text, x: 50 }] }, [a.page]);
    await check('disconnect_notes', { page: a.page, edge_ids: ['e1'] }, [a.page]);
    await check('delete_notes', { page: a.page, note_ids: ['n1'] }, [a.page]);
    const child = `mcp-${++pageCount}`;
    await check('create_page', { name: child, parent: a.page }, [a.page, child]);
    await check('move_page', { name: child, parent: b.page }, [a.page, b.page, child]);

    // 冪等と申告したツールは、すべて確かめた
    const idempotent = TOOLS.filter((t) => !t.readOnly && t.idempotent).map((t) => t.name);
    expect([...checked].sort()).toEqual(idempotent.sort());
  });
});

/** MCP のクライアントで `/mcp` につなぐ。主体は、ローカル開発の `agent:local` */
async function connect(target = app) {
  const ctx = createExecutionContext();
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
    // テストではネットワークを通さず、Worker の入口を直接呼ぶ（ローカル開発の認証を通る）。
    // Host は実際のリクエストなら必ず付く
    fetch: async (input, init) => {
      const request = new Request(input as string, init as RequestInit);
      request.headers.set('Host', 'localhost');
      return target.fetch(request, env, ctx);
    },
  });
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

const READ_TOOLS = TOOLS.filter((t) => t.readOnly).map((t) => t.name).sort();
const WRITE_TOOLS = TOOLS.filter((t) => !t.readOnly).map((t) => t.name);

describe('MCP のハンドラ', () => {
  it('MCP のクライアントから、ツールの一覧を取得して呼び出せる', async () => {
    const { page, notesOf } = await newPage([createNote('n1')]);
    const client = await connect();

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS.map((t) => t.name).sort());
    // 注釈は、省くとクライアントが「破壊的、冪等でない、外とやり取りする」で扱うので、すべて返す
    const annotations = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    for (const t of TOOLS) expect(annotations[t.name], t.name).toEqual(toolAnnotations(t));
    expect(annotations.read_board).toEqual({ readOnlyHint: true, idempotentHint: true, openWorldHint: false });
    // 付箋を足すだけのツールは、破壊的な操作として申告しない
    expect(annotations.add_notes).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
    expect(annotations.delete_notes).toEqual({
      readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false,
    });

    const added = await client.callTool({
      name: 'add_notes',
      arguments: { page, notes: [{ text: 'MCP 経由' }], reason: 'e2e' },
    });
    expect(added.isError).toBeFalsy();
    expect((await notesOf()).map((n) => n.text)).toContain('MCP 経由');
    const board = await env.PAGE.getByName(page).getBoardState();
    expect(board?.notes.find((n) => n.text === 'MCP 経由')?.createdBy).toBe('agent:local');

    // ツールが断った場合は、エラーの結果として返る
    const failed = await client.callTool({ name: 'read_board', arguments: { page: 'mcp-no-such-page' } });
    expect(failed.isError).toBe(true);
    expect(failed.content).toEqual([{ type: 'text', text: 'page not found: mcp-no-such-page' }]);
    await client.close();
  });

  it('読み取りだけのクライアントには、書き込みのツールを出さず、呼ばれても書き込まない', async () => {
    const { page, notesOf } = await newPage([createNote('n1')]);
    // どのクライアントも読み取りだけ、と、書き込めるクライアントに当たらない、の 2 通り
    for (const mcp of [{ write: false }, { write: ['claude.ai', 'localhost'] }]) {
      const client = await connect(createApp({ mcp }));
      expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(READ_TOOLS);
      expect(WRITE_TOOLS.length).toBeGreaterThan(0);
      for (const name of WRITE_TOOLS) {
        // 登録していないツールは、MCP のサーバーが「ツールがない」で断る（入力の検証の失敗と区別する）
        await expect(
          client.callTool({ name, arguments: { page, notes: [{ text: '書けてはいけない' }], reason: 'ro' } }),
          name,
        ).rejects.toThrow(`Tool ${name} not found`);
      }
      expect((await notesOf()).map((n) => n.id)).toEqual(['n1']);
      // 読み取りのツールは使える
      const read = await client.callTool({ name: 'read_board', arguments: { page } });
      expect(read.isError).toBeFalsy();
      await client.close();
    }
  });

  it('読み取りだけの主体に渡す BoardAccess は、書き込みのツールを直接呼んでも断る', async () => {
    const { page, notesOf } = await newPage([createNote('n1')]);
    const access = readOnlyAccess(new ServerBoardAccess(env, AGENT));
    const run = (name: string, input: unknown) => {
      const tool = TOOLS.find((t) => t.name === name)!;
      return tool.run(access, tool.input.parse(input));
    };
    await expect(run('add_notes', { page, notes: [{ text: 'x' }] })).rejects.toThrow('this client can only read');
    await expect(run('delete_notes', { page, note_ids: ['n1'] })).rejects.toThrow('this client can only read');
    await expect(run('create_page', { name: `mcp-ro-${++pageCount}` })).rejects.toThrow('this client can only read');
    expect((await notesOf()).map((n) => n.id)).toEqual(['n1']);
    expect(((await run('read_board', { page })) as { notes: unknown[] }).notes).toHaveLength(1);
  });

  it('書き込めるクライアントに並べた主体は、すべてのツールを使える', async () => {
    const { page, notesOf } = await newPage();
    const client = await connect(createApp({ mcp: { write: ['local'] } }));
    expect((await client.listTools()).tools).toHaveLength(TOOLS.length);
    const added = await client.callTool({ name: 'add_notes', arguments: { page, notes: [{ text: '書ける' }], reason: 'rw' } });
    expect(added.isError).toBeFalsy();
    expect((await notesOf()).map((n) => n.text)).toContain('書ける');
    await client.close();
  });
});
