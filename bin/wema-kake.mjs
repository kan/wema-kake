#!/usr/bin/env node
// wema-kake の入口のコマンド。今あるのは init だけ。
//
//   npx @kanf/wema-kake init [directory] [--yes] [--no-install]
//
// Wiki 1 つ分のディレクトリを作る。中身は、パッケージに同梱した template/ で、聞いた値を
// src/config.ts と wrangler.jsonc と package.json に埋めてから書き出す。
//
// 雛形は GitHub から取らず、同梱のものを使う。init が作るのは、その版の wema-kake に合った雛形になる。
// 依存は足さない（対話は node:readline/promises で足りる）
import { spawn } from 'node:child_process';
import { cp, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const template = join(root, 'template');
const LANGS = ['ja', 'en'];

const USAGE = `usage: npx @kanf/wema-kake init [directory] [--yes] [--no-install]

  init          create a wiki in a new directory
  --yes, -y     take every default without asking
  --no-install  write the files and stop, without running npm install
`;

function fail(reason) {
  console.error(`wema-kake: ${reason}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(USAGE);
  process.exit(argv.length === 0 ? 1 : 0);
}
if (argv[0] !== 'init') fail(`unknown command: ${argv[0]}\n\n${USAGE}`);

const useDefaults = argv.includes('--yes') || argv.includes('-y');
const skipInstall = argv.includes('--no-install');
const positional = argv.slice(1).find((arg) => !arg.startsWith('-'));

// 聞ける相手がいないなら、既定の値で進めない。readline は端末でないとき、質問を出す前に入力を
// 読み切って閉じるので、パイプで答えを流す形は支えない。黙って既定の値で作るより、--yes を促して落ちる
if (!useDefaults && !process.stdin.isTTY) fail('no terminal to ask on. Pass --yes to take every default.');

await init();

async function init() {
  const rl = useDefaults ? null : createInterface({ input: process.stdin, output: process.stdout });
  rl?.on('SIGINT', cancel);
  const ask = async (question, fallback) => {
    if (rl === null) return fallback;
    const answer = (await rl.question(`${question} (${fallback}) `).catch(cancel)).trim();
    return answer === '' ? fallback : answer;
  };

  try {
    const directory = positional ?? (await ask('Directory', 'my-wiki'));
    const target = resolve(process.cwd(), directory);
    await checkEmpty(target, directory);

    // Worker、D1、R2 の名前は、ディレクトリ名（パスの最後の部分）から作る
    const slug = slugify(basename(target));
    const siteName = await ask('Site name', 'My wiki');
    let defaultLang;
    for (;;) {
      defaultLang = await ask(`Default language (${LANGS.join(' / ')})`, 'en');
      if (LANGS.includes(defaultLang)) break;
      // --yes では同じ既定の値が返り続けるので、回り続けない
      if (rl === null) fail(`unknown language: ${defaultLang}`);
      process.stdout.write(`  choose one of ${LANGS.join(', ')}\n`);
    }

    await cp(template, target, { recursive: true, filter: packableOnly });
    await restoreGitignore(target);
    await fill(target, { slug, siteName, defaultLang });
    // ローカル開発の主体。.dev.vars は .gitignore に入っている
    await cp(join(target, '.dev.vars.example'), join(target, '.dev.vars'));

    process.stdout.write(`\nCreated ${target}\n`);
    const install = skipInstall
      ? false
      : (await ask('Install dependencies now? (y/n)', 'y')).toLowerCase().startsWith('y');
    rl?.close();
    if (install) await npmInstall(target);
    printNextSteps(directory, install);
  } finally {
    rl?.close();
  }
}

/** 雛形に値を埋める。埋める場所は 1 つずつ名指しする（replaceOnce が見つからなければ落ちる） */
async function fill(target, { slug, siteName, defaultLang }) {
  await replaceEach(join(target, 'src', 'config.ts'), [
    ["  siteName: 'My wiki',", `  siteName: ${quote(siteName)},`],
    ["  defaultLang: 'en',", `  defaultLang: ${quote(defaultLang)},`],
  ]);

  await replaceEach(join(target, 'wrangler.jsonc'), [
    ['"name": "my-wiki",', `"name": "${slug}",`],
    ['"database_name": "my-wiki",', `"database_name": "${slug}",`],
    ['"bucket_name": "my-wiki-images"', `"bucket_name": "${slug}-images"`],
    ['https://my-wiki.<account>', `https://${slug}.<account>`],
  ]);

  // 自分と同じ版を指す。雛形に書いてある範囲は、雛形を直したときのものなので、古い版を指しうる。
  // 今の範囲を雛形から読んでから、名指しで置き換える（正規表現で当てると、書き方が変わった日に
  // 0 件の置き換えで素通りする）
  const manifest = join(target, 'package.json');
  const current = JSON.parse(await readFile(manifest, 'utf8')).dependencies['@kanf/wema-kake'];
  await replaceEach(manifest, [
    ['"name": "my-wiki",', `"name": "${slug}",`],
    [`"@kanf/wema-kake": "${current}"`, `"@kanf/wema-kake": "^${await version()}"`],
  ]);

  await replaceEach(join(target, 'README.md'), [['# my-wiki', `# ${siteName}`]]);
}

