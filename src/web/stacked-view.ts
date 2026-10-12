// スマートフォンの幅では、付箋を縦 1 列に積んで表示する（docs/plan.md のフェーズ 6.5「スマートフォンの幅」）。
//
// wema の setStacked() は、付箋のデータ（位置と幅）を変えずに、描く位置だけを縦 1 列にする。
// 同期しているボードで使っても、サーバーへは何も送られない。あわせて setPageScroll() で、ボードの
// パンとズームをやめて、ボードを置いた要素の中を縦にスクロールさせる（スタイルは style.css の .stacked）。
import type { WemaBoard } from '@kanf/wema';
import { onViewEnd, viewSignal } from './navigation';

/** この幅以下では、付箋を縦に積む。ヘッダーを 2 行にする幅（style.css）とそろえる */
const NARROW = '(max-width: 640px)';
/** 列の左右と上に空ける余白 */
const MARGIN = 12;
/** 積んでいる間、ボードを置いた要素に付けるクラス */
const STACKED_CLASS = 'stacked';

export interface StackedView {
  /** 積んで表示しているか。積み始める直前から、`onChange(false)` が済むまで true */
  isStacked(): boolean;
  /**
   * 画面の幅に合わせた切り替えを始める。付箋を読み込んでから呼ぶ（同期しているボードでは、
   * 最初の同期が済んでから）
   */
  start(): void;
}

/**
 * `container`（ボードを置いた要素）の幅に合わせて、縦積みと、データどおりの配置を切り替える。
 * ウィンドウの大きさの変更や、端末の回転で幅が変わったときも切り替える。
 *
 * `onChange` は、切り替わった後に呼ぶ。データどおりの配置へ戻るとき、表示位置は原点、倍率は等倍に
 * なっている（wema は、ページスクロールを抜けても前の位置へ戻さない）。見せたい位置へは、ここで動かす
 *
 * `first` は、列の先頭に並べる付箋の id。残りの付箋は、データの位置の上から順（同じ高さなら左から順）に並ぶ
 */
export function stackOnNarrow(
  board: WemaBoard,
  container: HTMLElement,
  { onChange, first = [] }: { onChange?: (stacked: boolean) => void; first?: string[] } = {},
): StackedView {
  const query = matchMedia(NARROW);
  /** 積んでいる列の幅。積んでいなければ undefined。同じ幅では積み直さない */
  let shown: number | undefined;

  const apply = () => {
    if (query.matches) {
      // クラスを付けてから幅を読む（スクロールバーの分だけ、中の幅が変わる）
      container.classList.add(STACKED_CLASS);
      const width = container.clientWidth - MARGIN * 2;
      if (width === shown || width <= 0) return;
      const entering = shown === undefined;
      // 先に入れる。ページスクロールへ入るときの表示位置の変更を、積んでいる間のものとして扱わせる
      shown = width;
      board.setPageScroll(true);
      board.setStacked({ x: MARGIN, y: MARGIN, width, order: first });
      if (entering) onChange?.(true);
    } else if (shown !== undefined) {
      container.classList.remove(STACKED_CLASS);
      board.setStacked(null);
      board.setPageScroll(false);
      try {
        onChange?.(false);
      } finally {
        // onChange が失敗しても、積んでいる扱いのまま残さない
        shown = undefined;
      }
    } else {
      // 幅が取れずに積めなかったときに付けたクラスを外す
      container.classList.remove(STACKED_CLASS);
    }
  };

  return {
    isStacked: () => shown !== undefined,
    start() {
      apply();
      query.addEventListener('change', apply, { signal: viewSignal() });
      // 積んだままでも、幅が変われば列の幅を合わせる
      const observer = new ResizeObserver(apply);
      observer.observe(container);
      onViewEnd(() => observer.disconnect());
    },
  };
}
