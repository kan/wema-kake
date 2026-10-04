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
    ['[[Bad_Slug]] [[]] [[a b]] [[https://x.example]]', '[[Bad_Slug]] [[]] [[a b]] [[https://x.example]]'],
    ['[[<b>]] と [[a]]<script>', '[[&lt;b&gt;]] と <a href="/p/a">a</a>&lt;script&gt;'],
    ['- <script>alert(1)</script>', '<ul><li>&lt;script&gt;alert(1)&lt;/script&gt;</li></ul>'],
  ])('%j → %s', (text, html) => {
    expect(textToHtml(text)).toBe(html);
  });

  it('変換した HTML は、サニタイザを通しても変わらない', async () => {
    const html = textToHtml('見出し <b>\n- 項目 & 記号\n- [x] 完了\n- [ ] 未完了\n結び');
    expect(await sanitizeHtml(html)).toBe(html);
  });
});
