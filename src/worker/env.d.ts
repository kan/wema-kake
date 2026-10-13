// wrangler.jsonc の vars に書かない変数（ローカルの .dev.vars や wrangler secret に置くもの）
interface Env {
  /** ローカル開発で Access の代わりに使う email。ローカルのホスト名へのリクエストでだけ有効 */
  DEV_USER_EMAIL?: string;
}
