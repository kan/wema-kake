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
