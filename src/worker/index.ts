import { Hono, type HonoRequest } from 'hono';
import { type AuthEnv, requireAccess } from './access';
import { assetServer } from './assets';
import { canWrite, resolveConfig, type WemaKakeConfig } from './config';
import { images } from './images';
import { handleMcp } from './mcp/server';
import { ACTOR_HEADER, AUTH_EXPIRES_HEADER } from './page-do';
import { pagesApi, validSlug } from './pages-api';

/**
 * Worker のアプリを組み立てる。パッケージの入口（src/index.ts）の `createWemaKake` が呼ぶ。
 * テストは、これを直接呼んで `app.request` を使う。設定の不正は、ここで例外にする
 */
export function createApp(options: WemaKakeConfig = {}) {
  const config = resolveConfig(options);
  const serveAsset = assetServer(config);
  const app = new Hono<AuthEnv>();

  app.use(async (c, next) => {
    c.set('config', config);
    await next();
  });

  // このアプリに届くリクエストはすべて認証を通す（画面のアセットも、末尾のルートから返すので、
  // 認証の後になる）。`/mcp` は MCP のクライアント（agent）だけ、それ以外は Access にログインした
  // 人だけを通す。
  //
  // MCP のクライアントは、Access の Managed OAuth で認可される。クライアントの登録、認可の画面、
  // トークンの発行は Access が行い、Worker には届かない。
  // **`/mcp` は、下の `app.use(requireAccess('user'))` より前に置くこと。** ハンドラが応答を返すので、
  // 人向けの認証には進まない。後ろに置くと、agent が人向けの認証で断られる
  // 無効なら、人向けの認証より前で 404 を返す（後ろに落とすと、agent のトークンが人向けの認証で 403 になる）
  //
  // MCP の仕様（Streamable HTTP）は、DNS リバインディングへの対策として、すべての要求で `Origin` を
  // 確かめることを求めている。人向けの入口と違い、メソッドを問わず、認証より前で確かめる
  const mcp = config.mcp;
  if (mcp) {
    app.all(
      '/mcp',
      (c, next) => (isForeignOrigin(c.req) ? c.json({ error: 'forbidden origin' }, 403) : next()),
      requireAccess('agent'),
      (c) => {
        const actor = c.get('actor');
        return handleMcp(c.req.raw, c.env, c.executionCtx as ExecutionContext, actor, canWrite(mcp, actor));
      },
    );
  } else {
    app.all('/mcp', (c) => c.notFound());
  }

  app.use(requireAccess('user'));

  // Access の Cookie は他サイトからのリクエストにも付く。状態を変えるリクエストと WebSocket の
  // 接続要求（同一オリジンの制約を受けない）は、他のオリジンからのものを断る
  app.use(async (c, next) => {
    const method = c.req.method;
    const guarded = (method !== 'GET' && method !== 'HEAD') || c.req.header('Upgrade') === 'websocket';
    if (guarded && isForeignOrigin(c.req)) {
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

  // API のパスで、上のどのルートにも合わなかったもの。画面（index.html）ではなく JSON の 404 にする。
  // **API のパスの最初の部分を足したら、ここにも足す**（足さないと、そのパスの「ない」が画面の 200 になる）
  for (const path of ['/api/*', '/ws/*', '/img/*', '/mcp', '/mcp/*']) app.all(path, (c) => c.notFound());

  // 残りの GET と HEAD は、画面のアセット（`run_worker_first: true` なので、静的ファイルの要求もここに来る）
  app.on(['GET', 'HEAD'], '*', (c) => serveAsset(c.req.raw, c.env));

  app.notFound((c) => c.json({ error: 'not found' }, 404));

  return app;
}

/**
 * `Origin` が付いていて、このアプリのオリジンと違うか。スキームとポートも含めて比べる。
 * `Origin` が付いていない要求（ブラウザでないクライアント）は、他のオリジンとは見なさない
 */
function isForeignOrigin(req: HonoRequest): boolean {
  const origin = req.header('Origin');
  return !!origin && origin !== new URL(req.url).origin;
}
