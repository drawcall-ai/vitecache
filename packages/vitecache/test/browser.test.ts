import { afterEach, expect, test, vi } from 'vitest';
import { CacheEntry } from '../src/browser.js';
import { key } from '../src/entry.js';

afterEach(() => vi.unstubAllGlobals());

function serve(response: () => Response) {
  vi.stubGlobal('location', { href: 'https://example.test/app/' });
  const fetch = vi.fn(async (_url: URL, _init: RequestInit) => response());
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

test('loads the bytes at the key, revalidating them, below the base path', async () => {
  const fetch = serve(
    () => new Response(new Uint8Array([5]), { headers: { 'Content-Type': 'application/octet-stream' } }),
  );
  const options = { version: 'unit@1', basePath: '/app/cache' };
  expect(await new CacheEntry(options).load()).toEqual(new Uint8Array([5]));
  expect(fetch.mock.calls[0]?.[0].href).toBe(`https://example.test/app/cache/${key(options)}.bin`);
  expect(fetch.mock.calls[0]?.[1].cache).toBe('no-cache');
});

test.each([
  ['404', () => new Response(null, { status: 404 })],
  ['an SPA fallback page', () => new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html' } })],
])('a miss answered with %s loads undefined', async (_, response) => {
  serve(response);
  expect(await new CacheEntry({ version: 'missing@1' }).load()).toBeUndefined();
});

test('save writes nothing and warns once per version', async () => {
  const fetch = serve(() => new Response(null, { status: 404 }));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await new CacheEntry({ version: 'warned@1' }).save(new Uint8Array([1]));
  await new CacheEntry({ version: 'warned@1' }).save(new Uint8Array([1]));
  expect(warn).toHaveBeenCalledOnce();
  expect(fetch).not.toHaveBeenCalled();
});

/** The skill's public loader key path: below the app's base for a served URL, as is for Node's path from setPath. */
function publicPath(served: string, basePath: string): string {
  const base = served.startsWith('/') ? '/' : new URL('..', new URL(basePath, served)).pathname;
  return `/${new URL(served, 'http://node').pathname.slice(base.length)}`;
}

test("the skill's public loader keys alike on Node's path and the browser's served URL", () => {
  const keyed = (path: string) => key({ version: 'model@1', dependencies: { path: { value: path } } });
  const node = keyed(publicPath('/@scope/my%20tree/./model.glts', '/app/_vitecache/'));
  expect(keyed(publicPath('http://host/app/@scope/my%20tree/model.glts', '/app/_vitecache/'))).toBe(node);
  expect(keyed(publicPath('http://host/@scope/my%20tree/model.glts', '/_vitecache/'))).toBe(node);
  expect(node).toBe(keyed('/@scope/my%20tree/model.glts'));
});
