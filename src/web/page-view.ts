// ページの画面（/p/<slug>）。wema のボードと、見出し（表示名、バックリンク、操作の履歴、削除）。
import { WemaBoard, type WemaNote } from '@kanf/wema';
import { MAX_TITLE_LENGTH, type OpSummary, type RevertOutcome, type SkipReason } from '../shared/api';
import { CHILD_NOTE_SIZE, CHILD_PAGE_KEY, childPageOf } from '../shared/hierarchy';
import { parseSystemSummary } from '../shared/op-summary';
import { REASON_TEXT_CONFLICT } from '../shared/protocol';
import * as api from './api';
import { bookmarkStar, pageLinks, pageNavMenu } from './bookmarks';
import { ChildNotes, childPageForm } from './child-notes';
import {
  confirmDeletePage,
  el,
  failureMessage,
  formatDate,
  isPlainClick,
  openInternalLink,
  textInput,
  type FailureKey,
} from './dom';
import { t } from './i18n';
import { icon, type IconName } from './icons';
import { site } from './site';
import {
  navigate,
  onViewEnd,
  pageSlugOf,
  setBeforeLeave,
  setPopLeave,
  type Transition,
  viewSignal,
} from './navigation';
import { NoteAuthors } from './note-authors';
import { dropOntoChildPages } from './note-drop';
import { stackOnNarrow } from './stacked-view';
import { BoardSync, type SyncSocket, type SyncStatus, toSyncSocket } from './sync';
import {
  centerOnNotes,
  header,
  historyButtons,
  iconButton,
  menuItem,
  modal,
  pageColorPicker,
  popover,
  separator,
  settings,
  switchLang,
  toast,
  WEMA_LABELS,
  zoomControls,
} from './toolbar';
import { zoomTransitions } from './viewport-motion';
import { rememberViewport } from './viewport-store';

const NOTICE_MS = 8000;
/** 他のページへ切り替える前に、保存中の変更を待つ時間の上限 */
const LEAVE_WAIT_MS = 1500;

/** ブラウザごとの設定のキー。ページの内容と同期の対象には含めない */
const VIEW_ONLY_KEY = 'view-only';
const THEME_KEY = 'theme';

/** 整列のボタン（アイコン、説明、wema に渡す整列の種類） */
const ALIGNMENTS = [
  ['alignLeft', t('align.left'), 'left'],
  ['alignCenter', t('align.center'), 'center'],
  ['alignRight', t('align.right'), 'right'],
  ['alignTop', t('align.top'), 'top'],
  ['alignMiddle', t('align.middle'), 'middle'],
  ['alignBottom', t('align.bottom'), 'bottom'],
] as const;

const STATUS_TEXT: Record<SyncStatus, string> = {
  connecting: t('status.connecting'),
  synced: '',
  offline: t('status.offline'),
};

/** 取り消さなかった理由の表示 */
const SKIP_REASON: Record<SkipReason, string> = {
  modified: t('skip.modified'),
  connected: t('skip.connected'),
  deleted: t('skip.deleted'),
  exists: t('skip.exists'),
  'endpoint-missing': t('skip.endpoint-missing'),
};

/** 取り消しの結果を知らせる文言 */
function revertMessage(result: RevertOutcome): string {
  const reasons = [...new Set(result.skipped.map((s) => SKIP_REASON[s.reason]))];
  const why = reasons.length > 0 ? t('revert.reasons', reasons) : '';
  if (result.applied === 0) return t('revert.none', why);
  if (result.skipped.length === 0) return t('revert.done');
  return t('revert.partial', result.skipped.length, why);
}

