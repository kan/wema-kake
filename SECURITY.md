# セキュリティポリシー

## 脆弱性の報告

wema-kake に脆弱性を見つけたら、公開の Issue には書かず、GitHub の [Private vulnerability reporting](https://github.com/kan/wema-kake/security/advisories/new) から報告してください。報告の内容は、修正を公開するまでメンテナーにだけ見えます。

報告には次の内容を書いてください。

- 脆弱性の内容
- 再現の手順
- 想定される影響（読み書きできるデータ、必要な権限など）

受け取った報告は、できるだけ早く確認して返信します。

## 対象

対象は、このリポジトリのコード（`main` ブランチの最新）です。リリースの版は切っていないので、古いコミットへの修正の適用は行いません。

次のものは、それぞれの報告先へお願いします。

- 付箋ボードのライブラリ wema の問題: [kan/wema](https://github.com/kan/wema/security/policy)
- 各自がデプロイしたインスタンスの設定の誤り（Cloudflare Access のポリシーなど）: そのインスタンスの管理者
