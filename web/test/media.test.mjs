import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createHmac } from 'node:crypto';
import { createMedia } from '../lib/media.mjs';

function response(body, statusCode = 200, headers = {}, finalUrl) { return Object.assign(Readable.from([Buffer.from(body)]), { statusCode, headers, finalUrl }); }
function detail(url, type = 'hls') { return { source: 'fixture', lines: [{ name: '高清', episodes: [{ name: '正片', url, type }] }] }; }
function tokenOf(url) { return new URL(url, 'http://test.example').searchParams.get('token'); }
function payloadOf(url) { return JSON.parse(Buffer.from(tokenOf(url).split('.')[0], 'base64url').toString('utf8')); }

async function serverFor(t, media) {
  const server = createServer(async (req, res) => {
    try { await media.serve(req, res, new URL(req.url, 'http://test.example').searchParams.get('token')); }
    catch (error) { if (!res.headersSent) { res.statusCode = error.status || 500; res.end(error.message); } else res.destroy(error); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('rewrites master variants and child playlist key/map/segment URIs with signed tokens', async t => {
  const calls = [];
  const master = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",URI="audio.m3u8?token=audio"\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nchild/list.m3u8?token=child%2Fvalue\n';
  const child = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example/key?token=key"\n#EXT-X-MAP:URI="init.mp4?token=map"\n#EXTINF:10,\n../segment.ts?token=segment\n#EXT-X-ENDLIST\n';
  const media = createMedia({ secret: 'fixture-secret', request: async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/original.m3u8')) return response(master, 200, { 'content-type': 'application/vnd.apple.mpegurl' }, 'https://cdn.example/final/master.m3u8?token=master');
    return response(child, 200, { 'content-type': 'application/vnd.apple.mpegurl' }, String(url));
  } });
  const base = await serverFor(t, media);
  const playback = media.playback(detail('https://cdn.example/original.m3u8?token=first'), 0, 0);
  const first = await fetch(base + playback.proxyUrl);
  const text = await first.text();
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('content-type'), 'application/vnd.apple.mpegurl; charset=utf-8');
  const audioProxy = text.match(/URI="([^"]+)"/)[1];
  assert.equal(payloadOf(audioProxy).url, 'https://cdn.example/final/audio.m3u8?token=audio');
  const childProxy = text.split('\n').find(line => line.startsWith('/api/media?'));
  assert.equal(payloadOf(childProxy).url, 'https://cdn.example/final/child/list.m3u8?token=child%2Fvalue');
  assert.equal(payloadOf(childProxy).expires, payloadOf(playback.proxyUrl).expires);
  const childResponse = await fetch(base + childProxy);
  const childText = await childResponse.text();
  const uris = [...childText.matchAll(/URI="([^"]+)"/g)].map(match => payloadOf(match[1]).url);
  assert.deepEqual(uris, ['https://keys.example/key?token=key', 'https://cdn.example/final/child/init.mp4?token=map']);
  assert.equal(payloadOf(childText.split('\n').find(line => line.startsWith('/api/media?'))).url, 'https://cdn.example/final/segment.ts?token=segment');
  assert.equal(calls.length, 2);
});

test('forwards Range and 206 headers without upstream cookies or arbitrary headers', async t => {
  let options;
  const media = createMedia({ request: async (_url, value) => { options = value; return response('2345', 206, { 'content-type': 'video/mp4', 'content-range': 'bytes 2-5/10', 'content-length': '4', 'accept-ranges': 'bytes', 'set-cookie': 'upstream=secret', 'x-powered-by': 'remote' }); } });
  const base = await serverFor(t, media);
  const playback = media.playback(detail('https://cdn.example/video.mp4?token=kept', 'mp4'), 0, 0);
  const result = await fetch(base + playback.proxyUrl, { headers: { range: 'bytes=2-5', cookie: 'session=local', authorization: 'Bearer local' } });
  assert.equal(result.status, 206);
  assert.equal(await result.text(), '2345');
  assert.equal(result.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(result.headers.get('set-cookie'), null);
  assert.equal(result.headers.get('x-powered-by'), null);
  assert.deepEqual(options.headers, { range: 'bytes=2-5' });
});

test('rejects arbitrary URLs, token tampering and expiry before any upstream request', async t => {
  let requests = 0;
  const secret = 'known-fixture-key';
  const media = createMedia({ secret, request: async () => { requests++; return response('bad'); } });
  const base = await serverFor(t, media);
  const playback = media.playback(detail('https://cdn.example/movie.mp4', 'mp4'), 0, 0);
  const token = tokenOf(playback.proxyUrl);
  assert.equal((await fetch(base + '/api/media?url=https://cdn.example/arbitrary.mp4')).status, 403);
  assert.equal((await fetch(base + '/api/media?token=' + token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'))).status, 403);
  const oldPayload = Buffer.from(JSON.stringify({ url: 'https://cdn.example/old.mp4', type: 'mp4', expires: Date.now() - 1 })).toString('base64url');
  const signature = createHmac('sha256', secret).update(oldPayload).digest('base64url');
  const expired = await fetch(base + '/api/media?token=' + oldPayload + '.' + signature);
  assert.equal(expired.status, 403);
  assert.match(await expired.text(), /已过期/);
  assert.equal(requests, 0);
});

test('page playback returns a direct link and rejects invalid selections/private media', () => {
  const media = createMedia();
  assert.deepEqual(media.playback(detail('https://jx.example/play?url=abc', 'page'), 0, 0), { url: 'https://jx.example/play?url=abc', type: 'page' });
  assert.throws(() => media.playback(detail('https://cdn.example/a.mp4', 'mp4'), 0, 9), { status: 400 });
  assert.throws(() => media.playback(detail('https://cdn.example/a.mp4', 'mp4'), '0', 0), { status: 400 });
  assert.throws(() => media.playback(detail('http://192.168.1.1/a.mp4', 'mp4'), 0, 0), { status: 403 });
});

test('rejects playlist private keys and invalid Range requests', async t => {
  const media = createMedia({ request: async () => response('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="http://10.0.0.1/key"\nsegment.ts\n', 200, { 'content-type': 'application/vnd.apple.mpegurl' }) });
  const base = await serverFor(t, media);
  const playback = media.playback(detail('https://cdn.example/list.m3u8'), 0, 0);
  assert.equal((await fetch(base + playback.proxyUrl)).status, 403);
  for (const range of ['items=1-2', 'bytes=-', 'bytes=2-1', 'bytes=9007199254740992-']) assert.equal((await fetch(base + playback.proxyUrl, { headers: { range } })).status, 400, range);
});

test('never exposes upstream HTML or scripts as executable same-origin content', async t => {
  const media = createMedia({ request: async () => response('<script>stealCookies()</script>', 200, { 'content-type': 'text/html' }) });
  const base = await serverFor(t, media);
  const playback = media.playback(detail('https://cdn.example/video.mp4', 'mp4'), 0, 0);
  const result = await fetch(base + playback.proxyUrl);
  assert.equal(result.headers.get('content-type'), 'application/octet-stream');
  assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await result.text(), '<script>stealCookies()</script>');
});

test('rejects HLS Range requests while retaining segment Range support', async t => {
  let calls = 0;
  const media = createMedia({ request: async () => { calls++; return response('#EXTM3U\n', 206, { 'content-type': 'application/vnd.apple.mpegurl' }); } });
  const base = await serverFor(t, media);
  const hls = media.playback(detail('https://cdn.example/list.m3u8'), 0, 0);
  assert.equal((await fetch(base + hls.proxyUrl, { headers: { range: 'bytes=0-10' } })).status, 400);
  assert.equal(calls, 0);
  const misleading = media.playback(detail('https://cdn.example/video.mp4', 'mp4'), 0, 0);
  assert.equal((await fetch(base + misleading.proxyUrl, { headers: { range: 'bytes=0-10' } })).status, 502);
});

test('client disconnect destroys an active upstream stream', async t => {
  let upstream;
  let started = false;
  const media = createMedia({ request: async () => {
    upstream = Object.assign(new Readable({ read() { if (!started) { started = true; this.push(Buffer.from('first')); } } }), { statusCode: 200, headers: { 'content-type': 'video/mp4' } });
    return upstream;
  } });
  const base = await serverFor(t, media);
  const playback = media.playback(detail('https://cdn.example/video.mp4', 'mp4'), 0, 0);
  const controller = new AbortController();
  const result = await fetch(base + playback.proxyUrl, { signal: controller.signal });
  await result.body.getReader().read();
  controller.abort();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(upstream.destroyed, true);
});

test('upstream stream errors remain observable after pipeline destroys the response', async () => {
  const media = createMedia({ request: async () => {
    const upstream = Object.assign(new Readable({ read() {} }), { statusCode: 200, headers: { 'content-type': 'video/mp4' } });
    setImmediate(() => upstream.destroy(new Error('fixture upstream failure')));
    return upstream;
  } });
  const req = Object.assign(new EventEmitter(), { headers: {}, method: 'GET', aborted: false });
  const res = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  res.setHeader = () => {};
  const playback = media.playback(detail('https://cdn.example/video.mp4', 'mp4'), 0, 0);
  await assert.rejects(media.serve(req, res, tokenOf(playback.proxyUrl)), error => error.status === 502 && error.cause.message === 'fixture upstream failure');
});

test('HEAD and unsatisfied ranges retain status and release upstream', async t => {
  let last;
  const media = createMedia({ request: async (_url, options) => { last = response('', options.headers.range ? 416 : 200, { 'content-type': 'video/mp4', 'content-length': options.headers.range ? '0' : '1000', 'content-range': 'bytes */1000' }); return last; } });
  const base = await serverFor(t, media);
  const playback = media.playback(detail('https://cdn.example/v.mp4', 'mp4'), 0, 0);
  const head = await fetch(base + playback.proxyUrl, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '1000');
  assert.equal(last.destroyed, true);
  const unsatisfied = await fetch(base + playback.proxyUrl, { headers: { range: 'bytes=9999-' } });
  assert.equal(unsatisfied.status, 416);
  assert.equal(unsatisfied.headers.get('content-range'), 'bytes */1000');
});
