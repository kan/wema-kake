import { createMiddleware } from 'hono/factory';
import { createRemoteJWKSet, type JWKSCacheInput, jwksCache, jwtVerify } from 'jose';

export type AuthEnv = {
  Bindings: Env;
  Variables: {
    /** 'user:<email>'。DO に渡す変更の主体 */
    actor: string;
    /** 認証の期限（UNIX 秒）。ローカル開発では期限がないので未設定 */
    authExpiresAt?: number;
  };
};

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

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

/** Access が付けた JWT を検証し、email と期限を返す。検証できなければ null */
async function verifyAccessJwt(token: string, teamDomain: string, aud: string) {
  try {
    const keys = remoteKeys(new URL('/cdn-cgi/access/certs', teamDomain));
    const { payload } = await jwtVerify(token, keys, {
      issuer: teamDomain,
      audience: aud,
      requiredClaims: ['exp'],
    });
    if (typeof payload.email !== 'string' || payload.email === '') return null;
    return { email: payload.email, expiresAt: payload.exp };
  } catch {
    return null;
  }
}

/**
 * Cloudflare Access の JWT（`Cf-Access-Jwt-Assertion`）を検証する。
 *
 * 画面と API は Access アプリケーションで保護する前提だが、Access の設定を誤っても
 * 未認証のリクエストを通さないよう、Worker でも検証する。email は変更の主体にも使う。
 *
 * `ACCESS_TEAM_DOMAIN` と `ACCESS_AUD` が未設定のときは、ローカル開発に限り
 * `DEV_USER_EMAIL` を使う。どちらもなければ拒否する。
 */
export const requireAccess = createMiddleware<AuthEnv>(async (c, next) => {
  const { ACCESS_TEAM_DOMAIN: teamDomain, ACCESS_AUD: aud, DEV_USER_EMAIL: devEmail } = c.env;

  if (teamDomain && aud) {
    const token = c.req.header('Cf-Access-Jwt-Assertion');
    const verified = token ? await verifyAccessJwt(token, teamDomain, aud) : null;
    if (!verified) return c.json({ error: 'unauthorized' }, 401);
    c.set('actor', `user:${verified.email}`);
    c.set('authExpiresAt', verified.expiresAt);
  } else if (devEmail && LOCAL_HOSTS.has(new URL(c.req.url).hostname)) {
    c.set('actor', `user:${devEmail}`);
  } else {
    return c.json({ error: 'authentication is not configured' }, 500);
  }
  await next();
});
