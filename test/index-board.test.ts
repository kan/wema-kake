import { describe, expect, it } from 'vitest';
import type { IndexLink, IndexPage } from '../src/shared/api';
import { buildIndexBoard } from '../src/web/index-board';
import { sanitizeHtml } from '../src/worker/sanitize';

const page = (name: string, over: Partial<IndexPage> = {}): IndexPage => ({
  name, title: null, note_count: 1, updated_at: 0, excerpt: '', ...over,
});
const link = (from_page: string, to_page: string, missing = 0): IndexLink => ({ from_page, to_page, missing });
const build = (pages: IndexPage[], links: IndexLink[] = [], width = 1000) =>
  buildIndexBoard(pages, links, width, () => '2026/10/03');

describe('buildIndexBoard', () => {
  it('ページ 1 つを付箋 1 枚にし、表示名のリンク、本文の冒頭、更新日を出す', () => {
    const { data } = build([page('memo', { title: 'メモ <b>', excerpt: '本文 & 冒頭', note_count: 3 })]);
    expect(data.notes).toHaveLength(1);
    expect(data.notes[0]).toMatchObject({ id: 'memo', width: 220, height: 130 });
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
    expect(data.edges).toEqual([
      { id: 'a>b', from: 'a', to: 'b', fromAnchor: 'auto', toAnchor: 'auto', style: 'arrow' },
      { id: 'b>a', from: 'b', to: 'a', fromAnchor: 'auto', toAnchor: 'auto', style: 'arrow' },
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
    const overlaps = data.notes.some((p) =>
      data.notes.some(
        (q) => p !== q && p.x < q.x + q.width && q.x < p.x + p.width && p.y < q.y + q.height && q.y < p.y + p.height,
      ),
    );
    expect(overlaps).toBe(false);
  });

  it('相互リンクだけでつながったページ群にも位置を付け、重ねない', () => {
    // a → b は起点（a）がある。c ⇄ d は起点がなく、自動レイアウトが位置を返さない
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
