import { Hono, type HonoRequest } from 'hono';
import { type AuthEnv, requireAccess } from './access';
import { assetServer } from './assets';
import { canWrite, isAdmin, resolveConfig, type WemaKakeConfig } from './config';
import { images } from './images';
import { handleMcp } from './mcp/server';
import { ACTOR_HEADER, APPROVAL_CHECK_HEADER, AUTH_EXPIRES_HEADER } from './page-do';
import { pagesApi, validSlug } from './pages-api';
import { profilesApi } from './profiles-api';
import { approvalOfRequest, requireApproval, session, usersApi } from './users-api';

/**
 * ページの中身、画像、WebSocket を返すパス。承認の関所を掛け、どのルートにも合わなければ、画面ではなく
 * JSON の 404 にする
 */
const DATA_PATHS = ['/api/*', '/ws/*', '/img/*'];

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
      async (c) => {
        // コネクタを導入できるのは管理者だけ。OAuth のクライアントの登録と認可は Access が受けるので
        // 止められないが、管理者でない人が認可した agent は、ここでツールを使えなくなる
        const email = c.get('email');
        if (!isAdmin(config, email)) return c.json({ error: 'only administrators can use MCP' }, 403);
        const actor = c.get('actor');
        // 委任者は、人の主体と同じ形（`user:<email>`）で記録する
        return handleMcp(c.req.raw, c.env, { actor, delegate: `user:${email}` }, canWrite(mcp, actor));
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

  // 認証が有効かと、承認の状態を返す。**承認の関所より前に置くこと**（承認待ちの人が、自分の状態を
  // 読めるようにする）。ハンドラが応答を返すので、後ろの関所には進まない
  app.get('/api/session', session);
  // 承認（設定の `approval`）。承認済みでない人は、ページの中身、画像、WebSocket に届かない。
  // 画面のアセットには掛けない（承認待ちの表示を出すため。HTML には、下で状態を埋め込む）
  for (const path of DATA_PATHS) app.use(path, requireApproval);

  app.route('/api/users', usersApi);
  app.route('/api', profilesApi);
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
    // 承認が有効なら、DO が接続の間も承認の状態を確かめ直す（取り消された人の接続を切る）。
    // 管理者は、表の状態にかかわらず承認済みなので、確かめない
    if (config.approval && !isAdmin(config, c.get('email'))) headers.set(APPROVAL_CHECK_HEADER, c.get('email'));
    else headers.delete(APPROVAL_CHECK_HEADER);
    return c.env.PAGE.getByName(c.req.param('slug')).fetch(new Request(c.req.raw, { headers }));
  });

  // API のパスで、上のどのルートにも合わなかったもの。画面（index.html）ではなく JSON の 404 にする。
  // **API のパスの最初の部分を足したら、`DATA_PATHS` に足す**（足さないと、そのパスの「ない」が画面の 200 に
  // なり、承認の関所も掛からない）
  for (const path of [...DATA_PATHS, '/mcp', '/mcp/*']) app.all(path, (c) => c.notFound());

  // 残りの GET と HEAD は、画面のアセット（`run_worker_first: true` なので、静的ファイルの要求もここに来る）
  // 承認が有効なら、ページの読み込み（HTML）に、承認の状態を埋め込む。画面は、承認済みでなければ
  // 承認待ちの表示だけを出す。スクリプトや画像のアセットの要求では、D1 を読まない
  app.on(['GET', 'HEAD'], '*', async (c) => {
    const approval = c.req.header('Accept')?.includes('text/html') ? await approvalOfRequest(c) : undefined;
    return serveAsset(c.req.raw, c.env, approval === 'approved' ? undefined : approval);
  });

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
