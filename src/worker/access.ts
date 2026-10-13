import { createMiddleware } from 'hono/factory';
import { createRemoteJWKSet, type JWKSCacheInput, jwksCache, jwtVerify } from 'jose';

/**
 * 入口が受け付ける主体の種類。
 * - user: Access にログインしたブラウザ（画面からの API、WebSocket、画像）
 * - agent: Access の Managed OAuth で認可された MCP のクライアント（`/mcp`）
 */
export type PrincipalKind = 'user' | 'agent';

/** リクエストを送ってきた主体。Access の認証結果から決める */
interface Principal {
  /** 'user:<email>' / 'agent:<client>'。DO に渡す変更の主体 */
  actor: string;
  /** 認証の期限（UNIX 秒）。ローカル開発では期限がないので未設定 */
  expiresAt?: number;
}

export type AuthEnv = {
  Bindings: Env;
  Variables: {
    /** `Principal` の `actor` */
    actor: string;
    /** `Principal` の `expiresAt` */
    authExpiresAt?: number;
  };
};

type AuthResult = { principal: Principal } | { status: 401 | 403 | 500; error: string };

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * ローカル開発のホスト名か。`.localhost` で終わる名前も含める（ローカルのリバースプロキシが
 * 付ける `<名前>.localhost`）。`.localhost` はループバック専用の予約名（RFC 6761）なので、
 * デプロイ先のホスト名がこれに当たることはない
 */
const isLocalHost = (hostname: string) => LOCAL_HOSTS.has(hostname) || hostname.endsWith('.localhost');

/**
 * 取得済みの公開鍵（データ）を、鍵の取得元の URL ごとに isolate 内で使い回す。
 * createRemoteJWKSet そのものはリクエストごとに作る。使い回すと取得中の Promise が
 * リクエスト間で共有され、Workers では別のリクエストが作った Promise を待つと止まることがある。
 * 鍵の期限、ローテーション時の取り直し、取り直しの間隔の制限は jose が行う。
 */
const keyCaches = new Map<string, JWKSCacheInput>();

function remoteKeys(certsUrl: URL) {
  let cache = keyCaches.get(certsUrl.href);
  if (!cache) {
    cache = {};
    keyCaches.set(certsUrl.href, cache);
  }
  return createRemoteJWKSet(certsUrl, { [jwksCache]: cache });
}

/**
 * agent の主体を、認可のリダイレクト先から決める。リダイレクト先は、Access の設定
 * （Allowed redirect URIs）で許可したものに限られるので、クライアントが申告する名前と違って偽れない。
 * `https://claude.ai/api/mcp/auth_callback` なら `agent:claude.ai`。
 *
 * 手元のクライアント（リダイレクト先が localhost やループバックのアドレス）は、どれも
 * `agent:localhost` になり、互いを区別しない。ホスト名のない独自スキーム（`com.example.app:/cb`）は、
 * スキームを名前にする
 */
export function agentActor(redirectUri: unknown): string {
  let host = '';
  try {
    const url = new URL(typeof redirectUri === 'string' ? redirectUri : '');
    host = LOCAL_HOSTS.has(url.hostname) ? 'localhost' : url.hostname || url.protocol;
  } catch {
    // 下で unknown にする
  }
  const name = host.toLowerCase().replace(/[^a-z0-9.-]+/g, '-');
  return `agent:${name.replace(/^[-.]+|[-.]+$/g, '').slice(0, 64) || 'unknown'}`;
}

/**
 * Access が付けた JWT を検証し、主体とその種類を返す。検証できなければ null。
 *
 * MCP のクライアントは、Access の Managed OAuth で認可される。そのトークンで届いたリクエストの
 * JWT には `oauth`（`client_id` と `client_redirect_uri`）が入り、ブラウザのログインでは入らない。
 * `oauth` があれば、形がどうであれ agent として扱う（人の入口を通さない）
 */
async function verifyAccessJwt(
  token: string,
  teamDomain: string,
  aud: string,
): Promise<(Principal & { kind: PrincipalKind }) | null> {
  try {
    const keys = remoteKeys(new URL('/cdn-cgi/access/certs', teamDomain));
    const { payload } = await jwtVerify(token, keys, {
      issuer: teamDomain,
      audience: aud,
      requiredClaims: ['exp'],
    });
    if (typeof payload.email !== 'string' || payload.email === '') return null;
    const { email, exp: expiresAt, oauth } = payload;
    if (oauth === undefined) return { kind: 'user', actor: `user:${email}`, expiresAt };
    const redirectUri = (oauth as { client_redirect_uri?: unknown } | null)?.client_redirect_uri;
    return { kind: 'agent', actor: agentActor(redirectUri), expiresAt };
  } catch {
    return null;
  }
}

/**
 * リクエストの主体を決める。画面からのリクエストも MCP も、ここを通す。
 *
 * Cloudflare Access の JWT（`Cf-Access-Jwt-Assertion`）を検証する。画面も `/mcp` も Access の
 * アプリケーションで保護する前提だが、Access の設定を誤っても未認証のリクエストを通さないよう、
 * Worker でも検証する。
 *
 * Access はパスを区別しないので、OAuth のトークンでも `/api` などを呼べてしまう。`kind` と
 * 合わない主体は、ここで断る。
 *
 * `ACCESS_TEAM_DOMAIN` と `ACCESS_AUD` が未設定のときは、ローカル開発に限り `DEV_USER_EMAIL` を
 * 使う。どちらもなければ拒否する。
 */
async function authenticate(request: Request, env: Env, kind: PrincipalKind): Promise<AuthResult> {
  const { ACCESS_TEAM_DOMAIN: teamDomain, ACCESS_AUD: aud, DEV_USER_EMAIL: devEmail } = env;

  if (teamDomain && aud) {
    const token = request.headers.get('Cf-Access-Jwt-Assertion');
    const verified = token ? await verifyAccessJwt(token, teamDomain, aud) : null;
    if (!verified) return { status: 401, error: 'unauthorized' };
    if (verified.kind !== kind) return { status: 403, error: 'forbidden' };
    return { principal: verified };
  }

  if (devEmail && isLocalHost(new URL(request.url).hostname)) {
    return { principal: { actor: kind === 'user' ? `user:${devEmail}` : 'agent:local' } };
  }
  return { status: 500, error: 'authentication is not configured' };
}

/**
 * `kind` の主体だけを通すミドルウェア。**入口（ルート）ごとに、どちらの種類かを宣言して掛ける。**
 * パスの文字列を見て種類を決める形にしない（ルーターはパスをデコードして照合するので、
 * `/%6dcp` のようなパスで、判定とルーティングが食い違う）
 */
export const requireAccess = (kind: PrincipalKind) =>
  createMiddleware<AuthEnv>(async (c, next) => {
    const result = await authenticate(c.req.raw, c.env, kind);
    if ('error' in result) return c.json({ error: result.error }, result.status);
    c.set('actor', result.principal.actor);
    c.set('authExpiresAt', result.principal.expiresAt);
    await next();
  });
