import { WemaBoard } from '@kanf/wema';
import '@kanf/wema/style.css';
import { isValidSlug } from '../shared/slug';

const app = document.getElementById('app')!;

const slug = /^\/p\/([^/]+)$/.exec(location.pathname)?.[1];

if (slug && isValidSlug(slug)) {
  document.title = `${slug} - wema-kake`;
  new WemaBoard({ container: app });
} else {
  app.textContent = 'wema-kake';
}
