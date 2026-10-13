// 付箋ごとの付加情報。サーバーが認証結果と時刻から決める値で、付箋のデータ（WemaNote、meta）には
// 入れない（クライアントが書き換えられる値になるため）。画面は、表示にだけ使う。
//
// 項目を足すとき（付箋への反応など）も、付箋の id ごとのこの形に足し、スナップショットの `info` で
// 届ける。操作の履歴に積まない項目は seq を進めないので、変更は `ops` ではなく、別のメッセージで届ける
// （`meta` と同じく、再接続のときに現在値を送り直す）。
import type { HistoryDelta } from './delta';

export interface NoteInfo {
  /** 作成者（'user:<email>' / 'agent:<client>'）。分からなければ null */
  createdBy: string | null;
  /** 最後に変更した時刻（UNIX ミリ秒）。移動や大きさの変更でも変わる */
  updatedAt: number;
}

/** 付箋の id ごとの付加情報（スナップショットに載せる形） */
export type NoteInfos = Record<string, NoteInfo>;

/** 作成者が agent（MCP のクライアント）か */
export const isAgentActor = (actor: string | null): boolean => actor?.startsWith('agent:') ?? false;

/**
 * 確定した操作を、付加情報に反映する。サーバーが付箋の行に書く値（`created_by`、`updated_at`）と
 * 同じ結果になる。変わった付箋の id を返す。
 *
 * @param actor 操作の主体
 * @param at 操作を記録した時刻
 * @param deltas サーバーが実際に適用したデルタ
 */
export function applyOpToInfos(
  infos: Map<string, NoteInfo>,
  actor: string,
  at: number,
  deltas: HistoryDelta[],
): Set<string> {
  const changed = new Set<string>();
  for (const d of deltas) {
    if (d.type === 'note:create') {
      infos.set(d.note.id, { createdBy: actor, updatedAt: at });
      changed.add(d.note.id);
    } else if (d.type === 'note:delete') {
      if (infos.delete(d.note.id)) changed.add(d.note.id);
    } else if (d.type === 'note:update') {
      // 手元にない付箋の更新は、作成者が分からないまま、時刻だけを持つ
      infos.set(d.noteId, { createdBy: infos.get(d.noteId)?.createdBy ?? null, updatedAt: at });
      changed.add(d.noteId);
    }
  }
  return changed;
}
