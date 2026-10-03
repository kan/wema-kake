// wrangler.jsonc の vars に書かない変数（ローカルの .dev.vars や wrangler secret に置くもの）
interface Env {
  /** ローカル開発で Access の代わりに使う email。localhost へのリクエストでだけ有効 */
  DEV_USER_EMAIL?: string;

  // MCP の認可で使う、Access for SaaS（OIDC）の設定。wrangler secret で設定する。
  // そろっていなければ、MCP の認可（/authorize と /callback）は 503 を返す
  ACCESS_CLIENT_ID?: string;
  ACCESS_CLIENT_SECRET?: string;
  ACCESS_TOKEN_URL?: string;
  ACCESS_AUTHORIZATION_URL?: string;
  ACCESS_JWKS_URL?: string;
  /** 承認済みクライアントの Cookie と、認可の state の署名に使う鍵 */
  COOKIE_ENCRYPTION_KEY?: string;
}
