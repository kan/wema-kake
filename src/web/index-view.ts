// 一覧の画面（/）。
//
// 設計では、ページの一覧を wema のボードで表す（docs/plan.md の 3.7 節）。そのために要る
// wema の機能（スクロール、付箋の絞り込み、リンクのクリックの処理）を依頼中なので、
// それが入るまでは、新規ページの作成と、ページへ移動するための仮のリストだけを出す。
import { MAX_TITLE_LENGTH } from '../shared/api';
import { isValidSlug } from '../shared/slug';
import * as api from './api';
import { el, errorMessage, formatDate } from './dom';

/** スラッグの初期値。短い乱数（小文字の英数字） */
function randomSlug(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((b) => (b % 36).toString(36)).join('');
}

export function openIndex(app: HTMLElement): void {
  document.title = 'wema-kake';

  const titleInput = el('input', { placeholder: '表示名（省略できます）', maxLength: MAX_TITLE_LENGTH });
  const slugInput = el('input', { value: randomSlug(), title: 'URL に使う名前。小文字の英数字とハイフン' });
  const message = el('span', { className: 'sync-notice' });
  const form = el(
    'form',
    { className: 'new-page' },
    titleInput,
    el('span', { textContent: '/p/' }),
    slugInput,
    el('button', { type: 'submit', textContent: '新規ページ' }),
    message,
  );

  const create = async () => {
    const slug = slugInput.value.trim();
    if (!isValidSlug(slug)) {
      message.textContent = 'スラッグは小文字の英数字とハイフンで、64 文字までです';
      return;
    }
    try {
      await api.createPage(slug, titleInput.value);
    } catch (e) {
      if (e instanceof api.ApiError && e.status === 409) {
        message.replaceChildren(
          'そのスラッグのページはすでにあります（',
          el('a', { href: `/p/${slug}`, textContent: '開く' }),
          '）',
        );
      } else {
        message.textContent = `作成に失敗しました（${errorMessage(e)}）`;
      }
      return;
    }
    location.assign(`/p/${slug}`);
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void create();
  });

  const list = el('ul', { className: 'page-list' });
  app.append(
    el(
      'header',
      { className: 'page-header' },
      el('h1', { textContent: 'wema-kake' }),
      el('span', { className: 'spacer' }),
      form,
    ),
    el('main', { className: 'index-body' }, list),
  );

  api
    .getPages()
    .then(({ pages }) => {
      list.replaceChildren(
        ...pages.map((p) =>
          el(
            'li',
            {},
            el('a', { href: `/p/${p.name}`, textContent: p.title ?? p.name }),
            el('span', {
              className: 'page-meta',
              textContent: ` ${formatDate(p.updated_at)}・付箋 ${p.note_count} 枚`,
            }),
          ),
        ),
      );
      if (pages.length === 0) list.append(el('li', { className: 'empty', textContent: 'まだページがありません' }));
    })
    .catch((e: unknown) => {
      list.replaceChildren(
        el('li', { className: 'empty', textContent: `一覧を取得できませんでした（${errorMessage(e)}）` }),
      );
    });
}
