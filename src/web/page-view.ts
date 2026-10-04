// ページの画面（/p/<slug>）。wema のボードと、見出し（表示名、バックリンク、操作の履歴、削除）。
import { WemaBoard } from '@kanf/wema';
import { MAX_TITLE_LENGTH, type OpSummary, type RevertOutcome, type SkipReason } from '../shared/api';
import { REASON_TEXT_CONFLICT } from '../shared/protocol';
import * as api from './api';
import { confirmDeletePage, el, errorMessage, formatDate, openInternalLink } from './dom';
import type { IconName } from './icons';
import { BoardSync, type SyncSocket, type SyncStatus, toSyncSocket } from './sync';
import { header, iconButton, menuItem, popover, separator, settings, toast, zoomControls } from './toolbar';

const NOTICE_MS = 8000;

/** ブラウザごとの設定のキー。ページの内容と同期の対象には含めない */
const VIEW_ONLY_KEY = 'view-only';
const THEME_KEY = 'theme';

/** 整列のボタン（アイコン、説明、wema に渡す整列の種類） */
const ALIGNMENTS = [
  ['alignLeft', '左端をそろえる', 'left'],
  ['alignCenter', '左右の中央をそろえる', 'center'],
  ['alignRight', '右端をそろえる', 'right'],
  ['alignTop', '上端をそろえる', 'top'],
  ['alignMiddle', '上下の中央をそろえる', 'middle'],
  ['alignBottom', '下端をそろえる', 'bottom'],
] as const;

const STATUS_TEXT: Record<SyncStatus, string> = {
  connecting: '接続中…',
  synced: '',
  offline: 'オフライン（再接続します）',
};

/** 取り消さなかった理由の表示 */
const SKIP_REASON: Record<SkipReason, string> = {
  modified: 'その後に変更された',
  connected: '他の接続線がつながっている',
  deleted: 'すでに削除されている',
  exists: '同じものがすでにある',
  'endpoint-missing': '両端の付箋がない',
};

/** 取り消しの結果を知らせる文言 */
function revertMessage(result: RevertOutcome): string {
  const reasons = [...new Set(result.skipped.map((s) => SKIP_REASON[s.reason]))];
  const why = reasons.length > 0 ? `（${reasons.join('、')}）` : '';
  if (result.applied === 0) return `取り消せる変更がありませんでした${why}`;
  if (result.skipped.length === 0) return '取り消しました';
  return `一部を取り消しました。${result.skipped.length} 件は残しています${why}`;
}

/** WebSocket で接続し、接続が開いてから返す。開く前に閉じたら失敗にする */
function connect(slug: string): Promise<SyncSocket> {
  return new Promise((resolve, reject) => {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${scheme}://${location.host}/ws/${slug}`);
    ws.addEventListener('close', () => reject(new Error('websocket closed')), { once: true });
    ws.addEventListener('open', () => resolve(toSyncSocket(ws)), { once: true });
  });
}

