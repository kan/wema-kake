import { describe, expect, it } from 'vitest';
import { internalUrl } from '../src/web/links';

const ORIGIN = 'https://wiki.example.com';

describe('internalUrl', () => {
  it.each([
    'https://wiki.example.com/',
    'https://wiki.example.com/p/memo',
    'https://wiki.example.com/p/memo?x=1#h',
  ])('%s はサイト内', (url) => {
    expect(internalUrl(url, ORIGIN)).toBe(url);
  });

  it.each([
    'https://other.example/p/memo',
    'http://wiki.example.com/p/memo',
    'https://wiki.example.com.evil.example/p/memo',
    'https://wiki.example.com@evil.example/p/memo',
    'mailto:a@example.com',
    'not a url',
  ])('%s はサイト外', (url) => {
    expect(internalUrl(url, ORIGIN)).toBeNull();
  });

  it('パスが // で始まる URL でも、移動先はサイト内のまま', () => {
    // パスだけを取り出して移動すると、//evil.example/x はサイト外を指す
    const target = internalUrl('https://wiki.example.com//evil.example/x', ORIGIN);
    expect(target).toBe('https://wiki.example.com//evil.example/x');
    expect(new URL(target!).origin).toBe(ORIGIN);
    expect(new URL(new URL(target!).pathname, ORIGIN).origin).not.toBe(ORIGIN);
  });
});
