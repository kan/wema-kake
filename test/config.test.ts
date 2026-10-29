import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { FIRST_PAGE_SLUG, firstPageTitle } from '../src/shared/guide';
import { DEFAULT_SITE, parseSiteConfig, SITE_META_NAME } from '../src/shared/site';
import { agentActor } from '../src/worker/access';
import { canWrite, resolveConfig, type WemaKakeConfig } from '../src/worker/config';
import { createApp } from '../src/worker/index';

/** HTML から、`<title>` の中身と、サイトの設定の `<meta>` を取り出す */
async function readSite(res: Response) {
  let title = '';
  let content: string | null = null;
  await new HTMLRewriter()
    .on('title', {
      text(chunk) {
        title += chunk.text;
      },
    })
    .on(`meta[name="${SITE_META_NAME}"]`, {
      element(el) {
        content = el.getAttribute('content');
      },
    })
    .transform(res)
    .text();
  // 本文と属性の値は、文字参照のままで返る
  const decode = (value: string) =>
    value.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const meta = content as string | null;
  return { title: decode(title), content: meta === null ? null : parseSiteConfig(decode(meta)) };
}

const html = { Accept: 'text/html' };

describe('resolveConfig', () => {
  it('省いた項目を既定の値で埋める', () => {
    expect(resolveConfig()).toEqual({ siteName: 'wema-kake', defaultLang: 'en', mcp: { write: true }, firstPage: true });
    expect(resolveConfig({ siteName: 'Notes', defaultLang: 'ja', mcp: false, firstPage: false })).toEqual({
      siteName: 'Notes',
      defaultLang: 'ja',
      mcp: false,
      firstPage: false,
    });
  });

  it('不正な値は、起動時に例外にする', () => {
    expect(() => resolveConfig({ siteName: '  ' })).toThrow(/siteName/);
    expect(() => resolveConfig({ defaultLang: 'fr' as never })).toThrow(/defaultLang/);
    expect(() => resolveConfig({ mcp: 'false' as never })).toThrow(/mcp/);
    expect(() => resolveConfig({ firstPage: 0 as never })).toThrow(/firstPage/);
  });

  it('mcp の書き込みの設定を確かめる', () => {
    expect(resolveConfig({ mcp: { write: false } }).mcp).toEqual({ write: false });
    expect(resolveConfig({ mcp: { write: ['claude.ai', 'localhost'] } }).mcp).toEqual({ write: ['claude.ai', 'localhost'] });
    expect(() => resolveConfig({ mcp: null as never })).toThrow(/mcp/);
    expect(() => resolveConfig({ mcp: {} as never })).toThrow(/mcp\.write/);
    expect(() => resolveConfig({ mcp: { write: 'claude.ai' as never } })).toThrow(/mcp\.write/);
    // 主体の名前でない書き方は、黙って読み取りだけにならないよう、起動時に断る
    for (const name of ['agent:claude.ai', 'https://claude.ai', 'Claude.ai', '', ' claude.ai', 'a'.repeat(65), 1]) {
      expect(() => resolveConfig({ mcp: { write: [name as string] } }), String(name)).toThrow(/mcp\.write/);
    }
  });

  it('agentActor が作る主体の名前は、そのまま mcp.write に並べられる', () => {
    // 64 文字で切った後の末尾に . が来るホスト名も、切った後の名前で並べられる
    const hosts = ['claude.ai', 'chatgpt.com', 'localhost', `${'a'.repeat(63)}.example.com`, 'x'.repeat(80)];
    for (const host of hosts) {
      const actor = agentActor(`https://${host}/callback`);
      const name = actor.slice('agent:'.length);
      expect(name.length, host).toBeLessThanOrEqual(64);
      const mcp = resolveConfig({ mcp: { write: [name] } }).mcp;
      expect(mcp && canWrite(mcp, actor), host).toBe(true);
    }
  });

  it('canWrite は、主体の名前が完全に一致するときだけ書き込みを許す', () => {
    expect(canWrite({ write: true }, 'agent:claude.ai')).toBe(true);
    expect(canWrite({ write: false }, 'agent:claude.ai')).toBe(false);
    const mcp = { write: ['claude.ai'] };
    expect(canWrite(mcp, 'agent:claude.ai')).toBe(true);
    expect(canWrite(mcp, 'agent:chatgpt.com')).toBe(false);
    expect(canWrite(mcp, 'agent:evil.claude.ai')).toBe(false);
    expect(canWrite(mcp, 'user:claude.ai')).toBe(false);
  });
});

