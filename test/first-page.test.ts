import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { FIRST_PAGE, guideBoard } from '../src/shared/guide';
import { api } from './helpers';

const index = async () =>
  (await (await api('/api/index')).json()) as { pages: { name: string; title: string; note_count: number }[] };

it('ページが 1 つもなければ、一覧を開いたときに最初のページを作る。消した後は作り直さない', async () => {
  const guide = guideBoard('first');
  expect((await index()).pages).toMatchObject([
    { name: FIRST_PAGE.slug, title: FIRST_PAGE.title, note_count: guide.notes.length },
  ]);

  // 付箋は、サニタイズで書き換わらずに、そのまま保存される
  const snapshot = await env.PAGE.getByName(FIRST_PAGE.slug).getSnapshot();
  expect(snapshot.data.notes).toEqual(guide.notes);
  expect(snapshot.data.edges).toEqual(guide.edges);

  // もう一度開いても、増えない
  expect((await index()).pages).toHaveLength(1);

  const res = await api(`/api/pages/${FIRST_PAGE.slug}`, { method: 'DELETE' });
  expect(res.status).toBe(200);
  expect((await index()).pages).toEqual([]);
});
