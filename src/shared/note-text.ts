// LLM（MCP / WebMCP）が渡すプレーンテキストを、付箋の text（HTML）にする。
// 受け付ける書式は、箇条書き（`- `）とチェックリスト（`- [ ]` / `- [x]`）だけ。それ以外は
// そのままの文字として扱う（HTML のタグを書いても、タグとしては解釈しない）。

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
    `<input type="checkbox"${checked ? ' checked' : ''}>${escapeHtml(text)}</li>`
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
      const items = group.map((line) => `<li>${escapeHtml(BULLET_RE.exec(line)![1])}</li>`);
      blocks.push(`<ul>${items.join('')}</ul>`);
    } else {
      blocks.push(group.map(escapeHtml).join('<br>'));
    }
    i = end;
  }
  return blocks.join('');
}
