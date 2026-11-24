// ログインしている人（`GET /api/session`）。画面ごとに 1 回だけ問い合わせ、その画面の部品で分け合う
// （ヘッダーの利用者のリンク、ページの画面のロックの項目といいね）。画面が替わったら問い合わせ直す
// （管理者のヘッダーに出す承認待ちの人数を、新しくするため）。
import type { Session } from '../shared/api';
import { getSession } from './api';
import { viewSignal } from './navigation';

let current: { signal: AbortSignal; session: Promise<Session> } | undefined;

/** 今の画面の session。失敗したら、その画面の間は失敗のまま（部品は、出さないでおく） */
export function viewSession(): Promise<Session> {
  const signal = viewSignal();
  if (current?.signal !== signal) current = { signal, session: getSession() };
  return current.session;
}
