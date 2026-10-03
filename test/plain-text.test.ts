import { describe, expect, it } from 'vitest';
import { decodeEntities, extractContent, linkedSlug } from '../src/worker/plain-text';

describe('decodeEntities', () => {
  it.each([
    ['a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#x27;', `a & b <c> "d" 'e'`],
    ['a&nbsp;b', 'a b'],
    ['&#x3042;&#12356;', 'あい'],
    ['&unknown; &#0; &#x110000; &amp', '&unknown; &#0; &#x110000; &amp'],
  ])('%s → %s', (input, expected) => {
    expect(decodeEntities(input)).toBe(expected);
  });
});

describe('extractContent', () => {
  it('タグを除き、ブロックの区切りを改行にする', async () => {
    const html = '<div>1 行目</div><div><b>2</b> 行目<br>3 行目</div><ul><li>a</li><li>b &amp; c</li></ul>';
    expect((await extractContent(html)).text).toBe('1 行目\n2 行目\n3 行目\na\nb & c');
  });

  it('タグのない text はエンティティだけ復号する', async () => {
    expect(await extractContent('5 &lt; 10')).toEqual({ text: '5 < 10', hrefs: [] });
  });

  it('リンク先を取り出す', async () => {
    const html = '<a href="/p/memo">m</a> <a href="https://example.com/?a=1&amp;b=2">e</a> <a>none</a>';
    expect((await extractContent(html)).hrefs).toEqual(['/p/memo', 'https://example.com/?a=1&b=2']);
  });
});

describe('linkedSlug', () => {
  const site = 'https://wiki.example.com';

  it.each([
    ['/p/memo', 'memo'],
    ['/p/memo/', 'memo'],
    ['/p/memo?x=1#h', 'memo'],
    ['https://wiki.example.com/p/memo-2', 'memo-2'],
  ])('%s → %s', (href, slug) => {
    expect(linkedSlug(href, site)).toBe(slug);
  });

  it.each([
    'https://other.example.com/p/memo',
    '//other.example.com/p/memo',
    '/p/Bad_Slug',
    '/p/a/b',
    '/pages/memo',
    'p/memo/extra',
    'mailto:a@example.com',
    'http://[',
  ])('%s はページ間リンクとして扱わない', (href) => {
    expect(linkedSlug(href, site)).toBeNull();
  });

  it('サイトのオリジンが未設定なら、絶対 URL は拾わない', () => {
    expect(linkedSlug('https://wiki.example.com/p/memo', '')).toBeNull();
    expect(linkedSlug('/p/memo', '')).toBe('memo');
  });
});
