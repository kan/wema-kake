// デプロイする。D1 のマイグレーションを適用してから、Worker をデプロイする。
//
// 設定は、wrangler.deploy.jsonc（デプロイ先ごとの値を書いたもの。git には入れない）があれば、
// それを使う。なければ wrangler.jsonc を使う（「Deploy to Cloudflare」ボタンからのデプロイ。
// リソースの ID は、Cloudflare がリポジトリの複製に書き込む）。AGENTS.md の「デプロイ」を参照。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const config = existsSync('wrangler.deploy.jsonc') ? 'wrangler.deploy.jsonc' : 'wrangler.jsonc';
console.log(`config: ${config}`);

for (const args of [
  ['d1', 'migrations', 'apply', 'DB', '--remote'],
  ['deploy'],
]) {
  // Windows では npx が .cmd なので、シェルを通す
  const { status } = spawnSync('npx', ['wrangler', ...args, '--config', config], { stdio: 'inherit', shell: true });
  if (status !== 0) process.exit(status ?? 1);
}
