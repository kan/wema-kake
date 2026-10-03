import { describe, expect, it } from 'vitest';
import { sanitizeHtml } from '../src/worker/sanitize';

describe('sanitizeHtml（wema の tests/sanitize.test.ts と同じケース）', () => {
  it.each([
    '<b>bold</b> <i>italic</i> <u>underline</u>',
    'line1<br>line2',
    '<span style="color: red;">x</span>',
    '<a href="https://example.com" target="_blank">link</a>',
    '<ul><li>item1</li><li>item2</li></ul>',
    '<input type="checkbox" checked>',
    '<img src="/img/00000000-0000-0000-0000-000000000000.png" alt="test">',
    '<iframe src="https://example.com" width="560" height="315"></iframe>',
    '<ul><li><b>bold item</b></li></ul>',
    'Hello world',
    '5 < 10 and 10 > 5',
    'a &lt;b&gt; &amp; c',
  ])('%s は変えない', async (html) => {
    expect(await sanitizeHtml(html)).toBe(html);
  });

  it.each([
    ['safe text<script>alert("xss")</script>', 'safe text'],
    ['<b onclick="alert(1)" onmouseover="alert(2)">bold</b>', '<b>bold</b>'],
    ['<a href="javascript:alert(1)">x</a>', '<a>x</a>'],
    ['<img src="javascript:alert(1)">', '<img>'],
    ['<span style="color: red; position: absolute; top: 0">x</span>', '<span style="color: red">x</span>'],
    ['<input type="text" value="x">', ''],
    ['<input>', ''],
    ['<font color="red">styled text</font>', 'styled text'],
  ])('%s → %s', async (html, expected) => {
    expect(await sanitizeHtml(html)).toBe(expected);
  });
});

describe('sanitizeHtml（サーバー側で厳しくしている点）', () => {
  it.each([
    // スキームの偽装
    ['<a href=" JaVa\tScRiPt:alert(1)">x</a>', '<a>x</a>'],
    ['<a href="&#106;avascript:alert(1)">x</a>', '<a>x</a>'],
    ['<a href="java&Tab;script:alert(1)">x</a>', '<a>x</a>'],
    ['<a href="data:text/html,<script>alert(1)</script>">x</a>', '<a>x</a>'],
    ['<iframe src="data:text/html;base64,PHNjcmlwdD4="></iframe>', '<iframe></iframe>'],
    ['<img src="data:image/svg+xml,<svg onload=alert(1)>">', '<img>'],
    ['<video src="https://example.com/a.mp4" poster="javascript:alert(1)"></video>', '<video src="https://example.com/a.mp4"></video>'],
    // タグを外すと中身がマークアップになる要素は中身ごと除く
    ['a<textarea><script>alert(1)</script></textarea>b', 'ab'],
    ['a<title><img src=x onerror=alert(1)></title>b', 'ab'],
    ['a<svg><style><img src=x onerror=alert(1)></style></svg>b', 'ab'],
    ['a<math><mi>x</mi></math>b', 'ab'],
    ['<iframe src="https://example.com"><script>alert(1)</script></iframe>', '<iframe src="https://example.com"></iframe>'],
    // タグ名を割っても script にはならない（対応する開始タグのない終了タグは残るが無害）
    ['<scr<font>ipt>alert(1)</scr</font>ipt>', 'ipt>alert(1)</scr</font>ipt>'],
    // コメント
    ['a<!-- c -->b<b>c<!-- d --></b>', 'ab<b>c</b>'],
    // style の値
    ['<span style="color: red; background-color: url(javascript:alert(1))">x</span>', '<span style="color: red">x</span>'],
    ['<span style="color: &#x72;ed">x</span>', '<span>x</span>'],
    ['<span style="position: fixed">x</span>', '<span>x</span>'],
    // 相対 URL と許可したスキームは残す
    ['<a href="/p/memo">x</a>', '<a href="/p/memo">x</a>'],
    ['<a href="mailto:a@example.com">x</a>', '<a href="mailto:a@example.com">x</a>'],
    ['<a href="tel:+81-3-0000-0000">x</a>', '<a href="tel:+81-3-0000-0000">x</a>'],
    // 画像は R2 に置く。data URL は受け付けない（wema は許可している）
    ['<img src="data:image/png;base64,abc" alt="test">', '<img alt="test">'],
    ['<video src="data:video/mp4;base64,abc"></video>', '<video></video>'],
    ['<a href="https://example.com/?a=1&amp;b=2">x</a>', '<a href="https://example.com/?a=1&amp;b=2">x</a>'],
  ])('%s → %s', async (html, expected) => {
    expect(await sanitizeHtml(html)).toBe(expected);
  });

  it('結果をもう一度通しても変わらない', async () => {
    const once = await sanitizeHtml('<div><font><b onclick="x">a</b></font><script>y</script></div>');
    expect(await sanitizeHtml(once)).toBe(once);
  });
});
