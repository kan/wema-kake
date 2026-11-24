// 同じページを開いている人と、その選択と編集（issue #124）。サーバーの中継と、BoardSync の受け取り
import { describe, expect, it } from 'vitest';
import { join, open } from './helpers';

let count = 0;
const unique = () => `presence-${++count}`;
const ME = 'user:dev@example.com';

describe('presence', () => {
  it('つながると、ほかの全員の分を受け取り、ほかの全員へ知らされる', async () => {
    const slug = unique();
    const a = await join(slug, 'pa');
    a.send({ type: 'presence', selection: ['n1'] });
    const b = await join(slug, 'pb');
    // b には a の今の選択が届き、a には b がつながったことが届く
    expect(await b.nextPresence()).toEqual({ type: 'presence', clientId: 'pa', actor: ME, selection: ['n1'] });
    expect(await a.nextPresence()).toEqual({ type: 'presence', clientId: 'pb', actor: ME, selection: [] });
    a.close();
    b.close();
  });

  it('選択と編集を、主体を付けて送り主以外へ中継する。名乗った主体と、知らないキーは使わない', async () => {
    const slug = unique();
    const a = await join(slug, 'pa');
    const b = await join(slug, 'pb');
    // つながったときの、互いの分
    await a.nextPresence();
    await b.nextPresence();
    a.send({ type: 'presence', selection: ['n1', 'n2', 'n1'], editing: 'n2', actor: 'user:evil@example.com', x: 1 });
    expect(await b.nextPresence()).toEqual({ type: 'presence', clientId: 'pa', actor: ME, selection: ['n1', 'n2'], editing: 'n2' });

    // 不正な内容は捨てる（届くのは、次の正しいものだけ）
    for (const bad of [{ selection: 'n1' }, { selection: [1] }, { selection: Array(101).fill('n1') }, { selection: [], editing: 3 }]) {
      a.send({ type: 'presence', ...bad });
    }
    a.send({ type: 'presence', selection: [] });
    expect(await b.nextPresence()).toEqual({ type: 'presence', clientId: 'pa', actor: ME, selection: [] });
    a.close();
    b.close();
  });

  it('多くの付箋を選んでも中継し、後からつながった人にも届く（Attachment の大きさの上限を超える）', async () => {
    const slug = unique();
    const a = await join(slug, 'pa');
    const selection = Array.from({ length: 100 }, (_, i) => `${'n'.repeat(60)}${String(i).padStart(3, '0')}`);
    a.send({ type: 'presence', selection });
    const b = await join(slug, 'pb');
    expect(await b.nextPresence()).toMatchObject({ clientId: 'pa', selection });
    a.close();
    b.close();
  });

  it('hello より先に届いた presence も、hello の後に知らせる', async () => {
    const slug = unique();
    const b = await join(slug, 'pb');
    const a = await open(slug);
    a.send({ type: 'presence', selection: ['n1'] });
    a.send({ type: 'hello', clientId: 'pa' });
    expect(await b.nextPresence()).toEqual({ type: 'presence', clientId: 'pa', actor: ME, selection: ['n1'] });
    a.close();
    b.close();
  });

  it('切れたら、ほかの全員へ leave を知らせる。同じクライアントがつなぎ直した接続が残っていれば知らせない', async () => {
    const slug = unique();
    const a = await join(slug, 'pa');
    const b = await join(slug, 'pb');
    await a.nextPresence();
    await b.nextPresence();

    // 同じ clientId でつなぎ直した（前の接続は、後から閉じる）
    const again = await join(slug, 'pa');
    expect(await b.nextPresence()).toMatchObject({ type: 'presence', clientId: 'pa' });
    a.close();
    await a.closed;
    again.send({ type: 'presence', selection: ['n9'] });
    expect(await b.nextPresence()).toMatchObject({ type: 'presence', clientId: 'pa', selection: ['n9'] });

    again.close();
    expect(await b.nextPresence()).toEqual({ type: 'leave', clientId: 'pa' });
    b.close();
  });
});
