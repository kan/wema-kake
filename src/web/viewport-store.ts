// 表示位置と倍率を、ページごとにブラウザへ保存する。開き直したときと、子ページから親ページへ
// 戻ったときに、前に見ていた場所から始める。表示位置は各ブラウザの表示状態で、ページの内容と
// 同期の対象には含めない。
import type { WemaBoard, WemaViewport } from '@kanf/wema';
import { settings } from './toolbar';

/** 保存しておくページの数。超えたら、古いものから捨てる */
const MAX_SAVED = 200;
const KEY = 'viewports';

/**
 * 保存の形。古い順に並べた配列にする（オブジェクトのキーにすると、数字だけのスラッグが
 * 先頭に並び、新しいのに古いものとして捨てられる）
 */
type Saved = [slug: string, x: number, y: number, zoom: number][];

function load(): Saved {
  try {
    const value: unknown = JSON.parse(settings.get(KEY) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter(
      (entry): entry is Saved[number] =>
        Array.isArray(entry) &&
        typeof entry[0] === 'string' &&
        entry.slice(1, 4).every((n) => typeof n === 'number' && Number.isFinite(n)),
    );
  } catch {
    return [];
  }
}

/** 表示位置を動かし終えてから、保存するまでの時間 */
const SAVE_DELAY_MS = 300;

/**
 * ボードの表示位置を、ページごとに覚える。返す関数を、最初の同期が済んだときに 1 回呼ぶ。
 * 前に見ていた場所があればそこへ、なければ全体が収まる倍率にし、そこから保存を始める
 * （それより前の動きは保存しない。空のボードを動かした位置で、前回の位置を上書きしないため）
 */
export function rememberViewport(board: WemaBoard, slug: string): () => void {
  let started = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
    saveViewport(slug, board.getViewport());
  };
  board.on('viewport:change', () => {
    if (!started) return;
    clearTimeout(timer);
    timer = setTimeout(flush, SAVE_DELAY_MS);
  });
  // 動かした直後に他のページへ移っても、最後の位置を保存する
  window.addEventListener('pagehide', flush);

  return () => {
    const saved = savedViewport(slug);
    if (saved) board.setViewport(saved);
    else board.fitToContent();
    started = true;
  };
}

/** 保存してある表示位置。なければ undefined */
function savedViewport(slug: string): WemaViewport | undefined {
  const entry = load().find(([name]) => name === slug);
  if (!entry) return undefined;
  const [, x, y, zoom] = entry;
  return { x, y, zoom };
}

function saveViewport(slug: string, { x, y, zoom }: WemaViewport): void {
  // 入れ直して、末尾（新しい側）へ移す
  const saved = load().filter(([name]) => name !== slug);
  saved.push([slug, Math.round(x), Math.round(y), Math.round(zoom * 1000) / 1000]);
  settings.set(KEY, JSON.stringify(saved.slice(-MAX_SAVED)));
}
