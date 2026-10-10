// 付箋を、子ページの付箋の上へドラッグして放すと、その子ページへ移す。
// Ctrl / Cmd を押したまま放すと、移さずに写す（元の付箋は、動かす前の位置へ戻る）。
//
// wema には、付箋を放したことを知らせるイベントがない。付箋の上で押し始めたポインターが離れた
// ときに、位置だけを変える操作が確定したら（history:commit）、ドラッグの終わりとして扱う。
import type { WemaBoard, WemaNote } from '@kanf/wema';
import type { PageSummary } from '../shared/api';
import { childPageOf } from '../shared/hierarchy';
import * as api from './api';
import { failureMessage } from './dom';
import { t } from './i18n';
import { viewSignal } from './navigation';

/** ドラッグで変わるフィールド（重なりの順は、ドラッグを始めたときに前面へ出すので変わる） */
const DRAG_KEYS = new Set(['x', 'y', 'zIndex']);

/** 放せる子ページの付箋に付けるクラス */
const TARGET_CLASS = 'drop-target';
/** 子ページへ送っている途中の付箋に付けるクラス（見えなくする） */
const LEAVING_CLASS = 'note-leaving';

type Position = Pick<Partial<WemaNote>, 'x' | 'y'>;

export interface NoteDropOptions {
  /** 今のページのスラッグ */
  slug: string;
  /** サーバーへ送る clientId（同期と同じもの） */
  clientId: string;
  /** 子ページの表示名（知らせに出す） */
  titleOf(child: string): string;
  notify(text: string): void;
  /** 子ページへ付箋を送り終えた。`page` は、置いた後の子ページの概要 */
  onSent(page: PageSummary): void;
}

/**
 * @returns `settled` は、送っている途中の付箋が、送り終わる（このページから消し終わる）のを待つ。
 *   他のページへ切り替える前に待つこと（待たないと、送った付箋が、このページにも残る）
 */
