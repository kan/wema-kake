import { env } from 'cloudflare:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { app } from '../src/worker/index';

const TEAM = 'https://team.cloudflareaccess.com';
const AUD = 'aud-tag';
const accessEnv = { ...env, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };

let privateKey: CryptoKey;
let otherKey: CryptoKey;
let jwks: { keys: unknown[] };

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  otherKey = (await generateKeyPair('RS256')).privateKey;
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' }] };
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Access の公開鍵の取得だけを差し替える */
function mockCerts() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === `${TEAM}/cdn-cgi/access/certs`) return Response.json(jwks);
    throw new Error(`unexpected fetch: ${url}`);
  });
}

function token({
  email = 'a@example.com' as string | undefined,
  key = privateKey,
  kid = 'k1',
  iss = TEAM,
  aud = AUD,
  exp = '5m',
} = {}) {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuer(iss)
    .setAudience(aud)
    .setExpirationTime(exp)
    .sign(key);
}

const get = (headers: Record<string, string>, e: object = accessEnv) =>
  app.request('https://wiki.example.com/api/pages/memo', { headers }, e);

describe('requireAccess', () => {
  it('Access の JWT が正しければ通す', async () => {
    mockCerts();
    const res = await get({ 'Cf-Access-Jwt-Assertion': await token() });
    expect(res.status).toBe(200);
  });

  it.each([
    ['別の鍵で署名', () => token({ key: otherKey })],
    ['aud が違う', () => token({ aud: 'other' })],
    ['issuer が違う', () => token({ iss: 'https://evil.example.com' })],
    ['期限切れ', () => token({ exp: '-1m' })],
    ['email がない（サービストークンなど）', () => new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(TEAM).setAudience(AUD).setExpirationTime('5m').sign(privateKey)],
    ['JWT の形をしていない', async () => 'garbage'],
  ])('%s JWT は 401', async (_name, make) => {
    mockCerts();
    const res = await get({ 'Cf-Access-Jwt-Assertion': await make() });
    expect(res.status).toBe(401);
  });

  it('鍵のローテーション後は公開鍵を取り直す。ただし短い間隔では取り直さない', async () => {
    const certs = mockCerts();
    expect((await get({ 'Cf-Access-Jwt-Assertion': await token() })).status).toBe(200);
    const fetched = certs.mock.calls.length;

    const rotated = await generateKeyPair('RS256');
    jwks = { keys: [{ ...(await exportJWK(rotated.publicKey)), kid: 'k2', alg: 'RS256' }] };
    const newToken = await token({ key: rotated.privateKey, kid: 'k2' });

    // 取得した直後は、知らない鍵 ID でも取り直さない
    expect((await get({ 'Cf-Access-Jwt-Assertion': newToken })).status).toBe(401);
    expect(certs.mock.calls.length).toBe(fetched);

    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 60_000);
    expect((await get({ 'Cf-Access-Jwt-Assertion': newToken })).status).toBe(200);
    expect(certs.mock.calls.length).toBe(fetched + 1);
  });

  it('JWT がなければ 401（DEV_USER_EMAIL があっても使わない）', async () => {
    const res = await get({}, { ...accessEnv, DEV_USER_EMAIL: 'dev@example.com' });
    expect(res.status).toBe(401);
  });

  it('Access が未設定のとき、DEV_USER_EMAIL は localhost でだけ有効', async () => {
    const devEnv = { ...env, ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '', DEV_USER_EMAIL: 'dev@example.com' };
    expect((await app.request('http://localhost/api/pages/memo', {}, devEnv)).status).toBe(200);
    expect((await app.request('https://wiki.example.com/api/pages/memo', {}, devEnv)).status).toBe(500);
  });

  it('Access も DEV_USER_EMAIL も未設定なら拒否する', async () => {
    const bare = { ...env, ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '', DEV_USER_EMAIL: undefined };
    expect((await app.request('http://localhost/api/pages/memo', {}, bare)).status).toBe(500);
  });

  it('WebSocket の接続要求も保護する', async () => {
    const res = await app.request(
      'https://wiki.example.com/ws/memo',
      { headers: { Upgrade: 'websocket' } },
      accessEnv,
    );
    expect(res.status).toBe(401);
  });
});
