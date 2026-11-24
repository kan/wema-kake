// 利用者の承認（issue #120）の入口。承認の関所、`GET /api/session`、管理者の利用者の API。
import { type Context, Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { type ApprovalStatus, ERROR_NOT_APPROVED, type Session } from '../shared/api';
import type { AuthEnv } from './access';
import { isAdmin } from './config';
import { type MailText, sendSiteMail, siteUrl } from './mail';
import { approvalOf, decideUser, listUsers, pendingCount } from './users';

/**
 * リクエストの人の承認の状態。承認が無効なら undefined。画面の読み込み（HTML）と WebSocket の接続では、
 * 覚えている結果を使わずに D1 を読む（`APPROVAL_CACHE_MS` の説明）
 */
export function approvalOfRequest(c: Context<AuthEnv>, fresh = isConnectOrPage(c)): Promise<ApprovalStatus | undefined> {
  const config = c.get('config');
  return config.approval
    ? approvalOf(c.env.DB, config, c.get('email'), fresh, (email) => mailPending(c, email))
    : Promise.resolve(undefined);
}

/**
 * 新しい人が承認待ちになったことを、管理者の全員へメールで知らせる（issue #131）。1 人ずつ送る
 * （宛先に並べると、ほかの管理者のアドレスが見える）
 */
const mailPending = async (c: Context<AuthEnv>, email: string) => {
  const compose = (text: MailText, site: string) => ({
    subject: text.pendingSubject(site),
    text: text.pendingText(email, siteUrl(c.env.SITE_ORIGIN, '/users')),
  });
  await Promise.all([...(c.get('config').admins ?? [])].map((admin) => sendSiteMail(c, admin, compose)));
};

/** 承認したことを、本人へメールで知らせる（issue #131） */
const mailApproved = (c: Context<AuthEnv>, email: string) =>
  sendSiteMail(c, email, (text, site) => ({
    subject: text.approvedSubject(site),
    text: text.approvedText(site, siteUrl(c.env.SITE_ORIGIN, '/')),
  }));

const isConnectOrPage = (c: Context<AuthEnv>) =>
  c.req.header('Upgrade') === 'websocket' || (c.req.header('Accept')?.includes('text/html') ?? false);

/**
 * 承認済みでなければ 403 を返すミドルウェア。承認が無効なら何もしない。
 * `/api`、`/ws`、`/img` に掛ける（画面のアセットには掛けない。承認待ちの表示を出すのに要る）
 */
export const requireApproval = createMiddleware<AuthEnv>(async (c, next) => {
  const approval = await approvalOfRequest(c);
  if (approval !== undefined && approval !== 'approved') return c.json({ error: ERROR_NOT_APPROVED, approval }, 403);
  await next();
});

/**
 * ログインしている人。承認の関所より前に置く（承認待ちの人も、自分の状態を読めるようにする）。
 * 切断中に認証が切れたかをブラウザが調べるのにも使うので、軽く保つ
 */
export async function session(c: Context<AuthEnv>) {
  const admin = isAdmin(c.get('config'), c.get('email'));
  const body: Session = { actor: c.get('actor'), admin };
  // 切断中のブラウザが、承認を取り消されていないかを確かめるのにも使うので、D1 を読む
  const approval = await approvalOfRequest(c, true);
  if (approval !== undefined) {
    body.approval = approval;
    if (admin) body.pendingUsers = await pendingCount(c.env.DB);
  }
  return c.json(body);
}

/** `/api/users`。管理者だけが呼べる。承認が無効なら 404（画面にも項目を出さない） */
export const usersApi = new Hono<AuthEnv>();

usersApi.use(async (c, next) => {
  const config = c.get('config');
  if (!config.approval) return c.json({ error: 'approval is not enabled' }, 404);
  if (!isAdmin(config, c.get('email'))) return c.json({ error: 'only administrators can manage users' }, 403);
  await next();
});

usersApi.get('/', async (c) => c.json({ users: await listUsers(c.env.DB, c.get('config')) }));

/**
 * 承認か拒否をする（本文は `{ "status": "approved" | "rejected" }`）。まだ来ていない人は 404。
 * 管理者は 400（いつも承認済みとして扱うので、表の状態を変えても効かない）
 */
usersApi.put('/:email/status', async (c) => {
  const body = await c.req.json<{ status?: unknown }>().catch(() => null);
  const status = body?.status;
  if (status !== 'approved' && status !== 'rejected') {
    return c.json({ error: 'status must be "approved" or "rejected"' }, 400);
  }
  if (isAdmin(c.get('config'), c.req.param('email'))) {
    return c.json({ error: 'administrators are always approved' }, 400);
  }
  const before = await decideUser(c.env.DB, c.req.param('email'), status, c.get('actor'));
  if (before === null) return c.json({ error: 'user not found' }, 404);
  // 承認した（承認済みの人を承認し直したときは送らない）ことを、本人へ知らせる（issue #131）
  if (status === 'approved' && before !== 'approved') await mailApproved(c, c.req.param('email').toLowerCase());
  return c.json({ ok: true });
});
