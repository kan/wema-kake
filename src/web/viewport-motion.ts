// 表示位置と倍率を、動きを付けて変える。階層を移るとき（一覧からページへ、ページから子ページへ、
// その逆）の、ズームの演出に使う。wema の setViewport は、すぐに切り替わるので、フレームごとに呼ぶ。
import type { WemaBoard, WemaNote, WemaViewport } from '@kanf/wema';
import { navigate, navigationCount, type Transition, viewSignal } from './navigation';

/** 演出の長さ。入る前と、入った後の、それぞれの長さ */
const DURATION_MS = 220;
/** 付箋へ寄ったときに、付箋の外側に空ける余白（画面のピクセル） */
const FOCUS_PADDING = 32;
/** 入った直後の、最初の倍率（落ち着く倍率に対する比）。小さい状態から広がる */
const ENTER_SCALE = 0.5;
/** 上の階層へ戻る前に、縮める倍率（今の倍率に対する比） */
const LEAVE_SCALE = 0.5;

/** 動きを減らす設定（OS やブラウザ）なら、演出をしない */
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** ゆっくり始まり、ゆっくり終わる */
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/**
 * 表示位置と倍率を、`to` まで動かす。動かし終えるか、画面が切り替わったら解決する。
 * 倍率は比で補間する（等速で拡大しているように見せる）
 */
function animateViewport(board: WemaBoard, to: WemaViewport, superseded: () => boolean): Promise<void> {
  if (reducedMotion()) {
    board.setViewport(to);
    return Promise.resolve();
  }
  const from = board.getViewport();
  const signal = viewSignal();
  const start = performance.now();
  return new Promise((resolve) => {
    const step = (now: number) => {
      // 画面が切り替わったら、ボードはもう破棄されている
      // 同じボードで次の演出が始まったら、そちらに任せる（2 つが交互に動かすと、表示が揺れる）
      if (signal.aborted || superseded()) return resolve();
      const t = Math.min(1, (now - start) / DURATION_MS);
      const k = ease(t);
      board.setViewport({
        x: from.x + (to.x - from.x) * k,
        y: from.y + (to.y - from.y) * k,
        zoom: from.zoom * (to.zoom / from.zoom) ** k,
      });
      if (t < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
}

/**
 * `move` で動かした先の表示位置を求めて、元の位置へ戻す。倍率の上限と下限、ボードの大きさの
 * 扱いを、wema に任せるためのもの（ボードごとに、倍率の下限が違う）
 */
function destinationOf(board: WemaBoard, move: () => void): WemaViewport {
  const before = board.getViewport();
  move();
  const to = board.getViewport();
  board.setViewport(before);
  return to;
}

/** 付箋が、ボードいっぱいに近い大きさで中央に来る表示位置 */
const focusedOn = (board: WemaBoard, note: WemaNote) =>
  destinationOf(board, () => board.fitToContent({ noteIds: [note.id], padding: FOCUS_PADDING, maxZoom: Infinity }));

/** ボードの中央を動かさずに、今の `factor` 倍にした表示位置 */
const scaledBy = (board: WemaBoard, factor: number) =>
  destinationOf(board, () => board.zoomTo(board.getViewport().zoom * factor));

/**
 * 階層を移るときの、ズームの演出。1 つの画面のボードにつき、1 つ作る。
 *
 * - 下の階層へ入る: 押した付箋へ寄ってから切り替える（`enter`）。切り替えた先は、小さい状態から広がる
 * - 上の階層へ戻る: 全体を縮めてから切り替える（`leave`）。切り替えた先は、戻ってきたページの付箋から広がる
 *
 * `onStart` は、切り替えの演出を始める直前に呼ぶ（演出で動かした位置を、見ていた場所として
 * 保存しないようにする、など）
 */
export function zoomTransitions(board: WemaBoard, onStart?: () => void) {
  /** 演出つきで、他の画面へ切り替えている途中か。途中でもう一度押されても、何もしない */
  let leaving = false;
  /** 始めた演出の数。入ってきた演出の途中で、離れる演出が始まったら、古いほうを止める */
  let animations = 0;
  const animate = (to: WemaViewport) => {
    const mine = ++animations;
    return animateViewport(board, to, () => mine !== animations);
  };
  /** 離れる前の演出をして、切り替え先へ渡す手がかりを返す。すでに離れている途中なら undefined */
  const depart = async (
    destination: () => WemaViewport | undefined,
    transition: Transition,
  ): Promise<Transition | undefined> => {
    if (leaving) return undefined;
    leaving = true;
    onStart?.();
    // 行き先は、onStart の後に求める（求めるときに、表示位置を一度動かして戻すため）
    const to = destination();
    if (to) await animate(to);
    return transition;
  };
  const go = async (destination: () => WemaViewport | undefined, url: string, transition: Transition) => {
    const signal = viewSignal();
    const count = navigationCount();
    const arrival = await depart(destination, transition);
    // 演出の途中で、他の切り替え（「戻る」など）が始まっていたら、そちらを優先する
    // （保存中の変更を待っている間は、まだ画面が終わっていないので、数でも確かめる）
    if (arrival && !signal.aborted && count === navigationCount()) navigate(url, arrival);
  };
  /** 付箋 `noteId` へ寄った表示位置 */
  const onNote = (noteId: string) => () => {
    const note = board.getNote(noteId);
    return note && focusedOn(board, note);
  };
  const shrunk = () => scaledBy(board, LEAVE_SCALE);
  return {
    /** 付箋 `noteId` へ寄ってから、`url`（その付箋が表すページ）へ入る */
    enter(noteId: string, url: string): Promise<void> {
      return go(onNote(noteId), url, { kind: 'enter' });
    },
    /** 全体を縮めてから、`url`（上の階層）へ戻る。`from` は、戻り先に付箋として出ているページ */
    leave(url: string, from: string): Promise<void> {
      return go(shrunk, url, { kind: 'leave', from });
    },
    /**
     * ブラウザの「戻る」と「進む」で離れるときの演出。`enter` / `leave` と同じ動きをするが、
     * 切り替えは呼ぶ側（navigation.ts）が行うので、切り替え先へ渡す手がかりを返すだけにする
     */
    enterOnPop(noteId: string): Promise<Transition | undefined> {
      return depart(onNote(noteId), { kind: 'enter' });
    },
    leaveOnPop(from: string): Promise<Transition | undefined> {
      return depart(shrunk, { kind: 'leave', from });
    },
    /**
     * 切り替わってきた直後の演出。今の表示位置を、落ち着く位置として、そこまで動かす。
     * `noteOf` は、ページのスラッグから、そのページを表す付箋を探す
     */
    async arrive(arrival: Transition | undefined, noteOf: (page: string) => WemaNote | undefined): Promise<void> {
      const target = board.getViewport();
      if (arrival?.kind === 'enter') {
        board.zoomTo(target.zoom * ENTER_SCALE);
      } else if (arrival?.kind === 'leave') {
        const note = noteOf(arrival.from);
        if (!note) return;
        board.fitToContent({ noteIds: [note.id], padding: FOCUS_PADDING, maxZoom: Infinity });
      } else {
        return;
      }
      await animate(target);
    },
  };
}
