// この Wiki の設定。どの項目も省ける（省いたときの値は、各項目のコメントにある）。
//
// デプロイ先ごとの値（Access の設定、サイトのオリジン）は、ここではなく wrangler.jsonc の vars に書く
import type { WemaKakeConfig } from '@kanf/wema-kake';

const config: WemaKakeConfig = {
  // 画面に出すサイトの名前（一覧の見出しと、タブの表示名）。省くと 'wema-kake'
  siteName: 'My wiki',
  // 既定の言語（'ja' か 'en'）。画面で選んだ言語も、ブラウザの言語の設定も、対応する言語に
  // 当たらないときに使う。省くと 'en'
  defaultLang: 'en',
  // リモート MCP サーバー（/mcp）。false にすると /mcp は 404 を返す。省くと true（どのクライアントも
  // 書き込める）。読み取りだけにするなら { write: false }、書き込めるクライアントを限るなら
  // { write: ['localhost'] } のように並べる（README の「MCP で書き込めるクライアントを限る」）
  mcp: true,
  // ページが 1 つもないときに、使い方の付箋を置いたページを 1 回だけ作る。省くと true
  firstPage: true,
  // 管理者の email。MCP（/mcp）を使えるのは、管理者が認可したクライアントだけになる。省くと、
  // Access を通ったすべての人を管理者として扱う（README の「管理者を決める」）
  // admins: ['you@example.com'],
  // 初めて来た人を承認待ちにし、管理者が承認するまで使わせない。省くと false。true にするには
  // admins が要る（README の「利用者を承認制にする」）
  // approval: true,
};

export default config;