export function openPage(app: HTMLElement, slug: string): void {
  let currentTitle: string | null = null;
  /** このタブで削除を実行中か。完了を待ってから一覧へ戻るので、切断の通知では戻らない */
  let deleting = false;

  // --- ボード ---
  // ヘッダーのボタンがボードを操作するので、ボードを先に作る。
  // 最初の同期が済むまでは編集させない（同期でボード全体が入れ替わるため）
  const container = el('div', { className: 'board' });
  const historyPanel = el('aside', { className: 'history-panel', hidden: true });
  const body = el('div', { className: 'page-body' }, container, historyPanel);
  const board = new WemaBoard({
    container,
    readOnly: true,
    theme: settings.get(THEME_KEY) === 'card' ? 'card' : 'default',
    onImageUpload: api.uploadImage,
    // 他のページへのリンク（Wiki リンク）は、同じタブで開く
    onLinkClick: openInternalLink,
  });

  // 一時的な通知は、ボードの上に重ねて出す
  const notify = toast(body, NOTICE_MS);
  const fail = (what: string) => (e: unknown) => notify(`${what}に失敗しました（${errorMessage(e)}）`);

  // --- ヘッダーの左: 今いる場所 ---
  const title = el('h1', { className: 'page-title', title: `/p/${slug}（クリックして表示名を変える）` });
  // 同期の状態。同期済みのときは何も出さない。文言は title に入れ、文字で出すのはオフラインのときだけ
  const status = el('span', { className: 'sync-status' });

  const showTitle = (value: string | null) => {
    currentTitle = value;
    title.textContent = value ?? slug;
    document.title = `${value ?? slug} - wema-kake`;
  };
  showTitle(null);

  // --- ヘッダーの中央: 付箋の操作 ---
  const undoButton = iconButton('undo', '元に戻す (Ctrl+Z)', () => board.undo());
  const redoButton = iconButton('redo', 'やり直す (Ctrl+Shift+Z)', () => board.redo());
  const addButton = iconButton('add', '付箋を追加', () => {
    // 見えている範囲の左上の近くに置く。続けて押しても重ならないよう、少しずつずらす
    const offset = (board.getNotes().length % 10) * 20;
    const viewport = board.getViewport();
    board.addNote({
      x: (120 + offset - viewport.x) / viewport.zoom,
      y: (80 + offset - viewport.y) / viewport.zoom,
    });
  });

  const layoutPanel = el('div', { className: 'layout-panel' });
  const layout = popover(iconButton('layout', '整列と配置'), layoutPanel);
  /** 整列のボタンと、押せるようになる選択数 */
  const layoutButtons: [HTMLButtonElement, number][] = [];
  const layoutButton = (name: IconName, label: string, needs: number, run: (selected: string[]) => void) => {
    const button = iconButton(name, label, () => {
      run(board.getSelection());
      layout.close();
    });
    layoutButtons.push([button, needs]);
    layoutPanel.append(button);
  };
  for (const [name, label, alignment] of ALIGNMENTS) {
    layoutButton(name, label, 2, (selected) => board.alignNotes(selected, alignment));
  }
  layoutButton('distributeH', '左右に均等に並べる（3 枚以上を選択）', 3, (s) => board.distributeNotes(s, 'horizontal'));
  layoutButton('distributeV', '上下に均等に並べる（3 枚以上を選択）', 3, (s) => board.distributeNotes(s, 'vertical'));
  layoutButton('autoLayout', '接続線に沿って自動で配置（全体）', 0, () => board.autoLayout());

  /** ボタンの有効と無効を、ボードの状態に合わせる。自前の状態は持たない */
  const updateTools = () => {
    const locked = board.isReadOnly() || board.isViewOnly();
    undoButton.disabled = locked || !board.canUndo();
    redoButton.disabled = locked || !board.canRedo();
    addButton.disabled = locked;
    const selected = board.getSelection().length;
    for (const [button, needs] of layoutButtons) button.disabled = locked || selected < needs;
  };
  // Ctrl / Cmd + A で全選択（wema のスタンドアロン版と同じ。入力中は、入力欄の全選択のままにする）
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.key !== 'a') return;
    // 編集できないとき（最初の同期前、削除後）と、使い方を開いている間は、何もしない
    if (board.isReadOnly() || document.querySelector('dialog[open]')) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && (active.isContentEditable || active.matches('input, textarea'))) return;
    e.preventDefault();
    board.selectAll();
  });

  board.on('readOnly:change', updateTools);
  board.on('history:change', updateTools);
  board.on('note:select', updateTools);
  // 選択中の付箋が削除されたとき（他の人の削除を含む）は note:select が届かないので、ここで拾う
  board.on('note:delete', updateTools);
  updateTools();

  // --- ヘッダーの右: Wiki の機能 ---
  const backlinksButton = el('button', { type: 'button', className: 'text-button', hidden: true });
  const backlinksPanel = el('div', { className: 'link-list' });
  const historyButton = iconButton('history', '操作の履歴');
  const menuPanel = el('div', { className: 'menu' });
  const menu = popover(iconButton('menu', 'メニュー'), menuPanel, { align: 'right' });

  app.append(
    header(
      [el('a', { href: '/', textContent: '一覧' }), title, status],
      [
        el('span', { className: 'tool-group' }, undoButton, redoButton),
        separator(),
        addButton,
        separator(),
        el('span', { className: 'tool-group optional' }, layout.root, separator(), zoomControls(board, container)),
      ],
      [popover(backlinksButton, backlinksPanel, { align: 'right' }).root, historyButton, menu.root],
    ),
    body,
  );

  // --- 同期 ---
  const sync = new BoardSync(board, () => connect(slug), {
    onReady() {
      board.setReadOnly(false);
      // 参照モードは、サーバーの内容を読み込んだ後に入る（入った時点の位置を wema が覚えるため）
      if (settings.get(VIEW_ONLY_KEY) === '1') board.setViewOnly(true);
    },
    onStatus(state, pending) {
      const text = state === 'synced' && pending > 0 ? '保存中…' : STATUS_TEXT[state];
      // 操作のたびに呼ばれるので、変わったときだけ書き換える
      if (status.title !== text) {
        status.title = text;
        status.textContent = state === 'offline' ? text : '';
      }
      if (status.dataset.state !== state) status.dataset.state = state;
    },
    onTitle: showTitle,
    // 認証し直すには、Access を通る通常のページ読み込みが要る
    onAuthExpired: () => location.reload(),
    isAuthenticated: api.isAuthenticated,
    onDeleted() {
      board.setReadOnly(true);
      if (deleting) return;
      alert('このページは削除されました。一覧へ戻ります。');
      location.assign('/');
    },
    onReject(reason) {
      notify(
        reason === REASON_TEXT_CONFLICT
          ? '他の人が同じ付箋を編集していたため、変更を取り消しました'
          : `変更を保存できなかったため、取り消しました（${reason}）`,
      );
    },
  });
  sync.start();

  // --- 表示名の編集 ---
  title.addEventListener('click', () => {
    const input = el('input', {
      className: 'title-input',
      value: currentTitle ?? '',
      placeholder: slug,
      maxLength: MAX_TITLE_LENGTH,
    });
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      input.replaceWith(title);
      const value = input.value.trim();
      // 表示は、サーバーから届く meta で更新される
      if (save && value !== (currentTitle ?? '')) api.setTitle(slug, value).catch(fail('表示名の変更'));
    };
    input.addEventListener('keydown', (e) => {
      // 日本語入力の変換を確定する Enter では、編集を確定しない
      if (e.isComposing) return;
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    title.replaceWith(input);
    input.focus();
    input.select();
  });

  // --- バックリンク ---
  api
    .getBacklinks(slug)
    .then(({ pages }) => {
      // 件数だけをヘッダーに出し、ページ名は押したときに出す（リンク元が多くてもあふれない）
      if (pages.length === 0) return;
      backlinksButton.textContent = `リンク元 ${pages.length}`;
      backlinksButton.title = 'このページへリンクしているページ';
      backlinksButton.hidden = false;
      backlinksPanel.append(...pages.map((p) => el('a', { href: `/p/${p.name}`, textContent: p.title ?? p.name })));
    })
    .catch(fail('リンク元の取得'));

  // --- 操作の履歴と取り消し ---
  const agentOnly = el('input', { type: 'checkbox', checked: true });
  const opList = el('ul', { className: 'op-list' });

  const loadOps = async () => {
    const { ops } = await api.getOps(slug, agentOnly.checked);
    opList.replaceChildren(...ops.map(opRow));
    if (ops.length === 0) opList.append(el('li', { className: 'empty', textContent: '操作はありません' }));
  };
  const refreshOps = () => loadOps().catch(fail('履歴の取得'));

  const revert = async (op: OpSummary, button: HTMLButtonElement) => {
    button.disabled = true;
    try {
      notify(revertMessage(await api.revertOp(slug, op.seq, sync.clientId)));
      await loadOps();
    } catch (e) {
      fail('取り消し')(e);
    }
  };

  function opRow(op: OpSummary): HTMLLIElement {
    const reverted = op.revertedBy !== null;
    const button = el('button', { type: 'button', textContent: '取り消す', disabled: reverted });
    button.addEventListener('click', () => void revert(op, button));
    const summary = op.summary ?? (op.reverts !== null ? '取り消し' : '（説明なし）');
    return el(
      'li',
      { className: reverted ? 'reverted' : '' },
      el('div', { className: 'op-meta', textContent: `${formatDate(op.createdAt)} ${op.actor}` }),
      el('div', { className: 'op-summary', textContent: summary + (reverted ? '（取り消し済み）' : '') }),
      button,
    );
  }

  agentOnly.addEventListener('change', refreshOps);
  historyPanel.append(
    el(
      'div',
      { className: 'history-head' },
      el('label', {}, agentOnly, ' agent の操作だけ'),
      el('button', { type: 'button', textContent: '更新', onclick: refreshOps }),
    ),
    opList,
  );
  historyButton.addEventListener('click', () => {
    historyPanel.hidden = !historyPanel.hidden;
    if (!historyPanel.hidden) void refreshOps();
  });

  // --- メニュー ---
  const viewOnlyItem = menuItem('', () => {
    // 最初の同期が済むまでは切り替えない
    if (board.isReadOnly()) return;
    // 終えると、参照モードの間に自分が動かした付箋は元の位置へ戻る（wema の動作）。
    // その間に届いた他の人の変更と、再接続で読み直した内容は残る（wema 0.7.1 以降）
    const next = !board.isViewOnly();
    settings.set(VIEW_ONLY_KEY, next ? '1' : '0');
    board.setViewOnly(next);
    menu.close();
  });
  const showViewOnly = () => {
    viewOnlyItem.textContent = board.isViewOnly() ? '参照モードを終える' : '参照モード（読むだけ）';
    updateTools();
  };
  board.on('viewOnly:change', showViewOnly);
  showViewOnly();
  const themeItem = menuItem('', () => {
    const next = board.getTheme() === 'card' ? 'default' : 'card';
    board.setTheme(next);
    settings.set(THEME_KEY, next);
    showTheme();
  });
  const showTheme = () => {
    themeItem.textContent = board.getTheme() === 'card' ? '付箋の見た目: カード' : '付箋の見た目: 標準';
  };
  showTheme();

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(board.exportData(), null, 2)], { type: 'application/json' });
    const link = el('a', { href: URL.createObjectURL(blob), download: `${slug}.json` });
    link.click();
    // すぐに失効させると、ブラウザによってはダウンロードが始まる前に URL が無効になる
    setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
    menu.close();
  };

  const help = helpDialog();
  app.append(help);

  const deletePage = () => {
    menu.close();
    if (!confirmDeletePage(currentTitle ?? slug)) return;
    deleting = true;
    api
      .deletePage(slug)
      // 削除が済んでから戻る（先に戻ると、一覧にまだ出ていることがある）
      .then(() => location.assign('/'))
      .catch((e) => {
        deleting = false;
        fail('削除')(e);
      });
  };

  menuPanel.append(
    viewOnlyItem,
    themeItem,
    menuItem('JSON を書き出す', exportJson),
    menuItem('使い方', () => {
      menu.close();
      help.showModal();
    }),
    el('hr'),
    // 削除は、常に見える場所には置かない
    menuItem('ページを削除…', deletePage, 'danger'),
  );
}

