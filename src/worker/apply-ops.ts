import type { BoardData, HistoryDelta, WemaEdge, WemaNote } from '../shared/delta';
import { CHILD_PAGE_KEY, childPageOf, childRejection } from '../shared/hierarchy';
import { REASON_TEXT_CONFLICT } from '../shared/protocol';
import type { BoardState } from '../shared/tools';
import { sanitizeHtml } from './sanitize';
import { type NoteField, type Obj, RejectError, REQUIRED_EDGE_FIELDS } from './validate';

/** WemaNote のフィールド名 → notes の列名（更新できるもの） */
const NOTE_COLUMNS: Record<string, string> = {
  x: 'x',
  y: 'y',
  width: 'width',
  height: 'height',
  text: 'text',
  color: 'color',
  autoSize: 'auto_size',
  foldable: 'foldable',
  // meta は JSON の文字列で保存する。空なら NULL
  meta: 'extra',
  // wema が付箋にフィールドを足したら、ここで型エラーになる（知らないフィールドを黙って捨てないため）
} satisfies Record<NoteField, string>;

/**
 * 真偽値のフィールドを、すべて未設定（false）にした値。「未設定」と false が同じ意味で、
 * 列には 0 / 1 で保存する。読んだ付箋には true のものしか入らないので、付箋の内容に合わせる
 * デルタを作るときは、これを下に敷く
 */
export const UNSET_FLAGS = { autoSize: false, foldable: false } satisfies Partial<WemaNote>;
const FLAG_FIELDS = Object.keys(UNSET_FLAGS);

/** meta を、保存する形（JSON の文字列。空なら null）にする。キーは検証のときに並べ替えてある */
function metaJson(meta: unknown): string | null {
  return meta && Object.keys(meta).length > 0 ? JSON.stringify(meta) : null;
}

/**
 * 付箋のフィールドの値が同じか。autoSize と foldable は「未設定」と false が同じ意味。
 * meta は全体を比べる（キーがないことと、空は同じ）
 */
export function sameNoteValue(key: string, a: unknown, b: unknown): boolean {
  if (FLAG_FIELDS.includes(key)) return (a === true) === (b === true);
  if (key === 'meta') return metaJson(a) === metaJson(b);
  return a === b;
}

/** 保存した列の値を、付箋のフィールドの値にする */
function fromColumn(key: string, value: unknown): unknown {
  if (FLAG_FIELDS.includes(key)) return Boolean(value);
  if (key === 'meta') return value === null ? undefined : JSON.parse(value as string);
  return value;
}

/** 付箋のフィールドの値を、保存する列の値にする */
function toColumn(key: string, value: unknown): unknown {
  if (FLAG_FIELDS.includes(key)) return value === true ? 1 : 0;
  if (key === 'meta') return metaJson(value);
  return value;
}

function rowToNote(row: Obj): WemaNote {
  const note: WemaNote = {
    id: row.id as string,
    x: row.x as number,
    y: row.y as number,
    width: row.width as number,
    height: row.height as number,
    text: row.text as string,
    color: row.color as string,
    zIndex: row.z_index as number,
  };
  if (row.auto_size) note.autoSize = true;
  if (row.foldable) note.foldable = true;
  if (row.extra !== null) note.meta = JSON.parse(row.extra as string);
  return note;
}

/** このページに置いてある子ページ（子ページの付箋が指すページ） */
export function childPages(sql: SqlStorage): Set<string> {
  const rows = sql
    .exec(`SELECT json_extract(extra, '$.${CHILD_PAGE_KEY}') AS page FROM notes WHERE extra IS NOT NULL`)
    .toArray();
  return new Set(rows.map((row) => row.page).filter((page): page is string => typeof page === 'string'));
}

/** 子ページの付箋の、id、色、指している子ページ（本文は読まない） */
export function childNoteColors(sql: SqlStorage): { id: string; color: string; page: string }[] {
  return sql
    .exec<{ id: string; color: string; page: SqlStorageValue }>(
      `SELECT id, color, json_extract(extra, '$.${CHILD_PAGE_KEY}') AS page FROM notes WHERE extra IS NOT NULL`,
    )
    .toArray()
    .filter((row): row is { id: string; color: string; page: string } => typeof row.page === 'string');
}

