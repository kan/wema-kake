// ゴミ箱の付箋を、元のページへ戻す（POST /api/trash/restore）。
//
// ゴミ箱の DO が記録した、元のページ、元の id、元の位置（trash_origins）を読み、元のページごとに、
// 他のページへの移動と同じ transferNotes で戻す。作成者は引き継ぐ。
import type { RestoreOutcome } from '../shared/api';
import type { WemaKakeEnv } from './config';
import { TRASH_SLUG } from '../shared/trash';
import { transferNotes } from './transfer';
import { parseId, parseNoteIds, RejectError } from './validate';

export interface RestoreInput {
  /** 変更の主体。呼び出し側が認証結果から決める */
  actor: string;
  clientId: string;
  /** 同じ値で送り直しても、二重には戻さない */
  opId: string;
  /** ゴミ箱での付箋の id。外から来た値 */
  noteIds: unknown;
}

export type RestoreResult =
  | { ok: true; pages: RestoreOutcome[] }
  | { ok: false; code: 'invalid' | 'not-found'; reason: string };

export async function restoreNotes(env: WemaKakeEnv, input: RestoreInput): Promise<RestoreResult> {
  let noteIds: string[];
  try {
    parseId(input.clientId, 'clientId');
    parseId(input.opId, 'opId');
    noteIds = parseNoteIds(input.noteIds);
  } catch (e) {
    if (e instanceof RejectError) return { ok: false, code: 'invalid', reason: e.message };
    throw e;
  }

  const origins = await env.PAGE.getByName(TRASH_SLUG).trashOrigins(noteIds);
  const found = new Set(origins.map((origin) => origin.noteId));
  const missing = noteIds.filter((id) => !found.has(id));
  // 記録のない付箋（ゴミ箱で作った付箋など）が混ざっていても、残りは戻す。どれも記録がなければ 404
  const reason = `no record of the original page: ${missing.join(', ')}`;
  if (origins.length === 0) return { ok: false, code: 'not-found', reason };
  const unknown: RestoreOutcome[] = missing.length > 0 ? [{ page: null, noteIds: [], error: reason }] : [];

  const byPage = new Map<string, typeof origins>();
  for (const origin of origins) {
    const group = byPage.get(origin.page);
    if (group) group.push(origin);
    else byPage.set(origin.page, [origin]);
  }

  // 元のページどうしは独立しているので、並べて戻す（ゴミ箱から消す操作は、ゴミ箱の DO が順に処理する）
  const groups = [...byPage].sort(([a], [b]) => a.localeCompare(b));
  const restored = await Promise.all(groups.map(([page, group]) => restoreGroup(env, input, page, group)));
  return { ok: true, pages: [...restored, ...unknown] };
}

async function restoreGroup(
  env: WemaKakeEnv,
  input: RestoreInput,
  page: string,
  group: { noteId: string; originalId: string; x: number; y: number }[],
): Promise<RestoreOutcome> {
  const result = await transferNotes(env, {
    actor: input.actor,
    clientId: input.clientId,
    // ページごとに別の操作として記録する。ゴミ箱から消す操作も同じ値で記録するので、ページごとに変える
    opId: await pageOpId(input.opId, page),
    from: TRASH_SLUG,
    to: page,
    noteIds: group.map((origin) => origin.noteId),
    copy: false,
    placeAs: new Map(group.map((origin) => [origin.noteId, { id: origin.originalId, x: origin.x, y: origin.y }])),
  });
  return result.ok ? { page, noteIds: result.noteIds } : { page, noteIds: [], error: result.reason };
}

/** 元のページごとの opId。同じ `opId` と `page` からは、同じ値になる（送り直しで、二重に戻さない） */
async function pageOpId(opId: string, page: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${opId}\n${page}`));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
