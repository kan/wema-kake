import { createExecutionContext, env } from 'cloudflare:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { agentActor } from '../src/worker/access';
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
  oauth = undefined as unknown,
} = {}) {
  return new SignJWT({ email, oauth })
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

  it('JWT がなければ 401（DEV_USER_EMAIL があっても使わない）', async () => {
    const res = await get({}, { ...accessEnv, DEV_USER_EMAIL: 'dev@example.com' });
    expect(res.status).toBe(401);
  });

  it('Access が未設定のとき、DEV_USER_EMAIL はローカルのホスト名でだけ有効', async () => {
    const devEnv = { ...env, ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '', DEV_USER_EMAIL: 'dev@example.com' };
    expect((await app.request('http://localhost/api/pages/memo', {}, devEnv)).status).toBe(200);
    // ローカルのリバースプロキシが付けるホスト名（<名前>.localhost）も、ローカルとして扱う
    expect((await app.request('https://wema-kake.dev.localhost/api/pages/memo', {}, devEnv)).status).toBe(200);
    expect((await app.request('https://wiki.example.com/api/pages/memo', {}, devEnv)).status).toBe(500);
    // 末尾が似ているだけの名前は、ローカルとして扱わない
    expect((await app.request('https://evillocalhost/api/pages/memo', {}, devEnv)).status).toBe(500);
    expect((await app.request('https://localhost.example.com/api/pages/memo', {}, devEnv)).status).toBe(500);
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

describe('agent と人の入口を分ける', () => {
  /** Access の Managed OAuth のトークンで届いたリクエストの JWT に入る値 */
  const CLAUDE = { client_id: 'c1', client_redirect_uri: 'https://claude.ai/api/mcp/auth_callback' };

  const mcp = (headers: Record<string, string>, e: object = accessEnv) =>
    app.request(
      'https://wiki.example.com/mcp',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      },
      e,
      createExecutionContext(),
    );

  it('OAuth のトークンで届いたリクエストは、/mcp だけを通す', async () => {
    mockCerts();
    const jwt = await token({ oauth: CLAUDE });
    expect((await mcp({ 'Cf-Access-Jwt-Assertion': jwt })).status).toBe(200);
    expect((await get({ 'Cf-Access-Jwt-Assertion': jwt })).status).toBe(403);
    const ws = await app.request(
      'https://wiki.example.com/ws/memo',
      { headers: { Upgrade: 'websocket', 'Cf-Access-Jwt-Assertion': jwt } },
      accessEnv,
    );
    expect(ws.status).toBe(403);
  });

  it('oauth の中身が期待と違っても、人の入口は通さない', async () => {
    mockCerts();
    for (const oauth of [{}, null, 'x']) {
      expect((await get({ 'Cf-Access-Jwt-Assertion': await token({ oauth }) })).status).toBe(403);
    }
  });

  it('ブラウザのログインで届いたリクエストは、/mcp を通さない', async () => {
    mockCerts();
    expect((await mcp({ 'Cf-Access-Jwt-Assertion': await token() })).status).toBe(403);
    expect((await mcp({})).status).toBe(401);
  });

  it('エンコードしたパスでも、/mcp は agent だけを通す', async () => {
    mockCerts();
    const encoded = (jwt: string) =>
      app.request(
        'https://wiki.example.com/%6dcp',
        { method: 'POST', headers: { 'Cf-Access-Jwt-Assertion': jwt } },
        accessEnv,
        createExecutionContext(),
      );
    expect((await encoded(await token())).status).toBe(403);
  });

  it('/mcp も、他のオリジンからのリクエストを断る', async () => {
    mockCerts();
    const res = await mcp({
      'Cf-Access-Jwt-Assertion': await token({ oauth: CLAUDE }),
      Origin: 'https://evil.example.com',
    });
    expect(res.status).toBe(403);
  });

  it('Access が未設定のとき、/mcp もローカルのホスト名でだけ有効', async () => {
    const devEnv = { ...env, ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '', DEV_USER_EMAIL: 'dev@example.com' };
    expect((await mcp({}, devEnv)).status).toBe(500);
  });

  it('agent の主体は、認可のリダイレクト先のホスト名から決める', () => {
    expect(agentActor(CLAUDE.client_redirect_uri)).toBe('agent:claude.ai');
    expect(agentActor('https://ChatGPT.com/connector_platform_oauth_redirect')).toBe('agent:chatgpt.com');
    expect(agentActor('http://localhost:8976/callback')).toBe('agent:localhost');
    expect(agentActor('http://127.0.0.1:8976/callback')).toBe('agent:localhost');
    expect(agentActor('http://[::1]:8976/callback')).toBe('agent:localhost');
    expect(agentActor('com.example.app:/callback')).toBe('agent:com.example.app');
    expect(agentActor('cursor://anysphere.cursor-mcp/oauth/callback')).toBe('agent:anysphere.cursor-mcp');
    expect(agentActor('not a url')).toBe('agent:unknown');
    expect(agentActor(undefined)).toBe('agent:unknown');
  });
});

// 公開鍵を入れ替えるので、このファイルの最後に置く（後のテストが、古い鍵で署名できなくなる）
describe('公開鍵のローテーション', () => {
  it('ローテーション後は公開鍵を取り直す。ただし短い間隔では取り直さない', async () => {
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
});
