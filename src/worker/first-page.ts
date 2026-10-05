// 最初のページ。ページが 1 つもない環境で、一覧を最初に開いたときに、使い方の付箋を置いた
// ページを 1 回だけ作る。作ったことは D1 の settings に記録し、すべてのページを消しても作り直さない。
import type { HistoryDelta } from '../shared/delta';
import { FIRST_PAGE_SLUG, firstPageTitle, guideBoard } from '../shared/guide';
import type { Lang } from '../shared/i18n';

const KEY = 'first_page';

/**
 * まだ作っていなければ、最初のページを作る。作ったら true。
 * 一覧が空のときにだけ呼ぶ（呼ぶたびに D1 へ書き込みを試みるため）。
 *
 * `lang` は、一覧を開いた人の画面の言語。その言語の表示名と付箋で作る。作った後は、ふつうの
 * ページなので、言語を切り替えても変わらない
 */
export async function createFirstPage(env: Env, lang: Lang): Promise<boolean> {
  // 記録を先に書く。同時に届いたリクエストのうち、書けた 1 つだけが作る
  const claimed = await env.DB.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, 'created')`)
    .bind(KEY)
    .run();
  if (claimed.meta.changes === 0) return false;
  try {
    const { notes, edges } = guideBoard('first', lang);
    const deltas: HistoryDelta[] = [
      ...notes.map((note): HistoryDelta => ({ type: 'note:create', note })),
      ...edges.map((edge): HistoryDelta => ({ type: 'edge:create', edge })),
    ];
    return await env.PAGE.getByName(FIRST_PAGE_SLUG).createWithContent(firstPageTitle(lang), deltas);
  } catch (e) {
    // 作れなかったら、記録を消して、次に一覧を開いたときにやり直す
    await env.DB.prepare(`DELETE FROM settings WHERE key = ?`).bind(KEY).run();
    throw e;
  }
}
