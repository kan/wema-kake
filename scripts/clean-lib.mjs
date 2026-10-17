// 前のビルドの dist/lib を捨てる。tsc は出力先を掃除しないので、消したり改名したりしたソースの
// .js が残り、そのままパッケージに入って、利用側から import できてしまう。
// dist/web は消さない（vite の emptyOutDir が面倒を見る）
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(dirname(fileURLToPath(import.meta.url))), 'dist', 'lib');
await rm(out, { recursive: true, force: true });
