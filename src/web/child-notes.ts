// 子ページの付箋（meta に子ページのスラッグを持つ付箋）の表示と、置くための入力欄。
//
// 本文の代わりに、子ページの表示名、付箋の枚数、付箋の配置の簡易な再現を出す（wema の renderNote）。
// 表示名を押すと、子ページへ入る。階層の決まりは src/shared/hierarchy.ts と docs/plan.md のフェーズ 6.6。
import type { WemaBoard, WemaNote } from '@kanf/wema';
import type { PageSummary } from '../shared/api';
import { type ChildRejectCode, childPageOf, MAX_DEPTH, parseChildRejection } from '../shared/hierarchy';
import * as api from './api';
import { el, errorMessage, textInput } from './dom';
import { checkedSlug, pageFields } from './page-form';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 配置の再現で、付箋の外側に空ける余白（子ページの座標での大きさ） */
const LAYOUT_PADDING = 40;
/** 概要のない子ページの付箋が続けて現れるときに、まとめて 1 回だけ取りに行くための待ち時間 */
const REFRESH_DELAY_MS = 300;

/** 子ページの付箋の大きさ。配置の再現が入るよう、ふつうの付箋より少し大きくする */
export const CHILD_NOTE_SIZE = { width: 240, height: 180 };

type LayoutNote = [x: number, y: number, width: number, height: number, color: string];

function parseLayout(json: string | null): LayoutNote[] {
  if (!json) return [];
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? (value as LayoutNote[]) : [];
  } catch {
    return [];
  }
}

/** 子ページの付箋の配置を、SVG で簡易に再現する。位置、大きさ、色だけを使う */
function layoutPreview(notes: LayoutNote[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'child-layout');
  if (notes.length === 0) return svg;
  const left = Math.min(...notes.map(([x]) => x)) - LAYOUT_PADDING;
  const top = Math.min(...notes.map(([, y]) => y)) - LAYOUT_PADDING;
  const right = Math.max(...notes.map(([x, , width]) => x + width)) + LAYOUT_PADDING;
  const bottom = Math.max(...notes.map(([, y, , height]) => y + height)) + LAYOUT_PADDING;
  svg.setAttribute('viewBox', `${left} ${top} ${right - left} ${bottom - top}`);
  for (const [x, y, width, height, color] of notes) {
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', String(x));
    rect.setAttribute('y', String(y));
    rect.setAttribute('width', String(width));
    rect.setAttribute('height', String(height));
    // 色は付箋のデータで、サーバーが形を検証している。属性として渡すので、式としては解釈されない
    rect.setAttribute('fill', color);
    svg.append(rect);
  }
  return svg;
}

/**
 * 1 つのボードの、子ページの付箋の表示を受け持つ。
 * `render` を WemaBoard の `renderNote` に渡し、ボードを作った後に `attach` を呼ぶ。
 */
export class ChildNotes {
  /** 子ページの概要。未作成か削除済みのページは null。まだ取得していなければ、キーがない */
  private readonly pages = new Map<string, PageSummary | null>();
  private board: WemaBoard | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  /** @param slug 今のページ（親ページ）のスラッグ */
  constructor(private readonly slug: string) {}

  /**
   * wema の `renderNote`。子ページの付箋なら、中身を描いて true を返す。
   * 付箋を作ったとき（読み込み、他の人の変更、Undo での復活を含む）と、`meta` が変わったときに呼ばれる
   */
  readonly render = (note: WemaNote, container: HTMLElement): boolean => {
    const child = childPageOf(note);
    if (child === undefined) return false;
    // 概要のない子ページが現れたら、取りに行く
    if (!this.pages.has(child)) this.scheduleRefresh();
    const info = this.pages.get(child);

    // リンクなので、押せば子ページへ移る（修飾キーつきなら、新しいタブで開く）
    const title = el('a', { className: 'child-title', href: `/p/${child}`, textContent: info?.title ?? child });
    // 付箋の選択にしない（ポップアップを出さない）
    title.addEventListener('click', (e) => e.stopPropagation());

    container.classList.add('child-note');
    container.append(title, el('div', { className: 'child-meta', textContent: this.describe(child, info) }));
    if (info) container.append(layoutPreview(parseLayout(info.layout)));
    return true;
  };

  /** 付箋の枚数か、置かれ方がおかしいときの知らせ */
  private describe(child: string, info: PageSummary | null | undefined): string {
    if (info === undefined) return '読み込み中…';
    if (info === null) return 'ページが見つかりません';
    // 索引の親は、置いた数秒後に反映される。別のページを指しているときだけ、食い違いとして知らせる
    if (info.parent !== null && info.parent !== this.slug) return `「${info.parent}」に置かれています`;
    return `子ページ・付箋 ${info.note_count} 枚（/p/${child}）`;
  }

