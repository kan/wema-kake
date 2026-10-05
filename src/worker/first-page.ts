// 最初のページ。ページが 1 つもない環境で、一覧を最初に開いたときに、使い方の付箋を置いた
// ページを 1 回だけ作る。作ったことは D1 の settings に記録し、すべてのページを消しても作り直さない。
import type { HistoryDelta } from '../shared/delta';
import { FIRST_PAGE, guideBoard } from '../shared/guide';

const KEY = 'first_page';

/**
 * まだ作っていなければ、最初のページを作る。作ったら true。
 * 一覧が空のときにだけ呼ぶ（呼ぶたびに D1 へ書き込みを試みるため）
 */
export async function createFirstPage(env: Env): Promise<boolean> {
  // 記録を先に書く。同時に届いたリクエストのうち、書けた 1 つだけが作る
  const claimed = await env.DB.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, 'created')`)
    .bind(KEY)
    .run();
  if (claimed.meta.changes === 0) return false;
  try {
    const { notes, edges } = guideBoard('first');
    const deltas: HistoryDelta[] = [
      ...notes.map((note): HistoryDelta => ({ type: 'note:create', note })),
      ...edges.map((edge): HistoryDelta => ({ type: 'edge:create', edge })),
    ];
    return await env.PAGE.getByName(FIRST_PAGE.slug).createWithContent(FIRST_PAGE.title, deltas);
  } catch (e) {
    // 作れなかったら、記録を消して、次に一覧を開いたときにやり直す
    await env.DB.prepare(`DELETE FROM settings WHERE key = ?`).bind(KEY).run();
    throw e;
  }
}
