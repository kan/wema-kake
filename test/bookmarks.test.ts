import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { api } from './helpers';

/** ページを表示名つきで作り、D1 への反映（alarm）まで済ませる */
async function createPage(slug: string, title: string) {
  const stub = env.PAGE.getByName(slug);
  await stub.setTitle(title);
  await runDurableObjectAlarm(stub);
}

const bookmarks = async () => ((await (await api('/api/bookmarks')).json()) as { pages: unknown[] }).pages;
const put = (slug: string) => api(`/api/bookmarks/${slug}`, { method: 'PUT' });
const remove = (slug: string) => api(`/api/bookmarks/${slug}`, { method: 'DELETE' });

describe('ブックマーク', () => {
  it('付けた順に返し、外せる。同じページに 2 回付けても増えない', async () => {
    await createPage('bm-a', 'ページ A');
    await createPage('bm-b', 'ページ B');
    expect((await put('bm-b')).status).toBe(200);
    expect((await put('bm-a')).status).toBe(200);
    expect((await put('bm-b')).status).toBe(200);
    expect(await bookmarks()).toEqual([
      { name: 'bm-b', title: 'ページ B' },
      { name: 'bm-a', title: 'ページ A' },
    ]);

    expect((await remove('bm-b')).status).toBe(200);
    // 付いていなくても、成功として返す
    expect((await remove('bm-b')).status).toBe(200);
    expect(await bookmarks()).toEqual([{ name: 'bm-a', title: 'ページ A' }]);
    await remove('bm-a');
  });

  it('存在しないページと、不正なスラッグには付けられない', async () => {
    expect((await put('bm-missing')).status).toBe(404);
    expect((await put('Bad_Slug')).status).toBe(400);
    expect(await bookmarks()).toEqual([]);
  });

  it('索引への反映の前のページにも付けられる（表示名は null で返る）', async () => {
    await env.PAGE.getByName('bm-fresh').setTitle('作ったばかり');
    expect((await put('bm-fresh')).status).toBe(200);
    expect(await bookmarks()).toEqual([{ name: 'bm-fresh', title: null }]);
    await remove('bm-fresh');
  });

  it('他の利用者のブックマークは返さない', async () => {
    await createPage('bm-other', '他の人のページ');
    await env.DB.prepare(`INSERT INTO bookmarks (actor, page, created_at) VALUES ('user:other@example.com', ?, 1)`)
      .bind('bm-other')
      .run();
    expect(await bookmarks()).toEqual([]);
  });

  it('ページを削除すると、全員のブックマークから消える', async () => {
    await createPage('bm-gone', '消すページ');
    await put('bm-gone');
    await env.DB.prepare(`INSERT INTO bookmarks (actor, page, created_at) VALUES ('user:other@example.com', ?, 1)`)
      .bind('bm-gone')
      .run();
    expect((await api('/api/pages/bm-gone', { method: 'DELETE' })).status).toBe(200);
    expect(await env.DB.prepare(`SELECT count(*) AS n FROM bookmarks WHERE page = 'bm-gone'`).first()).toEqual({ n: 0 });
  });

  it('上限を超えては付けられない。付いているページへの付け直しは通る', async () => {
    await createPage('bm-limit', '上限');
    await createPage('bm-over', '上限の外');
    expect((await put('bm-limit')).status).toBe(200);
    const rows = Array.from({ length: 99 }, (_, i) =>
      env.DB.prepare(`INSERT INTO bookmarks (actor, page, created_at) VALUES ('user:dev@example.com', ?, ?)`).bind(
        `bm-filler-${i}`,
        i,
      ),
    );
    await env.DB.batch(rows);
    expect((await put('bm-over')).status).toBe(400);
    expect((await put('bm-limit')).status).toBe(200);
    await env.DB.prepare(`DELETE FROM bookmarks WHERE page LIKE 'bm-filler-%' OR page = 'bm-limit'`).run();
  });
});
