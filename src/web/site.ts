// サイトの設定。Worker が index.html に埋め込んだ `<meta>` から、読み込み時に 1 回だけ読む
// （src/shared/site.ts）。ブラウザの外（テスト）や、`<meta>` がないときは既定の値にする
import type { ApprovalStatus } from '../shared/api';
import { APPROVAL_META_NAME, parseSiteConfig, SITE_META_NAME, type SiteConfig } from '../shared/site';

// i18n と同じく、テスト（Workers のランタイム。DOM の型もない）からも読まれるので、自前の型で受ける
const browser = (
  globalThis as { document?: { querySelector(selector: string): { getAttribute(name: string): string | null } | null } }
).document;

export const site: SiteConfig = parseSiteConfig(
  browser?.querySelector(`meta[name="${SITE_META_NAME}"]`)?.getAttribute('content'),
);

const approvalMeta = browser?.querySelector(`meta[name="${APPROVAL_META_NAME}"]`)?.getAttribute('content');

/**
 * 承認（設定の `approval`）が済んでいなければ、その状態（'pending' / 'rejected'）。済んでいるか、
 * 承認が無効なら undefined。画面は、これが付いていたら承認待ちの表示だけを出す
 */
// 知らない値（新しい状態を足した Worker）は、承認待ちとして扱う
export const unapproved: Exclude<ApprovalStatus, 'approved'> | undefined =
  !approvalMeta || approvalMeta === 'approved' ? undefined : approvalMeta === 'rejected' ? 'rejected' : 'pending';
