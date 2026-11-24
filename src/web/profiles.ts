// 利用者の表示名とアイコン（issue #121）。サーバーから引いた結果を、主体ごとに覚えておく。
//
// 名前を出す画面は、`requestProfiles` で引く。出す前に待つか、先に描いて、届いたら `onProfilesChange` で
// 描き直す。表示名を設定していない人は、email の `@` より前を名前にする。
import { MAX_PROFILE_LOOKUP, type Profile } from '../shared/api';
import { emailOfActor, isAgentActor } from '../shared/note-info';
import { lookupProfiles } from './api';
import { el } from './dom';
import { t } from './i18n';

/** 引いた結果を使う時間。ほかの人が名前を変えても、長くてもこれだけ経てば、次に出すときに引き直す */
const PROFILE_TTL_MS = 60_000;

/** 引けなかったときに、引き直すまで待つ時間（描くたびに引き直さない） */
const RETRY_MS = 10_000;

const UNSET: Profile = { name: null, icon: null };

/** 主体ごとの結果。`until` まで使う */
const cache = new Map<string, { profile: Profile; until: number }>();
const listeners = new Set<() => void>();
let queued = new Set<string>();
let flush: Promise<void> | undefined;
/** 引いている途中の主体と、その引き終わり。同じ人を重ねて引かない */
const inFlight = new Map<string, Promise<void>>();

const fresh = (actor: string) => (cache.get(actor)?.until ?? 0) > Date.now();

/** 引いた結果。まだ引いていない人は undefined、何も設定していない人は、どちらも null */
export const profileOf = (actor: string): Profile | undefined => cache.get(actor)?.profile;

/** 表示名を設定していない人の名前（email の `@` より前）。agent はその名前（OAuth のクライアント） */
export function defaultName(actor: string): string {
  const email = emailOfActor(actor);
  if (email !== undefined) return email.split('@')[0] || email;
  return actor.slice(actor.indexOf(':') + 1);
}

/** 主体の、画面に出す名前。人は表示名（なければ email の `@` より前） */
export const displayName = (actor: string): string => profileOf(actor)?.name || defaultName(actor);

/**
 * 作成者の名前。agent で委任者（agent を認可した人）が分かれば、「Claude（A さんの代理）」の形にする。
 * 管理者が 2 人以上いると、どちらの agent も同じ主体（agent:claude.ai）になるため
 */
export function authorLabel(actor: string, delegate: string | null | undefined): string {
  const name = displayName(actor);
  return isAgentActor(actor) && delegate ? t('author.onBehalf', name, displayName(delegate)) : name;
}

/** 表示名とアイコンが変わったときに呼ぶ。返り値を呼ぶと外す */
export function onProfilesChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** まだ引いていない人（undefined）は、何も設定していない人と同じに描く */
const same = (a: Profile = UNSET, b: Profile) => a.name === b.name && a.icon === b.icon;

/** 結果を覚え、変わった人がいれば知らせる（引き直して同じなら、描き直させない） */
function store(entries: [string, Profile][], until: number): void {
  let changed = false;
  for (const [actor, profile] of entries) {
    changed ||= !same(profileOf(actor), profile);
    cache.set(actor, { profile, until });
  }
  if (changed) for (const listener of listeners) listener();
}

/**
 * `actors` の表示名とアイコンを引く（引いたばかりの人は引かない）。変わったら `onProfilesChange` で知らせる。
 * 返り値は、引き終えると解決する（引けなくても解決する）
 */
export function requestProfiles(actors: Iterable<string>): Promise<void> {
  const waits = new Set<Promise<void>>();
  for (const actor of actors) {
    if (emailOfActor(actor) === undefined || fresh(actor)) continue;
    const pending = inFlight.get(actor);
    if (pending) waits.add(pending);
    else queued.add(actor);
  }
  if (queued.size > 0) {
    // 同じ描画の中で何度呼ばれても、1 回にまとめて引く
    flush ??= Promise.resolve().then(() => lookup());
    waits.add(flush);
  }
  return Promise.all(waits).then(() => undefined);
}