/** `page` を指す子ページの付箋が、`exceptId` 以外にあるか */
function hasChildNote(sql: SqlStorage, page: string, exceptId: string): boolean {
  return (
    sql
      .exec(
        `SELECT 1 FROM notes WHERE json_extract(extra, '$.${CHILD_PAGE_KEY}') = ? AND id <> ? LIMIT 1`,
        page, exceptId,
      )
      .toArray().length > 0
  );
}

/** 同じ子ページを、1 つのページに 2 つ置くことはできない */
function assertNotPlaced(sql: SqlStorage, note: Pick<WemaNote, 'meta'>, noteId: string): void {
  const page = childPageOf(note);
  if (page !== undefined && hasChildNote(sql, page, noteId)) {
    throw new RejectError(childRejection('duplicate', page));
  }
}

function rowToEdge(row: Obj): WemaEdge {
  return {
    ...JSON.parse(row.props as string),
    id: row.id as string,
    from: row.from_id as string,
    to: row.to_id as string,
  };
}

function edgeProps(edge: Obj): string {
  const { id: _id, from: _from, to: _to, ...props } = edge;
  return JSON.stringify(props);
}

export function exists(sql: SqlStorage, table: 'notes' | 'edges', id: string): boolean {
  return sql.exec(`SELECT 1 FROM ${table} WHERE id = ?`, id).toArray().length > 0;
}

export function readNote(sql: SqlStorage, id: string): WemaNote | undefined {
  const row = sql.exec(`SELECT * FROM notes WHERE id = ?`, id).toArray()[0];
  return row && rowToNote(row);
}

/**
 * 付箋の、指定したフィールドだけを読む（`keys` のうち更新できるフィールド以外は無視する）。
 * 移動だけの更新で大きな text を読まないようにするためのもの。autoSize と foldable は真偽値で返す。
 */
export function readNoteFields(sql: SqlStorage, id: string, keys: string[]): Obj | undefined {
  const fields = keys.filter((k) => k in NOTE_COLUMNS);
  const columns = fields.length > 0 ? fields.map((k) => NOTE_COLUMNS[k]).join(', ') : '1';
  const row = sql.exec(`SELECT ${columns} FROM notes WHERE id = ?`, id).toArray()[0];
  if (!row) return undefined;
  const out: Obj = {};
  for (const k of fields) {
    // 未設定のフィールド（meta）は、キーごと入れない
    const value = fromColumn(k, row[NOTE_COLUMNS[k]]);
    if (value !== undefined) out[k] = value;
  }
  return out;
}

export function readEdge(sql: SqlStorage, id: string): WemaEdge | undefined {
  const row = sql.exec(`SELECT * FROM edges WHERE id = ?`, id).toArray()[0];
  return row && rowToEdge(row);
}

const noteRows = (sql: SqlStorage) => sql.exec(`SELECT * FROM notes ORDER BY rowid`).toArray();
/** 付箋だけを読む（接続線は読まない） */
export const readNotes = (sql: SqlStorage) => noteRows(sql).map(rowToNote);
const readEdges = (sql: SqlStorage) => sql.exec(`SELECT * FROM edges ORDER BY rowid`).toArray().map(rowToEdge);

/** 付箋（作成者つき）と接続線。agent に渡す */
export function readBoardWithAuthors(sql: SqlStorage): Pick<BoardState, 'notes' | 'edges'> {
  return {
    notes: noteRows(sql).map((row) => ({ ...rowToNote(row), createdBy: row.created_by as string | null })),
    edges: readEdges(sql),
  };
}

export function readBoard(sql: SqlStorage): BoardData {
  return { version: 1, notes: noteRows(sql).map(rowToNote), edges: readEdges(sql) };
}

export interface Sanitized {
  /** サニタイズで text が変わった付箋について、送信元の手元の状態を直すためのデルタ */
  fixups: HistoryDelta[];
  /** text を更新するデルタ → サニタイズした `before.text`（競合の判定に使う） */
  cleanBefore: Map<HistoryDelta, string>;
}

