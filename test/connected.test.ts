import { describe, expect, it } from 'vitest';
import { connectedNotes } from '../src/shared/connected';

const edge = (from: string, to: string) => ({ from, to });

describe('connectedNotes', () => {
  it('接続線を、向きに関係なく、先までたどる', () => {
    const edges = [edge('a', 'b'), edge('c', 'b'), edge('c', 'd'), edge('x', 'y')];
    expect(connectedNotes(['a'], edges).sort()).toEqual(['b', 'c', 'd']);
  });

  it('始めの付箋は、結果に入れない', () => {
    const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')];
    expect(connectedNotes(['a', 'b'], edges)).toEqual(['c']);
  });

  it('接続線がなければ、空になる', () => {
    expect(connectedNotes(['a'], [edge('b', 'c')])).toEqual([]);
  });

  it('通れない付箋は、結果に入れず、その先へもたどらない', () => {
    const edges = [edge('a', 'b'), edge('b', 'c'), edge('a', 'd')];
    expect(connectedNotes(['a'], edges, (id) => id !== 'b')).toEqual(['d']);
  });
});
