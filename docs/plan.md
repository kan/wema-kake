# wema-kake 設計と実装プラン

`AGENTS.md` の方針を実装に落とすための設計の補足と、作業の順序をまとめる。
方針そのもの（技術構成、スキーマ、プロトコル）は `AGENTS.md` が正で、ここには重複して書かない。

作成日: 2026-10-03

## 1. 前提の確認結果

### wema の現状（v0.3.3、ローカルの `~/wema` で確認）

`AGENTS.md` の「wema 側で必要な変更」に書かれた内容は、現在のコードと一致していた。

- `HistoryManager` の `Delta` 型は `HistoryDelta` 案と同じ形だが、export されていない。`history:commit` に相当するイベントもない
- Undo / Redo は `recording = false` で再生するので、デルタが外に出ない
- `applyRemote`、`onImageUpload`、`board.batch` はない。画像は `FileReader` で data URL にして挿入している
- `layout.ts` の 3 関数は `NoteManager` を引数に取り、`getNote` / `updateNote` を直接呼ぶ
- `sanitize.ts` は `DOMParser` に依存しており、Workers ではそのまま使えない
- `syncAutoSize` は width / height を書き換えた後で `prev` を作っている

issue は次の 2 件を立てた。

- [kan/wema#50](https://github.com/kan/wema/issues/50) リアルタイム同期・LLM 連携対応のための API 追加
- [kan/wema#51](https://github.com/kan/wema/issues/51) autoSize の `note:update` で `prev` が更新後の値になっている

### Cloudflare と MCP まわり（2026-10-03 に公式ドキュメントで確認）

| 項目 | 結果 | 設計への影響 |
| --- | --- | --- |
| DO の SQLite の外部キー | workerd のビルド定義で既定有効（`SQLITE_DEFAULT_FOREIGN_KEYS=1`）。DO のドキュメント本文には記述がない | CASCADE は使える見込み。テストで 1 件確認する |
| DO のトランザクション | `sql.exec()` で `BEGIN` は使えない。`ctx.storage.transactionSync()` を使い、コールバックは同期でなければならない | サニタイズ（非同期）はトランザクションの前に済ませる（3.2 節） |
| Alarm | DO 1 つにつき 1 つ。`setAlarm` は上書き。失敗時は再試行される | D1 反映と `ops` の間引きを 1 つの alarm ハンドラで行う |
| MCP サーバーの実装 | `McpAgent` は非推奨で機能凍結。新規は `createMcpHandler`（ステートレス、DO 不要）が推奨 | `createMcpHandler` を使う。公式サンプル `remote-mcp-cf-access` は `McpAgent` のままなので、OAuth 部分だけ流用する |
| `workers-oauth-provider` | 1.x になった。単一 Worker の `OAuthProvider` 構成は引き続き使える | 1.x で組む。サンプルは 0.8 系なので移行ガイドを読む |
| Access のパス切り分け | 公開したいパスだけを対象にした Access アプリを別に作り、Bypass ポリシーを付けるのが公式の手段。パスはより具体的なものが優先 | 4 節のとおり |
| Worker 単位の Access 保護 | WebSocket に対応していない | 使わない。ホスト名とパス単位の Access アプリで保護する |
| HTMLRewriter | `removeAndKeepContent()`、属性の列挙と削除、コメントの削除がある。`Response` を経由する必要がある。テキストのエンティティの扱いと DO 内での動作は公式の記述がない | フェーズ 1 で実機確認する |
| D1 の FTS5 | FTS5 は公式に対応。trigram トークナイザは公式の記述がない。仮想テーブルがあると DB を export できない | フェーズ 1 で実機確認する。3 文字未満の検索語は trigram に一致しないので LIKE を併用する |
| テスト | 公式の標準は `@cloudflare/vitest-plugin`（vitest `^4.1.0`。vitest 5 は未対応）。DO の SQLite、Alarm、Hibernation をテストできる | これを使う。DO の WebSocket のテストはストレージ分離と併用できないので `--max-workers=1 --no-isolate` で流す |
| claude.ai の定期実行 | Claude Code の routines は claude.ai のコネクタを呼べる。カスタムコネクタを付けられないという issue（anthropics/claude-code#63233）があり、解消済みかは未確認 | フェーズ 6 の完了後に実際に試す |
| ChatGPT の定期実行 | カスタム MCP を呼べるという公式の記述は確認できなかった | 同上。使えなければ claude.ai のみで運用する |

## 2. 今回決めたこと

| 項目 | 決定 |
| --- | --- |
| ページ名と URL | URL はスラッグ、表示名は別に持つタイトル。URL は `/p/<slug>` |
| Wiki リンク | 付箋内の `<a href>` を正とする。独自記法は入れない |
| ルーティング | Hono |
| revert の衝突 | 部分適用。衝突したデルタだけスキップし、スキップした対象を返す |

### スラッグとタイトル

- スラッグは `^[a-z0-9][a-z0-9-]{0,63}$`。作成時に決め、後から変えない
- DO は `idFromName(slug)` で引く。D1 の `pages.name` にもスラッグを入れる
- タイトルは DO の `meta`（キー `title`）に持ち、D1 の `pages.title` に反映する。未設定のときはスラッグを表示する
- タイトルの変更は付箋のデルタではないので、`applyOps` とは別の DO メソッド `setTitle` で行う。接続中のクライアントへは `{ type: 'meta'; title: string }` を配信する（`ServerMsg` への追加）
- 存在しないスラッグを開いたら空のボードを表示する。D1 に行ができるのは最初の書き込みの後
- 新規作成の画面ではタイトルとスラッグを入力する。スラッグの初期値は短い乱数にしておき、手で書き換えられるようにする

### Wiki リンクの抽出

- 対象は、`href` のパスが `/p/<slug>` に一致する `<a>`。相対 URL と、自サイトのオリジンを持つ絶対 URL の両方を拾う
- 抽出は D1 反映（alarm）のときに全付箋の text に対して行い、そのページ発の `links` を入れ替える
- リンクを作る操作は wema の既存のリンク機能を使う。ページ名の補完などの入力補助は後から足す

## 3. 設計の補足

### 3.1 ディレクトリ構成

単一パッケージにする。パッケージマネージャは wema と同じ npm。

```
src/
  shared/          Worker とブラウザの両方から読む
    delta.ts       HistoryDelta 型（wema が export するまでの写し）、逆デルタの生成
    protocol.ts    ClientMsg / ServerMsg
    tools.ts       MCP ツールの定義（名前、説明、入力スキーマ）と BoardAccess インターフェース
    slug.ts        スラッグの検証
  worker/
    index.ts       OAuthProvider の export、Hono アプリ、DO クラスの export
    access.ts      Access JWT の検証
    page-do.ts     PageDO（WebSocket、RPC、alarm）
    apply-ops.ts   検証と保存
    sanitize.ts    HTMLRewriter 版のサニタイザ
    plain-text.ts  タグの除去、リンクの抽出
    revert.ts      取り消し
    indexer.ts     D1 への反映
    images.ts      R2 へのアップロードと配信
    mcp/           createMcpHandler、ツールの実装、Access for SaaS のログイン処理
  web/             Vite でビルドし Static Assets で配信する
    main.ts        ルーティング（一覧、ページ）
    sync.ts        wema のイベントと WebSocket のメッセージの相互変換
    ...
migrations/        D1 のマイグレーション
test/
wrangler.jsonc
```

### 3.2 `applyOps` の処理順

DO の書き込みは `applyOps(actor, clientId, opId, deltas, summary?)` だけにする。

1. 形の検証。デルタの型、数値が有限か、id の形式、1 回の `ops` のデルタ数と text の長さの上限
2. サニタイズ。`note:create` と `note:update` の text を HTMLRewriter に通す。**ここだけが非同期**
3. 以降は `await` を挟まずに実行する
   1. 重複の確認。同じ `client_id` と `op_id` の `ops` がすでにあれば、適用せずにその `seq` を返す（再接続後の再送への対処）
   2. `transactionSync` の中でデルタを順に検証しながら適用し、`seq` を進め、`ops` に記録する。検証に失敗したら例外で全体を巻き戻し、`reject` を返す
   3. 接続中の全クライアントへ `ops` を配信する
   4. alarm が未設定なら数秒後に設定する

手順 2 を先に済ませるのは、`transactionSync` のコールバックが同期でなければならないことと、`await` の間に別のメッセージが割り込めることによる。
状態の検証を `await` の後に置けば、検証から保存までの間に他の書き込みが入らない。

検証の規則（フェーズ 2 の実装で決めた）。

- 作成は、id が使用済みのとき、または接続線の両端がないときに拒否する
- 更新と削除は、対象がすでになければそのデルタを捨てる。他の人が先に消した付箋への操作で、送信元の変更全体を巻き戻さないため
- text の更新は、`before.text` が現在値と違えば拒否する。`before.text` は、送られてきた値とサニタイズした値のどちらかが現在値と一致すればよい。前者だけだと、送信元がサニタイズ前の text を持ったまま続けて編集したときに拒否される。後者だけだと、サニタイズの規則を変える前に保存した text を編集できなくなる
- text は 1 つ 500KB まで、1 回の `ops` は記録する内容の合計で 1.8MB まで（DO の SQLite の 1 行 2MB に収めるため）
- `applyOps` の呼び出しは DO の中で 1 つずつ順に処理する。サニタイズを待つ間に後続の呼び出しが先に進むと、同じクライアントの操作が送信順に適用されなくなるため
- 同じ `opId` の再送には、記録済みの結果（`fixups` を含む）を返す
- `note:update` の `zIndex` と `edge:update` の `from` / `to` は捨てる。値が変わらないキーも捨てる
- すべてのデルタを捨てた場合は `ops` に記録せず、`seq` も進めない

記録と配信の規則。

- `ops.body` と配信するデルタは、サーバーが実際に適用したものにする。更新の `before` と削除対象の内容は、送られてきた値ではなくサーバーの保存値で置き換える（取り消しを正しく行うため）
- 付箋を消すときに接続線が残っていたら、サーバーが `edge:delete` のデルタを作って同じ `ops` に入れる。wema は接続線の削除を先に送ってくるので、残るのは他の人が同時に足した接続線と、接続線を指定しない MCP からの削除である
- 送信元は自分の `opId` の `ops` を適用しない。そのため、サーバーが変えた分（サニタイズで変わった text、サーバーが足した接続線の削除）は `fixups` として返し、送信元だけが `applyRemote()` で適用する
- 更新の `after` にキーがなく `before` にあるものは「未設定に戻す」を表す。wema は接続線の折り畳みを解くときに `collapsed: undefined` を使うが、値が `undefined` のキーは JSON にすると消えるためである。受信側（`web/sync.ts`）もこの規則で復元する

### 3.3 WebSocket

- Hibernation API を使う。接続ごとの `clientId` と `actor` は `serializeAttachment` に入れる
- `actor` はクライアントの自己申告を使わず、Worker が Access JWT の email から `user:<email>` を作って DO に渡す
- `preview` と `presence` は保存せず、送信元以外へ中継する
- `hello` の `lastSeq` 以降の `ops` が残っていれば差分を、間引かれていれば `snapshot` を返す

### 3.4 D1 への反映

alarm ハンドラで次を行う。

1. 全付箋の text からタグを除いて連結し、`pages` を upsert する
2. リンクを抽出し、そのページ発の `links` を入れ替える
3. FTS のテーブルを更新する
4. 保持期間を過ぎた `ops` を消す

D1 は索引だが、**ページの一覧を持つのは D1 だけ**である（DO は名前から列挙できない）。
D1 を失うと、どのスラッグが存在するかが分からなくなる。D1 の Time Travel による復元を前提にし、FTS の仮想テーブルは、export の前に削除して後から作り直せるように、マイグレーションを分けておく。

### 3.5 取り消し

- `revert(seq, actor)` は `ops.body` から逆デルタを作り、デルタごとに現在値が元の `after` と一致するか確認する。一致しないものはスキップする
- 残ったデルタを `applyOps` と同じ経路で 1 つの `ops` として適用する。`summary` に元の `seq` を入れる
- 戻り値は、適用した数と、スキップした付箋と接続線の id、その理由
- 全部スキップになった場合は `ops` を作らず、`reverted_by` も書かない
- 付箋の削除を取り消すときは、同じ `ops` に入っている接続線の削除も一緒に戻る（逆順に適用するので付箋が先に復活する）

### 3.6 MCP

- `OAuthProvider` の `apiHandler` に `createMcpHandler` で作ったハンドラ、`defaultHandler` に Hono アプリを渡す
- ツールの実装は `BoardAccess`（ボードを読む、デルタを適用する、取り消す）越しに書く。サーバー版はページ DO の RPC を呼ぶ
- `actor` は `agent:<OAuth クライアント名>`。`created_by` と `ops.actor` に入る
- `add_notes` の id は Worker 側で `crypto.randomUUID()` を使って採番する
- `auto_layout` は wema が export する純粋なレイアウト関数を Worker で呼び、結果を `note:update` のデルタにして `applyOps` に渡す
- `revert_operation` が取り消せるのは、同じ `actor` が行った `ops` に限る

`createMcpHandler`、`OAuthProvider`、Access for SaaS の 3 つを組み合わせた公式サンプルは見つかっていない。
フェーズ 6 の最初にこの 3 つの接続だけを試し、動かなければ `McpAgent` に切り替える。

## 4. 認証とパスの切り分け

| パス | 保護 | 処理 |
| --- | --- | --- |
| `/`、`/p/*`、静的ファイル | Access | Static Assets |
| `/api/*`、`/ws/*`、`/img/*` | Access | Worker。`Cf-Access-Jwt-Assertion` を `jose` で検証する |
| `/mcp` | Bypass | Worker。OAuth のアクセストークンを検証する |
| `/authorize`、`/token`、`/register`、`/callback`、`/.well-known/oauth-*` | Bypass | Worker（`OAuthProvider`） |

- Access アプリは、ホスト名全体を保護するものを 1 つと、Bypass するパスごとのものを作る
- Worker で JWT を検証する目的は 2 つある。Access の設定を誤っても未認証のリクエストを通さないことと、`actor` に使う email を得ること
- ローカル開発では Access がないので、開発用の変数で固定の email を使う。この変数は本番の設定には入れない

## 5. 実装の順序

フェーズ 0 は wema 側の作業で、フェーズ 1 と 2 は wema の新版を待たずに進められる。

### フェーズ 0: wema の変更（#50、#51）

フェーズ 3 までに必要なのは `history:commit` と `HistoryDelta` の export、`applyRemote`、viewOnly 復元の扱い、#51。
`onImageUpload` はフェーズ 4、レイアウトの純粋関数はフェーズ 6、`board.batch` はフェーズ 8 までにあればよい。

### フェーズ 1: プロジェクトの初期設定

- `git init`、npm、TypeScript、wrangler、Hono、Vite、`@cloudflare/vitest-plugin`
- `wrangler.jsonc` に DO（`new_sqlite_classes`）、D1、Static Assets を定義する
- 実機確認を 2 つ行い、結果を `AGENTS.md` に書く
  - HTMLRewriter が DO 内で動くか。テキスト中のエンティティ（`&lt;` など）が出力でどうなるか
  - D1 で `tokenize='trigram'` の FTS5 テーブルが作れるか
- 完了の条件: `wrangler dev` で空のページが返り、テストが 1 本通る

2026-10-03 に完了した。実機確認の結果は次のとおりで、`test/runtime.test.ts` に固定してある。

- HTMLRewriter は DO 内で動く。テキスト中のエンティティは、復号や再エスケープをされずに入力のまま出力される
- 要素の外にあるコメントは `on('*')` の `comments` に届かないので、`onDocument` の `comments` で除去する
- DO の SQLite は外部キー制約が既定で有効で、CASCADE が働く
- trigram の FTS5 テーブルはローカル（miniflare）の D1 で作れ、日本語の部分一致検索ができる。本番の D1 では未確認で、最初のデプロイ時に確かめる

R2 と KV のバインディングは、使い始めるフェーズ（4 と 6）で `wrangler.jsonc` へ足すことにした。

### フェーズ 2: ページ DO

- スキーマの作成（`meta.version` で管理）、`applyOps`、スナップショットの取得、`ops` の記録
- サニタイザ。wema の `tests/sanitize.test.ts` のケースを移して同じ結果になることを確かめる
- 完了の条件: `applyOps` の検証、サニタイズ、競合（text の `before` 不一致）、重複 `opId`、CASCADE のテストが通る

2026-10-03 に完了した。プランから変えた点は次のとおり。

- スキーマは最初の書き込みで作る。存在しないスラッグを開いただけでは DO に何も保存しない
- サニタイザは wema より厳しくした。中身が生のテキストになる要素（`textarea`、`title` など）と SVG、MathML は中身ごと除き、URL のスキームは許可リスト（`http`、`https`、`mailto`）で判定する。出力が変わらなくなるまで繰り返す
- `<img>` の data URL はフェーズ 4 まで受け付ける（wema に `onImageUpload` が入るまで画像を貼れなくなるため）
- `WemaNote` に将来増えるフィールド用の `extra` 列は作った。ただし、未知のフィールドを今は保存せずに捨てている

### フェーズ 3: ブラウザとの同期

- WebSocket（`hello`、`ops`、`snapshot`、`reject`）、再接続と差分の再送
- `web/sync.ts`。`history:commit` を `ops` として送り、受信した `ops` を `applyRemote()` で反映する
- Access の設定とデプロイ
- 完了の条件: 2 つのブラウザで同じページを開き、付箋の作成、編集、移動、削除と、接続線の操作が相互に反映される。ここで個人のメモとして使い始められる

サーバー側と `web/sync.ts` は 2026-10-03 に実装した（wema は v0.4.0）。残りは Access の設定とデプロイである。

完了の条件は、ローカルの開発サーバーと実際のブラウザ（Chromium）の 2 つのタブで確かめた。付箋の作成、text の編集、移動、Undo、削除が相互に反映され、再読み込みでも復元される。接続線の操作と画像の添付は、手で操作して、保存されるところまで確かめた。

`web/sync.ts` は DOM を使わない作りにしてあり、テストから実際の Worker と DO へ接続して動かしている（`test/sync.test.ts`）。

- Access JWT の検証と、`/api/*`、`/ws/*` への適用
- WebSocket の `hello`、`ops`、`snapshot`、`reject`。変更の配信は `applyOps` の中で行うので、MCP など WebSocket 以外からの変更も同じ経路で届く
- 再接続時の差分の再送。差分が 500 件を超えるとき、または `ops` が残っていないときはスナップショットを返す
- WebSocket の接続要求の `Origin` の確認（プランになかった追加）

DO の WebSocket のテストは、既知の問題にあった `--max-workers=1 --no-isolate` を付けなくても通っている。不安定になったらこのオプションを付ける。

### フェーズ 4: Wiki の機能

- D1 のマイグレーション、alarm での反映、ページ一覧、検索、バックリンクの表示
- ページの新規作成とタイトルの変更
- 画像のアップロード（R2）と配信。data URL の `<img>` はサニタイザで除去する
- 完了の条件: 一覧と検索からページへ移動でき、リンク先のページにバックリンクが出る

サーバー側は 2026-10-03 に実装した（API の一覧は `AGENTS.md` の「HTTP API」）。残りは画面（一覧、検索、バックリンク、新規作成、タイトルの編集）と、wema の `onImageUpload` を使った画像の貼り付けである。

- data URL の `<img>` は、wema v0.4.0 の `onImageUpload` を画面に組み込んだ時点で、サニタイザで除去するようにした。画像は R2 へ上げ、text には URL だけが入る。HTML の貼り付けで入ってきた data URL の画像は、サーバーが `src` を取り除く
- ページの新規作成に専用の API は作らなかった。表示名の設定か最初の付箋の作成で、ページができる
- 絶対 URL のリンクを拾うための `SITE_ORIGIN` を `wrangler.jsonc` の `vars` に足した（プランになかった追加）
- 状態を変えるリクエスト全般で、他のオリジンからのものを断るようにした（フェーズ 3 では WebSocket だけだった）

### フェーズ 5: 取り消し

- `revert`、`ops` の一覧取得
- ブラウザの「最近の agent の操作」一覧と取り消しボタン
- 完了の条件: 複数の付箋を変更する `ops` を取り消せる。途中で人が 1 枚を変更した場合、その 1 枚だけが残り、結果に表示される

サーバー側は 2026-10-03 に実装した。残りは画面（agent の操作の一覧と取り消しボタン）である。3.5 節から変えた点は次のとおり。

- 衝突の判定を、デルタ単位ではなくフィールド単位にした。agent が位置と色を変えた付箋の位置だけを人が変えた場合、色は戻る
- 付箋の作成の取り消しは、text が変わっていなければ消す。位置や色まで比べると、agent が貼った付箋を動かしただけで取り消せなくなる
- 取り消しの `ops` に `reverts`（取り消した対象の `seq`）を持たせた。要求元のブラウザは取り消しを手元に適用していないので、自分の `clientId` の `ops` でも `reverts` があればリモートの変更として適用する
- 取り消さない接続線がつながっている付箋は消さない。消すと、その接続線も一緒に消えるため
- 取り消しを取り消したら、元の操作の `reverted_by` を消す。元の操作をもう一度取り消せる
- 一部だけ取り消した場合も `reverted_by` を書くので、残りを後から取り消すことはできない

### フェーズ 6: リモート MCP

- OAuth（`OAuthProvider` + Access for SaaS）と `createMcpHandler` の接続確認
- ツールを読み取り系（`list_pages`、`search_pages`、`read_board`）、書き込み系、`auto_layout`、`revert_operation` の順に実装する
- 完了の条件: claude.ai にコネクタとして登録し、ボードを読んで付箋を追加でき、その操作をブラウザから取り消せる
- 完了後に、claude.ai と ChatGPT の定期実行からこのコネクタを呼べるかを試す

### セキュリティレビュー（フェーズ 6 の後）

フェーズ 6 までの実装が済んだら、`/security-review` を 1 回まとめて回す。
重いので、フェーズごとには回さない。

このタイミングにするのは、認証なしで届くパス（`/mcp` と OAuth 用）がフェーズ 6 で初めて加わり、攻撃を受ける面がそこで出そろうためである。
フェーズ 3 のデプロイはこのレビューより前になるが、その時点で外から届くのは Access で保護したパスだけである。

特に見てもらう点。

- コミットと push のたびに自動で走るセキュリティレビュー（`security-guidance` プラグイン）の指摘は、見出しだけが届き、本文が届いていない。フェーズ 2 と 3 の指摘には、見出しから該当箇所を推測して対応した。推測が外れている可能性があるので、次の箇所は改めて確認する
  - `sanitize.ts` の HTML の許可リスト（指摘の内容が分からないまま、現状のままにしている）
  - `apply-ops.ts` と `validate.ts` のサイズ上限
  - `page-do.ts` の送信元の判定と、接続の認証の期限
  - フェーズ 2 の push 後に届いた 4 件のうち、見出しも届かなかった 1 件
- Access JWT の検証と、認証なしで公開するパスの切り分け
- MCP 経由の入力（プロンプトインジェクションで意図しない削除が起きた場合に、取り消しで戻せるか）

DO のスキーマは、最初のデプロイまでは最初のマイグレーションを直接書き換えている（`ops` の一意制約など）。
デプロイした後は既存のマイグレーションを書き換えず、新しいマイグレーションを足す。書き換えると、作成済みのページに変更が反映されない。

### フェーズ 7: 複数人での利用

- `preview`（ドラッグ中の中継）、`presence`（選択と編集中の表示）
- iframe の `src` を埋め込み対象のドメインに限定する
- agent が作った付箋と変更の見せ方

### フェーズ 8: WebMCP

`shared/tools.ts` の定義を使い、`BoardAccess` のブラウザ版（wema の API を呼ぶ）を足す。

## 6. 残っている未決定事項

| 項目 | 現時点の案 | 決める時期 |
| --- | --- | --- |
| `ops` の保持期間 | 決定済み。30 日以内か直近 1000 件のどちらかに収まっていれば残す。agent の `ops` も同じ | フェーズ 4 で実装した |
| 履歴の閲覧 UI の範囲 | 当面は agent の操作一覧のみ。人の操作の履歴表示は作らない | フェーズ 5 |
| agent が作った付箋の見せ方 | 付箋の隅にバッジを出す。色は agent が分類に使うので専用色にはしない | フェーズ 7 |
| MCP の text の入力形式 | プレーンテキストと、`- ` の箇条書き、`- [ ]` のチェックリストだけを HTML に変換する | フェーズ 6 |
| 定期実行からコネクタが使えるか | 実際に試す | フェーズ 6 の後 |
