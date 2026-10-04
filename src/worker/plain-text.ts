import { pageLink } from '../shared/note-text';
import { isValidSlug } from '../shared/slug';

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** HTMLRewriter はテキストと属性値のエンティティを復号しないので、ここで復号する */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity[0] !== '#') return NAMED_ENTITIES[entity.toLowerCase()] ?? whole;
    const hex = entity[1] === 'x' || entity[1] === 'X';
    const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

export interface NoteContent {
  /** タグを除いたテキスト。ブロックの区切りは改行にする */
  text: string;
  /** `<a>` の href（エンティティを復号したもの） */
  hrefs: string[];
}

/**
 * 付箋の text（サニタイズ済みの HTML）から、テキストとリンク先を取り出す。
 *
 * `pageLinks` を渡すと、ページへのリンクを `[[slug]]` の書式でテキストに残す（LLM に渡すとき。
 * 書くときの書式は src/shared/note-text.ts）。リンクの文字がスラッグと違えば、文字の後ろに付ける。
 * 渡さなければ、リンクの文字だけが残る（検索の索引を作るとき）
 */
export async function extractContent(
  html: string,
  pageLinks?: { siteOrigin: string | undefined },
): Promise<NoteContent> {
  if (!html.includes('<')) return { text: decodeEntities(html).trim(), hrefs: [] };

  const parts: string[] = [];
  const hrefs: string[] = [];
  const rewritten = new HTMLRewriter()
    .on('a[href]', {
      element(el) {
        const href = decodeEntities(el.getAttribute('href') ?? '');
        hrefs.push(href);
        const slug = pageLinks && linkedSlug(href, pageLinks.siteOrigin);
        if (!slug) return;
        // リンクの文字を集めておき、閉じタグで、書式に直して置き換える
        const start = parts.length;
        el.onEndTag(() => {
          // 文字は復号しないまま戻す（最後に、全体をまとめて復号する。ここで復号すると 2 回になる）
          const raw = parts.splice(start).join('').trim();
          const label = decodeEntities(raw);
          parts.push(label === '' || label === slug ? pageLink(slug) : `${raw} ${pageLink(slug)}`);
        });
      },
    })
    .on('br, div, p, li, ul, ol', {
      element(el) {
        parts.push('\n');
        if (el.tagName !== 'br') el.onEndTag(() => void parts.push('\n'));
      },
    })
    .onDocument({
      text(chunk) {
        parts.push(chunk.text);
      },
    })
    .transform(new Response(html));
  // 変換後の HTML は使わない。読み捨てて、ハンドラだけを走らせる
  await rewritten.body!.pipeTo(new WritableStream());

  const text = decodeEntities(parts.join(''))
    .replace(/[ \t]*\n\s*/g, '\n')
    .trim();
  return { text, hrefs };
}

/** 相対 URL を解決するための仮のオリジン */
const RELATIVE_BASE = 'https://relative.invalid';

/**
 * href がこのサイトのページ（`/p/<slug>`）を指していれば、そのスラッグを返す。
 * 対象は相対 URL と、`siteOrigin` を持つ絶対 URL。
 */
export function linkedSlug(href: string, siteOrigin: string | undefined): string | null {
  let url: URL;
  try {
    url = new URL(href, RELATIVE_BASE);
  } catch {
    return null;
  }
  if (url.origin !== RELATIVE_BASE && url.origin !== siteOrigin) return null;
  const slug = /^\/p\/([^/]+)\/?$/.exec(url.pathname)?.[1];
  return slug && isValidSlug(slug) ? slug : null;
}
