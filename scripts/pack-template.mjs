// 雛形の .gitignore を、パッケージに入る名前（gitignore）で隣に複製する。prepack から走る。
//
// npm は .gitignore をパッケージに入れない（files に挙げても落とす）。落ちたままだと、init が作った
// 木に無視の設定がなく、node_modules/ も手元の secret（.dev.vars）も commit される。
// repo の側は .gitignore のままでないと困る（Deploy to Cloudflare のボタンは、GitHub の template/ を
// そのまま新しい repo にする）ので、配るとき用の複製を作る。bin/wema-kake.mjs が .gitignore に戻す。
// 複製は生成物なので、git には入れない
import { copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const template = join(dirname(dirname(fileURLToPath(import.meta.url))), 'template');
await copyFile(join(template, '.gitignore'), join(template, 'gitignore'));
