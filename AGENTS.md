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
| 認証 | Cloudflare Access（MCP は Access を上流 IdP にした OAuth） |
| LLM 連携 | リモート MCP サーバー（Workers 上、`workers-oauth-provider`）。WebMCP は後から追加 |
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

## デプロイ

- **このリポジトリは公開している。デプロイ先ごとの値を、git に入れるファイルへ書かないこと。** 対象は、Worker の名前、ホスト名、D1 と KV の ID、Access のチームドメインと AUD タグ、`SITE_ORIGIN`。文書（`docs/`、この `AGENTS.md`）にも、実際のホスト名や ID を書かない
- `wrangler.jsonc` は、ローカル開発とテストに使う。値は空のまま保つ
- デプロイ用の設定は `wrangler.deploy.jsonc`（`.gitignore` 済み）。`wrangler.jsonc` をコピーして、デプロイ先の値を書く。**`wrangler.jsonc` のバインディングや `run_worker_first` を変えたら、`wrangler.deploy.jsonc` にも同じ変更を入れること**（wrangler は設定を継承できないので、丸ごとのコピーになっている）
- デプロイは `npm run deploy`（`scripts/deploy.mjs`）。本番の D1 のマイグレーションを適用してから、Worker をデプロイする。設定は、`wrangler.deploy.jsonc` があればそれを、なければ `wrangler.jsonc` を使う（後者は、README の「Deploy to Cloudflare」ボタンからのデプロイのため。**`wrangler.deploy.jsonc` を消したまま `npm run deploy` を実行すると、`wrangler.jsonc` の名前で別の Worker ができる**）
- マイグレーションだけを適用するには `npx wrangler d1 migrations apply DB --remote --config wrangler.deploy.jsonc`
- secret は `npx wrangler secret put <名前> --config wrangler.deploy.jsonc` で入れる
- 最初のデプロイの手順
  1. D1、KV、R2 バケットを作り、ID を `wrangler.deploy.jsonc` に書く。マイグレーションを適用して、デプロイする。**Access の値が空の間、`/api`、`/ws`、`/img` は 500、`/authorize` は 503 を返す**（保護のない状態では、データを読み書きできない）
  2. 画面用の Access アプリケーション（Self-hosted）を作り、チームドメインと AUD タグを `wrangler.deploy.jsonc` に書いて、デプロイし直す。チームドメインは、末尾のスラッシュを付けない
  3. 同じホスト名で、Access アプリケーションをもう 1 つ作る。パスは `/mcp`、`/authorize`、`/callback`、`/token`、`/register`、`/.well-known/*`、ポリシーは Bypass（Everyone）
  4. Access for SaaS（OIDC）のアプリケーションを作る。リダイレクト先は `https://<ホスト名>/callback`、スコープは `openid`、`email`、`profile`。**このアプリケーションにも、Allow のポリシーが要る**（画面用のアプリケーションとは別。ないと、ログインの後に「That account does not have access」と出る）。表示された値と、乱数で作った `COOKIE_ENCRYPTION_KEY` を、secret に入れる
  5. 未ログインの `curl` で確かめる。保護したパスは Access のログイン画面へ転送され、`/mcp` は 401、`/authorize` はクライアントの登録後に 200 を返す
  - ポリシーを直した後は、MCP のクライアントの側で、接続を最初からやり直す。Access のエラーの画面からログインし直すと、戻り先が失われて、App Launcher の案内が出る

## 認証

