import { describe, expect, it } from 'vitest';
import { decodeEntities } from '../src/shared/note-html';

describe('decodeEntities', () => {
  it.each([
    ['a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#x27;', `a & b <c> "d" 'e'`],
    ['a&nbsp;b', 'a b'],
    ['&#x3042;&#12356;', 'あい'],
    ['&unknown; &#0; &#x110000; &amp', '&unknown; &#0; &#x110000; &amp'],
  ])('%s → %s', (input, expected) => {
    expect(decodeEntities(input)).toBe(expected);
  });
});
