import '@kanf/wema/style.css';
import './style.css';
import { isValidSlug } from '../shared/slug';
import { openHelp } from './help-view';
import { openIndex } from './index-view';
import { startRouter } from './navigation';
import { openPage } from './page-view';

const app = document.getElementById('app')!;

startRouter((path, initial, arrival) => {
  const slug = /^\/p\/([^/]+)\/?$/.exec(path)?.[1];
  const isPage = slug !== undefined && isValidSlug(slug);
  if (isPage || path === '/' || path === '/help') {
    app.replaceChildren();
    if (isPage) openPage(app, slug, arrival);
    else if (path === '/help') openHelp(app);
    else openIndex(app, arrival);
    return true;
  }
  // 見つからないパスは、最初の画面としてだけ出す。他の画面から移るときは、読み込み直す
  if (!initial) return false;
  app.textContent = 'ページが見つかりません';
  return true;
});
