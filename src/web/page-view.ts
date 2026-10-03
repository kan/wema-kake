// ページの画面（/p/<slug>）。wema のボードと、見出し（表示名、バックリンク、操作の履歴、削除）。
import { WemaBoard } from '@kanf/wema';
import { MAX_TITLE_LENGTH, type OpSummary, type RevertOutcome, type SkipReason } from '../shared/api';
import { REASON_TEXT_CONFLICT } from '../shared/protocol';
import * as api from './api';
import { el, errorMessage, formatDate } from './dom';
import { BoardSync, type SyncSocket, type SyncStatus, toSyncSocket } from './sync';

const NOTICE_MS = 8000;

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

  // --- 見出し ---
  const title = el('h1', { className: 'page-title', title: 'クリックして表示名を変える' });
  const status = el('span', { className: 'sync-status' });
  // 一時的な通知。同期の状態（status）は頻繁に書き換わるので、別の要素にする
  const notice = el('span', { className: 'sync-notice' });
  const backlinks = el('span', { className: 'backlinks' });
  const historyButton = el('button', { type: 'button', textContent: '操作の履歴' });
  const deleteButton = el('button', { type: 'button', className: 'danger', textContent: '削除' });
  const header = el(
    'header',
    { className: 'page-header' },
    el('a', { href: '/', textContent: '一覧' }),
    title,
    status,
    notice,
    el('span', { className: 'spacer' }),
    backlinks,
    historyButton,
    deleteButton,
  );

  const container = el('div', { className: 'board' });
  const historyPanel = el('aside', { className: 'history-panel', hidden: true });
  app.append(header, el('div', { className: 'page-body' }, container, historyPanel));

  const showTitle = (value: string | null) => {
    currentTitle = value;
    title.textContent = value ?? slug;
    document.title = `${value ?? slug} - wema-kake`;
  };
  showTitle(null);

  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  const notify = (text: string) => {
    notice.textContent = text;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => (notice.textContent = ''), NOTICE_MS);
  };
  const fail = (what: string) => (e: unknown) => notify(`${what}に失敗しました（${errorMessage(e)}）`);

  // --- ボードと同期 ---
  // 最初の同期が済むまでは編集させない（同期でボード全体が入れ替わるため）
  const board = new WemaBoard({ container, readOnly: true, onImageUpload: api.uploadImage });

  const sync = new BoardSync(board, () => connect(slug), {
    onReady: () => board.setReadOnly(false),
    onStatus(state, pending) {
      const text = state === 'synced' && pending > 0 ? '保存中…' : STATUS_TEXT[state];
      // 操作のたびに呼ばれるので、変わったときだけ書き換える
      if (status.textContent !== text) status.textContent = text;
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
      if (pages.length === 0) return;
      backlinks.append('リンク元: ');
      pages.forEach((p, i) => {
        if (i > 0) backlinks.append('、');
        backlinks.append(el('a', { href: `/p/${p.name}`, textContent: p.title ?? p.name }));
      });
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

  // --- 削除 ---
  deleteButton.addEventListener('click', () => {
    const name = currentTitle ?? slug;
    if (!confirm(`ページ「${name}」を削除します。付箋と履歴がすべて消え、取り消しはできません。`)) return;
    deleting = true;
    api
      .deletePage(slug)
      // 削除が済んでから戻る（先に戻ると、一覧にまだ出ていることがある）
      .then(() => location.assign('/'))
      .catch((e) => {
        deleting = false;
        fail('削除')(e);
      });
  });
}