- **ブラウザ向けの画面と WebSocket**: Cloudflare Access のアプリケーションで保護する
- **MCP エンドポイント（`/mcp` と OAuth 用のパス）**: Access アプリケーションの保護対象から外し、Worker 自身が `@cloudflare/workers-oauth-provider` で OAuth 2.1 を処理する。ログインの実体は Access for SaaS（OIDC）に委ねるので、認証の仕組みは Access に一元化される
- claude.ai / ChatGPT のコネクタはそれぞれのサーバーから接続してくるため、`/mcp` まで Access のログイン画面で塞ぐと接続できない。パスの切り分けを間違えないこと
- 参考: Cloudflare 公式の「Secure MCP servers with Access for SaaS」とサンプル `cloudflare/ai/demos/remote-mcp-cf-access`
- **Worker の入口は `OAuthProvider`**（`src/worker/index.ts`）。`/mcp` は Worker が発行したアクセストークンで保護し、`/token`、`/register`、`/.well-known/*` は `OAuthProvider` が処理する。`/authorize` と `/callback` は `src/worker/mcp/authorize.ts`、それ以外は下の Access の JWT 検証を掛けたアプリ（`app`）に届く
  - Access for SaaS の設定は wrangler secret で入れる: `ACCESS_CLIENT_ID`、`ACCESS_CLIENT_SECRET`、`ACCESS_TOKEN_URL`、`ACCESS_AUTHORIZATION_URL`、`ACCESS_JWKS_URL`、`COOKIE_ENCRYPTION_KEY`。**1 つでも欠けていれば `/authorize` と `/callback` は 503 を返す**（認可を完了できないので、`/mcp` は誰も使えない）
  - OAuth のデータ（クライアントの登録、認可コード、トークン）は KV（`OAUTH_KV`）に置く
  - `/callback` では Access の ID トークンの署名、期限、宛先（`ACCESS_CLIENT_ID`）を `jose` で検証する。**サンプルの `verifyToken` は宛先を確かめないので使わない**
  - **認可の state は、承認したブラウザに Cookie（`__Host-OAUTH_STATE`）で結び付ける。`/callback` はこの Cookie が state と対応しなければ断る。この検査を外さないこと**。クライアントの登録（`/register`）は誰でもできるので、検査がないと、攻撃者が自分のクライアントで承認まで済ませて Access のログインの URL を利用者に踏ませるだけで、利用者の権限のトークンを得られる
  - 本人確認は認可のときの 1 回だけ。Access から外した人も、リフレッシュトークンの期限（`OAuthProvider` の既定で 30 日）までは MCP を使える。すぐに止めるには、KV（`OAUTH_KV`）からその人の認可を消す
  - POST `/authorize` はフォームから認可要求を受け取る。**登録済みのクライアントとリダイレクト先かを確かめ直すこと**（`isRegisteredRequest`）
  - 変更の主体は `agent:<OAuth クライアントの名前>`（`actorFromProps`）。認可のときに `props` に保存した値から決める。クライアントの名前は自己申告なので、権限の判定には使わない（誰が認可したかは `props.email`）
  - `src/worker/mcp/workers-oauth-utils.ts` はサンプルの無改変コピー（MIT）。**ここを直接編集しない**。上流の更新を取り込むときは丸ごと差し替える
- **Worker でも Access の JWT（`Cf-Access-Jwt-Assertion`）を検証する**（`src/worker/access.ts`）。Access の設定を誤っても未認証のリクエストを通さないためと、変更の主体（`user:<email>`）を得るため。`app` に届くリクエストすべてに掛けてある（`src/worker/index.ts` の `app.use(requireAccess)`）。**認証なしで公開するパス（`/mcp` と OAuth 用）は、このアプリの外に置くこと。このミドルウェアを外したり、パスを列挙する形に戻したりしない**
  - 設定は `wrangler.jsonc` の `vars` の `ACCESS_TEAM_DOMAIN`（`https://<team>.cloudflareaccess.com`）と `ACCESS_AUD`（Access アプリケーションの AUD タグ）。両方が空なら 500 を返す
  - ローカル開発は `.dev.vars` の `DEV_USER_EMAIL` を使う（`.dev.vars.example` を参照）。localhost へのリクエストでだけ有効で、Access の設定があれば無視される
- WebSocket の接続要求は `Origin` を確かめ、他のオリジンからの接続を断る（WebSocket は同一オリジンの制約を受けず、Access の Cookie は他サイトからの接続にも付くため）
- 主体はクライアントの自己申告を使わない。Worker が認証結果から決めて DO に渡す
- `clientId` はクライアントの自己申告なので、**同じ送信元かどうかの判定（再送の判定、`fixups` の宛先）には主体も合わせて使う**
- WebSocket は開いたままになるので、接続時の JWT の期限（`exp`）を接続ごとに持つ。期限を過ぎた接続は、受信も配信もせずにコード 4401 で閉じる。クライアントは再読み込みして認証し直す

## DO 内スキーマ（ページ単位）