/** 操作の履歴に出す要約。サーバーの付けた符号は、今の言語の文言にする。それ以外は、書かれたまま出す */
function summaryText(op: OpSummary): string {
  if (op.summary === null) return op.reverts !== null ? t('ops.summary.revertUnknown') : t('ops.noSummary');
  const system = parseSystemSummary(op.summary);
  switch (system?.kind) {
    case 'pageCreated':
      return t('ops.summary.pageCreated');
    case 'childRemoved':
      return t('ops.summary.childRemoved', system.page);
    case 'revert':
      return t('ops.summary.revert', system.seq);
    case 'notesReceived':
      return t('ops.summary.notesReceived', system.page);
    case 'childRecolored':
      return t('ops.summary.childRecolored', system.page);
    default:
      return op.summary;
  }
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

/** `arrival` は、どのように切り替わってきたか。最初の同期が済んだときに、最初の表示位置を決めるのに使う */
export function openPage(app: HTMLElement, slug: string, arrival?: Transition): void {
  let currentTitle: string | null = null;
  /** このタブで削除を実行中か。完了を待ってから一覧へ戻るので、切断の通知では戻らない */
  let deleting = false;

  // --- ボード ---
  // ヘッダーのボタンがボードを操作するので、ボードを先に作る。
  // 最初の同期が済むまでは編集させない（同期でボード全体が入れ替わるため）
  const container = el('div', { className: 'board' });
  const body = el('div', { className: 'page-body' }, container);
  // 子ページの付箋は、本文の代わりに子ページの概要を出す。表示名を押すと、子ページへ入る
  const childNotes = new ChildNotes(slug, (child, noteId) => void zoom.enter(noteId, `/p/${child}`));
  const noteAuthors = new NoteAuthors();
  const board = new WemaBoard({
    container,
    readOnly: true,
    theme: settings.get(THEME_KEY) === 'card' ? 'card' : 'default',
    onImageUpload: api.uploadImage,
    // 他のページへのリンク（Wiki リンク）は、同じタブで開く
    onLinkClick: openInternalLink,
    renderNote: childNotes.render,
    // 付箋の下に、作成者と更新日時を出す（wema 0.16.0）。出るのは、ホバーしたときと、付箋を選んだとき
    renderNoteAccessory: noteAuthors.render,
    // 付箋を縦に積んでいる間は、接続線の代わりに、つながっている相手を付箋の下に出す（wema 0.15.0）。
    // 相手が子ページの付箋なら、本文（空）の代わりに、子ページの表示名を出す。表示名が後から
    // 分かったときは、ChildNotes がその付箋を refreshNote() で描き直し、wema が相手の印も描き直す
    noteLinks: {
      text(peer) {
        const child = childPageOf(peer);
        return child === undefined ? undefined : childNotes.titleOf(child);
      },
    },
    labels: WEMA_LABELS,
    // 空いている場所のドラッグは、表示位置を動かす。範囲で選ぶのは、Ctrl / Cmd か Shift + ドラッグ
    emptyDrag: 'pan',
  });
  childNotes.attach(board);

  // 倍率は、ページごとにブラウザへ保存する（次に開いたときと、子ページから戻ったときに使う）。
  // 表示位置は覚えず、開くたびに付箋全体の中央から始める
  // スマートフォンの幅では、付箋を縦 1 列に積んで表示する。その間は等倍で、倍率を覚えない。
  // 幅を広げて配置へ戻ったら、最初に開いたときと同じ位置と倍率にする
  const stack = stackOnNarrow(board, container, {
    onChange(stacked) {
      if (!stacked) viewport.restore();
    },
  });
  const viewport = rememberViewport(board, slug, container, stack.isStacked);

  // --- 階層を移るときの、ズームの演出（子ページへ入る、親ページや一覧へ戻る） ---
  // 演出で変えた倍率を、このページの見ていた倍率として保存しない
  const zoom = zoomTransitions(board, viewport.freeze, stack.isStacked);
  /** 上の階層（先祖のページか、一覧）へのリンクを、縮んでから切り替わるようにする */
  const leaveOnClick = (link: HTMLAnchorElement, from: () => string) => {
    link.addEventListener('click', (e) => {
      if (!isPlainClick(e)) return;
      e.preventDefault();
      void zoom.leave(link.href, from());
    });
    return link;
  };
  /** このボードに置いてある、子ページ `page` の付箋 */
  const childNote = (page: string) => board.getNotes().find((note) => childPageOf(note) === page);
  /** ルートからこのページまでの道筋（このページを含む）。先祖が分かるまでは、このページだけ */
  let lineage = [slug];
  /** このページのルート（一覧に付箋として出ているページ） */
  const root = () => lineage[0];
  // ブラウザの「戻る」と「進む」でも、階層を移るなら、同じ演出を入れる
  setPopLeave((path) => {
    if (path === '/') return zoom.leaveOnPop(root());
    const target = pageSlugOf(path);
    if (target === undefined || target === slug) return undefined;
    // 先祖のページへ戻る。戻り先に置いてあるのは、道筋の上で 1 つ下のページ
    const at = lineage.indexOf(target);
    if (at >= 0) return zoom.leaveOnPop(lineage[at + 1]);
    // このボードに置いてある子ページへ入る
    const note = childNote(target);
    return note && zoom.enterOnPop(note.id);
  });
  /** 最初の表示位置を決める。入ってきたときは小さい状態から、戻ってきたときは子ページの付箋から広げる */
  const arrive = async () => {
    if (stack.isStacked()) {
      // 積んでいる間は、表示位置と倍率を動かせない（演出は zoom が省く）。列の先頭から始める。
      // 子ページから戻ってきたときは、その子ページの付箋が見える位置までスクロールする
      const from = arrival?.kind === 'leave' ? childNote(arrival.from) : undefined;
      if (from) board.revealNotes([from.id]);
    } else {
      viewport.restore();
    }
    await zoom.arrive(arrival, childNote);
    // 倍率の保存は、演出が済んでから始める（演出の途中の倍率を、見ていた倍率として保存しない）
    viewport.start();
  };

  // 一時的な通知は、ボードの上に重ねて出す
  const notify = toast(body, NOTICE_MS);
  const fail = (what: FailureKey) => (e: unknown) => notify(failureMessage(what, e));

  // --- ヘッダーの左: 今いる場所 ---
  const title = el('h1', { className: 'page-title', title: t('page.titleHint', slug) });
  // 同期の状態。同期済みのときは何も出さない。文言は title に入れ、文字で出すのはオフラインのときだけ
  const status = el('span', { className: 'sync-status' });
  const crumbs = el('span', { className: 'crumbs' });

  const showTitle = (value: string | null) => {
    currentTitle = value;
    title.textContent = value ?? slug;
    document.title = t('documentTitle', value ?? slug, site.siteName);
  };
  showTitle(null);
  // ページの色。ヘッダーの地の色にする。変更は、サーバーから届いたときにも反映する（他の人の変更）。
  // 自分の変更は、応答で反映する（切断中は、サーバーからの知らせが届かない）
  const colorPicker = pageColorPicker((color) => {
    api
      .setColor(slug, color)
      .then((result) => showColor(result.color))
      .catch(fail('failed.color'));
  });

  // --- ヘッダーの中央: 付箋の操作 ---
  const { undo: undoButton, redo: redoButton } = historyButtons(board);
  /**
   * 新しい付箋を置く位置。見えている範囲の左上の近くで、続けて置いても重ならないよう、少しずつずらす。
   * 積んでいる間は、位置を渡さない（wema が、データの上では既存の付箋の左下に置く。列では最後に並び、
   * 広い画面で開いても、他の付箋と重ならない）
   */
  const nextNotePosition = () => {
    if (stack.isStacked()) return {};
    const offset = (board.getNotes().length % 10) * 20;
    const viewport = board.getViewport();
    return { x: (120 + offset - viewport.x) / viewport.zoom, y: (80 + offset - viewport.y) / viewport.zoom };
  };
  /** 付箋を足す。積んでいる間は列の最後に入るので、見える位置までスクロールする */
  const addNote = (params: Parameters<WemaBoard['addNote']>[0] = {}) => {
    // 型の上では必ず付箋が返るが、編集できないとき（ロック、参照モード）は、何も作らず undefined が返る
    const note = board.addNote({ ...nextNotePosition(), ...params }) as WemaNote | undefined;
    if (note && stack.isStacked()) board.revealNotes([note.id]);
  };
  const addButton = iconButton('add', t('note.add'), () => addNote());

  // 子ページを置く。新しく作るか、既存のルートのページを選ぶ
  const childForm = childPageForm(slug, (child) => {
    // 本文は持たせない。置けるかどうか（親は 1 つだけ、輪にならない、深さ）は、サーバーが確かめる。
    // 断られたら、同期が付箋を取り消して、理由を通知する
    addNote({ ...CHILD_NOTE_SIZE, text: '', meta: { [CHILD_PAGE_KEY]: child } });
    childPopover.close();
  });
  const childButton = iconButton('childPage', t('child.place'));
  const childPopover = popover(childButton, childForm.root, { onOpen: childForm.opened });

  /** 自動配置。並べ直した付箋全体の中央へ動かす（倍率は変えない） */
  const autoLayout = () => {
    board.autoLayout();
    centerOnNotes(board, container);
  };
  // 選んだ付箋が 2 枚未満のときは、自動配置しか押せないので、メニューを開かずにそのまま自動配置する
  const layoutTrigger = iconButton('layout', t('layout.title'));
  const layoutDirect = () => board.getSelection().length < 2;
  const layoutPanel = el('div', { className: 'layout-panel' });
  const layout = popover(layoutTrigger, layoutPanel, {
    instead: () => {
      if (!layoutDirect()) return false;
      autoLayout();
      return true;
    },
  });
  /** ボタンの見た目を、メニューか自動配置かに合わせる。直前の状態（未設定は undefined） */
  let layoutShownDirect: boolean | undefined;
  const showLayoutTrigger = (direct: boolean) => {
    if (direct === layoutShownDirect) return;
    layoutShownDirect = direct;
    layout.close();
    const label = direct ? t('layout.auto') : t('layout.title');
    layoutTrigger.title = layoutTrigger.ariaLabel = label;
    layoutTrigger.replaceChildren(icon(direct ? 'autoLayout' : 'layout'));
    // 自動配置のボタンは、開くメニューを持たない
    layoutTrigger.ariaExpanded = direct ? null : 'false';
  };
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
  layoutButton('distributeH', t('layout.distributeH'), 3, (s) => board.distributeNotes(s, 'horizontal'));
  layoutButton('distributeV', t('layout.distributeV'), 3, (s) => board.distributeNotes(s, 'vertical'));
  layoutButton('autoLayout', t('layout.auto'), 0, autoLayout);

  /** ボタンの有効と無効を、ボードの状態に合わせる。自前の状態は持たない */
  const updateTools = () => {
    const locked = board.isReadOnly() || board.isViewOnly();
    undoButton.disabled = locked || !board.canUndo();
    redoButton.disabled = locked || !board.canRedo();
    addButton.disabled = locked;
    childButton.disabled = locked;
    const selected = board.getSelection().length;
    for (const [button, needs] of layoutButtons) button.disabled = locked || selected < needs;
    // メニューを開かずに自動配置するときは、編集できなければ押せなくする
    const direct = layoutDirect();
    showLayoutTrigger(direct);
    layoutTrigger.disabled = direct && locked;
  };
  // Ctrl / Cmd + A で全選択（wema のスタンドアロン版と同じ。入力中は、入力欄の全選択のままにする）
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.key !== 'a') return;
    // 編集できないとき（最初の同期前、削除後）と、操作の履歴を重ねて出している間は、何もしない
    if (board.isReadOnly() || document.querySelector('dialog[open]')) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && (active.isContentEditable || active.matches('input, textarea'))) return;
    e.preventDefault();
    board.selectAll();
  }, { signal: viewSignal() });

  board.on('readOnly:change', updateTools);
  board.on('history:change', updateTools);
  board.on('note:select', updateTools);
  // 選択中の付箋が削除されたとき（他の人の削除を含む）は note:select が届かないので、ここで拾う
  board.on('note:delete', updateTools);
  updateTools();

  // --- ヘッダーの右: Wiki の機能 ---
  const backlinksButton = el('button', { type: 'button', className: 'text-button', hidden: true });
  const backlinksPanel = el('div', { className: 'link-list' });
  const menuPanel = el('div', { className: 'menu' });
  const menu = popover(iconButton('menu', t('menu.title')), menuPanel, { align: 'right' });
  // ★ でこのページをブックマークし、ブックマークしたページの一覧から移る
  const star = bookmarkStar(slug, fail('failed.bookmark'));

  const pageHeader = header(
    // 一覧へ戻るときは、このページのルートの付箋へ縮む
    [leaveOnClick(el('a', { href: '/', textContent: t('list') }), root), crumbs, title, colorPicker.root, star, status],
    [
      el('span', { className: 'tool-group' }, undoButton, redoButton),
      separator(),
      el('span', { className: 'tool-group' }, addButton, childPopover.root),
      separator(),
      el('span', { className: 'tool-group optional' }, layout.root, separator(), zoomControls(board, container)),
    ],
    [popover(backlinksButton, backlinksPanel, { align: 'right' }).root, pageNavMenu(), menu.root],
  );
  app.append(pageHeader, body);
  const showColor = (color: string | null) => {
    // サーバーが PAGE_COLORS のどれかであることを確かめた値。なければ、スタイルシートの既定の色に戻る
    pageHeader.style.backgroundColor = color ?? '';
    colorPicker.show(color);
  };

  // --- パンくず（ルートから親までの道筋。URL を直接開いたときも出る） ---
  api
    .getAncestors(slug)
    .then(({ ancestors }) => {
      lineage = [...ancestors.map((page) => page.name), slug];
      ancestors.forEach((page, i) => {
        // 戻り先のページに置いてあるのは、道筋の上で 1 つ下のページ
        const child = lineage[i + 1];
        const link = el('a', { href: `/p/${page.name}`, textContent: page.title ?? page.name });
        crumbs.append(leaveOnClick(link, () => child), '›');
      });
    })
    .catch(fail('failed.ancestors'));

  // --- 同期 ---
  const sync = new BoardSync(board, () => connect(slug), {
    onNoteInfo: noteAuthors.refresh,
    // 最初の同期が済んだときに、1 回だけ呼ばれる
    onReady() {
      board.setReadOnly(false);
      // 参照モードは、サーバーの内容を読み込んだ後に入る（入った時点の位置を wema が覚えるため）
      if (settings.get(VIEW_ONLY_KEY) === '1') board.setViewOnly(true);
      // 縦積みの切り替えは、付箋を読み込んでから始める
      stack.start();
      // 付箋全体の中央から始める。倍率は、前に見ていた倍率か、なければ全体が収まる倍率
      void arrive();
    },
    onStatus(state, pending) {
      const text = state === 'synced' && pending > 0 ? t('status.saving') : STATUS_TEXT[state];
      // 操作のたびに呼ばれるので、変わったときだけ書き換える
      if (status.title !== text) {
        status.title = text;
        status.textContent = state === 'offline' ? text : '';
      }
      if (status.dataset.state !== state) status.dataset.state = state;
    },
    onTitle: showTitle,
    onColor: showColor,
    // 認証し直すには、Access を通る通常のページ読み込みが要る
    onAuthExpired: () => location.reload(),
    isAuthenticated: api.isAuthenticated,
    onDeleted() {
      board.setReadOnly(true);
      if (deleting) return;
      alert(t('page.deletedAlert'));
      location.assign('/');
    },
    onReject(reason) {
      notify(
        reason === REASON_TEXT_CONFLICT
          ? t('sync.conflict')
          : (childForm.rejectionMessage(reason) ?? t('sync.rejected', reason)),
      );
    },
  });
  noteAuthors.attach(board, (noteId) => sync.noteInfo(noteId));
  sync.start();

  // 付箋を、子ページの付箋の上へドラッグして放すと、その子ページへ移す（Ctrl / Cmd で写す）
  const drops = dropOntoChildPages(board, container, {
    slug,
    clientId: sync.clientId,
    titleOf: (child) => childNotes.titleOf(child),
    notify,
    onSent: (page) => childNotes.contentChanged(page),
  });

  // 読み込みなしで他のページへ切り替わるときの後始末。保存中の変更を送り終えるのを少し待ってから、
  // 同期を止めて、ボードを破棄する
  setBeforeLeave(async () => {
    const deadline = Date.now() + LEAVE_WAIT_MS;
    // 子ページへ送っている途中の付箋があれば、送り終えて、このページから消すところまで待つ
    await Promise.race([drops.settled(), new Promise((resolve) => setTimeout(resolve, LEAVE_WAIT_MS))]);
    while (sync.pendingCount > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  });
  onViewEnd(() => {
    sync.stop();
    board.destroy();
  });

  // --- 表示名の編集 ---
  title.addEventListener('click', () => {
    const input = textInput({
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
      if (save && value !== (currentTitle ?? '')) api.setTitle(slug, value).catch(fail('failed.rename'));
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
      backlinksButton.textContent = t('backlinks.count', pages.length);
      backlinksButton.title = t('backlinks.title');
      backlinksButton.hidden = false;
      backlinksPanel.append(...pageLinks(pages));
    })
    .catch(fail('failed.backlinks'));

  // --- 操作の履歴と取り消し ---
  const agentOnly = el('input', { type: 'checkbox', checked: true });
  const opList = el('ul', { className: 'op-list' });

  // 取り消しの結果と、失敗の理由。重ねて出している間は、ボードの上の通知が背景の下になるので、ここに出す
  const opResult = el('div', { className: 'op-result', role: 'status' });
  const opFail = (what: FailureKey) => (e: unknown) => {
    opResult.textContent = failureMessage(what, e);
  };

  const loadOps = async () => {
    const { ops } = await api.getOps(slug, agentOnly.checked);
    opList.replaceChildren(...ops.map(opRow));
    if (ops.length === 0) opList.append(el('li', { className: 'empty', textContent: t('ops.empty') }));
  };
  const refreshOps = () => loadOps().catch(opFail('failed.history'));

  const revert = async (op: OpSummary, button: HTMLButtonElement) => {
    button.disabled = true;
    try {
      opResult.textContent = revertMessage(await api.revertOp(slug, op.seq, sync.clientId));
      await loadOps();
    } catch (e) {
      opFail('failed.revert')(e);
    }
  };

  function opRow(op: OpSummary): HTMLLIElement {
    const reverted = op.revertedBy !== null;
    const button = el('button', { type: 'button', textContent: t('ops.revert'), disabled: reverted });
    button.addEventListener('click', () => void revert(op, button));
    const summary = summaryText(op);
    return el(
      'li',
      { className: reverted ? 'reverted' : '' },
      el('div', { className: 'op-meta', textContent: `${formatDate(op.createdAt)} ${op.actor}` }),
      el('div', { className: 'op-summary', textContent: summary + (reverted ? t('ops.revertedMark') : '') }),
      button,
    );
  }

  agentOnly.addEventListener('change', refreshOps);
  // 重ねて出す（メニューの「操作の履歴」から開く）。ボードの幅は取らない
  const historyDialog = modal(
    'history-dialog',
    el('h2', { textContent: t('ops.title') }),
    el(
      'div',
      { className: 'history-head' },
      el('label', {}, agentOnly, ' ', t('ops.agentOnly')),
      el('button', { type: 'button', textContent: t('ops.refresh'), onclick: refreshOps }),
    ),
    opResult,
    opList,
  );
  app.append(historyDialog);

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
    viewOnlyItem.textContent = t(board.isViewOnly() ? 'menu.viewOnlyExit' : 'menu.viewOnly');
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
    themeItem.textContent = t(board.getTheme() === 'card' ? 'menu.themeCard' : 'menu.themeDefault');
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
        fail('failed.delete')(e);
      });
  };

  menuPanel.append(
    viewOnlyItem,
    themeItem,
    menuItem(t('menu.history'), () => {
      menu.close();
      opResult.textContent = '';
      historyDialog.showModal();
      void refreshOps();
    }),
    menuItem(t('menu.exportJson'), exportJson),
    // 使い方は、試すためのボードで見せる（保存しない。src/web/help-view.ts）
    menuItem(t('help'), () => navigate('/help')),
    // 切り替え先の言語の名前を出す。選ぶと、この端末に記憶して、読み込み直す
    menuItem(t('lang.switch'), switchLang),
    el('hr'),
    // 削除は、常に見える場所には置かない
    menuItem(t('menu.deletePage'), deletePage, 'danger'),
  );
}
