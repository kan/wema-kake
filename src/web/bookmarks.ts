// ヘッダーから他のページへ移るための一覧。ブックマーク（よく行くページ）と、最近の変更。
//
// ブックマークは、利用者ごとにサーバーへ保存する（GET / PUT / DELETE /api/bookmarks）。
// ヘッダーに、ブックマークしたページの一覧を出すボタンを置く。ページの画面には、そのページを
// ブックマークするかどうかを切り替える ★ も置く。
import * as api from './api';
import { appLink, el, errorMessage, formatDate } from './dom';
import { t } from './i18n';
import { type IconName, icon } from './icons';
import { viewSignal } from './navigation';
import { iconButton, popover } from './toolbar';

/** ページへのリンクを並べる。`detail` は、表示名の右に薄く出す文字（更新日時など） */
export function pageLinks<T extends api.PageLink>(pages: T[], detail?: (page: T) => string): HTMLElement[] {
  return pages.map((page) =>
    appLink(
      `/p/${page.name}`,
      el('span', { className: 'link-title', textContent: page.title ?? page.name }),
      detail && el('span', { className: 'link-detail', textContent: detail(page) }),
    ),
  );
}

/** 一覧を読み込んで `panel` に出す。読み込みの間と、失敗したとき、1 件もないときは、その旨を出す */
function showPageLinks(panel: HTMLElement, load: () => Promise<HTMLElement[]>, empty: string): void {
  const signal = viewSignal();
  const note = (text: string) => panel.replaceChildren(el('span', { className: 'empty', textContent: text }));
  // 前の内容があれば、読み込みの間はそのまま出しておく（開くたびに空にすると、ちらつく）
  if (panel.childElementCount === 0) note(t('loading'));
  load()
    .then((links) => {
      if (signal.aborted) return;
      if (links.length === 0) note(empty);
      else panel.replaceChildren(...links);
    })
    .catch((e: unknown) => {
      if (!signal.aborted) note(t('links.loadFailed', errorMessage(e)));
    });
}

/** 「最近の変更」に出すページの数 */
const RECENT_PAGES = 15;

/**
 * ページの一覧を出すボタン（ヘッダーの右に置く）。開くたびに読み直す（他のタブや端末で変えた分も出る）
 */
function pageListMenu(
  iconName: IconName,
  title: string,
  load: () => Promise<HTMLElement[]>,
  empty: string,
): HTMLElement {
  const panel = el('div', { className: 'link-list' });
  return popover(iconButton(iconName, title), panel, {
    align: 'right',
    onOpen: () => showPageLinks(panel, load, empty),
  }).root;
}

/** 最近変更されたページ（新しい順。子ページも含む）の一覧を出すボタン */
export const recentPagesMenu = (): HTMLElement =>
  pageListMenu(
    'history',
    t('recent.title'),
    async () => pageLinks(await api.getRecentPages(RECENT_PAGES), (page) => formatDate(page.updated_at)),
    t('recent.empty'),
  );

/** ブックマークしたページの一覧を出すボタン */
export const bookmarksMenu = (): HTMLElement =>
  pageListMenu(
    'bookmarks',
    t('bookmarks.title'),
    async () => pageLinks(await api.getBookmarks()),
    t('bookmarks.empty'),
  );

/**
 * `slug` のページを、ブックマークするかどうかを切り替える ★。`onError` は、切り替えに失敗したときに呼ぶ
 */
export function bookmarkStar(slug: string, onError: (e: unknown) => void): HTMLButtonElement {
  const signal = viewSignal();
  let on = false;
  // 切り替えの途中は押せないようにする（続けて押すと、付ける要求と外す要求の順が前後する）
  const star = iconButton('star', '', () => {
    const next = !on;
    star.disabled = true;
    api
      .setBookmark(slug, next)
      .then(() => {
        if (!signal.aborted) show(next);
      })
      .catch((e: unknown) => {
        if (signal.aborted) return;
        // 開いただけで、まだ何も書いていないページは、サーバーにない
        const missing = e instanceof api.ApiError && e.status === 404;
        onError(missing ? new Error(t('bookmark.unwritten')) : e);
      })
      .finally(() => {
        star.disabled = false;
      });
  });
  const show = (value: boolean) => {
    on = value;
    star.replaceChildren(icon(on ? 'starFilled' : 'star'));
    star.title = t(on ? 'bookmark.remove' : 'bookmark.add');
    star.ariaLabel = star.title;
    star.ariaPressed = String(on);
  };
  show(false);
  // 今の状態が分かるまでは、押せない
  star.disabled = true;
  api
    .getBookmarks()
    .then((pages) => {
      if (signal.aborted) return;
      show(pages.some((page) => page.name === slug));
      star.disabled = false;
    })
    // 状態が分からないまま押せるようにはしない（外すつもりで付けてしまう）。一覧は、開けば読み直す
    .catch(() => {});
  return star;
}
