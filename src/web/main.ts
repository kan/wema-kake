import '@kanf/wema/style.css';
import './style.css';
import { isValidSlug } from '../shared/slug';
import { openHelp } from './help-view';
import { lang, t } from './i18n';
import { openIndex } from './index-view';
import { isAppPath, pageSlugOf, startRouter, type Transition } from './navigation';
import { openPage } from './page-view';
import { unapproved } from './site';
import { openApprovalWait, openUsers } from './users-view';

const app = document.getElementById('app')!;
// index.html は 1 つなので、言語は、決めた後でここから入れる（読み上げと、ブラウザの翻訳の判定に使われる）
document.documentElement.lang = lang;

// 承認（設定の `approval`）が済んでいない人には、どのパスでも承認待ちの表示だけを出す
if (unapproved) openApprovalWait(app, unapproved);
else startRouter(renderPath);

function renderPath(path: string, initial: boolean, arrival?: Transition): boolean {
  const slug = pageSlugOf(path);
  const isPage = slug !== undefined && isValidSlug(slug);
  // /p/ で始まるパスは、スラッグが正しいときだけ画面にする（/p/a/b は見つからない）
  if (isPage || (!path.startsWith('/p/') && isAppPath(path))) {
    app.replaceChildren();
    if (isPage) openPage(app, slug, arrival);
    else if (path === '/help') openHelp(app);
    else if (path === '/users') openUsers(app);
    else openIndex(app, arrival);
    return true;
  }
  // 見つからないパスは、最初の画面としてだけ出す。他の画面から移るときは、読み込み直す
  if (!initial) return false;
  app.textContent = t('notFound');
  return true;
}
