import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { createQuarkPosters } from '../lib/quark-posters.mjs';
import { createRequest } from '../lib/network.mjs';
import { createQuarkCatalog } from '../lib/quark-catalog.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const url = id => `https://img3.doubanio.com/view/photo/m_ratio_poster/public/p${id}.png`;
const registered = { poster: id => /^[1-9]\d*$/.test(id) && Number(id) <= 1000 ? url(id) : undefined };
function image(body = png, { statusCode = 200, headers = {} } = {}) {
  return Object.assign(Readable.from([body]), { statusCode, headers: { 'content-type': 'image/png', 'content-length': String(body.length), ...headers } });
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('registered poster lookup uses fixed Douban headers and returns verified bytes with a stable ETag', async () => {
  const calls = [], catalog = { poster: id => id === '1' ? url(id) : undefined, detail() { assert.fail('poster lookup must not fetch details'); } };
  const service = createQuarkPosters({ catalog, request: async (target, options) => { calls.push({ target, options }); return image(); } });
  try {
    const first = await service.get('1'); assert.deepEqual(first.body, png); assert.equal(first.type, 'image/png'); assert.match(first.etag, /^"[A-Za-z0-9_-]{43}"$/);
    assert.equal((await service.get('1')).etag, first.etag); assert.equal(calls.length, 1);
    assert.equal(calls[0].target, url('1')); assert.equal(calls[0].options.headers.referer, 'https://movie.douban.com/'); assert.match(calls[0].options.headers['user-agent'], /^Mozilla\/5\.0/);
    assert.equal(calls[0].options.followRedirects, false); assert.equal(calls[0].options.headers['accept-encoding'], 'identity');
    assert.equal(Object.keys(calls[0].options.headers).some(key => /cookie|authorization/i.test(key)), false);
    assert.equal(calls.length, 1);
  } finally { await service.stop(); }
});

test('IDs and registered image hosts are constrained before any transport call', async () => {
  let calls = 0;
  const request = async () => { calls++; return image(); };
  for (const id of ['0', '-1', '1x', 'https://img3.doubanio.com/a.png', '9007199254740992']) {
    const service = createQuarkPosters({ catalog: registered, request });
    try { await assert.rejects(service.get(id), error => error.status === 400); } finally { await service.stop(); }
  }
  for (const poster of ['http://img3.doubanio.com/a.png', 'https://img3.doubanio.com:444/a.png', 'https://user:pass@img3.doubanio.com/a.png', 'https://img3.doubanio.com.evil.example/a.png', 'https://evil.doubanio.com/a.png', 'https://movie.douban.com/a.png', 'https://127.0.0.1/a.png']) {
    const service = createQuarkPosters({ catalog: { poster: () => poster }, request });
    try { await assert.rejects(service.get('1'), error => error.status === 404); } finally { await service.stop(); }
  }
  const missing = createQuarkPosters({ catalog: {}, request });
  try { await assert.rejects(missing.get('1'), error => error.status === 404); } finally { await missing.stop(); }
  assert.equal(calls, 0);
});

test('safe transport blocks private DNS and never follows an image redirect', async () => {
  let transports = 0, lookups = 0;
  const privateRequest = createRequest({ lookup: async () => [{ address: '127.0.0.1', family: 4 }], httpsRequest: () => { transports++; assert.fail('private DNS must not connect'); } });
  const blocked = createQuarkPosters({ catalog: registered, request: privateRequest });
  try { await assert.rejects(blocked.get('1'), error => error.status === 403); } finally { await blocked.stop(); }
  const safeRequest = createRequest({ lookup: async host => { lookups++; assert.equal(host, 'img3.doubanio.com'); return [{ address: '8.8.8.8', family: 4 }]; }, httpsRequest: (target, options, respond) => {
    transports++; assert.equal(target.hostname, 'img3.doubanio.com'); assert.equal(options.validatedAddress, '8.8.8.8');
    options.lookup(target.hostname, { all: true }, (error, records) => { assert.equal(error, null); assert.equal(records[0].address, '8.8.8.8'); });
    const outgoing = new EventEmitter(); outgoing.end = () => queueMicrotask(() => { const response = image(png, { statusCode: 302, headers: { location: 'https://evil.example/redirect.png' } }); respond(response); outgoing.emit('response', response); }); outgoing.destroy = error => outgoing.emit('error', error); return outgoing;
  } });
  const redirected = createQuarkPosters({ catalog: registered, request: safeRequest });
  try { await assert.rejects(redirected.get('1'), error => error.status === 502 && /重定向/.test(error.message)); } finally { await redirected.stop(); }
  assert.equal(transports, 1); assert.equal(lookups, 1);
});

test('418 CDN text, disguised HTML/SVG, wrong magic, compression and oversize bodies are rejected and not cached', async () => {
  for (const response of [
    image(Buffer.from('cdn error 001\n'), { statusCode: 418, headers: { 'content-type': 'image/jpeg' } }),
    image(Buffer.from('<html>not an image</html>')),
    image(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), { headers: { 'content-type': 'image/svg+xml' } }),
    image(png, { headers: { 'content-type': 'image/jpeg' } }),
    image(png, { headers: { 'content-encoding': 'gzip' } }),
    image(png, { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } }),
    Object.assign(Readable.from([png, Buffer.alloc(2 * 1024 * 1024)]), { statusCode: 200, headers: { 'content-type': 'image/png' } }),
  ]) {
    let calls = 0;
    const service = createQuarkPosters({ catalog: registered, request: async () => ++calls === 1 ? response : image() });
    try { await assert.rejects(service.get('1'), error => error.status === 502); assert.equal(response.destroyed, true); assert.deepEqual((await service.get('1')).body, png); assert.equal(calls, 2); }
    finally { await service.stop(); }
  }
});

