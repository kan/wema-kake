// LLM（MCP / WebMCP）が渡すプレーンテキストを、付箋の text（HTML）にする。
// 受け付ける書式は、箇条書き（`- `）、チェックリスト（`- [ ]` / `- [x]`）、ページへのリンク
// （`[[slug]]`）だけ。それ以外はそのままの文字として扱う（HTML のタグを書いても、タグとしては
// 解釈しない）。本文にそのまま書いた URL（http / https）は、URL を文字にしたリンクになる。
//
// 読むとき（read_board）は、src/worker/plain-text.ts が、ページへのリンクを同じ書式に戻す。
import { SLUG_PATTERN } from './slug';

/** 本文の中の、ページへのリンク。`[[` と `]]` の間は、スラッグそのもの */
const PAGE_LINK_RE = new RegExp(`\\[\\[(${SLUG_PATTERN})\\]\\]`, 'g');

/** ページへのリンクの書式 */
export const pageLink = (slug: string) => `[[${slug}]]`;

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * URL に使える文字（正規表現の文字クラスの中身）。ASCII の、空白でない文字のうち、引用符、山かっこ、
 * 角かっこ（`[[slug]]` と紛れる）、バックスラッシュ、波かっこなどを除いたもの。
 * **引用符と山かっこを足さないこと**（リンクの `href` に、エスケープなしで入れている）
 */
export const URL_CHARS = '!#-&(-;=?-Z_a-z~';

/**
 * 本文の中の URL の候補。URL に使える文字の並び（日本語の文に続けて書かれても、URL の終わりが分かる）
 */
const URL_RE = new RegExp(`https?://[${URL_CHARS}]+`, 'g');
/** 全体が、URL に使える文字だけでできているか */
const SAFE_URL_RE = new RegExp(`^[${URL_CHARS}]+$`);
/** 文の側のものとして、URL の末尾から外す句読点 */
export const TRAILING_PUNCTUATION = '.,;:!?';

/**
 * URL の候補から、後ろに続いていた文字（文の句読点や、閉じかっこ）を外して、URL にする。
 * `length` は、候補のうち URL として使った長さ。リンクにできないものは null。
 *
 * **リンクの文字は、リンク先の URL そのものにする**（`href`）。文字とリンク先を別々に書ける
 * 書式は作らない。LLM が、文字でリンク先を偽れないようにするため。
 * - ユーザー名やパスワードを含む URL（`https://信頼できる名前@別のホスト/`）は、リンクにしない
 * - 国際化ドメイン名は、解釈した後の形（Punycode）で出る。似た文字のホスト名を見分けられる
 */
function externalLink(candidate: string): { href: string; length: number } | null {
  let end = candidate.length;
  // 余っている閉じかっこの数。最初に 1 回だけ数える（外すたびに数え直すと、かっこの並んだ本文で遅くなる）
  let unmatched = candidate.split(')').length - candidate.split('(').length;
  for (; ; end--) {
    const last = candidate[end - 1];
    // 閉じかっこは、対になる開きかっこが URL の中にないときだけ、文の側のものとして外す
    if (last === ')' && unmatched > 0) unmatched--;
    else if (!TRAILING_PUNCTUATION.includes(last)) break;
  }
  let url: URL;
  try {
    url = new URL(candidate.slice(0, end));
  } catch {
    return null;
  }
  if (url.username !== '' || url.password !== '') return null;
  // 解釈した後の URL に、使えない文字が現れたら、リンクにしない。ホスト名のパーセントエンコードは
  // 復号されるので（`https://x%22y/` → `https://x"y/`）、引用符で `href` の外へ出られてしまう
  if (!SAFE_URL_RE.test(url.href)) return null;
  return { href: url.href, length: end };
}

/** URL を含まない文字を HTML にする。エスケープしてから、ページへのリンクをリンクに変える */
const plainHtml = (text: string) =>
  escapeHtml(text).replace(PAGE_LINK_RE, (_, slug: string) => `<a href="/p/${slug}">${slug}</a>`);

/** 1 行ぶんの文字を HTML にする。URL と、ページへのリンクを、リンクに変える */
function inlineHtml(text: string): string {
  let html = '';
  let from = 0;
  for (const match of text.matchAll(URL_RE)) {
    const link = externalLink(match[0]);
    if (!link) continue;
    const href = escapeHtml(link.href);
    html += plainHtml(text.slice(from, match.index));
    html += `<a href="${href}" target="_blank" rel="noopener noreferrer">${href}</a>`;
    from = match.index + link.length;
  }
  return html + plainHtml(text.slice(from));
}

const CHECK_RE = /^- \[([ xX])\] ?(.*)$/;
const BULLET_RE = /^- (.*)$/;

type Kind = 'check' | 'bullet' | 'plain';

function kindOf(line: string): Kind {
  if (CHECK_RE.test(line)) return 'check';
  if (BULLET_RE.test(line)) return 'bullet';
  return 'plain';
}

/** wema のチェックリストと同じ形の HTML にする */
function checkItem(line: string): string {
  const [, mark, text] = CHECK_RE.exec(line)!;
  const checked = mark !== ' ';
  return (
    `<li${checked ? ' class="wema-checked"' : ''}>` +
    `<input type="checkbox"${checked ? ' checked' : ''}>${inlineHtml(text)}</li>`
  );
}

export function textToHtml(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: string[] = [];
  for (let i = 0; i < lines.length; ) {
    const kind = kindOf(lines[i]);
    let end = i;
    while (end < lines.length && kindOf(lines[end]) === kind) end++;
    const group = lines.slice(i, end);
    if (kind === 'check') {
      blocks.push(`<ul class="wema-checklist">${group.map(checkItem).join('')}</ul>`);
    } else if (kind === 'bullet') {
      const items = group.map((line) => `<li>${inlineHtml(BULLET_RE.exec(line)![1])}</li>`);
      blocks.push(`<ul>${items.join('')}</ul>`);
    } else {
      blocks.push(group.map(inlineHtml).join('<br>'));
    }
    i = end;
  }
  return blocks.join('');
}
