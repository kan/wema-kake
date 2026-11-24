// メールでの通知（issue #131）。送信のバインディングは偽物に替え、送ろうとしたメールを集めて確かめる
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { OwnProfile } from '../src/shared/api';
import { createApp } from '../src/worker/index';
import type { PageDO } from '../src/worker/page-do';
import { NOTE_NOTICE_DELAY_MS } from '../src/worker/page-do';
import { createNote } from './helpers';

const ADMIN = 'admin@example.com';
const FROM = 'notice@example.com';

let count = 0;
const unique = (prefix: string) => `${prefix}-${++count}`;
const person = () => `${unique('p')}@example.com`;

interface Sent {
  to: string | string[];
  subject: string;
  text?: string;
}

/** 送ろうとしたメールを集める、偽物の `send_email` バインディング */
function fakeMail(): { binding: SendEmail; sent: Sent[] } {
  const sent: Sent[] = [];
  const binding = {
    async send(message: Sent) {
      sent.push(message);
      return { messageId: String(sent.length) };
    },
  } as unknown as SendEmail;
  return { binding, sent };
}

function setup(options: { approval?: boolean; mail?: boolean } = {}) {
  const { binding, sent } = fakeMail();
  const app = createApp({ admins: [ADMIN], approval: options.approval ?? false, siteName: 'テスト' });
  const mailEnv = options.mail === false ? {} : { EMAIL: binding, EMAIL_FROM: FROM };
  const dev = (email: string) => ({
    ...env, ...mailEnv, SITE_ORIGIN: 'https://wk.example.com', ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '', DEV_USER_EMAIL: email,
  });
  const call = (email: string, path: string, init: RequestInit = {}) => app.request(`http://localhost${path}`, init, dev(email));
  const json = (email: string, method: string, path: string, body?: unknown) =>
    call(email, path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { sent, call, json };
}

describe('承認のメール', () => {
  it('初めて来た人が承認待ちになると、管理者へ 1 度だけ送る', async () => {
    const { sent, call } = setup({ approval: true });
    const email = person();
    await call(email, '/api/session');
    await call(email, '/api/session');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: ADMIN, subject: '[テスト] A user is waiting for approval' });
    expect(sent[0].text).toContain(email);
    expect(sent[0].text).toContain('https://wk.example.com/users');
  });

  it('承認すると本人へ送る。拒否と、承認済みの人の承認し直しでは送らない', async () => {
    const { sent, call, json } = setup({ approval: true });
    const email = person();
    await call(email, '/api/session');
    sent.length = 0;
    const decide = (status: string) => json(ADMIN, 'PUT', `/api/users/${encodeURIComponent(email)}/status`, { status });

    expect((await decide('approved')).status).toBe(200);
    expect(sent).toEqual([expect.objectContaining({ to: email, subject: '[テスト] You can now use the site' })]);
    await decide('approved');
    await decide('rejected');
    expect(sent).toHaveLength(1);
    // 拒否した人を承認し直したら送る
    await decide('approved');
    expect(sent).toHaveLength(2);
  });

  it('送信の設定が無ければ送らず、承認はそのまま進む', async () => {
    const { sent, call, json } = setup({ approval: true, mail: false });
    const email = person();
    await call(email, '/api/session');
    expect((await json(ADMIN, 'PUT', `/api/users/${encodeURIComponent(email)}/status`, { status: 'approved' })).status).toBe(200);
    expect(sent).toHaveLength(0);
  });

  it('送信に失敗しても、承認は失敗しない', async () => {
    const app = createApp({ admins: [ADMIN], approval: true });
    const failing = { send: () => Promise.reject(Object.assign(new Error('no'), { code: 'E_DAILY_LIMIT_EXCEEDED' })) };
    const email = person();
    const res = await app.request('http://localhost/api/session', {}, {
      ...env, EMAIL: failing, EMAIL_FROM: FROM, ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '', DEV_USER_EMAIL: email,
    });
    expect(res.status).toBe(200);
  });
});

describe('プロフィールのメールの設定', () => {
  it('送れるサイトかと、受け取るかを返す。受け取るかは変えられる', async () => {
    const { json, call } = setup();
    const email = person();
    const profile = async () => (await (await call(email, '/api/profile')).json()) as OwnProfile;
    expect(await profile()).toEqual({ name: null, icon: null, notifyNotes: false, mail: true });
    expect((await json(email, 'PUT', '/api/profile/notify', { notes: true, lang: 'ja' })).status).toBe(200);
    expect((await profile()).notifyNotes).toBe(true);
    expect((await json(email, 'PUT', '/api/profile/notify', { notes: true, lang: 'fr' })).status).toBe(400);
    expect((await json(email, 'PUT', '/api/profile/notify', { notes: 'yes', lang: 'ja' })).status).toBe(400);

    const { call: plain } = setup({ mail: false });
    expect(((await (await plain(email, '/api/profile')).json()) as OwnProfile).mail).toBe(false);
  });
});

