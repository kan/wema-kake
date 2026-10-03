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
  /** 送信元にだけ付く。サーバーが変えた分で、送信元はこれだけを適用する */
  fixups?: HistoryDelta[];
}

/** サーバー → ブラウザ */
export type ServerMsg =
  | { type: 'snapshot'; seq: number; data: BoardData }
  | OpsMsg
  | { type: 'reject'; opId: string; reason: string; current?: BoardContent };