```sql
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,   -- 'slug', 'title', 'seq', 'version', 'epoch', 'index_hash', 'parent'（親ページのスラッグ）
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
  layout     TEXT                 -- 付箋の配置（[[x, y, 幅, 高さ, 色], ...] の JSON）。子ページの付箋の表示に使う
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
- 検索とリンクに関わる内容（表示名、テキスト、リンク先）が前回の反映から変わっていなければ、`pages` の `note_count` と `updated_at` だけを書く。付箋の移動や色の変更のたびに全文検索の索引を書き直さないため。前回の内容のハッシュは DO の `meta` の `index_hash` に持つ
- alarm が設定済みかどうかは `ctx.storage.getAlarm()` で確かめる（メモリには持たない）
- 絶対 URL のリンクを拾うには `wrangler.jsonc` の `vars` の `SITE_ORIGIN` を設定する。空のときは相対 URL（`/p/<slug>`）だけを拾う
- `ops` は 30 日以内か直近 1000 件のどちらかに収まっていれば残す

## HTTP API

すべて Access の認証が要る。状態を変えるリクエストは、他のオリジンからのものを断る。

| メソッドとパス | 内容 |
| --- | --- |
| `GET /api/session` | 認証が有効かの確認用。`{ "actor": "user:<email>" }` を返す |
| `GET /api/index` | 一覧のボード用。ルートのページ（表示名、本文の冒頭、更新日時、子ページの数）と、ルート同士のリンクをまとめて返す。新しい順に 500 ページまで。子ページと孫ページは返さない。ページが 1 つもなければ、最初のページを作ってから返す（1 回だけ。「画面」の節） |
| `POST /api/pages-info` | ページの概要（表示名、付箋の数、親、付箋の配置）をまとめて返す（本文は `{ "names": [...] }`、200 件まで）。子ページの付箋の表示に使う。まだ索引にないページ（作ったばかり）は DO から補い、付箋の配置は null で返す。存在しないページは結果に入らない |
| `GET /api/pages/<slug>/ancestors` | 先祖のページを、ルートから順に返す（パンくず用） |
| `GET /api/pages?limit=&updated_after=` | ページ一覧（D1）。更新の新しい順 |
| `POST /api/pages/<slug>` | ページの新規作成（本文は `{ "title": "..." }`。表示名は省略できる）。すでにあれば 409 を返し、何も変えない |
| `DELETE /api/pages/<slug>` | ページの削除。取り消しはできない |
| `GET /api/search?q=` | 全文検索（D1）。3 文字以上は FTS、3 文字未満は LIKE。`roots=1` を付けると、一致したページのスラッグと、そのルートのスラッグだけを返す（一覧の絞り込み用。スラッグも照合する） |
| `GET /api/pages/<slug>` | スナップショット（`seq`、`title`、付箋と接続線） |
| `GET /api/pages/<slug>/backlinks` | このページへリンクしているページ（D1） |
| `GET /api/bookmarks` | 自分のブックマーク（付けた順。`{ "pages": [{ "name", "title" }] }`）。利用者は Access の主体で決まり、他の利用者の分は返さない。索引への反映の前のページは、表示名が null になる |
| `PUT /api/bookmarks/<slug>` | ブックマークを付ける。すでに付いていれば何もしない。ページがなければ 404、1 人 100 件を超えると 400 |
| `DELETE /api/bookmarks/<slug>` | ブックマークを外す。付いていなくても成功を返す |
| `PUT /api/pages/<slug>/title` | 表示名の変更（本文は `{ "title": "..." }`）。空文字で未設定に戻す。書き込みのないページに対して呼ぶとページが作られる。本文に `"mustExist": true` を付けると、作らずに 404 を返す（一覧の画面が使う。古い一覧に残った削除済みのページを作り直さないため） |
| `POST /api/pages/<slug>/notes` | 他のページから移す（写す）付箋を置く（本文は `{ "clientId", "opId", "from", "notes", "edges" }`。`from` は付箋が元あったページのスラッグ）。互いの位置関係を保って、今ある付箋の下に置く。同じ `opId` で送り直しても二重には置かない。置いた後のページの概要（`page`。`POST /api/pages-info` と同じ形で、索引への反映を待たない）を返す。ページがなければ 404（作らない） |
| `POST /api/images` | 画像のアップロード（本文は画像のバイト列、`Content-Type` は png / jpeg / gif / webp / avif）。`{ "url": "/img/<key>" }` を返す。10MB まで |
| `GET /img/<key>` | 画像の取得（R2） |
| `GET /api/pages/<slug>/ops?agent=1&limit=` | 最近の操作（新しい順）。`agent=1` で agent の操作に絞る |
| `POST /api/pages/<slug>/ops/<seq>/revert` | 操作の取り消し（本文は `{ "clientId": "...", "opId": "..." }`）。`{ seq, applied, skipped }` を返す |
| `GET /ws/<slug>` | WebSocket |

## ページ名と URL

- URL は `/p/<slug>`。スラッグは `^[a-z0-9][a-z0-9-]{0,63}$` で、作成時に決めて後から変えない
- DO は `idFromName(slug)` で引く
- 表示名（タイトル）はスラッグとは別に DO の `meta` に持ち、D1 の `pages.title` に反映する。タイトルの変更は `applyOps` とは別の DO メソッドで行う

## ページの階層

設計と経緯は `docs/plan.md` のフェーズ 6.6。定数と判定は `src/shared/hierarchy.ts`。

- **ページを、別のページのボードの上に「子ページの付箋」として置くと、そのページの子になる。** 子ページの付箋は、`meta` に子ページのスラッグを持つ付箋（`meta.page`）。wema の `renderNote` で、本文の代わりに子ページの概要を出す（`src/web/child-notes.ts`）
- 付箋を、子ページの付箋の上へドラッグして放すと、その子ページへ移る。Ctrl / Cmd を押したまま放すと、移さずに写す（`src/web/note-drop.ts`）
  - 手順は「子ページへ送る（`POST /api/pages/<slug>/notes`）→ 成功したら、このページの付箋を消す」の順。**先に消さないこと**（送れなかったときに、付箋が失われる）
  - 他のページへ切り替える前に、送っている途中の付箋を待つ（`dropOntoChildPages` の戻り値の `settled()`。`setBeforeLeave` の中で待っている）。待たないと、送った付箋がこのページにも残る
  - 送り先での id は、ブラウザが新しく振る。送る付箋どうしをつなぐ接続線だけを一緒に送る
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
  | { type: 'snapshot'; seq: number; title: string | null; epoch: string | null; data: { version: 1; notes: WemaNote[]; edges: WemaEdge[] } }
  | { type: 'meta'; title: string | null; epoch: string | null }   // 表示名が変わった、またはページができた。seq は進まない
  | { type: 'ops'; seq: number; actor: string; clientId: string; opId: string; deltas: HistoryDelta[]; summary?: string;
      reverts?: number;           // 取り消しなら、取り消した対象の seq（「取り消し」の節を参照）
      fixups?: HistoryDelta[] }   // fixups は送信元にだけ付ける（後述）
  | { type: 'reject'; opId: string; reason: string; fixups?: HistoryDelta[] }   // fixups はサーバーの現在値に合わせるデルタ
  | { type: 'preview'; clientId: string; noteId: string; x?: number; y?: number; width?: number; height?: number }
  | { type: 'presence'; clientId: string; selection: string[]; editing?: string };
```

