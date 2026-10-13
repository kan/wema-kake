// ヘッダーから他のページへ移るための一覧。ブックマーク（よく行くページ）を上に固定し、その下に
// 最近更新のあったページを数件出す。入力欄で、全部のページから名前で絞り込める（issue #12）。
//
// ブックマークは、利用者ごとにサーバーへ保存する（GET / PUT / DELETE /api/bookmarks）。
// ページの画面には、そのページをブックマークするかどうかを切り替える ★ も置く。
// 一覧に出す順を決める計算は page-nav.ts にある。
import { MAX_BOOKMARKS, MAX_QUERY_LENGTH } from '../shared/api';
import * as api from './api';
import { appLink, el, errorMessage, formatDate, textInput } from './dom';
import { t } from './i18n';
import { icon } from './icons';
import { viewSignal } from './navigation';
import { navEntries, type NavPage, RECENT_PAGES } from './page-nav';
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

/** 名前で絞り込んだときに、サーバーから取るページの数 */
const FILTER_LIMIT = 30;
/** 入力が止まってから、絞り込みを始めるまでの時間 */
const FILTER_DELAY_MS = 200;

/** 一覧の 1 行。ブックマークしたページには ★、更新の時刻が分かるページには日時を付ける */
function navLink(page: NavPage, bookmarked: boolean): HTMLAnchorElement {
  return appLink(
    `/p/${page.name}`,
    bookmarked && el('span', { className: 'link-star', title: t('nav.bookmarked') }, icon('starFilled')),
    el('span', { className: 'link-title', textContent: page.title ?? page.name }),
    page.updated_at !== null && el('span', { className: 'link-detail', textContent: formatDate(page.updated_at) }),
  );
}

/**
 * 他のページへ移るための一覧を出すボタン（ヘッダーの右に置く）。ブックマークしたページ、最近更新の
 * あったページ（子ページも含む）の順に並べる。入力欄に文字を入れると、全部のページから、表示名か
 * スラッグにその文字を含むページを出す。開くたびに読み直す（他のタブや端末で変えた分も出る）
 */
export function pageNavMenu(): HTMLElement {
  const signal = viewSignal();
  const filter = textInput({
    type: 'search',
    className: 'nav-filter',
    placeholder: t('nav.filter'),
    ariaLabel: t('nav.filter'),
    maxLength: MAX_QUERY_LENGTH,
  });
  const list = el('div', { className: 'link-list' });
  const panel = el('div', { className: 'page-nav' }, filter, list);

  /**
   * 開いてから読んだブックマーク。絞り込みの間は、読み直さない。読めなかったときは undefined に
   * 戻して、次の絞り込みで読み直す
   */
  let bookmarks: Promise<NavPage[]> | undefined;
  /** 最後に始めた読み込み。古い結果が後から届いても使わない */
  let latest = 0;
  /** 出ている一覧が、今の入力に合っているか（合うまでは、Enter で移らない） */
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const note = (text: string) => list.replaceChildren(el('span', { className: 'empty', textContent: text }));
  const show = async () => {
    const run = ++latest;
    const query = filter.value.trim();
    const loading = (bookmarks ??= api.getBookmarks());
    loading.catch(() => {
      if (bookmarks === loading) bookmarks = undefined;
    });
    try {
      const [marks, others] = await Promise.all([
        loading,
        // 絞り込まないときは、ブックマークしたページを除いても、最近の分が残る数を取る
        query === ''
          ? api.getRecentPages(RECENT_PAGES + MAX_BOOKMARKS)
          : api.getRecentPages(FILTER_LIMIT, query),
      ]);
      if (signal.aborted || run !== latest) return;
      const { pinned, rest } = navEntries(marks, others, query);
      if (pinned.length + rest.length === 0) {
        note(t(query === '' ? 'nav.empty' : 'nav.noMatch'));
      } else {
        list.replaceChildren();
        list.append(
          ...pinned.map((page) => navLink(page, true)),
          // ブックマークしたページと、それ以外の間を、線で区切る
          ...(pinned.length > 0 && rest.length > 0 ? [el('hr')] : []),
          ...rest.map((page) => navLink(page, false)),
        );
        // サーバーは、新しい順に FILTER_LIMIT 件までしか返さない。切れているかもしれないときは、知らせる
        if (query !== '' && others.length >= FILTER_LIMIT) {
          list.append(el('span', { className: 'empty', textContent: t('nav.more') }));
        }
      }
      settled = true;
    } catch (e) {
      if (!signal.aborted && run === latest) note(t('links.loadFailed', errorMessage(e)));
    }
  };

  filter.addEventListener('input', () => {
    settled = false;
    // 前の入力での読み込みが、この後に届いても使わない
    latest++;
    clearTimeout(timer);
    timer = setTimeout(() => void show(), FILTER_DELAY_MS);
  });
  filter.addEventListener('keydown', (e) => {
    // 日本語入力の変換を確定する Enter では、移らない
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    // 先頭のページへ移る
    if (settled) list.querySelector('a')?.click();
  });
  signal.addEventListener('abort', () => clearTimeout(timer));

  return popover(iconButton('bookmarks', t('nav.title')), panel, {
    align: 'right',
    onOpen() {
      clearTimeout(timer);
      filter.value = '';
      settled = false;
      bookmarks = undefined;
      // 前の内容があれば、読み込みの間はそのまま出しておく（開くたびに空にすると、ちらつく）
      if (list.childElementCount === 0) note(t('loading'));
      void show();
      // タッチの端末では、開いただけでキーボードが出て、一覧が隠れる。入力欄へは、押して入る
      if (!matchMedia('(pointer: coarse)').matches) filter.focus();
    },
  }).root;
}

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
