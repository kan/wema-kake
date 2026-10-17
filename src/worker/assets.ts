// 画面のアセット（ビルド済みの dist/web）を返す。`run_worker_first: true` なので、API に当たらない
// リクエストもすべて Worker に届き、ここから ASSETS バインディングへ渡す。
//
// HTML（index.html。SPA なので、/p/<slug> などにもこれが返る）には、サイトの設定を `<meta>` で
// 埋め込み、`<title>` をサイトの名前にする（src/shared/site.ts）。
import { SITE_META_NAME, type SiteConfig } from '../shared/site';
import type { WemaKakeEnv } from './config';

const escapeAttr = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** アセットを返す関数を作る。設定は変わらないので、埋め込む `<meta>` はここで 1 回だけ作る */
export function assetServer(site: SiteConfig) {
  // 画面に要る項目だけを出す（設定のほかの項目を、画面に見せない）
  const content: SiteConfig = { siteName: site.siteName, defaultLang: site.defaultLang };
  const meta = `<meta name="${SITE_META_NAME}" content="${escapeAttr(JSON.stringify(content))}">`;
  const title = { element: (el: Element) => void el.setInnerContent(site.siteName) };
  const head = { element: (el: Element) => void el.prepend(meta, { html: true }) };

  return async (request: Request, env: WemaKakeEnv): Promise<Response> => {
    // ページの読み込み（HTML を取りに来るリクエスト）は、条件付きの取得にしない。アセットの ETag は
    // ファイルの中身だけで決まるので、設定だけを変えてデプロイしたときに、304 で古い設定の HTML が
    // 使われ続ける。index.html は小さいので、毎回送る
    let forward = request;
    if (request.headers.get('Accept')?.includes('text/html')) {
      const headers = new Headers(request.headers);
      headers.delete('If-None-Match');
      headers.delete('If-Modified-Since');
      forward = new Request(request, { headers });
    }

    const res = await env.ASSETS.fetch(forward);
    if (!res.headers.get('Content-Type')?.startsWith('text/html')) return res;

    const headers = new Headers(res.headers);
    // 書き換えた本文は、元の ETag と中身が合わない
    headers.delete('ETag');
    headers.delete('Content-Length');
    return new HTMLRewriter().on('title', title).on('head', head).transform(new Response(res.body, { status: res.status, statusText: res.statusText, headers }));
  };
}