### 流れ

- 接続先は `/ws/<slug>`
- 接続時に `hello` を送る。`lastSeq` が `ops` に残っていれば差分の `ops` を、なければ `snapshot` を返す。クライアントは `snapshot.data` を `importData()` で読み込む
  - 差分を返すときは、先に `meta`（表示名の現在値）を送る。表示名の変更は `seq` を進めず、差分に出ないため。`lastSeq` が最新なら `meta` だけを返す
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

- Workers 上に置き、`/mcp` で Streamable HTTP を提供する。OAuth は前述のとおり `workers-oauth-provider` + Access for SaaS
- MCP のハンドラは `agents` の `createMcpHandler`（ステートレス）で作る。`McpAgent` は非推奨で機能凍結されている。公式サンプル `remote-mcp-cf-access` は `McpAgent` のままなので、流用するのは OAuth 部分（Access for SaaS のログイン処理）だけにする
- MCP サーバーは「DO に `ops` を送る一クライアント」として実装する。ツールは該当ページの DO の `applyOps` を呼ぶだけで、検証・サニタイズ・保存・ブロードキャストはブラウザからの変更と共通
- 1 回のツール呼び出し = 1 つの `ops`（`actor: 'agent:<client>'`、`summary` にツール名と LLM が渡した説明）。複数の付箋を動かす整理も 1 つの `ops` にまとめ、後から 1 操作として取り消せるようにする
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
| `connect_notes` / `disconnect_notes` | 接続線の追加・削除（ラベル指定可） |
| `auto_layout` | 接続線に基づく自動レイアウト。wema のレイアウト関数を DO 側で実行する（末尾の wema 側の変更を参照） |
| `revert_operation` | agent 自身の直前の操作を取り消す（後述の取り消し機能を使う） |

