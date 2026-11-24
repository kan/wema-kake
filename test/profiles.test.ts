// 利用者の表示名とアイコン（issue #121）
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { MAX_DISPLAY_NAME_LENGTH, MAX_ICON_BYTES, type Profile } from '../src/shared/api';
import { TOOLS } from '../src/shared/tools';
import { createApp } from '../src/worker/index';
import { ServerBoardAccess } from '../src/worker/mcp/board-access';
import { createNote } from './helpers';

const app = createApp();
const ADMIN = 'admin@example.com';
const approvalApp = createApp({ admins: [ADMIN], approval: true });

let count = 0;
const unique = (prefix: string) => `${prefix}-${++count}`;
const person = () => `${unique('p')}@example.com`;

const dev = (email: string) => ({ ...env, ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '', DEV_USER_EMAIL: email });
const call = (email: string, path: string, init: RequestInit = {}, target = app) =>
  target.request(`http://localhost${path}`, init, dev(email));
const putName = (email: string, name: unknown) =>
  call(email, '/api/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
const putIcon = (email: string, body: Uint8Array, type = 'image/webp') =>
  call(email, '/api/profile/icon', { method: 'PUT', headers: { 'Content-Type': type }, body });
/** 表示名とアイコンだけ（メールの設定は mail.test.ts） */
const profile = async (email: string): Promise<Profile> => {
  const { name, icon } = (await (await call(email, '/api/profile')).json()) as Profile;
  return { name, icon };
};
const lookup = async (email: string, actors: unknown) => {
  const res = await call(email, '/api/profiles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ actors }),
  });
  return { status: res.status, body: (await res.json()) as { profiles: Record<string, Profile> } };
};
/** 中身は確かめないので、形式の申告だけ合っていればよい */
const fakeWebp = (bytes = 100) => new Uint8Array(bytes).fill(1);

describe('表示名', () => {
  it('設定して読める。前後の空白は落とし、空文字で未設定に戻す', async () => {
    const email = person();
    expect(await profile(email)).toEqual({ name: null, icon: null });
    expect(await (await putName(email, '  山田 花子 ')).json()).toEqual({ ok: true, name: '山田 花子' });
    expect(await profile(email)).toEqual({ name: '山田 花子', icon: null });
    expect((await putName(email, '')).status).toBe(200);
    expect(await profile(email)).toEqual({ name: null, icon: null });
  });

  it(`${MAX_DISPLAY_NAME_LENGTH} 文字まで（絵文字は 1 文字と数える）。制御文字と文字列でない値は 400`, async () => {
    const email = person();
    expect((await putName(email, '😀'.repeat(MAX_DISPLAY_NAME_LENGTH))).status).toBe(200);
    expect((await putName(email, 'a'.repeat(MAX_DISPLAY_NAME_LENGTH + 1))).status).toBe(400);
    expect((await putName(email, 'a\nb')).status).toBe(400);
    // 行の区切り、C1 の制御文字、文字の向きを変える制御（2 種）。生の文字で書くと、U+2028 が改行として
    // 扱われ、CI でファイルを読めなかったので、コードポイントから作る
    for (const bad of [0x2028, 0x85, 0x202e, 0x2067].map((c) => `a${String.fromCodePoint(c)}b`)) {
      expect((await putName(email, bad)).status).toBe(400);
    }
    expect((await putName(email, 1)).status).toBe(400);
  });

  it('ほかの人と同じ名前でもよい', async () => {
    expect((await putName(person(), '同じ名前')).status).toBe(200);
    expect((await putName(person(), '同じ名前')).status).toBe(200);
  });
});

