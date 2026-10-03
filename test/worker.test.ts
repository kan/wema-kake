import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { isValidSlug } from '../src/shared/slug';

describe('isValidSlug', () => {
  it.each(['a', 'memo-2026', '0abc', 'a'.repeat(64)])('%s を受け付ける', (slug) => {
    expect(isValidSlug(slug)).toBe(true);
  });

  it.each(['', '-a', 'Memo', 'a_b', 'a/b', '絵馬', 'a'.repeat(65)])('%s を拒否する', (slug) => {
    expect(isValidSlug(slug)).toBe(false);
  });
});

describe('GET /api/pages/:slug', () => {
  it('未作成のページは空のスナップショットを返し、ストレージに何も作らない', async () => {
    const res = await SELF.fetch('https://example.com/api/pages/first-page');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      slug: 'first-page',
      seq: 0,
      data: { version: 1, notes: [], edges: [] },
    });

    const tables = await runInDurableObject(env.PAGE.getByName('first-page'), (_do, state) =>
      state.storage.sql.exec(`SELECT count(*) AS c FROM sqlite_master`).one().c,
    );
    expect(tables).toBe(0);
  });

  it('不正なスラッグは 400', async () => {
    const res = await SELF.fetch('https://example.com/api/pages/Bad_Slug');
    expect(res.status).toBe(400);
  });
});
