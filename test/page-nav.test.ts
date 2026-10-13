import { describe, expect, it } from 'vitest';
import { navEntries, type NavPage, RECENT_PAGES } from '../src/web/page-nav';

const page = (name: string, title: string | null = null, updated_at: number | null = null): NavPage => ({
  name, title, updated_at,
});
const names = ({ pinned, rest }: { pinned: NavPage[]; rest: NavPage[] }) => [
  ...pinned.map((entry) => `★${entry.name}`),
  ...rest.map((entry) => entry.name),
];

describe('navEntries', () => {
  it('ブックマークしたページを付けた順に先に並べ、その後ろに最近のページを続ける', () => {
    const entries = navEntries([page('b'), page('a')], [page('x', null, 30), page('y', null, 20)]);
    expect(names(entries)).toEqual(['★b', '★a', 'x', 'y']);
  });

  it('ブックマークしたページは、最近のページの側には重ねて出さない', () => {
    const entries = navEntries([page('a', 'A', 20)], [page('x', null, 30), page('a', 'A', 20), page('y', null, 10)]);
    expect(names(entries)).toEqual(['★a', 'x', 'y']);
  });

  it(`最近のページは ${RECENT_PAGES} 件まで。ブックマークしたページは、数に入れない`, () => {
    const recent = Array.from({ length: 12 }, (_, i) => page(`p${i}`, null, 100 - i));
    const entries = navEntries([page('p0'), page('p1'), page('old')], recent);
    expect(names(entries)).toEqual(['★p0', '★p1', '★old', 'p2', 'p3', 'p4', 'p5', 'p6']);
  });

  it('文字があるときは、ブックマークを表示名かスラッグで絞る。英字の大文字と小文字は区別しない', () => {
    const bookmarks = [page('memo', '買い物'), page('todo', 'Memo の整理'), page('other', 'その他')];
    expect(names(navEntries(bookmarks, [], ' MEMO '))).toEqual(['★memo', '★todo']);
    expect(names(navEntries(bookmarks, [], '買い'))).toEqual(['★memo']);
  });

  it('英字のほかは、大文字と小文字を区別する（サーバーの絞り込みと同じ）', () => {
    const bookmarks = [page('a', 'École'), page('b', 'Ｍemo')];
    expect(names(navEntries(bookmarks, [], 'école'))).toEqual([]);
    expect(names(navEntries(bookmarks, [], 'ｍemo'))).toEqual([]);
    expect(names(navEntries(bookmarks, [], 'ÉCOLE'))).toEqual(['★a']);
  });

  it('文字があるときは、サーバーの絞った分を、数を切らずに続ける', () => {
    const found = Array.from({ length: 8 }, (_, i) => page(`memo-${i}`));
    const entries = navEntries([page('memo-3'), page('zzz')], found, 'memo');
    expect(names(entries)).toEqual(['★memo-3', 'memo-0', 'memo-1', 'memo-2', 'memo-4', 'memo-5', 'memo-6', 'memo-7']);
  });

  it('1 件もなければ、どちらも空を返す', () => {
    expect(navEntries([], [])).toEqual({ pinned: [], rest: [] });
    expect(navEntries([page('a')], [], 'zzz')).toEqual({ pinned: [], rest: [] });
  });
});
