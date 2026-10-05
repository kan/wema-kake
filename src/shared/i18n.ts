// 画面の言語を決める処理。画面とサーバーの両方が使う（docs/plan.md のフェーズ 9）。
//
// 言語は、次の順で決める。
//   1. その端末で選んだ言語（Cookie）
//   2. ブラウザの言語の設定（サーバーでは Accept-Language、画面では navigator.languages）
//   3. どちらにも対応する言語がなければ、DEFAULT_LANG

export type Lang = 'ja' | 'en';

export const LANGS: readonly Lang[] = ['ja', 'en'];

/** ブラウザの設定に、対応する言語が 1 つもないときの言語 */
export const DEFAULT_LANG: Lang = 'en';

/**
 * 選んだ言語を持つ Cookie の名前。値は Lang。選んでいない端末には置かない。
 * 画面のスクリプトが読み書きする（秘密の値ではない）。サーバーは読むだけ
 */
export const LANG_COOKIE = 'wk_lang';

const isLang = (value: string | undefined): value is Lang => LANGS.includes(value as Lang);

/**
 * 言語を決める。`chosen` は、選んだ言語（Cookie の値。なければ undefined）。`preferred` は、
 * ブラウザの言語の並び（優先の高い順。`ja-JP` のような地域つきの値は、先頭の部分で比べる）
 */
export function resolveLang(chosen: string | undefined, preferred: readonly string[]): Lang {
  if (isLang(chosen)) return chosen;
  for (const tag of preferred) {
    const primary = tag.trim().toLowerCase().split('-')[0];
    if (isLang(primary)) return primary;
  }
  return DEFAULT_LANG;
}

/** Cookie の文字列（`document.cookie` か、Cookie ヘッダー）から、`name` の値を取り出す */
export function cookieValue(cookies: string | null | undefined, name: string): string | undefined {
  for (const part of (cookies ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** Accept-Language の値を、優先の高い順の言語の並びにする。q が 0 のものは外す */
export function parseAcceptLanguage(header: string | null | undefined): string[] {
  return (header ?? '')
    .split(',')
    .map((part, index) => {
      const [tag, ...params] = part.split(';');
      const q = params.map((param) => /^\s*q\s*=\s*([\d.]+)\s*$/.exec(param)?.[1]).find((value) => value !== undefined);
      return { tag: tag.trim(), q: q === undefined ? 1 : Number(q), index };
    })
    .filter(({ tag, q }) => tag !== '' && tag !== '*' && q > 0)
    // q が同じなら、書かれた順
    .sort((a, b) => b.q - a.q || a.index - b.index)
    .map(({ tag }) => tag);
}

/** リクエストを送ってきたブラウザの、画面の言語 */
export function requestLang(request: Request): Lang {
  return resolveLang(
    cookieValue(request.headers.get('Cookie'), LANG_COOKIE),
    parseAcceptLanguage(request.headers.get('Accept-Language')),
  );
}
