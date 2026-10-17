// ローカル開発とテストの設定。template/src/config.ts と同じく、既定の値のまま使う
// （テストは既定の値を前提にしている。test/site.test.ts は、別の設定を createApp に直接渡して確かめる）
import type { WemaKakeConfig } from '../src/index';

const config: WemaKakeConfig = {};

export default config;
