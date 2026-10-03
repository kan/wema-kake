import { type OAuthHelpers, OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { Hono } from 'hono';
import { type AuthEnv, requireAccess } from './access';
import { images } from './images';
import { oauthRoutes } from './mcp/authorize';
import { mcpHandler } from './mcp/server';
import { ACTOR_HEADER, AUTH_EXPIRES_HEADER } from './page-do';
import { pagesApi, validSlug } from './pages-api';

export { PageDO } from './page-do';

/**
 * Access で認証した人だけが使う部分（画面からの API、WebSocket、画像）。
 * 認証なしで公開するパス（/mcp と OAuth 用）は、このアプリの外に置く（下の OAuthProvider）
 */
export const app = new Hono<AuthEnv>();

// このアプリに届くリクエストはすべて認証を通す（静的ファイルは Worker を通らず、Access だけで守られる）
app.use(requireAccess);

// Access の Cookie は他サイトからのリクエストにも付く。状態を変えるリクエストと WebSocket の
// 接続要求（同一オリジンの制約を受けない）は、他のオリジンからのものを断る
app.use(async (c, next) => {
  const method = c.req.method;
  const guarded = (method !== 'GET' && method !== 'HEAD') || c.req.header('Upgrade') === 'websocket';
  const origin = c.req.header('Origin');
  if (guarded && origin && origin !== new URL(c.req.url).origin) {
    return c.json({ error: 'forbidden origin' }, 403);
  }
  await next();
});

app.route('/api', pagesApi);
app.route('/', images);

app.get('/ws/:slug', validSlug, async (c) => {
  if (c.req.header('Upgrade') !== 'websocket') {
    return c.json({ error: 'expected websocket' }, 426);
  }

  // クライアントが同名のヘッダーを付けてきても、認証結果で上書きする
  const headers = new Headers(c.req.raw.headers);
  headers.set(ACTOR_HEADER, c.get('actor'));
  const expiresAt = c.get('authExpiresAt');
  if (expiresAt === undefined) headers.delete(AUTH_EXPIRES_HEADER);
  else headers.set(AUTH_EXPIRES_HEADER, String(expiresAt));
  return c.env.PAGE.getByName(c.req.param('slug')).fetch(new Request(c.req.raw, { headers }));
});

/** Access の保護対象から外してあるパスのうち、MCP のクライアントを認可するためのもの */
const AUTHORIZATION_PATHS = new Set(['/authorize', '/callback']);

/**
 * `/mcp` は、この Worker が発行したアクセストークンで保護する（OAuth 2.1）。
 * トークンの発行（/token）、クライアントの登録（/register）、メタデータ（/.well-known/）は
 * OAuthProvider が処理する。それ以外は defaultHandler に届く。
 *
 * claude.ai / ChatGPT のコネクタは、それぞれのサーバーから接続してくる。これらのパスを
 * Access のログイン画面で塞ぐと接続できないので、Access の保護対象から外しておく
 */
function createProvider(origin: string) {
  return new OAuthProvider<Env>({
    apiRoute: '/mcp',
    apiHandler: mcpHandler,
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/token',
    clientRegistrationEndpoint: '/register',
    // MCP サーバーの正式な URL。クライアントは、これと接続先が一致することを確かめる
    resourceMetadata: { resource: `${origin}/mcp` },
    defaultHandler: {
      fetch(request: Request, env: Env, ctx: ExecutionContext) {
        const { pathname } = new URL(request.url);
        // 認可の画面は、Access for SaaS のログインで本人を確かめる。それ以外は Access の JWT を検証する。
        // OAuthProvider は、defaultHandler に渡す env に OAUTH_PROVIDER（認可の完了などの操作）を足す
        return AUTHORIZATION_PATHS.has(pathname)
          ? oauthRoutes.fetch(request, env as Env & { OAUTH_PROVIDER: OAuthHelpers }, ctx)
          : app.fetch(request, env, ctx);
      },
    },
  });
}

/** オリジンごとの OAuthProvider。設定にサイトの URL が要るので、最初のリクエストで作る */
const providers = new Map<string, ReturnType<typeof createProvider>>();

export default {
  fetch(request, env, ctx) {
    // サイトの URL は `SITE_ORIGIN` を使う。未設定なら、リクエストが届いたオリジンを使う
    const origin = env.SITE_ORIGIN || new URL(request.url).origin;
    let provider = providers.get(origin);
    if (!provider) {
      provider = createProvider(origin);
      providers.set(origin, provider);
    }
    return provider.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
