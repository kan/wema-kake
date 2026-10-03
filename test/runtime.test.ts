// 公式ドキュメントに記述がなく、設計が依存しているランタイムの挙動を固定するテスト。
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { PageDO } from '../src/worker/page-do';

describe('HTMLRewriter', () => {
  it('DO 内で動き、テキスト中のエンティティは復号も再エスケープもされない', async () => {
    const stub = env.PAGE.getByName('runtime-rewriter');
    const out = await runInDurableObject(stub, async () => {
      const html =
        'a &lt;b&gt; &amp; "q" <b onclick="x()">x</b><font>f</font><script>y</script><!--c-->';
      const texts: string[] = [];
      const rewritten = await new HTMLRewriter()
        .on('*', {
          element(el) {
            if (el.tagName === 'script') el.remove();
            else if (el.tagName === 'font') el.removeAndKeepContent();
            for (const [name] of [...el.attributes]) {
              if (name.startsWith('on')) el.removeAttribute(name);
            }
          },
        })
        .onDocument({
          // 要素の外にあるコメントは on('*') の comments では届かない
          comments(c) {
            c.remove();
          },
          text(t) {
            texts.push(t.text);
          },
        })
        .transform(new Response(html))
        .text();
      return { rewritten, firstText: texts[0] };
    });
    expect(out.rewritten).toBe('a &lt;b&gt; &amp; "q" <b>x</b>f');
    expect(out.firstText).toBe('a &lt;b&gt; &amp; "q" ');
  });
});

describe('DO の SQLite', () => {
  it('外部キー制約が既定で有効で、付箋を消すと接続線も消える', async () => {
    const stub = env.PAGE.getByName('runtime-fk');
    const edgeCount = await runInDurableObject(stub, async (instance: PageDO, state) => {
      // スキーマは最初の書き込みで作られる
      await instance.applyOps({
        actor: 'user:test',
        clientId: 'c1',
        opId: 'init',
        deltas: [{ type: 'note:create', note: { id: 'n0', x: 0, y: 0, width: 1, height: 1, text: '', color: '#fff' } }],
      });
      const sql = state.storage.sql;
      for (const id of ['n1', 'n2']) {
        sql.exec(
          `INSERT INTO notes (id, x, y, width, height, text, color, z_index, updated_at)
           VALUES (?, 0, 0, 200, 150, '', '#FFF9C4', 1, 0)`,
          id,
        );
      }
      sql.exec(
        `INSERT INTO edges (id, from_id, to_id, props, updated_at) VALUES ('e1', 'n1', 'n2', '{}', 0)`,
      );
      sql.exec(`DELETE FROM notes WHERE id = 'n1'`);
      return sql.exec(`SELECT count(*) AS c FROM edges`).one().c;
    });
    expect(edgeCount).toBe(0);
  });
});

describe('D1 の FTS5', () => {
  it('trigram トークナイザで日本語を部分一致検索できる。3 文字未満は LIKE が要る', async () => {
    await env.DB.prepare(`INSERT INTO pages_fts (name, title, plain_text) VALUES (?, ?, ?)`)
      .bind('p1', '絵馬掛', '付箋ボードで作る Wiki のメモ')
      .run();
    const names = async (sql: string, arg: string) =>
      (await env.DB.prepare(sql).bind(arg).all<{ name: string }>()).results.map((r) => r.name);

    const match = `SELECT name FROM pages_fts WHERE pages_fts MATCH ?`;
    expect(await names(match, '"付箋ボード"')).toEqual(['p1']);
    expect(await names(match, '"付箋"')).toEqual([]);
    expect(await names(`SELECT name FROM pages_fts WHERE plain_text LIKE ?`, '%付箋%')).toEqual([
      'p1',
    ]);
  });
});
