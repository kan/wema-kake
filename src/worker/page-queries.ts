// D1 の索引に対する、ページの一覧と検索のクエリ。HTTP の API と MCP のツールの両方が使う。
import { MAX_LIST_LIMIT, MAX_QUERY_LENGTH, type RootHit } from '../shared/api';
import { MAX_DEPTH } from '../shared/hierarchy';
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
      `SELECT name, title, note_count, updated_at, parent FROM pages
       WHERE updated_at > ? ORDER BY updated_at DESC LIMIT ?`,
    )
    .bind(Number(options.updatedAfter) || 0, clampLimit(options.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT))
    .all<PageInfo>();
  return results;
}

export interface SearchHit {
  name: string;
  title: string | null;
  updated_at: number;
  /** 親ページのスラッグ。ルートのページなら null */
  parent: string | null;
  snippet?: string;
}

/** 検索語を整える。空か長すぎるときは null */
function normalizeQuery(query: string): string | null {
  const q = query.trim();
  return q === '' || q.length > MAX_QUERY_LENGTH ? null : q;
}

/** 3 文字未満の検索語は trigram に一致しないので、LIKE で探す */
const usesFts = (q: string) => [...q].length >= MIN_FTS_QUERY_LENGTH;
/** 検索語全体を 1 つの語句として扱う（FTS5 の演算子として解釈させない） */
const ftsPhrase = (q: string) => `"${q.replaceAll('"', '""')}"`;
const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, '\\$&')}%`;

/** 全文検索（表示名と本文）。検索語が空か長すぎるときは null を返す */
export async function searchPages(db: D1Database, query: string): Promise<SearchHit[] | null> {
  const q = normalizeQuery(query);
  if (q === null) return null;

  if (usesFts(q)) {
    const { results } = await db
      .prepare(
        `SELECT p.name, p.title, p.updated_at, p.parent, snippet(pages_fts, 1, '', '', '…', 24) AS snippet
         FROM pages_fts JOIN pages p ON p.id = pages_fts.rowid
         WHERE pages_fts MATCH ? ORDER BY rank LIMIT ?`,
      )
      .bind(ftsPhrase(q), SEARCH_LIMIT)
      .all<SearchHit>();
    return results;
  }

  const { results } = await db
    .prepare(
      `SELECT name, title, updated_at, parent FROM pages
       WHERE title LIKE ?1 ESCAPE '\\' OR plain_text LIKE ?1 ESCAPE '\\'
       ORDER BY updated_at DESC LIMIT ?2`,
    )
    .bind(likePattern(q), SEARCH_LIMIT)
    .all<SearchHit>();
  return results;
}

/**
 * 一覧の絞り込み用の検索。一致したページ（表示名、本文、スラッグ）と、そのルートを返す。
 * 一覧にはルートのページしか出ないので、子孫のページが一致したときは、ルートを残して知らせる。
 * 入力のたびに呼ばれるので、抜粋の生成と関連度での並び替えはしない。
 */
export async function searchRoots(db: D1Database, query: string): Promise<RootHit[] | null> {
  const q = normalizeQuery(query);
  if (q === null) return null;

  const pattern = likePattern(q);
  const matched = usesFts(q)
    ? `SELECT p.name FROM pages_fts JOIN pages p ON p.id = pages_fts.rowid WHERE pages_fts MATCH ?1
       UNION SELECT name FROM pages WHERE name LIKE ?2 ESCAPE '\\'`
    : `SELECT name FROM pages
       WHERE title LIKE ?2 ESCAPE '\\' OR plain_text LIKE ?2 ESCAPE '\\' OR name LIKE ?2 ESCAPE '\\'`;
  const { results } = await db
    .prepare(
      `WITH RECURSIVE matched(name) AS (${matched} LIMIT ?3),
         up(name, cur, parent, depth) AS (
           SELECT m.name, p.name, p.parent, 1 FROM matched m JOIN pages p ON p.name = m.name
           UNION ALL
           SELECT up.name, p.name, p.parent, up.depth + 1
           FROM up JOIN pages p ON p.name = up.parent WHERE up.depth <= ?4
         )
       SELECT name, cur AS root FROM up WHERE parent IS NULL`,
    )
    // LIKE だけの検索では ?1 を使わないが、番号をそろえるために渡す
    .bind(usesFts(q) ? ftsPhrase(q) : '', pattern, SEARCH_LIMIT, MAX_DEPTH)
    .all<RootHit>();
  return results;
}
