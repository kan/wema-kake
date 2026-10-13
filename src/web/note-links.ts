// 付箋のつながりの印（issue #11）。付箋を縦に積んでいる間（stacked-view.ts）は、wema が接続線を
// 表示しない。代わりに、付箋ごとに、つながっている相手を印として並べる。
//
// ここは、印の中身を決める計算だけを持つ（DOM に触らない）。
import type { WemaEdge, WemaNote } from '@kanf/wema';
import { childPageOf } from '../shared/hierarchy';
import { BLOCK_TAGS, decodeEntities } from '../shared/note-html';

/**
 * 付箋から見た、接続線の向き。`out` は相手へ向かう矢印、`in` は相手から来る矢印、
 * `both` は両端の矢印、`none` は矢印のない線
 */
export type LinkDirection = 'out' | 'in' | 'both' | 'none';

export interface NoteLink {
  edgeId: string;
  direction: LinkDirection;
  /** 相手の付箋の id */
  peer: string;
  /** 相手の付箋の冒頭。子ページの付箋なら、子ページの表示名。本文に文字がなければ、空文字 */
  text: string;
  /** 接続線のラベル */
  label?: string;
}

/** 印を並べる順。出ていく線、入ってくる線の順に出す */
const ORDER: LinkDirection[] = ['out', 'in', 'both', 'none'];

/** タグの名前より後ろ。属性の値（引用符の中）に `>` があっても、そこで終わりにしない */
const TAG_REST = `(?:[^>"']|"[^"]*"|'[^']*')*>`;
const BLOCK_RE = new RegExp(`</?(?:${BLOCK_TAGS.join('|')})\\b${TAG_REST}`, 'gi');
const TAG_RE = new RegExp(`<${TAG_REST}`, 'g');
/** 見えない文字（ゼロ幅スペース、BOM）。これだけの行は、文字のない行として扱う */
const INVISIBLE_RE = /[​﻿]/g;

/**
 * 付箋の text（サニタイズ済みの HTML）の、文字のある最初の行。文字がなければ、空文字。
 * 本文にそのまま入っている改行も、行の区切りにする（wema は、本文を `white-space: pre-wrap` で描く）。
 * 結果は、文字としてだけ使うこと（タグを正規表現で外しているので、HTML としては入れない）
 */
export function firstLine(html: string): string {
  const text = decodeEntities(html.replace(BLOCK_RE, '\n').replace(TAG_RE, ''));
  for (const line of text.split('\n')) {
    const trimmed = line.replace(INVISIBLE_RE, '').trim();
    if (trimmed !== '') return trimmed;
  }
  return '';
}

function directionOf(edge: WemaEdge, noteId: string): LinkDirection {
  // 矢印の指定がなければ、style から決まる（wema の描き方と同じ）
  const head = edge.arrowHead ?? (edge.style === 'arrow' ? 'end' : 'none');
  if (head === 'both' || head === 'none') return head;
  return (head === 'end') === (edge.from === noteId) ? 'out' : 'in';
}

/**
 * 付箋 `noteId` の印。`edges` は、その付箋につながる接続線（`board.getEdgesOf(noteId)`）。
 * 相手の付箋が `noteOf` で見つからない線と、両端が同じ付箋の線は、印にしない。
 * ボードに残っているが相手として出したくない付箋（子ページへ送っている途中の付箋など）は、
 * 呼び出す側が `noteOf` で undefined を返して外す
 *
 * `titleOf` は、子ページの表示名を返す
 */
export function noteLinks(
  noteId: string,
  edges: WemaEdge[],
  noteOf: (id: string) => WemaNote | undefined,
  titleOf: (child: string) => string,
): NoteLink[] {
  const links: NoteLink[] = [];
  for (const edge of edges) {
    const peerId = edge.from === noteId ? edge.to : edge.from;
    const peer = peerId === noteId ? undefined : noteOf(peerId);
    if (!peer) continue;
    const child = childPageOf(peer);
    const label = edge.label?.trim();
    links.push({
      edgeId: edge.id,
      direction: directionOf(edge, noteId),
      peer: peerId,
      text: child !== undefined ? titleOf(child) : firstLine(peer.text),
      ...(label ? { label } : {}),
    });
  }
  // 並べ替えは安定なので、同じ向きの印は、接続線の順のまま
  return links.sort((a, b) => ORDER.indexOf(a.direction) - ORDER.indexOf(b.direction));
}
