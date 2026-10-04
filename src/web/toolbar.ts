// ヘッダーの部品。ページの画面と一覧の画面で共有する（docs/plan.md のフェーズ 6.5）。
//
// ヘッダーは 1 行で、3 つの区画に分ける。
//   左: 今いる場所   中央: 付箋の操作   右: Wiki の機能
import type { WemaBoard } from '@kanf/wema';
import { type Child, el } from './dom';
import { type IconName, icon } from './icons';
import { viewSignal } from './navigation';

/** 3 つの区画を持つヘッダー */
export function header(left: Child[], tools: Child[], right: Child[]): HTMLElement {
  return el(
    'header',
    { className: 'page-header' },
    el('div', { className: 'zone zone-left' }, ...left),
    el('div', { className: 'zone zone-tools' }, ...tools),
    el('div', { className: 'zone zone-right' }, ...right),
  );
}

/** アイコンだけのボタン。説明は `title` で出す */
export function iconButton(name: IconName, title: string, onClick?: () => void): HTMLButtonElement {
  const button = el('button', { type: 'button', className: 'icon-button', title, ariaLabel: title }, icon(name));
  if (onClick) button.addEventListener('click', onClick);
  return button;
}

export const separator = () => el('span', { className: 'separator' });

/**
 * `panel` が出ている間に、`root` の外が押されたら `close` を呼ぶ。
 * キャプチャの段階で受ける。wema はパンやリサイズを始めるときにイベントの伝播を止めるので、
 * 通常の段階で受けると、ボードを押しても閉じないことがある
 */
export function onPressOutside(panel: HTMLElement, root: HTMLElement, close: () => void): void {
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (!panel.hidden && !root.contains(e.target as Node)) close();
    },
    // 画面が切り替わったら外す
    { capture: true, signal: viewSignal() },
  );
}

/**
 * ボタンを押すと開く小さなパネル（メニュー、整列、リンク元、新規ページ）。
 * パネルの外をクリックするか、Escape で閉じる。
 */
export function popover(
  trigger: HTMLButtonElement,
  panel: HTMLElement,
  options: { onOpen?: () => void; align?: 'left' | 'right' } = {},
): { root: HTMLElement; close: () => void } {
  panel.classList.add('popover-panel', `popover-${options.align ?? 'left'}`);
  panel.hidden = true;
  const root = el('span', { className: 'popover' }, trigger, panel);
  const close = () => {
    panel.hidden = true;
    trigger.ariaExpanded = 'false';
  };
  trigger.ariaExpanded = 'false';
  trigger.addEventListener('click', () => {
    if (!panel.hidden) return close();
    panel.hidden = false;
    trigger.ariaExpanded = 'true';
    options.onOpen?.();
  });
  onPressOutside(panel, root, close);
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape' && !panel.hidden) close();
    },
    { signal: viewSignal() },
  );
  return { root, close };
}

/** メニューの項目 1 つ */
export function menuItem(label: string, onClick: () => void, className = ''): HTMLButtonElement {
  const item = el('button', { type: 'button', className: `menu-item ${className}`.trim(), textContent: label });
  item.addEventListener('click', onClick);
  return item;
}

/** ボタンで拡大と縮小をするときの、1 回の倍率（wema のスタンドアロン版と同じ） */
const ZOOM_STEP = 1.25;

/**
 * 見えている付箋全体の中央が、ボードの中央に来るように動かす。倍率は変えない。
 * wema の `centerContent()` は、全体がボードに収まらないときに左上を表示するので、ここで計算する。
 * 画面上の位置から求めるので、倍率にも絞り込みにも左右されない
 */
function centerOnNotes(board: WemaBoard, container: HTMLElement): void {
  const rects = [...container.querySelectorAll<HTMLElement>('.wema-note')]
    .filter((note) => note.offsetParent !== null)
    .map((note) => note.getBoundingClientRect());
  if (rects.length === 0) return;
  const middle = (low: number[], high: number[]) => (Math.min(...low) + Math.max(...high)) / 2;
  const box = container.getBoundingClientRect();
  const { x, y } = board.getViewport();
  board.setViewport({
    x: x + (box.left + box.right) / 2 - middle(rects.map((r) => r.left), rects.map((r) => r.right)),
    y: y + (box.top + box.bottom) / 2 - middle(rects.map((r) => r.top), rects.map((r) => r.bottom)),
  });
}

/**
 * 表示のボタン（縮小、倍率、拡大、全体が収まるように縮小、中央へ移動）。倍率の表示は wema の
 * イベントに合わせる。`container` は、ボードを置いた要素
 */
export function zoomControls(board: WemaBoard, container: HTMLElement): HTMLElement {
  const level = el('button', { type: 'button', className: 'zoom-level', title: '等倍に戻す' });
  level.addEventListener('click', () => board.zoomTo(1));
  // viewport:change はパンでも届くので、倍率の表示が変わるときだけ書き換える
  let shown = '';
  const show = (zoom: number) => {
    const text = `${Math.round(zoom * 100)}%`;
    if (text === shown) return;
    shown = text;
    level.textContent = text;
  };
  board.on('viewport:change', ({ zoom }) => show(zoom));
  show(board.getViewport().zoom);
  return el(
    'span',
    { className: 'tool-group' },
    iconButton('zoomOut', '縮小', () => board.zoomTo(board.getViewport().zoom / ZOOM_STEP)),
    level,
    iconButton('zoomIn', '拡大', () => board.zoomTo(board.getViewport().zoom * ZOOM_STEP)),
    iconButton('zoomFit', '全体が収まるように縮小', () => board.fitToContent()),
    iconButton('center', '付箋全体の中央へ移動（倍率はそのまま）', () => centerOnNotes(board, container)),
  );
}

/** 通知を、ボードの上に重ねて出す。ヘッダーの幅を取らないので、他の要素が動かない */
export function toast(host: HTMLElement, durationMs: number): (text: string) => void {
  const box = el('div', { className: 'toast', hidden: true, role: 'status' });
  host.append(box);
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (text) => {
    box.textContent = text;
    box.hidden = false;
    clearTimeout(timer);
    timer = setTimeout(() => {
      box.hidden = true;
    }, durationMs);
  };
}

/** ブラウザごとの設定。保存できない環境（プライベートブラウズなど）では、既定値で動く */
export const settings = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(`wema-kake:${key}`);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(`wema-kake:${key}`, value);
    } catch {
      // 保存できなくても、この画面では動く
    }
  },
};