/**
 * デルタ中の text をサニタイズする（`note.text` と `after.text` を書き換える）。
 * `cleanBefore: false` なら `before.text` のサニタイズを省く（競合の判定に使わない場合）。
 */
export async function sanitizeDeltas(
  deltas: HistoryDelta[],
  options = { cleanBefore: true },
): Promise<Sanitized> {
  const fixups: HistoryDelta[] = [];
  const cleanBefore = new Map<HistoryDelta, string>();
  const fix = (noteId: string, sent: string, clean: string) => {
    // 送信元は after を適用するだけなので、送られてきた text は記録に残さない
    if (sent !== clean) {
      fixups.push({ type: 'note:update', noteId, before: {}, after: { text: clean } });
    }
  };
  for (const d of deltas) {
    if (d.type === 'note:create') {
      const sent = d.note.text;
      d.note.text = await sanitizeHtml(sent);
      fix(d.note.id, sent, d.note.text);
    } else if (d.type === 'note:update' && d.after.text !== undefined) {
      const sent = d.after.text;
      d.after.text = await sanitizeHtml(sent);
      fix(d.noteId, sent, d.after.text);
      const before = d.before.text;
      if (options.cleanBefore && before !== undefined) {
        cleanBefore.set(d, before === sent ? d.after.text : await sanitizeHtml(before));
      }
    }
  }
  return { fixups, cleanBefore };
}

export interface Applied {
  /** 実際に適用したデルタ。before と削除対象はサーバーの保存値で置き換えてある */
  deltas: HistoryDelta[];
  /** 送信元が送っていないのにサーバーが足したデルタ（付箋の削除に伴う接続線の削除） */
  fixups: HistoryDelta[];
}

/**
 * デルタを順に適用する。`transactionSync` の中で呼ぶこと（RejectError で全体を巻き戻す）。
 *
 * - 作成: id が使用済み、または接続線の両端がなければ拒否する
 * - 更新と削除: 対象がすでになければ、そのデルタを捨てる（他の人が先に消した場合）
 * - text の更新: `before.text` が現在値と違えば拒否する。`before.text` はそのままの値か、
 *   サニタイズした値（`cleanBefore`）のどちらかが一致すればよい。前者は、サニタイズの規則を
 *   変える前に保存した text を編集できるようにするため。後者は、送信元がサニタイズ前の
 *   text を手元に持ったまま続けて編集した場合のため
 * - 更新で `after` にキーがなく `before` にあるものは、未設定に戻す
 */
