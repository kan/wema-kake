import { SELF } from 'cloudflare:test';
import { expect } from 'vitest';
import type { ServerMsg } from '../src/shared/protocol';

/** Worker へのリクエスト。localhost 宛てなので、開発用の主体（dev@example.com）で認証される */
export const api = (path: string, init?: RequestInit) => SELF.fetch(`http://localhost${path}`, init);

export interface Client {
  send(msg: unknown): void;
  /**
   * 次に届くメッセージ。届かなければ失敗する。meta（表示名と epoch の通知。ページができたときにも
   * 届く）は読み飛ばす
   */
  next(): Promise<ServerMsg>;
  /** 次に届く meta。それより前のメッセージは読み飛ばす */
  nextMeta(): Promise<ServerMsg>;
  /** しばらく待って、meta 以外が何も届いていないことを確かめる */
  expectSilent(): Promise<void>;
  close(): void;
  closed: Promise<{ code: number; reason: string }>;
}

/** WebSocket で接続する（hello はまだ送らない） */
export async function open(slug: string, headers: Record<string, string> = {}): Promise<Client> {
  const res = await api(`/ws/${slug}`, { headers: { Upgrade: 'websocket', ...headers } });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();

  const queue: ServerMsg[] = [];
  let wake: (() => void) | undefined;
  ws.addEventListener('message', (e) => {
    queue.push(JSON.parse(e.data as string));
    wake?.();
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.addEventListener('close', (e) => resolve({ code: e.code, reason: e.reason }));
  });
  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  /** `want` に合う次のメッセージ。合わないものは読み飛ばす */
  const take = async (want: (msg: ServerMsg) => boolean): Promise<ServerMsg> => {
    for (;;) {
      if (queue.length === 0) await wait(2000);
      const msg = queue.shift();
      if (!msg) throw new Error('no message');
      if (want(msg)) return msg;
    }
  };

  return {
    closed,
    send: (msg) => ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)),
    close: () => ws.close(),
    next: () => take((msg) => msg.type !== 'meta'),
    nextMeta: () => take((msg) => msg.type === 'meta'),
    async expectSilent() {
      if (queue.length === 0) await wait(100);
      expect(queue.filter((msg) => msg.type !== 'meta')).toEqual([]);
    },
  };
}

/** 接続して hello を送り、スナップショットを受け取る */
export async function join(slug: string, clientId: string): Promise<Client> {
  const c = await open(slug);
  c.send({ type: 'hello', clientId });
  const snapshot = await c.next();
  expect(snapshot.type).toBe('snapshot');
  return c;
}

/** テスト用の付箋。`over` で一部のフィールドを差し替える */
export const note = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  x: 10,
  y: 20,
  width: 200,
  height: 150,
  text: 'hello',
  color: '#FFF9C4',
  zIndex: 1,
  ...over,
});

export const edge = (id: string, from: string, to: string, over: Record<string, unknown> = {}) => ({
  id,
  from,
  to,
  fromAnchor: 'auto',
  toAnchor: 'auto',
  style: 'arrow',
  ...over,
});

export const createNote = (id: string, over?: Record<string, unknown>) => ({
  type: 'note:create',
  note: note(id, over),
});
