// MCP のクライアント（claude.ai / ChatGPT のコネクタ）を認可するための画面と、Cloudflare Access
// （Access for SaaS、OIDC）へのログインの中継。Cloudflare 公式のサンプル
// cloudflare/ai の demos/remote-mcp-cf-access の access-handler.ts を元にしている。
//
// 流れ:
//   1. GET  /authorize  クライアントの認可要求。承認の画面を出す（承認済みのクライアントなら省く）
//   2. POST /authorize  承認。Access のログインへリダイレクトする
//   3. GET  /callback   Access から戻る。ID トークンを検証し、クライアントへ認可コードを返す
//
// これらのパスは Access の保護対象から外してある（コネクタのサーバーから届くため）。
import type { AuthRequest, OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { Hono } from 'hono';
import { deleteCookie, generateCookie, getCookie } from 'hono/cookie';
import { jwtVerify } from 'jose';
import { remoteKeys } from '../access';
import {
  addApprovedClient,
  createOAuthState,
  fetchUpstreamAuthToken,
  generateCSRFProtection,
  getUpstreamAuthorizeUrl,
  isClientApproved,
  OAuthError,
  renderApprovalDialog,
  validateCSRFToken,
  validateOAuthState,
} from './workers-oauth-utils';

type OAuthEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

/** 認可のときに保存し、`/mcp` のハンドラに渡る値 */
export interface McpProps extends Record<string, unknown> {
  /** 認可した人（Access でログインした人）の email。誰の認可かを後から確かめるための記録 */
  email: string;
  /** クライアントの名前（claude.ai など）。変更の主体（agent:<client>）に使う */
  client: string;
}

/** Access for SaaS の設定（wrangler secret）。そろっていなければ、認可は受け付けない */
function accessConfig(env: Env) {
  const {
    ACCESS_CLIENT_ID: clientId,
    ACCESS_CLIENT_SECRET: clientSecret,
    ACCESS_TOKEN_URL: tokenUrl,
    ACCESS_AUTHORIZATION_URL: authorizationUrl,
    ACCESS_JWKS_URL: jwksUrl,
    COOKIE_ENCRYPTION_KEY: cookieKey,
  } = env;
  if (!clientId || !clientSecret || !tokenUrl || !authorizationUrl || !jwksUrl || !cookieKey) return null;
  return { clientId, clientSecret, tokenUrl, authorizationUrl, jwksUrl, cookieKey };
}

type AccessConfig = NonNullable<ReturnType<typeof accessConfig>>;

/**
 * 認可の state を、承認したブラウザに結び付ける Cookie。state は署名つきだが、それだけでは
 * 「誰のブラウザで承認したか」が分からない。攻撃者が自分のクライアントで承認まで済ませ、
 * Access のログインの URL をログイン済みの利用者に踏ませると、利用者の権限で認可が完了してしまう。
 * `/callback` で、この Cookie を持つブラウザ（= 承認したブラウザ）かを確かめる
 */
const STATE_COOKIE = '__Host-OAUTH_STATE';
/** `maxAge` は、state の有効期間（createOAuthState の既定）と同じ */
const STATE_COOKIE_OPTIONS = { httpOnly: true, secure: true, path: '/', sameSite: 'Lax', maxAge: 600 } as const;

async function stateFingerprint(stateToken: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stateToken));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function redirectToAccess(
  request: Request,
  config: AccessConfig,
  stateToken: string,
  codeChallenge: string,
  headers = new Headers(),
): Promise<Response> {
  headers.append(
    'Set-Cookie',
    generateCookie(STATE_COOKIE, await stateFingerprint(stateToken), STATE_COOKIE_OPTIONS),
  );
  headers.set(
    'Location',
    getUpstreamAuthorizeUrl({
      client_id: config.clientId,
      code_challenge: codeChallenge,
      redirect_uri: new URL('/callback', request.url).href,
      scope: 'openid email profile',
      state: stateToken,
      upstream_url: config.authorizationUrl,
    }),
  );
  return new Response(null, { status: 302, headers });
}

/**
 * 認可要求が、登録済みのクライアントのものかを確かめる。POST /authorize はフォームから
 * 認可要求を受け取るので、書き換えられていても通さないよう、ここで確かめ直す
 */
async function isRegisteredRequest(env: OAuthEnv, info: AuthRequest): Promise<boolean> {
  const client = info.clientId ? await env.OAUTH_PROVIDER.lookupClient(info.clientId) : null;
  return client !== null && client.redirectUris.includes(info.redirectUri);
}

