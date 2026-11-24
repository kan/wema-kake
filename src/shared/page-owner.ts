// ページを作った人（issue #130）。ページを消せるのは、作った人と管理者だけ。
// サーバー（ページの DO、API）と画面（削除のボタンを出すか）の両方で使う
import { emailOfActor, isAgentActor } from './note-info';

/**
 * 書き込みの主体から、ページを作った人（'user:<email>'）を決める。agent なら委任者。
 * 人に結び付かない主体（system、委任者の分からない agent）なら null（管理者だけが消せる）
 */
export function ownerOf({ actor, delegate }: { actor: string; delegate?: string | null }): string | null {
  const person = isAgentActor(actor) ? delegate : actor;
  return person && emailOfActor(person) !== undefined ? person : null;
}

/** `actor` がページを消せるか。`owner` はページを作った人（記録が無ければ null） */
export function canDeletePage(owner: string | null, actor: string, admin: boolean): boolean {
  if (admin) return true;
  return owner !== null && owner.toLowerCase() === actor.toLowerCase();
}
