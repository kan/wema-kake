// 子ページの付箋（meta に子ページのスラッグを持つ付箋）の表示と、置くための入力欄。
//
// 本文の代わりに、子ページの表示名、付箋の枚数、付箋の配置の簡易な再現を出す（wema の renderNote）。
// 表示名を押すと、子ページへ入る。階層の決まりは src/shared/hierarchy.ts と docs/plan.md のフェーズ 6.6。
import type { WemaBoard, WemaNote } from '@kanf/wema';
import { INDEX_DELAY_MS, type PageSummary } from '../shared/api';
import { type ChildRejectCode, childPageOf, MAX_DEPTH, parseChildRejection } from '../shared/hierarchy';
import * as api from './api';
import { el, failureMessage, isPlainClick, textInput } from './dom';
import { t } from './i18n';
import { onViewEnd, viewSignal } from './navigation';
import { checkedSlug, pageFields } from './page-form';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 配置の再現で、付箋の外側に空ける余白（子ページの座標での大きさ） */
const LAYOUT_PADDING = 40;
/** 概要のない子ページの付箋が続けて現れるときに、まとめて 1 回だけ取りに行くための待ち時間 */
const REFRESH_DELAY_MS = 300;
/** 子ページの変更が、索引（付箋の枚数と配置）に反映されるのを待つ時間 */
const INDEXING_WAIT_MS = INDEX_DELAY_MS + 2000;

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
  /** 手元の概要のほうが、索引より新しい子ページ（付箋を移した直後） */
  private readonly ahead = new Set<string>();
  /** 子ページの中身を変えた後の、索引への反映を待つ取り直し */
  private indexedTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * @param slug 今のページ（親ページ）のスラッグ
   * @param open 子ページへ入る。修飾キーなしの左クリックで呼ぶ。`noteId` は、押された付箋
   */
  constructor(
    private readonly slug: string,
    private readonly open: (child: string, noteId: string) => void,
  ) {}

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

    const title = el('a', { className: 'child-title', href: `/p/${child}`, textContent: info?.title ?? child });
    title.addEventListener('click', (e) => {
      // 付箋の選択にしない（ポップアップを出さない）
      e.stopPropagation();
      // 修飾キーつきのクリックと中ボタンは、ブラウザに任せる（リンクなので、新しいタブで開く）
      if (!isPlainClick(e)) return;
      // ふつうのクリックは、読み込みなしで、付箋へ寄ってから子ページへ入る
      e.preventDefault();
      this.open(child, note.id);
    });

    container.classList.add('child-note');
    container.append(title, el('div', { className: 'child-meta', textContent: this.describe(child, info) }));
    if (info) container.append(layoutPreview(parseLayout(info.layout)));
    return true;
  };

  /** 付箋の枚数か、置かれ方がおかしいときの知らせ */
  private describe(child: string, info: PageSummary | null | undefined): string {
    if (info === undefined) return t('loading');
    if (info === null) return t('notFound');
    // 索引の親は、置いた数秒後に反映される。別のページを指しているときだけ、食い違いとして知らせる
    if (info.parent !== null && info.parent !== this.slug) return t('child.elsewhere', info.parent);
    return t('child.summary', info.note_count, child);
  }

  /** ボードにつなぐ */
  attach(board: WemaBoard): void {
    this.board = board;
    // 別のタブで子ページを編集して戻ってきたときに、表示名と枚数を新しくする
    window.addEventListener('focus', () => this.scheduleRefresh(), { signal: viewSignal() });
    onViewEnd(() => {
      // 画面が切り替わったら、ボードは破棄される。予約してある取り直しも止める
      clearTimeout(this.refreshTimer);
      clearTimeout(this.indexedTimer);
      this.board = undefined;
    });
  }

  /** 子ページの表示名。まだ分からなければ、スラッグ */
  titleOf(child: string): string {
    return this.pages.get(child)?.title ?? child;
  }

  /**
   * このページから、子ページの中身を変えた（付箋を移した）。`page` は、変えた後の概要。
   * すぐに描き直し、索引への反映を待って、取り直す
   */
  contentChanged(page: PageSummary): void {
    this.pages.set(page.name, page);
    // 索引に反映されるまでは、取り直すと古い概要が返る。その間は、この概要を上書きしない
    this.ahead.add(page.name);
    const note = this.board?.getNotes().find((n) => childPageOf(n) === page.name);
    if (note) this.board?.refreshNote(note.id);
    // ふつうの取り直しの予約とは、別に持つ（間に取り直しが入っても、反映の後の取り直しを残す）
    clearTimeout(this.indexedTimer);
    this.indexedTimer = setTimeout(() => {
      this.ahead.clear();
      void this.refresh();
    }, INDEXING_WAIT_MS);
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
    // 待っている間に、画面が切り替わっていたら、何もしない
    if (this.board !== board) return;
    const byName = new Map(found.map((page) => [page.name, page]));
    for (const [name, noteId] of placed) {
      if (this.ahead.has(name)) continue;
      this.pages.set(name, byName.get(name) ?? null);
      // 描き直す。概要が入ったので、ここからの render は、取り直しを予約しない
      board.refreshNote(noteId);
    }
  }
}

/** 子ページとして置けなかった理由の、画面に出す文言 */
const REJECTION: Record<ChildRejectCode, string> = {
  'not-found': t('child.reject.not-found'),
  self: t('child.reject.self'),
  'other-parent': t('child.reject.other-parent'),
  duplicate: t('child.reject.duplicate'),
  ancestor: t('child.reject.ancestor'),
  'too-deep': t('child.reject.too-deep', MAX_DEPTH),
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
  const submit = el('button', { type: 'submit', textContent: t('child.createAndPlace') });
  const createForm = el(
    'form',
    { className: 'new-page' },
    el('strong', { textContent: t('child.newHeading') }),
    ...fields.labels,
    submit,
  );

  const roots = el('datalist', { id: 'child-page-roots' });
  const existingInput = textInput({ placeholder: t('child.slugPlaceholder') });
  existingInput.setAttribute('list', roots.id);
  const existingForm = el(
    'form',
    { className: 'new-page' },
    el('strong', { textContent: t('child.existingHeading') }),
    el('label', {}, t('child.rootPage'), existingInput),
    roots,
    el('button', { type: 'submit', textContent: t('child.placeExisting') }),
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
            ? t('child.slugTaken')
            : failureMessage('failed.create', error);
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
      return t('child.rejected', why, created.has(rejection.page));
    },
  };
}