describe('新しい付箋のメール', () => {
  /** ページの DO の送信を、偽物に替える（同じ DO の、後の書き込みにも効く） */
  async function mailFrom(slug: string): Promise<Sent[]> {
    const { binding, sent } = fakeMail();
    await runInDurableObject(env.PAGE.getByName(slug), (instance: PageDO) => {
      const own = (instance as unknown as { env: Env }).env;
      Object.defineProperty(instance, 'env', {
        value: { ...own, EMAIL: binding, EMAIL_FROM: FROM, SITE_ORIGIN: 'https://wk.example.com' },
      });
    });
    return sent;
  }
  /** まとめる時間が過ぎたことにして、alarm を動かす */
  async function elapse(slug: string): Promise<void> {
    await runInDurableObject(env.PAGE.getByName(slug), (_: PageDO, state) => {
      const row = state.storage.sql.exec(`SELECT value FROM meta WHERE key = 'note_notice'`).toArray()[0];
      if (!row) return;
      const pending = JSON.parse(row.value as string) as { since: number };
      pending.since -= NOTE_NOTICE_DELAY_MS;
      state.storage.sql.exec(`UPDATE meta SET value = ? WHERE key = 'note_notice'`, JSON.stringify(pending));
    });
    await runDurableObjectAlarm(env.PAGE.getByName(slug));
  }
  const write = (slug: string, actor: string, ids: string[], delegate?: string) =>
    env.PAGE.getByName(slug).applyOps({
      actor, delegate, clientId: 'c', opId: unique('o'), deltas: ids.map((id) => createNote(id)),
    });

  it('ほかの人が足した付箋を、まとめて 1 通で作った人へ送る。作った人の付箋は数えない', async () => {
    const { json } = setup();
    const owner = person();
    const slug = unique('page');
    await write(slug, `user:${owner}`, ['n0']);
    await json(owner, 'PUT', '/api/profile/notify', { notes: true, lang: 'ja' });
    const sent = await mailFrom(slug);

    const a = person();
    await json(a, 'PUT', '/api/profile', { name: 'エー' });
    await write(slug, `user:${a}`, ['n1', 'n2']);
    await write(slug, `user:${owner}`, ['n3']);
    await write(slug, 'agent:claude.ai', ['n4'], `user:${owner}`);
    const b = person();
    await write(slug, `user:${b}`, ['n5']);
    // 時刻が来るまでは送らない
    await runDurableObjectAlarm(env.PAGE.getByName(slug));
    expect(sent).toHaveLength(0);

    await elapse(slug);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: owner, subject: `「${slug}」に新しい付箋が 3 件あります` });
    expect(sent[0].text).toContain(`エー さん、${b.split('@')[0]} さんが付箋を 3 件`);
    expect(sent[0].text).toContain(`https://wk.example.com/p/${slug}`);

    // 送った後は、新しく足されるまで送らない
    await elapse(slug);
    expect(sent).toHaveLength(1);
  });

  it('取り消した付箋は数えない', async () => {
    const { json } = setup();
    const owner = person();
    const slug = unique('page');
    await write(slug, `user:${owner}`, ['n0']);
    await json(owner, 'PUT', '/api/profile/notify', { notes: true, lang: 'en' });
    const sent = await mailFrom(slug);
    const other = `user:${person()}`;
    const first = await write(slug, other, ['n1']);
    await write(slug, other, ['n2', 'n3']);
    if (!first.ok || first.seq === null) throw new Error('write failed');
    await env.PAGE.getByName(slug).revert({ seq: first.seq, actor: other, clientId: 'c', opId: unique('rv') });
    await elapse(slug);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe(`2 new notes on "${slug}"`);
  });

  it('消した付箋は数えない。削除を戻した付箋は 1 枚として数える', async () => {
    const { json } = setup();
    const owner = person();
    const slug = unique('page');
    await write(slug, `user:${owner}`, ['n0']);
    await json(owner, 'PUT', '/api/profile/notify', { notes: true, lang: 'en' });
    const sent = await mailFrom(slug);
    const other = `user:${person()}`;
    await write(slug, other, ['n1', 'n2', 'n3']);
    const remove = async (id: string) => {
      const res = await env.PAGE.getByName(slug).applyOps({
        actor: other, clientId: 'c', opId: unique('o'), deltas: [{ type: 'note:delete', note: createNote(id).note }],
      });
      expect(res.ok).toBe(true);
    };
    await remove('n1');
    await remove('n2');
    await write(slug, other, ['n2']);
    await elapse(slug);
    expect(sent.map((m) => m.subject)).toEqual([`2 new notes on "${slug}"`]);
  });

  it('承認待ちか拒否された人には送らない', async () => {
    const { json } = setup();
    const owner = person();
    const slug = unique('page');
    await write(slug, `user:${owner}`, ['n0']);
    await json(owner, 'PUT', '/api/profile/notify', { notes: true, lang: 'en' });
    await env.DB.prepare(`INSERT INTO users (email, status, created_at) VALUES (?, 'rejected', 0)`).bind(owner).run();
    const sent = await mailFrom(slug);
    await write(slug, `user:${person()}`, ['n1']);
    await elapse(slug);
    expect(sent).toHaveLength(0);
  });

  it('受け取ると決めていない人には送らない', async () => {
    const owner = person();
    const slug = unique('page');
    await write(slug, `user:${owner}`, ['n0']);
    const sent = await mailFrom(slug);
    await write(slug, `user:${person()}`, ['n1']);
    await elapse(slug);
    expect(sent).toHaveLength(0);
  });

  it('作った人のいないページでは数えない', async () => {
    const slug = unique('system');
    await env.PAGE.getByName(slug).createWithContent('最初のページ', [{ type: 'note:create', note: createNote('n0').note }]);
    const sent = await mailFrom(slug);
    await write(slug, `user:${person()}`, ['n1']);
    await runInDurableObject(env.PAGE.getByName(slug), (_: PageDO, state) => {
      expect(state.storage.sql.exec(`SELECT 1 FROM meta WHERE key = 'note_notice'`).toArray()).toHaveLength(0);
    });
    expect(sent).toHaveLength(0);
  });
});