describe('アイコン', () => {
  it('WebP を上げると、/img で読める URL を返す。替えると前の画像を消す。外せる', async () => {
    const email = person();
    const first = (await (await putIcon(email, fakeWebp())).json()) as { icon: string };
    expect(first.icon).toMatch(/^\/img\/[0-9a-f-]{36}\.webp$/);
    const img = await call(email, first.icon);
    expect(img.status).toBe(200);
    expect(img.headers.get('Content-Type')).toBe('image/webp');
    await img.arrayBuffer();

    const second = (await (await putIcon(email, fakeWebp(200))).json()) as { icon: string };
    expect(await profile(email)).toEqual({ name: null, icon: second.icon });
    expect(await env.IMAGES.head(first.icon.slice('/img/'.length))).toBeNull();

    expect((await call(email, '/api/profile/icon', { method: 'DELETE' })).status).toBe(200);
    expect(await profile(email)).toEqual({ name: null, icon: null });
    expect(await env.IMAGES.head(second.icon.slice('/img/'.length))).toBeNull();
  });

  it('JPEG も受け付ける（WebP を書き出せないブラウザのため）', async () => {
    const email = person();
    const { icon } = (await (await putIcon(email, fakeWebp(), 'image/jpeg')).json()) as { icon: string };
    expect(icon).toMatch(/^\/img\/[0-9a-f-]{36}\.jpg$/);
    const img = await call(email, icon);
    expect(img.headers.get('Content-Type')).toBe('image/jpeg');
    await img.arrayBuffer();
  });

  it('WebP と JPEG でなければ 415、上限を超えれば 413、空なら 400', async () => {
    const email = person();
    expect((await putIcon(email, fakeWebp(), 'image/png')).status).toBe(415);
    expect((await putIcon(email, fakeWebp(MAX_ICON_BYTES + 1))).status).toBe(413);
    expect((await putIcon(email, new Uint8Array())).status).toBe(400);
    expect(await profile(email)).toEqual({ name: null, icon: null });
  });

  it('表示名を変えても、アイコンは残る（逆も）', async () => {
    const email = person();
    const { icon } = (await (await putIcon(email, fakeWebp())).json()) as { icon: string };
    await putName(email, '名前');
    expect(await profile(email)).toEqual({ name: '名前', icon });
  });
});

describe('POST /api/profiles', () => {
  it('何かを設定した人だけを、渡した主体の文字列のまま返す（email の大文字と小文字は区別しない）', async () => {
    const named = person();
    const unset = person();
    await putName(named, 'あだ名');
    const upper = `user:${named.toUpperCase()}`;
    const { status, body } = await lookup(unset, [upper, `user:${unset}`, 'agent:claude.ai']);
    expect(status).toBe(200);
    expect(body.profiles).toEqual({ [upper]: { name: 'あだ名', icon: null } });
  });

  it('D1 の 1 文で束ねられる数を超えても引ける。500 を超えれば 400', async () => {
    const named = person();
    await putName(named, '最後の人');
    const many = [...Array.from({ length: 300 }, (_, i) => `user:nobody-${i}@example.com`), `user:${named}`];
    expect((await lookup(named, many)).body.profiles).toEqual({ [`user:${named}`]: { name: '最後の人', icon: null } });
    expect((await lookup(named, Array.from({ length: 501 }, () => 'user:x@example.com'))).status).toBe(400);
    expect((await lookup(named, 'user:x')).status).toBe(400);
  });
});

it('承認が有効なら、承認待ちの人は表示名を変えられない', async () => {
  const email = person();
  const res = await call(
    email,
    '/api/profile',
    { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x' }) },
    approvalApp,
  );
  expect(res.status).toBe(403);
  // 管理者は、承認の表に入らないが、表示名を持てる
  expect((await call(ADMIN, '/api/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '管理者さん' }) }, approvalApp)).status).toBe(200);
  expect(await (await call(ADMIN, '/api/profile', {}, approvalApp)).json()).toMatchObject({ name: '管理者さん', icon: null });
});

it('read_board は、作成者が表示名を設定していれば created_by_name を付ける', async () => {
  const named = person();
  const unset = person();
  await putName(named, '書いた人');
  const page = unique('profile-page');
  const stub = env.PAGE.getByName(page);
  await stub.createPage('表示名のテスト');
  for (const [actor, id] of [
    [`user:${named}`, 'n1'],
    [`user:${unset}`, 'n2'],
  ]) {
    expect((await stub.applyOps({ actor, clientId: 'c', opId: unique('op'), deltas: [createNote(id)] })).ok).toBe(true);
  }
  const tool = TOOLS.find((t) => t.name === 'read_board')!;
  const board = (await tool.run(new ServerBoardAccess(env, { actor: 'agent:test', delegate: `user:${ADMIN}` }), { page })) as {
    notes: { id: string; created_by: string; created_by_name?: string }[];
  };
  const byId = new Map(board.notes.map((n) => [n.id, n]));
  expect(byId.get('n1')).toMatchObject({ created_by: `user:${named}`, created_by_name: '書いた人' });
  expect(byId.get('n2')?.created_by_name).toBeUndefined();
});
