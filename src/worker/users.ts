// 利用者の承認（設定の `approval`。issue #120）。利用者の表は D1 の `users`（migrations/0007_users.sql）。
//
// 判定は Worker の入口で行う（`/api`、`/ws`、`/img` は、承認済みでなければ 403。画面の HTML には
// 状態を埋め込み、画面が承認待ちの表示に切り替える）。開いたままの WebSocket は、ページの DO が、
// 接続の最初と書き込みのたびに `isApproved` で確かめ直す（承認を取り消された人の接続を切るため）。
import type { ApprovalStatus, UserEntry } from '../shared/api';
import { isAdmin, type ResolvedConfig } from './config';

/**
 * 承認済みと確かめた結果を覚えておく時間。API と画像のリクエストのたびに D1 を読まないため。
 * 取り消しが届くのは、長くてもこれだけ遅れる（ページの DO の確かめ直しと同じ長さ）。
 * **画面の読み込み（HTML）と WebSocket の接続には使わない**（`fresh`）。ほかの isolate で拒否された人が、
 * 古い結果で画面を開き直したり、つなぎ直したりできないようにする（DO は、Worker が接続の直前に
 * 確かめた結果を、そのまま覚える）
 */
export const APPROVAL_CACHE_MS = 30_000;

/** 承認済みと確かめた時刻（小文字の email ごと）。この isolate の中だけで持つ */
const approvedAt = new Map<string, number>();

const statusOf = (db: D1Database, key: string) =>
  db.prepare('SELECT status FROM users WHERE email = ?').bind(key).first<{ status: ApprovalStatus }>();

/**
 * `email` の人の状態。表になければ、承認待ちとして入れる（初めて来た人）。
 * 管理者は表を見ずに approved を返す（管理者を、表の状態で締め出さない）。
 * `fresh` なら、覚えている結果を使わずに D1 を読む（`APPROVAL_CACHE_MS`）
 */
export async function approvalOf(
  db: D1Database,
  config: ResolvedConfig,
  email: string,
  fresh = false,
): Promise<ApprovalStatus> {
  if (isAdmin(config, email)) return 'approved';
  const key = email.toLowerCase();
  const at = approvedAt.get(key);
  if (!fresh && at !== undefined && Date.now() - at < APPROVAL_CACHE_MS) return 'approved';
  // ほとんどのリクエストは、読むだけで済む。書くのは初めて来たときだけにする
  let status = (await statusOf(db, key))?.status;
  if (status === undefined) {
    // 同じ人のリクエストが同時に来ても、1 行だけになる。先に入った行（別の状態に変えられている
    // こともある）の状態を返す（DO NOTHING では、競合したときに RETURNING が行を返さない）
    const row = await db
      .prepare(
        `INSERT INTO users (email, status, created_at) VALUES (?, 'pending', ?)
         ON CONFLICT (email) DO UPDATE SET email = excluded.email RETURNING status`,
      )
      .bind(key, Date.now())
      .first<{ status: ApprovalStatus }>();
    status = row?.status ?? 'pending';
  }
  if (status === 'approved') approvedAt.set(key, Date.now());
  else approvedAt.delete(key);
  return status;
}

/** `email` の人が承認済みか。表を読むだけで、行は作らない（ページの DO から呼ぶ） */
export async function isApproved(db: D1Database, email: string): Promise<boolean> {
  return (await statusOf(db, email.toLowerCase()))?.status === 'approved';
}

/**
 * 利用者の一覧。承認待ち（古い順）、管理者（設定の `admins`。email の順）、ほかの人（新しい順）の順に並べる。
 * 管理者になる前に表に入った人は、管理者として 1 度だけ出す
 */
export async function listUsers(db: D1Database, config: ResolvedConfig): Promise<UserEntry[]> {
  const { results } = await db
    .prepare(
      `SELECT email, status, created_at, decided_by, decided_at FROM users
       ORDER BY status = 'pending' DESC,
                CASE WHEN status = 'pending' THEN created_at ELSE -COALESCE(decided_at, created_at) END`,
    )
    .all<UserEntry>();
  const admins = config.admins ?? new Set<string>();
  const rows = results.filter((user) => !admins.has(user.email));
  const adminRows = [...admins].sort().map(
    (email): UserEntry => ({ email, status: 'approved', admin: true, created_at: null, decided_by: null, decided_at: null }),
  );
  const decided = rows.findIndex((user) => user.status !== 'pending');
  const split = decided === -1 ? rows.length : decided;
  return [...rows.slice(0, split), ...adminRows, ...rows.slice(split)];
}

/** 承認待ちの人数（管理者の画面の印に使う） */
export async function pendingCount(db: D1Database): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM users WHERE status = 'pending'`).first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * 承認か拒否をする。`by` は管理者の主体。表にない人なら false（まだ来ていない人は、先に承認できない。
 * 来る前に承認するなら、Access の側で許可する範囲を絞る）
 */
export async function decideUser(
  db: D1Database,
  email: string,
  status: Exclude<ApprovalStatus, 'pending'>,
  by: string,
): Promise<boolean> {
  const key = email.toLowerCase();
  // この isolate で覚えている結果は、すぐに捨てる（ほかの isolate では、長くても APPROVAL_CACHE_MS 遅れる）
  approvedAt.delete(key);
  const result = await db
    .prepare('UPDATE users SET status = ?, decided_by = ?, decided_at = ? WHERE email = ?')
    .bind(status, by, Date.now(), key)
    .run();
  return result.meta.changes > 0;
}
