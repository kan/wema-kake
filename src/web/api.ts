// サーバーの HTTP API の呼び出し。形は AGENTS.md の「HTTP API」を参照。
import type { Reaction, ReactionKind } from '../shared/note-info';
import {
  ERROR_NOT_APPROVED,
  type IndexLink,
  type IndexPage,
  type OpSummary,
  type PageSummary,
  type Profile,
  type RestoreOutcome,
  type RevertOutcome,
  type RootHit,
  type Session,
  type UserEntry,
} from '../shared/api';

/** ページへのリンクを出すのに要るもの。表示名が未設定なら null（スラッグを出す） */
export interface PageLink {
  name: string;
  title: string | null;
}

/** API がエラーを返した。`status` は HTTP のステータス */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** `body` は JSON にして送る。`Blob` なら、そのまま、その形式で送る（アイコンの画像） */
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const raw = body instanceof Blob;
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': raw ? body.type : 'application/json' },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok || json === null) {
    // 承認（設定の `approval`）を取り消された。読み込み直すと、承認待ちの表示になる
    if (res.status === 403 && json?.error === ERROR_NOT_APPROVED) location.reload();
    throw new ApiError(json?.error ?? `${method} ${path}: ${res.status}`, res.status);
  }
  return json;
}

/** 一覧のボード用。ページ（本文の冒頭つき）と、ページ間のリンク */
export const getIndex = () => request<{ pages: IndexPage[]; links: IndexLink[] }>('GET', '/api/index');

/**
 * 表示名、本文、スラッグが検索語に一致するページと、そのルート。
 * 一覧にはルートのページしか出ないので、子孫のページが一致したときは、ルートで知らせる
 */
export async function searchRoots(q: string): Promise<RootHit[]> {
  const { pages } = await request<{ pages: RootHit[] }>('GET', `/api/search?roots=1&q=${encodeURIComponent(q)}`);
  return pages;
}

/** ページの概要（子ページの付箋の表示に使う）。索引にないページは、結果に入らない */
export async function getPagesInfo(names: string[]): Promise<PageSummary[]> {
  if (names.length === 0) return [];
  return (await request<{ pages: PageSummary[] }>('POST', '/api/pages-info', { names })).pages;
}

/** 先祖のページ。ルートから順 */
export const getAncestors = (slug: string) =>
  request<{ ancestors: { name: string; title: string | null }[] }>('GET', `/api/pages/${slug}/ancestors`);

/** ページを新しく作る。すでにあれば ApiError（status 409） */
export const createPage = (slug: string, title: string) =>
  request<{ ok: true }>('POST', `/api/pages/${slug}`, { title });

/** 自分のブックマーク（付けた順）。索引への反映の前のページは、表示名と更新の時刻が null */
export async function getBookmarks(): Promise<(PageLink & { updated_at: number | null })[]> {
  return (await request<{ pages: (PageLink & { updated_at: number | null })[] }>('GET', '/api/bookmarks')).pages;
}

/** ブックマークを付ける（`on` が false なら外す） */
export const setBookmark = (slug: string, on: boolean) =>
  request<{ ok: true }>(on ? 'PUT' : 'DELETE', `/api/bookmarks/${slug}`);

/**
 * 最近変更されたページ（新しい順）。子ページも含む。`name` を渡すと、表示名かスラッグにその文字を
 * 含むページに絞る
 */
export async function getRecentPages(limit: number, name = ''): Promise<(PageLink & { updated_at: number })[]> {
  const query = new URLSearchParams({ limit: String(limit), ...(name === '' ? {} : { name }) });
  return (await request<{ pages: (PageLink & { updated_at: number })[] }>('GET', `/api/pages?${query}`)).pages;
}

export const getBacklinks = (slug: string) =>
  request<{ pages: { name: string; title: string | null }[] }>('GET', `/api/pages/${slug}/backlinks`);

/** `mustExist` なら、ページがないときに作らず、404 で失敗する */
export const setTitle = (slug: string, title: string, mustExist = false) =>
  request<{ title: string | null }>('PUT', `/api/pages/${slug}/title`, { title, mustExist });

/** ページの色を変える。null で、付けていない状態に戻す */
export const setColor = (slug: string, color: string | null) =>
  request<{ color: string | null }>('PUT', `/api/pages/${slug}/color`, { color });

/** ページのロック（編集の禁止）の設定と解除。管理者だけが呼べる */
export const setLocked = (slug: string, locked: boolean) =>
  request<{ locked: boolean }>('PUT', `/api/pages/${slug}/lock`, { locked });

/** 付箋のリアクションを付ける（`on` が false なら外す）。付箋の今のリアクションを返す */
export const react = (slug: string, noteId: string, kind: ReactionKind, on: boolean) =>
  request<{ reactions: Reaction[] }>(
    on ? 'PUT' : 'DELETE',
    `/api/pages/${slug}/notes/${encodeURIComponent(noteId)}/reactions/${kind}`,
  );