export function applyDeltas(
  sql: SqlStorage,
  deltas: HistoryDelta[],
  actor: string,
  now: number,
  cleanBefore?: Map<HistoryDelta, string>,
): Applied {
  const applied: HistoryDelta[] = [];
  const fixups: HistoryDelta[] = [];

  for (const d of deltas) {
    switch (d.type) {
      case 'note:create': {
        const n = d.note;
        if (exists(sql, 'notes', n.id)) throw new RejectError(`note already exists: ${n.id}`);
        assertNotPlaced(sql, n, n.id);
        sql.exec(
          `INSERT INTO notes (id, x, y, width, height, text, color, z_index, auto_size, foldable, extra,
                              created_by, updated_at, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          n.id, n.x, n.y, n.width, n.height, n.text, n.color, n.zIndex, n.autoSize ? 1 : 0,
          n.foldable ? 1 : 0, metaJson(n.meta), actor, now, actor,
        );
        applied.push(d);
        break;
      }

      case 'note:update': {
        const next: Obj = { ...d.after };
        // autoSize と foldable は「未設定」と false が同じ意味
        for (const flag of FLAG_FIELDS) {
          if (flag in d.before || flag in next) next[flag] = next[flag] === true;
        }
        // meta は全体を置き換える。after になく before にあれば、取り除く（空の meta にする）
        if (!('meta' in next) && 'meta' in d.before) next.meta = {};
        const keys = Object.keys(NOTE_COLUMNS).filter((k) => next[k] !== undefined);
        if (keys.length === 0) break;
        const cur = readNoteFields(sql, d.noteId, keys);
        if (!cur) break;
        if (
          next.text !== undefined &&
          d.before.text !== cur.text &&
          cleanBefore?.get(d) !== cur.text
        ) {
          throw new RejectError(REASON_TEXT_CONFLICT, { notes: [readNote(sql, d.noteId)!], edges: [] });
        }
        const changed = keys.filter((k) => !sameNoteValue(k, next[k], cur[k]));
        if (changed.length === 0) break;
        if (changed.includes('meta')) assertNotPlaced(sql, next as Pick<WemaNote, 'meta'>, d.noteId);
        sql.exec(
          `UPDATE notes SET ${changed.map((k) => `${NOTE_COLUMNS[k]} = ?`).join(', ')},
                            updated_at = ?, updated_by = ?
           WHERE id = ?`,
          ...changed.map((k) => toColumn(k, next[k])),
          now, actor, d.noteId,
        );
        // 未設定の値（取り除いた meta、もともとなかった meta）は、キーごと入れない
        const fieldsOf = (values: Obj) =>
          Object.fromEntries(changed.filter((k) => toColumn(k, values[k]) !== null).map((k) => [k, values[k]]));
        applied.push({ type: 'note:update', noteId: d.noteId, before: fieldsOf(cur), after: fieldsOf(next) });
        break;
      }

      case 'note:delete': {
        const cur = readNote(sql, d.note.id);
        if (!cur) break;
        // wema は接続線の削除を先に送ってくる。残っているのは他の人が同時に足したものか、
        // 接続線を指定しない呼び出し（MCP）なので、ここで削除のデルタを作って記録に残す
        const rest = sql
          .exec(`SELECT * FROM edges WHERE from_id = ? OR to_id = ? ORDER BY rowid`, cur.id, cur.id)
          .toArray()
          .map(rowToEdge);
        for (const edge of rest) {
          const del: HistoryDelta = { type: 'edge:delete', edge };
          applied.push(del);
          fixups.push(del);
        }
        if (rest.length > 0) {
          sql.exec(`DELETE FROM edges WHERE from_id = ? OR to_id = ?`, cur.id, cur.id);
        }
        sql.exec(`DELETE FROM notes WHERE id = ?`, cur.id);
        applied.push({ type: 'note:delete', note: cur });
        break;
      }

      case 'edge:create': {
        const e = d.edge;
        if (exists(sql, 'edges', e.id)) throw new RejectError(`edge already exists: ${e.id}`);
        if (!exists(sql, 'notes', e.from) || !exists(sql, 'notes', e.to)) {
          throw new RejectError(`edge endpoint not found: ${e.id}`);
        }
        sql.exec(
          `INSERT INTO edges (id, from_id, to_id, props, created_by, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          e.id, e.from, e.to, edgeProps({ ...e }), actor, now,
        );
        applied.push(d);
        break;
      }

      case 'edge:update': {
        const cur = readEdge(sql, d.edgeId);
        if (!cur) break;
        const next: Obj = { ...cur };
        const patch: Obj = d.after;
        const before: Obj = {};
        const after: Obj = {};
        for (const key of new Set([...Object.keys(d.before), ...Object.keys(patch)])) {
          const value = patch[key];
          if (value === undefined && REQUIRED_EDGE_FIELDS.includes(key)) continue;
          const prev = next[key];
          if (value === prev) continue;
          if (prev !== undefined) before[key] = prev;
          if (value === undefined) {
            delete next[key];
          } else {
            after[key] = value;
            next[key] = value;
          }
        }
        if (Object.keys(before).length === 0 && Object.keys(after).length === 0) break;
        sql.exec(
          `UPDATE edges SET props = ?, updated_at = ? WHERE id = ?`,
          edgeProps(next), now, d.edgeId,
        );
        applied.push({ type: 'edge:update', edgeId: d.edgeId, before, after });
        break;
      }

      case 'edge:delete': {
        const cur = readEdge(sql, d.edge.id);
        if (!cur) break;
        sql.exec(`DELETE FROM edges WHERE id = ?`, cur.id);
        applied.push({ type: 'edge:delete', edge: cur });
        break;
      }
    }
  }

  return { deltas: applied, fixups };
}