test('cache expires, follows registered URL changes, and evicts within its memory bound', async () => {
  let clock = 0, target = url('1'), calls = 0;
  const service = createQuarkPosters({ catalog: { poster: () => target }, now: () => clock, request: async () => { calls++; return image(); } });
  try {
    await service.get('1'); await service.get('1'); assert.equal(calls, 1); clock += 6 * 60 * 60 * 1000 + 1; await service.get('1'); assert.equal(calls, 2);
    target = url('2'); await service.get('1'); assert.equal(calls, 3);
  } finally { await service.stop(); }
  const large = Buffer.concat([png, Buffer.alloc(1024 * 1024 - png.length)]); calls = 0;
  const bounded = createQuarkPosters({ catalog: registered, request: async () => { calls++; return image(large); } });
  try { for (let id = 1; id <= 17; id++) await bounded.get(String(id)); assert.equal(calls, 17); await bounded.get('17'); assert.equal(calls, 17); await bounded.get('1'); assert.equal(calls, 18, 'oldest image evicted before exceeding 16 MiB'); }
  finally { await bounded.stop(); }
});

test('duplicate subscribers share one image and cancelling one does not interrupt the other', async () => {
  let finish, calls = 0, upstreamSignal;
  const service = createQuarkPosters({ catalog: registered, request: async (_url, { signal }) => { calls++; upstreamSignal = signal; await new Promise(resolve => { finish = resolve; }); return image(); } });
  const controller = new AbortController();
  try {
    const one = service.get('1', { signal: controller.signal }).catch(error => error), two = service.get('1'); await tick(); assert.equal(calls, 1); controller.abort(); assert.equal((await one).name, 'AbortError'); assert.equal(upstreamSignal.aborted, false); finish(); assert.deepEqual((await two).body, png);
  } finally { finish?.(); await service.stop(); }
});

