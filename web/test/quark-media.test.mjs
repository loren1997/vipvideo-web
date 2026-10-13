import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable, PassThrough } from 'node:stream';
import { createQuarkMedia } from '../lib/quark-media.mjs';

const descriptor = (extra = {}) => ({ episode: { type: 'hls', url: 'https://video.quark.cn/main.m3u8?sign=keep' },
  headers: { cookie: '__puus=account-secret', 'user-agent': 'Official-web-agent', referer: 'https://pan.quark.cn/', authorization: 'do-not-forward' },
  allowCookieOrigins: ['https://video.quark.cn'], metadata: { name: '影片', category: 'movie', version: 'stable-v1' }, ...extra });
async function fixture(t, options = {}) {
  const calls = [], cloud = createQuarkMedia({ quark: { playback: async () => descriptor() }, request: async (url, input) => {
    calls.push({ url: String(url), headers: input.headers });
    const manifest = url.pathname.endsWith('.m3u8');
    return Object.assign(Readable.from([Buffer.from(manifest
      ? '#EXTM3U\n#EXTINF:5,\nsame.ts?sign=keep\n#EXTINF:5,\nhttps://cdn.example/other.ts\n#EXT-X-ENDLIST\n' : 'video')]),
    { statusCode: 200, headers: { 'content-type': manifest ? 'application/vnd.apple.mpegurl' : 'video/mp2t' } });
  }, ...options });
  const server = createServer(async (req, res) => {
    try { const url = new URL(req.url, 'http://localhost'); await cloud.serve(req, res, url.pathname.split('/').at(-1), url.searchParams.get('token')); }
    catch (error) { res.statusCode = error.status || 500; res.end(error.message); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { cloud.invalidate(); server.closeAllConnections(); await new Promise(done => server.close(done)); });
  return { cloud, calls, base: `http://127.0.0.1:${server.address().port}` };
}

test('cloud credentials stay on exact official origins and HLS child URLs remain signed', async t => {
  const { cloud, calls, base } = await fixture(t), lease = await cloud.playback('asset');
  assert.match(lease.response.url, /^\/api\/quark\/media\/[a-f0-9]{32}\?token=/);
  assert.ok(!JSON.stringify(lease.response).includes('account-secret'));
  assert.ok(!JSON.stringify(lease.response).includes('video.quark.cn'));
  const response = await fetch(base + lease.response.url);
  assert.equal(response.status, 200);
  const children = (await response.text()).split('\n').filter(row => row && !row.startsWith('#'));
  for (const child of children) assert.equal((await fetch(base + child)).status, 200);
  assert.equal(calls[0].headers.cookie, '__puus=account-secret');
  assert.equal(calls[1].headers.cookie, '__puus=account-secret');
  assert.equal(calls[2].headers.cookie, undefined);
  assert.equal(calls[2].headers.referer, undefined);
  assert.ok(calls.every(call => call.headers.authorization === undefined));
  assert.match(calls[1].url, /sign=keep$/);
});

test('original download forwards Range while account changes invalidate media and in-flight leases', async t => {
  const { cloud, calls, base } = await fixture(t, { quark: { playback: async () => descriptor({ episode: { type: 'mkv', url: 'https://video.quark.cn/file.mkv' } }) } });
  const lease = await cloud.playback('asset');
  assert.equal((await fetch(base + lease.response.url, { headers: { Range: 'bytes=20-40' } })).status, 200);
  assert.equal(calls[0].headers.range, 'bytes=20-40');
  cloud.invalidate();
  assert.equal((await fetch(base + lease.response.url)).status, 403);
  let release; const pending = new Promise(resolve => { release = resolve; });
  const delayed = createQuarkMedia({ quark: { playback: () => pending } });
  const result = delayed.playback('asset'); delayed.invalidate(); release(descriptor());
  await assert.rejects(result, { status: 409 });
});

test('passes the household authorization guard into delayed upstream playback lookup', async () => {
  let allowed = true, release, entered, continued = 0, guard;
  const pending = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const cloud = createQuarkMedia({ quark: { playback: async (_, options) => {
    guard = options?.valid; entered(); await pending;
    if (guard && !guard()) throw Object.assign(new Error('会话已结束'), { status: 401 });
    continued++; return descriptor();
  } } });
  const playback = cloud.playback('asset', { valid: () => allowed });
  await started; allowed = false; release();
  await assert.rejects(playback, { status: 401 });
  assert.equal(typeof guard, 'function'); assert.equal(continued, 0);
});

test('rejects credential origin lookalikes, private media and hidden content before producing a URL', async () => {
  for (const extra of [{ allowCookieOrigins: ['https://video.quark.cn.evil'] },
    { allowCookieOrigins: ['http://video.quark.cn'] }, { episode: { type: 'mp4', url: 'http://127.0.0.1/private' } }]) {
    const cloud = createQuarkMedia({ quark: { playback: async () => descriptor(extra) } });
    await assert.rejects(cloud.playback('asset'));
  }
  const cloud = createQuarkMedia({ quark: { playback: async () => descriptor({ metadata: { category: 'adult' } }) },
    visible: () => { throw Object.assign(new Error('hidden'), { status: 403 }); } });
  await assert.rejects(cloud.playback('asset'), { status: 403 });
});

test('disconnect closes a delayed upstream before it can stream old-account data', async t => {
  let release, started;
  const waiting = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { started = resolve; });
  const response = Object.assign(Readable.from([Buffer.from('old-account-video')]), { statusCode: 200, headers: { 'content-type': 'video/mp4' } });
  const { cloud, base } = await fixture(t, { quark: { playback: async () => descriptor({ episode: { type: 'mp4', url: 'https://video.quark.cn/file.mp4' } }) },
    request: async () => { started(); await waiting; return response; } });
  const lease = await cloud.playback('asset'), result = fetch(base + lease.response.url);
  await ready; cloud.invalidate(); release();
  assert.equal((await result).status, 403); assert.equal(response.destroyed, true);
});

test('disconnect aborts an already streaming original download', async t => {
  const upstream = Object.assign(new PassThrough(), { statusCode: 200, headers: { 'content-type': 'video/mp4' } });
  const { cloud, base } = await fixture(t, { quark: { playback: async () => descriptor({ episode: { type: 'mp4', url: 'https://video.quark.cn/file.mp4' } }) },
    request: async () => upstream });
  const lease = await cloud.playback('asset'); upstream.write('started');
  const response = await fetch(base + lease.response.url), reader = response.body.getReader();
  assert.equal((await reader.read()).done, false);
  cloud.invalidate(); assert.equal(upstream.destroyed, true);
  await assert.rejects(reader.read());
});
