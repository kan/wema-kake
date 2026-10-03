import type { HistoryDelta, WemaBoardData, WemaEdge, WemaNote } from '@kanf/wema';

// 変更の単位は wema の HistoryDelta（Undo 1 回分を構成するデルタ）。
// update の `after` にキーがなく `before` にあるものは「未設定に戻す」を表す。
// 値が `undefined` のキーは JSON にすると消えるため、この規則で復元する。
export type { HistoryDelta, WemaEdge, WemaNote };

/** 操作を打ち消すデルタ。逆順にし、作成と削除、before と after を入れ替える */
export function invertDeltas(deltas: HistoryDelta[]): HistoryDelta[] {
  return [...deltas].reverse().map((d): HistoryDelta => {
    switch (d.type) {
      case 'note:create':
        return { type: 'note:delete', note: d.note };
      case 'note:delete':
        return { type: 'note:create', note: d.note };
      case 'edge:create':
        return { type: 'edge:delete', edge: d.edge };
      case 'edge:delete':
        return { type: 'edge:create', edge: d.edge };
      case 'note:update':
        return { type: d.type, noteId: d.noteId, before: d.after, after: d.before };
      case 'edge:update':
        return { type: d.type, edgeId: d.edgeId, before: d.after, after: d.before };
    }
  });
}

/** viewport は各クライアントの表示状態なので保存しない */
export type BoardData = Omit<WemaBoardData, 'viewport'>;

/** 付箋と接続線の一部（拒否したときに返す現在値など） */
export type BoardContent = Pick<BoardData, 'notes' | 'edges'>;

export interface Snapshot {
  seq: number;
  /** 表示名。未設定なら null（表示にはスラッグを使う） */
  title: string | null;
  /**
   * ページを作るたびに変わる値。まだ作られていなければ null。
   * 削除して作り直したページを、前のページと見分けるのに使う
   */
  epoch: string | null;
  data: BoardData;
}
