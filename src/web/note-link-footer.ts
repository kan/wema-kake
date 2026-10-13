// 付箋のつながりの印を、付箋の下に描く（issue #11）。
//
// 付箋を縦に積んでいる間（stacked-view.ts）は、wema が接続線を表示しない。代わりに、付箋の下に、
// つながっている相手を印として並べる。印を押すと、相手の付箋が見える位置までスクロールする。
// 描く場所は、wema の renderNoteFooter（0.14.0）。wema が呼ぶのは、積んでいる間だけ。
// 印の中身を決める計算は note-links.ts にある。
import type { WemaBoard, WemaNote } from '@kanf/wema';
import { childPageOf } from '../shared/hierarchy';
import { el } from './dom';
import { t } from './i18n';
import { type LinkDirection, type NoteLink, noteLinks } from './note-links';

/** 向きを表す記号 */
const ARROW: Record<LinkDirection, string> = { out: '→', in: '←', both: '↔', none: '―' };

/** 印を押したときに、相手の付箋を強調する間、付箋の要素に付けるクラス（style.css） */
const FLASH_CLASS = 'note-link-target';

/** 付箋を、少しの間だけ強調する。続けて押されたら、最初からやり直す */
function flash(note: HTMLElement): void {
  note.classList.remove(FLASH_CLASS);
  // クラスを付け直しても、間で描画の計算を挟まないと、アニメーションは最初から始まらない
  void note.offsetWidth;
  note.classList.add(FLASH_CLASS);
  note.addEventListener('animationend', () => note.classList.remove(FLASH_CLASS), { once: true });
}

/** 読み上げ用の説明 */
function describe(link: NoteLink, text: string): string {
  const what = t(`links.${link.direction}`, text);
  return link.label === undefined ? what : t('links.labeled', what, link.label);
}

/**
 * 1 つのボードの、付箋のつながりの印を受け持つ。
 * `render` を WemaBoard の `renderNoteFooter` に渡し、ボードを作った後に `attach` を呼ぶ。
 */
export class NoteLinkFooters {
  private board: WemaBoard | undefined;

  /** @param titleOf 子ページの表示名を返す。子ページの付箋を置かないボードでは、省略する */
  constructor(private readonly titleOf: (child: string) => string = (child) => child) {}

  /**
   * wema の `renderNoteFooter`。つながっている付箋があれば、印を描いて true を返す。
   * wema は、きっかけになった処理が終わってから呼ぶので、ここで接続線と相手の付箋を調べられる
   */
  readonly render = (note: WemaNote, container: HTMLElement): boolean => {
    const board = this.board;
    if (!board) return false;
    const links = noteLinks(note.id, board.getEdgesOf(note.id), (id) => board.getNote(id), this.titleOf);
    if (links.length === 0) return false;
    // 並べ方は、中に入れた要素で決める（container の表示の指定は、wema の CSS が持っている）
    container.append(el('div', { className: 'note-links' }, ...links.map((link) => this.chip(board, link))));
    return true;
  };

  private chip(board: WemaBoard, link: NoteLink): HTMLButtonElement {
    const text = link.text === '' ? t('links.empty') : link.text;
    const chip = el(
      'button',
      {
        type: 'button',
        className: 'note-link',
        ariaLabel: describe(link, text),
        // 非表示の付箋（接続線の折り畳み）へは、移れない
        disabled: board.isNoteHidden(link.peer),
      },
      el('span', { className: 'note-link-arrow', textContent: ARROW[link.direction] }),
      link.label !== undefined && el('span', { className: 'note-link-label', textContent: link.label }),
      // 相手の本文は、文字として入れる（wema は、この要素の中身をサニタイズしない）
      el('span', { className: 'note-link-text', textContent: text }),
    );
    chip.addEventListener('click', () => {
      board.revealNotes([link.peer]);
      // 相手がすでに見えていると、スクロールしない。どの付箋が相手かを、少しの間の強調で示す
      const peer = chip
        .closest('.wema-board')
        ?.querySelector<HTMLElement>(`.wema-note[data-note-id="${CSS.escape(link.peer)}"]`);
      if (peer) flash(peer);
    });
    return chip;
  }

  /**
   * 付箋を描き直す。印が出るのは積んでいる間だけなので、それ以外では何もしない（`refreshNote()` は、
   * 利用側が描いた付箋の中身も描き直す。積み始めるときは、wema が全部の付箋の印を描く）
   */
  private refresh(ids: Iterable<string>): void {
    const board = this.board;
    if (!board || board.getStacked() === null) return;
    // 同じ付箋は、1 回だけ描き直す
    for (const id of new Set(ids)) board.refreshNote(id);
  }

  /** 付箋 `ids` を印に出している付箋（つながっている相手）の印を、描き直す */
  readonly refreshPeers = (...ids: string[]): void => {
    const board = this.board;
    if (!board) return;
    this.refresh(ids.flatMap((id) => board.getEdgesOf(id).map((edge) => (edge.from === id ? edge.to : edge.from))));
  };

  /**
   * ボードにつなぐ。印に出しているものが変わったら、描き直す。wema が自分で描き直すのは、その付箋の
   * 本文か meta が変わったときだけで、接続線と、相手の付箋が変わったときは、ここから頼む
   */
  attach(board: WemaBoard): void {
    this.board = board;
    const refreshEnds = ({ edge }: { edge: { from: string; to: string } }) => this.refresh([edge.from, edge.to]);
    board.on('edge:create', refreshEnds);
    board.on('edge:update', refreshEnds);
    board.on('edge:delete', refreshEnds);
    board.on('note:update', ({ note, prev }) => {
      // 相手の付箋の冒頭が変わり得るのは、本文と、子ページの付箋の指すページ
      if (note.text !== prev.text || childPageOf(note) !== childPageOf(prev)) this.refreshPeers(note.id);
    });
    board.on('note:visibility', ({ hidden, shown }) => this.refreshPeers(...hidden, ...shown));
  }
}
