import type { WemaEdge, WemaNote } from '@kanf/wema';
import { describe, expect, it } from 'vitest';
import { CHILD_PAGE_KEY } from '../src/shared/hierarchy';
import { firstLine, noteLinks } from '../src/web/note-links';

describe('firstLine', () => {
  it.each([
    ['1 行だけ', '1 行だけ'],
    ['<div>1 行目</div><div>2 行目</div>', '1 行目'],
    ['1 行目<br>2 行目', '1 行目'],
    ['<div><br></div><div> <b>太字</b>の行 </div>', '太字の行'],
    ['<ul class="wema-checklist"><li><input type="checkbox">やること</li><li>次</li></ul>', 'やること'],
    ['<blockquote>引用</blockquote>感想', '引用'],
    ['a &amp; b &lt;c&gt;', 'a & b <c>'],
    ['&nbsp;<a href="/p/memo">メモ</a> を読む', 'メモ を読む'],
    ['<img src="/img/x.png">', ''],
    ['<a href="https://example.com/?a>b">資料</a>', '資料'],
    ['<div title="a>b">1 行目</div>2 行目', '1 行目'],
    ['<div>​</div><div>﻿本文</div>', '本文'],
    ['<div>前半\n後半</div>', '前半'],
    ['', ''],
  ])('%s → %s', (html, expected) => {
    expect(firstLine(html)).toBe(expected);
  });
});

describe('noteLinks', () => {
  const note = (id: string, text: string, meta?: Record<string, string>): WemaNote =>
    ({ id, text, ...(meta ? { meta } : {}) }) as WemaNote;
  const edge = (id: string, from: string, to: string, over: Partial<WemaEdge> = {}): WemaEdge => ({
    id, from, to, fromAnchor: 'auto', toAnchor: 'auto', style: 'arrow', ...over,
  });
  const notes = new Map(
    [
      note('a', '<div>原因</div><div>詳しく</div>'),
      note('b', '結果'),
      note('c', ''),
      note('child', '', { [CHILD_PAGE_KEY]: 'sub' }),
    ].map((n) => [n.id, n]),
  );
  const links = (id: string, edges: WemaEdge[]) =>
    noteLinks(id, edges, (peer) => notes.get(peer), (child) => `表示名:${child}`);

  it('出ていく線と入ってくる線を、相手の付箋の冒頭で印にする', () => {
    const edges = [edge('e1', 'a', 'b'), edge('e2', 'c', 'a')];
    expect(links('a', edges)).toEqual([
      { edgeId: 'e1', direction: 'out', peer: 'b', text: '結果' },
      { edgeId: 'e2', direction: 'in', peer: 'c', text: '' },
    ]);
    expect(links('b', edges.slice(0, 1))).toEqual([{ edgeId: 'e1', direction: 'in', peer: 'a', text: '原因' }]);
  });

  it('向きは、矢印の付く端で決める。指定がなければ style から決まる', () => {
    const direction = (over: Partial<WemaEdge>) => links('a', [edge('e', 'a', 'b', over)])[0].direction;
    expect(direction({ arrowHead: 'end' })).toBe('out');
    expect(direction({ arrowHead: 'start' })).toBe('in');
    expect(direction({ arrowHead: 'both' })).toBe('both');
    expect(direction({ arrowHead: 'none' })).toBe('none');
    expect(direction({ style: 'line' })).toBe('none');
    expect(direction({ style: 'dashed' })).toBe('none');
    // 矢印の指定は、style より優先する
    expect(direction({ style: 'line', arrowHead: 'end' })).toBe('out');
  });

  it('出ていく線、入ってくる線の順に並べる。同じ向きの中では、接続線の順のまま', () => {
    const edges = [
      edge('e1', 'b', 'a'),
      edge('e2', 'a', 'c', { style: 'line' }),
      edge('e3', 'a', 'b'),
      edge('e4', 'a', 'c'),
    ];
    expect(links('a', edges).map((link) => link.edgeId)).toEqual(['e3', 'e4', 'e1', 'e2']);
  });

  it('接続線のラベルを添える。空白だけのラベルは添えない', () => {
    expect(links('a', [edge('e1', 'a', 'b', { label: ' だから ' })])[0].label).toBe('だから');
    expect(links('a', [edge('e1', 'a', 'b', { label: '  ' })])[0]).not.toHaveProperty('label');
  });

  it('子ページの付箋は、子ページの表示名を出す', () => {
    expect(links('a', [edge('e1', 'a', 'child')])[0].text).toBe('表示名:sub');
  });

  it('相手の付箋がない線と、両端が同じ付箋の線は、印にしない', () => {
    expect(links('a', [edge('e1', 'a', 'gone'), edge('e2', 'a', 'a')])).toEqual([]);
  });
});
