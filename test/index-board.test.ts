import { describe, expect, it } from 'vitest';
import type { IndexLink, IndexPage } from '../src/shared/api';
import { buildIndexBoard } from '../src/web/index-board';
import { sanitizeHtml } from '../src/worker/sanitize';

const page = (name: string, over: Partial<IndexPage> = {}): IndexPage => ({
  name, title: null, note_count: 1, updated_at: 0, excerpt: '', child_count: 0, ...over,
});
const link = (from_page: string, to_page: string, missing = 0): IndexLink => ({ from_page, to_page, missing });
const build = (pages: IndexPage[], links: IndexLink[] = [], width = 1000, height = 600) =>
  buildIndexBoard(pages, links, { width, height }, () => '2026/10/03');

type Box = { x: number; y: number; width: number; height: number };
const overlapping = (notes: Box[]) =>
  notes.some((p) =>
    notes.some(
      (q) => p !== q && p.x < q.x + q.width && q.x < p.x + p.width && p.y < q.y + q.height && q.y < p.y + p.height,
    ),
  );
const extent = (notes: Box[]) => ({
  width: Math.max(...notes.map((n) => n.x + n.width)),
  height: Math.max(...notes.map((n) => n.y + n.height)),
});

describe('buildIndexBoard', () => {
  it('ページ 1 つを付箋 1 枚にし、表示名のリンク、本文の冒頭、更新日を出す', () => {
    const { data } = build([page('memo', { title: 'メモ <b>', excerpt: '本文 & 冒頭', note_count: 3 })]);
    expect(data.notes).toHaveLength(1);
    expect(data.notes[0]).toMatchObject({ id: 'memo', width: 220, height: 160 });
    expect(data.notes[0].text).toBe(
      '<a href="/p/memo"><b>メモ &lt;b&gt;</b></a>' +
        '<div>本文 &amp; 冒頭</div>' +
        '<div><span style="font-size: 11px; color: #666">2026/10/03・付箋 3 枚</span></div>',
    );
  });

  it('付箋の HTML は、サニタイザを通しても変わらない（許可されたタグと属性だけで組んでいる）', async () => {
    const { data } = build(
      [page('memo', { title: 'メモ <b> & "x"', excerpt: '<script>alert(1)</script>' })],
      [link('memo', 'todo', 1)],
    );
    for (const note of data.notes) {
      expect(await sanitizeHtml(note.text)).toBe(note.text);
    }
  });

  it('表示名がなければスラッグを出す', () => {
    expect(build([page('untitled')]).data.notes[0].text).toContain('<b>untitled</b>');
  });

  it('ページ間のリンクを接続線にする。自分へのリンクは線にしない', () => {
    const { data } = build([page('a'), page('b'), page('c')], [link('a', 'b'), link('a', 'a'), link('b', 'a')]);
    // 線は細くし、上下の位置関係に合わせて付箋の上端と下端につなぐ（a が上、b が下）
    const style = { style: 'arrow', strokeWidth: 1, arrowSize: 8 };
    expect(data.edges).toEqual([
      { id: 'a>b', from: 'a', to: 'b', fromAnchor: 'bottom', toAnchor: 'top', ...style },
      { id: 'b>a', from: 'b', to: 'a', fromAnchor: 'top', toAnchor: 'bottom', ...style },
    ]);
  });

  it('リンク先が未作成のページは、色を変えた付箋として出す', () => {
    const { data, searchText } = build([page('a')], [link('a', 'todo', 1)]);
    const missing = data.notes.find((n) => n.id === 'todo')!;
    expect(missing.color).not.toBe(data.notes[0].color);
    expect(missing.text).toContain('<a href="/p/todo">todo</a>');
    expect(missing.text).toContain('未作成');
    expect(data.edges.map((e) => e.id)).toEqual(['a>todo']);
    expect(searchText.get('todo')).toBe('todo');
  });

  it('一覧に含まれない既存のページへのリンクは、線にも付箋にもしない', () => {
    const { data } = build([page('a')], [link('a', 'beyond-limit', 0), link('not-listed', 'a')]);
    expect(data.notes.map((n) => n.id)).toEqual(['a']);
    expect(data.edges).toEqual([]);
  });

  it('つながったページは階層に、つながりのないページはその下に、幅に収まる列数で並べる', () => {
    const pages = ['a', 'b', 'x1', 'x2', 'x3', 'x4', 'x5'].map((name) => page(name));
    const { data } = build(pages, [link('a', 'b')], 900);
    const at = Object.fromEntries(data.notes.map((n) => [n.id, n]));

    // a から b へのリンク: b は a の下の段
    expect(at.b.y).toBeGreaterThan(at.a.y);
    // つながりのないページは、つながったページより下。幅 900 には 3 列入る
    expect(at.x1.y).toBeGreaterThan(at.b.y + at.b.height);
    expect([at.x1.y, at.x2.y, at.x3.y]).toEqual([at.x1.y, at.x1.y, at.x1.y]);
    expect(at.x4.y).toBeGreaterThan(at.x1.y);
    expect(at.x4.x).toBe(at.x1.x);
    expect(at.x2.x).toBeGreaterThan(at.x1.x);

    // つながりのないページは、渡した幅からはみ出さない。付箋は重ならない
    for (const id of ['x1', 'x2', 'x3', 'x4', 'x5']) {
      expect(at[id].x + at[id].width).toBeLessThanOrEqual(900);
    }
    expect(overlapping(data.notes)).toBe(false);
  });

  it('1 ページへ多くのページからリンクがあっても、横 1 列に伸ばさず、折り返して並べる', () => {
    const sources = Array.from({ length: 20 }, (_, i) => `s${i}`);
    const { data } = build(
      [page('hub'), ...sources.map((name) => page(name))],
      sources.map((name) => link(name, 'hub')),
    );
    const at = Object.fromEntries(data.notes.map((n) => [n.id, n]));
    const rows = new Set(sources.map((name) => at[name].y));
    expect(rows.size).toBeGreaterThan(1);
    // リンク先は、リンク元のどの行よりも下
    expect(at.hub.y).toBeGreaterThan(Math.max(...rows));
    // 20 枚を横 1 列に並べた幅（5000px 超）にはならない
    expect(extent(data.notes).width).toBeLessThan(2500);
    expect(overlapping(data.notes)).toBe(false);
  });

  it('リンクでつながったまとまりが複数あれば、横に並べ、入らなければ次の行へ送る', () => {
    const names = ['a1', 'a2', 'b1', 'b2', 'c1', 'c2'];
    const { data } = build(names.map((name) => page(name)), [link('a1', 'a2'), link('b1', 'b2'), link('c1', 'c2')], 700, 800);
    const at = Object.fromEntries(data.notes.map((n) => [n.id, n]));
    // 幅 700 には 2 列。まとまり a と b が横に並び、c は次の行
    expect(at.b1.y).toBe(at.a1.y);
    expect(at.b1.x).toBeGreaterThan(at.a1.x);
    expect(at.c1.y).toBeGreaterThan(at.a2.y);
    expect(overlapping(data.notes)).toBe(false);
  });

  it('等倍で表示領域に収まる数なら、幅を広げない', () => {
    // 幅 1000 に 3 列、高さ 700 に 3 行。9 ページは収まる
    const { data } = build(Array.from({ length: 9 }, (_, i) => page(`p${i}`)), [], 1000, 700);
    expect(extent(data.notes).width).toBeLessThanOrEqual(1000);
    expect(extent(data.notes).height).toBeLessThanOrEqual(700);
    // まとまりも、表示領域の幅からはみ出さない
    const pairs = ['a', 'b', 'c', 'd'];
    const linked = build(
      pairs.flatMap((p) => [page(`${p}1`), page(`${p}2`)]),
      pairs.map((p) => link(`${p}1`, `${p}2`)),
      1100,
      2000,
    );
    expect(extent(linked.data.notes).width).toBeLessThanOrEqual(1100);
  });

  it('ページが多いときは、全体が表示領域と同じくらいの縦横比になる幅まで広げる', () => {
    const pages = Array.from({ length: 300 }, (_, i) => page(`p${i}`));
    const { data } = build(pages, [], 1200, 600);
    const { width, height } = extent(data.notes);
    // 幅 1200 に収まる 4 列のままだと、縦に 75 行（12000px 超）になる
    expect(width).toBeGreaterThan(1200);
    expect(width / height).toBeGreaterThan(1.4);
    expect(width / height).toBeLessThan(2.8);
    expect(overlapping(data.notes)).toBe(false);
  });

  it('相互リンクだけでつながったページ群にも位置を付け、重ねない', () => {
    // a → b は起点（a）がある。c ⇄ d は起点がない（wema 0.5.0 は、この組み合わせで c と d の
    // 位置を返さなかった。0.6.0 では返る）
    const pages = ['a', 'b', 'c', 'd'].map((name) => page(name));
    const { data } = build(pages, [link('a', 'b'), link('c', 'd'), link('d', 'c')]);
    const positions = data.notes.map((n) => `${n.x},${n.y}`);
    expect(new Set(positions).size).toBe(4);
    expect(positions).not.toContain('0,0');
    expect(data.edges).toHaveLength(3);
  });

  it('絞り込みで照合する文字列は、小文字にした表示名とスラッグ', () => {
    const { searchText } = build([page('my-slug', { title: 'Design Notes' })]);
    expect(searchText.get('my-slug')).toBe('design notes\nmy-slug');
  });

  it('ページがなければ空のボード', () => {
    expect(build([]).data).toEqual({ version: 1, notes: [], edges: [] });
  });
});
