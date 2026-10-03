// wrangler.jsonc の vars に書かない（ローカルの .dev.vars にだけ置く）変数
interface Env {
  /** ローカル開発で Access の代わりに使う email。localhost へのリクエストでだけ有効 */
  DEV_USER_EMAIL?: string;
}
