import { describe, expect, it } from 'vitest';
import { textToHtml } from '../src/shared/note-text';
import { sanitizeHtml } from '../src/worker/sanitize';

describe('textToHtml', () => {
  it.each([
    ['1 行', '1 行'],
    ['1 行目\n2 行目', '1 行目<br>2 行目'],
    ['改行コードの違い\r\n2 行目\r3 行目', '改行コードの違い<br>2 行目<br>3 行目'],
    ['<b>タグ</b> & "引用"', '&lt;b&gt;タグ&lt;/b&gt; &amp; "引用"'],
    ['- 一つ目\n- 二つ目', '<ul><li>一つ目</li><li>二つ目</li></ul>'],
    [
      '- [ ] 未完了\n- [x] 完了\n- [X] 完了',
      '<ul class="wema-checklist"><li><input type="checkbox">未完了</li>' +
        '<li class="wema-checked"><input type="checkbox" checked>完了</li>' +
        '<li class="wema-checked"><input type="checkbox" checked>完了</li></ul>',
    ],
    [
      '見出し\n- 項目\n- [ ] やること\n結び',
      '見出し<ul><li>項目</li></ul><ul class="wema-checklist"><li><input type="checkbox">やること</li></ul>結び',
    ],
    ['-ハイフンだけでは箇条書きにしない', '-ハイフンだけでは箇条書きにしない'],
    // ページへのリンク。スラッグの形でないものは、文字のまま
    ['[[design]] を参照', '<a href="/p/design">design</a> を参照'],
    ['- [ ] [[todo-1]] を見る', '<ul class="wema-checklist"><li><input type="checkbox"><a href="/p/todo-1">todo-1</a> を見る</li></ul>'],
    ['[[Bad_Slug]] [[]] [[a b]] [[javascript:alert(1)]]', '[[Bad_Slug]] [[]] [[a b]] [[javascript:alert(1)]]'],
    ['[[<b>]] と [[a]]<script>', '[[&lt;b&gt;]] と <a href="/p/a">a</a>&lt;script&gt;'],
    ['- <script>alert(1)</script>', '<ul><li>&lt;script&gt;alert(1)&lt;/script&gt;</li></ul>'],
  ])('%j → %s', (text, html) => {
    expect(textToHtml(text)).toBe(html);
  });

  const link = (href: string) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${href}</a>`;

  // 外部の URL は、URL そのものを文字にしたリンクになる（文字でリンク先を偽れない）
  it.each([
    ['出典: https://example.com/news/1', `出典: ${link('https://example.com/news/1')}`],
    ['http://example.com', link('http://example.com/')],
    // クエリの & は、文字と属性の両方でエスケープする
    ['https://example.com/?a=1&b=2#top', link('https://example.com/?a=1&amp;b=2#top')],
    // 文の句読点と、対にならない閉じかっこは、URL に含めない
    ['詳細（https://example.com/a）。', `詳細（${link('https://example.com/a')}）。`],
    ['(see https://example.com/a).', `(see ${link('https://example.com/a')}).`],
    ['https://en.wikipedia.org/wiki/A_(b), 次', `${link('https://en.wikipedia.org/wiki/A_(b)')}, 次`],
    // 日本語の文に続けて書いても、URL は ASCII の範囲で終わる
    ['記事はhttps://example.com/aです', `記事は${link('https://example.com/a')}です`],
    ['- https://a.example/ と [[design]]', `<ul><li>${link('https://a.example/')} と <a href="/p/design">design</a></li></ul>`],
    // ユーザー名つきの URL（ホスト名を見誤らせる書き方）は、リンクにしない
    ['https://trusted.example@evil.example/x', 'https://trusted.example@evil.example/x'],
    ['https://user:pass@evil.example/', 'https://user:pass@evil.example/'],
    // ホスト名のパーセントエンコードは、解釈で復号される。引用符などが現れる URL は、リンクにしない
    ['https://x%22onmouseover=alert(1)//', 'https://x%22onmouseover=alert(1)//'],
    ['https://x%22class=a/ https://x%27y/ https://x%60y/', 'https://x%22class=a/ https://x%27y/ https://x%60y/'],
    // http と https 以外は、リンクにしない
    ['javascript:alert(1) ftp://example.com/ data:text/html,x', 'javascript:alert(1) ftp://example.com/ data:text/html,x'],
    ['https:// と http://', 'https:// と http://'],
    // Markdown の書式は解釈しない。URL の部分だけがリンクになる
    ['[安全なサイト](https://evil.example/)', `[安全なサイト](${link('https://evil.example/')})`],
    // HTML で書いたリンクは、文字のまま。中の URL だけが、URL を文字にしたリンクになる
    [
      '<a href="https://evil.example/">銀行</a>',
      `&lt;a href="${link('https://evil.example/')}"&gt;銀行&lt;/a&gt;`,
    ],
  ])('%j → %s', (text, html) => {
    expect(textToHtml(text)).toBe(html);
  });

  it('閉じかっこの並んだ本文でも、遅くならない', () => {
    const started = performance.now();
    textToHtml(`https://a.example/${')'.repeat(19_000)}`);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it('変換した HTML は、サニタイザを通しても変わらない', async () => {
    const html = textToHtml(
      '見出し <b>\n- 項目 & 記号\n- [x] 完了\n- [ ] 未完了\n結び https://example.com/?a=1&b=2 と [[design]]',
    );
    expect(await sanitizeHtml(html)).toBe(html);
  });
});
