// 付箋に貼る画像。R2 に置き、text には URL（/img/<key>）だけを入れる。
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AuthEnv } from './access';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** 受け付ける形式。SVG はスクリプトを含められるので受け付けない */
const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
};

const KEY_RE = new RegExp(`^[0-9a-f-]{36}\\.(${Object.values(EXTENSIONS).join('|')})$`);

/** 送られてきた本文の形式（`Content-Type` の、引数を除いた部分。小文字） */
export const contentTypeOf = (header: string | undefined): string => header?.split(';')[0].trim().toLowerCase() ?? '';

/**
 * 画像を R2 に置き、キーを返す（`/img/<key>` で返せる形。`KEY_RE`）。`contentType` は `EXTENSIONS` のどれか。
 * 付箋の画像と、利用者のアイコン（src/worker/profiles-api.ts）が使う
 */
export async function storeImage(
  bucket: R2Bucket,
  body: ArrayBuffer,
  contentType: string,
  uploadedBy: string,
  purpose?: string,
): Promise<string> {
  const key = `${crypto.randomUUID()}.${EXTENSIONS[contentType]}`;
  await bucket.put(key, body, {
    httpMetadata: { contentType },
    customMetadata: { uploadedBy, ...(purpose ? { purpose } : {}) },
  });
  return key;
}

export const images = new Hono<AuthEnv>();

/** 本文に画像のバイト列、Content-Type に画像の形式を入れて送る */
images.post(
  '/api/images',
  // Content-Length のない送信でも、上限を超える本文をメモリに載せない
  bodyLimit({
    maxSize: MAX_IMAGE_BYTES,
    onError: (c) => c.json({ error: 'image too large' }, 413),
  }),
  async (c) => {
    const contentType = contentTypeOf(c.req.header('Content-Type'));
    if (!EXTENSIONS[contentType]) return c.json({ error: 'unsupported image type' }, 415);
    const body = await c.req.arrayBuffer();
    if (body.byteLength === 0) return c.json({ error: 'empty image' }, 400);

    const key = await storeImage(c.env.IMAGES, body, contentType, c.get('actor'));
    return c.json({ url: `/img/${key}` }, 201);
  },
);

images.get('/img/:key', async (c) => {
  const key = c.req.param('key');
  if (!KEY_RE.test(key)) return c.notFound();
  const object = await c.env.IMAGES.get(key);
  if (!object) return c.notFound();
  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
      ETag: object.httpEtag,
      // キーは内容ごとに新しく作るので、同じ URL の内容は変わらない
      'Cache-Control': 'private, max-age=31536000, immutable',
      // 申告された形式と中身が違っても、ブラウザに HTML などとして解釈させない
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  });
});