export const oauthRoutes = new Hono<{ Bindings: OAuthEnv; Variables: { config: AccessConfig } }>();

oauthRoutes.use(async (c, next) => {
  const config = accessConfig(c.env);
  if (!config) return c.text('MCP authorization is not configured', 503);
  c.set('config', config);
  await next();
});

oauthRoutes.onError((error, c) => {
  if (error instanceof OAuthError) return error.toResponse();
  console.error('authorization failed', error);
  return c.text('Internal server error', 500);
});

oauthRoutes.get('/authorize', async (c) => {
  const config = c.get('config');
  const info = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  if (!info.clientId) return c.text('Invalid request', 400);

  // 承認済みのクライアントなら、承認の画面を省く
  if (await isClientApproved(c.req.raw, info.clientId, config.cookieKey)) {
    const { stateToken, codeChallenge } = await createOAuthState(info, c.env.OAUTH_KV, config.cookieKey);
    return redirectToAccess(c.req.raw, config, stateToken, codeChallenge);
  }

  const { token: csrfToken, setCookie } = generateCSRFProtection();
  return renderApprovalDialog(c.req.raw, {
    client: await c.env.OAUTH_PROVIDER.lookupClient(info.clientId),
    csrfToken,
    server: {
      name: 'wema-kake',
      description: '付箋ボードの Wiki。ページの付箋を読み、追加や整理を行います。',
    },
    setCookie,
    state: { oauthReqInfo: info },
  });
});

oauthRoutes.post('/authorize', async (c) => {
  const config = c.get('config');
  const form = await c.req.raw.formData();
  const { clearCookie } = validateCSRFToken(form, c.req.raw);

  let info: AuthRequest | undefined;
  try {
    info = (JSON.parse(atob(String(form.get('state')))) as { oauthReqInfo?: AuthRequest }).oauthReqInfo;
  } catch {
    // 下で 400 にする
  }
  if (!info?.clientId || !(await isRegisteredRequest(c.env, info))) {
    return c.text('Invalid request', 400);
  }

  const headers = new Headers();
  headers.append('Set-Cookie', await addApprovedClient(c.req.raw, info.clientId, config.cookieKey));
  headers.append('Set-Cookie', clearCookie);
  const { stateToken, codeChallenge } = await createOAuthState(info, c.env.OAUTH_KV, config.cookieKey);
  return redirectToAccess(c.req.raw, config, stateToken, codeChallenge, headers);
});

oauthRoutes.get('/callback', async (c) => {
  const config = c.get('config');
  // 承認したブラウザからのリクエストかを確かめる（state を消費する前に行う）
  const state = c.req.query('state');
  const bound = getCookie(c, STATE_COOKIE);
  if (!state || !bound || bound !== (await stateFingerprint(state))) {
    return c.text('Invalid or missing authorization session', 400);
  }
  // state は 1 回だけ使える。署名を確かめてから、保存しておいた認可要求を取り出す
  const { oauthReqInfo: info, codeVerifier } = await validateOAuthState(
    c.req.raw,
    c.env.OAUTH_KV,
    config.cookieKey,
  );
  if (!info.clientId) return c.text('Invalid OAuth request data', 400);

  const [, idToken, errorResponse] = await fetchUpstreamAuthToken({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code: c.req.query('code'),
    redirect_uri: new URL('/callback', c.req.url).href,
    upstream_url: config.tokenUrl,
    code_verifier: codeVerifier,
  });
  if (errorResponse) return errorResponse;

  // ID トークンの署名、期限、宛先（この Worker の client_id）を確かめる
  let claims: { sub?: string; email?: unknown; name?: unknown };
  try {
    const keys = remoteKeys(new URL(config.jwksUrl));
    claims = (await jwtVerify(idToken, keys, { audience: config.clientId, requiredClaims: ['exp', 'sub'] })).payload;
  } catch {
    return c.text('Invalid ID token', 401);
  }
  if (typeof claims.email !== 'string' || claims.email === '' || !claims.sub) {
    return c.text('Invalid ID token', 401);
  }

  const client = await c.env.OAUTH_PROVIDER.lookupClient(info.clientId);
  const props: McpProps = { email: claims.email, client: client?.clientName ?? info.clientId };
  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: info,
    userId: claims.sub,
    scope: info.scope,
    metadata: { label: typeof claims.name === 'string' ? claims.name : claims.email },
    props,
  });
  deleteCookie(c, STATE_COOKIE, { path: '/', secure: true });
  return c.redirect(redirectTo, 302);
});