/** 使い方。付箋として置くと、ページの内容として保存されて他の人にも見えるので、重ねて出す */
function helpDialog(): HTMLDialogElement {
  const section = (heading: string, items: string[]) => [
    el('h3', { textContent: heading }),
    el('ul', {}, ...items.map((text) => el('li', { textContent: text }))),
  ];
  const dialog = el(
    'dialog',
    { className: 'help' },
    el('h2', { textContent: '使い方' }),
    ...section('付箋', [
      '空いている場所をダブルクリック → 付箋を作る',
      '付箋の上端をドラッグ → 動かす',
      '右下をドラッグ → 大きさを変える',
      '選択して Delete → 削除する',
      'Shift + クリック、空いている場所をドラッグ → 複数を選ぶ（Ctrl + A で全部）',
    ]),
    ...section('接続線', [
      '付箋の縁の ● をドラッグ → 他の付箋とつなぐ',
      '空いている場所で離す → つないだ先に付箋を作る',
      '接続線をクリック → 線の種類やラベルを変える',
    ]),
    ...section('表示', [
      'ホイール、Space + ドラッグ → 表示位置を動かす',
      'Ctrl + ホイール、ピンチ → 拡大と縮小',
      'Ctrl + Z / Ctrl + Shift + Z → 元に戻す / やり直す（自分の操作だけ）',
    ]),
    ...section('Wiki', [
      '他のページへのリンクは、付箋の本文に /p/ページ名 へのリンクを張る',
      'agent（MCP）の操作は「操作の履歴」から取り消せる',
    ]),
    el('form', { method: 'dialog' }, el('button', { textContent: '閉じる' })),
  );
  // 背景（dialog の外側）のクリックでも閉じる。対象の要素ではなく座標で判定する
  // （余白のクリックや、文字をドラッグで選んだ後のクリックも、対象は dialog になるため）
  dialog.addEventListener('click', (e) => {
    const box = dialog.getBoundingClientRect();
    const inside =
      e.clientX >= box.left && e.clientX <= box.right && e.clientY >= box.top && e.clientY <= box.bottom;
    if (!inside) dialog.close();
  });
  return dialog;
}
