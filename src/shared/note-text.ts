// LLM（MCP / WebMCP）が渡すプレーンテキストを、付箋の text（HTML）にする。
// 受け付ける書式は、箇条書き（`- `）、チェックリスト（`- [ ]` / `- [x]`）、ページへのリンク
// （`[[slug]]`）だけ。それ以外はそのままの文字として扱う（HTML のタグを書いても、タグとしては
// 解釈しない）。外部の URL へのリンクは書けない。
//
// 読むとき（read_board）は、src/worker/plain-text.ts が、ページへのリンクを同じ書式に戻す。
import { SLUG_PATTERN } from './slug';

/** 本文の中の、ページへのリンク。`[[` と `]]` の間は、スラッグそのもの */
const PAGE_LINK_RE = new RegExp(`\\[\\[(${SLUG_PATTERN})\\]\\]`, 'g');

/** ページへのリンクの書式 */
export const pageLink = (slug: string) => `[[${slug}]]`;

/** 1 行ぶんの文字を HTML にする。エスケープしてから、ページへのリンクをリンクに変える */
function inlineHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(PAGE_LINK_RE, (_, slug: string) => `<a href="/p/${slug}">${slug}</a>`);
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
