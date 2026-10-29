# パッケージの境界と互換の決まり

wema-kake は npm のパッケージ `@kanf/wema-kake` で、デプロイ物ではない。利用側は、雛形（`template/`）から自分のリポジトリを作り、自分の Worker としてデプロイする（issue #17）。

この文書は、パッケージが利用側に約束するものと、それを変えるときの決まりを書く。公開（npm への publish、版の付け方、リリースノート）は別の issue で扱う。

## 持ち物の分担

| 持つ側 | 持つもの |
| --- | --- |
| wema-kake（パッケージ） | Worker の処理（API、WebSocket、MCP、Access の検証、画面のアセットの配信）、`PageDO`、D1 のマイグレーション（`migrations/`）、ビルド済みの画面（`dist/web`）、雛形（`template/`）と、雛形を書き出すコマンド（`bin/wema-kake.mjs`） |
| 利用側 | 入口の `src/index.ts`、設定の `src/config.ts`、`wrangler.jsonc`（Worker の名前、バインディング、デプロイ先ごとの値）、`package.json` |

- 利用側の `wrangler.jsonc` は、パッケージの中を直接指す。D1 のマイグレーションは `migrations_dir` で `node_modules/@kanf/wema-kake/migrations` を、画面は `assets.directory` で `node_modules/@kanf/wema-kake/dist/web` を指す。どちらもコピーしないので、利用側の更新は `npm update` と `npm run deploy`（マイグレーションを当ててからデプロイ）で済む
- `run_worker_first` は `true`。すべてのリクエストを Worker が受け、API に当たらないものを `ASSETS` から返す。API のパスの一覧はパッケージが持つので、パスを足しても、利用側の設定は変わらない
- 画面のアセットも、Worker の認証（`requireAccess('user')`）を通してから返す。利用側が Access を設定するまで、画面も 500 を返す

## 入口（`src/index.ts`）

**ここが境界。** ここから export したものだけが、利用側から読まれる前提にする。ほかのモジュール（`src/worker/*`、`src/shared/*`）は、利用側から読まれない前提で動かせる。`package.json` の `exports` も `.`（`dist/lib/index.js`）と `./package.json` だけを出す。

| 名前 | 種類 | 内容 |
| --- | --- | --- |
| `createWemaKake(config?)` | 関数 | Worker の入口（`ExportedHandler<WemaKakeEnv>`）を返す。利用側は `export default` にする。設定の不正は、ここで例外にする（Worker の起動時に落ちる） |
| `PageDO` | クラス | ページごとの Durable Object。利用側の入口が、この名前で再 export する |
| `WemaKakeConfig` | 型 | 設定（下の表） |
| `WemaKakeEnv` | 型 | Worker が受け取るバインディングと変数（下の表） |
| `Lang` | 型 | 言語（`'ja' \| 'en'`） |

利用側の入口は、次の形になる。

```ts
import { createWemaKake, PageDO } from '@kanf/wema-kake';
import config from './config';

export { PageDO };
export default createWemaKake(config);
```

`createWemaKake` が返すのは `fetch` だけを持つオブジェクトで、Hono のアプリは返さない（Hono を約束に入れない）。

### 設定（`WemaKakeConfig`）

コードに書く設定。どの項目も省ける。

| 項目 | 既定 | 内容 |
| --- | --- | --- |
| `siteName` | `'wema-kake'` | 画面に出すサイトの名前（一覧の見出しと、タブの表示名）。空の文字列は例外 |
| `defaultLang` | `'en'` | 既定の言語。その端末で選んだ言語（Cookie）も、ブラウザの言語の設定も、対応する言語に当たらないときに使う。画面の言語と、最初のページの言語の両方に効く |
| `mcp` | `true` | `false` なら `/mcp` は 404 を返す。`{ write: false }` なら、どのクライアントも読み取りのツールだけを使える。`{ write: ['claude.ai'] }` なら、並べたクライアントだけが書き込みのツールも使える。名前は変更の主体（`agent:<名前>`）の名前で、主体の名前の形でない値は例外 |
| `firstPage` | `true` | ページが 1 つもないときに、使い方の付箋を置いたページを 1 回だけ作るか |

画面が使う値（`siteName` と `defaultLang`）は、Worker が `index.html` に `<meta name="wema-kake-site">` で埋め込む（`src/worker/assets.ts`、`src/shared/site.ts`）。画面の言語はスクリプトの読み込み時に同期で決めるので、API で問い合わせる形にしていない。HTML の読み込みは条件付きの取得にしない（設定だけを変えたデプロイで、304 から古い設定が使われないように）。

### バインディングと変数（`WemaKakeEnv`）

**名前は固定**で、利用側の `wrangler.jsonc` にこの名前で書く。

