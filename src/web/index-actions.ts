// 一覧の付箋の上に出す操作（表示名の変更、ページの削除）。
//
// 付箋の中身は wema がサニタイズして描くので、ボタンを付箋の HTML には入れられない。
// ポインタを載せた付箋の右上に、小さなボタンの列を重ねて出す。
import { MAX_TITLE_LENGTH } from '../shared/api';
import { el, textInput } from './dom';
import { t } from './i18n';
import { iconButton, onPressOutside } from './toolbar';

/** これより小さく表示されている付箋には、ボタンを出さない（縮小して全体を見ているとき） */
const MIN_NOTE_WIDTH = 120;
/** 付箋の角や、表示領域の端との間隔 */
const EDGE = 4;
/** 表示名の入力欄の幅の下限 */
const MIN_FORM_WIDTH = 200;

export interface NoteActionHandlers {
  /** 操作できるページか（未作成のページの付箋には出さない）。できるなら、今の表示名を返す */
  titleOf(slug: string): string | null | undefined;
  rename(slug: string, title: string): void;
  remove(slug: string): void;
}

/**
 * `canvas`（ボードを置いた要素）の付箋に、操作のボタンを付ける。
 * 返す関数は、ボタンを隠す（表示位置が動いたときや、ボードを作り直したときに呼ぶ）。
 */
export function attachNoteActions(canvas: HTMLElement, handlers: NoteActionHandlers): () => void {
  const renameButton = iconButton('edit', t('page.rename'));
  const removeButton = iconButton('trash', t('page.delete'));
  const buttons = el('div', { className: 'note-actions', hidden: true }, renameButton, removeButton);

  const input = textInput({ maxLength: MAX_TITLE_LENGTH, ariaLabel: t('title') });
  const form = el(
    'form',
    { className: 'note-rename', hidden: true },
    input,
    el('button', { type: 'submit', textContent: t('save') }),
  );
  canvas.append(buttons, form);

  /** ボタンを出している付箋のスラッグ */
  let target: string | undefined;

  const noteRect = (slug: string) => {
    const note = canvas.querySelector<HTMLElement>(`.wema-note[data-note-id="${CSS.escape(slug)}"]`);
    if (!note) return undefined;
    const rect = note.getBoundingClientRect();
    const base = canvas.getBoundingClientRect();
    return { left: rect.left - base.left, top: rect.top - base.top, right: rect.right - base.left, width: rect.width };
  };

  const hide = () => {
    target = undefined;
    buttons.hidden = true;
    form.hidden = true;
  };

  /** `box` を (left, top) に置く。表示領域からはみ出すときは、内側へ寄せる */
  const place = (box: HTMLElement, left: number, top: number) => {
    const clamp = (value: number, max: number) => Math.max(EDGE, Math.min(value, max - EDGE));
    box.style.left = `${clamp(left, canvas.clientWidth - box.offsetWidth)}px`;
    box.style.top = `${clamp(top, canvas.clientHeight - box.offsetHeight)}px`;
  };

  const show = (slug: string) => {
    if (slug === target) return;
    const rect = noteRect(slug);
    if (!rect || rect.width < MIN_NOTE_WIDTH || handlers.titleOf(slug) === undefined) return hide();
    target = slug;
    buttons.hidden = false;
    // 付箋の右上の角に、内側へ重ねて出す
    place(buttons, rect.right - buttons.offsetWidth - EDGE, rect.top + EDGE);
  };

  canvas.addEventListener('pointerover', (e) => {
    // 表示名の入力中は、ポインタが外れても閉じない
    if (!form.hidden) return;
    const over = e.target as Element;
    if (buttons.contains(over)) return;
    const slug = over.closest<HTMLElement>('.wema-note')?.dataset.noteId;
    if (slug === undefined) hide();
    else show(slug);
  });
  canvas.addEventListener('pointerleave', () => {
    if (form.hidden) hide();
  });
  // ボタンと入力欄の上での操作を、ボード（パン、付箋のドラッグ）に渡さない
  for (const box of [buttons, form]) {
    for (const type of ['pointerdown', 'dblclick', 'wheel'] as const) {
      box.addEventListener(type, (e) => e.stopPropagation());
    }
  }

  renameButton.addEventListener('click', () => {
    if (target === undefined) return;
    const rect = noteRect(target);
    if (!rect) return hide();
    buttons.hidden = true;
    form.hidden = false;
    form.style.width = `${Math.max(rect.width - EDGE * 2, MIN_FORM_WIDTH)}px`;
    place(form, rect.left + EDGE, rect.top + EDGE);
    input.value = handlers.titleOf(target) ?? '';
    input.placeholder = target;
    input.focus();
    input.select();
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const slug = target;
    const value = input.value.trim();
    hide();
    if (slug !== undefined && value !== (handlers.titleOf(slug) ?? '')) handlers.rename(slug, value);
  });
  input.addEventListener('keydown', (e) => {
    // 日本語入力の変換を取り消す Escape では、閉じない
    if (e.key === 'Escape' && !e.isComposing) hide();
  });
  // 入力欄の外を押したら、変更せずに閉じる。フォーカスの移動では判定しない（ボタンを押しても
  // フォーカスが移らないブラウザがあり、「保存」を押した時点で閉じてしまう）
  onPressOutside(form, form, hide);

  removeButton.addEventListener('click', () => {
    const slug = target;
    hide();
    if (slug !== undefined) handlers.remove(slug);
  });

  return hide;
}
