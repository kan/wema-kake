// 付箋の text（HTML）のサニタイズ。許可リストは wema の src/utils/sanitize.ts に合わせている。
// wema は DOMParser で木を作ってから処理するが、HTMLRewriter は字句を順に流すだけなので、
// 次の 2 点を wema より厳しくしている。
// - 中身が生のテキストとして扱われる要素や SVG / MathML は、タグを外すと中身がマークアップとして
//   解釈されるので、中身ごと除去する
// - 出力が変わらなくなるまで繰り返し、タグを外した結果できた不許可の要素を残さない

const ALLOWED_TAGS = new Set([
  'b', 'strong', 'i', 'em', 'u', 's', 'br', 'span',
  'ul', 'ol', 'li', 'a', 'input', 'img', 'iframe', 'video', 'audio', 'div', 'p',
]);

/** class と style はどのタグでも許可する */
const TAG_ATTRIBUTES: Record<string, Set<string>> = {
  a: new Set(['href', 'target', 'rel']),
  input: new Set(['type', 'checked']),
  img: new Set(['src', 'alt', 'width', 'height']),
  iframe: new Set(['src', 'width', 'height', 'sandbox', 'allow', 'allowfullscreen', 'frameborder', 'title']),
  video: new Set(['src', 'controls', 'preload', 'width', 'height', 'poster']),
  audio: new Set(['src', 'controls', 'preload']),
};

const URL_ATTRIBUTES = new Set(['href', 'src', 'poster']);

/** 中身ごと除去するタグ */
const REMOVE_TAGS = new Set([
  'script', 'style', 'noscript', 'object', 'embed', 'applet',
  'textarea', 'title', 'xmp', 'plaintext', 'noembed', 'noframes', 'svg', 'math',
]);

const ALLOWED_CSS_PROPS = new Set([
  'color', 'background-color', 'font-size', 'font-weight', 'font-style',
  'text-decoration', 'text-align', 'margin', 'padding', 'display',
  'list-style-type', 'white-space',
]);

/** wema の SAFE_URL_SCHEMES と同じ */
const ALLOWED_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);

const MAX_PASSES = 4;

export class SanitizeError extends Error {}

/**
 * スキームを許可リストで判定する。HTMLRewriter は属性値のエンティティを復号しないので、
 * スキームの位置にエンティティがある値（`&#106;avascript:` など）は拒否する。
 *
 * wema は画像などの `data:` URL を許可するが、ここでは受け付けない。画像は R2 に置き、
 * text には URL だけを入れる（data URL は text の大きさの上限にすぐ達するため）。
 */
function isSafeUrl(value: string): boolean {
  // ブラウザは URL 中の空白と制御文字を無視してスキームを解釈する
  const compact = value.replace(/[\u0000- ]/g, '');
  const head = compact.split(/[/?#]/, 1)[0];
  if (head.includes('&')) return false;
  const colon = head.indexOf(':');
  if (colon === -1) return true;
  return ALLOWED_SCHEMES.has(head.slice(0, colon).toLowerCase());
}

/** 許可した宣言だけを残す。何も除かなかったときは元の文字列をそのまま返す */
function sanitizeStyle(value: string): string {
  if (/[&\\]/.test(value)) return '';
  const declarations = value.split(';').filter((d) => d.trim() !== '');
  const kept = declarations.filter((d) => {
    const colon = d.indexOf(':');
    if (colon === -1) return false;
    const prop = d.slice(0, colon).trim().toLowerCase();
    const val = d.slice(colon + 1);
    return ALLOWED_CSS_PROPS.has(prop) && !/url\(|expression\(|@import|[<>]/i.test(val);
  });
  if (kept.length === declarations.length) return value;
  return kept.map((d) => d.trim()).join('; ');
}

function sanitizeElement(el: Element): void {
  const tag = el.tagName.toLowerCase();
  if (REMOVE_TAGS.has(tag)) {
    el.remove();
    return;
  }
  if (!ALLOWED_TAGS.has(tag)) {
    el.removeAndKeepContent();
    return;
  }
  if (tag === 'input' && el.getAttribute('type')?.toLowerCase() !== 'checkbox') {
    el.remove();
    return;
  }

  const allowed = TAG_ATTRIBUTES[tag];
  for (const [rawName, value] of [...el.attributes]) {
    const name = rawName.toLowerCase();
    if (name === 'class') continue;
    if (name === 'style') {
      const style = sanitizeStyle(value);
      if (style === '') el.removeAttribute(rawName);
      else if (style !== value) el.setAttribute(rawName, style);
      continue;
    }
    if (!allowed?.has(name)) {
      el.removeAttribute(rawName);
      continue;
    }
    if (URL_ATTRIBUTES.has(name) && !isSafeUrl(value)) {
      el.removeAttribute(rawName);
    }
  }

  // iframe の中身は生のテキストで、表示には使われない
  if (tag === 'iframe') el.setInnerContent('');
}

function sanitizeOnce(html: string): Promise<string> {
  return new HTMLRewriter()
    .on('*', { element: sanitizeElement })
    .onDocument({
      comments(comment) {
        comment.remove();
      },
    })
    .transform(new Response(html))
    .text();
}

/** 許可していないタグ、属性、URL スキーム、style の宣言を除いた HTML を返す */
export async function sanitizeHtml(html: string): Promise<string> {
  if (!html.includes('<')) return html;
  let current = html;
  for (let i = 0; i < MAX_PASSES; i++) {
    const next = await sanitizeOnce(current);
    if (next === current) return next;
    current = next;
  }
  throw new SanitizeError('text could not be sanitized');
}
