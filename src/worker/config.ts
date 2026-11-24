// パッケージの利用側が渡す設定と、Worker が受け取るバインディング。どちらも、パッケージの
// 入口（src/index.ts）から型として公開する。**公開した後は約束になる**ので、項目を落とすことと、
// 既定の値を変えることは、破壊的変更として扱う（docs/package.md の「互換の決まり」）。
import { isLang, type Lang } from '../shared/i18n';
import { agentName } from './access';
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
  /**
   * リモート MCP サーバー（`/mcp`）。既定は `true`
   *
   * - `true`: どのクライアントも、すべてのツールを使える
   * - `false`: `/mcp` は 404 を返す
   * - `{ write: false }`: どのクライアントも、読み取りのツールだけを使える
   * - `{ write: ['localhost'] }`: 並べたクライアントだけが書き込みのツールも使え、ほかは読み取りだけ。
   *   名前は、変更の主体（`agent:<名前>`）の名前。認可のリダイレクト先のホスト名で、claude.ai なら
   *   `claude.ai`、手元のクライアントは `localhost`、ローカル開発（Access なし）は `local`
   */
  mcp?: boolean | McpConfig;
  /**
   * ページが 1 つもない環境で、一覧を最初に開いたときに、使い方の付箋を置いたページを作るか。
   * 既定は `true`
   */
  firstPage?: boolean;
  /**
   * 管理者の email の一覧。MCP（`/mcp`）のコネクタを使えるのは、管理者が認可したものだけになる
   * （JWT の `email` で判定する。英字の大文字と小文字は区別しない）。
   * 省くと、Access を通ったすべての人を管理者として扱う（これまでの動き）。空の配列なら、管理者はいない
   */
  admins?: readonly string[];
  /**
   * 初めて来た人を承認待ちにし、管理者が承認するまで使わせないか。既定は `false`（Access を
   * 通った人は、そのまま使える）。`true` にするときは `admins` が要る（承認する人がいないため）。
   * 有効にすると、それまで使っていた人も承認待ちになる。管理者が「利用者」の画面で承認する
   */
  approval?: boolean;
}

/** `mcp` を有効にするときの設定 */
export interface McpConfig {
  /** 書き込みのツールを使えるクライアント。`true` ならすべて、`false` ならどれも使えない */
  write: boolean | readonly string[];
}

/** 既定の値を埋めた設定。`mcp` は、無効なら `false` */
export type ResolvedConfig = SiteConfig & {
  mcp: false | McpConfig;
  firstPage: boolean;
  /** 管理者の email（小文字にしたもの）。null なら、全員が管理者 */
  admins: ReadonlySet<string> | null;
  /** 初めて来た人を承認待ちにするか */
  approval: boolean;
};

function resolveAdmins(admins: unknown): ReadonlySet<string> | null {
  if (admins === undefined) return null;
  if (!Array.isArray(admins)) throw new TypeError('wema-kake: admins must be an array of emails');
  for (const email of admins) {
    // 主体の形（`user:a@example.com`）で書くと、どの email にも当たらず、黙って誰も管理者でなくなる
    if (typeof email !== 'string' || !/^[^\s@:]+@[^\s@:]+$/.test(email)) {
      throw new TypeError(`wema-kake: admins: not an email: ${String(email)}`);
    }
  }
  return new Set(admins.map((email: string) => email.toLowerCase()));
}

/** `email` の人が管理者か。email が分からなければ、管理者ではない */
export function isAdmin(config: Pick<ResolvedConfig, 'admins'>, email: string | undefined): boolean {
  if (config.admins === null) return true;
  return email !== undefined && config.admins.has(email.toLowerCase());
}

function resolveMcp(mcp: unknown): false | McpConfig {
  if (mcp === false) return false;
  if (mcp === true) return { write: true };
  // JavaScript から渡されると型の検査を通らないので、'false' のような文字列をここで断る（真として扱われる）
  if (typeof mcp !== 'object' || mcp === null) throw new TypeError('wema-kake: mcp must be a boolean or { write }');
  const { write } = mcp as { write?: unknown };
  if (typeof write === 'boolean') return { write };
  if (!Array.isArray(write)) throw new TypeError('wema-kake: mcp.write must be a boolean or an array of client names');
  for (const name of write) {
    // `agent:claude.ai` や `https://claude.ai` と書くと、どの主体にも当たらず、黙って読み取りだけになる
    if (typeof name !== 'string' || name === '' || agentName(name) !== name) {
      throw new TypeError(`wema-kake: mcp.write: not a client name (e.g. 'claude.ai'): ${String(name)}`);
    }
  }
  return { write: [...write] };
}

/** 主体（`agent:<名前>`）が、書き込みのツールを使えるか */
export function canWrite(mcp: McpConfig, actor: string): boolean {
  if (typeof mcp.write === 'boolean') return mcp.write;
  return mcp.write.some((name) => actor === `agent:${name}`);
}

/**
 * 既定の値を埋める。不正な値は、Worker の起動時（モジュールの読み込み時）に例外にする。
 * リクエストを受けてから気付く形にしない
 */
export function resolveConfig(config: WemaKakeConfig = {}): ResolvedConfig {
  const {
    siteName = DEFAULT_SITE.siteName,
    defaultLang = DEFAULT_SITE.defaultLang,
    mcp = true,
    firstPage = true,
    admins,
    approval = false,
  } = config;
  if (typeof siteName !== 'string' || siteName.trim() === '') {
    throw new TypeError('wema-kake: siteName must be a non-empty string');
  }
  if (!isLang(defaultLang)) throw new TypeError(`wema-kake: unknown defaultLang: ${String(defaultLang)}`);
  // JavaScript から渡されると型の検査を通らないので、0 のような値をここで断る
  if (typeof firstPage !== 'boolean') throw new TypeError('wema-kake: firstPage must be a boolean');
  if (typeof approval !== 'boolean') throw new TypeError('wema-kake: approval must be a boolean');
  const resolvedAdmins = resolveAdmins(admins);
  // admins を省くと全員が管理者になり、承認待ちの人がいなくなる。空の配列では、承認できる人がいない。
  // どちらも、承認を有効にしたつもりで効いていない設定なので、起動の時点で知らせる
  if (approval && (resolvedAdmins === null || resolvedAdmins.size === 0)) {
    throw new TypeError('wema-kake: approval requires at least one email in admins');
  }
  return { siteName, defaultLang, mcp: resolveMcp(mcp), firstPage, admins: resolvedAdmins, approval };
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
