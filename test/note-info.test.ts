import { describe, expect, it } from 'vitest';
import type { HistoryDelta } from '../src/shared/delta';
import { applyOpToInfos, changesWriter, isAgentActor, type NoteInfo } from '../src/shared/note-info';
import { createNote, edge, note } from './helpers';

/** テスト用のデルタ（補助関数の戻り値は、型が緩い） */
const deltas = (...items: unknown[]) => items as HistoryDelta[];

describe('applyOpToInfos', () => {
  it('作成で作成者と時刻が入り、更新で時刻だけが変わり、削除で消える', () => {
    const infos = new Map<string, NoteInfo>();

    const created = applyOpToInfos(infos, 'agent:claude.ai', 100, deltas(createNote('n1'), createNote('n2')));
    expect(created).toEqual(new Set(['n1', 'n2']));
    expect(infos.get('n1')).toEqual({ createdBy: 'agent:claude.ai', delegate: null, updatedAt: 100 });

    const changed = applyOpToInfos(
      infos,
      'user:a@example.com',
      200,
      deltas(
        { type: 'note:update', noteId: 'n1', before: { x: 0 }, after: { x: 10 } },
        { type: 'note:delete', note: note('n2') },
      ),
    );
    expect(changed).toEqual(new Set(['n1', 'n2']));
    // 動かしたのが別の人でも、作成者は変わらない
    expect(infos.get('n1')).toEqual({ createdBy: 'agent:claude.ai', delegate: null, updatedAt: 200 });
    expect(infos.has('n2')).toBe(false);
  });

  it('接続線のデルタと、手元にない付箋の削除は、何も変えない', () => {
    const infos = new Map<string, NoteInfo>();
    const changed = applyOpToInfos(
      infos,
      'user:a@example.com',
      100,
      deltas({ type: 'edge:delete', edge: edge('e1', 'n1', 'n2') }, { type: 'note:delete', note: note('gone') }),
    );
    expect(changed.size).toBe(0);
    expect(infos.size).toBe(0);
  });

  it('手元にない付箋の更新は、作成者が分からないまま時刻を持つ', () => {
    const infos = new Map<string, NoteInfo>();
    applyOpToInfos(
      infos,
      'user:a@example.com',
      100,
      deltas({ type: 'note:update', noteId: 'n1', before: { x: 0 }, after: { x: 10 } }),
    );
    expect(infos.get('n1')).toEqual({ createdBy: null, delegate: null, updatedAt: 100 });
  });

  it('作成で委任者が入り、更新では変わらない', () => {
    const infos = new Map<string, NoteInfo>();
    applyOpToInfos(infos, 'agent:claude.ai', 100, deltas(createNote('n1')), 'user:a@example.com');
    expect(infos.get('n1')).toEqual({ createdBy: 'agent:claude.ai', delegate: 'user:a@example.com', updatedAt: 100 });
    applyOpToInfos(
      infos,
      'agent:claude.ai',
      200,
      deltas({ type: 'note:update', noteId: 'n1', before: { x: 0 }, after: { x: 10 } }),
      'user:b@example.com',
    );
    expect(infos.get('n1')).toEqual({ createdBy: 'agent:claude.ai', delegate: 'user:a@example.com', updatedAt: 200 });
  });
});

describe('changesWriter', () => {
  it('位置だけの変更と、内容で決まる大きさの変更では、書き込み者を変えない', () => {
    const user = 'user:a@example.com';
    expect(changesWriter(user, ['x', 'y'], {})).toBe(false);
    expect(changesWriter(user, ['x', 'width', 'height'], { autoSize: true })).toBe(false);
    expect(changesWriter(user, ['height'], { foldable: true })).toBe(false);
    // 手で変えた大きさ、本文、色、meta、autoSize の切り替えでは変える
    expect(changesWriter(user, ['width', 'height'], {})).toBe(true);
    expect(changesWriter(user, ['width'], { foldable: true })).toBe(true);
    for (const key of ['text', 'color', 'meta', 'autoSize', 'foldable']) {
      expect(changesWriter(user, ['x', key], { autoSize: true }), key).toBe(true);
    }
    // サーバーが自分で行う操作では変えない
    expect(changesWriter('system', ['color'], {})).toBe(false);
  });

  it('applyOpToInfos は、移動以外の変更で書き込み者を変える', () => {
    const infos = new Map<string, NoteInfo>();
    applyOpToInfos(infos, 'user:a@example.com', 100, deltas(createNote('n1')));
    applyOpToInfos(
      infos, 'agent:claude.ai', 200,
      deltas({ type: 'note:update', noteId: 'n1', before: { color: '#fff' }, after: { color: '#000' } }),
      'user:b@example.com',
    );
    expect(infos.get('n1')).toEqual({ createdBy: 'agent:claude.ai', delegate: 'user:b@example.com', updatedAt: 200 });

    // 手元のボードで autoSize の付箋なら、大きさの変更では変えない。autoSize を外す変更では変える
    const autoSize = () => ({ autoSize: true });
    const resize = { type: 'note:update', noteId: 'n1', before: { x: 0, height: 10 }, after: { x: 5, height: 30 } };
    applyOpToInfos(infos, 'user:c@example.com', 300, deltas(resize), null, autoSize);
    expect(infos.get('n1')?.createdBy).toBe('agent:claude.ai');
    applyOpToInfos(infos, 'user:c@example.com', 400, deltas(resize), null, () => ({}));
    expect(infos.get('n1')).toEqual({ createdBy: 'user:c@example.com', delegate: null, updatedAt: 400 });
    applyOpToInfos(
      infos, 'user:d@example.com', 500,
      deltas({ type: 'note:update', noteId: 'n1', before: { autoSize: true, width: 1 }, after: { autoSize: false, width: 2 } }),
      null,
      autoSize,
    );
    expect(infos.get('n1')?.createdBy).toBe('user:d@example.com');
  });
});

describe('isAgentActor', () => {
  it('agent: で始まる主体だけを agent とする', () => {
    expect(isAgentActor('agent:claude.ai')).toBe(true);
    expect(isAgentActor('user:agent@example.com')).toBe(false);
    expect(isAgentActor(null)).toBe(false);
  });
});
