import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { api, createNote, join, note } from './helpers';

let opCount = 0;

/** ページに付箋を作り、D1 への反映（alarm）まで済ませる */
async function seed(slug: string, texts: string[], title?: string) {
  const stub = env.PAGE.getByName(slug);
  if (title !== undefined) await stub.setTitle(title);
  if (texts.length > 0) {
    const deltas = texts.map((text, i) => createNote(`n${i}`, { text }));
    const res = await stub.applyOps({ actor: 'user:a', clientId: 'c1', opId: `op${++opCount}`, deltas });
    expect(res.ok).toBe(true);
  }
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  return stub;
}

const names = async (res: Response) =>
  ((await res.json()) as { pages: { name: string }[] }).pages.map((p) => p.name);

describe('D1 への反映', () => {
  it('変更の後に alarm が設定され、実行するとページの索引ができる', async () => {
    await seed('idx-basic', ['<div>付箋ボードの<b>メモ</b></div><div>2 行目</div>', 'もう 1 枚'], '絵馬掛の設計');
    const row = await env.DB.prepare(`SELECT * FROM pages WHERE name = ?`).bind('idx-basic').first();
    expect(row).toMatchObject({
      name: 'idx-basic',
      title: '絵馬掛の設計',
      plain_text: '付箋ボードのメモ\n2 行目\nもう 1 枚',
      note_count: 2,
    });
    expect(row!.updated_at).toBeGreaterThan(0);
  });

  it('変更がなければ alarm は設定されない', async () => {
    const stub = env.PAGE.getByName('idx-untouched');
    await stub.getSnapshot();
    expect(await runDurableObjectAlarm(stub)).toBe(false);
    expect(await env.DB.prepare(`SELECT 1 FROM pages WHERE name = ?`).bind('idx-untouched').first()).toBeNull();
  });

  it('再反映すると、索引は入れ替わる（重複しない）', async () => {
    const stub = await seed('idx-replace', ['最初の内容です <a href="/p/idx-target-a">a</a>']);
    await stub.applyOps({
      actor: 'user:a', clientId: 'c1', opId: 'replace',
      deltas: [{
        type: 'note:update', noteId: 'n0',
        before: { text: '最初の内容です <a href="/p/idx-target-a">a</a>' },
        after: { text: '書き換えた内容です <a href="/p/idx-target-b">b</a>' },
      }],
    });
    await runDurableObjectAlarm(stub);

    const links = await env.DB.prepare(`SELECT to_page FROM links WHERE from_page = ?`).bind('idx-replace').all();
    expect(links.results).toEqual([{ to_page: 'idx-target-b' }]);
    const fts = await env.DB.prepare(
      `SELECT f.plain_text FROM pages_fts f JOIN pages p ON p.id = f.rowid WHERE p.name = ?`,
    ).bind('idx-replace').all();
    expect(fts.results).toEqual([{ plain_text: '書き換えた内容です b' }]);
    expect(await env.DB.prepare(`SELECT count(*) AS c FROM pages_fts WHERE plain_text LIKE '%最初の内容%'`).first())
      .toEqual({ c: 0 });
  });

  it('検索とリンクに関わる内容が変わっていなければ、付箋の数と更新日時だけを書く', async () => {
    const stub = await seed('idx-unchanged', ['動かすだけの付箋']);
    // 全文検索の行が書き直されたかを見分けるための印
    await env.DB.prepare(
      `UPDATE pages_fts SET title = '印' WHERE rowid = (SELECT id FROM pages WHERE name = 'idx-unchanged')`,
    ).run();
    await env.DB.prepare(`UPDATE pages SET updated_at = 1 WHERE name = 'idx-unchanged'`).run();

    await stub.applyOps({
      actor: 'user:a', clientId: 'c1', opId: 'move',
      deltas: [{ type: 'note:update', noteId: 'n0', before: {}, after: { x: 500 } }, createNote('n-empty', { text: '' })],
    });
    await runDurableObjectAlarm(stub);

    const page = await env.DB.prepare(`SELECT id, note_count, updated_at FROM pages WHERE name = 'idx-unchanged'`).first();
    expect(page).toMatchObject({ note_count: 2 });
    expect(page!.updated_at).toBeGreaterThan(1);
    expect(await env.DB.prepare(`SELECT title FROM pages_fts WHERE rowid = ?`).bind(page!.id).first())
      .toEqual({ title: '印' });
  });

  it('内容が変わっていなくても、D1 にページの行がなければ作り直す', async () => {
    const stub = await seed('idx-lost', ['索引を失ったページ']);
    await env.DB.prepare(`DELETE FROM pages WHERE name = 'idx-lost'`).run();
    await stub.applyOps({
      actor: 'user:a', clientId: 'c1', opId: 'move',
      deltas: [{ type: 'note:update', noteId: 'n0', before: {}, after: { x: 500 } }],
    });
    await runDurableObjectAlarm(stub);
    expect(await env.DB.prepare(`SELECT plain_text FROM pages WHERE name = 'idx-lost'`).first())
      .toEqual({ plain_text: '索引を失ったページ' });
  });

  it('付箋内のリンクからページ間リンクを作る。自分自身と外部へのリンクは含めない', async () => {
    await seed('idx-links', [
      '<a href="/p/idx-dest-1">1</a> <a href="/p/idx-dest-1">重複</a> <a href="/p/idx-links">自分</a>',
      '<a href="https://example.com/p/idx-dest-2">外部</a> <a href="/p/idx-dest-3?x=1">3</a>',
    ]);
    const { results } = await env.DB.prepare(
      `SELECT to_page FROM links WHERE from_page = ? ORDER BY to_page`,
    ).bind('idx-links').all();
    expect(results).toEqual([{ to_page: 'idx-dest-1' }, { to_page: 'idx-dest-3' }]);
  });

  it('保持期間と件数の両方を過ぎた ops だけを消す', async () => {
    const stub = await seed('idx-prune', ['a']);
    await runInDurableObject(stub, (_do, state) => {
      const sql = state.storage.sql;
      const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
      // seq 1 は古い。さらに 1001 件ぶん seq を進め、古い ops と新しい ops を混ぜる
      sql.exec(`UPDATE ops SET created_at = ? WHERE seq = 1`, old);
      sql.exec(
        `INSERT INTO ops (seq, actor, client_id, op_id, body, created_at) VALUES
           (2, 'user:a', 'c1', 'old-but-recent-seq', '[]', ?), (1002, 'user:a', 'c1', 'new', '[]', ?)`,
        old, Date.now(),
      );
      sql.exec(`UPDATE meta SET value = '1002' WHERE key = 'seq'`);
    });
    await stub.setTitle('再反映させる');
    await runDurableObjectAlarm(stub);
    const seqs = await runInDurableObject(stub, (_do, state) =>
      state.storage.sql.exec(`SELECT seq FROM ops ORDER BY seq`).toArray().map((r) => r.seq),
    );
    // 残り 1000 件（seq 3〜1002）に入らず、30 日も過ぎている seq 1 と 2 が消える
    expect(seqs).toEqual([1002]);
  });
});

