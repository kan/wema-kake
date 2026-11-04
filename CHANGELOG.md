# 変更履歴

このファイルには、利用側に届く変更を版ごとに書く。

書き方は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に、版の付け方は
[Semantic Versioning](https://semver.org/lang/ja/) に従う（0.x の間の付け方は AGENTS.md の「PR 運用」）。

## [Unreleased]

### 変更

- `agents` を 0.32.0 に、`@modelcontextprotocol/server` を 2.4.0 に、`jose` を 6.2.14 に上げた

### 内部

- リリースの準備を [tagpr](https://github.com/Songmu/tagpr) で行うようにした。リリース PR が版の更新とこのファイルの節を持ち、マージするとタグが打たれて npm へ publish される。GitHub Release の本文は、commit の一覧ではなく、このファイルのその版の節になる

## [0.1.5] - 2026-10-29

### 追加

- 付箋を消すと、すぐには消さずにゴミ箱のページ（スラッグは `trash`）へ移し、30 日後に消す。画面からの削除も、MCP の `delete_notes` も同じ。ゴミ箱からは、付箋を元のページの元の位置へ戻せる（#27）
- ページごとに、古い付箋を薄く表示して自動で消す設定を足した（しない / 7 日 / 30 日 / 90 日）。最後に更新した時刻から数え、期限を過ぎた付箋はゴミ箱へ移る（#27）
- 設定の `mcp` で、書き込めるクライアントを限れるようにした。`{ write: false }` でどのクライアントも読み取りだけ、`{ write: ['<名前>'] }` で並べたクライアントだけが書き込める（#30）

### 変更

- MCP のツールに、`readOnlyHint` に加えて `destructiveHint` / `idempotentHint` / `openWorldHint` の注釈を付けた（#31）
- MCP の `disconnect_notes` が、重複した id を断るようにした
- `@kanf/wema` を 0.17.0 に上げた

### セキュリティ

- `/mcp` でも Origin を検査し、自分のオリジンと一致しない要求を認証より前で 403 にする（MCP の仕様の DNS リバインディング対策）。CORS のヘッダーも付けない（#28）

### ドキュメント

- 雛形の README に、MCP の接続を切る手順と、止まるまでの時間を書いた（#29）

## [0.1.4] - 2026-10-27

### 変更

- `@kanf/wema` を 0.16.1 に、`agents` を 0.30.0 に上げた

### セキュリティ

- 雛形のロックの依存を更新し、body-parser / fast-uri / undici の脆弱性を解消した

## [0.1.3] - 2026-10-21

### 追加

- MCP に、付箋を他のページへ移す `move_notes` を足した

### 修正

- 画面で付箋を他のページへ移すと、作成者が移した人に変わっていた。サーバーが元のページから中身と作成者を読んで移すようにし、作成者を引き継ぐ。移している間に元のページで変わった付箋は、消さずに残して 409 で知らせる

## [0.1.2] - 2026-10-21

### 追加

- MCP に、ページを作る `create_page` と、ページを子ページとして移す `move_page` を足した。`create_page` は `parent` を指定すると、親のページに子ページの付箋も置く

### 修正

- publish のときに、`bin` のパスについて npm が警告を出さないようにした（#26）

## [0.1.1] - 2026-10-17

### 内部

- 雛形に `package-lock.json` を足した（Deploy to Cloudflare のボタンが `npm ci` で使う）。パッケージの中身は 0.1.0 と変わらない

## [0.1.0] - 2026-10-17

最初の公開版。利用側が雛形（`npx @kanf/wema-kake init`）から自分の Worker を作り、npm のこのパッケージを使ってデプロイする。

[0.1.5]: https://github.com/kan/wema-kake/releases/tag/v0.1.5
[0.1.4]: https://github.com/kan/wema-kake/releases/tag/v0.1.4
[0.1.3]: https://github.com/kan/wema-kake/releases/tag/v0.1.3
[0.1.2]: https://github.com/kan/wema-kake/releases/tag/v0.1.2
[0.1.1]: https://github.com/kan/wema-kake/releases/tag/v0.1.1
[0.1.0]: https://github.com/kan/wema-kake/releases/tag/v0.1.0
