import { Hono } from 'hono';
import { isValidSlug } from '../shared/slug';
import { type AuthEnv, requireAccess } from './access';
import { ACTOR_HEADER } from './page-do';

export { PageDO } from './page-do';

const app = new Hono<AuthEnv>();

// Worker に届くリクエストはすべて認証を通す（静的ファイルは Worker を通らず、Access だけで守られる）。
// 認証なしで公開するパス（/mcp と OAuth 用）を足すときは、このアプリの外に置く
app.use(requireAccess);

app.get('/api/pages/:slug', async (c) => {
  const slug = c.req.param('slug');
  if (!isValidSlug(slug)) {
    return c.json({ error: 'invalid slug' }, 400);
  }
  return c.json({ slug, ...(await c.env.PAGE.getByName(slug).getSnapshot()) });
});

app.get('/ws/:slug', async (c) => {
  const slug = c.req.param('slug');
  if (!isValidSlug(slug)) {
    return c.json({ error: 'invalid slug' }, 400);
  }
  if (c.req.header('Upgrade') !== 'websocket') {
    return c.json({ error: 'expected websocket' }, 426);
  }
  // WebSocket は同一オリジンの制約を受けず、Access の Cookie は他サイトからの接続にも付く。
  // 他サイトのページからこのボードを操作されないよう、Origin を確かめる
  const origin = c.req.header('Origin');
  if (origin && origin !== new URL(c.req.url).origin) {
    return c.json({ error: 'forbidden origin' }, 403);
  }

  // クライアントが同名のヘッダーを付けてきても、認証結果で上書きする
  const headers = new Headers(c.req.raw.headers);
  headers.set(ACTOR_HEADER, c.get('actor'));
  return c.env.PAGE.getByName(slug).fetch(new Request(c.req.raw, { headers }));
});

export default app;
