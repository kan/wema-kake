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

## 認証

- **ブラウザ向けの画面と WebSocket**: Cloudflare Access のアプリケーションで保護する
- **MCP エンドポイント（`/mcp` と OAuth 用のパス）**: Access アプリケーションの保護対象から外し、Worker 自身が `@cloudflare/workers-oauth-provider` で OAuth 2.1 を処理する。ログインの実体は Access for SaaS（OIDC）に委ねるので、認証の仕組みは Access に一元化される
- claude.ai / ChatGPT のコネクタはそれぞれのサーバーから接続してくるため、`/mcp` まで Access のログイン画面で塞ぐと接続できない。パスの切り分けを間違えないこと
- 参考: Cloudflare 公式の「Secure MCP servers with Access for SaaS」とサンプル `cloudflare/ai/demos/remote-mcp-cf-access`
- **Worker でも Access の JWT（`Cf-Access-Jwt-Assertion`）を検証する**（`src/worker/access.ts`）。Access の設定を誤っても未認証のリクエストを通さないためと、変更の主体（`user:<email>`）を得るため。Worker に届くリクエストすべてに掛けてある（`src/worker/index.ts` の `app.use(requireAccess)`）。**認証なしで公開するパス（`/mcp` と OAuth 用）を足すときは、このアプリの外に置くこと。このミドルウェアを外したり、パスを列挙する形に戻したりしない**
  - 設定は `wrangler.jsonc` の `vars` の `ACCESS_TEAM_DOMAIN`（`https://<team>.cloudflareaccess.com`）と `ACCESS_AUD`（Access アプリケーションの AUD タグ）。両方が空なら 500 を返す
  - ローカル開発は `.dev.vars` の `DEV_USER_EMAIL` を使う（`.dev.vars.example` を参照）。localhost へのリクエストでだけ有効で、Access の設定があれば無視される
- WebSocket の接続要求は `Origin` を確かめ、他のオリジンからの接続を断る（WebSocket は同一オリジンの制約を受けず、Access の Cookie は他サイトからの接続にも付くため）
- 主体はクライアントの自己申告を使わない。Worker が認証結果から決めて DO に渡す
- `clientId` はクライアントの自己申告なので、**同じ送信元かどうかの判定（再送の判定、`fixups` の宛先）には主体も合わせて使う**
- WebSocket は開いたままになるので、接続時の JWT の期限（`exp`）を接続ごとに持つ。期限を過ぎた接続は、受信も配信もせずにコード 4401 で閉じる。クライアントは再読み込みして認証し直す

## DO 内スキーマ（ページ単位）

```sql
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,   -- 'slug', 'title', 'seq', 'version' など
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
  extra      TEXT,                   -- 将来 WemaNote に増えるフィールド用の JSON
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
  updated_at INTEGER NOT NULL
);

CREATE INDEX pages_updated_at ON pages (updated_at);

CREATE TABLE links (
  from_page TEXT NOT NULL,
  to_page   TEXT NOT NULL,
  PRIMARY KEY (from_page, to_page)
);

CREATE INDEX links_to_page ON links (to_page);

-- rowid は pages.id と同じ値にする
CREATE VIRTUAL TABLE pages_fts USING fts5(title, plain_text, tokenize = 'trigram');
```

全文検索は FTS5 の trigram トークナイザを使う（`migrations/0002_fts.sql`）。ローカル（miniflare）では動作を確認し `test/runtime.test.ts` で固定した。本番の D1 では未確認なので、最初のデプロイ時にマイグレーションが通るか確認すること。3 文字未満の検索語は trigram に一致しないため LIKE を併用する。仮想テーブルがあると D1 を export できないので、FTS のテーブルは削除して作り直せるようにマイグレーションを分ける。

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
| `GET /api/pages?limit=&updated_after=` | ページ一覧（D1）。更新の新しい順 |
| `GET /api/search?q=` | 全文検索（D1）。3 文字以上は FTS、3 文字未満は LIKE |
| `GET /api/pages/<slug>` | スナップショット（`seq`、`title`、付箋と接続線） |
| `GET /api/pages/<slug>/backlinks` | このページへリンクしているページ（D1） |
| `PUT /api/pages/<slug>/title` | 表示名の変更（本文は `{ "title": "..." }`）。空文字で未設定に戻す。書き込みのないページに対して呼ぶとページが作られる |
| `POST /api/images` | 画像のアップロード（本文は画像のバイト列、`Content-Type` は png / jpeg / gif / webp / avif）。`{ "url": "/img/<key>" }` を返す。10MB まで |
| `GET /img/<key>` | 画像の取得（R2） |
| `GET /api/pages/<slug>/ops?agent=1&limit=` | 最近の操作（新しい順）。`agent=1` で agent の操作に絞る |
| `POST /api/pages/<slug>/ops/<seq>/revert` | 操作の取り消し（本文は `{ "clientId": "...", "opId": "..." }`）。`{ seq, applied, skipped }` を返す |
| `GET /ws/<slug>` | WebSocket |

## ページ名と URL