| 名前 | 種類 | 内容 |
| --- | --- | --- |
| `PAGE` | Durable Object | クラスは `PageDO` |
| `DB` | D1 | 横断索引。スキーマは `migrations/` |
| `IMAGES` | R2 | 付箋に貼った画像 |
| `ASSETS` | Assets | 画面（`assets.binding`） |
| `ACCESS_TEAM_DOMAIN` | 変数 | Access のチームドメイン |
| `ACCESS_AUD` | 変数 | Access アプリケーションの AUD タグ |
| `SITE_ORIGIN` | 変数 | このサイトのオリジン。付箋の中の絶対 URL のリンクを、ページ間のリンクとして拾う |
| `DEV_USER_EMAIL` | 変数（`.dev.vars`） | ローカル開発で Access の代わりに使う email |

デプロイ先ごとの値（Access、`SITE_ORIGIN`）は、設定（`config.ts`）ではなく `vars` で受ける。コードを変えずに、デプロイ先だけを差し替えられるようにするため。

## 互換の決まり

公開の後は、他人の本番のデータに当たる。次のどれかを壊す変更を、**破壊的変更**と呼ぶ。

1. 保存してあるデータ（DO の SQLite、D1、R2）を、新しい版が読めなくなる。古い版に戻すと、新しい版が書いたデータを読めなくなる
2. 利用側の `wrangler.jsonc`、`src/index.ts`、`src/config.ts` に、変更が要る（バインディングの名前、クラス名、DO の `migrations` の tag、`migrations_dir` と `assets.directory` の場所を含む）
3. 入口（`src/index.ts`）から export しているものの名前、引数、型、設定の項目と既定の値
4. URL（`/p/<slug>`、`/img/...`、`/mcp`、HTTP API のパス）
5. MCP のツールの名前と引数。LLM の側の設定（コネクタ、定期タスクの指示）に残るので、公開 API として扱う。足すのはよいが、名前を変える、引数を必須にする、引数を落とすのは破壊的変更

### D1 のマイグレーション

- **追加のみで書く。** リリースに入ったマイグレーションは書き換えない
- 利用側のデプロイは「マイグレーションが先、Worker が後」なので、古いコードが新しいスキーマの上で動く時間がある。**列や表を落とすとき、名前を変えるときは、2 回のリリースに分ける**（1 回目で使うのをやめ、2 回目で落とす）
- 新しい列は、古いコードが書き込んでも通るように、`NULL` を許すか既定の値を付ける

### DO の中のスキーマ

ページごとの DO の SQLite は、D1 のように一括では流せない。`page-do.ts` の `MIGRATIONS`（添字 + 1 がバージョン）を、DO が起動したときに、`meta` の `version` から先の分だけ当てる。

- **版を飛ばして上げられる。** 未適用の分を、まとめて順に当てる。`MIGRATIONS` の要素は書き換えず、末尾に足す（D1 と同じく、追加のみ）
- **上げる途中で失敗したら、何も変わらない。** 当てる処理は 1 つの `transactionSync` の中にあり、`version` の更新も同じトランザクションに入っている。失敗すると例外がそのまま DO の起動の失敗になり、そのページは開けない。次に起動したときに、同じところからやり直す
- 開かれないページは古いスキーマのまま残る。**古いバージョンのスキーマを前提にした処理（読み替え）を消さない**、あるいは消す前に全ページを上げる手段を用意する
- デプロイを戻すと、新しい版で上げた DO を、古い版の Worker が開く。古い版は、`version` の値が自分の知る数より大きければ何もしない。知らない列は無視される。列を落とす変更は、D1 と同じく 2 回に分ける

### 同期のプロトコル（WebSocket）

デプロイの直後は、古い画面を開いたままのタブが、新しい Worker につながる。今は、画面と Worker の版の照合をしていない。代わりに、次を守る。

- メッセージと項目は**足すだけ**にする。受ける側は、知らない項目を無視し、欠けた項目を許す（例: `snapshot` の `info` がない古い Worker には、画面が `msg.info ?? {}` で備えている）
- 意味を変える、項目を落とす、必須にする変更が要るときは、版を伝えて合わなければ再読み込みさせる仕組みを先に入れる（未実装。要るときが来たら issue にする）

### バインディングと設定の型

- バインディングの名前、`PageDO` のクラス名、DO の `migrations` の tag（`v1`）は、利用側の `wrangler.jsonc` に書かれる。変えると、利用側の手作業が要る。とくにクラス名と tag は、変えると保存してあるページに届かなくなる
- 設定の項目は、足すのはよい（省いたときの値で今の動きを保つこと）。落とす、既定の値を変える、必須にするのは破壊的変更

## 認証の差し替え

認証は Cloudflare Access に任せ、Worker は Access の JWT を検証する（`src/worker/access.ts` の `authenticate`）。この処理は、入口から差し替えられる形にしていない。Access なしの認証（管理用のパスワードなど）を持つと決めたときに、設定の項目として足す（足すだけなので、破壊的変更にはならない）。
