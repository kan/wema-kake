// 表示名とアイコン（issue #121）の API。`/api` の下に置くので、承認の関所を通る。
//   GET    /api/profile        自分の表示名とアイコン（と、メールの設定）
//   PUT    /api/profile/notify 新しい付箋のメールを受け取るか（issue #131）
//   PUT    /api/profile        自分の表示名を変える（本文は `{ "name": "..." }`。空文字で未設定に戻す）
//   PUT    /api/profile/icon   自分のアイコンを変える（本文は WebP か JPEG の画像）
//   DELETE /api/profile/icon   自分のアイコンを外す
//   POST   /api/profiles       主体の一覧から、表示名とアイコンをまとめて引く
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  ICON_CONTENT_TYPES,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_ICON_BYTES,
  MAX_PROFILE_LOOKUP,
  type OwnProfile,
} from '../shared/api';
import { isLang } from '../shared/i18n';
import type { AuthEnv } from './access';
import { contentTypeOf, storeImage } from './images';
import { canSendMail } from './mail';
import {
  noteNoticeOf,
  parseDisplayName,
  profileOf,
  profilesOfActors,
  setDisplayName,
  setIcon,
  setNoteNotice,
} from './profiles';

export const profilesApi = new Hono<AuthEnv>();

profilesApi.get('/profile', async (c) => {
  const email = c.get('email');
  const [profile, notice] = await Promise.all([profileOf(c.env.DB, email), noteNoticeOf(c.env.DB, email)]);
  return c.json({ ...profile, notifyNotes: notice !== null, mail: canSendMail(c.env) } satisfies OwnProfile);
});

/**
 * 自分が作ったページに、ほかの人が付箋を足したらメールで知らせるか（issue #131）。
 * 本文は `{ "notes": true, "lang": "ja" }`。`lang` はメールの言語（画面の言語を送る）
 */
profilesApi.put('/profile/notify', async (c) => {
  const body = await c.req.json<{ notes?: unknown; lang?: unknown }>().catch(() => null);
  if (typeof body?.notes !== 'boolean' || typeof body.lang !== 'string' || !isLang(body.lang)) {
    return c.json({ error: 'notes must be a boolean and lang must be "ja" or "en"' }, 400);
  }
  await setNoteNotice(c.env.DB, c.get('email'), body.notes, body.lang);
  return c.json({ ok: true });
});

profilesApi.put('/profile', async (c) => {
  const body = await c.req.json<{ name?: unknown }>().catch(() => null);
  const name = parseDisplayName(body?.name);
  if (name === undefined) {
    return c.json({ error: `name must be a string of at most ${MAX_DISPLAY_NAME_LENGTH} characters, without control characters` }, 400);
  }
  await setDisplayName(c.env.DB, c.get('email'), name);
  return c.json({ ok: true, name });
});

profilesApi.put(
  '/profile/icon',
  bodyLimit({ maxSize: MAX_ICON_BYTES, onError: (c) => c.json({ error: 'icon too large' }, 413) }),
  async (c) => {
    const contentType = contentTypeOf(c.req.header('Content-Type'));
    if (!(ICON_CONTENT_TYPES as readonly string[]).includes(contentType)) {
      return c.json({ error: `icon must be one of ${ICON_CONTENT_TYPES.join(', ')}` }, 415);
    }
    const body = await c.req.arrayBuffer();
    if (body.byteLength === 0) return c.json({ error: 'empty icon' }, 400);
    const key = await storeImage(c.env.IMAGES, body, contentType, c.get('actor'), 'icon');
    try {
      return c.json({ ok: true, icon: await setIcon(c.env.DB, c.env.IMAGES, c.get('email'), key) });
    } catch (e) {
      // 表に書けなければ、どこからも参照されない画像になる
      await c.env.IMAGES.delete(key);
      throw e;
    }
  },
);

profilesApi.delete('/profile/icon', async (c) => {
  await setIcon(c.env.DB, c.env.IMAGES, c.get('email'), null);
  return c.json({ ok: true, icon: null });
});

/**
 * 本文は `{ "actors": ["user:<email>", ...] }`。応答は `{ "profiles": { "<主体>": { name, icon } } }` で、
 * 何かを設定した人だけが入る（キーは、渡された主体の文字列のまま）。`user:` でない主体（agent）は入らない
 */
profilesApi.post('/profiles', async (c) => {
  const body = await c.req.json<{ actors?: unknown }>().catch(() => null);
  const actors = body?.actors;
  if (!Array.isArray(actors) || actors.length > MAX_PROFILE_LOOKUP || !actors.every((a) => typeof a === 'string')) {
    return c.json({ error: `actors must be an array of at most ${MAX_PROFILE_LOOKUP} strings` }, 400);
  }
  return c.json({ profiles: Object.fromEntries(await profilesOfActors(c.env.DB, actors as string[])) });
});
