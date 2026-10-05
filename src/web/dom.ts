import { lang, type MessageKey, t } from './i18n';
import { internalUrl } from './links';
import { navigate } from './navigation';

export type Child =Node | string | null | undefined | false;

/** 要素を作る。`props` は要素のプロパティ（className、textContent、onclick など） */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c): c is Node | string => c !== null && c !== undefined && c !== false));
  return node;
}

/**
 * wema の `onLinkClick` に渡す。サイト内のリンクは同じタブで開き、true を返す（wema は何もしない）。
 * サイト外のリンクと、修飾キーや中ボタンでのクリックは、wema に任せる（新しいタブで開く）。
 *
 * `url` は、ブラウザが解決した絶対 URL。サイト内かどうかはオリジンで判定する
 * （属性の値の先頭が `/` かどうかで判定すると、`//other.example/` でサイト外へ飛ばせてしまう）
 */
export function openInternalLink(url: string, event: MouseEvent): boolean {
  const target = internalLinkTarget(url, event);
  if (target === null) return false;
  navigate(target);
  return true;
}

/** 修飾キーなしの左クリックか。修飾キーつきのクリックと中ボタンは、ブラウザに任せる（新しいタブで開く） */
export const isPlainClick = (event: MouseEvent): boolean =>
  !(event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0);

/**
 * サイト内へのリンク。クリックすると、読み込みなしで切り替える（`navigate`）。修飾キーつきの
 * クリックと中ボタンは、ブラウザに任せる（新しいタブで開く）
 */
export function appLink(href: string, ...children: Child[]): HTMLAnchorElement {
  const link = el('a', { href }, ...children);
  link.addEventListener('click', (e) => {
    if (!isPlainClick(e)) return;
    e.preventDefault();
    navigate(href);
  });
  return link;
}

/** 同じタブで開くリンクなら、移動先の URL を返す。サイト外のリンクと、修飾キーつきのクリックは null */
export function internalLinkTarget(url: string, event: MouseEvent): string | null {
  return isPlainClick(event) ? internalUrl(url, location.origin) : null;
}

/**
 * パスワードマネージャーに、入力の候補を出させないための属性。この画面の入力欄は、ページの
 * 表示名、スラッグ、検索語で、氏名やログイン情報ではない。「表示名」や「URL」というラベルから、
 * 候補を出すものがある（1Password など）。標準の属性はないので、製品ごとの属性を付ける
 */
const NO_AUTOFILL: Record<string, string> = {
  autocomplete: 'off',
  'data-1p-ignore': '', // 1Password
  'data-lpignore': 'true', // LastPass
  'data-bwignore': '', // Bitwarden
  'data-form-type': 'other', // Dashlane
};

/** 文字を入力する欄。画面の入力欄は、すべてこれで作る（パスワードマネージャーの候補を出さない） */
export function textInput(props: Partial<HTMLInputElement> = {}): HTMLInputElement {
  const input = el('input', props);
  for (const [name, value] of Object.entries(NO_AUTOFILL)) input.setAttribute(name, value);
  return input;
}

/** スラッグの初期値。短い乱数（小文字の英数字） */
export function randomSlug(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((b) => (b % 36).toString(36)).join('');
}

/** ページの削除を確かめる（ページの画面と一覧の画面で、同じ文言を出す） */
export function confirmDeletePage(name: string): boolean {
  return confirm(t('page.deleteConfirm', name));
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 失敗の知らせの文言のキー（`failed.bookmark` など） */
export type FailureKey = Extract<MessageKey, `failed.${string}`>;

/** 「〜に失敗しました（理由）」の文言 */
export function failureMessage(key: FailureKey, e: unknown): string {
  return t(key, errorMessage(e));
}

export function formatDate(ms: number): string {
  return new Date(ms).toLocaleString(lang, {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}
