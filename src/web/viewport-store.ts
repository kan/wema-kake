// 倍率を、ページごとにブラウザへ保存する。開き直したときと、子ページから親ページへ戻ったときに、
// 前に見ていた倍率で、付箋全体の中央から始める。表示位置は覚えない。倍率は各ブラウザの表示状態で、
// ページの内容と同期の対象には含めない。
import type { WemaBoard } from '@kanf/wema';
import { onViewEnd, viewSignal } from './navigation';
import { centerOnNotes, settings } from './toolbar';

/** 保存しておくページの数。超えたら、古いものから捨てる */
const MAX_SAVED = 200;
const KEY = 'viewports';

/**
 * 保存の形。古い順に並べた配列にする（オブジェクトのキーにすると、数字だけのスラッグが
 * 先頭に並び、新しいのに古いものとして捨てられる）
 */
type Saved = [slug: string, zoom: number][];

function load(): Saved {
  try {
    const value: unknown = JSON.parse(settings.get(KEY) ?? '[]');
    if (!Array.isArray(value)) return [];
    return (
      value
        // 表示位置も保存していた頃の値（[slug, x, y, zoom]）からは、倍率だけを引き継ぐ
        .map((entry: unknown) => (Array.isArray(entry) && entry.length === 4 ? [entry[0], entry[3]] : entry))
        .filter(
          (entry): entry is Saved[number] =>
            Array.isArray(entry) &&
            entry.length === 2 &&
            typeof entry[0] === 'string' &&
            typeof entry[1] === 'number' &&
            Number.isFinite(entry[1]),
        )
    );
  } catch {
    return [];
  }
}

/** 倍率を変え終えてから、保存するまでの時間 */
const SAVE_DELAY_MS = 300;

/**
 * ボードの倍率を、ページごとに覚える。`container` は、ボードを置いた要素。
 *
 * - `restore`: 最初の同期が済んだときに 1 回呼ぶ。付箋全体の中央を、ボードの中央に出す。倍率は、
 *   前に見ていた倍率があればそれに、なければ全体が収まる倍率にする
 * - `start`: ここから先の倍率の変更を保存する。`restore` と、入ってきたときの演出が済んでから呼ぶ
 *   （それより前の動きは保存しない。演出の途中の倍率を、見ていた倍率として保存しないため。
 *   全体が収まる倍率にしただけのページも、倍率を変えるまでは保存しない。付箋が増えれば、次に
 *   開いたときに、収まる倍率を取り直す）
 * - `freeze`: 今の倍率を保存して、以後は保存しない（後から `start` を呼んでも、再開しない）。
 *   画面を切り替える演出の前に呼ぶ
 */
export function rememberViewport(
  board: WemaBoard,
  slug: string,
  container: HTMLElement,
): { restore: () => void; start: () => void; freeze: () => void } {
  /** idle: まだ保存を始めていない。saving: 倍率の変更を保存する。frozen: もう保存しない */
  let state: 'idle' | 'saving' | 'frozen' = 'idle';
  /** 最後に見た倍率。パンだけの動きでは保存しない */
  let zoom = board.getViewport().zoom;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
    saveZoom(slug, board.getViewport().zoom);
  };
  board.on('viewport:change', (viewport) => {
    const changed = viewport.zoom !== zoom;
    zoom = viewport.zoom;
    if (state !== 'saving' || !changed) return;
    clearTimeout(timer);
    timer = setTimeout(flush, SAVE_DELAY_MS);
  });
  // 変えた直後に他のページへ移っても、最後の倍率を保存する。読み込みなしで切り替わるときは、
  // ボードが破棄される前に保存する（先に登録したものから呼ばれるので、ボードを作った直後に呼ぶこと）
  window.addEventListener('pagehide', flush, { signal: viewSignal() });
  onViewEnd(flush);

  return {
    restore() {
      const saved = savedZoom(slug);
      if (saved === undefined) board.fitToContent();
      else board.setViewport({ zoom: saved });
      // 全体が収まらないときも、中央から始める（fitToContent は、収まらないと左上を出す）
      centerOnNotes(board, container);
    },
    start() {
      // 止めた後（切り替えの演出が始まった後）に呼ばれても、再開しない
      if (state === 'idle') state = 'saving';
    },
    freeze() {
      flush();
      state = 'frozen';
    },
  };
}

/** 保存してある倍率。なければ undefined */
function savedZoom(slug: string): number | undefined {
  return load().find(([name]) => name === slug)?.[1];
}

function saveZoom(slug: string, zoom: number): void {
  // 入れ直して、末尾（新しい側）へ移す
  const saved = load().filter(([name]) => name !== slug);
  saved.push([slug, Math.round(zoom * 1000) / 1000]);
  settings.set(KEY, JSON.stringify(saved.slice(-MAX_SAVED)));
}
