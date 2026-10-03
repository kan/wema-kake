// 一覧の画面（/）。ページの一覧を wema のボードで表す（docs/plan.md の 3.7 節）。
// ページ 1 つが付箋 1 枚、ページ間のリンクが接続線。検索は、一致するページの付箋だけを残す。
import { WemaBoard, type WemaNote } from '@kanf/wema';
import { MAX_QUERY_LENGTH, MAX_TITLE_LENGTH } from '../shared/api';
import { isValidSlug } from '../shared/slug';
import * as api from './api';
import { el, errorMessage, formatDate, openInternalLink } from './dom';
import { buildIndexBoard, type IndexBoard } from './index-board';

/** 入力が止まってから検索するまでの時間 */
const SEARCH_DELAY_MS = 200;

/** スラッグの初期値。短い乱数（小文字の英数字） */
function randomSlug(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((b) => (b % 36).toString(36)).join('');
}

/** 新規ページの入力欄 */
function newPageForm(): HTMLFormElement {
  const titleInput = el('input', { placeholder: '表示名（省略できます）', maxLength: MAX_TITLE_LENGTH });
  const slugInput = el('input', { value: randomSlug(), title: 'URL に使う名前。小文字の英数字とハイフン' });
  const message = el('span', { className: 'sync-notice' });
  const form = el(
    'form',
    { className: 'new-page' },
    titleInput,
    el('span', { textContent: '/p/' }),
    slugInput,
    el('button', { type: 'submit', textContent: '新規ページ' }),
    message,
  );

  const create = async () => {
    const slug = slugInput.value.trim();
    if (!isValidSlug(slug)) {
      message.textContent = 'スラッグは小文字の英数字とハイフンで、64 文字までです';
      return;
    }
    try {
      await api.createPage(slug, titleInput.value);
    } catch (e) {
      if (e instanceof api.ApiError && e.status === 409) {
        message.replaceChildren(
          'そのスラッグのページはすでにあります（',
          el('a', { href: `/p/${slug}`, textContent: '開く' }),
          '）',
        );
      } else {
        message.textContent = `作成に失敗しました（${errorMessage(e)}）`;
      }
      return;
    }
    location.assign(`/p/${slug}`);
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void create();
  });
  return form;
}

/** fitCanvasToNotes で、付箋の外側に空ける余白 */
const CANVAS_MARGIN = 40;

/**
 * 仮の対処。wema にはまだスクロールもパンもなく、ボードは置いた要素の大きさに固定される。
 * 表示領域からはみ出した付箋に届くよう、ボードを置く要素を付箋の範囲と同じ大きさにして、
 * 外側の要素（.index-scroll）をスクロールさせる。
 *
 * wema にパンが入ったら（kan/wema#52）、この関数と .index-scroll の入れ子、対応する CSS を外す。
 */
function fitCanvasToNotes(canvas: HTMLElement, scroller: HTMLElement, notes: WemaNote[]): void {
  const right = Math.max(0, ...notes.map((n) => n.x + n.width)) + CANVAS_MARGIN;
  const bottom = Math.max(0, ...notes.map((n) => n.y + n.height)) + CANVAS_MARGIN;
  canvas.style.width = `${Math.max(right, scroller.clientWidth)}px`;
  canvas.style.height = `${Math.max(bottom, scroller.clientHeight)}px`;
}

export function openIndex(app: HTMLElement): void {
  document.title = 'wema-kake';

  const search = el('input', {
    type: 'search',
    className: 'index-search',
    placeholder: 'ページを絞り込む',
    maxLength: MAX_QUERY_LENGTH,
    value: new URLSearchParams(location.search).get('q') ?? '',
  });
  const count = el('span', { className: 'sync-status' });
  // 仮の対処（fitCanvasToNotes を参照）のために、ボードを置く要素をスクロールする要素で包む
  const canvas = el('div', { className: 'index-canvas' });
  const scroller = el('div', { className: 'index-scroll' }, canvas);
  app.append(
    el(
      'header',
      { className: 'page-header' },
      el('h1', { textContent: 'wema-kake' }),
      search,
      count,
      el('span', { className: 'spacer' }),
      newPageForm(),
    ),
    scroller,
  );

  let board: WemaBoard | undefined;
  let index: IndexBoard | undefined;
  /** 最後に始めた絞り込み。古い検索の結果が後から届いても使わない */
  let latest = 0;

  /** 最後に絞り込んだ検索語。同じ語でもう一度検索しない */
  let applied: string | undefined;

  const applyFilter = async () => {
    if (!board || !index) return;
    const q = search.value.trim();
    if (q === applied) return;
    applied = q;
    history.replaceState(null, '', q ? `/?q=${encodeURIComponent(q)}` : '/');
    const request = ++latest;
    const total = index.data.notes.length;
    if (q === '') {
      board.setNoteFilter(null);
      count.textContent = `${total} ページ`;
      return;
    }
    const show = (matched: Set<string>, note = '') => {
      board?.setNoteFilter([...matched]);
      count.textContent = `${matched.size} / ${total} ページ${note}`;
    };
    // 表示名とスラッグは手元で照合し、すぐに反映する
    // （未作成のページは検索の索引にないので、これだけで判定する）
    const needle = q.toLowerCase();
    const matched = new Set(
      [...index.searchText].filter(([, text]) => text.includes(needle)).map(([id]) => id),
    );
    show(matched);
    // 本文は、サーバーの検索で照合し、届いたら足す
    try {
      const names = await api.searchPages(q);
      // 待っている間に検索語が変わっていたら、古い結果は使わない
      if (request !== latest) return;
      for (const name of names) if (index.searchText.has(name)) matched.add(name);
      show(matched);
    } catch (e) {
      if (request === latest) show(matched, `（本文の検索に失敗しました: ${errorMessage(e)}）`);
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => void applyFilter(), SEARCH_DELAY_MS);
  });

  api
    .getIndex()
    .then(({ pages, links }) => {
      if (pages.length === 0) {
        canvas.append(el('p', { className: 'empty', textContent: 'まだページがありません' }));
        return;
      }
      index = buildIndexBoard(pages, links, scroller.clientWidth, formatDate);
      fitCanvasToNotes(canvas, scroller, index.data.notes);
      // 参照モード: 編集の UI は出ず、付箋はドラッグできるが、保存はしない
      board = new WemaBoard({
        container: canvas,
        data: index.data,
        viewOnly: true,
        onLinkClick: openInternalLink,
      });
      return applyFilter();
    })
    .catch((e: unknown) => {
      canvas.replaceChildren(
        el('p', { className: 'empty', textContent: `一覧を取得できませんでした（${errorMessage(e)}）` }),
      );
    });
}