  /** ボードにつなぐ */
  attach(board: WemaBoard): void {
    this.board = board;
    // 別のタブで子ページを編集して戻ってきたときに、表示名と枚数を新しくする
    window.addEventListener('focus', () => this.scheduleRefresh());
  }

  /** 置いてある子ページの概要を、取り直す。予約が重なったら、1 回にまとめる */
  private scheduleRefresh(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refresh(), REFRESH_DELAY_MS);
  }

  private async refresh(): Promise<void> {
    const board = this.board;
    if (!board) return;
    const placed = new Map<string, string>();
    for (const note of board.getNotes()) {
      const child = childPageOf(note);
      if (child !== undefined) placed.set(child, note.id);
    }
    if (placed.size === 0) return;
    let found: PageSummary[];
    try {
      found = await api.getPagesInfo([...placed.keys()]);
    } catch {
      // 取得できなくても、スラッグだけの表示で使える。次のきっかけ（ウィンドウへ戻る）で取り直す
      return;
    }
    const byName = new Map(found.map((page) => [page.name, page]));
    for (const [name, noteId] of placed) {
      this.pages.set(name, byName.get(name) ?? null);
      // 描き直す。概要が入ったので、ここからの render は、取り直しを予約しない
      board.refreshNote(noteId);
    }
  }
}

/** 子ページとして置けなかった理由の、画面に出す文言 */
const REJECTION: Record<ChildRejectCode, string> = {
  'not-found': 'ページが見つかりません',
  self: '自分自身は置けません',
  'other-parent': 'すでに別のページの子になっています',
  duplicate: 'このページにすでに置いてあります',
  ancestor: 'このページの先祖なので、輪になります',
  'too-deep': `階層は ${MAX_DEPTH} 段までです`,
};

/**
 * 子ページを置くための入力欄。新しいページを作って置くか、既存のルートのページを選んで置く。
 * 置けるかどうかの検査はサーバーが行う。ここでは、付箋を置く処理（`place`）を呼ぶだけ
 */
export function childPageForm(
  parent: string,
  place: (child: string) => void,
): {
  root: HTMLElement;
  opened: () => void;
  /** サーバーが変更を断った理由が、子ページとして置けなかったことなら、通知の文言を返す */
  rejectionMessage: (reason: string) => string | undefined;
} {
  /** この入力欄から作ったページ。置くのを断られても、ルートのページとして残る */
  const created = new Set<string>();
  const fields = pageFields();
  const message = el('div', { className: 'form-error' });
  const submit = el('button', { type: 'submit', textContent: '作成して置く' });
  const createForm = el(
    'form',
    { className: 'new-page' },
    el('strong', { textContent: '新しいページを作って置く' }),
    ...fields.labels,
    submit,
  );

  const roots = el('datalist', { id: 'child-page-roots' });
  const existingInput = textInput({ placeholder: 'ページの名前（スラッグ）' });
  existingInput.setAttribute('list', roots.id);
  const existingForm = el(
    'form',
    { className: 'new-page' },
    el('strong', { textContent: '既存のページを置く' }),
    el('label', {}, 'ルートのページ', existingInput),
    roots,
    el('button', { type: 'submit', textContent: '置く' }),
  );

  createForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const slug = checkedSlug(fields.slug, message);
    if (slug === undefined) return;
    // 二度押しで、同じページを 2 回作りに行かない
    submit.disabled = true;
    api
      .createPage(slug, fields.title.value)
      .then(() => {
        created.add(slug);
        place(slug);
      })
      .catch((error: unknown) => {
        message.textContent =
          error instanceof api.ApiError && error.status === 409
            ? 'そのスラッグのページはすでにあります。既存のページとして置けます'
            : `作成に失敗しました（${errorMessage(error)}）`;
      })
      .finally(() => {
        submit.disabled = false;
      });
  });
  existingForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const slug = checkedSlug(existingInput, message);
    if (slug !== undefined) place(slug);
  });

  return {
    root: el('div', { className: 'child-form' }, createForm, existingForm, message),
    opened() {
      message.textContent = '';
      existingInput.value = '';
      fields.reset();
      // 一覧に出ているのが、ルートのページ。自分自身は置けないので外す
      api
        .getIndex()
        .then(({ pages }) => {
          roots.replaceChildren(
            ...pages
              .filter((page) => page.name !== parent)
              .map((page) => el('option', { value: page.name, label: page.title ?? page.name })),
          );
        })
        .catch(() => {
          // 候補が出ないだけで、スラッグを入力すれば置ける
        });
    },
    rejectionMessage(reason) {
      const rejection = parseChildRejection(reason);
      if (!rejection) return undefined;
      const why = REJECTION[rejection.code] ?? reason;
      // 「作成して置く」で作ったページは、置けなくても消えない
      const kept = created.has(rejection.page) ? '。作成したページは、ルートのページとして一覧に残っています' : '';
      return `子ページとして置けませんでした（${why}）${kept}`;
    },
  };
}