export function dropOntoChildPages(
  board: WemaBoard,
  container: HTMLElement,
  options: NoteDropOptions,
): { settled(): Promise<void> } {
  const signal = viewSignal();
  /** 送っている途中の付箋 */
  const pending = new Set<Promise<void>>();
  /** 押し始めた付箋と、そのときの位置。付箋の上で押していなければ undefined */
  let pressed: { id: string; x: number; y: number } | undefined;
  /** 付箋の上で押し始めたポインターが、離れた位置。同じイベントの処理が済んだら消す */
  let released: { x: number; y: number; copy: boolean } | undefined;
  let marked: HTMLElement | undefined;

  const isChildNote = (id: string) => {
    const note = board.getNote(id);
    return note !== undefined && childPageOf(note) !== undefined;
  };

  /**
   * 画面の位置で、運んでいる付箋（`carried`）のすぐ下に見えている付箋が、子ページの付箋なら、
   * その要素。ふつうの付箋に隠れている子ページの付箋は、対象にしない（重ねて置いただけで、移さない）。
   * 重なりの順と、見えているかは、ブラウザに任せる
   */
  const targetAt = (clientX: number, clientY: number, carried: Set<string>): HTMLElement | undefined => {
    const top = document
      .elementsFromPoint(clientX, clientY)
      .find(
        (el): el is HTMLElement =>
          el instanceof HTMLElement &&
          el.matches('.wema-note') &&
          container.contains(el) &&
          !carried.has(el.dataset.noteId ?? ''),
      );
    return top && isChildNote(top.dataset.noteId ?? '') ? top : undefined;
  };

  const noteElement = (id: string) =>
    container.querySelector<HTMLElement>(`.wema-note[data-note-id="${CSS.escape(id)}"]`);

  /** 放せる子ページの付箋に、印を付ける（`next` がなければ、外す） */
  const mark = (next: HTMLElement | undefined) => {
    if (next === marked) return;
    marked?.classList.remove(TARGET_CLASS);
    next?.classList.add(TARGET_CLASS);
    marked = next;
  };

  // wema より先に受け取る（wema は、ポインターが離れたときに、同期的に操作を確定する）
  const listen = { capture: true, signal };
  window.addEventListener('pointerdown', (e) => {
    // 2 本目の指では、押し始めた付箋を変えない
    if (!e.isPrimary) return;
    const el = e.target instanceof Element ? e.target.closest<HTMLElement>('.wema-note') : null;
    const note = e.button === 0 && el && container.contains(el) ? board.getNote(el.dataset.noteId ?? '') : undefined;
    pressed = note && { id: note.id, x: note.x, y: note.y };
  }, listen);
  window.addEventListener('pointermove', (e) => {
    if (!pressed) return;
    const note = board.getNote(pressed.id);
    // 付箋が動いていなければ、ドラッグではない（本文の文字を選んでいる、など）
    if (!note || (note.x === pressed.x && note.y === pressed.y) || board.isViewOnly()) return mark(undefined);
    // 選択中の付箋をドラッグすると、選択中の付箋がまとめて動く
    const selection = board.getSelection();
    const carried = new Set(selection.includes(pressed.id) ? selection : [pressed.id]);
    // 子ページの付箋だけを運んでいるときは、放しても移さない
    mark([...carried].every(isChildNote) ? undefined : targetAt(e.clientX, e.clientY, carried));
  }, listen);
  const release = (e: PointerEvent) => {
    if (!e.isPrimary) return;
    mark(undefined);
    if (pressed && e.type === 'pointerup') {
      released = { x: e.clientX, y: e.clientY, copy: e.ctrlKey || e.metaKey };
      // 確定は、このイベントの中で届く。届かなければ（動かしていない）、次の操作に持ち越さない
      setTimeout(() => (released = undefined));
    }
    pressed = undefined;
  };
  window.addEventListener('pointerup', release, listen);
  window.addEventListener('pointercancel', release, listen);

  board.on('history:commit', ({ deltas, origin }) => {
    const drop = released;
    released = undefined;
    // 参照モードの間の移動は、終えると元へ戻る。その間は、移さない
    if (!drop || origin !== 'user' || board.isViewOnly()) return;
    /** 動かした付箋と、動かす前の位置 */
    const before = new Map<string, Position>();
    for (const d of deltas) {
      if (d.type !== 'note:update' || !Object.keys(d.after).every((key) => DRAG_KEYS.has(key))) return;
      // 同じ付箋のデルタが続くなら、最初のものが、動かす前の位置
      const { zIndex: _, ...position } = d.before;
      before.set(d.noteId, { ...position, ...before.get(d.noteId) });
    }
    const target = board.getNote(targetAt(drop.x, drop.y, new Set(before.keys()))?.dataset.noteId ?? '');
    const child = target && childPageOf(target);
    // 子ページの付箋は、移さない（ページの親を変えることになる）。一緒に運んでいたら、元の位置へ戻す
    const ids = [...before.keys()].filter((id) => board.getNote(id) !== undefined && !isChildNote(id));
    if (child === undefined || ids.length === 0) return;
    const sending = send(child, ids, before, drop.copy).finally(() => pending.delete(sending));
    pending.add(sending);
  });

  /** 付箋 `ids` を、子ページ `child` へ送る。送り終えたら、このページの付箋を消す（写すときは残す） */
  async function send(child: string, ids: string[], before: Map<string, Position>, copy: boolean): Promise<void> {
    // 送り先での id。同じ付箋を 2 回写しても、重ならない
    const newIds = new Map(ids.map((id) => [id, crypto.randomUUID()]));
    const notes = ids.map((id) => ({ ...board.getNote(id)!, id: newIds.get(id)! }));
    // 送る付箋どうしをつなぐ接続線は、一緒に送る。残る付箋との接続線は、送らない
    const edges = board
      .getEdges()
      .filter((edge) => newIds.has(edge.from) && newIds.has(edge.to))
      .map((edge) => ({ ...edge, id: crypto.randomUUID(), from: newIds.get(edge.from)!, to: newIds.get(edge.to)! }));
    const body = { clientId: options.clientId, opId: crypto.randomUUID(), from: options.slug, notes, edges };

    /** `which` に合う付箋を、動かす前の位置へ戻す */
    const putBack = (which: (id: string) => boolean) => {
      const back = [...before].filter(([id]) => which(id) && board.getNote(id) !== undefined);
      if (back.length > 0) board.batch(() => back.forEach(([id, position]) => board.updateNote(id, position)));
    };
    // 操作の確定（history:commit）を処理している途中では、ボードを書き換えない
    await Promise.resolve();
    // 応答を待たずに、見た目を先に済ませる。移す付箋は、送り終えるまで見えなくしておく（消すのは、
    // 送れてから）。残る付箋（写す付箋、一緒に運んでいた子ページの付箋）は、動かす前の位置へ戻す
    const moving = (id: string) => !copy && newIds.has(id);
    const leaving = ids.filter(moving).flatMap((id) => noteElement(id) ?? []);
    for (const el of leaving) el.classList.add(LEAVING_CLASS);
    putBack((id) => !moving(id));

    const result = await api
      .sendNotes(child, body)
      .catch((error: unknown) => {
        // 断られたのなら、送り直さない。応答を受け取れなかっただけなら、置かれたかどうかが分からない
        // ので、同じ opId でもう一度だけ送る（置かれていれば、サーバーは二重には置かない）
        if (error instanceof api.ApiError) throw error;
        return api.sendNotes(child, body);
      })
      .catch((error: unknown) => ({ error }));
    // 待っている間に、画面が切り替わっていたら、ボードは破棄されている
    if (signal.aborted) return;
    if ('error' in result) {
      // 送れなかった付箋は、見えるようにして、動かす前の位置へ戻す
      for (const el of leaving) el.classList.remove(LEAVING_CLASS);
      putBack(moving);
      options.notify(failureMessage('failed.transfer', result.error));
      return;
    }
    const gone = ids.filter((id) => moving(id) && board.getNote(id) !== undefined);
    if (gone.length > 0) board.batch(() => gone.forEach((id) => board.deleteNote(id)));
    options.notify(t(copy ? 'transfer.copied' : 'transfer.moved', ids.length, options.titleOf(child)));
    if (result.page) options.onSent(result.page);
  }

  return { settled: () => Promise.allSettled(pending).then(() => {}) };
}
