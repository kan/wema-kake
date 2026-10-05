// 使い方の画面（/help）。使い方の付箋を並べた、試すためのボード。
//
// サーバーには保存せず、同期もしない。付箋を動かしたり書き換えたりして試せて、画面を離れると
// 消える。ページとして置くと、ページの内容として保存されて、他の人にも見えてしまう。
import { WemaBoard } from '@kanf/wema';
import { guideBoard } from '../shared/guide';
import { appLink, el, openInternalLink } from './dom';
import { lang, t } from './i18n';
import { onViewEnd } from './navigation';
import { header, historyButtons, langButton, separator, WEMA_LABELS, zoomControls } from './toolbar';

export function openHelp(app: HTMLElement): void {
  document.title = t('documentTitle', t('help'));
  const container = el('div', { className: 'board' });
  // ボードを置く要素を、先に画面に出す。付箋の大きさは目安の値で、wema が読み込んだときに計測する。
  // 画面に出ていない要素の中では計測されず、接続線が、目安の大きさで引かれる
  app.append(el('div', { className: 'page-body' }, container));
  const board = new WemaBoard({
    container,
    data: { version: 1, ...guideBoard('help', lang) },
    onLinkClick: openInternalLink,
    labels: WEMA_LABELS,
  });
  onViewEnd(() => board.destroy());

  const { undo, redo } = historyButtons(board);
  const updateTools = () => {
    undo.disabled = !board.canUndo();
    redo.disabled = !board.canRedo();
  };
  board.on('history:change', updateTools);
  updateTools();

  app.prepend(
    header(
      [appLink('/', t('list')), el('h1', { textContent: t('help') })],
      [undo, redo, separator(), zoomControls(board, container)],
      [el('span', { className: 'help-note', textContent: t('help.unsaved') }), langButton()],
    ),
  );
}