describe('parseSiteConfig', () => {
  it('読めない値や欠けた項目は、既定の値にする', () => {
    expect(parseSiteConfig(null)).toEqual(DEFAULT_SITE);
    expect(parseSiteConfig('not json')).toEqual(DEFAULT_SITE);
    expect(parseSiteConfig('{"siteName":"","defaultLang":"fr"}')).toEqual(DEFAULT_SITE);
    expect(parseSiteConfig('{"siteName":"Notes"}')).toEqual({ siteName: 'Notes', defaultLang: 'en' });
  });
});

describe('画面のアセット', () => {
  it('アセットに一致しないパスは index.html を返し、サイトの設定を埋め込む', async () => {
    const res = await SELF.fetch('http://localhost/p/memo', { headers: html });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/^text\/html/);
    expect(res.headers.get('ETag')).toBeNull();
    expect(await readSite(res)).toEqual({ title: 'wema-kake', content: DEFAULT_SITE });
  });

  it('設定のサイトの名前と既定の言語を埋め込む。HTML の特殊文字はそのまま渡る', async () => {
    const app = createApp({ siteName: 'A "wiki" <&>', defaultLang: 'ja' });
    const res = await app.request('http://localhost/', { headers: html }, env);
    expect(await readSite(res)).toEqual({
      title: 'A "wiki" <&>',
      content: { siteName: 'A "wiki" <&>', defaultLang: 'ja' },
    });
  });

  it('HTML の読み込みは、条件付きの取得でも 304 にしない（設定だけを変えたデプロイに追従する）', async () => {
    const etag = (await env.ASSETS.fetch('http://localhost/index.html')).headers.get('ETag');
    expect(etag).not.toBeNull();
    const res = await SELF.fetch('http://localhost/', { headers: { ...html, 'If-None-Match': etag! } });
    expect(res.status).toBe(200);
  });

  it('HTML でないアセットは、そのまま返す', async () => {
    const res = await SELF.fetch('http://localhost/favicon.svg');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/svg/);
    expect(res.headers.get('ETag')).not.toBeNull();
  });

  it('API のパスで、どのルートにも合わないものは、画面ではなく JSON の 404 を返す', async () => {
    for (const path of ['/api/nope', '/ws/', '/img/', '/img/not-a-key', '/mcp/x']) {
      const res = await SELF.fetch(`http://localhost${path}`, { headers: html });
      expect(res.status, path).toBe(404);
      expect(await res.json(), path).toEqual({ error: 'not found' });
    }
  });

  it('アセットも認証を通す', async () => {
    const bare = { ...env, DEV_USER_EMAIL: undefined };
    const res = await createApp().request('http://localhost/', { headers: html }, bare);
    expect(res.status).toBe(500);
  });
});

describe('設定', () => {
  it('mcp: false なら /mcp は 404（画面も返さない）', async () => {
    const app = createApp({ mcp: false });
    const post = await app.request(
      'http://localhost/mcp',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      env,
    );
    expect(post.status).toBe(404);
    const get = await app.request('http://localhost/mcp', { headers: html }, env);
    expect(get.status).toBe(404);
    expect(await get.json()).toEqual({ error: 'not found' });
    // Access が有効でも、人向けの認証（401 / 403）より前に 404 を返す
    const accessEnv = { ...env, ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com', ACCESS_AUD: 'aud' };
    expect((await app.request('https://wiki.example.com/mcp', { method: 'POST' }, accessEnv)).status).toBe(404);
  });

  it('firstPage: false なら最初のページを作らない。defaultLang は、最初のページの言語の決め方に使う', async () => {
    const index = async (config: WemaKakeConfig) =>
      (await (
        await createApp(config).request('http://localhost/api/index', { headers: { 'Accept-Language': 'fr' } }, env)
      ).json()) as { pages: { name: string; title: string }[] };

    expect((await index({ firstPage: false })).pages).toEqual([]);
    const { results } = await env.DB.prepare(`SELECT key FROM settings`).all();
    expect(results).toEqual([]);

    // ブラウザの言語（fr）に対応する言語がないので、既定の言語で作る
    expect((await index({ defaultLang: 'ja' })).pages).toMatchObject([
      { name: FIRST_PAGE_SLUG, title: firstPageTitle('ja') },
    ]);
  });
});
