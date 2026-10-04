import { describe, expect, it } from 'vitest';
import { textToHtml } from '../src/shared/note-text';
import { decodeEntities, extractContent, linkedSlug } from '../src/worker/plain-text';
import { sanitizeHtml } from '../src/worker/sanitize';

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

describe('extractContent: ページへのリンクを書式で残す（LLM に渡すとき）', () => {
  const links = { siteOrigin: 'https://wiki.example.com' };

  it.each([
    // リンクの文字がスラッグと同じなら、書式だけにする
    ['<a href="/p/design">design</a> を参照', '[[design]] を参照'],
    // 違えば、文字の後ろに付ける
    ['詳細は<a href="/p/design">設計メモ</a>にある', '詳細は設計メモ [[design]]にある'],
    // 文字のないリンク
    ['<a href="/p/design"></a>', '[[design]]'],
    // サイトの絶対 URL も、ページへのリンクとして扱う
    ['<a href="https://wiki.example.com/p/design">メモ</a>', 'メモ [[design]]'],
    // 外部のリンクと、ページでないパスは、文字だけを残す
    ['<a href="https://other.example/p/design">外部</a> <a href="/img/x.png">画像</a>', '外部 画像'],
    // リンクの中の装飾は、文字として集める
    ['<a href="/p/design"><b>太字</b>の文字</a>', '太字の文字 [[design]]'],
    ['<ul><li><a href="/p/a">a</a></li><li><a href="/p/b">b</a></li></ul>', '[[a]]\n[[b]]'],
  ])('%s → %s', async (html, text) => {
    expect((await extractContent(html, links)).text).toBe(text);
  });

  it('指定しなければ、リンクの文字だけが残る（検索の索引）', async () => {
    expect((await extractContent('<a href="/p/design">設計メモ</a>')).text).toBe('設計メモ');
  });

  it('書いた書式は、読むと同じ書式に戻る', async () => {
    const written = textToHtml('関連: [[design]] と [[todo-list]]\n- [[design]]');
    expect(written).toBe(
      '関連: <a href="/p/design">design</a> と <a href="/p/todo-list">todo-list</a>' +
        '<ul><li><a href="/p/design">design</a></li></ul>',
    );
    expect(await sanitizeHtml(written)).toBe(written);
    expect((await extractContent(written, links)).text).toBe('関連: [[design]] と [[todo-list]]\n[[design]]');
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
