// Worker の入口。処理はすべて @kanf/wema-kake にあり、ここでは設定を渡すだけ。
//
// PageDO（ページごとの Durable Object）は、Worker の入口から export されている必要があるので、
// ここで再 export する。名前は wrangler.jsonc の class_name と合わせる
import { createWemaKake, PageDO } from '@kanf/wema-kake';
import config from './config';

export { PageDO };
export default createWemaKake(config);
