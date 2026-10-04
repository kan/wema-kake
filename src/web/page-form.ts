// 新しいページを作るときの入力欄（表示名とスラッグ）。一覧の「新規ページ」と、ページの画面の
// 「子ページを置く」で共有する。作成の後の動作と、作成に失敗したときの表示は、それぞれで違う。
import { MAX_TITLE_LENGTH } from '../shared/api';
import { isValidSlug } from '../shared/slug';
import { el, randomSlug } from './dom';

/** 表示名とスラッグの入力欄。`labels` を、そのままフォームに入れる */
export function pageFields(): {
  title: HTMLInputElement;
  slug: HTMLInputElement;
  labels: HTMLElement[];
  /** 入力欄を開いたときの状態にする（表示名は空、スラッグは新しい乱数）。表示名にフォーカスを置く */
  reset: () => void;
} {
  const title = el('input', { placeholder: '省略できます', maxLength: MAX_TITLE_LENGTH });
  const slug = el('input', { value: randomSlug(), title: 'URL に使う名前。小文字の英数字とハイフン' });
  return {
    title,
    slug,
    labels: [
      el('label', {}, '表示名', title),
      el('label', {}, 'URL', el('span', { className: 'slug-field' }, '/p/', slug)),
    ],
    reset() {
      title.value = '';
      slug.value = randomSlug();
      title.focus();
    },
  };
}

/** 入力されたスラッグを返す。形が正しくなければ、`message` に理由を出して undefined を返す */
export function checkedSlug(input: HTMLInputElement, message: HTMLElement): string | undefined {
  const slug = input.value.trim();
  if (isValidSlug(slug)) return slug;
  message.textContent = 'スラッグは小文字の英数字とハイフンで、64 文字までです';
  return undefined;
}
