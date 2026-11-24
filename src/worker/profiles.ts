// 利用者の表示名とアイコン（issue #121）。D1 の `profiles`（migrations/0008_profiles.sql）に持ち、
// アイコンの画像は、付箋の画像と同じ R2（`IMAGES`）に置く（/img/<key> で返す）。
//
// 承認の `users` とは別の表にする。管理者と、承認が無効なときの利用者も、表示名とアイコンを持てるようにするため。
import { MAX_DISPLAY_NAME_LENGTH, type Profile } from '../shared/api';
import { DEFAULT_LANG, type Lang, resolveLang } from '../shared/i18n';
import { emailOfActor } from '../shared/note-info';

interface ProfileRow {
  email: string;
  name: string | null;
  icon: string | null;
}

/** D1 の 1 文で束ねられる値の数の上限（100）より少なくする */
const LOOKUP_CHUNK = 90;

const iconUrl = (key: string | null) => (key === null ? null : `/img/${key}`);

const toProfile = (row: Pick<ProfileRow, 'name' | 'icon'>): Profile => ({ name: row.name, icon: iconUrl(row.icon) });

/** 表示名を検証する。空文字は未設定（null）。不正なら undefined */
export function parseDisplayName(input: unknown): string | null | undefined {
  if (typeof input !== 'string') return undefined;
  const name = input.trim();
  // 制御文字（改行を含む）、行と段落の区切り、文字の向きを変える制御（Bidi_Control）は、作者の表示を崩す
  // （向きを変えると、ほかの人の名前に見せかけられる）ので受け付けない
  if ([...name].length > MAX_DISPLAY_NAME_LENGTH || /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/u.test(name)) {
    return undefined;
  }
  return name || null;
}

/** `email` の人の表示名とアイコン。まだ何も設定していなければ、どちらも null */
export async function profileOf(db: D1Database, email: string): Promise<Profile> {
  const row = await db
    .prepare('SELECT name, icon FROM profiles WHERE email = ?')
    .bind(email.toLowerCase())
    .first<Pick<ProfileRow, 'name' | 'icon'>>();
  return row ? toProfile(row) : { name: null, icon: null };
}

/**
 * 主体（'user:<email>'）ごとの表示名とアイコン。キーは渡した主体の文字列のまま（email の大文字と小文字は
 * 区別しない）。何も設定していない人と、人でない主体（agent）は入らない
 */
export async function profilesOfActors(db: D1Database, actors: Iterable<string>): Promise<Map<string, Profile>> {
  const byEmail = new Map<string, string[]>();
  for (const actor of actors) {
    const email = emailOfActor(actor)?.toLowerCase();
    if (email !== undefined) byEmail.set(email, [...(byEmail.get(email) ?? []), actor]);
  }
  const keys = [...byEmail.keys()];
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < keys.length; i += LOOKUP_CHUNK) {
    const chunk = keys.slice(i, i + LOOKUP_CHUNK);
    statements.push(
      db.prepare(`SELECT email, name, icon FROM profiles WHERE email IN (${chunk.map(() => '?').join(', ')})`).bind(...chunk),
    );
  }
  const found = new Map<string, Profile>();
  // 束ねきれない分も、1 回の往復で引く
  for (const { results } of statements.length === 0 ? [] : await db.batch<ProfileRow>(statements)) {
    for (const row of results) {
      if (row.name === null && row.icon === null) continue;
      for (const actor of byEmail.get(row.email) ?? []) found.set(actor, toProfile(row));
    }
  }
  return found;
}

const upsert = (column: 'name' | 'icon') =>
  `INSERT INTO profiles (email, ${column}, updated_at) VALUES (?, ?, ?)
   ON CONFLICT (email) DO UPDATE SET ${column} = excluded.${column}, updated_at = excluded.updated_at`;

/** 新しい付箋のメールの設定（issue #131）。受け取らない人、まだ何も設定していない人は null */
export async function noteNoticeOf(db: D1Database, email: string): Promise<{ lang: Lang } | null> {
  const row = await db
    .prepare('SELECT notify_notes, notify_lang FROM profiles WHERE email = ?')
    .bind(email.toLowerCase())
    .first<{ notify_notes: number; notify_lang: string | null }>();
  if (!row?.notify_notes) return null;
  return { lang: resolveLang(row.notify_lang ?? undefined, [], DEFAULT_LANG) };
}

/** 新しい付箋のメールを受け取るかを変える。`lang` はメールの言語 */
export async function setNoteNotice(db: D1Database, email: string, on: boolean, lang: Lang): Promise<void> {
  await db
    .prepare(
      `INSERT INTO profiles (email, notify_notes, notify_lang, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (email) DO UPDATE SET notify_notes = excluded.notify_notes, notify_lang = excluded.notify_lang,
         updated_at = excluded.updated_at`,
    )
    .bind(email.toLowerCase(), on ? 1 : 0, lang, Date.now())
    .run();
}

/** 表示名を変える（null で未設定に戻す） */
export async function setDisplayName(db: D1Database, email: string, name: string | null): Promise<void> {
  await db.prepare(upsert('name')).bind(email.toLowerCase(), name, Date.now()).run();
}

/**
 * アイコンを変える（`key` が null なら外す）。前の画像は R2 から消す（ほかから参照されないため）。
 * 返り値は新しいアイコンの URL
 */
export async function setIcon(db: D1Database, bucket: R2Bucket, email: string, key: string | null): Promise<string | null> {
  const id = email.toLowerCase();
  // 前のキーを読んでから書く（1 回の往復）。同じ人が同時に変えると前の画像が残ることがあるが、表は壊れない
  const [before] = await db.batch<{ icon: string | null }>([
    db.prepare('SELECT icon FROM profiles WHERE email = ?').bind(id),
    db.prepare(upsert('icon')).bind(id, key, Date.now()),
  ]);
  const old = before.results[0]?.icon;
  if (old && old !== key) await bucket.delete(old);
  return iconUrl(key);
}
