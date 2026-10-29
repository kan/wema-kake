# my-wiki

[wema-kake](https://github.com/kan/wema-kake)（`@kanf/wema-kake`）で動く、付箋の Wiki です。Wiki の処理と画面はすべて `@kanf/wema-kake` にあり、このリポジトリが持つのは設定だけです。

| ファイル | 中身 |
| --- | --- |
| `src/config.ts` | サイトの名前、既定の言語、MCP を有効にするか、最初のページを作るか |
| `wrangler.jsonc` | Worker の名前、バインディング、デプロイ先ごとの値（Access の設定、サイトのオリジン） |
| `src/index.ts` | Worker の入口。設定を `@kanf/wema-kake` に渡すだけ |

## ローカルでの開発

```sh
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

`http://localhost:8787/` で開けます。ローカルでは Access を通らず、`.dev.vars` の `DEV_USER_EMAIL` が利用者になります。

## 最初のデプロイ

Cloudflare のアカウントがあれば、ほかに要るものはありません。D1 と R2 は、`wrangler deploy` がバインディングから作ります。

```sh
npx wrangler login
npm run deploy:first
```

**デプロイしただけでは、まだ使えません。** Access を設定するまで、画面と API は 500 を返します（保護のない状態で公開しないためです）。続けて、下の「Access の設定」を行います。

## Access の設定

1. Cloudflare Zero Trust で、Access アプリケーション（Self-hosted）を 1 つ作る。宛先は Worker のホスト名だけ（パスは空）、ポリシーは Allow
2. チームドメイン（`https://<team>.cloudflareaccess.com`。末尾の `/` は付けない）と AUD タグを、`wrangler.jsonc` の `ACCESS_TEAM_DOMAIN` と `ACCESS_AUD` に書いて、`npm run deploy` でデプロイし直す
3. MCP を使うなら、そのアプリケーションの Additional settings の「OAuth」で **Managed OAuth** を有効にし、Allowed redirect URIs に、つなぐクライアントのコールバックを入れる
   - claude.ai: `https://claude.ai/api/mcp/auth_callback`
   - ChatGPT: `https://chatgpt.com/connector_platform_oauth_redirect`
   - 手元のクライアント（Claude Code など）: Allow localhost clients と Allow loopback clients を有効にする
   - 定期タスクから使うなら、Grant session duration を 1 か月（上限）にする。既定のままだと、アプリケーションのセッションの長さで切れて、そのたびにコネクタの再認可が要る
4. 未ログインの `curl` で確かめる。Managed OAuth を有効にしていれば、`/api/session` と `POST /mcp` は 401 を返し、`WWW-Authenticate` に `resource_metadata` が入る

- **Worker 単位の保護（Worker の「Access」タブの「Protect this Worker behind Access」）は使わない。** WebSocket に対応していない
- **`/mcp` を Bypass にするアプリケーションを作らない。** Access を通らないリクエストには JWT が付かないので、Worker が 401 を返す

MCP のサーバーの URL は `https://<ホスト名>/mcp` です。

## MCP の接続を切る

MCP のクライアントは、Access が発行したアクセストークンで `/mcp` を呼びます。アクセストークンが切れると、リフレッシュトークンで新しいものを受け取ります。Worker は要求のたびに Access の JWT を確かめ、接続の状態を持たないので、Access がトークンを受け付けなくなった時点で止まります。

止まることが分かっている切り方は次の 2 つです。

| 切り方 | 止まる範囲 | 止まるまで |
| --- | --- | --- |
| Access のポリシーから利用者を外す | その利用者が認可した、すべてのクライアント | 発行済みのアクセストークンが切れるまで（Managed OAuth の設定の Access token lifetime。既定で 15 分）。発行済みのアクセストークンは期限まで使える。Access は、トークンを更新するたびにポリシーを評価し直す（Cloudflare の文書による。実際に外して確かめてはいない） |
| `src/config.ts` を `mcp: false` にして、`npm run deploy` でデプロイし直す | すべての利用者の、すべてのクライアント | デプロイが済んだ時点。`/mcp` は 404 を返す。MCP のクライアントのトークンでは、画面と API にも入れない |

- 止まるまでの時間を短くしたいなら、Access token lifetime を短くする（Cloudflare の文書の推奨は 5〜15 分）
- 利用者を外すときは、画面も止める。ポリシーから外したうえで、Zero Trust の Team & Resources > Users でその利用者を選び、Action > Revoke を選ぶ。ブラウザのセッションが取り消される。ポリシーから外さないと、また新しいセッションを作れる
- **どちらの切り方でも、発行済みのリフレッシュトークンが消えるとは限らない**（消えるかは確かめていない）。ポリシーに戻したり `mcp: true` に戻したりすると、リフレッシュトークンが切れるまで（Grant session duration）は、同じクライアントからまた使えるおそれがある。端末をなくしたときに、この 2 つで一時的に止めてから元に戻すと、なくした端末からも使えるようになるかもしれない

確かめていないことは次のとおりです。Cloudflare の文書にも書いていません。

- 特定のクライアント（claude.ai だけ、なくした端末だけ、など）の接続だけを切る方法
- Users の Revoke と、アプリケーションの「Revoke existing tokens」で、MCP のトークン（アクセストークンとリフレッシュトークン）も取り消されるか。文書は、ブラウザのセッションについてだけ書いている
- Allowed redirect URIs からクライアントのコールバックを外したとき、発行済みのトークンが使えなくなるか。外したクライアントの新しい登録は通らない
- Managed OAuth を無効にしたとき、発行済みのトークンがどうなるか
- claude.ai や ChatGPT でコネクタを消したとき、Access のトークンが取り消されるか。そのクライアントからの呼び出しは止まるが、トークンを取り消す要求をクライアントが送るかは分からない

## 更新

```sh
npm update @kanf/wema-kake
npm run deploy
```

`npm run deploy` は、D1 のマイグレーションを当ててから Worker をデプロイします。版ごとの変更と、利用側で要る作業は、wema-kake のリリースノートに書かれます。
