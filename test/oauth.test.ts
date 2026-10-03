// MCP の認可（OAuth）を、クライアントの登録から /mcp の呼び出しまで通しで確かめる。
// Cloudflare Access（Access for SaaS）への通信だけを、模擬の応答に差し替える。
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { env, SELF } from 'cloudflare:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { oauthRoutes } from '../src/worker/mcp/authorize';
import { createNote } from './helpers';

const BASE = 'http://localhost';
const REDIRECT_URI = 'https://client.example.com/callback';
/** Access for SaaS の設定（vitest.config.ts の bindings）。wrangler の型にはない変数を読む */
const config: Env = env;

let privateKey: CryptoKey;
let jwks: { keys: unknown[] };

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' }] };
});

afterEach(() => {
  vi.restoreAllMocks();
});

const idToken = (claims: Record<string, unknown> = {}, aud: string = config.ACCESS_CLIENT_ID!) =>
  new SignJWT({ email: 'kan@example.com', name: 'Kan', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setSubject('user-1')
    .setAudience(aud)
    .setExpirationTime('5m')
    .sign(privateKey);

/** Access のトークンの発行と公開鍵の取得だけを差し替える */
function mockAccess(token: () => Promise<string>) {
  const real = globalThis.fetch;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === config.ACCESS_TOKEN_URL) {
      return Response.json({ access_token: 'upstream-access-token', id_token: await token() });
    }
    if (url === config.ACCESS_JWKS_URL) return Response.json(jwks);
    return real(input as RequestInfo, init);
  });
}

async function pkce() {
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { verifier, challenge };
}

async function register(name = 'Claude') {
  const res = await SELF.fetch(`${BASE}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: 'none',
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

const authorizeUrl = (clientId: string, challenge: string, redirectUri = REDIRECT_URI) =>
  `${BASE}/authorize?` +
  new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    state: 'client-state',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: `${BASE}/mcp`,
  });

/** 承認の画面を開き、フォームを送って、Access へのリダイレクトまで進める */
async function approve(clientId: string, challenge: string) {
  const page = await SELF.fetch(authorizeUrl(clientId, challenge));
  expect(page.status).toBe(200);
  const html = await page.text();
  const field = (name: string) => new RegExp(`name="${name}" value="([^"]*)"`).exec(html)![1];
  const cookie = page.headers.get('Set-Cookie')!.split(';')[0];
  const form = new URLSearchParams({ state: field('state'), csrf_token: field('csrf_token') });
  const res = await SELF.fetch(`${BASE}/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: form,
    redirect: 'manual',
  });
  return { html, res, form, cookie };
}

/** Access から戻ってきたブラウザのリクエスト。承認したブラウザなら、state に対応する Cookie を持つ */
function callbackFrom(approved: Response, withCookie = true) {
  const state = new URL(approved.headers.get('Location')!).searchParams.get('state')!;
  const cookie = approved.headers.getSetCookie().find((c) => c.startsWith('__Host-OAUTH_STATE='))!;
  return SELF.fetch(`${BASE}/callback?code=upstream-code&state=${encodeURIComponent(state)}`, {
    redirect: 'manual',
    headers: withCookie ? { Cookie: cookie.split(';')[0] } : {},
  });
}

/** 登録からアクセストークンの取得まで */
async function obtainToken(clientName = 'Claude') {
  const clientId = await register(clientName);
  const { verifier, challenge } = await pkce();
  const { res } = await approve(clientId, challenge);

  mockAccess(() => idToken());
  const callback = await callbackFrom(res);
  expect(callback.status).toBe(302);
  const back = new URL(callback.headers.get('Location')!);
  expect(`${back.origin}${back.pathname}`).toBe(REDIRECT_URI);
  expect(back.searchParams.get('state')).toBe('client-state');

  const token = await SELF.fetch(`${BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: back.searchParams.get('code')!,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
      resource: `${BASE}/mcp`,
    }),
  });
  expect(token.status).toBe(200);
  return ((await token.json()) as { access_token: string }).access_token;
}

