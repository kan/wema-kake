// パッケージ（@kanf/wema-kake）の入口。**ここが境界**で、ここから export したものだけが、
// 利用側から読まれる前提にする。載せたものを変えるときは、破壊的変更かどうかを
// docs/package.md の「互換の決まり」で確かめる。
//
// 利用側の入口（template/src/index.ts）は、次の形になる。
//
//   import { createWemaKake, PageDO } from '@kanf/wema-kake';
//   import config from './config';
//
//   export { PageDO };
//   export default createWemaKake(config);
import type { WemaKakeConfig, WemaKakeEnv } from './worker/config';
import { createApp } from './worker/index';

export type { Lang } from './shared/i18n';
export type { WemaKakeConfig, WemaKakeEnv } from './worker/config';
/**
 * ページごとの Durable Object。**利用側の Worker の入口から、この名前で再 export すること**
 * （Durable Object のクラスは、Worker の入口から export されている必要がある）。
 * クラス名は、利用側の `wrangler.jsonc`（`durable_objects` と `migrations`）にも書かれる
 */
export { PageDO } from './worker/page-do';

/**
 * Worker の入口（`export default` にするもの）を作る。設定の不正は、ここで例外にする
 */
export function createWemaKake(config: WemaKakeConfig = {}): ExportedHandler<WemaKakeEnv> {
  const app = createApp(config);
  return { fetch: (request, env, ctx) => app.fetch(request, env, ctx) };
}
