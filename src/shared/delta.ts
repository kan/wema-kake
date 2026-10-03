import type { WemaBoardData, WemaEdge, WemaNote } from '@kanf/wema';

export type { WemaEdge, WemaNote };

/**
 * 変更の単位。wema の HistoryManager が作るデルタと同じ形
 * （wema が `HistoryDelta` を export したらそちらに置き換える。kan/wema#50）。
 *
 * update の `after` にキーがなく `before` にあるものは「未設定に戻す」を表す。
 * 値が `undefined` のキーは JSON にすると消えるため、この規則で復元する。
 */
export type HistoryDelta =
  | { type: 'note:create'; note: WemaNote }
  | { type: 'note:update'; noteId: string; before: Partial<WemaNote>; after: Partial<WemaNote> }
  | { type: 'note:delete'; note: WemaNote }
  | { type: 'edge:create'; edge: WemaEdge }
  | { type: 'edge:update'; edgeId: string; before: Partial<WemaEdge>; after: Partial<WemaEdge> }
  | { type: 'edge:delete'; edge: WemaEdge };

/** viewport は各クライアントの表示状態なので保存しない */
export type BoardData = Omit<WemaBoardData, 'viewport'>;

/** 付箋と接続線の一部（拒否したときに返す現在値など） */
export type BoardContent = Pick<BoardData, 'notes' | 'edges'>;

export interface Snapshot {
  seq: number;
  data: BoardData;
}
