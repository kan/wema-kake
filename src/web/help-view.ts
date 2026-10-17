// 使い方の画面（/help）。使い方の付箋を並べた、試すためのボード。
//
// サーバーには保存せず、同期もしない。付箋を動かしたり書き換えたりして試せて、画面を離れると
// 消える。ページとして置くと、ページの内容として保存されて、他の人にも見えてしまう。
import { WemaBoard } from '@kanf/wema';
import { GUIDE_INTRO_ID, guideBoard } from '../shared/guide';
import { appLink, el, openInternalLink } from './dom';
import { lang, t } from './i18n';
import { onViewEnd } from './navigation';
import { site } from './site';
import { stackOnNarrow } from './stacked-view';
import { header, historyButtons, langButton, separator, WEMA_LABELS, zoomControls } from './toolbar';

export function openHelp(app: HTMLElement): void {
  document.title = t('documentTitle', t('help'), site.siteName);
  const container = el('div', { className: 'board' });
  // ボードを置く要素を、先に画面に出す。付箋の大きさは目安の値で、wema が読み込んだときに計測する。
  // 画面に出ていない要素の中では計測されず、接続線が、目安の大きさで引かれる
  app.append(el('div', { className: 'page-body' }, container));
  const board = new WemaBoard({
    container,
    data: { version: 1, ...guideBoard('help', lang) },
    onLinkClick: openInternalLink,
    // ページの画面と同じく、付箋を縦に積んでいる間は、つながっている相手を付箋の下に出す
    noteLinks: true,
    labels: WEMA_LABELS,
    // ページの画面と同じ操作にする
    emptyDrag: 'pan',
  });
  onViewEnd(() => board.destroy());
  // ページの画面と同じく、スマートフォンの幅では、付箋を縦 1 列に積んで表示する。
  // 案内の付箋は、配置の上では装飾の見本の右にあるので、先頭に並べる
  stackOnNarrow(board, container, { first: [GUIDE_INTRO_ID] }).start();

  const { undo, redo } = historyButtons(board);
  const updateTools = () => {
    undo.disabled = !board.canUndo();
    redo.disabled = !board.canRedo();
  };
  board.on('history:change', updateTools);
  updateTools();

  // ズームのボタンは、ページの画面と同じく、幅が狭いときは隠す
  const zoomTools = zoomControls(board, container);
  zoomTools.classList.add('optional');
  app.prepend(
    header(
      [appLink('/', t('list')), el('h1', { textContent: t('help') })],
      [undo, redo, separator(), zoomTools],
      [el('span', { className: 'help-note', textContent: t('help.unsaved') }), langButton()],
    ),
  );
}