describe('ページの API', () => {
  it('一覧を更新の新しい順に返し、updated_after で絞れる', async () => {
    await seed('list-a', ['a']);
    const first = (await env.DB.prepare(`SELECT updated_at FROM pages WHERE name = 'list-a'`).first())!;
    await env.DB.prepare(`UPDATE pages SET updated_at = updated_at - 1000 WHERE name = 'list-a'`).run();
    await seed('list-b', ['b'], 'B のページ');

    const all = await api('/api/pages');
    const pages = ((await all.json()) as { pages: Record<string, unknown>[] }).pages;
    const listed = pages.filter((p) => String(p.name).startsWith('list-'));
    expect(listed.map((p) => p.name)).toEqual(['list-b', 'list-a']);
    expect(listed[0]).toMatchObject({ name: 'list-b', title: 'B のページ', note_count: 1 });

    const after = await names(await api(`/api/pages?updated_after=${(first.updated_at as number) - 1}`));
    expect(after).toContain('list-b');
    expect(after).not.toContain('list-a');

    // 小数や数値でない limit でもエラーにしない
    expect(await names(await api('/api/pages?limit=1.5'))).toHaveLength(1);
    expect((await api('/api/pages?limit=abc')).status).toBe(200);
  });

  it('3 文字以上は全文検索、3 文字未満は部分一致で探す', async () => {
    await seed('search-a', ['神社の境内にある絵馬掛所のメモ']);
    await seed('search-b', ['別の話題'], '境内の整理');

    const fts = await api(`/api/search?q=${encodeURIComponent('絵馬掛所')}`);
    const hits = ((await fts.json()) as { pages: Record<string, unknown>[] }).pages;
    expect(hits.map((p) => p.name)).toEqual(['search-a']);
    expect(hits[0].snippet).toContain('絵馬掛所');

    const short = await names(await api(`/api/search?q=${encodeURIComponent('境内')}`));
    expect(short).toEqual(expect.arrayContaining(['search-a', 'search-b']));
  });

  it('検索語の記号を演算子やワイルドカードとして解釈しない', async () => {
    await seed('search-sym', ['100% の "引用" と a_b を含む OR NOT']);
    const q = async (s: string) => names(await api(`/api/search?q=${encodeURIComponent(s)}`));
    expect(await q('"引用"')).toContain('search-sym');
    expect(await q('含む OR NOT')).toContain('search-sym');
    expect(await q('0%')).toContain('search-sym');
    expect(await q('%')).toContain('search-sym');
    // % と _ がワイルドカードなら一致してしまう検索語
    expect(await q('a%b')).not.toContain('search-sym');
    expect(await q('x_')).not.toContain('search-sym');
    expect((await api('/api/search?q=')).status).toBe(400);
  });

  it('バックリンクを返す', async () => {
    await seed('back-from-1', ['<a href="/p/back-to">t</a>'], 'リンク元 1');
    await seed('back-from-2', ['<a href="/p/back-to">t</a>']);
    await seed('back-other', ['<a href="/p/elsewhere">t</a>']);
    const res = await api('/api/pages/back-to/backlinks');
    const pages = ((await res.json()) as { pages: Record<string, unknown>[] }).pages;
    expect(pages).toEqual(
      expect.arrayContaining([
        { name: 'back-from-1', title: 'リンク元 1' },
        { name: 'back-from-2', title: null },
      ]),
    );
    expect(pages).toHaveLength(2);
  });

  it('表示名を変えるとスナップショットと索引に反映され、接続中のブラウザに届く', async () => {
    const slug = 'title-page';
    const browser = await join(slug, 'c1');

    const put = (title: unknown) =>
      api(`/api/pages/${slug}/title`, { method: 'PUT', body: JSON.stringify({ title }) });
    const res = await put('  新しい表示名  ');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, title: '新しい表示名' });

    expect(await (await api(`/api/pages/${slug}`)).json()).toMatchObject({ title: '新しい表示名', seq: 0 });
    await runDurableObjectAlarm(env.PAGE.getByName(slug));
    expect(await env.DB.prepare(`SELECT title, note_count FROM pages WHERE name = ?`).bind(slug).first())
      .toEqual({ title: '新しい表示名', note_count: 0 });
    // ページができた通知（表示名はまだない）に続いて、表示名の変更が届く
    expect(await browser.nextMeta()).toEqual({ type: 'meta', title: null, epoch: expect.any(String) });
    expect(await browser.nextMeta()).toMatchObject({ type: 'meta', title: '新しい表示名' });

    // 空文字で未設定に戻す
    expect(await (await put('')).json()).toEqual({ ok: true, title: null });
    expect(await browser.nextMeta()).toMatchObject({ type: 'meta', title: null });
    browser.close();
  });

  it('mustExist を付けた表示名の変更は、ページがなければ作らずに断る', async () => {
    const slug = 'title-must-exist';
    const put = () =>
      api(`/api/pages/${slug}/title`, { method: 'PUT', body: JSON.stringify({ title: '改名', mustExist: true }) });
    // まだないページ（一覧に残っていた削除済みのページ）は、作り直さない
    const missing = await put();
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'page not found' });
    expect(await (await api(`/api/pages/${slug}`)).json()).toMatchObject({ epoch: null });

    await env.PAGE.getByName(slug).createPage('元の名前');
    expect(await (await put()).json()).toEqual({ ok: true, title: '改名' });
  });

  it.each([
    ['文字列でない', 123],
    ['長すぎる', 'a'.repeat(201)],
    ['改行を含む', 'a\nb'],
  ])('%s表示名は拒否する', async (_name, title) => {
    const res = await api('/api/pages/title-bad/title', { method: 'PUT', body: JSON.stringify({ title }) });
    expect(res.status).toBe(400);
  });

  it('他のオリジンからの変更は断る', async () => {
    const res = await api('/api/pages/title-cross/title', {
      method: 'PUT',
      headers: { Origin: 'https://evil.example.com' },
      body: JSON.stringify({ title: 'x' }),
    });
    expect(res.status).toBe(403);
  });
});

