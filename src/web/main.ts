import '@kanf/wema/style.css';
import './style.css';
import { isValidSlug } from '../shared/slug';
import { openIndex } from './index-view';
import { openPage } from './page-view';

const app = document.getElementById('app')!;

const slug = /^\/p\/([^/]+)\/?$/.exec(location.pathname)?.[1];
if (slug && isValidSlug(slug)) {
  openPage(app, slug);
} else if (location.pathname === '/') {
  openIndex(app);
} else {
  app.textContent = 'ページが見つかりません';
}
