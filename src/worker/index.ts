import { Hono } from 'hono';
import { isValidSlug } from '../shared/slug';

export { PageDO } from './page-do';

const app = new Hono<{ Bindings: Env }>();

app.get('/api/pages/:slug', async (c) => {
  const slug = c.req.param('slug');
  if (!isValidSlug(slug)) {
    return c.json({ error: 'invalid slug' }, 400);
  }
  return c.json({ slug, seq: await c.env.PAGE.getByName(slug).getSeq() });
});

export default app;
