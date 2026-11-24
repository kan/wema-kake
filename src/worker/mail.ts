// メールでの通知（issue #131）。Cloudflare Email Service の `send_email` バインディング（`EMAIL`）と、
// 送信元のアドレス（vars の `EMAIL_FROM`）が両方あるときだけ送る。どちらかが無ければ何もしない。
//
// 送るもの（文面は下の MESSAGES）
//   - 新しい人が承認待ちになった → 管理者の全員へ（users-api.ts）
//   - 管理者が承認した → 本人へ（users-api.ts）
//   - 自分が作ったページに、ほかの人が付箋を足した → 作った人へ。受け取ると決めた人だけ（page-do.ts）
//
// **送信に失敗しても、例外にしない**（承認や書き込みを失敗させない）。失敗はログに残す。
import type { Context } from 'hono';
import type { Lang } from '../shared/i18n';
import type { AuthEnv } from './access';
import type { WemaKakeEnv } from './config';

type MailEnv = Pick<WemaKakeEnv, 'EMAIL' | 'EMAIL_FROM'>;

export interface Mail {
  to: string | string[];
  subject: string;
  text: string;
}

/** メールを送れる設定か */
export function canSendMail(env: MailEnv): env is { EMAIL: SendEmail; EMAIL_FROM: string } {
  return env.EMAIL !== undefined && typeof env.EMAIL_FROM === 'string' && env.EMAIL_FROM !== '';
}

/**
 * メールを送る。送れない設定なら何もしない。失敗しても例外にせず、ログに残す。
 * `fromName` は送信元の表示名（サイトの名前）
 */
export async function sendMail(env: MailEnv, mail: Mail, fromName?: string): Promise<void> {
  if (!canSendMail(env) || (Array.isArray(mail.to) && mail.to.length === 0)) return;
  const address = env.EMAIL_FROM;
  try {
    await env.EMAIL.send({
      from: fromName ? { email: address, name: fromName } : address,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
    });
  } catch (e) {
    // Email Service のエラーは `code`（E_RECIPIENT_NOT_ALLOWED など）を持つ
    const code = (e as { code?: unknown }).code;
    console.error(`wema-kake: could not send mail${typeof code === 'string' ? ` (${code})` : ''}:`, e);
  }
}

/**
 * リクエストの処理から、サイトの名前で送る。文面はサイトの既定の言語（設定の `defaultLang`）で、
 * `compose` が作る。応答を待たせない（`waitUntil`）。実行の文脈が無いとき（テストの `app.request`）は、
 * 送り終えるまで待つ
 */
export function sendSiteMail(
  c: Context<AuthEnv>,
  to: Mail['to'],
  compose: (text: MailText, site: string) => Pick<Mail, 'subject' | 'text'>,
): Promise<void> {
  const { siteName, defaultLang } = c.get('config');
  const task = sendMail(c.env, { to, ...compose(mailText(defaultLang), siteName) }, siteName);
  try {
    c.executionCtx.waitUntil(task);
    return Promise.resolve();
  } catch {
    return task;
  }
}

/** 文面の中の URL。サイトのオリジン（vars の `SITE_ORIGIN`）が無ければ、パスだけにする */
export const siteUrl = (origin: string | undefined, path: string): string =>
  origin ? new URL(path, origin).toString() : path;

const MESSAGES = {
  ja: {
    pendingSubject: (site: string) => `[${site}] 承認待ちの利用者がいます`,
    pendingText: (email: string, url: string) =>
      `${email} さんが承認を待っています。\n\n利用者の画面で、承認するか拒否してください。\n${url}\n`,
    approvedSubject: (site: string) => `[${site}] 使えるようになりました`,
    approvedText: (site: string, url: string) => `${site} の管理者が、あなたを承認しました。\n\n${url}\n`,
    notesSubject: (page: string, count: number) => `「${page}」に新しい付箋が ${count} 件あります`,
    notesText: (page: string, count: number, writers: string, url: string) =>
      `あなたが作ったページ「${page}」に、${writers}が付箋を ${count} 件足しました。\n\n${url}\n\n` +
      'この知らせは、プロフィールの画面で止められます。\n',
  },
  en: {
    pendingSubject: (site: string) => `[${site}] A user is waiting for approval`,
    pendingText: (email: string, url: string) =>
      `${email} is waiting for approval.\n\nApprove or reject them on the users page.\n${url}\n`,
    approvedSubject: (site: string) => `[${site}] You can now use the site`,
    approvedText: (site: string, url: string) => `An administrator of ${site} has approved you.\n\n${url}\n`,
    notesSubject: (page: string, count: number) => `${count} new note${count === 1 ? '' : 's'} on "${page}"`,
    notesText: (page: string, count: number, writers: string, url: string) =>
      `${writers} added ${count} note${count === 1 ? '' : 's'} to "${page}", a page you created.\n\n${url}\n\n` +
      'You can turn these notices off on your profile page.\n',
  },
} as const;

export type MailText = (typeof MESSAGES)[Lang];

export const mailText = (lang: Lang): MailText => MESSAGES[lang];

/**
 * 付箋を足した人の名前を並べる。日本語では、人の名前に「さん」を付ける（agent のクライアント名には
 * 付けない）。`others` は、並べなかった人数（「ほか n 人」）
 */
export function writerList(lang: Lang, writers: readonly { name: string; person: boolean }[], others: number): string {
  if (lang === 'ja') {
    const names = writers.map(({ name, person }) => (person ? `${name} さん` : name)).join('、');
    return others > 0 ? `${names}ほか ${others} 人` : names;
  }
  const names = writers.map(({ name }) => name).join(', ');
  return others > 0 ? `${names} and ${others} other${others === 1 ? '' : 's'}` : names;
}
