// 一覧の画面（/）。ページの一覧を wema のボードで表す（docs/plan.md の 3.7 節）。
// ページ 1 つが付箋 1 枚、ページ間のリンクが接続線。検索は、一致するページの付箋だけを残す。
import { WemaBoard, type WemaViewport } from '@kanf/wema';
import { type IndexLink, type IndexPage, MAX_QUERY_LENGTH } from '../shared/api';
import * as api from './api';
import { bookmarksMenu, recentPagesMenu } from './bookmarks';
import { appLink, confirmDeletePage, el, errorMessage, formatDate, internalLinkTarget, textInput } from './dom';
import { attachNoteActions } from './index-actions';
import { buildIndexBoard, descendantHitsHtml, type IndexBoard } from './index-board';
import { navigate, onViewEnd, type Transition, viewSignal } from './navigation';
import { checkedSlug, pageFields } from './page-form';
import { header, popover, separator, toast, zoomControls } from './toolbar';
import { zoomTransitions } from './viewport-motion';

/** 入力が止まってから検索するまでの時間 */
const SEARCH_DELAY_MS = 200;
/** 通知を出しておく時間 */
const NOTICE_MS = 8000;

/** 新規ページの入力欄 */
function newPageForm(): HTMLFormElement {
  const fields = pageFields();
  const message = el('div', { className: 'form-error' });
  const form = el(
    'form',
    { className: 'new-page' },
    ...fields.labels,
    el('button', { type: 'submit', textContent: '作成' }),
    message,
  );

  const create = async () => {
    const slug = checkedSlug(fields.slug, message);
    if (slug === undefined) return;
    try {
      await api.createPage(slug, fields.title.value);
    } catch (e) {
      if (e instanceof api.ApiError && e.status === 409) {
        message.replaceChildren(
          'そのスラッグのページはすでにあります（',
          appLink(`/p/${slug}`, '開く'),
          '）',
        );
      } else {
        message.textContent = `作成に失敗しました（${errorMessage(e)}）`;
      }
      return;
    }
    navigate(`/p/${slug}`);
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void create();
  });
  return form;
}

/**
 * 一覧で縮小できる下限。上限の 500 ページを格子に並べた大きさでも、全体が収まる。
 * リンクが 50 段以上つながる鎖は縦に伸びるので、この倍率でも収まらない
 */
const INDEX_MIN_ZOOM = 0.05;

/**
 * 付箋にポインタを載せている間、そのページにつながる線だけを目立たせる（他の線は薄くする）。
 * リンクの多い一覧では線が重なるので、見たいページの線をたどれるようにする。
 * 線の id は「リンク元>リンク先」（index-board.ts）で、スラッグに `>` は入らない。
 */
function highlightLinksOnHover(canvas: HTMLElement): void {
  let current: string | undefined;
  const show = (slug: string | undefined) => {
    if (slug === current) return;
    current = slug;
    canvas.classList.toggle('index-focus', slug !== undefined);
    for (const group of canvas.querySelectorAll<SVGElement>('.wema-edge-group')) {
      const [from, to] = (group.dataset.edgeId ?? '').split('>');
      group.classList.toggle('index-linked', slug !== undefined && (from === slug || to === slug));
    }
  };
  canvas.addEventListener('pointerover', (e) => {
    show((e.target as Element).closest<HTMLElement>('.wema-note')?.dataset.noteId);
  });
  canvas.addEventListener('pointerleave', () => show(undefined));
}

/**
 * 最後に一覧を離れたときの、絞り込み（URL の検索の部分）と表示位置。ページから戻ってきたときに、
 * 見ていた場所から始めるのに使う。ページを読み込み直すと消える（一覧の並びは、ページの増減で変わるので、
 * ブラウザには保存しない）
 */
let lastSeen: { search: string; viewport: WemaViewport } | undefined;