describe('一覧のボード用の API', () => {
  it('ページと、ページ間のリンクをまとめて返す。未作成のリンク先には印が付く', async () => {
    await seed('board-a', ['A の本文です <a href="/p/board-b">b</a> <a href="/p/board-missing">m</a>'], 'ページ A');
    await seed('board-b', ['B の本文'.repeat(40)]);

    const res = await api('/api/index');
    const body = (await res.json()) as {
      pages: Record<string, unknown>[];
      links: Record<string, unknown>[];
    };
    const a = body.pages.find((p) => p.name === 'board-a');
    expect(a).toMatchObject({ name: 'board-a', title: 'ページ A', note_count: 1, excerpt: 'A の本文です b m' });
    const b = body.pages.find((p) => p.name === 'board-b');
    expect((b!.excerpt as string).length).toBe(60);

    // names=1 なら、スラッグだけを返す（一覧の絞り込み用）
    const names = await api(`/api/search?names=1&q=${encodeURIComponent('A の本文')}`);
    expect(await names.json()).toEqual({ pages: [{ name: 'board-a' }] });

    expect(body.links.filter((l) => l.from_page === 'board-a')).toEqual(
      expect.arrayContaining([
        { from_page: 'board-a', to_page: 'board-b', missing: 0 },
        { from_page: 'board-a', to_page: 'board-missing', missing: 1 },
      ]),
    );
  });
});