describe('MCP の認可', () => {
  it('トークンなしの /mcp は 401 で、認可サーバーの場所を知らせる', async () => {
    const res = await SELF.fetch(`${BASE}/mcp`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain('Bearer');

    const meta = await SELF.fetch(`${BASE}/.well-known/oauth-authorization-server`);
    expect(await meta.json()).toMatchObject({
      authorization_endpoint: `${BASE}/authorize`,
      token_endpoint: `${BASE}/token`,
      registration_endpoint: `${BASE}/register`,
    });
  });

  it('でたらめなトークンでは /mcp を呼べない', async () => {
    const res = await SELF.fetch(`${BASE}/mcp`, {
      method: 'POST', headers: { Authorization: 'Bearer not-a-real-token' }, body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('承認の画面にクライアントの名前を出し、承認すると Access のログインへ進む', async () => {
    const clientId = await register('<b>Claude</b>');
    const { html, res } = await approve(clientId, (await pkce()).challenge);
    // クライアントが登録した名前は、エスケープして表示する
    expect(html).toContain('&lt;b&gt;Claude&lt;/b&gt;');
    expect(html).not.toContain('<b>Claude</b>');

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('Location')!);
    expect(`${location.origin}${location.pathname}`).toBe(config.ACCESS_AUTHORIZATION_URL);
    expect(location.searchParams.get('client_id')).toBe(config.ACCESS_CLIENT_ID);
    expect(location.searchParams.get('redirect_uri')).toBe(`${BASE}/callback`);
    expect(location.searchParams.get('code_challenge')).toBeTruthy();
  });

  it('承認のフォームは、CSRF トークンがないと受け付けない', async () => {
    const clientId = await register();
    const { form } = await approve(clientId, (await pkce()).challenge);
    const res = await SELF.fetch(`${BASE}/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
      redirect: 'manual',
    });
    expect(res.status).toBe(400);
  });

  it('フォームの認可要求を、登録していないリダイレクト先に書き換えても通らない', async () => {
    const clientId = await register();
    const { form, cookie } = await approve(clientId, (await pkce()).challenge);
    const state = JSON.parse(atob(form.get('state')!));
    state.oauthReqInfo.redirectUri = 'https://evil.example.com/steal';
    form.set('state', btoa(JSON.stringify(state)));
    const res = await SELF.fetch(`${BASE}/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: form,
      redirect: 'manual',
    });
    expect(res.status).toBe(400);
  });

  it('登録していないリダイレクト先の認可要求は断る', async () => {
    const clientId = await register();
    const res = await SELF.fetch(
      authorizeUrl(clientId, (await pkce()).challenge, 'https://evil.example.com/steal'),
      { redirect: 'manual' },
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it.each([
    ['宛先が違う ID トークン', () => idToken({}, 'another-client')],
    ['email のない ID トークン', () => idToken({ email: undefined })],
    ['署名が違う ID トークン', async () => {
      const other = await generateKeyPair('RS256');
      return new SignJWT({ email: 'kan@example.com' })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setSubject('user-1').setAudience(config.ACCESS_CLIENT_ID!).setExpirationTime('5m')
        .sign(other.privateKey);
    }],
  ])('%sでは認可を完了しない', async (_name, token) => {
    const clientId = await register();
    const { res } = await approve(clientId, (await pkce()).challenge);
    mockAccess(token);
    expect((await callbackFrom(res)).status).toBe(401);
  });

  it('承認したブラウザ以外から /callback を開いても、認可は完了しない', async () => {
    // 攻撃者が自分のクライアントで承認まで済ませ、Access のログインの URL を利用者に踏ませた場合
    const clientId = await register('Attacker');
    const { res } = await approve(clientId, (await pkce()).challenge);
    const fetchSpy = mockAccess(() => idToken());
    expect((await callbackFrom(res, false)).status).toBe(400);
    expect(fetchSpy.mock.calls.some(([input]) => String(input) === config.ACCESS_TOKEN_URL)).toBe(false);
    // state は消費されていないので、承認したブラウザからなら完了できる
    expect((await callbackFrom(res)).status).toBe(302);
  });

  it('state のない、またはでたらめな state の /callback は断る', async () => {
    expect((await SELF.fetch(`${BASE}/callback?code=x`)).status).toBe(400);
    expect((await SELF.fetch(`${BASE}/callback?code=x&state=forged.signature`)).status).toBe(400);
  });

  it('Access for SaaS の設定がそろっていなければ、認可は受け付けない', async () => {
    const res = await oauthRoutes.request('/authorize', {}, { ...env, ACCESS_CLIENT_SECRET: '' });
    expect(res.status).toBe(503);
  });

  it('認可を終えたクライアントは、発行されたトークンで /mcp のツールを呼べる', async () => {
    const accessToken = await obtainToken('Claude');
    vi.restoreAllMocks();

    const slug = 'oauth-e2e';
    const stub = env.PAGE.getByName(slug);
    await stub.createPage('OAuth のテスト');
    await stub.applyOps({ actor: 'user:a', clientId: 'c1', opId: 'seed', deltas: [createNote('n1')] });

    const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      // SELF.fetch は Host を付けない。実際のリクエストなら必ず付く
      fetch: (input, init) => {
        const request = new Request(input as string, init as RequestInit);
        request.headers.set('Host', 'localhost');
        return SELF.fetch(request);
      },
      requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(transport);
    expect((await client.listTools()).tools.length).toBeGreaterThan(5);

    const added = await client.callTool({
      name: 'add_notes',
      arguments: { page: slug, notes: [{ text: 'OAuth を通した書き込み' }] },
    });
    expect(added.isError).toBeFalsy();
    // 変更の主体は、認可したクライアントの名前から決まる
    const board = await stub.getBoardState();
    expect(board?.notes.find((n) => n.text === 'OAuth を通した書き込み')?.createdBy).toBe('agent:claude');
    await client.close();
  });
});