/** ログインしている人と、管理者かどうか */
export const getSession = () => request<Session>('GET', '/api/session');

/** 利用者の一覧（管理者だけ。承認が有効なときだけ） */
export const listUsers = async () => (await request<{ users: UserEntry[] }>('GET', '/api/users')).users;

/** 利用者を承認するか拒否する（管理者だけ） */
export const decideUser = (email: string, status: 'approved' | 'rejected') =>
  request<{ ok: true }>('PUT', `/api/users/${encodeURIComponent(email)}/status`, { status });

export const setExpiry = (slug: string, days: number | null) =>
  request<{ expireDays: number | null }>('PUT', `/api/pages/${slug}/expiry`, { days });

/** ゴミ箱の付箋を、元のページへ戻す。戻せなかったページがあれば、`error` の付いた結果で 409 になる */
export async function restoreFromTrash(clientId: string, noteIds: string[]): Promise<RestoreOutcome[]> {
  const res = await fetch('/api/trash/restore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, opId: crypto.randomUUID(), noteIds }),
  });
  const json = (await res.json().catch(() => null)) as { pages?: RestoreOutcome[]; error?: string } | null;
  if (json?.pages) return json.pages;
  throw new ApiError(json?.error ?? `restore: ${res.status}`, res.status);
}

export const deletePage = (slug: string) => request<{ ok: true }>('DELETE', `/api/pages/${slug}`);

export const getOps = (slug: string, agentOnly: boolean) =>
  request<{ ops: OpSummary[] }>('GET', `/api/pages/${slug}/ops${agentOnly ? '?agent=1' : ''}`);

export const revertOp = (slug: string, seq: number, clientId: string) =>
  request<RevertOutcome>('POST', `/api/pages/${slug}/ops/${seq}/revert`, {
    clientId,
    opId: crypto.randomUUID(),
  });

/**
 * ページ `slug` の付箋を、ページ `to` へ移す（写す）。付箋の中身はサーバーが読む（送り先の、今ある
 * 付箋の下に置かれる）。同じ `opId` で送り直しても、二重には置かれない。返る `page` は、置いた後の
 * 送り先の概要
 */
export const transferNotes = (
  slug: string,
  body: {
    clientId: string;
    opId: string;
    to: string;
    noteIds: string[];
    /** 付箋の id から、サーバーにある位置の代わりに使う位置 */
    positions: Record<string, { x: number; y: number }>;
    copy: boolean;
  },
) => request<{ ok: true; page: PageSummary | null }>('POST', `/api/pages/${slug}/transfer`, body);

/** 自分の表示名とアイコン（issue #121） */
export const getProfile = () => request<Profile>('GET', '/api/profile');

/** 自分の表示名を変える。空文字で未設定に戻す */
export const setDisplayName = (name: string) => request<{ ok: true; name: string | null }>('PUT', '/api/profile', { name });

/** 自分のアイコンを変える（WebP、`MAX_ICON_BYTES` まで）。新しいアイコンの URL を返す */
export const uploadIcon = async (image: Blob): Promise<string> =>
  (await request<{ ok: true; icon: string }>('PUT', '/api/profile/icon', image)).icon;

export const removeIcon = () => request<{ ok: true; icon: null }>('DELETE', '/api/profile/icon');

/** 主体の一覧から、表示名とアイコンを引く。何も設定していない人は入らない */
export const lookupProfiles = (actors: string[]) =>
  request<{ profiles: Record<string, Profile> }>('POST', '/api/profiles', { actors });

/** 画像を R2 に上げ、付箋に入れる URL を返す */
export async function uploadImage(file: File): Promise<string> {
  const res = await fetch('/api/images', {
    method: 'POST',
    headers: { 'Content-Type': file.type },
    body: file,
  });
  if (!res.ok) throw new Error(`image upload failed: ${res.status}`);
  return ((await res.json()) as { url: string }).url;
}

/**
 * 認証がまだ有効かを確かめる。期限が切れていると、API は 401 を返すか、Access が
 * ログイン画面へリダイレクトする。通信できないだけの場合は、有効として扱う（再接続を続ける）。
 * 承認（設定の `approval`）を取り消されていても false にする（読み込み直すと、承認待ちの表示になる）
 */
export async function isAuthenticated(): Promise<boolean> {
  try {
    const res = await fetch('/api/session', { redirect: 'manual' });
    if (res.status === 401 || res.type === 'opaqueredirect') return false;
    const session = res.ok ? ((await res.json().catch(() => null)) as Session | null) : null;
    return session?.approval === undefined || session.approval === 'approved';
  } catch {
    return true;
  }
}
