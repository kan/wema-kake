import { Hono } from 'hono';
import { type AuthEnv, requireAccess } from './access';
import { images } from './images';
import { handleMcp } from './mcp/server';
import { ACTOR_HEADER, AUTH_EXPIRES_HEADER } from './page-do';
import { pagesApi, validSlug } from './pages-api';

export { PageDO } from './page-do';

export const app = new Hono<AuthEnv>();

// このアプリに届くリクエストはすべて認証を通す（静的ファイルは Worker を通らず、Access だけで守られる）。
// `/mcp` は MCP のクライアント（agent）だけ、それ以外は Access にログインした人だけを通す。
//
// MCP のクライアントは、Access の Managed OAuth で認可される。クライアントの登録、認可の画面、
// トークンの発行は Access が行い、Worker には届かない。
// **`/mcp` は、下の `app.use(requireAccess('user'))` より前に置くこと。** ハンドラが応答を返すので、
// 人向けの認証には進まない。後ろに置くと、agent が人向けの認証で断られる
app.all('/mcp', requireAccess('agent'), (c) =>
  handleMcp(c.req.raw, c.env, c.executionCtx as ExecutionContext, c.get('actor')),
);

app.use(requireAccess('user'));

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
