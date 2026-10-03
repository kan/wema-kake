import { WemaBoard } from '@kanf/wema';
import '@kanf/wema/style.css';
import { REASON_TEXT_CONFLICT } from '../shared/protocol';
import { isValidSlug } from '../shared/slug';
import { BoardSync, type SyncSocket, type SyncStatus, toSyncSocket } from './sync';

const app = document.getElementById('app')!;

/** WebSocket で接続し、接続が開いてから返す。開く前に閉じたら失敗にする */
function connect(slug: string): Promise<SyncSocket> {
  return new Promise((resolve, reject) => {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${scheme}://${location.host}/ws/${slug}`);
    ws.addEventListener('close', () => reject(new Error('websocket closed')), { once: true });
    ws.addEventListener('open', () => resolve(toSyncSocket(ws)), { once: true });
  });
}

/** 画像を R2 に上げ、付箋に入れる URL を返す */
async function uploadImage(file: File): Promise<string> {
  const res = await fetch('/api/images', {
    method: 'POST',
    headers: { 'Content-Type': file.type },
    body: file,
  });
  if (!res.ok) throw new Error(`image upload failed: ${res.status}`);
  return ((await res.json()) as { url: string }).url;
}

/**
 * 認証がまだ有効かを確かめる。期限が切れていると、API は 401 を返すか、Access が
 * ログイン画面へリダイレクトする。通信できないだけの場合は、有効として扱う（再接続を続ける）
 */
async function isAuthenticated(): Promise<boolean> {
  try {
    const res = await fetch('/api/session', { redirect: 'manual' });
    return res.status !== 401 && res.type !== 'opaqueredirect';
  } catch {
    return true;
  }
}

const NOTICE_MS = 8000;

const STATUS_TEXT: Record<SyncStatus, string> = {
  connecting: '接続中…',
  synced: '',
  offline: 'オフライン（再接続します）',
};

function openPage(slug: string): void {
  const header = document.createElement('header');
  header.className = 'page-header';
  const title = document.createElement('h1');
  const status = document.createElement('span');
  status.className = 'sync-status';
  // 一時的な通知。同期の状態（status）は頻繁に書き換わるので、別の要素にする
  const notice = document.createElement('span');
  notice.className = 'sync-notice';
  header.append(title, status, notice);

  const container = document.createElement('div');
  container.className = 'board';
  app.append(header, container);

  const showTitle = (value: string | null) => {
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

  // 最初の同期が済むまでは編集させない（同期でボード全体が入れ替わるため）
  const board = new WemaBoard({ container, readOnly: true, onImageUpload: uploadImage });

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
    isAuthenticated,
    onReject(reason) {
      notify(
        reason === REASON_TEXT_CONFLICT
          ? '他の人が同じ付箋を編集していたため、変更を取り消しました'
          : `変更を保存できなかったため、取り消しました（${reason}）`,
      );
    },
  });
  sync.start();
}

const slug = /^\/p\/([^/]+)$/.exec(location.pathname)?.[1];
if (slug && isValidSlug(slug)) {
  openPage(slug);
} else {
  app.textContent = 'wema-kake';
}
