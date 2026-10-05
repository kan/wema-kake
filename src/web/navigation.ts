// 画面の切り替え。一覧（/）とページ（/p/<slug>）の間は、ページ全体を読み込み直さずに切り替える
// （階層を移るときに、画面が白くならないようにする。docs/plan.md のフェーズ 6.6）。

/**
 * 切り替えの演出の手がかり。切り替え先の画面が、最初の表示位置を決めるのに使う。
 * 階層は、上から、一覧、ルートのページ、子ページ、…の順。
 * - enter: 付箋から、その付箋が表すページへ入った（一覧からページへ、ページから子ページへ）
 * - leave: 上の階層へ戻った。`from` は、戻り先に付箋として出ているページ
 *   （先祖のページへ戻るなら、そこに置いてある子ページ。一覧へ戻るなら、ルートのページ）
 */
export type Transition = { kind: 'enter' } | { kind: 'leave'; from: string };

/** 今の画面が続く間だけ有効な signal。画面全体に付けるリスナーは、これを渡して付ける */
let view = new AbortController();
export const viewSignal = (): AbortSignal => view.signal;

/** 今の画面が終わるときに呼ぶ処理を登録する（同期を止める、ボードを破棄する、など） */
export function onViewEnd(run: () => void): void {
  view.signal.addEventListener('abort', run, { once: true });
}

/** 今の画面を離れる前に待つ処理（保存中の変更を送り終える、など）。画面ごとに 1 つ */
let beforeLeave: (() => Promise<void>) | undefined;
export function setBeforeLeave(run: () => Promise<void>): void {
  beforeLeave = run;
}

/**
 * パスを画面にする。`initial` は、ページを読み込んだ直後の、最初の画面かどうか。
 * `arrival` は、演出つきで切り替わってきたときの手がかり。
 * 読み込みなしで切り替えられないパスなら false を返す
 */
type Render = (path: string, initial: boolean, arrival?: Transition) => boolean;
let render: Render = () => false;

/** 始めた切り替えの数。待っている間に次の切り替えが始まったら、古いほうは何もしない */
let generation = 0;
/** 始めた切り替えの数。演出の後で切り替える側が、演出の間に別の切り替えが始まっていないかを見る */
export const navigationCount = (): number => generation;

/** 今の画面を終わらせて、`path` の画面を出す。出せなければ、ページ全体を読み込み直す */
async function show(path: string, arrival?: Transition): Promise<void> {
  const current = ++generation;
  await beforeLeave?.();
  // 待っている間に、別の切り替え（「戻る」など）が始まっていたら、そちらに任せる。
  // 続けると、後から描いた古い行き先が残り、URL と画面が食い違う
  if (current !== generation) return;
  beforeLeave = undefined;
  view.abort();
  view = new AbortController();
  if (!render(path, false, arrival)) location.reload();
}

/**
 * ページを読み込み直す。画面を切り替えるときと同じく、先に、今の画面の待つ処理（保存中の変更を
 * 送り終える）を済ませる
 */
export async function reloadPage(): Promise<void> {
  await beforeLeave?.();
  location.reload();
}

/** 最初の画面を出し、ブラウザの「戻る」と「進む」に応じる */
export function startRouter(renderPath: Render): void {
  render = renderPath;
  render(location.pathname, true);
  window.addEventListener('popstate', () => void show(location.pathname));
}

/**
 * サイト内の URL へ移る。一覧（/）、ページ（/p/<slug>）、使い方（/help）なら、読み込みなしで切り替える。
 * それ以外は、ページ全体の読み込みで移る
 */
export function navigate(url: string, transition?: Transition): void {
  const target = new URL(url, location.href);
  const { pathname } = target;
  if (target.origin !== location.origin || !(pathname === '/' || pathname === '/help' || pathname.startsWith('/p/'))) {
    location.assign(target.href);
    return;
  }
  history.pushState(null, '', target.pathname + target.search + target.hash);
  void show(target.pathname, transition);
}