describe('ページの新規作成', () => {
  const create = (slug: string, body: unknown) =>
    api(`/api/pages/${slug}`, { method: 'POST', body: JSON.stringify(body) });

  it('表示名を付けて作ると、索引に出る', async () => {
    expect((await create('new-titled', { title: '新しいページ' })).status).toBe(201);
    await runDurableObjectAlarm(env.PAGE.getByName('new-titled'));
    expect(await env.DB.prepare(`SELECT title, note_count FROM pages WHERE name = 'new-titled'`).first())
      .toEqual({ title: '新しいページ', note_count: 0 });
  });

  it('表示名なしでも作れる', async () => {
    expect((await create('new-untitled', {})).status).toBe(201);
    expect(await (await api('/api/pages/new-untitled')).json()).toMatchObject({
      title: null, epoch: expect.any(String),
    });
  });

  it('すでにあるページには 409 を返し、表示名を書き換えない', async () => {
    await seed('new-existing', ['x'], '元の表示名');
    expect((await create('new-existing', { title: '上書き' })).status).toBe(409);
    expect(await (await api('/api/pages/new-existing')).json()).toMatchObject({ title: '元の表示名' });
  });

  it('不正な表示名は 400', async () => {
    expect((await create('new-bad', { title: 'a\nb' })).status).toBe(400);
    expect(await (await api('/api/pages/new-bad')).json()).toMatchObject({ epoch: null });
  });
});

