// 接続線でつながっている付箋をたどる。
import type { WemaEdge } from './delta';

/**
 * `ids` の付箋から、接続線をたどって届く付箋（`ids` 自身は除く）。接続線の向きは見ない。
 * `passable` が false を返す付箋は、結果に入れず、その先へもたどらない
 */
export function connectedNotes(
  ids: Iterable<string>,
  edges: Pick<WemaEdge, 'from' | 'to'>[],
  passable: (id: string) => boolean = () => true,
): string[] {
  const neighbors = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    const list = neighbors.get(a);
    if (list) list.push(b);
    else neighbors.set(a, [b]);
  };
  for (const edge of edges) {
    link(edge.from, edge.to);
    link(edge.to, edge.from);
  }
  const start = new Set(ids);
  const found = new Set<string>();
  const queue = [...start];
  for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
    for (const next of neighbors.get(id) ?? []) {
      if (start.has(next) || found.has(next) || !passable(next)) continue;
      found.add(next);
      queue.push(next);
    }
  }
  return [...found];
}
