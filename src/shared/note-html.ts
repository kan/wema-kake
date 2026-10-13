// 付箋の text（HTML）からテキストを取り出すときに、Worker（検索の索引、LLM へ渡すテキスト。
// src/worker/plain-text.ts）と、ブラウザ（付箋のつながりの印。src/web/note-links.ts）で共有するもの。

/** テキストにするときに、改行として扱うタグ */
export const BLOCK_TAGS = ['br', 'div', 'p', 'li', 'ul', 'ol', 'blockquote'] as const;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * 文字参照を、文字に戻す。タグを外した後のテキストに使う（HTMLRewriter も、正規表現でタグを外した
 * 結果も、文字参照は復号されないまま残る）。
 *
 * 名前付きの文字参照は、上の 6 つだけを戻す（ブラウザが付箋の HTML に書き出すもの）。`&nbsp;` は、
 * ふつうの空白にする。それ以外は、書かれたまま残す
 */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity[0] !== '#') return NAMED_ENTITIES[entity.toLowerCase()] ?? whole;
    const hex = entity[1] === 'x' || entity[1] === 'X';
    const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}