describe('ページの削除', () => {
  it('ページの内容と索引を消し、接続中のブラウザを専用のコードで閉じる', async () => {
    const stub = await seed('del-page', ['消すページ <a href="/p/del-other">o</a>'], '消すページ');
    await seed('del-other', ['<a href="/p/del-page">back</a>']);
    const browser = await join('del-page', 'c1');

    const res = await api('/api/pages/del-page', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await browser.closed).toMatchObject({ code: 4410 });

    expect(await stub.getSnapshot()).toEqual({
      seq: 0, title: null, epoch: null, data: { version: 1, notes: [], edges: [] },
    });
    const tables = await runInDurableObject(stub, (_do, state) =>
      state.storage.sql.exec(`SELECT count(*) AS c FROM sqlite_master`).one().c,
    );
    expect(tables).toBe(0);
    expect(await runDurableObjectAlarm(stub)).toBe(false);

    expect(await env.DB.prepare(`SELECT 1 FROM pages WHERE name = 'del-page'`).first()).toBeNull();
    expect((await env.DB.prepare(`SELECT 1 FROM links WHERE from_page = 'del-page'`).all()).results).toEqual([]);
    expect(await names(await api(`/api/search?q=${encodeURIComponent('消すページ')}`))).not.toContain('del-page');
    // 他のページからのリンクは残り、一覧では未作成のページとして出る
    const index = (await (await api('/api/index')).json()) as { links: Record<string, unknown>[] };
    expect(index.links).toContainEqual({ from_page: 'del-other', to_page: 'del-page', missing: 1 });
  });

  it('削除した後に書き込むと、新しいページとして作られる', async () => {
    const stub = await seed('del-again', ['1 回目']);
    await api('/api/pages/del-again', { method: 'DELETE' });
    const res = await stub.applyOps({
      actor: 'user:a', clientId: 'c1', opId: 'after-delete', deltas: [createNote('n9', { text: '2 回目' })],
    });
    expect(res).toMatchObject({ ok: true, seq: 1 });
    await runDurableObjectAlarm(stub);
    expect(await env.DB.prepare(`SELECT plain_text FROM pages WHERE name = 'del-again'`).first())
      .toEqual({ plain_text: '2 回目' });
  });

  it('他のオリジンからの削除は断る', async () => {
    await seed('del-cross', ['x']);
    const res = await api('/api/pages/del-cross', { method: 'DELETE', headers: { Origin: 'https://evil.example.com' } });
    expect(res.status).toBe(403);
    expect(await env.DB.prepare(`SELECT 1 FROM pages WHERE name = 'del-cross'`).first()).not.toBeNull();
  });
});

describe('画像', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

  it('アップロードした画像を、返された URL で取得できる', async () => {
    const res = await api('/api/images', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png });
    expect(res.status).toBe(201);
    const { url } = (await res.json()) as { url: string };
    expect(url).toMatch(/^\/img\/[0-9a-f-]{36}\.png$/);

    const got = await api(url);
    expect(got.status).toBe(200);
    expect(got.headers.get('Content-Type')).toBe('image/png');
    expect(got.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(png);
  });

  it.each([
    ['SVG', 'image/svg+xml', 415],
    ['HTML', 'text/html', 415],
  ])('%s は受け付けない', async (_name, type, status) => {
    const res = await api('/api/images', { method: 'POST', headers: { 'Content-Type': type }, body: png });
    expect(res.status).toBe(status);
  });

  it('空の本文と大きすぎる画像は受け付けない', async () => {
    const post = (body: BodyInit) =>
      api('/api/images', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body });
    expect((await post(new Uint8Array(0))).status).toBe(400);
    expect((await post(new Uint8Array(10 * 1024 * 1024 + 1))).status).toBe(413);
  });

  it('存在しないキーと不正なキーは 404', async () => {
    expect((await api('/img/00000000-0000-0000-0000-000000000000.png')).status).toBe(404);
    expect((await api('/img/..%2Fsecret')).status).toBe(404);
  });
});

it('note ヘルパーの形がスナップショットと一致する', async () => {
  const stub = await seed('helper-shape', ['x']);
  expect((await stub.getSnapshot()).data.notes).toEqual([note('n0', { text: 'x' })]);
});
