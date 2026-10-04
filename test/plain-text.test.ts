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
    // 外部へのリンクは、URL を残す。文字が URL と違えば、山かっこで後ろに付ける
    ['<a href="https://other.example/p/design">外部</a>', '外部 <https://other.example/p/design>'],
    ['<a href="https://other.example/?a=1&amp;b=2">https://other.example/?a=1&amp;b=2</a>', 'https://other.example/?a=1&b=2'],
    ['<a href="https://other.example/?a=1&amp;b=2">A &amp; B</a>', 'A & B <https://other.example/?a=1&b=2>'],
    // 文字が、解釈する前の URL と同じなら、URL だけにする
    ['<a href="https://other.example">https://other.example</a>', 'https://other.example/'],
    ['<a href="https://other.example/"></a>', 'https://other.example/'],
    // ページでないパスと、http / https 以外は、文字だけを残す
    ['<a href="/img/x.png">画像</a> <a href="mailto:a@example.com">連絡先</a>', '画像 連絡先'],
    // リンクの中の装飾は、文字として集める
    ['<a href="/p/design"><b>太字</b>の文字</a>', '太字の文字 [[design]]'],
    ['<ul><li><a href="/p/a">a</a></li><li><a href="/p/b">b</a></li></ul>', '[[a]]\n[[b]]'],
  ])('%s → %s', async (html, text) => {
    expect((await extractContent(html, links)).text).toBe(text);
  });

  it('指定しなければ、リンクの文字だけが残る（検索の索引）', async () => {
    expect((await extractContent('<a href="/p/design">設計メモ</a>')).text).toBe('設計メモ');
  });

  it('書いた URL は、読むと同じ URL に戻る', async () => {
    const text = '出典: https://example.com/news?a=1&b=2 と [[design]]\nhttps://other.example/a_(b)';
    expect((await extractContent(textToHtml(text), links)).text).toBe(text);
  });

  // 人が貼ったリンクを読んで、書き戻しても、同じリンク先になる（書く側がリンクにしない文字は、エンコードして返す）
  it.each([
    ['https://other.example/x', 'https://other.example/x'],
    ['https://ja.wikipedia.org/wiki/日本', 'https://ja.wikipedia.org/wiki/%E6%97%A5%E6%9C%AC'],
    ["https://other.example/a'b[c]|d e", 'https://other.example/a%27b%5Bc%5D%7Cd%20e'],
    ['HTTPS://Other.Example/A', 'https://other.example/A'],
    // 末尾の句読点と、対にならないかっこ
    ['https://other.example/a.', 'https://other.example/a%2E'],
    ['https://other.example/a(b', 'https://other.example/a%28b'],
    ['https://other.example/a)', 'https://other.example/a%29'],
    ['https://other.example/wiki/A_(b)', 'https://other.example/wiki/A_(b)'],
    ['https://other.example/search?', 'https://other.example/search?'],
  ])('href %s は、%s として読める', async (href, url) => {
    const html = `<a href="${href.replace(/&/g, '&amp;')}">資料</a>`;
    const read = (await extractContent(html, links)).text;
    expect(read).toBe(`資料 <${url}>`);
    // 書き戻すと、同じ URL へのリンクになる（空のクエリの ? だけは外れる）
    expect(textToHtml(read)).toContain(`<a href="${url.replace(/\?$/, '')}" `);
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
