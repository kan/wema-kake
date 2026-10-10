// ヘッダーの部品。ページの画面と一覧の画面で共有する（docs/plan.md のフェーズ 6.5）。
//
// ヘッダーは 1 行で、3 つの区画に分ける。
//   左: 今いる場所   中央: 付箋の操作   右: Wiki の機能
import { enLabels, jaLabels, type WemaBoard, type WemaLabels } from '@kanf/wema';
import { PAGE_COLORS, type PageColor } from '../shared/api';
import { type Child, el } from './dom';
import { LANG_COOKIE } from '../shared/i18n';
import { lang, otherLang, t } from './i18n';
import { type IconName, icon } from './icons';
import { reloadPage, viewSignal } from './navigation';

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

/**
 * 画面に重ねて出す枠（`showModal()` で開く）。「閉じる」のボタン、Escape、枠の外のクリックで閉じる。
 * 画面（`app`）に足して使う
 */
export function modal(className: string, ...children: Child[]): HTMLDialogElement {
  const dialog = el(
    'dialog',
    { className: `modal ${className}` },
    ...children,
    el('form', { method: 'dialog', className: 'modal-foot' }, el('button', { textContent: t('close') })),
  );
  // 枠の外（背景）のクリックでも閉じる。背景のクリックは、対象が dialog そのものになる。
  // 枠の余白のクリックや、文字をドラッグで選んだ後のクリックも同じ対象になるので、座標で見分ける。
  // 中のボタンやチェックボックスは、座標を見ない（キーボードで押したときのクリックは、座標が 0, 0 になる）
  dialog.addEventListener('click', (e) => {
    if (e.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    const inside =
      e.clientX >= box.left && e.clientX <= box.right && e.clientY >= box.top && e.clientY <= box.bottom;
    if (!inside) dialog.close();
  });
  return dialog;
}

/** `PAGE_COLORS` の色の名前（wema の文言のキー） */
const COLOR_LABELS: Record<PageColor, Extract<keyof WemaLabels, `color${string}`>> = {
  '#FFF9C4': 'colorButter',
  '#FFCDD2': 'colorRose',
  '#FFE0B2': 'colorPeach',
  '#E1BEE7': 'colorLavender',
  '#BBDEFB': 'colorSky',
  '#B2DFDB': 'colorMint',
  '#C8E6C9': 'colorSage',
  '#F5F5F5': 'colorGray',
};

/**
 * ページの色を選ぶボタン。押すと、色の一覧が開く。選んだら `pick` を呼ぶ（null は「色なし」）。
 * 今の色は、`show` で渡す（ボタンと、一覧の印に出す）
 */
export function pageColorPicker(pick: (color: string | null) => void): {
  root: HTMLElement;
  show(color: string | null): void;
} {
  const names = lang === 'ja' ? jaLabels : enLabels;
  const trigger = el('button', {
    type: 'button',
    className: 'color-button',
    title: t('page.color'),
    ariaLabel: t('page.color'),
  });
  const panel = el('div', { className: 'color-panel' });
  const picker = popover(trigger, panel);
  const swatches = new Map<string | null, HTMLButtonElement>();
  const swatch = (color: string | null, label: string) => {
    const button = el('button', { type: 'button', className: 'color-swatch', title: label, ariaLabel: label });
    // 色は PAGE_COLORS の固定の値
    if (color !== null) button.style.backgroundColor = color;
    button.addEventListener('click', () => {
      pick(color);
      picker.close();
    });
    swatches.set(color, button);
    panel.append(button);
  };
  for (const color of PAGE_COLORS) swatch(color, names[COLOR_LABELS[color]]);
  swatch(null, t('page.colorNone'));
  return {
    root: picker.root,
    show(color) {
      // サーバーが PAGE_COLORS のどれかであることを確かめた値
      trigger.style.backgroundColor = color ?? '';
      for (const [value, button] of swatches) button.classList.toggle('active', value === color);
    },
  };
}

/** メニューの項目 1 つ */
export function menuItem(label: string, onClick: () => void, className = ''): HTMLButtonElement {
  const item = el('button', { type: 'button', className: `menu-item ${className}`.trim(), textContent: label });
  item.addEventListener('click', onClick);
  return item;
}

/**
 * wema が描く部分（付箋と接続線のポップアップ、文字のツールバー、畳んだ付箋の開閉のリンク）の文言
 * （wema の `labels`）。ボードを作るところで、必ず渡す。日本語は wema に同梱のものを使い、
 * 英語は wema の既定のまま
 */
export const WEMA_LABELS: Partial<WemaLabels> | undefined = lang === 'ja' ? jaLabels : undefined;

/** 選んだ言語を記憶しておく長さ（秒）。1 年 */
const REMEMBER_LANG_SECONDS = 60 * 60 * 24 * 365;

/**
 * 言語を切り替える。選んだ言語をこの端末に記憶して、ページを読み込み直す（文言を定数に入れている
 * モジュールがあるので、表示中の画面の文言は差し替えない）
 */
export function switchLang(): void {
  // 選んだ言語は、Cookie に持つ（サーバーも読む。src/shared/i18n.ts）
  document.cookie = `${LANG_COOKIE}=${otherLang}; Path=/; Max-Age=${REMEMBER_LANG_SECONDS}; SameSite=Lax`;
  // 保存中の変更を送り終えてから、読み込み直す
  void reloadPage();
}

/** 言語を切り替えるボタン（メニューの外に置くとき用）。切り替え先の言語の名前を出す */
export function langButton(): HTMLButtonElement {
  const button = el('button', { type: 'button', className: 'text-button', textContent: t('lang.switch') });
  button.addEventListener('click', switchLang);
  return button;
}

/** Undo と Redo のボタン。有効と無効は、呼ぶ側が決める */
export function historyButtons(board: WemaBoard): { undo: HTMLButtonElement; redo: HTMLButtonElement } {
  return {
    undo: iconButton('undo', t('undo'), () => board.undo()),
    redo: iconButton('redo', t('redo'), () => board.redo()),
  };
}

/** ボタンで拡大と縮小をするときの、1 回の倍率（wema のスタンドアロン版と同じ） */
const ZOOM_STEP = 1.25;

/**
 * 見えている付箋全体の中央が、ボードの中央に来るように動かす。倍率は変えない。
 * wema の `centerContent()` は、全体がボードに収まらないときに左上を表示するので、ここで計算する。
 * 画面上の位置から求めるので、倍率にも絞り込みにも左右されない
 */
export function centerOnNotes(board: WemaBoard, container: HTMLElement): void {
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
  const level = el('button', { type: 'button', className: 'zoom-level', title: t('zoom.reset') });
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
    iconButton('zoomOut', t('zoom.out'), () => board.zoomTo(board.getViewport().zoom / ZOOM_STEP)),
    level,
    iconButton('zoomIn', t('zoom.in'), () => board.zoomTo(board.getViewport().zoom * ZOOM_STEP)),
    iconButton('zoomFit', t('zoom.fit'), () => board.fitToContent()),
    iconButton('center', t('zoom.center'), () => centerOnNotes(board, container)),
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
