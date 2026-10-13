// ヘッダーから他のページへ移るための一覧の、並べ方（issue #12）。画面は bookmarks.ts。
//
// ブックマークしたページを上に固定し、その下に、最近更新のあったページを数件だけ出す。
// 入力欄に文字があるときは、表示名かスラッグにその文字を含むページを出す。
// ここは、並べる順を決める計算だけを持つ（DOM に触らない）。

/** 最近更新のあったページを出す数 */
export const RECENT_PAGES = 5;

export interface NavPage {
  name: string;
  title: string | null;
  /** 最後に更新された時刻（ミリ秒）。索引への反映の前のページは null */
  updated_at: number | null;
}

export interface NavList {
  /** ブックマークしたページ（付けた順） */
  pinned: NavPage[];
  /** それ以外のページ（サーバーの返した順） */
  rest: NavPage[];
}

/** 英字だけを小文字にする（サーバーの絞り込みと同じ。全角の英字やアクセント付きの文字は、そのまま比べる） */
const lower = (text: string) => text.replace(/[A-Z]+/g, (upper) => upper.toLowerCase());

/** 表示名かスラッグに、`query`（`lower` 済み）を含むか */
const matches = (page: NavPage, query: string) =>
  lower(page.name).includes(query) || lower(page.title ?? '').includes(query);

/**
 * 一覧に出すページを、ブックマークしたページと、それ以外（`others`）に分けて並べる。
 * ブックマークしたページは、`others` にあっても重ねて出さない。
 *
 * `query` が空のとき、`others` は最近更新のあったページで、`RECENT_PAGES` 件までを出す。
 * 文字があるとき、`others` はサーバーが名前で絞ったページで、ブックマークは手元で同じ規則で絞る
 * （付けたばかりで、まだ索引にないページも、スラッグが合えば出る）
 */
export function navEntries(bookmarks: NavPage[], others: NavPage[], query = ''): NavList {
  const q = lower(query.trim());
  const bookmarked = new Set(bookmarks.map((page) => page.name));
  const rest = others.filter((page) => !bookmarked.has(page.name));
  return {
    pinned: q === '' ? bookmarks : bookmarks.filter((page) => matches(page, q)),
    rest: q === '' ? rest.slice(0, RECENT_PAGES) : rest,
  };
}
