import { describe, expect, it } from 'vitest';
import { cookieValue, parseAcceptLanguage, requestLang, resolveLang } from '../src/shared/i18n';
import { parseSystemSummary, systemSummary } from '../src/shared/op-summary';
import { en } from '../src/web/i18n/en';
import { ja } from '../src/web/i18n/ja';

describe('言語を決める', () => {
  it('選んだ言語が、ブラウザの設定より優先される', () => {
    expect(resolveLang('en', ['ja'])).toBe('en');
    expect(resolveLang('ja', ['en-US'])).toBe('ja');
  });

  it('選んでいなければ、ブラウザの設定の、優先の高い順で決める。地域つきの値は、先頭の部分で比べる', () => {
    expect(resolveLang(undefined, ['fr', 'ja-JP', 'en'])).toBe('ja');
    expect(resolveLang(undefined, ['EN-us', 'ja'])).toBe('en');
  });

  it('対応する言語がなければ en。不正な値の Cookie は無視する', () => {
    expect(resolveLang(undefined, ['fr', 'de'])).toBe('en');
    expect(resolveLang(undefined, [])).toBe('en');
    expect(resolveLang('fr', ['ja'])).toBe('ja');
    expect(resolveLang('', ['ja'])).toBe('ja');
  });

  it('Accept-Language を、q 値の高い順に並べる。同じ q なら書かれた順。q が 0 のものは外す', () => {
    expect(parseAcceptLanguage('en-US,en;q=0.8,ja;q=0.9')).toEqual(['en-US', 'ja', 'en']);
    expect(parseAcceptLanguage('ja;q=0, en;q=0.5, *;q=0.1')).toEqual(['en']);
    expect(parseAcceptLanguage(null)).toEqual([]);
    expect(parseAcceptLanguage('')).toEqual([]);
  });

  it('Cookie の文字列から、名前の一致する値だけを取り出す', () => {
    expect(cookieValue('a=1; wk_lang=en; b=2', 'wk_lang')).toBe('en');
    expect(cookieValue('xwk_lang=en', 'wk_lang')).toBeUndefined();
    expect(cookieValue(null, 'wk_lang')).toBeUndefined();
  });

  it('リクエストの Cookie と Accept-Language から決める', () => {
    const request = (headers: Record<string, string>) => new Request('http://localhost/', { headers });
    expect(requestLang(request({ 'Accept-Language': 'ja,en;q=0.5' }))).toBe('ja');
    expect(requestLang(request({ 'Accept-Language': 'ja', Cookie: 'wk_lang=en' }))).toBe('en');
    expect(requestLang(request({}))).toBe('en');
  });
});

describe('画面の文言', () => {
  it('日本語と英語で、値を埋め込む文言の引数の数が同じ', () => {
    // キーがそろっていることと、引数の型は、en.ts の satisfies で確かめている。ここでは、
    // 片方だけが関数になっていないか（値を埋め込み忘れていないか）を確かめる
    for (const key of Object.keys(ja) as (keyof typeof ja)[]) {
      expect(typeof en[key], key).toBe(typeof ja[key]);
    }
  });
});

describe('サーバーが付ける操作の要約', () => {
  it('符号にして、読み戻せる', () => {
    expect(parseSystemSummary(systemSummary.pageCreated())).toEqual({ kind: 'pageCreated' });
    expect(parseSystemSummary(systemSummary.childRemoved('my-page'))).toEqual({ kind: 'childRemoved', page: 'my-page' });
    expect(parseSystemSummary(systemSummary.revert(12))).toEqual({ kind: 'revert', seq: 12 });
  });

  it('符号でない要約と、知らない符号は、null（画面は、書かれたまま出す）', () => {
    expect(parseSystemSummary('子ページ a の削除')).toBeNull();
    expect(parseSystemSummary('revert #3')).toBeNull();
    expect(parseSystemSummary('system:unknown')).toBeNull();
    expect(parseSystemSummary('system:revert:')).toBeNull();
    expect(parseSystemSummary('system:revert:abc')).toBeNull();
  });
});