- `add_notes` / `update_notes` のテキストはプレーンテキスト。改行は `<br>` にし、`- ` の箇条書きと `- [ ]` / `- [x]` のチェックリストだけを HTML に変換する。それ以外はエスケープするので、LLM は HTML を書けない。変換後も必ずサーバーのサニタイズを通す
- ページへのリンクは `[[スラッグ]]` と書ける（`src/shared/note-text.ts`）。`read_board` の本文にも、ページへのリンクは同じ書式で出る（`src/worker/plain-text.ts`。リンクの文字がスラッグと違えば、文字の後ろに付く）
- 外部のページへのリンクは、本文に URL（`http` / `https`）をそのまま書いたものだけがリンクになる。**リンクの文字は、リンク先の URL そのものにすること。文字とリンク先を別々に指定できる書式（Markdown の `[文字](URL)` など）を足さない**。LLM が、外部の文章の指示に従って、文字でリンク先を偽れないようにするため
  - ユーザー名やパスワードを含む URL（`https://信頼できる名前@別のホスト/`）は、リンクにしない
  - 文字と `href` には、解釈した後の URL（`URL.href`）を使う。国際化ドメイン名は Punycode で出る
  - **解釈した後の URL が、URL に使える文字（`URL_CHARS`）だけでできていることを確かめること。`URL_CHARS` に、引用符と山かっこを足さない**。ホスト名のパーセントエンコードは復号されるので（`https://x%22y/` → `https://x"y/`）、確かめないと、引用符で `href` の外へ出られる
  - `read_board` は、外部へのリンクを URL の文字として返す。人が貼ったリンクで、文字が URL と違うものは、`文字 <URL>` の形で返す。書き戻しても同じリンク先になるよう、書く側がリンクにしない文字は、パーセントエンコードして返す（`src/worker/plain-text.ts` の `writableUrl`）
  - 残る危険: 指示に従わされた agent が、ボードの内容を URL に埋め込んで貼ること。人が押すと、内容がリンク先へ渡る。URL は画面にそのまま出る。**表示しただけで外へ送られる要素（画像、iframe など）を、MCP から貼れるようにしないこと**
- **ページの作成と、子ページとして置く操作は、ツールにしていない**（LLM との連携を実際に使ってから決める）。`delete_notes` で子ページの付箋を消すと、子ページはルートへ戻る
- ページの作成・削除・改名のツールは当面提供しない。**書き込み系のツールは、存在しないページには適用しない**（`applyOps` の `mustExist`。読んでから適用するまでの間に削除されたページも作り直さない）
- 書き込み系のツールは、記録した操作の番号（`operation`）を返す。LLM はこれを `revert_operation` に渡せる。**何も変わらなかった操作は番号を返さずにエラーにする**（`applyOps` は seq を進めないので、返すと別の操作の番号になる）
- `revert_operation` が取り消せるのは、同じ主体（`agent:<client>`）の操作だけ。`operation` を省略すると、取り消しでない直近の自分の操作が対象になる
- ツールが断る場合（ページがない、付箋がない、本文の競合など）は `ToolError` を投げ、MCP では `isError` の結果として返す。LLM が読んで直せるようにするため
- アドバイスの付箋など agent が作った付箋を見分けられるよう、`created_by` を保存する。見た目での区別（専用の色、バッジ等）は未決定

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
  - 対象にしていないもの: MCP のツールの説明と返す文、MCP の認可の同意の画面、API のエラーの `error`（英語）
- **ブックマーク**（`src/web/bookmarks.ts`）: ページの画面の表示名の後ろの ★ で、そのページを自分のブックマークに入れる。ヘッダーの右のボタンで、ブックマークしたページの一覧を出して移る（ページの画面と一覧の画面）。利用者ごとに D1 の `bookmarks` に保存し、開くたびに読み直す。**ブラウザ（localStorage）には保存しない**（別の端末でも同じ一覧を出すため）
- 履歴に当たるものは 2 つあり、置き場所を分けてある
  - 最近の変更: ヘッダーの右の時計のボタン。変更の新しい順のページ（`GET /api/pages?limit=`。子ページも含む）の一覧を出して移る。ページの画面と一覧の画面に置く（`src/web/bookmarks.ts` の `recentPagesMenu`）
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
