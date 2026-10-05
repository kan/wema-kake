// 画面の文言を、今の言語で取り出す（docs/plan.md のフェーズ 9）。
//
// **画面の文言を、コードに直接書かないこと。** ja.ts と en.ts にキーを足して、`t()` で取り出す。
// 言語は、このモジュールを読み込んだときに決まり、画面を開いている間は変わらない（切り替えたら、
// ページを読み込み直す）。文言を定数に入れているモジュールがあるので、途中では変えられない。
import { cookieValue, LANG_COOKIE, type Lang, resolveLang } from '../../shared/i18n';
import { en } from './en';
import { ja } from './ja';

type Messages = typeof ja;
/** 文言のキー */
export type MessageKey = keyof Messages;
/** 文言の関数が取る引数。そのままの文字列なら、引数はない */
type Args<K extends keyof Messages> = Messages[K] extends (...args: infer A) => string ? A : [];

/**
 * ブラウザの `document`。このモジュールは、DOM に依存しないモジュール（index-board.ts）からも
 * 読まれ、テスト（Workers のランタイム）でも動くので、あるかどうかを確かめて使う
 */
const browser = (globalThis as { document?: { cookie: string } }).document;

/** 今の言語。ブラウザの外（テスト）では、文言の正である日本語にする */
export const lang: Lang =
  browser === undefined
    ? 'ja'
    : resolveLang(cookieValue(browser.cookie, LANG_COOKIE), navigator.languages ?? []);

const messages: Messages = lang === 'ja' ? ja : en;

/** `key` の文言を、今の言語で返す。値を埋め込む文言には、その値を渡す */
export function t<K extends keyof Messages>(key: K, ...args: Args<K>): string {
  const message = messages[key] as string | ((...args: Args<K>) => string);
  return typeof message === 'string' ? message : message(...args);
}

/**
 * 切り替え先の言語（今の言語でないほう）。切り替えの項目に出す名前は、文言の `lang.switch`。
 * 言語を 3 つ以上にするときは、選ぶ形に作り直す
 */
export const otherLang: Lang = lang === 'ja' ? 'en' : 'ja';
