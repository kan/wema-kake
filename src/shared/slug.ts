/** スラッグの形（正規表現の中身）。小文字の英数字とハイフンで、64 文字まで */
export const SLUG_PATTERN = '[a-z0-9][a-z0-9-]{0,63}';

export const SLUG_RE = new RegExp(`^${SLUG_PATTERN}$`);

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}
