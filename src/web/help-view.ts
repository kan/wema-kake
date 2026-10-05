// 使い方の画面（/help）。使い方の付箋を並べた、試すためのボード。
//
// サーバーには保存せず、同期もしない。付箋を動かしたり書き換えたりして試せて、画面を離れると
// 消える。ページとして置くと、ページの内容として保存されて、他の人にも見えてしまう。
import { WemaBoard } from '@kanf/wema';
import { guideBoard } from '../shared/guide';
import { el, isPlainClick, openInternalLink } from './dom';
import { navigate, onViewEnd } from './navigation';
import { FOLD_LABELS, header, iconButton, measureAutoSizeNotes, separator, zoomControls } from './toolbar';

export function openHelp(app: HTMLElement): void {
  document.title = '使い方 - wema-kake';
  const container = el('div', { className: 'board' });
  const board = new WemaBoard({
    container,
    data: { version: 1, ...guideBoard('help') },
    onLinkClick: openInternalLink,
    foldLabels: FOLD_LABELS,
  });
  onViewEnd(() => board.destroy());

  const undoButton = iconButton('undo', '元に戻す (Ctrl+Z)', () => board.undo());
  const redoButton = iconButton('redo', 'やり直す (Ctrl+Shift+Z)', () => board.redo());
  const updateTools = () => {
    undoButton.disabled = !board.canUndo();
    redoButton.disabled = !board.canRedo();
  };
  board.on('history:change', updateTools);
  updateTools();

  const back = el('a', { href: '/', textContent: '一覧' });
  back.addEventListener('click', (e) => {
    if (!isPlainClick(e)) return;
    e.preventDefault();
    navigate('/');
  });

  app.append(
    header(
      [back, el('h1', { textContent: '使い方' })],
      [undoButton, redoButton, separator(), zoomControls(board, container)],
      [el('span', { className: 'help-note', textContent: 'このボードは保存されません' })],
    ),
    el('div', { className: 'page-body' }, container),
  );
  // 付箋の大きさは目安の値なので、画面に出してから計測する（接続線が、付箋の縁に合う）
  measureAutoSizeNotes(board);
}
