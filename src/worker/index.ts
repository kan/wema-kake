import { Hono } from 'hono';
import { type AuthEnv, requireAccess } from './access';
import { images } from './images';
import { ACTOR_HEADER, AUTH_EXPIRES_HEADER } from './page-do';
import { pagesApi, validSlug } from './pages-api';

export { PageDO } from './page-do';

const app = new Hono<AuthEnv>();

// Worker に届くリクエストはすべて認証を通す（静的ファイルは Worker を通らず、Access だけで守られる）。
// 認証なしで公開するパス（/mcp と OAuth 用）を足すときは、このアプリの外に置く
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

export default app;
