import type { HistoryDelta, Snapshot } from './delta';

/** 認証の期限が切れた接続を、サーバーが閉じるときのコード。クライアントは再読み込みして認証し直す */
export const CLOSE_AUTH_EXPIRED = 4401;

/**
 * ページが削除されたときに、サーバーが接続を閉じるコード。クライアントは再接続しない
 * （再接続すると、手元の未確定の操作でページが作り直されてしまう）
 */
export const CLOSE_PAGE_DELETED = 4410;

/** 接続維持のためにクライアントが送る文字列と、サーバーの応答（JSON ではない） */
export const PING = 'ping';
export const PONG = 'pong';

/** text の更新で、`before.text` がサーバーの現在値と違ったときの `reject` の `reason` */
export const REASON_TEXT_CONFLICT = 'text conflict';

/** ブラウザ → サーバー */
export type ClientMsg =
  /**
   * `epoch` は、前に受け取ったスナップショットの値（あれば）。サーバーの今の値と違えば、
   * ページが削除されたか作り直されているので、サーバーは CLOSE_PAGE_DELETED で閉じる
   */
  | { type: 'hello'; clientId: string; lastSeq?: number; epoch?: string }
  | { type: 'ops'; opId: string; deltas: HistoryDelta[] };

/** 確定した変更。送信元も含めた全員に配信する */
export interface OpsMsg {
  type: 'ops';
  seq: number;
  actor: string;
  clientId: string;
  opId: string;
  /**
   * 操作を記録した時刻（UNIX ミリ秒）。付箋ごとの付加情報（src/shared/note-info.ts）の更新に使う。
   * 配信と、再接続のときの差分に付く。配信しなかった結果を送信元にだけ返すとき（再送への応答、
   * デルタをすべて捨てた操作）には付かない
   */
  createdAt?: number;
  /** サーバーが実際に適用したデルタ。送信元は自分の opId のものを適用しない */
  deltas: HistoryDelta[];
  summary?: string;
  /**
   * この操作が取り消しなら、取り消した対象の seq。取り消しは HTTP の API か MCP から行われ、
   * 要求元のブラウザも手元には適用していない。自分の clientId の操作でも、これがあれば適用する
   */
  reverts?: number;
  /** 送信元にだけ付く。サーバーが変えた分で、送信元はこれだけを適用する */
  fixups?: HistoryDelta[];
}

/** サーバー → ブラウザ */
export type ServerMsg =
  | ({ type: 'snapshot' } & Snapshot)
  | OpsMsg
  /** 表示名、ページの色、自動で消す日数が変わった。付箋の変更ではないので seq は進まない */
  | { type: 'meta'; title: string | null; color: string | null; epoch: string | null; expireDays: number | null }
  /**
   * 操作を受け付けなかった。送信元は手元の変更を巻き戻し、`fixups`（サーバーの現在値に
   * 合わせるためのデルタ。text が競合した付箋など）を適用する
   */
  | { type: 'reject'; opId: string; reason: string; fixups?: HistoryDelta[] };
