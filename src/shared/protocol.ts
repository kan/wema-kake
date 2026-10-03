import type { BoardContent, BoardData, HistoryDelta } from './delta';

/** ブラウザ → サーバー */
export type ClientMsg =
  | { type: 'hello'; clientId: string; lastSeq?: number }
  | { type: 'ops'; opId: string; deltas: HistoryDelta[] };

/** 確定した変更。送信元も含めた全員に配信する */
export interface OpsMsg {
  type: 'ops';
  seq: number;
  actor: string;
  clientId: string;
  opId: string;
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
  | { type: 'snapshot'; seq: number; title: string | null; data: BoardData }
  | OpsMsg
  /** 表示名が変わった。付箋の変更ではないので seq は進まない */
  | { type: 'meta'; title: string | null }
  | { type: 'reject'; opId: string; reason: string; current?: BoardContent };
