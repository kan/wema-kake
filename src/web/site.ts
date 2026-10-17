// サイトの設定。Worker が index.html に埋め込んだ `<meta>` から、読み込み時に 1 回だけ読む
// （src/shared/site.ts）。ブラウザの外（テスト）や、`<meta>` がないときは既定の値にする
import { parseSiteConfig, SITE_META_NAME, type SiteConfig } from '../shared/site';

// i18n と同じく、テスト（Workers のランタイム。DOM の型もない）からも読まれるので、自前の型で受ける
const browser = (
  globalThis as { document?: { querySelector(selector: string): { getAttribute(name: string): string | null } | null } }
).document;

export const site: SiteConfig = parseSiteConfig(
  browser?.querySelector(`meta[name="${SITE_META_NAME}"]`)?.getAttribute('content'),
);