- URL は `/p/<slug>`。スラッグは `^[a-z0-9][a-z0-9-]{0,63}$` で、作成時に決めて後から変えない
- DO は `idFromName(slug)` で引く
- 表示名（タイトル）はスラッグとは別に DO の `meta` に持ち、D1 の `pages.title` に反映する。タイトルの変更は `applyOps` とは別の DO メソッドで行う

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
  | { type: 'hello'; clientId: string; lastSeq?: number }
  | { type: 'ops'; opId: string; deltas: HistoryDelta[] }       // 原子的に適用
  | { type: 'preview'; noteId: string; x?: number; y?: number; width?: number; height?: number } // 保存しない
  | { type: 'presence'; selection: string[]; editing?: string };

// Server → Client
type ServerMsg =
  | { type: 'snapshot'; seq: number; title: string | null; data: { version: 1; notes: WemaNote[]; edges: WemaEdge[] } }
  | { type: 'meta'; title: string | null }   // 表示名が変わった。seq は進まない
  | { type: 'ops'; seq: number; actor: string; clientId: string; opId: string; deltas: HistoryDelta[]; summary?: string;
      reverts?: number;           // 取り消しなら、取り消した対象の seq（「取り消し」の節を参照）
      fixups?: HistoryDelta[] }   // fixups は送信元にだけ付ける（後述）
  | { type: 'reject'; opId: string; reason: string; current?: { notes: WemaNote[]; edges: WemaEdge[] } }
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
- クライアントは wema の `history:commit` を `ops` として送り、受信した `ops` は `applyRemote()` で適用する（自分の `opId` のものは適用済みなのでスキップ）
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
- `reject` を受けたクライアントは `current` を `applyRemote()` で反映し、楽観的に適用した変更を戻す
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

### ツール案

| ツール | 内容 |
| --- | --- |
| `list_pages` | D1 からページ一覧（名前・タイトル・更新日時・付箋数）を返す。更新日時で絞り込める |
| `search_pages` | D1 の全文検索 |
| `read_board` | 1 ページの付箋（id・タグ除去したテキスト・座標・サイズ・色・作成者）と接続線（from/to/label）を返す |
| `add_notes` | 付箋を複数追加する。位置を省略した場合は関連付け先の付箋の近くに自動配置 |
| `update_notes` | テキスト・色・位置・サイズを複数更新する |
| `delete_notes` | 付箋を削除する（接続線も合わせて削除） |
| `connect_notes` / `disconnect_notes` | 接続線の追加・削除（ラベル指定可） |
| `auto_layout` | 接続線に基づく自動レイアウト。wema のレイアウト関数を DO 側で実行する（末尾の wema 側の変更を参照） |
| `revert_operation` | agent 自身の直前の操作を取り消す（後述の取り消し機能を使う） |

- `add_notes` / `update_notes` のテキストはプレーンテキスト（改行は `<br>` に変換してエスケープ）を基本とし、箇条書きやチェックリストだけ限定的に受け付ける案。最終的には必ずサーバーのサニタイズを通す
- ページの作成・削除・改名のツールは当面提供しない
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
- ブラウザには「最近の agent の操作」一覧と取り消しボタンを用意する。定期タスクで LLM が勝手に整理する前提なので、早めに実装する

### WebMCP（後から追加）

ページを開いている状態での LLM 操作用に、同じツール定義を WebMCP（`document.modelContext.registerTool`、旧 `navigator.modelContext` にも対応）でも公開する。2026 年 10 月時点では WebMCP は実験段階で、ネイティブに呼べるエージェントは限られるため優先度は低い。
WebMCP 版はブラウザ内で wema の API を直接呼ぶので、LLM の変更がブラウザの Undo 履歴に積まれ Ctrl+Z で戻せる。そのために wema の `board.batch()` と `origin: 'agent'` が必要（末尾参照）。

## セキュリティ

- 付箋の text は HTML。wema は描画時に許可リスト方式でサニタイズしているが、保存されるのは innerHTML そのもの。サーバー側（DO の `applyOps` 内）で必ずサニタイズする。MCP 経由の入力も例外なく通す
- Workers には DOMParser がないので、wema と同じ許可リスト（タグ・属性・style プロパティ・`javascript:` / `data:text/html` の除去）を HTMLRewriter で実装する。確認済みの挙動（`test/runtime.test.ts` で固定）:
  - DO 内で使える
  - テキスト中のエンティティ（`&lt;` など）は復号も再エスケープもされず、入力のまま出力される
  - 要素の外にあるコメントは `on('*')` の `comments` では届かない。`onDocument` の `comments` で除去する
- 複数人で使う段階では iframe の src を wema の埋め込み変換対象ドメイン（YouTube / Vimeo / Spotify / Google Slides / Google Maps / X / Bluesky）に限定する
- 画像は `onImageUpload` で R2 に上げ、text には URL だけを入れる。data URL の画像は受け付けない（サイズ上限の問題があるため）
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

issue は 2026-10-03 に作成済み。**進捗と最新の内容は issue を正とする**（下の下書きは作成時点の写し）。

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
