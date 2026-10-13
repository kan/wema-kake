import { describe, expect, it } from 'vitest';
import type { HistoryDelta } from '../src/shared/delta';
import { applyOpToInfos, isAgentActor, type NoteInfo } from '../src/shared/note-info';
import { createNote, edge, note } from './helpers';

/** テスト用のデルタ（補助関数の戻り値は、型が緩い） */
const deltas = (...items: unknown[]) => items as HistoryDelta[];

describe('applyOpToInfos', () => {
  it('作成で作成者と時刻が入り、更新で時刻だけが変わり、削除で消える', () => {
    const infos = new Map<string, NoteInfo>();

    const created = applyOpToInfos(infos, 'agent:claude.ai', 100, deltas(createNote('n1'), createNote('n2')));
    expect(created).toEqual(new Set(['n1', 'n2']));
    expect(infos.get('n1')).toEqual({ createdBy: 'agent:claude.ai', updatedAt: 100 });

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
    expect(infos.get('n1')).toEqual({ createdBy: 'agent:claude.ai', updatedAt: 200 });
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
    expect(infos.get('n1')).toEqual({ createdBy: null, updatedAt: 100 });
  });
});

describe('isAgentActor', () => {
  it('agent: で始まる主体だけを agent とする', () => {
    expect(isAgentActor('agent:claude.ai')).toBe(true);
    expect(isAgentActor('user:agent@example.com')).toBe(false);
    expect(isAgentActor(null)).toBe(false);
  });
});
