// このリポジトリの中の利用側。ローカル開発（npm run dev / dev:roji）とテストが、ルートの
// wrangler.jsonc から、この入口を使う。**template/src/index.ts と同じ形に保つ**（違いは、
// パッケージ名の代わりに ../src/index を読むことだけ。ビルドせずに src/ を直接使うため）
import { createWemaKake, PageDO } from '../src/index';
import config from './config';

export { PageDO };
export default createWemaKake(config);
