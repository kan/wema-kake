// 付箋を、子ページの付箋の上へドラッグして放すと、その子ページへ移す。
// Ctrl / Cmd を押したまま放すと、移さずに写す（元の付箋は、動かす前の位置へ戻る）。
// 運んだ付箋と接続線でつながっている付箋があれば、一緒に送るかを尋ねる。
//
// wema には、付箋を放したことを知らせるイベントがない。付箋の上で押し始めたポインターが離れた
// ときに、位置だけを変える操作が確定したら（history:commit）、ドラッグの終わりとして扱う。
import type { WemaBoard, WemaNote } from '@kanf/wema';
import type { PageSummary } from '../shared/api';
import { connectedNotes } from '../shared/connected';
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
 * @returns `settled` は、送っている途中の付箋が、送り終わる（サーバーが、このページから消し終わる）のを待つ。
 *   他のページへ切り替える前に待つこと（待たないと、送れなかった付箋を、元の位置へ戻せない）
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
  /** 送っている途中の付箋（見えないだけで、送り終えるまでボードに残っている） */
  const inFlight = new Set<string>();
  /** 子ページへ送れる付箋か。子ページの付箋は、送れない（ページの親を変えることになる） */
  const sendable = (id: string) => board.getNote(id) !== undefined && !isChildNote(id) && !inFlight.has(id);

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
    // 子ページの付箋は、移さない。一緒に運んでいたら、元の位置へ戻す
    const ids = [...before.keys()].filter(sendable);
    if (child === undefined || ids.length === 0) return;
    const sending = send(child, ids, before, drop.copy).finally(() => pending.delete(sending));
    pending.add(sending);
  });

  /**
   * 運んだ付箋 `dragged` を、子ページ `child` へ送る。移すときは、サーバーが、作成者を引き継いで置き、
   * このページの付箋を消す（写すときは残す）
   */
  async function send(child: string, dragged: string[], before: Map<string, Position>, copy: boolean): Promise<void> {
    /** `which` に合う付箋を、動かす前の位置へ戻す */
    const putBack = (which: (id: string) => boolean) => {
      const back = [...before].filter(([id]) => which(id) && board.getNote(id) !== undefined);
      if (back.length > 0) board.batch(() => back.forEach(([id, position]) => board.updateNote(id, position)));
    };
    /** 送っている途中の付箋。移す付箋は、送り終えるまで見えなくしておく（消すのは、送れてから） */
    const sent: string[] = [];
    const leaving: HTMLElement[] = [];
    /** 移し終えた（付箋は、サーバーからの削除が届くまで、ボードに残る） */
    let moved = false;
    const take = (ids: string[]) => {
      sent.push(...ids);
      for (const id of ids) inFlight.add(id);
      if (copy) return;
      const elements = ids.flatMap((id) => noteElement(id) ?? []);
      for (const el of elements) el.classList.add(LEAVING_CLASS);
      leaving.push(...elements);
    };
    try {
      // 操作の確定（history:commit）を処理している途中では、ボードを書き換えない
      await Promise.resolve();
      // 応答を待たずに、見た目を先に済ませる。残る付箋（写す付箋、一緒に運んでいた子ページの付箋）は、
      // 動かす前の位置へ戻す
      take(dragged);
      putBack((id) => copy || !dragged.includes(id));

      // 運んだ付箋と接続線でつながっている付箋も、一緒に送るかを尋ねる（断ったら、運んだ付箋だけを送る）。
      // 子ページの付箋と、送っている途中の付箋は送れないので、その先へはたどらない
      const linked = connectedNotes(dragged, board.getEdges(), sendable);
      if (linked.length > 0) {
        // confirm は、閉じるまで画面の処理を止める。ポインターのイベントの処理の外へ出て、上の見た目が
        // 描かれてから尋ねる
        await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve)));
        if (signal.aborted) return;
        if (confirm(t(copy ? 'transfer.confirmCopyLinked' : 'transfer.confirmMoveLinked', linked.length))) {
          // 尋ねる前に数えた付箋が、待っている間に消えていることがある
          take(linked.filter(sendable));
        }
      }
      // 付箋の中身と、送る付箋どうしをつなぐ接続線は、サーバーが読んで送る。移すときは、作成者も
      // 引き継ぐ。運んだ付箋は、動かす前の位置で送る（運んでいない付箋との位置関係を保つ。送り先での
      // 位置は、サーバーが決める）
      const noteIds = sent.filter((id) => board.getNote(id) !== undefined);
      // 運んでいない付箋は、サーバーにある位置のままでよい。動かす前の位置で、片方の軸しか変わって
      // いなければ、もう片方は今の位置と同じ
      const positions = Object.fromEntries(
        noteIds.flatMap((id) => {
          const moved = before.get(id);
          const note = board.getNote(id);
          return moved && note ? [[id, { x: moved.x ?? note.x, y: moved.y ?? note.y }]] : [];
        }),
      );
      const body = { clientId: options.clientId, opId: crypto.randomUUID(), to: child, noteIds, positions, copy };

      const result = await api
        .transferNotes(options.slug, body)
        .catch((error: unknown) => {
          // 断られたのなら、送り直さない。応答を受け取れなかっただけなら、置かれたかどうかが分からない
          // ので、同じ opId でもう一度だけ送る（置かれていれば、サーバーは二重には置かない）
          if (error instanceof api.ApiError) throw error;
          return api.transferNotes(options.slug, body);
        })
        .catch((error: unknown) => ({ error }));
      // 待っている間に、画面が切り替わっていたら、ボードは破棄されている
      if (signal.aborted) return;
      if ('error' in result) {
        // 送れなかった付箋は、見えるようにして、動かす前の位置へ戻す。送り先に置けたのに、このページ
        // から消せなかった付箋（409）も同じ。消せた付箋は、同期で消える
        for (const el of leaving) el.classList.remove(LEAVING_CLASS);
        putBack(() => !copy);
        const partial = result.error instanceof api.ApiError && result.error.status === 409;
        options.notify(
          partial ? t('transfer.partial', options.titleOf(child)) : failureMessage('failed.transfer', result.error),
        );
        return;
      }
      // 移した付箋は、サーバーがこのページから消し、その操作が同期で届く。手元では消さない（手元で
      // 消すと、Undo で付箋が戻せてしまい、戻した付箋の作成者が、戻した人になる）。届くまでは、
      // 見えないまま残るので、送っている途中の扱いのままにする（もう一度送らない）
      if (!copy) moved = true;
      options.notify(t(copy ? 'transfer.copied' : 'transfer.moved', noteIds.length, options.titleOf(child)));
      if (result.page) options.onSent(result.page);
    } finally {
      if (!moved) for (const id of sent) inFlight.delete(id);
    }
  }

  return { settled: () => Promise.allSettled(pending).then(() => {}) };
}
