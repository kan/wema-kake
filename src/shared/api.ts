// サーバーとブラウザの両方が使う、HTTP API と DO のメソッドの型と定数。

/** 表示名の長さの上限 */
export const MAX_TITLE_LENGTH = 200;

/** 検索語の長さの上限 */
export const MAX_QUERY_LENGTH = 200;

/**
 * 一覧のボードの付箋に出す、本文の冒頭の長さ（文字数）。
 * 付箋の大きさ（src/web/index-board.ts）に収まる量にしてある
 */
export const INDEX_EXCERPT_LENGTH = 60;

/** `GET /api/index` が返すページ */
export interface IndexPage {
  name: string;
  title: string | null;
  note_count: number;
  updated_at: number;
  /** 本文の冒頭（INDEX_EXCERPT_LENGTH 文字まで） */
  excerpt: string;
}

/** `GET /api/index` が返すリンク */
export interface IndexLink {
  from_page: string;
  to_page: string;
  /** リンク先のページがまだ作られていなければ 1 */
  missing: number;
}

/** 記録済みの操作 1 件の概要（一覧に出すもの） */
export interface OpSummary {
  seq: number;
  actor: string;
  summary: string | null;
  /** この操作が取り消しなら、取り消した対象の seq。取り消しでなければ null */
  reverts: number | null;
  /** この操作を取り消した操作の seq。取り消されていなければ null */
  revertedBy: number | null;
  createdAt: number;
}

/**
 * 取り消さなかった理由。
 * - modified: その後に変更されていた（一部のフィールドだけ変更されていた場合は、残りは取り消している）
 * - connected: 付箋の作成を取り消そうとしたが、取り消さない接続線がつながっている
 * - deleted: 更新を取り消そうとしたが、対象がもうない
 * - exists: 削除を取り消そうとしたが、同じ id のものがある
 * - endpoint-missing: 接続線の削除を取り消そうとしたが、両端の付箋がない
 */
export type SkipReason = 'modified' | 'connected' | 'deleted' | 'exists' | 'endpoint-missing';

/** 取り消さなかったものと、その理由 */
export interface Skipped {
  target: 'note' | 'edge';
  id: string;
  reason: SkipReason;
}

/** 取り消しの結果 */
export interface RevertOutcome {
  /** 取り消しとして記録した操作の seq。取り消せるものが 1 つもなかった場合は null */
  seq: number | null;
  /** 取り消したデルタの数 */
  applied: number;
  /** その後に変更されていたなどの理由で、取り消さなかったもの */
  skipped: Skipped[];
}
