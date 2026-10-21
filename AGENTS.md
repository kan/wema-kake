# wema-kake

付箋ボードライブラリ [wema](https://github.com/kan/wema)（npm: `@kanf/wema`）を使った Wiki。
約20年前の旧 wema（付箋 UI + Ruby 製 API の Wiki クローン）のうち、Wiki として使える部分を現代の構成で作り直すもの。
名前は神社で絵馬を掛ける場所「絵馬掛（えまかけ）」から。wema が絵馬、wema-kake がそれを掛ける場所。

- 最初は個人のメモ用。最終的には複数人での同時編集を想定する
- LLM にボードを読ませ、アドバイスの付箋を貼る・付箋のつながりや分類を整理する、といった作業を claude.ai / ChatGPT の定期タスクから行わせたい。そのためにリモート MCP サーバーを提供する
- 付箋 UI は wema に任せ、このリポジトリは保存・同期・Wiki 機能・MCP を担う
- wema 側に足りない機能は wema に issue / PR を出して追加する（末尾参照）

## 技術構成

| 役割 | 採用技術 |
| --- | --- |
| 実行環境 | Cloudflare Workers（静的フロントは Workers Static Assets で同居） |
| ページの本体・同期 | Durable Objects（SQLite ストレージ、ページ 1 つ = DO 1 つ） |
| リアルタイム通信 | WebSocket（DO の Hibernation API を使う） |
| 横断索引 | D1（ページ一覧・検索・バックリンク） |
| 画像 | R2 |
| 認証 | Cloudflare Access（MCP の認可は、Access の Managed OAuth） |
| LLM 連携 | リモート MCP サーバー（Workers 上）。WebMCP は後から追加 |
| フロント | `@kanf/wema` |

役割分担の原則:

- **正のデータは DO**。付箋・接続線はページごとの DO 内 SQLite に保存する
- **D1 は索引のみ**。DO → D1 の一方向で更新し、D1 から DO へは書き戻さない
- DO → D1 の反映は書き込みごとではなく、DO の Alarm で「最後の更新から数秒後」にまとめて行う
- **変更の入口は 1 つ**。ブラウザ（WebSocket）も MCP も、DO に同じ形式のデルタを渡して同じ経路（検証 → サニタイズ → 保存 → ブロードキャスト）を通す

```
ブラウザ (wema) ──WebSocket──┐
                              ├──> Page DO (SQLite) ──Alarm──> D1 索引
MCP クライアント ──/mcp──> MCP ┘          │
 (claude.ai / ChatGPT)                     └──> 接続中のブラウザへブロードキャスト
```

## ローカルでの開発プレビュー

- roji が使える環境では、開発プレビュー（ローカルのサーバーを起動して、画面や API を確かめること）に `npm run dev:roji` を使う。**その環境では、`npm run dev` や、`wrangler dev` の直接の実行で起動しないこと**
  - 理由: `npm run dev` はポートを固定しておらず、他のプロジェクトの `wrangler dev` が動いていると、別のポートへずれる。`roji run` は空いているポートを選び、`https://wema-kake.<roji のドメイン>` という決まった URL を付ける
  - roji が使えるかは、`command -v roji` が成功し、`roji health` が「正常」を返すことで確かめる。バージョンは 1.5.0 以降（`roji version`）
  - 開く URL は、起動時に出る `roji: https://... -> localhost:<ポート>` の行で確かめる。roji のドメインは環境ごとに違うので、URL を決め打ちしない
- roji が入っていない、動いていない、または 1.5.0 より前の環境では、`npm run dev` を使う
- `dev:roji` の `wrangler dev` に渡している引数の理由と、ローカルと見なすホスト名は、下の「認証」にある

## パッケージの構成

**wema-kake は npm のパッケージ（`@kanf/wema-kake`）で、デプロイ物ではない。** 利用側が雛形（`template/`）から自分のリポジトリを作り、自分の Worker としてデプロイする（issue #17）。入口、設定の型、互換の決まりの詳細は `docs/package.md` にある。

| 場所 | 中身 |
| --- | --- |
| `src/index.ts` | パッケージの入口。**ここが境界**で、ここから export したものだけが、利用側から読まれる前提にする |
| `src/worker/config.ts` | 設定（`WemaKakeConfig`）とバインディング（`WemaKakeEnv`）の型 |
| `dev/` | このリポジトリの中の利用側。ルートの `wrangler.jsonc` の `main` がここを指し、ローカル開発とテストに使う。**`template/src/` と同じ形に保つ**（違いは `../src/index` を読むことだけ） |
| `template/` | 利用側の雛形。パッケージに入り、`npx @kanf/wema-kake init`（`bin/wema-kake.mjs`）が書き出す。Deploy to Cloudflare のボタンもここを指す |
| `dist/lib` | `npm run build:lib`（`tsc -p tsconfig.build.json`）の出力。`exports` が指す |
| `dist/web` | `npm run build:web`（vite）の出力。利用側の `assets.directory` が直接指す |

- **パッケージのコードで、グローバルの `Env` を使わない。** バインディングの型は `WemaKakeEnv`。`Env` は `wrangler types` がこのリポジトリの `wrangler.jsonc` から作る型で、`dist/lib` の `.d.ts` に残ると、利用側では別物を指す
- **バインディング、`assets`、DO の `migrations` を変えたら、`wrangler.jsonc` と `template/wrangler.jsonc` の両方を直す。** 利用側の `wrangler.jsonc` に要る変更は、破壊的変更になる（`docs/package.md` の「互換の決まり」）
- **`run_worker_first` は `true` のまま保つ。** すべてのリクエストを Worker が受け、API のどのルートにも合わない GET と HEAD を画面のアセットとして返す（`src/worker/index.ts` の末尾）。パスを足しても、利用側の設定は変わらない
  - **API のパスの最初の部分（`/api/` など）を足したら、`src/worker/index.ts` の JSON の 404 を返す一覧にも足す。** 足さないと、そのパスの「ない」が、画面の 200 になる
- **`bin/wema-kake.mjs` は、雛形の中の埋める場所を名指ししている**（`replaceOnce`）。`template/src/config.ts`、`template/wrangler.jsonc`、`template/package.json`、`template/README.md` のその行を変えたら、あちらも直す（見つからなければ init が落ちるので、黙って既定の値のまま出ることはない）
- テストは `src/` を直接読むので、`dist/lib` は要らない。`dist/web` は要る（画面のアセットを返す処理を確かめる）ので、`pretest` が `build:web` を回す
- 雛形が通るかの確かめ方: `npm pack` → 別のディレクトリで `npx --package=<tgz> wema-kake init <dir> --yes --no-install` → そこで `npm install <tgz>` → `npm run typecheck`、`npx wrangler deploy --dry-run`、`npm run dev`
- D1 と DO のスキーマ、同期のプロトコル、MCP のツールを変えるときは、`docs/package.md` の「互換の決まり」に従う。**D1 のマイグレーションと DO の `MIGRATIONS` は、追加のみで書く**

## リリース

- **npm への publish は、`v*` のタグから CI で行う**（`.github/workflows/publish.yml`。Trusted Publishing なので、token を secret に置かない）。手順は、`package.json` の `version` を上げるコミットを作り、そのコミットに `v<version>` のタグを打って push する。ワークフローが、タグと版の一致、lint、テストを見てから publish し、GitHub Release を作る
- **版を上げることと、タグを打つことは、ユーザーの承認を得てから行う**
- 版の付け方: 0.x の間は、破壊的変更（`docs/package.md` の「互換の決まり」）を minor で、それ以外を patch で上げる
- npmjs.com の Trusted Publisher の設定は、リポジトリの外にある。direct publish を許可しておく（既定のままだと `403 OIDC permission denied` で落ちる）
- publish の後に、雛形のロックを新しい版に合わせて commit する（Deploy to Cloudflare のボタンが `npm ci` で使う）。`cd template && npm install @kanf/wema-kake@latest --package-lock-only`。minor を上げたときは、`template/package.json` の範囲も上げる（`^0.1.0` は `0.2.0` を受けない）

## デプロイ

- **このリポジトリは公開している。デプロイ先ごとの値を、git に入れるファイルへ書かないこと。** 対象は、Worker の名前、ホスト名、D1 の ID、Access のチームドメインと AUD タグ、`SITE_ORIGIN`。文書（`docs/`、この `AGENTS.md`）にも、実際のホスト名や ID を書かない
- `wrangler.jsonc` は、ローカル開発とテストに使う。値は空のまま保つ
- 利用側の最初のデプロイと、Access の設定の手順は `template/README.md` にある（利用側の README になる）。つまずきやすい点もそこに書く
- **このリポジトリからはデプロイしない。** 作者の本番も、リポジトリの外にある利用側（雛形から作ったもの）が、npm に出した版を使ってデプロイする。このリポジトリで `wrangler deploy` を実行すると、`wrangler.jsonc` の名前（`wema-kake`）で、保護のない別の Worker ができる
- 本番に変更を届けるのは、版を上げて publish（上の「リリース」）→ 利用側で `npm update @kanf/wema-kake` → `npm run deploy`
- secret は使っていない（Access の設定は `vars` の 2 つだけ）

## 認証

- **画面と `/mcp` の両方を、Cloudflare Access のアプリケーション 1 つで保護する。** ホスト名全体を宛先にする。認証なしで公開するパスはない
- **MCP のクライアントは、Access の Managed OAuth で認可する。** 2026-10-13 に、Access for SaaS と `@cloudflare/workers-oauth-provider` から移した。経緯は `docs/plan.md` の「MCP の認可を Managed OAuth に移す」にある
  - クライアントの登録、同意の画面、トークンの発行と更新、`/.well-known/oauth-*` は、Access が処理する。**Worker には届かないので、Worker の側に OAuth の処理を足し直さないこと**
  - ブラウザでないクライアントが未認証で届くと、Access は 401 と `WWW-Authenticate`（`resource_metadata`）を返す。ブラウザには、これまでどおりログイン画面への転送を返す
  - Worker には、ブラウザのときと同じ `Cf-Access-Jwt-Assertion` が届く。**OAuth のトークンで届いたリクエストの JWT にだけ、`oauth`（`client_id` と `client_redirect_uri`）が入る**
  - トークンを更新するたびに、Access がポリシーを評価し直す。Access から外した人の agent は、アクセストークンの期限（既定で 15 分）で使えなくなる
  - Managed OAuth は、ダッシュボードで「Beta」と表示されている（2026-10-13 時点）。仕様が変わって MCP がつながらなくなったら、まず JWT の `oauth` の形を確かめる（確かめ方は `docs/plan.md` の同じ節）
- **Worker でも Access の JWT を検証し、主体を決める**（`src/worker/access.ts` の `authenticate`）。Access の設定を誤っても未認証のリクエストを通さないためと、変更の主体を得るため。**画面からのリクエストと MCP の両方を、この 1 つの処理に通す。** `src/worker/index.ts` で、`app` が受けるリクエストすべてを対象にしてある。**このミドルウェアを外したり、認証を掛けるパスを列挙する形に戻したりしない**
  - **Access はパスを区別しない。OAuth のトークンでも `/api` や `/ws` に届く。** 入口ごとに、受け付ける主体の種類（`PrincipalKind`）を宣言してある。`/mcp` は `requireAccess('agent')`（JWT に `oauth` がある）、それ以外は `app.use(requireAccess('user'))`（`oauth` がない）で、合わなければ 403 を返す
  - **agent 向けの入口は、`app.use(requireAccess('user'))` より前に、ルートごとに `requireAccess('agent')` を付けて置く。** それより後ろに足したルートは、人だけを通す。**種類を、パスの文字列の比較で決める形にしないこと。** Hono はパスをデコードして照合するので、`/%6dcp` のようなパスで、判定とルーティングが食い違う
  - 人の主体は `user:<email>`。agent の主体は `agent:<認可のリダイレクト先のホスト名>`（`agentActor`。claude.ai なら `agent:claude.ai`）。リダイレクト先は、Access の Allowed redirect URIs で許可したものに限られる。クライアントが登録のときに申告する名前は、JWT に入らない。手元のクライアント（リダイレクト先が localhost）は、どれも `agent:localhost` になる
  - **人と agent を分けているのは、JWT の `oauth` の有無だけ。** Access がこの項目を出さなくなると、agent が人として扱われ、`/api` などを呼べる（`/mcp` は 403 になる）。Managed OAuth の仕様の変更を知ったら、最初にここを確かめる
  - agent の JWT の `email` は、その agent を認可した人のもの（agent は、その人の代理）。今は記録していない。複数の利用者で使うようにするときに、主体に足す
  - 設定は `wrangler.jsonc` の `vars` の `ACCESS_TEAM_DOMAIN`（`https://<team>.cloudflareaccess.com`）と `ACCESS_AUD`（Access アプリケーションの AUD タグ）。両方が空なら 500 を返す
  - ローカル開発は `.dev.vars` の `DEV_USER_EMAIL` を使う（`.dev.vars.example` を参照）。`/mcp` の主体は `agent:local` になる。ローカルのホスト名（`localhost`、`127.0.0.1`、`[::1]`、`.localhost` で終わる名前）へのリクエストでだけ有効で、Access の設定があれば無視される。**ローカルと見なすホスト名を、これより広げないこと**（`src/worker/access.ts` の `isLocalHost`。`.localhost` はループバック専用の予約名なので、デプロイ先のホスト名には当たらない）
  - ローカルのリバースプロキシ [roji](https://github.com/kan/roji)（`{host}` の置き換えがある 1.5.0 以降）を使うなら `npm run dev:roji`。空いているポートで起動し、`https://wema-kake.<roji のドメイン>` で開ける。**`wrangler dev` の `--host {host} --upstream-protocol https` を外さないこと。** 外すと、Worker から見たオリジンが `http://<ホスト名>` になる。ブラウザが送る `Origin`（`https://<ホスト名>`）と合わなくなり、状態を変えるリクエストと WebSocket の接続が、オリジンの検査で 403 になる
- WebSocket の接続要求は `Origin` を確かめ、他のオリジンからの接続を断る（WebSocket は同一オリジンの制約を受けず、Access の Cookie は他サイトからの接続にも付くため）
- 主体はクライアントの自己申告を使わない。Worker が認証結果から決めて DO に渡す
- `clientId` はクライアントの自己申告なので、**同じ送信元かどうかの判定（再送の判定、`fixups` の宛先）には主体も合わせて使う**
- WebSocket は開いたままになるので、接続時の JWT の期限（`exp`）を接続ごとに持つ。期限を過ぎた接続は、受信も配信もせずにコード 4401 で閉じる。クライアントは再読み込みして認証し直す

## DO 内スキーマ（ページ単位）

```sql
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,   -- 'slug', 'title', 'color'（ページの色）, 'seq', 'version', 'epoch', 'index_hash', 'parent'（親ページのスラッグ）
  value TEXT NOT NULL
);

CREATE TABLE notes (
  id         TEXT PRIMARY KEY,       -- ブラウザでは wema が crypto.randomUUID()、MCP ではサーバーが採番
  x REAL NOT NULL, y REAL NOT NULL,
  width REAL NOT NULL, height REAL NOT NULL,
  text       TEXT NOT NULL,          -- サーバー側でサニタイズ済みの HTML
  color      TEXT NOT NULL,
  z_index    INTEGER NOT NULL,       -- 作成時の値のみ。以降の変更は同期しない（後述）
  auto_size  INTEGER NOT NULL DEFAULT 0,
  foldable   INTEGER NOT NULL DEFAULT 0,  -- 長い本文を畳んで表示する（wema 0.9.0）。開いているかどうかは保存しない
  extra      TEXT,                   -- 付箋の meta（利用側のデータ）の JSON。なければ NULL
  created_by TEXT,                   -- 'user:<id>' / 'agent:<client>'
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

CREATE TABLE edges (
  id         TEXT PRIMARY KEY,
  from_id    TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  to_id      TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  props      TEXT NOT NULL,          -- anchor / style / lineStyle / arrowHead / label / collapsed 等の JSON
  created_by TEXT,
  updated_at INTEGER NOT NULL
);

CREATE INDEX edges_from ON edges (from_id);
CREATE INDEX edges_to ON edges (to_id);

CREATE TABLE ops (
  seq         INTEGER PRIMARY KEY,   -- ボード全体の通番
  actor       TEXT NOT NULL,         -- 'user:<id>' / 'agent:<client>'
  client_id   TEXT NOT NULL,
  op_id       TEXT NOT NULL,
  summary     TEXT,                  -- MCP の場合、ツール名や LLM が付けた説明
  reverts     INTEGER,               -- この操作が取り消しなら、取り消した対象の seq
  reverted_by INTEGER,               -- この操作を取り消した操作の seq
  created_at  INTEGER NOT NULL,
  -- 大きくなる列は最後に置く（一覧などで手前の列だけを読むときに、中身まで読まずに済む）
  body        TEXT NOT NULL,         -- 適用したデルタ配列の JSON（before/after を含む）
  fixups      TEXT                   -- 送信元だけが適用するデルタ配列の JSON（同じ op_id の再送で返す）
);

CREATE INDEX ops_reverted_by ON ops (reverted_by) WHERE reverted_by IS NOT NULL;
CREATE UNIQUE INDEX ops_client_op ON ops (actor, client_id, op_id);
```

- `ops` は再接続時の差分送信・履歴表示・取り消し（後述）に使う。件数か日数で古いものを間引くが、agent の操作は取り消し可能期間のあいだ残す
- 付箋削除時の接続線は wema 側でも `edge:delete` として送られてくる。CASCADE は保険。DO の SQLite は外部キー制約が既定で有効（公式ドキュメントに記述がないので `test/runtime.test.ts` で固定している）
- トランザクションは `ctx.storage.transactionSync()` を使う（`sql.exec()` で `BEGIN` は実行できない）。コールバックは同期でなければならないので、サニタイズ（非同期）はトランザクションの前に済ませる

## D1 スキーマ（横断索引）

```sql
CREATE TABLE pages (
  id         INTEGER PRIMARY KEY, -- pages_fts の rowid と対応させる
  name       TEXT NOT NULL UNIQUE, -- スラッグ
  title      TEXT,                -- 表示名。未設定ならスラッグを表示する
  plain_text TEXT,                -- 全付箋のテキストをタグ除去して連結したもの
  note_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  parent     TEXT,                -- 親ページのスラッグ。ルートのページなら NULL（正は、子ページの DO の meta）
  layout     TEXT,                -- 付箋の配置（[[x, y, 幅, 高さ, 色], ...] の JSON）。子ページの付箋の表示に使う
  color      TEXT                 -- ページの色。付けていなければ NULL（正は、ページの DO の meta）
);

CREATE INDEX pages_updated_at ON pages (updated_at);
CREATE INDEX pages_parent ON pages (parent);

CREATE TABLE links (
  from_page TEXT NOT NULL,
  to_page   TEXT NOT NULL,
  PRIMARY KEY (from_page, to_page)
);

CREATE INDEX links_to_page ON links (to_page);

-- rowid は pages.id と同じ値にする
CREATE VIRTUAL TABLE pages_fts USING fts5(title, plain_text, tokenize = 'trigram');

-- 利用者（'user:<email>'）ごとのブックマーク。ページを削除すると、そのページの行も消す
CREATE TABLE bookmarks (
  actor      TEXT NOT NULL,
  page       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (actor, page)
);

-- サイト全体で 1 つの値。今は first_page（最初のページを作ったか）だけ
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

全文検索は FTS5 の trigram トークナイザを使う（`migrations/0002_fts.sql`）。ローカル（miniflare）では動作を確認し `test/runtime.test.ts` で固定した。本番の D1 でも、マイグレーションが通ることを確認した。3 文字未満の検索語は trigram に一致しないため LIKE を併用する。仮想テーブルがあると D1 を export できないので、FTS のテーブルは削除して作り直せるようにマイグレーションを分ける。

`links` は、付箋内の `<a href>` のうちパスが `/p/<slug>` に一致するものから作る（独自の Wiki リンク記法は入れない）。

ページの一覧を持つのは D1 だけである（DO は名前から列挙できない）。D1 を失うと存在するスラッグが分からなくなる点に注意。

D1 への反映は DO の `alarm()` で行う（`src/worker/indexer.ts`）。変更の 5 秒後に 1 ページ分の `pages` / `links` / `pages_fts` を入れ替え、同じ alarm で古い `ops` も消す。

- DO は自分のスラッグを `ctx.id.name` から得て、スキーマを作るとき（最初の書き込み）に `meta` の `slug` に保存する。alarm は保存した値だけを使う（alarm はリクエストを伴わずに起動されるので、そこで名前を取得できない場合に備えている）。ローカルでは `ctx.id.name` を取得できることを `test/runtime.test.ts` で固定した。本番では未確認なので、最初のデプロイ時に索引ができるか確認すること
- 検索とリンクに関わる内容（表示名、テキスト、リンク先）が前回の反映から変わっていなければ、`pages` の `note_count`、`updated_at`、`parent`、`layout`、`color` だけを書く。付箋の移動や色の変更のたびに全文検索の索引を書き直さないため。前回の内容のハッシュは DO の `meta` の `index_hash` に持つ
- alarm が設定済みかどうかは `ctx.storage.getAlarm()` で確かめる（メモリには持たない）
- 絶対 URL のリンクを拾うには `wrangler.jsonc` の `vars` の `SITE_ORIGIN` を設定する。空のときは相対 URL（`/p/<slug>`）だけを拾う
- `ops` は 30 日以内か直近 1000 件のどちらかに収まっていれば残す

## HTTP API

すべて Access の認証が要る。状態を変えるリクエストは、他のオリジンからのものを断る。

| メソッドとパス | 内容 |
| --- | --- |
| `GET /api/session` | 認証が有効かの確認用。`{ "actor": "user:<email>" }` を返す |
| `GET /api/index` | 一覧のボード用。ルートのページ（表示名、色、本文の冒頭、更新日時、子ページの数）と、ルート同士のリンクをまとめて返す。新しい順に 500 ページまで。子ページと孫ページは返さない。ページが 1 つもなければ、最初のページを作ってから返す（1 回だけ。「画面」の節） |
| `POST /api/pages-info` | ページの概要（表示名、色、付箋の数、親、付箋の配置）をまとめて返す（本文は `{ "names": [...] }`、200 件まで）。子ページの付箋の表示に使う。まだ索引にないページ（作ったばかり）は DO から補い、付箋の配置は null で返す。存在しないページは結果に入らない |
| `GET /api/pages/<slug>/ancestors` | 先祖のページを、ルートから順に返す（パンくず用） |
| `GET /api/pages?limit=&updated_after=&name=` | ページ一覧（D1）。更新の新しい順。`name` を渡すと、表示名かスラッグにその文字を含むページに絞る（英字の大文字と小文字は区別しない。本文は見ない） |
| `POST /api/pages/<slug>` | ページの新規作成（本文は `{ "title": "..." }`。表示名は省略できる）。すでにあれば 409 を返し、何も変えない |
| `DELETE /api/pages/<slug>` | ページの削除。取り消しはできない |
| `GET /api/search?q=` | 全文検索（D1）。3 文字以上は FTS、3 文字未満は LIKE。`roots=1` を付けると、一致したページのスラッグと、そのルートのスラッグだけを返す（一覧の絞り込み用。スラッグも照合する） |
| `GET /api/pages/<slug>` | スナップショット（`seq`、`title`、付箋と接続線） |
| `GET /api/pages/<slug>/backlinks` | このページへリンクしているページ（D1） |
| `GET /api/bookmarks` | 自分のブックマーク（付けた順。`{ "pages": [{ "name", "title", "updated_at" }] }`）。利用者は Access の主体で決まり、他の利用者の分は返さない。索引への反映の前のページは、表示名と `updated_at` が null になる |
| `PUT /api/bookmarks/<slug>` | ブックマークを付ける。すでに付いていれば何もしない。ページがなければ 404、1 人 100 件を超えると 400 |
| `DELETE /api/bookmarks/<slug>` | ブックマークを外す。付いていなくても成功を返す |
| `PUT /api/pages/<slug>/title` | 表示名の変更（本文は `{ "title": "..." }`）。空文字で未設定に戻す。書き込みのないページに対して呼ぶとページが作られる。本文に `"mustExist": true` を付けると、作らずに 404 を返す（一覧の画面が使う。古い一覧に残った削除済みのページを作り直さないため） |
| `PUT /api/pages/<slug>/color` | ページの色の変更（本文は `{ "color": "#BBDEFB" }`）。`src/shared/api.ts` の `PAGE_COLORS` のどれか。null で、付けていない状態に戻す。ほかの値と、`color` のない本文は 400。ページがなければ 404（作らない）。親ページがあれば、そこにある自分の付箋も同じ色にする |
| `POST /api/pages/<slug>/transfer` | このページの付箋を、他のページ（`to`）へ移す（写す）（本文は `{ "clientId", "opId", "to", "noteIds", "positions"?, "copy"? }`）。付箋の中身と、送る付箋どうしの接続線は、サーバーが元のページから読む。移すときは作成者を引き継ぎ、このページから消す。写すときは、作成者は写した人になる。`positions`（付箋の id から `{ x, y }`）は、このページでの位置の代わりに使う。送り先では、互いの位置関係を保って、今ある付箋の下に置く。同じ `opId` で送り直しても二重には置かない。置いた後の送り先の概要（`page`。`POST /api/pages-info` と同じ形で、索引への反映を待たない）を返す。ページか付箋がなければ 404、送り先に置けたのに元のページから消せなかった付箋があれば 409（移動の途中に元のページで変わった付箋は、消さずに残す） |
| `POST /api/pages/<slug>/notes` | 他のページから移す（写す）付箋を置く（本文は `{ "clientId", "opId", "from", "notes", "edges" }`。`from` は付箋が元あったページのスラッグ）。付箋の中身を送る側が渡すので、作成者は送った人になる。**今の画面は使わない。** 更新の前に開いた画面のタブのために残している。ページがなければ 404（作らない） |
| `POST /api/images` | 画像のアップロード（本文は画像のバイト列、`Content-Type` は png / jpeg / gif / webp / avif）。`{ "url": "/img/<key>" }` を返す。10MB まで |
| `GET /img/<key>` | 画像の取得（R2） |
| `GET /api/pages/<slug>/ops?agent=1&limit=` | 最近の操作（新しい順）。`agent=1` で agent の操作に絞る |
| `POST /api/pages/<slug>/ops/<seq>/revert` | 操作の取り消し（本文は `{ "clientId": "...", "opId": "..." }`）。`{ seq, applied, skipped }` を返す |
| `GET /ws/<slug>` | WebSocket |

## ページ名と URL

- URL は `/p/<slug>`。スラッグは `^[a-z0-9][a-z0-9-]{0,63}$` で、作成時に決めて後から変えない
- DO は `idFromName(slug)` で引く
- 表示名（タイトル）はスラッグとは別に DO の `meta` に持ち、D1 の `pages.title` に反映する。タイトルの変更は `applyOps` とは別の DO メソッドで行う
- **ページの色**も、表示名と同じ持ち方をする（DO の `meta` の `color` が正、D1 の `pages.color` が索引。変更は `setColor`、ブラウザへは `meta` のメッセージで届ける。ops には記録しないので、Undo と取り消しの対象にならない）。表示名と違い、**まだ作られていないページには付けない**（色を選んだだけでページを作らない。削除されたページを、古いタブから作り直さない）
  - 色は、wema の付箋の 8 色（`src/shared/api.ts` の `PAGE_COLORS`）か、なし（null）。**サーバーは、この一覧にない値を断る。画面は、届いた色をそのままスタイルに入れているので、検査を緩めないこと**
  - 使うのは 3 か所。ページの画面のヘッダーの地の色、親ページにある子ページの付箋の色、一覧の付箋の色。選ぶのは、ページの画面の表示名の後ろのボタン（`src/web/toolbar.ts` の `pageColorPicker`）
  - **子ページの付箋の色（`note.color`）と、子ページの色は、サーバーがそろえる**（`src/worker/page-do.ts` の `matchChildColors` と `recolorChildNotes`）。画面は、付箋の色をそのまま出す（上から塗らない。そろえる処理を画面に書かない）
    - 子ページの付箋の色を変えると（ポップアップ、MCP の `update_notes`、Undo、操作の取り消し）、親ページの DO が、書き込みの後に、子ページの `setOwnColor` を呼ぶ
    - 子ページの色を変えると（`setColor`）、子ページの DO が、親ページの `recolorChildNotes` を呼ぶ。親ページの付箋の更新として記録され（要約は `system:child-recolored:<slug>`）、開いているブラウザへ届く。色を外したときは、付箋を `UNSET_PAGE_COLOR` にする
    - 色の付いたページを子として置くと、付箋の色を、そのページの色にする。色の付いていないページを置いたときは、付箋の色のままにする（ページの色は付けない）
    - **`setOwnColor` は、親ページへ呼び返さない。色を合わせるための書き込み（`applyOpsInOrder` の `matchColors` が false）は、子ページへ色を送り返さない。** どちらも、2 つの DO が互いを呼び続けるのを防ぐため
    - `recolorChildNotes` は、色を引数で受け取らない。親ページの書き込みの順番待ちに入ってから、子ページの今の色を聞く（呼び出しが前後しても、最後に子ページの今の色になる）
    - そろえるのは、適用して記録したデルタ（`ApplyResult.deltas`）を見て決める。断られた変更と、今と同じ色への変更では、子ページの色を変えない
    - ページに付けられる色は `PAGE_COLORS` だけ。付箋には、MCP からほかの色も付けられる。その色は子ページに付かず（`setOwnColor` が断る）、子ページの次の索引の更新で、付箋が子ページの色に戻る
    - 相手の DO の呼び出しが失敗しても、元の変更は取り消さない。食い違いは、子ページの索引の更新（`reindex`）で、付箋を子ページの色に合わせて直す（色の付いていないページでは、付箋の色のままにする）。子ページの色を選び直しても直る（`setColor` は、色が変わっていなくても、親ページの付箋を合わせる）
  - 一覧の色は、D1 の索引から読むので、変更の数秒後に変わる（表示名と同じ）

## ページの階層

設計と経緯は `docs/plan.md` のフェーズ 6.6。定数と判定は `src/shared/hierarchy.ts`。

- **ページを、別のページのボードの上に「子ページの付箋」として置くと、そのページの子になる。** 子ページの付箋は、`meta` に子ページのスラッグを持つ付箋（`meta.page`）。wema の `renderNote` で、本文の代わりに子ページの概要を出す（`src/web/child-notes.ts`）
- 付箋を、子ページの付箋の上へドラッグして放すと、その子ページへ移る。Ctrl / Cmd を押したまま放すと、移さずに写す（`src/web/note-drop.ts`）
  - 画面は、付箋の id を `POST /api/pages/<slug>/transfer` に送るだけ。サーバー（`src/worker/transfer.ts`）が「送り先の DO が元のページの DO から付箋を読んで置く（`takeNotes`）→ 置けたら、元のページから消す（`removeNotes`）」の順に行う。**先に消さないこと**（置けなかったときに、付箋が失われる）
  - **移した付箋の作成者は引き継ぐ。** 付箋の中身と作成者はサーバーが読むので、送る側が作成者を偽れない。**作成者を、送る側の申告から決める形にしないこと**。写したときは、作成者は写した人になる（新しい付箋として扱う）
  - 送り先の DO は、元のページを、元のページの順番待ちに入らずに読む（`notesAmong`）。**順番待ちに入って読む形にしないこと**（元のページの書き込みが、別のページの順番待ちを待つことがあり、互いに待って止まる）。代わりに、`removeNotes` が、読んだときの版（`updated_at`）と今の版を比べ、違う付箋（その間に変わった、消えた）は消さずに残す。そのときは 409 を返す（送り先には、変わる前の付箋が置かれている）。その間の編集を、黙って失わないため
  - 元のページから消す操作は、clientId `transfer` で記録する。送った画面の clientId で記録すると、その画面は覚えのない自分の操作として無視し、消したことが手元に届かない。**画面は、移した付箋を手元では消さない**（手元で消すと、Undo で付箋を戻せてしまい、戻した付箋の作成者が戻した人になる）
  - 他のページへ切り替える前に、送っている途中の付箋を待つ（`dropOntoChildPages` の戻り値の `settled()`。`setBeforeLeave` の中で待っている）。待たないと、送れなかった付箋を元の位置へ戻せない
  - 送り先での id は、サーバーが新しく振る。送る付箋どうしをつなぐ接続線だけを一緒に置く
  - 運んだ付箋と接続線でつながっている付箋があれば、一緒に送るかを `confirm` で尋ねる（`src/shared/connected.ts` の `connectedNotes`）。**断っても、運んだ付箋は送る**（操作全体の取りやめではない）。子ページの付箋と、送っている途中の付箋（見えないだけで、ボードには残っている）は送れないので、その先へはたどらない。**`confirm` は、ポインターのイベントの処理の外で、運んだ付箋の見た目を済ませてから呼ぶこと**（閉じるまで画面の処理が止まる）
  - 運んだ付箋は、動かす前の位置で送る（運んでいない付箋との位置関係を保つため）
  - **子ページの付箋は、この操作では移さない**（ページの親を変えることになり、「親は 1 つだけ」の検査で断られる）
  - wema には、付箋を放したことを知らせるイベントがない。付箋の上で押し始めたポインターが離れたときに、位置だけを変える操作が確定したら（`history:commit`）、ドラッグの終わりとして扱っている
- **本文のリンク（Wiki リンク）は、階層に関与しない。階層を、付箋の本文の形から決めないこと**（説明を 1 行足しただけで階層が変わり、付箋の編集のたびにページが一覧に出たり消えたりする）
- **親は 1 つだけ。** 階層は木になる。深さは 5 段まで（ルートが 1 段目）。同じ子ページを、1 つのページに 2 つ置くこともできない
- 子ページの付箋を削除すると、子ページはルートへ戻る。Undo や取り消しで付箋が戻ると、もう一度子になる
- 子ページを削除すると、親ページにある子ページの付箋も消える。親ページを削除すると、子ページはルートへ戻る（子孫ごとの削除はしない）
- 一覧に出すのは、ルートのページだけ。絞り込みは子孫も対象にし、子孫が一致したら、そのルートの付箋を残して数を出す。子孫のページが関わるリンクは、一覧の線にしない

階層の記録は 2 つの DO にまたがる。**次の決まりを崩さないこと。**

- 正は、子ページの DO の `meta` の `parent`。D1 の `pages.parent` は索引で、変更の数秒後に反映される
- 親ページの DO は、子ページの付箋を作るデルタを適用する**前に**、子ページの DO の `setParent` を呼ぶ（`adoptChildren`）。断られたら、デルタ全体を拒否する。`reason` は `child page: <理由>: <スラッグ>` の形で、理由は `ChildRejectCode`（`not-found` / `self` / `other-parent` / `duplicate` / `ancestor` / `too-deep`）。**この文字列は `childRejection()` で作り、`parseChildRejection()` で読むこと。画面で、文言の一部が含まれるかで判定しない**付箋がなくなったら、適用した**後に** `clearParent` を呼ぶ（`releaseOrphans`）。`applyOps` と `revert` の両方が `withChildren` を通る
- **`setParent` / `clearParent` / `getPageRef` / `fitsWithin` を、書き込みの順番待ち（`write` / `inOrder`）に入れないこと。** 親ページの DO が順番待ちの中から呼ぶので、入れると、互いを待って止まることがある
- 輪の検査は 2 回行う。置く前と、`setParent` が済んだ後（他のページで同時に置く操作があると、前の検査だけでは 3 ページ以上の輪を見逃す）。子ページの側でも、相手が自分の子でないことを確かめる
- 深さは、D1 ではなく DO をたどって数える（`fitsWithin`）。D1 は反映が遅れるので、置いた直後の検査に使えない
- 2 つの DO の書き込みは、まとめて行えない。食い違いは、索引の更新（alarm）で直す。親ページの側は、付箋のない子をルートへ戻す（`reconcileChildren`）。子ページの側は、親がなくなっていればルートへ戻る（`healParent`）

## 変更の単位：HistoryDelta

ブラウザ・MCP の両方で、wema の履歴デルタ（HistoryManager が作る Undo 1 回分）を変更の単位にする。

```ts
import type { WemaNote, WemaEdge, HistoryDelta } from '@kanf/wema';

// HistoryDelta（wema 側で export してもらう。末尾参照）
// | { type: 'note:create'; note: WemaNote }
// | { type: 'note:update'; noteId: string; before: Partial<WemaNote>; after: Partial<WemaNote> }
// | { type: 'note:delete'; note: WemaNote }
// | { type: 'edge:create'; edge: WemaEdge }
// | { type: 'edge:update'; edgeId: string; before: Partial<WemaEdge>; after: Partial<WemaEdge> }
// | { type: 'edge:delete'; edge: WemaEdge }
```

DO は `applyOps(actor, opId, deltas, summary?)` を唯一の書き込み口として持ち、WebSocket ハンドラも MCP ツールもこれを呼ぶ。

## WebSocket プロトコル

```ts
// Client → Server
type ClientMsg =
  | { type: 'hello'; clientId: string; lastSeq?: number; epoch?: string }   // epoch は前に受け取った値（あれば）
  | { type: 'ops'; opId: string; deltas: HistoryDelta[] }       // 原子的に適用
  | { type: 'preview'; noteId: string; x?: number; y?: number; width?: number; height?: number } // 保存しない
  | { type: 'presence'; selection: string[]; editing?: string };

// Server → Client
type ServerMsg =
  | { type: 'snapshot'; seq: number; title: string | null; color: string | null; epoch: string | null; data: { version: 1; notes: WemaNote[]; edges: WemaEdge[] };
      info: Record<NoteId, { createdBy: string | null; updatedAt: number }> }   // 付箋ごとの付加情報（後述）
  | { type: 'meta'; title: string | null; color: string | null; epoch: string | null }   // 表示名かページの色が変わった、またはページができた。seq は進まない
  | { type: 'ops'; seq: number; actor: string; clientId: string; opId: string; deltas: HistoryDelta[]; summary?: string;
      createdAt?: number;         // 操作を記録した時刻。配信と、再接続のときの差分に付く。送信元にだけ返す確定（再送への応答など）には付かない
      reverts?: number;           // 取り消しなら、取り消した対象の seq（「取り消し」の節を参照）
      fixups?: HistoryDelta[] }   // fixups は送信元にだけ付ける（後述）
  | { type: 'reject'; opId: string; reason: string; fixups?: HistoryDelta[] }   // fixups はサーバーの現在値に合わせるデルタ
  | { type: 'preview'; clientId: string; noteId: string; x?: number; y?: number; width?: number; height?: number }
  | { type: 'presence'; clientId: string; selection: string[]; editing?: string };
```

### 流れ

- 接続先は `/ws/<slug>`
- 接続時に `hello` を送る。`lastSeq` が `ops` に残っていれば差分の `ops` を、なければ `snapshot` を返す。クライアントは `snapshot.data` を `importData()` で読み込む
  - 差分を返すときは、先に `meta`（表示名とページの色の現在値）を送る。表示名とページの色の変更は `seq` を進めず、差分に出ないため。`lastSeq` が最新なら `meta` だけを返す
  - 差分が 500 件か合計 4MB を超えるとき、または書き込みのないページでは `snapshot` を返す
  - 差分のうち自分の `clientId` の `ops` には `fixups` を付ける（確定を受け取る前に切断していた場合のため）
  - `hello` を送るまでは配信の対象にならず、`ops` を送ると接続を閉じられる
  - 再接続したクライアントは、確定を受け取っていない `ops` を同じ `opId` で送り直してよい（適用済みなら記録済みの結果が返る）
- 確定した変更は送信元も含めた全員に `ops` として配信する。送信元は自分の `opId` が返ってきたことを確定（ack）とみなす
- クライアントは wema の `history:commit` を `ops` として送り、受信した `ops` は `applyRemote()` で適用する（自分の `opId` のものは適用済みなのでスキップ）。実装は `src/web/sync.ts` の `BoardSync`。DOM に依存させず、ボードとソケットを引数で受け取る形にしてあり、`test/sync.test.ts` が実際の Worker と DO に接続して動かす
- 切断中の操作は手元にためておき、再接続後に同じ `opId` で送る。スナップショットでボード全体を入れ替えた後に自分の操作の確定が届いたら、サーバーが適用した `deltas` を手元にも適用する（入れ替えで手元から消えているため）
- `reject` を受けたら、手元に適用済みの変更を逆向きのデルタで巻き戻し、`fixups` を適用し、その上に後続の未確定の操作を適用し直す
- サーバーで確定した変更を手元に適用するときは、同じ付箋や接続線への未確定の変更を、その上に適用し直す。未確定の操作はサーバーでは後から適用されて後勝ちで残るので、手元の表示もそれに合わせる
- 接続に失敗したら `GET /api/session` で認証を確かめ、切れていれば再読み込みする（切断中に認証が切れた場合、接続の失敗からは理由が分からないため）
- 定数（閉じるコード 4401、`ping` / `pong`、`reject` の理由 `text conflict`）は `src/shared/protocol.ts` に置き、サーバーとブラウザの両方から使う
- 配信する `deltas` は、サーバーが実際に適用したもの。更新の `before` と削除対象の内容はサーバーの保存値で置き換えてある。サーバーが変えた分（サニタイズで変わった text、付箋の削除に伴ってサーバーが足した接続線の削除）は `fixups` に入れ、**送信元は自分の `opId` の `ops` を受けたとき `fixups` だけを `applyRemote()` する**
- 更新の `after` にキーがなく `before` にあるものは「未設定に戻す」を表す（wema は `collapsed: undefined` で折り畳みを解くが、値が `undefined` のキーは JSON で消えるため）。**送受信の両側でこの規則を守ること**
- 対象がすでにない更新と削除は、拒否せずにそのデルタだけ捨てる。全部捨てた場合 `seq` は進まない
- MCP 経由の変更も `actor: 'agent:...'` 付きの `ops` として配信される。ブラウザでは agent の変更を区別して表示できるようにする（表示方法は未決定）

### ドラッグ・リサイズ中

wema はドラッグ・リサイズ中も pointermove ごとに `note:update` を出す。

- ローカル由来の `note:update` のうち x/y/width/height は間引いて（目安 50ms 程度）`preview` として送る。サーバーは保存せず他のクライアントへ中継するだけ
- 確定値はドラッグ終了時の `history:commit` で `ops` として送る

### 競合処理

DO で書き込みは直列化されるので、基本はフィールド単位の後勝ち。

- `note:update` の `after` に `text` を含む場合のみ、サーバーの現在値が `before.text` と一致するか確認し、不一致なら `reject` する（MCP 経由でも同じ）
- `reject` を受けたクライアントは、楽観的に適用した変更を戻し、`fixups`（サーバーの現在値に合わせるデルタ）を `applyRemote()` で反映する
- Undo 履歴はブラウザごとのローカルのもの。他人や agent の変更後に Undo しても、text なら同じ `before` チェックで `reject` されるだけなので特別扱いしない
- `edge:update` の from/to は wema でも変更不可。サーバーでも無視する
- `note:update` に zIndex が含まれていても保存しない

### 同期対象の方針

- **zIndex は同期しない**。各クライアントの表示状態として扱う
- **接続線の collapsed は同期する**（まず共有で運用し、実用上うるさければ同期対象から外す）
- text の同時編集は付箋単位の後勝ち + 上記の衝突検出まで。CRDT（Yjs 等）は必要になるまで入れない。`presence.editing` で「誰が編集中か」を表示して衝突を減らす

## リモート MCP サーバー

### 目的

claude.ai / ChatGPT のコネクタとして登録し、定期タスクなど**ブラウザでページを開いていない状態**から LLM にボードを読み書きさせる。
主な用途は、メモを読んでアドバイスの付箋を貼る、付箋同士を接続線でつなぐ、色やレイアウトで分類・整理する、の三つ。

### 実装方針

- Workers 上に置き、`/mcp` で Streamable HTTP を提供する。認可は、前述のとおり Access の Managed OAuth
- MCP のハンドラは `agents` の `createMcpHandler`（ステートレス）で作る。`McpAgent` は非推奨で機能凍結されている。このハンドラは、他のオリジンからのリクエスト（`Origin` が違うもの）を 403 で断る
- MCP サーバーは「DO に `ops` を送る一クライアント」として実装する。書き込みのツールは該当ページの DO の `applyOps` を呼ぶだけで、検証・サニタイズ・保存・ブロードキャストはブラウザからの変更と共通。例外は `create_page` のページの作成で、画面と同じ DO の `createPage` を呼ぶ。もう 1 つの例外は `move_notes` で、画面からの移動と同じ `transferNotes`（DO の `takeNotes` と `removeNotes`）を呼ぶ。どちらも中で `applyOps` と同じ経路を通る
- 1 回のツール呼び出し = 1 つの `ops`（`actor: 'agent:<client>'`、`summary` にツール名と LLM が渡した説明）。複数の付箋を動かす整理も 1 つの `ops` にまとめ、後から 1 操作として取り消せるようにする。例外は `move_page` と `move_notes` で、ページをまたぐので、変更したページごとに 1 つずつ記録する（下の「ツール」）
- ツールの定義（名前・説明・入力スキーマ）は共通モジュールに置き、将来の WebMCP 版と共有する。実装は「ボードを読む・デルタを適用する」インターフェース越しに書き、サーバー版（DO を呼ぶ）とブラウザ版（wema の API を呼ぶ）を差し替えられるようにする

実装の場所:

- `src/shared/tools.ts`: ツールの定義と実装（`TOOLS`）。`BoardAccess` 越しに書いてあり、Workers の API に依存しない
- `src/shared/note-text.ts`: プレーンテキストを付箋の HTML にする（`textToHtml`）
- `src/worker/mcp/board-access.ts`: `BoardAccess` のサーバー版。ページの DO と D1 を呼ぶ
- `src/worker/mcp/server.ts`: `TOOLS` を MCP のサーバーに登録する。リクエストごとにサーバーを作る

### ツール

| ツール | 内容 |
| --- | --- |
| `list_pages` | D1 からページ一覧（名前・タイトル・更新日時・付箋数・親ページ）を返す。更新日時で絞り込める。子ページも含めて全ページを返す。**MCP のツールが受け渡しする日時は、入力も出力も ISO 8601 の文字列にする**（UNIX ミリ秒の数値は、LLM が読み違えやすい。日時を返すツールを足すときも同じ） |
| `search_pages` | D1 の全文検索。親ページも返す |
| `read_board` | 1 ページの付箋（id・タグ除去したテキスト・座標・サイズ・色・作成者）と接続線（from/to/label）を返す。子ページの付箋には `child_page`（子ページの名前）が付く |
| `add_notes` | 付箋を複数追加する。位置を省略した場合は関連付け先の付箋の近くに自動配置。大きさも指定できる。省略すると、幅は 200、高さは本文の量と幅からの見積もり（サーバーでは描画の大きさを測れない） |
| `update_notes` | テキスト・色・位置・サイズを複数更新する |
| `delete_notes` | 付箋を削除する（接続線も合わせて削除） |
| `move_notes` | 付箋を、別のページ（すでにあるページ）へ移す。作成者は引き継ぐ。画面からの移動と同じ処理（`src/worker/transfer.ts`）を使う |
| `connect_notes` / `disconnect_notes` | 接続線の追加・削除（ラベル指定可） |
| `auto_layout` | 接続線に基づく自動レイアウト。wema のレイアウト関数を DO 側で実行する（末尾の wema 側の変更を参照） |
| `create_page` | 付箋のないページを作る。`parent` を指定すると、そのページに子ページの付箋を置く（置く先がなければ、ページを作らずに断る） |
| `move_page` | 既存のページを、別のページの子へ移す（`parent: null` でルートへ戻す）。今の親ページの子ページの付箋を消してから、移す先に置く |
| `revert_operation` | agent 自身の直前の操作を取り消す（後述の取り消し機能を使う） |

- `add_notes` / `update_notes` のテキストはプレーンテキスト。改行は `<br>` にし、`- ` の箇条書きと `- [ ]` / `- [x]` のチェックリストだけを HTML に変換する。それ以外はエスケープするので、LLM は HTML を書けない。変換後も必ずサーバーのサニタイズを通す
- ページへのリンクは `[[スラッグ]]` と書ける（`src/shared/note-text.ts`）。`read_board` の本文にも、ページへのリンクは同じ書式で出る（`src/worker/plain-text.ts`。リンクの文字がスラッグと違えば、文字の後ろに付く）
- 外部のページへのリンクは、本文に URL（`http` / `https`）をそのまま書いたものだけがリンクになる。**リンクの文字は、リンク先の URL そのものにすること。文字とリンク先を別々に指定できる書式（Markdown の `[文字](URL)` など）を足さない**。LLM が、外部の文章の指示に従って、文字でリンク先を偽れないようにするため
  - ユーザー名やパスワードを含む URL（`https://信頼できる名前@別のホスト/`）は、リンクにしない
  - 文字と `href` には、解釈した後の URL（`URL.href`）を使う。国際化ドメイン名は Punycode で出る
  - **解釈した後の URL が、URL に使える文字（`URL_CHARS`）だけでできていることを確かめること。`URL_CHARS` に、引用符と山かっこを足さない**。ホスト名のパーセントエンコードは復号されるので（`https://x%22y/` → `https://x"y/`）、確かめないと、引用符で `href` の外へ出られる
  - `read_board` は、外部へのリンクを URL の文字として返す。人が貼ったリンクで、文字が URL と違うものは、`文字 <URL>` の形で返す。書き戻しても同じリンク先になるよう、書く側がリンクにしない文字は、パーセントエンコードして返す（`src/worker/plain-text.ts` の `writableUrl`）
  - 残る危険: 指示に従わされた agent が、ボードの内容を URL に埋め込んで貼ること。人が押すと、内容がリンク先へ渡る。URL は画面にそのまま出る。**表示しただけで外へ送られる要素（画像、iframe など）を、MCP から貼れるようにしないこと**
- **ページを作るのは `create_page` だけ。** 既存のページを作り直さない（すでにあれば断る。DO の `createPage`）。ページの作成は ops に記録しないので、`revert_operation` では取り消せない
- 子ページとして置く操作（`create_page` の `parent`、`move_page`）は、親ページへの子ページの付箋の `note:create` として記録する。置けるかどうか（親は 1 つ、輪にならない、深さ）の検査は、画面から置くときと同じく DO が行う。取り消すと、子ページはルートへ戻る。`delete_notes` で子ページの付箋を消しても、子ページはルートへ戻る
- `move_page` は、今の親ページから付箋を消す操作と、移す先に置く操作の 2 つを、それぞれのページに記録する（ページをまたぐので 1 つの操作にできない）。移す先がないときと、移す先が自分の子孫（輪になる）のときは、外す前に断る。**それ以外の理由（深さの上限など）で移す先に置けなかったら、消した操作を取り消して元の親ページに戻す**（戻せたかは今の親で判断し、戻せなかったときは、エラーの文で、今の親と消した操作の番号を LLM に伝える）。親の記録が古く、親ページに付箋がないときは、記録だけを消してから移す。消した付箋につながっていた接続線は、戻さない限り消える
- `move_notes` は、移す先に置く操作と、元のページから消す操作の 2 つを、それぞれのページに記録する。画面のドラッグと違い、移す先は子ページに限らない。子ページを表す付箋は移せない（`move_page` を使う）。移す先に置けたのに元のページから消せなかったときは、エラーの文で、置いた操作の番号を LLM に伝える。**付箋を移すのに `delete_notes` と `add_notes` を組み合わせさせないこと**（作成者が agent に変わる。ツールの説明でも、そう伝えている）
- ページの削除・改名のツールは当面提供しない。**書き込み系のツールは、存在しないページには適用しない**（`applyOps` の `mustExist`。読んでから適用するまでの間に削除されたページも作り直さない）
- 書き込み系のツールは、記録した操作の番号（`operation`）を返す。LLM はこれを `revert_operation` に渡せる。**何も変わらなかった操作は番号を返さずにエラーにする**（`applyOps` は seq を進めないので、返すと別の操作の番号になる）
- `revert_operation` が取り消せるのは、同じ主体（`agent:<client>`）の操作だけ。`operation` を省略すると、取り消しでない直近の自分の操作が対象になる
- ツールが断る場合（ページがない、付箋がない、本文の競合など）は `ToolError` を投げ、MCP では `isError` の結果として返す。LLM が読んで直せるようにするため
- アドバイスの付箋など agent が作った付箋を見分けられるよう、`created_by` を保存する。画面では、付箋の下に、その AI のアイコンを出す（下の「付箋ごとの付加情報」）

### 付箋ごとの付加情報（作成者と更新日時）

付箋の作成者（`created_by`）と、最後に更新した日時（`updated_at`）を、画面で付箋の近くに出す。出るのは、付箋にホバーしたときと、付箋を選んだときだけである。AI（agent）が作った付箋には、作成者と日時の右に、その AI のアイコンを並べる。

- **作成者と日時は、付箋のデータ（`WemaNote`、`meta`）に入れないこと。** サーバーが認証結果と時刻から決める値で、付箋のデータに入れると、クライアントが書き換えられる値になる。付箋の id ごとの「付加情報」として、付箋とは別に届ける（`src/shared/note-info.ts`）
- 届け方は 2 つ。スナップショットには、付箋ごとの表（`info`）を載せる。操作の配信（`ops`）には、時刻（`createdAt`）だけを足す。画面は、操作の主体（`actor`）、`createdAt`、デルタの 3 つから、付加情報を組み立てる（`applyOpToInfos`）
  - **`applyOpToInfos` の結果は、サーバーが付箋の行に書く値（`src/worker/apply-ops.ts` の `applyDeltas`）と同じにすること。** 作成で作成者と時刻が入り、更新で時刻だけが変わる。片方の規則を変えたら、もう片方も変える（合っているかは `test/sync.test.ts` が確かめている）
  - 自分が作って、まだ確定していない付箋には、付加情報がない（何も描かない）。確定の `ops` が届いたときに入る
- 表示は `src/web/note-authors.ts`。wema 0.16.0 の `renderNoteAccessory`（付箋の枠のすぐ下の領域）に描き、変わった付箋は `refreshNoteAccessory()` で描き直す（`BoardSync` の `onNoteInfo`）
  - **`@kanf/wema` を 0.16.0 より前に下げないこと**（`renderNoteAccessory` がない）
  - **領域（`container`）には、要素を直接入れること。行（`div`）で包まない。** ポインタを受けるのは直接入れた要素だけで、包むと、その行が幅いっぱいにクリックを受けて、広い画面で下の付箋を押せなくなる
  - **ホバーでの出し入れは、`visibility` で書くこと。`display` で切り替えない。** 高さが変わると、縦に積んでいる間は、ホバーのたびに列が積み直されて、付箋がポインタの下で動く
  - 縦に積んでいる間だけは、作成者、日時、アイコンを `display: none` にしてある（隠した分の高さで、すべての付箋の間隔が広がるため）。出るのは、付箋を選んだときで、そのとき列が積み直される。ホバーでは切り替えていないので、上の決まりとは食い違わない
  - **要素を、付箋の枠に重ねないこと**（負の `margin-top` など）。右下の大きさを変えるハンドルと、下辺の中央のアンカーを覆って、押せなくなる
  - 出している間（ホバー中と選択中）は、付箋ごと手前へ上げる（`style.css` の `z-index: 9998 !important`）。広い画面では、この領域が下の付箋に重なり、後から触った付箋に隠れるため。**`!important` を外さないこと**（wema は付箋の要素へ `z-index` を直接書く。外すと、そちらが優先されて、手前に出なくなる）。**値を 9999 以上にしないこと**（wema の範囲選択の枠とポップアップより手前に出る）。領域だけを上げることはできない（付箋の要素が、重なりの単位になっている）
  - AI のアイコンは、主体の名前（OAuth のリダイレクト先のホスト名）から選ぶ（`note-authors.ts` の `agentIcon`）。`claude` で始まれば Claude、`chatgpt` か `openai` で始まれば OpenAI、それ以外（`localhost` を含む）は共通のアイコン。絵柄は `src/web/icons.ts` にあり、Claude と OpenAI のものは Simple Icons（CC0）から写した。クライアントを足すときは、この 2 か所に足す
  - 出るのはページの画面だけ。使い方の画面と一覧の画面には、作成者がいないので出さない
- **この領域と経路は、付箋への反応（「いいね」など）にも使う前提で作ってある。** 項目を足すときは、`NoteInfo` に足して同じ経路で届け、`NoteAuthors` の `render` に要素を足す。履歴（`ops`）に積まない値は、`ops` とは別のメッセージで届ける
- 付箋を消して Undo で戻すと、作成者は戻した人になる（サーバーは、付箋の作成のたびに、その操作の主体を作成者として書く）。AI の付箋を人が消して戻すと、AI のアイコンが出なくなる

### 取り消し（revert）

MCP 経由の変更はブラウザにはリモートの変更として届くため、ブラウザの Ctrl+Z では戻せない。代わりにサーバー側で `ops` 単位の取り消しを提供する。

- `ops.body` の各デルタから逆向きのデルタを作り（逆順、create ↔ delete、before ↔ after の入れ替え）、新しい `ops` として適用する。元の `ops.reverted_by` に取り消し操作の `seq` を記録する
- 取り消し時、対象の現在値が元の `after` と一致しない（その後に誰かが変更した）デルタはスキップし、残りを適用する（部分適用）。スキップした付箋と接続線は結果として返す
  - 更新はフィールドごとに判定する。その後に変更されたフィールドだけを戻さない
  - 付箋の作成の取り消しは、text が変わっていたら消さない。位置、大きさ、色だけの変更なら消す（agent が貼った付箋を動かしただけで取り消せなくなるのを避ける）。接続線は label で判定する
  - 取り消さない接続線（変更されていたもの、他の人が後からつないだもの）がつながっている付箋は消さない。消すと、その接続線も一緒に消えるため
  - 削除の取り消しは、同じ id のものがすでにあるか、接続線の両端がなければ戻さない
  - 取り消せるものが 1 つもなければ、`ops` に記録せず、`reverted_by` も書かない
- 取り消しの `ops` には `reverts`（取り消した対象の `seq`）が付く。取り消しは HTTP の API か MCP から行われ、要求元のブラウザも手元には適用していない。**クライアントは、自分の `clientId` の `ops` でも `reverts` があればリモートの変更として適用すること**
- 取り消しの失敗は `code` で分類する（`not-found` / `conflict` / `forbidden` / `invalid`）。HTTP の API は順に 404 / 409 / 403 / 400 を返す
- 取り消しも `ops` の 1 つなので、取り消しを取り消せる（元の変更が戻る）。そのとき元の操作の `reverted_by` を消し、元の操作をもう一度取り消せるようにする
- 実装は `src/worker/revert.ts`。DO の `revert()` の `ownOnly` を指定すると、同じ主体の操作だけを取り消せる（MCP の `revert_operation` で使う）
- ブラウザでは、ページの画面のメニューの「操作の履歴」から、ops の一覧と取り消しを出す（「画面」の節。既定では agent の操作に絞る）

### WebMCP（後から追加）

ページを開いている状態での LLM 操作用に、同じツール定義を WebMCP（`document.modelContext.registerTool`、旧 `navigator.modelContext` にも対応）でも公開する。2026 年 10 月時点では WebMCP は実験段階で、ネイティブに呼べるエージェントは限られるため優先度は低い。
WebMCP 版はブラウザ内で wema の API を直接呼ぶので、LLM の変更がブラウザの Undo 履歴に積まれ Ctrl+Z で戻せる。そのために wema の `board.batch()` と `origin: 'agent'` が必要（末尾参照）。

## 画面

設計の詳細と、wema の制約への対処は `docs/plan.md` の 3.7 節にある。

- **ページの一覧（`/`）も wema のボードで表す。** ページ 1 つを付箋 1 枚、ページ間のリンクを接続線にする。リンク先が未作成のページは「未作成」の付箋として出す。検索は、一致するページの付箋だけを残す絞り込みで、残った付箋の位置は変えない
- 一覧のボードは保存しない。配置は開くたびに `src/web/index-board.ts` で計算し（まとまりごとの階層、多い階層は折り返す。wema の `computeAutoLayout` は横 1 列に伸びるので使わない）、参照モード（viewOnly）で出す。**一覧のボードを Page DO に保存したり、WebSocket で同期したりしない**
- 一覧のボードは wema v0.5.0（絞り込み、リンクのフック）、v0.6.0（パン）、v0.7.0（ズーム）の機能で作ってある（`src/web/index-view.ts`、データの組み立ては `src/web/index-board.ts`）
  - 絞り込みは `setNoteFilter()`。`importData()` で解除されるので、読み込みの後に呼ぶ
  - 付箋内のリンクは `onLinkClick` で受け、サイト内のリンクは同じタブで開く（`src/web/dom.ts` の `openInternalLink`）。**渡る URL はブラウザが解決した絶対 URL なので、サイト内かどうかはオリジンの比較で判定すること。先頭が `/` かどうかで判定しない**（`//other.example/` でサイト外へ飛ばせてしまう）。**移動先には、検査した絶対 URL をそのまま使うこと。パスだけを取り出して移動しない**（`https://このサイト//other.example/x` のパスは `//other.example/x` で、サイト外を指す）。判定は `src/web/links.ts` の `internalUrl`
  - はみ出した付箋へは、wema v0.6.0 のパンで移動する。絞り込みの後は `fitToContent()` で、残った付箋がすべて見える位置と倍率にする。検索語を消したら、開いたときの位置と等倍へ戻す。**ボードを置く要素は表示領域の大きさに固定すること。付箋の範囲まで広げて外側をスクロールさせない**（wema は、ボードの要素の大きさを見えている範囲として計算する）。ボードの上の Ctrl / Cmd + ホイールはボードのズームになる。ズームのボタンは、ヘッダーにある（`src/web/toolbar.ts` の `zoomControls`）
- ヘッダーは 1 行で、3 つの区画に分ける（左: 今いる場所、中央: 付箋の操作、右: Wiki の機能）。部品は `src/web/toolbar.ts`、アイコンは `src/web/icons.ts` にあり、ページの画面と一覧の画面で共有する。設計は `docs/plan.md` のフェーズ 6.5
  - ボタンの有効と無効は、ボードの状態（`isReadOnly()`、`isViewOnly()`、`canUndo()`、`getSelection()`）から決める。自前の状態を持たない
  - 参照モードと付箋の見た目は、ブラウザごとの設定（`localStorage`）で、ページの内容と同期の対象には含めない
  - 参照モードは `setViewOnly()` で切り替える。終えると、その間に自分が動かした付箋は元の位置へ戻る。その間に届いた他の人の変更（`applyRemote()`）と、再接続で読み直した内容（`importData()`）は残る。**`@kanf/wema` を 0.7.1 より前に下げないこと**（0.7.0 までは、参照モードの間に `importData()` があると、終えるときに読み直す前の位置へ戻り、サーバーの内容と食い違う）
  - 編集できるボード（ページの画面、使い方の画面）は、`emptyDrag: 'pan'` で作る（wema 0.11.0）。空いている場所のドラッグは表示位置を動かし、範囲で選ぶのは Ctrl / Cmd か Shift + ドラッグになる。操作を変えたら、使い方の付箋（`src/shared/guide.ts`）の文面も合わせる
  - **同期しているボード（ページの画面）で、付箋を画面の幅に合わせて並べ直すために、wema 0.12.0 の `stackNotes()` と `moveNotes()` を呼ばないこと。** 狭い画面向けの縦積みだが、表示だけでなく付箋のデータを書き換えるので、見ている端末の幅が、保存してある配置に入る。参照モードでも、幅の変更は `history:commit` に載ってサーバーへ保存され、参照モードを終えても戻らない（位置だけが戻る）。スマートフォンの幅での扱いと、確かめた結果は `docs/plan.md` のフェーズ 6.5 の「スマートフォンの幅」
  - 幅 640px 以下では、ヘッダーを 2 行にする（`src/web/style.css`。1 行目が左の区画、2 行目が中央と右の区画）。ヘッダーに部品を足したら、幅 375px で重ならないことを確かめる
  - 幅 640px 以下では、付箋を縦 1 列に積んで表示する（`src/web/stacked-view.ts` の `stackOnNarrow`。ページ、使い方、一覧の 3 つの画面で使う）。wema の `setStacked()` と `setPageScroll()` を、幅に合わせて切り替える。設計と確かめた結果は `docs/plan.md` のフェーズ 6.5 の「縦に積む画面」
    - **切り替える幅は、`stacked-view.ts` の `NARROW` と、`style.css` のヘッダーを 2 行にする幅で、同じ値にすること。** 片方だけを変えると、ヘッダーが 1 行のまま積まれるか、2 行で積まれない幅ができる
    - `setStacked()` は付箋のデータを変えないので、積んだり戻したりしても、サーバーへは何も送られない。上の「`stackNotes()` と `moveNotes()` を呼ばない」は、そのまま守る
    - **積んでいる間に付箋を足すときは、位置を渡さないこと**（`page-view.ts` の `nextNotePosition`）。wema が、データの上では既存の付箋の左下に置く。見えている範囲から位置を作って渡すと、広い画面で開いたときに、他の付箋と重なる
    - 積んでいる間は、ボードを置いた要素の中を縦にスクロールさせる（`.stacked`）。要素の大きさは、表示領域のまま変えない。ボードの表示位置と倍率は動かせない（`setViewport()`、`zoomTo()`、`fitToContent()` は何もしない）ので、**表示位置や倍率を使う処理を足すときは、`isStacked()` の間の扱いを決めること**。今は、階層を移るときのズームの演出を省き（`zoomTransitions` の `still`）、倍率を保存しない（`rememberViewport` の `paused`）
    - 積んでいる間は、付箋のドラッグとリサイズ、接続線の表示と作成ができない（wema の動作）。子ページへ付箋をドラッグして移す操作と、整列、ズームのボタンは、広い画面だけの操作とする。操作を変えたら、使い方の付箋（`src/shared/guide.ts`）の文面も合わせる
    - 積んでいる間は、接続線の代わりに、つながっている相手を「印」として付箋の下に並べる（ページと使い方の画面。一覧の画面には出さない）。印を押すと、相手の付箋が見える位置までスクロールし、相手の付箋を少しの間、枠で強調する（すでに見えていてスクロールしないときも、相手が分かる）。印は、wema 0.15.0 の `noteLinks` オプションが描く（中身、並び順、押したときの動作、描き直し、文言、見た目のどれも wema が持つ）。wema-kake が渡すのは、相手が子ページの付箋のときに出す文字（子ページの表示名）だけ（`page-view.ts` の `noteLinks.text`）。設計と確かめた結果は `docs/plan.md` の「付箋のつながりの印」
      - **`@kanf/wema` を 0.15.0 より前に下げないこと**（`noteLinks` がない）
      - **印を自前で描く実装（`renderNoteFooter`、接続線や付箋のイベントを受けて描き直す配線）を、足し直さないこと。** `renderNoteFooter` を渡すと、`noteLinks` は何も描かなくなる
      - 印に出す文字が、付箋のデータの外で変わったとき（子ページの表示名）は、**その付箋に `board.refreshNote(id)` を呼ぶ**（`ChildNotes` が、概要を取り直したときに呼んでいる）。wema が、その付箋を相手にしている印も描き直す
      - 文言は wema の `labels`（`linkOut` など）にあり、`WEMA_LABELS` を渡していれば今の言語で出る。見た目を変えるときは、wema のクラス（`.wema-note-links`、`.wema-note-link`、`.wema-note-link-target`）への上書きを `style.css` に書く。今は上書きしていない
  - **JSON の読み込み（`importData()`）と、wema のロック（`setReadOnly()`）のボタンは足さない**。`importData()` は `history:commit` が発火せず同期されない。readOnly は、同期が最初の読み込みの間に使っている
  - `src/web/icons.ts` の SVG は固定の文字列で、`innerHTML` で入れている。**外から来た値をここへ入れない**
- 一覧の付箋にポインタを載せると、付箋の右上に、表示名の変更とページの削除のボタンが出る（`src/web/index-actions.ts`）。付箋の中身は wema がサニタイズして描くので、ボタンは付箋の HTML には入れず、上に重ねている。操作の後は、手元の一覧を書き換えてボードを作り直す（表示位置と絞り込みは保つ）。未作成のページの付箋と、小さく表示している付箋には出さない
  - 「改名」は表示名の変更で、スラッグは変えられない（スラッグはページの DO の名前）
- 一覧（`/`）とページ（`/p/<slug>`）の間は、ページ全体を読み込み直さずに切り替える（`src/web/navigation.ts` の `navigate`）。階層を移るとき（一覧からページへ、ページから子ページへ、その逆）は、ズームの演出が入る（`src/web/viewport-motion.ts` の `zoomTransitions`）
  - **画面全体（`document` / `window`）に付けるリスナーは、`{ signal: viewSignal() }` を渡して付けること。** 渡さないと、画面を切り替えるたびに積み重なる。画面が終わるときの後始末（同期を止める、ボードを破棄する、タイマーを止める）は `onViewEnd` に登録する
  - **待った後（`await` の後）に画面を触る処理は、画面がまだ生きているかを確かめること**（`viewSignal()` を先に取っておき、`aborted` を見る）。切り替えた後に、破棄済みのボードや古い画面を触らないため
  - 演出つきの切り替えは、`zoomTransitions` の `enter` / `leave` を通す。演出の途中でもう一度呼ばれても、切り替えは 1 回だけになる
  - ブラウザの「戻る」と「進む」は、`popstate` で届いた時点で URL が変わっている。階層を移るときの演出は、画面が `setPopLeave` に登録した処理で行う（行き先のパスから、入るのか戻るのかを決めて、`zoomTransitions` の `enterOnPop` / `leaveOnPop` を呼ぶ）。**ここから `navigate` を呼ばないこと**（履歴が 1 つ増える）
  - ページを開いたときは、付箋全体の中央から始める（ヘッダーの「中央へ移動」と同じ `centerOnNotes`）。**表示位置は覚えない。** ブラウザに保存するのは、ページごとの倍率だけ（`src/web/viewport-store.ts`）。保存は、入ってきたときの演出が済んでから始め、切り替えの演出の前に止める。**演出で変えた倍率を、見ていた倍率として保存しないこと**
  - ページの削除と、認証の切れた後は、ページ全体の読み込みで移る
- **画面の文言は、日本語と英語を持つ**（設計は `docs/plan.md` のフェーズ 9）
  - **画面の文言を、コードに直接書かないこと。** `src/web/i18n/ja.ts`（正）と `src/web/i18n/en.ts` の両方にキーを足し、`t('キー')` で取り出す。`en.ts` は、`ja.ts` と同じキーと引数を持つことを、型で確かめている（足りなければ型エラー）
  - **値を埋め込む文言は、文言の側を関数にする。使う側で文字列を足さない**（日本語と英語で語順が違う）。英語の単数形と複数形は、`en.ts` の `count` で書き分ける
  - 言語は、端末で選んだ言語（Cookie の `wk_lang`）、ブラウザの言語の設定、`en` の順で決める（`src/shared/i18n.ts` の `resolveLang`。画面は `navigator.languages`、サーバーは `Accept-Language` を渡す）。選んだ言語は、**`localStorage` ではなく Cookie に持つ**（サーバーも読むため）
  - 言語は、画面を読み込んだときに決まり、開いている間は変わらない。切り替えは、Cookie を書いて読み込み直す（`src/web/toolbar.ts` の `switchLang`）。文言を定数に入れているモジュールがあるので、表示中の画面の文言を差し替える仕組みは作らない
  - 使い方の付箋の文面は、`src/shared/guide.ts` に言語ごとに持つ（サーバーも使う）。最初のページは、一覧を最初に開いた人の言語で作り、その後は変わらない
  - サーバーが付ける操作の要約は、文言ではなく符号で保存する（`src/shared/op-summary.ts`。`system:page-created` など）。画面が、今の言語の文言にして出す。**サーバーで、利用者に見せる文を組み立てて保存しないこと**
  - wema が描く部分（ポップアップ、ツールバー、畳んだ付箋の開閉のリンク）の文言は、wema の `labels` で渡す（wema 0.10.0）。**ボードを作るところでは、必ず `labels: WEMA_LABELS`（`src/web/toolbar.ts`）を渡すこと。** 日本語は wema に同梱の `jaLabels`、英語は wema の既定。`foldLabels` は使わない
  - autoSize の付箋の大きさは、wema が読み込んだときに計測する（wema 0.10.0）。**ボードは、画面に出ている要素の中に作ること。** 出ていない要素の中では計測されず、接続線が、保存された大きさで引かれる（使い方の画面は、ボードを置く要素を先に画面へ足している）
  - 対象にしていないもの: MCP のツールの説明と返す文、API のエラーの `error`（英語）
- **ブックマーク**（`src/web/bookmarks.ts`）: ページの画面の表示名の後ろの ★ で、そのページを自分のブックマークに入れる。利用者ごとに D1 の `bookmarks` に保存する。**ブラウザ（localStorage）には保存しない**（別の端末でも同じ一覧を出すため）
- **他のページへ移るための一覧**（`src/web/bookmarks.ts` の `pageNavMenu`。ページの画面と一覧の画面の、ヘッダーの右のボタン）: ブックマークしたページ（付けた順、★ の印）を上に固定する。その下に、最近更新のあったページを 5 件出す（子ページも含む。ブックマークしたページは重ねて出さない）。上の入力欄に文字を入れると、全部のページから、表示名かスラッグにその文字を含むページを出す（`GET /api/pages?name=`。本文は見ない。新しい順に 30 件までで、それより多いときは、その旨を出す）。Enter で、先頭のページへ移る。開くたびに読み直す。並べる順を決める計算は `src/web/page-nav.ts` の `navEntries`（DOM に触らない）
  - タッチの端末（`pointer: coarse`）では、開いたときに入力欄へフォーカスを入れない（キーボードが出て、一覧が隠れる）
- 履歴に当たるものは 2 つあり、置き場所を分けてある
  - 最近の変更: 上の「他のページへ移るための一覧」に、変更の新しい順のページを 5 件出す
  - 操作の履歴: ページの画面のメニューから開く。そのページの ops の一覧と取り消しを、画面に重ねて出す（`src/web/toolbar.ts` の `modal`）。取り消しの結果は、重ねた枠の中に出す（ボードの上の通知は、背景の下になる）
- サイト内へのリンクを画面に置くときは、`src/web/dom.ts` の `appLink` で作る（読み込みなしで切り替わる。修飾キーつきのクリックは、新しいタブで開く）
- **使い方の付箋**は `src/shared/guide.ts` にあり、次の 2 か所で使う。付箋は autoSize で、幅は最も長い行で決まる。**長い行を足すと隣の付箋と重なるので、1 行を短く保つこと**
  - 最初のページ（スラッグは `first-page`）: ページが 1 つもない環境で、一覧（`GET /api/index`）を最初に開いたときに、サーバーが、開いた人の言語で作る（`src/worker/first-page.ts`）。作ったことを D1 の `settings` の `first_page` に記録するので、すべてのページを消しても作り直さない。マイグレーションを適用した時点でページのあった環境には、作らない
  - 使い方の画面（`/help`、`src/web/help-view.ts`）: ページの画面のメニューの「使い方」から移る。試すためのボードで、編集できるが、**サーバーに保存せず、同期もしない**（ページとして置くと、内容が保存されて他の人にも見える）。画面を離れると消える
- ページの削除は画面からだけ行える（`DELETE /api/pages/<slug>`）。ページの画面のメニューと、一覧の付箋の上のボタンから行う。DO の内容と D1 の索引を消し、取り消しはできない。接続中のブラウザはコード 4410 で閉じ、ブラウザは再接続せずに一覧へ戻る。貼った画像は R2 に残る
- **削除したページが、古い書き込みで作り直されないようにする仕組みが 2 つある。どちらも外さないこと**
  - epoch: ページを作るたびに変わる値（DO の `meta`）。`snapshot` と `meta` でブラウザに渡し、ブラウザは再接続の `hello` で送り返す。サーバーの今の値と違えば、ページが削除されたか作り直されているので、4410 で閉じる。切断中だったタブが、未確定の操作を送り直すのを防ぐ
  - DO の `write()`: `applyOps` と `revert` はこれを通す。順番を待っている間に削除が始まった書き込みは、実行せずに拒否する
- D1 への反映（alarm）は、書き込みや削除と同じ順番待ち（`inOrder`）に入れてある。索引の書き込みが、ページの削除と前後しないようにするため

## セキュリティ

- 付箋の text は HTML。wema は描画時に許可リスト方式でサニタイズしているが、保存されるのは innerHTML そのもの。サーバー側（DO の `applyOps` 内）で必ずサニタイズする。MCP 経由の入力も例外なく通す
- Workers には DOMParser がないので、wema と同じ許可リスト（タグ・属性・style プロパティ・`javascript:` / `data:text/html` の除去）を HTMLRewriter で実装する。確認済みの挙動（`test/runtime.test.ts` で固定）:
  - DO 内で使える
  - テキスト中のエンティティ（`&lt;` など）は復号も再エスケープもされず、入力のまま出力される
  - 要素の外にあるコメントは `on('*')` の `comments` では届かない。`onDocument` の `comments` で除去する
- 複数人で使う段階では iframe の src を wema の埋め込み変換対象ドメイン（YouTube / Vimeo / Spotify / Google Slides / Google Maps / X / Bluesky）に限定する
- 画像は `onImageUpload` で R2 に上げ、text には URL だけを入れる。data URL の画像は受け付けない（サイズ上限の問題があるため）。wema のサニタイザは画像などの `data:` URL を許可するが、サーバーのサニタイザは除去する。URL のスキームの許可リスト（`http` / `https` / `mailto` / `tel`）は wema と同じにしてある
- ボードの内容は LLM に渡る。付箋に書かれた指示文（プロンプトインジェクション）で agent が意図しない削除をする可能性があるため、取り消し機能を必ず用意し、削除系ツールの扱いは運用しながら見直す

## 未決定事項

実装前・実装中に決める。決まったらこのファイルを更新すること。
実装の順序と、各項目の現時点の案は `docs/plan.md` にある。

- 履歴閲覧 UI の範囲
- agent が作った付箋・変更のブラウザでの見せ方
- claude.ai / ChatGPT それぞれの定期実行機能からカスタムコネクタが使えるかの確認（MCP サーバーの実装後に実際に試す。ChatGPT は公式の記述を確認できていない）

決定済み（2026-10-03）: ページ名と URL、Wiki リンクの記法、revert の衝突時の扱いは本文に反映した。ルーティングのフレームワークは Hono、テストは `@cloudflare/vitest-plugin`（vitest `^4.1.0`）を使う。

---

## wema 側で必要な変更

wema-kake の同期と LLM 連携は以下の wema の機能追加が前提。未実装なら wema（github.com/kan/wema）に issue を立ててから進めること。
issue は下記を 1 つのまとめ issue として立て、各項目をチェックリストにする。autoSize のバグは性質が違うので別 issue にする。

issue は 2026-10-03 に作成済み。**どちらも wema v0.4.0 で対応済み**（wema-kake が使う版は `package.json` にある。付箋の `meta` と `renderNote` は 0.8.1 から使える。**0.8.0 は使わないこと**。付箋の本文に `class="wema-note-custom"` の要素があると、`renderNote` の表示が壊れる）。下の下書きは作成時点の写しで、実際の API は wema の README を正とする。

- まとめ issue: https://github.com/kan/wema/issues/50
- autoSize のバグ: https://github.com/kan/wema/issues/51

### まとめ issue 下書き

**タイトル:** リアルタイム同期・LLM 連携（wema-kake）対応のための API 追加

**背景**

wema を使った Wiki「wema-kake」（Cloudflare Workers + Durable Objects）で、複数クライアント間の付箋同期と、LLM（リモート MCP / WebMCP）からの読み書きを行いたい。
現状の公開 API では次の理由でこれらが組めない。

- ドラッグ・リサイズ中は `note:update` / `change` が連続で発火し、操作の確定点を外から判別できない
- 外部から変更を反映すると通常の操作と同じイベントが出て送り返してしまい（エコー）、Undo 履歴にも積まれる
- `updateNote` / `addNote` 等は readOnly・viewOnly 中に何もしないため、閲覧者の画面にリモートの変更を反映できない
- 画像は data URL で text に直接埋め込まれるため、保存先のサイズ上限に当たる
- 自動レイアウト・整列・等間隔配置は WemaBoard のメソッドとしてしか呼べず、サーバー側（ブラウザなし）で使えない

HistoryManager がすでに「Undo 1 回分 = ユーザー操作 1 回分」の差分付きデルタを作っているので、これを公開すれば同期の単位としてそのまま使える。

**やること**

- [ ] `history:commit` イベントと `HistoryDelta` 型の export
  - ペイロード: `{ deltas: HistoryDelta[]; origin: 'user' | 'undo' | 'redo' | 'agent' }`
  - HistoryManager の `commitPending()` で発火する
  - Undo / Redo 時も発火させる。現在は `recording = false` で再生するためデルタが作られないので、Undo では逆向きのデルタ（逆順、create ↔ delete、before ↔ after の入れ替え）、Redo では元のデルタを流す
  - `HistoryDelta` は現在の内部デルタ型（`note:create` / `note:update`（before/after）/ `note:delete` / `edge:*`）をそのまま公開する
- [ ] `applyRemote(deltas: HistoryDelta[])` の追加
  - readOnly / viewOnly を無視して適用する
  - Undo 履歴には積まない（`history:commit` も発火しない）。既存の Undo 履歴は消さない
  - 発火する `note:*` / `edge:*` のペイロードに `origin: 'remote'` を付ける（ローカル由来は `origin: 'local'`）
  - 編集中の付箋の中身を上書きしない既存の挙動（`updateNoteElement` のフォーカス判定）は維持する
- [ ] `onImageUpload` オプションの追加
  - 型: `onImageUpload?: (file: File) => Promise<string>`（アップロード先 URL を返す）
  - 指定時は data URL の代わりに返された URL で `<img>` を挿入する
  - 未指定時は現状どおり data URL で埋め込む（スタンドアロン HTML 版のため後方互換を維持）
  - 案: アップロード完了後に挿入し、失敗時は挿入せずエラーイベントを出す（仮表示の要否は実装時に判断）
- [ ] レイアウト関数を DOM 非依存の純粋関数として export
  - 対象: 自動レイアウト（現 `autoLayout`）、整列（`alignNotes`）、等間隔配置（`distributeNotes`）
  - 現在の実装は NoteManager の `getNote` / `updateNote` を経由しているだけで、計算自体は付箋の座標・サイズと接続線のみに依存している。`(notes, edges, options) => Array<{ id, x, y }>` のような形にして、WemaBoard のメソッドはそれを呼んで `updateNote` する薄いラッパーにする
  - wema-kake ではサーバー（Durable Object）上で MCP の `auto_layout` ツールから使う
- [ ] `board.batch(fn)` の公開（WebMCP 対応時に必要。優先度低）
  - 内部の `historyManager.beginBatch()` / `endBatch()` で `fn` を包み、中の操作を Undo 1 回分・`history:commit` 1 回にまとめる
  - オプションで `origin`（例: `'agent'`）を指定でき、その `history:commit` の `origin` に反映される
- [ ] zIndex の扱いを README に明記する（コード変更なし）
  - `bringToFront` は zIndex を変えるがイベントも履歴も出ない。wema-kake では zIndex を各クライアントの表示状態として同期対象外にするため、この挙動は維持し、ドキュメントで「zIndex はローカルな表示状態」と明記する

**関連して確認したいこと**

- viewOnly 終了時の位置・折り畳み状態の復元（`positionSnapshot` / `collapsedEdgeSnapshot`）は `updateNote` / `updateEdge` 経由のため、通常の操作として `note:update` が出て履歴にも積まれる。同期時は「参照モード中に届いたリモートの変更を巻き戻して送信してしまう」ことになるので、復元は履歴に積まず `history:commit` も出さない形にしたい
- `change` イベントは経路によって `data` が `undefined` で発火する（`syncNoteContent`、blur 時、ドラッグ終了時など）。README のペイロード表記と合わせるか、常に `exportData()` を入れるか揃えたい
- 将来的に「collapsed を同期対象から外す」オプションが必要になる可能性がある（wema-kake で運用してから判断）

### 別 issue: autoSize の prev が更新後の値になっている

`NoteManager.syncAutoSize` で、付箋の width/height を書き換えた後に `prev` を作っているため、`note:update` の `prev` と `note` が同じ値になり、Undo 履歴に差分が残らない。`prev` は書き換え前にコピーする。
（`updateNoteElement` の autoSize 再計算は `note:update` を出さず `change` のみ発火している点も合わせて確認する）
