import { createMiddleware } from 'hono/factory';
import { createRemoteJWKSet, type JWKSCacheInput, jwksCache, jwtVerify } from 'jose';

export type AuthEnv = {
  Bindings: Env;
  Variables: {
    /** 'user:<email>'。DO に渡す変更の主体 */
    actor: string;
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

/** Access が付けた JWT を検証し、email を返す。検証できなければ null */
async function emailFromAccessJwt(token: string, teamDomain: string, aud: string) {
  try {
    const keys = remoteKeys(new URL('/cdn-cgi/access/certs', teamDomain));
    const { payload } = await jwtVerify(token, keys, { issuer: teamDomain, audience: aud });
    return typeof payload.email === 'string' && payload.email !== '' ? payload.email : null;
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

  let email: string | null = null;
  if (teamDomain && aud) {
    const token = c.req.header('Cf-Access-Jwt-Assertion');
    if (token) email = await emailFromAccessJwt(token, teamDomain, aud);
    if (!email) return c.json({ error: 'unauthorized' }, 401);
  } else if (devEmail && LOCAL_HOSTS.has(new URL(c.req.url).hostname)) {
    email = devEmail;
  } else {
    return c.json({ error: 'authentication is not configured' }, 500);
  }

  c.set('actor', `user:${email}`);
  await next();
});
