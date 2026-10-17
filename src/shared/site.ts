// サイトの設定のうち、画面が使うもの。Worker が index.html に埋め込み、画面が読み込み時に読む。
//
// 画面の言語は、スクリプトを読み込んだときに同期で決める（src/web/i18n/index.ts）。API で
// 問い合わせる形だと、その応答を待つまで文言を決められないので、HTML に入れて渡す。
import { DEFAULT_LANG, isLang, type Lang } from './i18n';

export interface SiteConfig {
  /** 画面に出すサイトの名前（一覧の見出しと、タブの表示名） */
  siteName: string;
  /** Cookie もブラウザの言語も、対応する言語に当たらないときの言語 */
  defaultLang: Lang;
}

/** 設定を省いたときの値 */
export const DEFAULT_SITE: SiteConfig = { siteName: 'wema-kake', defaultLang: DEFAULT_LANG };

/** index.html の `<head>` に入れる `<meta>` の名前。`content` は SiteConfig の JSON */
export const SITE_META_NAME = 'wema-kake-site';

/**
 * `<meta>` の `content` を読む。読めない値や欠けた項目は、既定の値にする（Worker を通らずに
 * 配られた index.html でも、画面が動くようにする）
 */
export function parseSiteConfig(content: string | null | undefined): SiteConfig {
  let value: Partial<Record<keyof SiteConfig, unknown>> = {};
  try {
    const parsed: unknown = JSON.parse(content ?? '');
    if (parsed && typeof parsed === 'object') value = parsed;
  } catch {
    // 下で既定の値にする
  }
  return {
    siteName: typeof value.siteName === 'string' && value.siteName !== '' ? value.siteName : DEFAULT_SITE.siteName,
    defaultLang: typeof value.defaultLang === 'string' && isLang(value.defaultLang) ? value.defaultLang : DEFAULT_SITE.defaultLang,
  };
}
