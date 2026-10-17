// パッケージの利用側が渡す設定と、Worker が受け取るバインディング。どちらも、パッケージの
// 入口（src/index.ts）から型として公開する。**公開した後は約束になる**ので、項目を落とすことと、
// 既定の値を変えることは、破壊的変更として扱う（docs/package.md の「互換の決まり」）。
import { isLang, type Lang } from '../shared/i18n';
import { DEFAULT_SITE, type SiteConfig } from '../shared/site';
import type { PageDO } from './page-do';

/** `createWemaKake` に渡す設定。どの項目も省ける */
export interface WemaKakeConfig {
  /** 画面に出すサイトの名前（一覧の見出しと、タブの表示名）。既定は `wema-kake` */
  siteName?: string;
  /**
   * 既定の言語。その端末で選んだ言語（Cookie）も、ブラウザの言語の設定も、対応する言語に
   * 当たらないときに使う。既定は `en`
   */
  defaultLang?: Lang;
  /** リモート MCP サーバー（`/mcp`）を有効にするか。`false` なら `/mcp` は 404 を返す。既定は `true` */
  mcp?: boolean;
  /**
   * ページが 1 つもない環境で、一覧を最初に開いたときに、使い方の付箋を置いたページを作るか。
   * 既定は `true`
   */
  firstPage?: boolean;
}

/** 既定の値を埋めた設定 */
export type ResolvedConfig = SiteConfig & { mcp: boolean; firstPage: boolean };

/**
 * 既定の値を埋める。不正な値は、Worker の起動時（モジュールの読み込み時）に例外にする。
 * リクエストを受けてから気付く形にしない
 */
export function resolveConfig(config: WemaKakeConfig = {}): ResolvedConfig {
  const { siteName = DEFAULT_SITE.siteName, defaultLang = DEFAULT_SITE.defaultLang, mcp = true, firstPage = true } = config;
  if (typeof siteName !== 'string' || siteName.trim() === '') {
    throw new TypeError('wema-kake: siteName must be a non-empty string');
  }
  if (!isLang(defaultLang)) throw new TypeError(`wema-kake: unknown defaultLang: ${String(defaultLang)}`);
  // JavaScript から渡されると型の検査を通らないので、'false' のような文字列をここで断る（真として扱われる）
  for (const [key, value] of Object.entries({ mcp, firstPage })) {
    if (typeof value !== 'boolean') throw new TypeError(`wema-kake: ${key} must be a boolean`);
  }
  return { siteName, defaultLang, mcp, firstPage };
}

/**
 * Worker が受け取るバインディングと変数。**名前は固定**で、利用側の `wrangler.jsonc` に
 * この名前で書く（template/wrangler.jsonc）
 */
export interface WemaKakeEnv {
  /** ページごとの Durable Object。クラスは、利用側の入口が再 export する `PageDO` */
  PAGE: DurableObjectNamespace<PageDO>;
  /** 横断索引（ページの一覧、全文検索、リンク）。スキーマはパッケージの `migrations/` */
  DB: D1Database;
  /** 付箋に貼った画像 */
  IMAGES: R2Bucket;
  /** 画面のビルド済みのアセット（`assets.binding`） */
  ASSETS: Fetcher;
  /** Cloudflare Access のチームドメイン（`https://<team>.cloudflareaccess.com`） */
  ACCESS_TEAM_DOMAIN?: string;
  /** Access アプリケーションの AUD タグ */
  ACCESS_AUD?: string;
  /** このサイトのオリジン。付箋内の絶対 URL のリンクを、ページ間リンクとして拾うのに使う */
  SITE_ORIGIN?: string;
  /** ローカル開発で Access の代わりに使う email。ローカルのホスト名へのリクエストでだけ有効 */
  DEV_USER_EMAIL?: string;
}
