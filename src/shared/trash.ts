// ゴミ箱と、古い付箋を自動で消す設定（issue #27）。
//
// 付箋を消すと、すぐには消さずにゴミ箱のページへ移す。ゴミ箱は、ふつうのページと同じ DO で、
// 「古い付箋を自動で消す」設定が 30 日に固定されている。この設定は、ほかのページにも付けられる。
// ゴミ箱以外のページで期限を過ぎた付箋は、ゴミ箱へ移る。ゴミ箱で期限を過ぎた付箋は、消える。
import type { WemaNote } from './delta';
import { childPageOf } from './hierarchy';

/** ゴミ箱のページのスラッグ。予約してあり、一覧、検索、リンクの索引には出さない */
export const TRASH_SLUG = 'trash';

/** ゴミ箱の付箋が消えるまでの日数 */
export const TRASH_EXPIRE_DAYS = 30;

/** ページに付けられる「古い付箋を自動で消す」日数。付けていなければ null */
export const EXPIRE_DAYS_CHOICES = [7, 30, 90] as const;

export const DAY_MS = 24 * 60 * 60 * 1000;

export const isTrash = (slug: string): boolean => slug === TRASH_SLUG;

/**
 * 自動で消す対象（ゴミ箱へ移す対象）の付箋か。子ページの付箋（ページを表す付箋）は対象にしない。
 * サーバーの SQL の条件（src/worker/page-do.ts の `EXPIRABLE`）と、同じ規則にすること
 */
export const isExpirable = (note: Pick<WemaNote, 'meta'>): boolean => childPageOf(note) === undefined;

/**
 * 付箋の古さ。最後に更新してから、期限までのどこにいるか（0 から 1）。画面は、これが大きいほど
 * 付箋を薄く出す（不透明度は src/web/style.css の `--note-age`）
 */
export function noteAge(updatedAt: number, expireDays: number, now: number): number {
  return Math.min(Math.max((now - updatedAt) / (expireDays * DAY_MS), 0), 1);
}
