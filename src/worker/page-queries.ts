// D1 の索引に対する、ページの一覧と検索のクエリ。HTTP の API と MCP のツールの両方が使う。
import { MAX_LIST_LIMIT, MAX_QUERY_LENGTH } from '../shared/api';
import type { PageInfo } from '../shared/tools';
import { clampLimit } from './validate';

const DEFAULT_LIST_LIMIT = 100;
/** 一覧の絞り込みに使うので、一覧の上限とそろえる */
const SEARCH_LIMIT = MAX_LIST_LIMIT;
/** trigram の FTS が一致を返せる最短の検索語（文字数） */
const MIN_FTS_QUERY_LENGTH = 3;

/** ページ一覧（更新の新しい順）。`updatedAfter`（ミリ秒）より後に更新されたものに絞れる */
export async function listPages(
  db: D1Database,
  options: { updatedAfter?: unknown; limit?: unknown },
): Promise<PageInfo[]> {
  const { results } = await db
    .prepare(
      `SELECT name, title, note_count, updated_at FROM pages
       WHERE updated_at > ? ORDER BY updated_at DESC LIMIT ?`,
    )
    .bind(Number(options.updatedAfter) || 0, clampLimit(options.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT))
    .all<PageInfo>();
  return results;
}

export interface SearchHit {
  name: string;
  title?: string | null;
  updated_at?: number;
  snippet?: string;
}

/**
 * 全文検索（表示名と本文）。3 文字未満の検索語は trigram に一致しないので LIKE で探す。
 * 検索語が空か長すぎるときは null を返す。
 *
 * `namesOnly` なら、一致したページのスラッグだけを返す（一覧の絞り込み用。入力のたびに呼ばれる
 * ので、抜粋の生成と関連度での並び替えを省く）。
 */
export async function searchPages(
  db: D1Database,
  query: string,
  namesOnly = false,
): Promise<SearchHit[] | null> {
  const q = query.trim();
  if (q === '' || q.length > MAX_QUERY_LENGTH) return null;

  if ([...q].length >= MIN_FTS_QUERY_LENGTH) {
    // 検索語全体を 1 つの語句として扱う（FTS5 の演算子として解釈させない）
    const phrase = `"${q.replaceAll('"', '""')}"`;
    const { results } = await db
      .prepare(
        namesOnly
          ? `SELECT p.name FROM pages_fts JOIN pages p ON p.id = pages_fts.rowid
             WHERE pages_fts MATCH ? LIMIT ?`
          : `SELECT p.name, p.title, p.updated_at, snippet(pages_fts, 1, '', '', '…', 24) AS snippet
             FROM pages_fts JOIN pages p ON p.id = pages_fts.rowid
             WHERE pages_fts MATCH ? ORDER BY rank LIMIT ?`,
      )
      .bind(phrase, SEARCH_LIMIT)
      .all<SearchHit>();
    return results;
  }

  const pattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
  const { results } = await db
    .prepare(
      `SELECT ${namesOnly ? 'name' : 'name, title, updated_at'} FROM pages
       WHERE title LIKE ?1 ESCAPE '\\' OR plain_text LIKE ?1 ESCAPE '\\'
       ORDER BY updated_at DESC LIMIT ?2`,
    )
    .bind(pattern, SEARCH_LIMIT)
    .all<SearchHit>();
  return results;
}
