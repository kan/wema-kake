// 付箋を、他のページへ移す（写す）。画面（POST /api/pages/:slug/transfer）と MCP（move_notes）が使う。
//
// 送り先の DO が、元のページの DO から付箋を読んで置き（takeNotes）、置けたら、元のページから
// 消す（removeNotes）。付箋の中身と作成者はサーバーが読むので、移した付箋の作成者を、偽れない形で
// 引き継げる。2 つのページへの書き込みは、ページごとに 1 つずつ操作として記録する。
import type { WemaKakeEnv } from './config';
import { isValidSlug } from '../shared/slug';
import { parseId, parseNoteIds, parsePositions, RejectError } from './validate';

/**
 * 元のページから付箋を消す操作の clientId。送った画面の clientId を使うと、その画面は、自分の操作の
 * 確定と見なして（覚えのない opId なので無視して）、消したことを手元に反映しない
 */
const REMOVE_CLIENT_ID = 'transfer';

export interface TransferInput {
  /** 変更の主体。呼び出し側が認証結果から決める */
  actor: string;
  clientId: string;
  /** 同じ値で送り直しても、二重には置かない（消す操作も同じ値で記録する） */
  opId: string;
  from: string;
  to: string;
  /** 外から来た値をそのまま渡す。検証はここで行う */
  noteIds: unknown;
  /** 付箋の id から、元のページでの位置の代わりに使う `{ x, y }`。外から来た値 */
  positions?: unknown;
  /** 写す（元のページに残す。作成者は `actor`）。偽なら移す（作成者を引き継ぐ） */
  copy: boolean;
  /** 操作の履歴に出す説明。省略すると、相手のページを表す符号 */
  summary?: string;
}

/**
 * - `not-found`: 送り先か元のページ、または付箋がない
 * - `invalid`: 入力が不正か、置けなかった
 * - `partial`: 送り先には置けたが、元のページから消せなかった付箋がある（消せなかった、または
 *   読んだ後に元のページで変わったか消えたので、消さなかった）
 */
export type TransferFailure = 'not-found' | 'invalid' | 'partial';

export type TransferResult =
  | {
      ok: true;
      /** 送り先に置いた付箋の id（`noteIds` と同じ順） */
      noteIds: string[];
      /** 送り先で記録した操作の番号 */
      received: number;
      /** 元のページで記録した操作の番号。写したとき、消す付箋がもうなかったときは null */
      removed: number | null;
    }
  | { ok: false; code: TransferFailure; reason: string };

export async function transferNotes(env: WemaKakeEnv, input: TransferInput): Promise<TransferResult> {
  const { actor, clientId, opId, from, to, copy, summary } = input;
  let noteIds: string[];
  let positions: Map<string, { x: number; y: number }>;
  try {
    if (!isValidSlug(from) || !isValidSlug(to)) throw new RejectError('invalid page');
    // 消す操作は別の clientId で記録するので、ここで確かめておく（送り先は、置く前に確かめる）
    parseId(opId, 'opId');
    noteIds = parseNoteIds(input.noteIds);
    positions = parsePositions(input.positions);
  } catch (e) {
    if (e instanceof RejectError) return { ok: false, code: 'invalid', reason: e.message };
    throw e;
  }

  const taken = await env.PAGE.getByName(to).takeNotes({
    actor, clientId, opId, from, noteIds, positions, keepAuthors: !copy, summary,
  });
  if (!taken.ok) return { ok: false, code: taken.notFound ? 'not-found' : 'invalid', reason: taken.reason };
  if (copy) return { ok: true, noteIds: taken.noteIds, received: taken.seq, removed: null };

  const removed = await env.PAGE.getByName(from)
    .removeNotes({ actor, clientId: REMOVE_CLIENT_ID, opId, noteIds, versions: taken.versions, to, summary })
    .catch((e: unknown) => ({ ok: false as const, reason: e instanceof Error ? e.message : String(e) }));
  if (!removed.ok) {
    return {
      ok: false,
      code: 'partial',
      reason: `placed the notes in ${to} (operation ${taken.seq}), but could not remove them from ${from}: ${removed.reason}`,
    };
  }
  if (removed.kept.length > 0) {
    return {
      ok: false,
      code: 'partial',
      reason:
        `placed the notes in ${to} (operation ${taken.seq}), but left ${removed.kept.join(', ')} in ${from}` +
        ` because they were changed or removed there while moving (the copies in ${to} are from before the change)`,
    };
  }
  return { ok: true, noteIds: taken.noteIds, received: taken.seq, removed: removed.seq };
}
