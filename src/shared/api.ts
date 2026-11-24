// サーバーとブラウザの両方が使う、HTTP API と DO のメソッドの型と定数。

/** ページの一覧で 1 回に返す件数の上限 */
export const MAX_LIST_LIMIT = 500;

/** ページを変更してから、D1 の索引へ反映するまでの時間 */
export const INDEX_DELAY_MS = 5000;

/** 表示名の長さの上限 */
export const MAX_TITLE_LENGTH = 200;

/**
 * ページに付けられる色。wema の付箋の色と同じ並び（子ページの付箋と、一覧の付箋の色になる）。
 * 付けていないページは null
 */
export const PAGE_COLORS = ['#FFF9C4', '#FFCDD2', '#FFE0B2', '#E1BEE7', '#BBDEFB', '#B2DFDB', '#C8E6C9', '#F5F5F5'] as const;
export type PageColor = (typeof PAGE_COLORS)[number];
/** 色を付けていないページの、付箋（子ページの付箋、一覧の付箋）の色 */
export const UNSET_PAGE_COLOR: PageColor = '#FFF9C4';

/** 検索語の長さの上限 */
export const MAX_QUERY_LENGTH = 200;

/** 1 人が付けられるブックマークの数 */
export const MAX_BOOKMARKS = 100;

/**
 * 一覧のボードの付箋に出す、本文の冒頭の長さ（文字数）。
 * 付箋の大きさ（src/web/index-board.ts）に収まる量にしてある
 */
export const INDEX_EXCERPT_LENGTH = 60;

/** `GET /api/index` が返すページ */
export interface IndexPage {
  name: string;
  title: string | null;
  /** ページの色（PAGE_COLORS のどれか）。付けていなければ null */
  color: string | null;
  note_count: number;
  updated_at: number;
  /** 本文の冒頭（INDEX_EXCERPT_LENGTH 文字まで） */
  excerpt: string;
  /** 直接の子ページの数 */
  child_count: number;
  /**
   * ページを作った人（'user:<email>'。issue #130）。記録が無ければ空文字（管理者だけが消せる）。
   * まだ索引に反映していなければ null（消せるかどうかはサーバーが決める）
   */
  created_by: string | null;
}

/** `POST /api/pages-info` が返す、ページの概要（子ページの付箋の表示に使う） */
export interface PageSummary {
  name: string;
  title: string | null;
  /** ページの色（PAGE_COLORS のどれか）。付けていなければ null */
  color: string | null;
  note_count: number;
  /** 親ページのスラッグ。ルートのページなら null */
  parent: string | null;
  /** 付箋の配置（`[[x, y, 幅, 高さ, 色], ...]` の JSON）。索引がまだなら null */
  layout: string | null;
}

/** `GET /api/search?roots=1` が返す、一致したページと、そのルート */
export interface RootHit {
  /** 一致したページ */
  name: string;
  /** そのページのルート。ルートのページ自身が一致したなら、`name` と同じ */
  root: string;
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
  /** agent の操作なら、その委任者（'user:<email>'）。分からなければ null */
  delegate: string | null;
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

/** ゴミ箱の付箋を元のページへ戻した結果（`POST /api/trash/restore`）。元のページごとに 1 つ */
export interface RestoreOutcome {
  /** 元のページ。元のページの記録がない付箋をまとめた結果では null */
  page: string | null;
  /** 元のページに置いた付箋の id。戻せなかったら空 */
  noteIds: string[];
  /** 戻せなかった理由 */
  error?: string;
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

/** 利用者の承認の状態（設定の `approval` が有効なとき）。管理者は、いつも approved */
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

/** 承認待ちと拒否の人が `/api` と `/ws` と `/img` を呼んだときの 403 の `error` */
export const ERROR_NOT_APPROVED = 'not approved';

/** 利用者の画面に出す 1 人分（`GET /api/users`） */
export interface UserEntry {
  email: string;
  status: ApprovalStatus;
  /** 設定の `admins` の人。表には入らず、いつも承認済み（承認も拒否もできない） */
  admin?: true;
  /** 初めて来た時刻（UNIX ミリ秒）。管理者は null（表に入らないので、記録がない） */
  created_at: number | null;
  /** 最後に承認か拒否をした管理者の主体（'user:<email>'）。まだなら null */
  decided_by: string | null;
  decided_at: number | null;
}

/** `GET /api/session` の応答 */
export interface Session {
  actor: string;
  admin: boolean;
  /** 承認の状態。設定の `approval` が無効なら省く */
  approval?: ApprovalStatus;
  /** 承認待ちの人数。承認が有効で、管理者のときだけ */
  pendingUsers?: number;
}

/** 表示名の長さの上限（文字数。サロゲートペアは 1 文字と数える）。ほかの人と同じ名前も許す */
export const MAX_DISPLAY_NAME_LENGTH = 32;

/** アイコンの画像の一辺（px）。ブラウザで正方形に切り抜いて、この大きさに縮めてから上げる */
export const ICON_SIZE = 128;

/** アイコンの画像の大きさの上限（バイト） */
export const MAX_ICON_BYTES = 64 * 1024;

/**
 * アイコンの画像の形式。ブラウザは先頭から試す。WebP を書き出せないブラウザ（Safari。iOS はどのブラウザも
 * 同じ）のために、JPEG も受け付ける
 */
export const ICON_CONTENT_TYPES = ['image/webp', 'image/jpeg'] as const;

/** `POST /api/profiles` で 1 回に引ける主体の数の上限 */
export const MAX_PROFILE_LOOKUP = 500;

/** 利用者の表示名とアイコン（issue #121）。どちらも未設定なら null */
export interface Profile {
  name: string | null;
  /** アイコンの画像の URL（/img/<key>） */
  icon: string | null;
}