/** `arrival` は、どのように切り替わってきたか（ページから戻ってきたなら、そのページの付箋から広げる） */
export function openIndex(app: HTMLElement, arrival?: Transition): void {
  document.title = 'wema-kake';
  const signal = viewSignal();

  const search = textInput({
    type: 'search',
    className: 'index-search',
    placeholder: 'ページを絞り込む',
    maxLength: MAX_QUERY_LENGTH,
    value: new URLSearchParams(location.search).get('q') ?? '',
  });
  const count = el('span', { className: 'index-count' });
  // ズームのボタンは、ボードができてから入れる
  const zoomSlot = el('span', { className: 'tool-group optional' });
  // 新規ページの入力欄は常には出さず、ボタンを押したときに開く
  const form = newPageForm();
  const newPage = popover(
    el('button', { type: 'button', className: 'text-button primary', textContent: '＋ 新規ページ' }),
    form,
    { align: 'right', onOpen: () => form.querySelector('input')?.focus() },
  );
  // ボードを置く要素。大きさは表示領域に固定し、はみ出した付箋へは wema のパンで移動する
  const canvas = el('div', { className: 'index-canvas' });
  app.append(
    header(
      [el('h1', { textContent: 'wema-kake' })],
      [search, count, zoomSlot],
      [bookmarksMenu(), recentPagesMenu(), newPage.root],
    ),
    canvas,
  );

  let board: WemaBoard | undefined;
  let index: IndexBoard | undefined;
  /** 最後に始めた絞り込み。古い検索の結果が後から届いても使わない */
  let latest = 0;

  /** 最後に絞り込んだ検索語。同じ語でもう一度検索しない */
  let applied: string | undefined;

  /**
   * いま絞り込みで残している付箋 → 一致した子孫のページの数。絞り込んでいなければ null。
   * 一覧にはルートのページしか出ないので、子孫が一致したときは、ルートの付箋を残して、数を付箋に出す。
   * そのページ自身だけが一致したなら、数は 0
   */
  let matched: Map<string, number> | null = null;
  /** 一致の数を出している付箋（絞り込みが変わったときに、元の本文へ戻す） */
  let badged = new Set<string>();

  /** `matched` を、ボードと件数の表示に反映する。表示位置は変えない */
  const showMatched = (note = '') => {
    if (!board || !index) return;
    const total = index.data.notes.length;
    const hits = new Map([...(matched ?? [])].filter(([, descendants]) => descendants > 0));
    for (const id of new Set([...badged, ...hits.keys()])) {
      const text = index.texts.get(id);
      if (text !== undefined) board.updateNote(id, { text: text + descendantHitsHtml(hits.get(id) ?? 0) });
    }
    badged = new Set(hits.keys());
    board.setNoteFilter(matched && [...matched.keys()]);
    count.textContent = matched ? `${matched.size} / ${total} ページ${note}` : `${total} ページ`;
  };

  const applyFilter = async () => {
    if (!board || !index) return;
    const q = search.value.trim();
    if (q === applied) return;
    applied = q;
    history.replaceState(null, '', q ? `/?q=${encodeURIComponent(q)}` : '/');
    const request = ++latest;
    if (q === '') {
      matched = null;
      showMatched();
      // 開いたときと同じ表示位置と倍率へ戻す（配置は、この位置で幅に収まるように組んである）
      board.setViewport({ x: 0, y: 0, zoom: 1 });
      return;
    }
    const show = () => {
      showMatched();
      // 付箋の位置は変えず、残った付箋がすべて見える位置と倍率にする（等倍より大きくはしない）
      board?.fitToContent();
    };
    // 表示名とスラッグは手元で照合し、すぐに反映する
    // （未作成のページは検索の索引にないので、これだけで判定する）
    const needle = q.toLowerCase();
    const found = new Map(
      [...index.searchText].filter(([, text]) => text.includes(needle)).map(([id]): [string, number] => [id, 0]),
    );
    matched = found;
    show();
    // 本文と、子孫のページは、サーバーの検索で照合し、届いたら足す
    try {
      const hits = await api.searchRoots(q);
      // 待っている間に検索語が変わっていたら、古い結果は使わない
      if (request !== latest) return;
      const before = found.size;
      for (const { name, root } of hits) {
        if (!index.searchText.has(root)) continue;
        // 子孫のページが一致したら、そのルートの付箋に数を出す
        found.set(root, (found.get(root) ?? 0) + (name === root ? 0 : 1));
      }
      // 一致が増えたときだけ、表示位置をやり直す（待つ間に動かした表示位置を戻さない）
      if (found.size !== before) show();
      else showMatched();
    } catch (e) {
      if (request === latest) showMatched(`（本文の検索に失敗しました: ${errorMessage(e)}）`);
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => void applyFilter(), SEARCH_DELAY_MS);
  });

  // --- 付箋の上での操作（表示名の変更、ページの削除） ---
  let pages: IndexPage[] = [];
  let links: IndexLink[] = [];
  const build = () =>
    buildIndexBoard(pages, links, { width: canvas.clientWidth, height: canvas.clientHeight }, formatDate);
  const notify = toast(canvas, NOTICE_MS);

  /** 手元の一覧を書き換えた後に、ボードを作り直す。見ている場所と絞り込みは変えない */
  const rebuild = () => {
    if (!board) return;
    // 最後の 1 ページを消したときは、読み込み直して「まだページがありません」を出す
    if (pages.length === 0) return location.reload();
    hideActions();
    index = build();
    board.importData(index.data);
    // importData で、絞り込みと、付箋に足した一致の数の表示がなくなる。同じ結果で掛け直す
    // （検索はやり直さない）。なくなった付箋は外す
    badged = new Set();
    // 作り直さず、中身を減らす。検索の応答を待っている処理が、同じものへ結果を足すため
    for (const id of [...(matched?.keys() ?? [])]) if (!index.searchText.has(id)) matched?.delete(id);
    showMatched();
  };

  /** 手元の一覧から、ページを外す。そのページへのリンクは、未作成のページへのリンクになる */
  const dropPage = (slug: string) => {
    pages = pages.filter((p) => p.name !== slug);
    // 削除したページは、リンクされていれば「未作成」の付箋として残る。子孫の一致の数は出さない
    if (matched?.has(slug)) matched.set(slug, 0);
    links = links
      .filter((l) => l.from_page !== slug)
      .map((l) => (l.to_page === slug ? { ...l, missing: 1 } : l));
    rebuild();
  };

  /** 削除を送っている途中のページ。付箋は残っているが、操作はさせない */
  const deleting = new Set<string>();

  const hideActions = attachNoteActions(canvas, {
    // 未作成のページ（リンクだけがある）は、一覧に含まれないので操作できない
    titleOf: (slug) => (deleting.has(slug) ? undefined : pages.find((p) => p.name === slug)?.title),
    rename(slug, title) {
      api
        // 一覧が古くて、すでに削除されているページは、作り直さずに失敗させる
        .setTitle(slug, title, true)
        .then((result) => {
          pages = pages.map((p) => (p.name === slug ? { ...p, title: result.title } : p));
          rebuild();
        })
        .catch((e: unknown) => {
          if (e instanceof api.ApiError && e.status === 404) {
            notify('このページは、すでに削除されています');
            dropPage(slug);
          } else {
            notify(`表示名の変更に失敗しました（${errorMessage(e)}）`);
          }
        });
    },
    remove(slug) {
      const page = pages.find((p) => p.name === slug);
      if (!page) return;
      if (!confirmDeletePage(page.title ?? slug)) return;
      deleting.add(slug);
      api
        .deletePage(slug)
        .then(() => dropPage(slug))
        .catch((e: unknown) => notify(`削除に失敗しました（${errorMessage(e)}）`))
        .finally(() => deleting.delete(slug));
    },
  });

  api
    .getIndex()
    .then((result) => {
      // 待っている間に、他の画面へ切り替わっていたら、何もしない
      if (signal.aborted) return;
      ({ pages, links } = result);
      if (pages.length === 0) {
        canvas.append(el('p', { className: 'empty', textContent: 'まだページがありません' }));
        return;
      }
      index = build();
      // 参照モード: 編集の UI は出ず、付箋はドラッグできるが、保存はしない。
      // 空いている場所のドラッグとホイールで、表示位置を動かせる
      board = new WemaBoard({
        container: canvas,
        data: index.data,
        viewOnly: true,
        // ページが多くても、全体が収まる倍率まで縮小できるようにする
        minZoom: INDEX_MIN_ZOOM,
        // 付箋のリンクは、その付箋のページを指す。付箋へ寄ってから、ページへ入る。
        // サイト外のリンクと、修飾キーや中ボタンでのクリックは、wema に任せる（新しいタブで開く）
        onLinkClick(url, event) {
          const target = internalLinkTarget(url, event);
          if (target === null) return false;
          const noteId = (event.target as Element).closest<HTMLElement>('.wema-note')?.dataset.noteId;
          if (noteId === undefined) navigate(target);
          else void zoom.enter(noteId, target);
          return true;
        },
      });
      // 離れるときに見ていた場所を覚える。演出つきで離れるときは、演出で動かす前の位置を覚える
      let remembered = false;
      const remember = () => {
        if (remembered) return;
        remembered = true;
        lastSeen = { search: location.search, viewport: created.getViewport() };
      };
      const zoom = zoomTransitions(board, remember);
      // 付箋のリンクからページへは、読み込みなしで切り替わる。そのときに、ボードを破棄する
      // 待っている検索や、改名と削除の応答が、破棄したボードを触らないよう、変数も空にする
      // （applyFilter、showMatched、rebuild は、ボードがなければ何もしない）
      const created = board;
      onViewEnd(() => {
        remember();
        clearTimeout(timer);
        board = undefined;
        created.destroy();
      });
      zoomSlot.append(separator(), zoomControls(board, canvas));
      highlightLinksOnHover(canvas);
      // 表示位置や倍率が動いたら、付箋の上のボタンは位置がずれるので隠す
      board.on('viewport:change', hideActions);
      // 絞り込みで最初の表示位置が決まる。ページから戻ってきたときは、そのページの付箋から、
      // そこまで広げる（付箋の id は、ページのスラッグ）
      // 同じ絞り込みの一覧へ戻ってきたときは、前に見ていた場所から始める
      const seen = lastSeen?.search === location.search ? lastSeen.viewport : undefined;
      void applyFilter().then(() => {
        if (signal.aborted) return;
        if (seen) created.setViewport(seen);
        return zoom.arrive(arrival, (page) => created.getNote(page));
      });
    })
    .catch((e: unknown) => {
      canvas.replaceChildren(
        el('p', { className: 'empty', textContent: `一覧を取得できませんでした（${errorMessage(e)}）` }),
      );
    });
}