async function lookup(): Promise<void> {
  const batch = [...queued];
  queued = new Set();
  flush = undefined;
  let done!: () => void;
  const finished = new Promise<void>((resolve) => (done = resolve));
  for (const actor of batch) inFlight.set(actor, finished);
  try {
    for (let i = 0; i < batch.length; i += MAX_PROFILE_LOOKUP) {
      const chunk = batch.slice(i, i + MAX_PROFILE_LOOKUP);
      try {
        const { profiles } = await lookupProfiles(chunk);
        store(
          chunk.map((actor) => [actor, profiles[actor] ?? UNSET]),
          Date.now() + PROFILE_TTL_MS,
        );
      } catch {
        // 引けなくても、email の `@` より前を名前にして出せる。しばらくしてから引き直す
        store(
          chunk.map((actor) => [actor, profileOf(actor) ?? UNSET]),
          Date.now() + RETRY_MS,
        );
      }
    }
  } finally {
    for (const actor of batch) if (inFlight.get(actor) === finished) inFlight.delete(actor);
    done();
  }
}

/** 自分の表示名かアイコンを変えたときに呼ぶ（引き直さずに、画面へ反映する） */
export const updateOwnProfile = (actor: string, profile: Profile): void => store([[actor, profile]], Date.now() + PROFILE_TTL_MS);

/**
 * email から決める、頭文字のアイコンの色相（0〜359）。同じ人は、どの画面でも同じ色になる。
 * ほかの人が選んでいる付箋の枠（presence.ts）も、この色にする
 */
export function hueOf(actor: string): number {
  let hash = 0;
  for (const ch of actor.toLowerCase()) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
  return hash % 360;
}

/**
 * 主体のアイコン。画像を設定していれば画像、なければ名前の頭文字を色の付いた円に入れる。
 * 大きさは CSS（`.avatar`）で決める。説明（title）には名前と主体の全体を出す。
 *
 * `decorative` なら、説明を付けず、読み上げからも外す。隣に名前を書いてある場所や、親の要素が説明を
 * 持つ場所（いいねのボタン）で使う（アイコンの説明が、親の説明を隠すため）
 */
export function avatar(actor: string, { decorative = false } = {}): HTMLElement {
  const name = displayName(actor);
  const image = profileOf(actor)?.icon;
  const describe = (face: HTMLElement) => {
    if (decorative) face.ariaHidden = 'true';
    else face.title = `${name} (${actor})`;
    return face;
  };
  if (!image) return describe(initialAvatar(actor, name, decorative));
  const img = describe(el('img', { className: 'avatar', src: image, alt: decorative ? '' : name, draggable: false }));
  // 替えられたか外されたアイコン（前の画像は、すぐに消える。ほかの人の手元には、引き直すまで前の URL が残る）
  img.addEventListener('error', () => img.replaceWith(describe(initialAvatar(actor, name, decorative))), { once: true });
  return img;
}

/**
 * アイコンを、少しずつ重ねて並べる。`max` を超えた分は「+n」で出す。重なりと縁は CSS（`.avatar-stack`）、
 * 大きさは `className` の側で `--avatar-size` を決める
 */
export function avatarStack(
  actors: string[],
  { max, className, decorative = false }: { max: number; className: string; decorative?: boolean },
): HTMLElement {
  const shown = actors.slice(0, max).map((actor) => avatar(actor, { decorative }));
  const rest = actors.length - shown.length;
  return el(
    'span',
    { className: `avatar-stack ${className}` },
    ...shown,
    ...(rest > 0 ? [el('span', { className: 'avatar-stack-more', textContent: `+${rest}` })] : []),
  );
}

function initialAvatar(actor: string, name: string, decorative: boolean): HTMLElement {
  const initial = el('span', { className: 'avatar avatar-initial', textContent: [...name][0]?.toUpperCase() ?? '?' });
  if (!decorative) {
    initial.role = 'img';
    initial.ariaLabel = name;
  }
  initial.style.setProperty('--avatar-hue', String(hueOf(actor)));
  return initial;
}
