import type { HistoryDelta, Snapshot } from './delta';
import type { Reaction } from './note-info';

/** 認証の期限が切れた接続を、サーバーが閉じるときのコード。クライアントは再読み込みして認証し直す */
export const CLOSE_AUTH_EXPIRED = 4401;

/**
 * ページが削除されたときに、サーバーが接続を閉じるコード。クライアントは再接続しない
 * （再接続すると、手元の未確定の操作でページが作り直されてしまう）
 */
export const CLOSE_PAGE_DELETED = 4410;

/**
 * 承認（設定の `approval`）を取り消された人の接続を、サーバーが閉じるコード。クライアントは、認証の
 * 期限切れと同じく、ページを読み込み直す（承認待ちの表示になる）
 */
export const CLOSE_NOT_APPROVED = 4403;

/** 接続維持のためにクライアントが送る文字列と、サーバーの応答（JSON ではない） */
export const PING = 'ping';
export const PONG = 'pong';

/**
 * ページがロック（編集の禁止）されていて、書き込みを断ったときの `reason`。HTTP の API は 423 にする。
 * 付箋の移動で、元のページがロックされていたときは、後ろに `: <スラッグ>` が付く
 */
export const REASON_PAGE_LOCKED = 'page locked';

/** text の更新で、`before.text` がサーバーの現在値と違ったときの `reject` の `reason` */
export const REASON_TEXT_CONFLICT = 'text conflict';

/** 途中の動きで送る値のキー。中身に合わせて決まる大きさ（autoSize、foldable の高さ）は送らない */
export const PREVIEW_KEYS = ['x', 'y', 'width', 'height'] as const;

export type PreviewKey = (typeof PREVIEW_KEYS)[number];

/** 付箋の位置と大きさのうち、途中の動きで変わったもの */
export type PreviewValues = Partial<Record<PreviewKey, number>>;

/**
 * ドラッグや大きさの変更の途中の、付箋の位置と大きさ（issue #123）。確定した値ではないので、
 * サーバーは保存せず、seq も進めずに、ほかの接続へ中継するだけ。確定した値は、操作が終わったときの
 * `ops` で届く
 */
export type PreviewNote = { id: string } & PreviewValues;

/** 送る側が、途中の動きをまとめて送る間隔（ミリ秒） */
export const PREVIEW_INTERVAL_MS = 50;

/** 1 つの `preview` に入れられる付箋の数。超えた分は送らない（サーバーも捨てる） */
export const MAX_PREVIEW_NOTES = 100;

/** ブラウザ → サーバー */
export type ClientMsg =
  /**
   * `epoch` は、前に受け取ったスナップショットの値（あれば）。サーバーの今の値と違えば、
   * ページが削除されたか作り直されているので、サーバーは CLOSE_PAGE_DELETED で閉じる
   */
  | { type: 'hello'; clientId: string; lastSeq?: number; epoch?: string }
  | { type: 'ops'; opId: string; deltas: HistoryDelta[] }
  | { type: 'preview'; notes: PreviewNote[] };

/** 確定した変更。送信元も含めた全員に配信する */
export interface OpsMsg {
  type: 'ops';
  seq: number;
  actor: string;
  /** agent の操作なら、その委任者（agent を認可した人の 'user:<email>'）。分からなければ付かない */
  delegate?: string;
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

/**
 * 付箋のリアクションが変わった。付箋の id から、その付箋の今のリアクションの全体（なければ空の配列）。
 * `replace` なら、ページ全体の今のリアクションで、ここにない付箋にはリアクションがない（再接続して
 * 差分で追いつくときに送る。リアクションは ops に積まないので、差分に出ない）
 */
export interface ReactionsMsg {
  type: 'reactions';
  reactions: Record<string, Reaction[]>;
  replace?: true;
}

/** サーバー → ブラウザ */
export type ServerMsg =
  | ReactionsMsg
  | ({ type: 'snapshot' } & Snapshot)
  | OpsMsg
  /**
   * 表示名、ページの色、自動で消す日数、ロックが変わった。付箋の変更ではないので seq は進まない。
   * `locked` と `expireSince` は、古い Worker では付かない
   */
  | {
      type: 'meta';
      title: string | null;
      color: string | null;
      epoch: string | null;
      expireDays: number | null;
      locked?: boolean;
      expireSince?: number | null;
    }
  /**
   * 操作を受け付けなかった。送信元は手元の変更を巻き戻し、`fixups`（サーバーの現在値に
   * 合わせるためのデルタ。text が競合した付箋など）を適用する
   */
  | { type: 'reject'; opId: string; reason: string; fixups?: HistoryDelta[] }
  /** ほかの接続の、ドラッグや大きさの変更の途中の動き。`clientId` は送り主の接続（サーバーが付ける） */
  | { type: 'preview'; clientId: string; notes: PreviewNote[] };