/** ファイルの中の `[from, to]` を、順に 1 か所ずつ置き換える */
async function replaceEach(path, pairs) {
  const source = await readFile(path, 'utf8');
  await writeFile(path, pairs.reduce((text, [from, to]) => replaceOnce(text, from, to), source));
}

async function npmInstall(target) {
  process.stdout.write('\n');
  const code = await new Promise((done) => {
    const npm = spawn('npm', ['install'], { cwd: target, stdio: 'inherit', shell: process.platform === 'win32' });
    npm.on('error', () => done(1));
    npm.on('close', (status) => done(status ?? 1));
  });
  if (code !== 0) fail('npm install failed. Run it yourself in the new directory.');
}

function printNextSteps(directory, installed) {
  // 空白などを含む名前は、そのまま貼り付けて通るように引用符で囲む
  const cd = /^[\w./-]+$/.test(directory) ? directory : `'${directory.replaceAll("'", "'\\''")}'`;
  const steps = [`cd ${cd}`, ...(installed ? [] : ['npm install']), 'npm run dev   # http://localhost:8787'];
  process.stdout.write(`\nNext:\n\n${steps.map((step) => `  ${step}`).join('\n')}

To deploy:

  npx wrangler login
  npm run deploy:first

Then set up Cloudflare Access ("Access の設定" in the README). Until then the wiki answers 500.\n`);
}

/**
 * 空でないディレクトリには書かない。上書きの意味が人によって違うので、ここで止める。
 * ディレクトリはまだ作らない（質問の途中で抜けたときに、空のディレクトリを残さない）。書き出す cp が作る
 */
async function checkEmpty(target, directory) {
  let entries;
  try {
    entries = await readdir(target);
  } catch (error) {
    if (error?.code !== 'ENOENT') fail(`cannot write to ${directory} (${error instanceof Error ? error.message : error})`);
    return;
  }
  if (entries.length > 0) fail(`${directory} is not empty`);
}

/**
 * 無視の設定を .gitignore に戻す。npm は .gitignore をパッケージに入れないので、配るときは
 * gitignore という名前の複製を入れてある（scripts/pack-template.mjs）。repo から直に走らせたときは
 * .gitignore がそのまま来るので、何もしない
 */
async function restoreGitignore(target) {
  const ignore = join(target, '.gitignore');
  try {
    await rename(join(target, 'gitignore'), ignore);
  } catch {
    // 複製がないのは、repo から走らせたとき（.gitignore がある）か、prepack を通していない tarball
    // から走らせたとき。後者を黙って通すと、無視の設定がない木ができる
    await stat(ignore).catch(() => fail('the template has no .gitignore (was it packed without prepack?)'));
  }
}

/** 生成物と手元の物は持っていかない（repo から直に走らせたときのため） */
function packableOnly(source) {
  return !/[\\/](node_modules|\.wrangler|package-lock\.json|\.dev\.vars|worker-configuration\.d\.ts)$/.test(source);
}

/** 1 か所だけ置き換える。見つからないか、2 か所以上あれば落とす（雛形を直した日に黙って素通りしない） */
function replaceOnce(source, from, to) {
  const at = source.indexOf(from);
  if (at === -1) fail(`the template no longer contains: ${from}`);
  if (source.indexOf(from, at + from.length) !== -1) fail(`the template repeats: ${from}`);
  return `${source.slice(0, at)}${to}${source.slice(at + from.length)}`;
}

/** TypeScript の文字列として書ける形にする */
function quote(value) {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

/** Worker、D1、R2 の名前に使える形 */
function slugify(name) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .slice(0, 54)
    // 切り詰めた後に削る（先に削ると、切った位置の `-` が末尾に残る。Worker の名前は `-` で終われない）
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'my-wiki' : slug;
}

async function version() {
  return JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
}

/** 途中で抜けた人向け。失敗ではないので、理由を並べずに終わる */
function cancel() {
  process.stdout.write('\ncancelled\n');
  process.exit(130);
}
