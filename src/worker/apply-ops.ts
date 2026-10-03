import type { BoardData, HistoryDelta, WemaEdge, WemaNote } from '../shared/delta';
import { REASON_TEXT_CONFLICT } from '../shared/protocol';
import type { BoardState } from '../shared/tools';
import { sanitizeHtml } from './sanitize';
import { type Obj, RejectError, REQUIRED_EDGE_FIELDS } from './validate';

/** WemaNote のフィールド名 → notes の列名（更新できるもの） */
const NOTE_COLUMNS: Record<string, string> = {
  x: 'x',
  y: 'y',
  width: 'width',
  height: 'height',
  text: 'text',
  color: 'color',
  autoSize: 'auto_size',
};

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
  return note;
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
 * 移動だけの更新で大きな text を読まないようにするためのもの。autoSize は真偽値で返す。
 */
export function readNoteFields(sql: SqlStorage, id: string, keys: string[]): Obj | undefined {
  const fields = keys.filter((k) => k in NOTE_COLUMNS);
  const columns = fields.length > 0 ? fields.map((k) => NOTE_COLUMNS[k]).join(', ') : '1';
  const row = sql.exec(`SELECT ${columns} FROM notes WHERE id = ?`, id).toArray()[0];
  if (!row) return undefined;
  const out: Obj = {};
  for (const k of fields) {
    out[k] = k === 'autoSize' ? Boolean(row[NOTE_COLUMNS[k]]) : row[NOTE_COLUMNS[k]];
  }
  return out;
}

export function readEdge(sql: SqlStorage, id: string): WemaEdge | undefined {
  const row = sql.exec(`SELECT * FROM edges WHERE id = ?`, id).toArray()[0];
  return row && rowToEdge(row);
}

const noteRows = (sql: SqlStorage) => sql.exec(`SELECT * FROM notes ORDER BY rowid`).toArray();
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
        sql.exec(
          `INSERT INTO notes (id, x, y, width, height, text, color, z_index, auto_size,
                              created_by, updated_at, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          n.id, n.x, n.y, n.width, n.height, n.text, n.color, n.zIndex, n.autoSize ? 1 : 0,
          actor, now, actor,
        );
        applied.push(d);
        break;
      }

      case 'note:update': {
        const next: Obj = { ...d.after };
        // autoSize は「未設定」と false が同じ意味
        if ('autoSize' in d.before || 'autoSize' in next) next.autoSize = next.autoSize === true;
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
        const changed = keys.filter((k) => next[k] !== cur[k]);
        if (changed.length === 0) break;
        sql.exec(
          `UPDATE notes SET ${changed.map((k) => `${NOTE_COLUMNS[k]} = ?`).join(', ')},
                            updated_at = ?, updated_by = ?
           WHERE id = ?`,
          ...changed.map((k) => (k === 'autoSize' ? Number(next[k]) : next[k])),
          now, actor, d.noteId,
        );
        applied.push({
          type: 'note:update',
          noteId: d.noteId,
          before: Object.fromEntries(changed.map((k) => [k, cur[k]])),
          after: Object.fromEntries(changed.map((k) => [k, next[k]])),
        });
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
