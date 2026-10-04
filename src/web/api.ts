// サーバーの HTTP API の呼び出し。形は AGENTS.md の「HTTP API」を参照。
import type { IndexLink, IndexPage, OpSummary, PageSummary, RevertOutcome, RootHit } from '../shared/api';

/** API がエラーを返した。`status` は HTTP のステータス */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok || json === null) {
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

export const getBacklinks = (slug: string) =>
  request<{ pages: { name: string; title: string | null }[] }>('GET', `/api/pages/${slug}/backlinks`);

/** `mustExist` なら、ページがないときに作らず、404 で失敗する */
export const setTitle = (slug: string, title: string, mustExist = false) =>
  request<{ title: string | null }>('PUT', `/api/pages/${slug}/title`, { title, mustExist });

export const deletePage = (slug: string) => request<{ ok: true }>('DELETE', `/api/pages/${slug}`);

export const getOps = (slug: string, agentOnly: boolean) =>
  request<{ ops: OpSummary[] }>('GET', `/api/pages/${slug}/ops${agentOnly ? '?agent=1' : ''}`);

export const revertOp = (slug: string, seq: number, clientId: string) =>
  request<RevertOutcome>('POST', `/api/pages/${slug}/ops/${seq}/revert`, {
    clientId,
    opId: crypto.randomUUID(),
  });

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
 * ログイン画面へリダイレクトする。通信できないだけの場合は、有効として扱う（再接続を続ける）
 */
export async function isAuthenticated(): Promise<boolean> {
  try {
    const res = await fetch('/api/session', { redirect: 'manual' });
    return res.status !== 401 && res.type !== 'opaqueredirect';
  } catch {
    return true;
  }
}