test('two active requests and 32 queued requests are bounded and stop aborts and drains them', async () => {
  let active = 0, maximum = 0, calls = 0;
  const service = createQuarkPosters({ catalog: registered, request: async (_url, { signal }) => {
    calls++; active++; maximum = Math.max(maximum, active);
    try { await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); return image(); }
    finally { active--; }
  } });
  const jobs = Array.from({ length: 34 }, (_, i) => service.get(String(i + 1)).catch(error => error));
  await tick(); assert.equal(calls, 2); assert.equal(maximum, 2); await assert.rejects(service.get('35'), error => error.status === 503);
  await service.stop(); const errors = await Promise.all(jobs); assert.ok(errors.every(error => error.status === 503)); assert.equal(active, 0); assert.equal(calls, 2); await assert.rejects(service.get('1'), error => error.status === 503);
});

test('body timeout cancels the stream and releases capacity for a later image', async () => {
  const pending = Object.assign(new PassThrough(), { statusCode: 200, headers: { 'content-type': 'image/png' } }); let calls = 0;
  const service = createQuarkPosters({ catalog: registered, timeout: 10, request: async () => ++calls === 1 ? pending : image() });
  try { await assert.rejects(service.get('1'), error => error.status === 504); assert.equal(pending.destroyed, true); assert.deepEqual((await service.get('2')).body, png); }
  finally { await service.stop(); }
});

function catalogFixture() {
  const values = new Map(), calls = [];
  let clock = Date.UTC(2026, 9, 14), page = 0;
  const store = { meta: key => values.get(key), setMeta: (key, value) => values.set(key, value) };
  const film = id => ({ id, title: `海报样例${id}`, type: 'movie', year: '2025', genres: ['剧情'], is_released: true,
    rating: { count: 100, max: 10, value: 8 }, pic: { normal: url(id) } });
  function create() {
    return createQuarkCatalog({ store, now: () => clock, request: async target => {
      const address = new URL(target); calls.push(address.pathname);
      const data = address.pathname.endsWith('/recommend') ? { items: Array.from({ length: 20 }, (_, i) => film(String(page * 20 + i + 1))), total: 1000 } : film(address.pathname.split('/').at(-1));
      if (address.pathname.endsWith('/recommend')) page++;
      return Object.assign(Readable.from([Buffer.from(JSON.stringify(data))]), { statusCode: 200, headers: {} });
    } });
  }
  return { create, calls, age: days => { clock += days * 24 * 60 * 60 * 1000; } };
}

test('a persisted favorite poster recovers by trusted detail ID after an eight-day catalog restart', async () => {
  const fixture = catalogFixture(); let catalog = fixture.create();
  await catalog.browse(); assert.equal(catalog.poster('1'), url('1')); await catalog.stop(); fixture.age(8);
  catalog = fixture.create(); assert.equal(catalog.poster('1'), undefined); let images = 0;
  const service = createQuarkPosters({ catalog, request: async target => { images++; assert.equal(target, url('1')); return image(); } });
  try {
    const before = fixture.calls.length; assert.deepEqual((await service.get('1')).body, png);
    assert.deepEqual(fixture.calls.slice(before), ['/rexxar/api/v2/movie/1']); assert.equal(catalog.poster('1'), url('1'));
    await service.get('1'); assert.equal(fixture.calls.length, before + 1); assert.equal(images, 1);
  } finally { await service.stop(); await catalog.stop(); }
});

test('an old favorite poster recovers after both subject and page registries evict it', async () => {
  const fixture = catalogFixture(), catalog = fixture.create();
  for (let i = 0; i < 33; i++) await catalog.browse({ page: i % 25 + 1, sort: i < 25 ? 'release' : 'score' });
  assert.equal(catalog.poster('1'), undefined);
  const service = createQuarkPosters({ catalog, request: async target => { assert.equal(target, url('1')); return image(); } });
  try {
    const before = fixture.calls.length; assert.deepEqual((await service.get('1')).body, png);
    assert.deepEqual(fixture.calls.slice(before), ['/rexxar/api/v2/movie/1']);
  } finally { await service.stop(); await catalog.stop(); }
});

