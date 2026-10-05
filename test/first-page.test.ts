import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { FIRST_PAGE_SLUG, firstPageTitle, guideBoard } from '../src/shared/guide';
import { api } from './helpers';

const index = async (headers: Record<string, string> = {}) =>
  (await (await api('/api/index', { headers })).json()) as {
    pages: { name: string; title: string; note_count: number }[];
  };

it('ページが 1 つもなければ、一覧を開いたときに最初のページを作る。消した後は作り直さない', async () => {
  // 一覧を開いた人の言語（ここでは、選んだ言語の Cookie）で作る
  const guide = guideBoard('first', 'ja');
  expect((await index({ Cookie: 'wk_lang=ja', 'Accept-Language': 'en-US,en;q=0.9' })).pages).toMatchObject([
    { name: FIRST_PAGE_SLUG, title: firstPageTitle('ja'), note_count: guide.notes.length },
  ]);

  // 付箋は、サニタイズで書き換わらずに、そのまま保存される
  const snapshot = await env.PAGE.getByName(FIRST_PAGE_SLUG).getSnapshot();
  expect(snapshot.data.notes).toEqual(guide.notes);
  expect(snapshot.data.edges).toEqual(guide.edges);

  // もう一度開いても、増えない。言語が違っても、作り直さない
  expect((await index({ 'Accept-Language': 'en' })).pages).toMatchObject([{ title: firstPageTitle('ja') }]);

  const res = await api(`/api/pages/${FIRST_PAGE_SLUG}`, { method: 'DELETE' });
  expect(res.status).toBe(200);
  expect((await index()).pages).toEqual([]);
});

it('英語の付箋も、サニタイズで書き換わらない', async () => {
  const guide = guideBoard('first', 'en');
  const stub = env.PAGE.getByName('first-page-en');
  expect(
    await stub.createWithContent(
      firstPageTitle('en'),
      guide.notes.map((note) => ({ type: 'note:create', note })),
    ),
  ).toBe(true);
  expect((await stub.getSnapshot()).data.notes).toEqual(guide.notes);
});
