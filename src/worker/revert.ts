// 記録済みの操作の取り消し。逆向きのデルタを作り、取り消してよいものだけを適用する。
import type { HistoryDelta } from '../shared/delta';
import { applyDeltas, exists, readEdge, readNote, readNoteFields } from './apply-ops';
import type { Obj } from './validate';

/** 取り消さなかったものと、その理由 */
export interface Skipped {
  target: 'note' | 'edge';
  id: string;
  /**
   * - modified: その後に変更されていた（一部のフィールドだけ変更されていた場合は、残りは取り消している）
   * - connected: 付箋の作成を取り消そうとしたが、取り消さない接続線がつながっている
   * - deleted: 更新を取り消そうとしたが、対象がもうない
   * - exists: 削除を取り消そうとしたが、同じ id のものがある
   * - endpoint-missing: 接続線の削除を取り消そうとしたが、両端の付箋がない
   */
  reason: 'modified' | 'connected' | 'deleted' | 'exists' | 'endpoint-missing';
}

/**
 * 更新の取り消しのうち、現在値が「取り消す操作が書いた値」のままのキーだけを残す。
 * `expected` は取り消す操作が書いた値、`restore` は戻す値。キーがないことは未設定を表す。
 */
function unchangedKeys(
  current: Obj,
  expected: Obj,
  restore: Obj,
  same: (key: string, a: unknown, b: unknown) => boolean,
): { before: Obj; after: Obj; conflicted: boolean } {
  const before: Obj = {};
  const after: Obj = {};
  let conflicted = false;
  for (const key of new Set([...Object.keys(expected), ...Object.keys(restore)])) {
    if (!same(key, current[key], expected[key])) {
      conflicted = true;
      continue;
    }
    if (key in expected) before[key] = expected[key];
    if (key in restore) after[key] = restore[key];
  }
  return { before, after, conflicted };
}

/** autoSize は「未設定」と false が同じ意味 */
const sameNoteValue = (key: string, a: unknown, b: unknown) =>
  key === 'autoSize' ? (a === true) === (b === true) : a === b;

const sameEdgeValue = (_key: string, a: unknown, b: unknown) => a === b;

/**
 * 逆向きのデルタ（`invertDeltas` の結果）を、取り消してよいものだけ順に適用する。
 * `transactionSync` の中で呼ぶこと。
 *
 * 取り消してよいかは、対象が「取り消す操作が残した状態」のままかで決める。
 *
 * - 更新: フィールドごとに判定し、その後に変更されたフィールドは戻さない
 * - 作成（付箋）: text が変わっていたら消さない。位置、大きさ、色だけの変更なら消す
 *   （agent が貼った付箋を動かしただけで取り消せなくなるのを避ける）。
 *   取り消さない接続線がつながっている付箋も消さない
 * - 作成（接続線）: label が変わっていたら消さない
 * - 削除: 同じ id のものがすでにあるか、接続線の両端がなければ戻さない
 *
 * 対象がすでにない作成の取り消しは、することがないので `skipped` にも入れない。
 */
export function applyRevert(
  sql: SqlStorage,
  inverse: HistoryDelta[],
  actor: string,
  now: number,
): { deltas: HistoryDelta[]; skipped: Skipped[] } {
  const deltas: HistoryDelta[] = [];
  const skipped: Skipped[] = [];
  // 1 つずつ適用する。後のデルタの判定が、先のデルタの結果（復活した付箋など）を見られるようにする
  const apply = (d: HistoryDelta) => {
    deltas.push(...applyDeltas(sql, [d], actor, now).deltas);
  };
  /** 更新の取り消しで、戻してよいフィールドだけの before / after を返す。戻さない分は skipped に入れる */
  const restorable = (
    target: Skipped['target'],
    id: string,
    current: Obj | undefined,
    d: { before: Obj; after: Obj },
    same: (key: string, a: unknown, b: unknown) => boolean,
  ) => {
    if (!current) {
      skipped.push({ target, id, reason: 'deleted' });
      return undefined;
    }
    const { before, after, conflicted } = unchangedKeys(current, d.before, d.after, same);
    if (conflicted) skipped.push({ target, id, reason: 'modified' });
    return { before, after };
  };

  for (const d of inverse) {
    switch (d.type) {
      case 'note:delete': {
        const cur = readNote(sql, d.note.id);
        if (!cur) break;
        // 付箋を消すと、つながっている接続線も消える。この時点で残っている接続線は、
        // この取り消しで戻さなかったもの（変更されていた）か、他の人が後からつないだものなので、
        // 付箋ごと残す
        const connected =
          sql.exec(`SELECT 1 FROM edges WHERE from_id = ? OR to_id = ? LIMIT 1`, cur.id, cur.id)
            .toArray().length > 0;
        if (cur.text !== d.note.text) skipped.push({ target: 'note', id: cur.id, reason: 'modified' });
        else if (connected) skipped.push({ target: 'note', id: cur.id, reason: 'connected' });
        else apply(d);
        break;
      }

      case 'note:create': {
        if (exists(sql, 'notes', d.note.id)) {
          skipped.push({ target: 'note', id: d.note.id, reason: 'exists' });
        } else {
          apply(d);
        }
        break;
      }

      case 'note:update': {
        // 関わるフィールドだけを読む（移動の取り消しで大きな text を読まない）
        const keys = [...Object.keys(d.before), ...Object.keys(d.after)];
        const cur = readNoteFields(sql, d.noteId, keys);
        const patch = restorable('note', d.noteId, cur, d, sameNoteValue);
        if (patch) apply({ type: 'note:update', noteId: d.noteId, ...patch });
        break;
      }

      case 'edge:delete': {
        const cur = readEdge(sql, d.edge.id);
        if (!cur) break;
        if (cur.label !== d.edge.label) skipped.push({ target: 'edge', id: cur.id, reason: 'modified' });
        else apply(d);
        break;
      }

      case 'edge:create': {
        const e = d.edge;
        if (exists(sql, 'edges', e.id)) {
          skipped.push({ target: 'edge', id: e.id, reason: 'exists' });
        } else if (!exists(sql, 'notes', e.from) || !exists(sql, 'notes', e.to)) {
          skipped.push({ target: 'edge', id: e.id, reason: 'endpoint-missing' });
        } else {
          apply(d);
        }
        break;
      }

      case 'edge:update': {
        const cur = readEdge(sql, d.edgeId);
        const patch = restorable('edge', d.edgeId, cur && { ...cur }, d, sameEdgeValue);
        if (patch) apply({ type: 'edge:update', edgeId: d.edgeId, ...patch });
        break;
      }
    }
  }

  return { deltas, skipped };
}