test('same-ID recovery is shared across callers and one cancellation does not cancel shared detail work', async () => {
  let registered, finishDetail, finishImage, details = 0, images = 0;
  const catalog = { poster: () => registered, detail: async (...args) => {
    details++; assert.deepEqual(args, ['1']); await new Promise(resolve => { finishDetail = resolve; }); registered = url('1'); return { id: '1' };
  } };
  const service = createQuarkPosters({ catalog, request: async () => { images++; await new Promise(resolve => { finishImage = resolve; }); return image(); } });
  const controller = new AbortController();
  try {
    const one = service.get('1', { signal: controller.signal }).catch(error => error), two = service.get('1'); await tick(); assert.equal(details, 1);
    controller.abort(); assert.equal((await one).name, 'AbortError'); finishDetail(); await tick();
    const three = service.get('1'); await tick(); assert.equal(images, 1); finishImage();
    assert.deepEqual((await two).body, png); assert.deepEqual((await three).body, png); assert.equal(details, 1);
    await service.get('1'); assert.equal(details, 1); assert.equal(images, 1);
  } finally { finishDetail?.(); finishImage?.(); await service.stop(); }
});

test('recovery verifies the returned ID and rechecks only the registered fixed image hosts', async () => {
  for (const [id, target] of [['2', url('1')], ['1', 'https://127.0.0.1/private'], ['1', 'https://evil.doubanio.com/a.png'], ['1', undefined]]) {
    let registered, images = 0;
    const catalog = { poster: () => registered, detail: async () => { registered = target; return { id, poster: url('1') }; } };
    const service = createQuarkPosters({ catalog, request: async () => { images++; return image(); } });
    try { await assert.rejects(service.get('1'), error => error.status === 404); assert.equal(images, 0); }
    finally { await service.stop(); }
  }
});

test('a hanging shared detail cannot keep a poster caller beyond the existing eight-second deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 }); let finish, images = 0;
  const catalog = { poster: () => undefined, detail: () => new Promise(resolve => { finish = resolve; }) };
  const service = createQuarkPosters({ catalog, request: async () => { images++; return image(); } });
  try {
    const pending = service.get('1').catch(error => error); await tick(); t.mock.timers.tick(8000);
    assert.equal((await pending).status, 504); assert.equal(images, 0); await service.stop(); finish({ id: '1' }); await tick(); assert.equal(images, 0);
  } finally { finish?.({ id: '1' }); await service.stop(); }
});

test('catalog recovery and image reading share one startup deadline rather than receiving eight seconds each', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  let registered, finish, requestTimeout, settled = false;
  const pendingImage = Object.assign(new PassThrough(), { statusCode: 200, headers: { 'content-type': 'image/png' } });
  const catalog = { poster: () => registered, detail: async () => { await new Promise(resolve => { finish = resolve; }); registered = url('1'); return { id: '1' }; } };
  const service = createQuarkPosters({ catalog, request: async (_target, options) => { requestTimeout = options.timeout; return pendingImage; } });
  try {
    const pending = service.get('1').catch(error => error).finally(() => { settled = true; }); await tick(); t.mock.timers.tick(6000); finish(); await tick();
    assert.equal(requestTimeout, 2000); t.mock.timers.tick(1999); await tick(); assert.equal(settled, false);
    t.mock.timers.tick(1); assert.equal((await pending).status, 504); assert.equal(pendingImage.destroyed, true);
  } finally { finish?.(); await service.stop(); }
});

test('caller cancellation and service stop end recovery waits without aborting catalog detail for other users', async () => {
  const completions = []; let images = 0;
  const catalog = { poster: () => undefined, detail: () => new Promise(resolve => completions.push(resolve)) };
  const service = createQuarkPosters({ catalog, request: async () => { images++; return image(); } });
  const controller = new AbortController();
  try {
    const one = service.get('1', { signal: controller.signal }).catch(error => error); await tick(); controller.abort(); assert.equal((await one).name, 'AbortError');
    const two = service.get('2').catch(error => error); await tick(); await service.stop(); assert.equal((await two).status, 503);
    for (const complete of completions) complete({ id: '1' }); await tick(); assert.equal(images, 0);
  } finally { for (const complete of completions) complete({ id: '1' }); await service.stop(); }
});
