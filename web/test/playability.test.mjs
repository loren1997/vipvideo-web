import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { Readable } from 'node:stream';
import { createPlayability } from '../lib/playability.mjs';

const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 32]), Buffer.from('ftypisom'), Buffer.alloc(64)]);
const ts = Buffer.alloc(188 * 4, 0x11);
for (let offset = 0; offset < ts.length; offset += 188) ts[offset] = 0x47;
const episode = (url = 'https://cdn.example/video.m3u8?token=kept', type = 'hls') => ({ url, type });
function response(body = '', statusCode = 200, headers = {}, finalUrl) {
  return Object.assign(Readable.from([Buffer.isBuffer(body) ? body : Buffer.from(body)]), { statusCode, headers, finalUrl });
}
const manifest = segment => `#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\n${segment}\n#EXT-X-ENDLIST\n`;
const successHead = () => response('', 200, { 'content-type': 'video/mp4', 'content-length': '100000' });

test('MP4 HEAD keeps query parameters and requires successful supported media headers', async () => {
  const calls = [], heads = [];
  const service = createPlayability({ request: async (url, options) => { calls.push({ url, options }); const head = successHead(); heads.push(head); return head; }, now: () => 42 });
  assert.deepEqual(await service.check(episode('https://cdn.example/video.mp4?signature=a%2Fb', 'mp4')), { playable: true, checkedAt: 42 });
  assert.equal(calls[0].url, 'https://cdn.example/video.mp4?signature=a%2Fb');
  assert.equal(calls[0].options.method, 'HEAD');
  assert.equal(heads[0].destroyed, true);
  for (const [status, headers] of [[403, { 'content-type': 'video/mp4' }], [200, { 'content-type': 'text/html' }], [200, { 'content-type': 'video/mp4', 'content-length': '0' }]]) {
    let count = 0;
    const invalid = createPlayability({ request: async () => { count++; return response('', status, headers); } });
    assert.equal((await invalid.check(episode(undefined, 'mp4'))).playable, false);
    assert.equal(count, 1);
  }
});

test('unsupported HEAD falls back to bounded MP4 Range and closes ignored large ranges', async () => {
  for (const code of [405, 501]) {
    let body, calls = [];
    const service = createPlayability({ request: async (url, options) => {
      calls.push(options);
      if (options.method === 'HEAD') return response('', code);
      body = response(Buffer.concat([mp4, Buffer.alloc(1024 * 1024)]), 206, { 'content-type': 'application/octet-stream' });
      return body;
    } });
    assert.equal((await service.check(episode('https://cdn.example/movie.mp4', 'mp4'))).playable, true);
    assert.deepEqual(calls[1].headers, { range: 'bytes=0-1023' });
    assert.equal(body.destroyed, true);
  }
  const html = createPlayability({ request: async (_url, options) => options.method === 'HEAD' ? response('', 405) : response('<html>blocked</html>', 200, { 'content-type': 'video/mp4' }) });
  assert.equal((await html.check(episode(undefined, 'mp4'))).playable, false);
  const mislabeled = createPlayability({ request: async (_url, options) => options.method === 'HEAD' ? response('', 405) : response(ts, 200, { 'content-type': 'video/mp4' }) });
  assert.equal((await mislabeled.check(episode(undefined, 'mp4'))).playable, false);
});

test('HLS follows redirected master, keeps child/map/segment queries and verifies first media bytes', async () => {
  const calls = [];
  const service = createPlayability({ request: async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/start.m3u8')) return response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500000\nchild/list.m3u8?token=child%2Fvalue\n', 200, {}, 'https://cdn.example/final/master.m3u8?token=master');
    if (url.includes('list.m3u8')) return response('#EXTM3U\n#EXT-X-MAP:URI="init.mp4?token=map"\n#EXTINF:10,\n../segment.ts?token=segment\n');
    return response(url.includes('init.mp4') ? mp4 : ts, 206, { 'content-type': 'application/octet-stream' });
  } });
  assert.equal((await service.check(episode('https://cdn.example/start.m3u8?token=root'))).playable, true);
  assert.deepEqual(calls.map(call => call.url), ['https://cdn.example/start.m3u8?token=root', 'https://cdn.example/final/child/list.m3u8?token=child%2Fvalue', 'https://cdn.example/final/child/init.mp4?token=map', 'https://cdn.example/final/segment.ts?token=segment']);
  assert.deepEqual(calls.slice(2).map(call => call.options.headers.range), ['bytes=0-16383', 'bytes=0-16383']);
});

test('AES-128 verifies exact key, encrypted initialization and decrypted transport stream', async () => {
  const key = Buffer.alloc(16, 9), iv = Buffer.alloc(16, 3);
  const encrypt = bytes => { const cipher = createCipheriv('aes-128-cbc', key, iv); return Buffer.concat([cipher.update(bytes), cipher.final()]); };
  const calls = [];
  const service = createPlayability({ request: async (url, options) => {
    calls.push(url);
    if (url.includes('.m3u8')) return response(`#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin?auth=k",IV=0x${iv.toString('hex')}\n#EXT-X-MAP:URI="init.mp4?auth=m"\n#EXTINF:10,\nsegment.ts?auth=s\n`);
    if (url.includes('key.bin')) return response(key);
    return response(encrypt(url.includes('init.mp4') ? mp4 : ts), 200, { 'content-type': 'application/octet-stream' });
  } });
  assert.equal((await service.check(episode())).playable, true);
  assert.equal(calls.filter(url => url.includes('key.bin')).length, 1);
  assert.ok(calls.includes('https://cdn.example/key.bin?auth=k'));
});

test('AES-128 uses media sequence IV and rejects unavailable/wrong length keys', async () => {
  const key = Buffer.alloc(16, 2), iv = Buffer.alloc(16); iv.writeBigUInt64BE(7n, 8);
  const cipher = createCipheriv('aes-128-cbc', key, iv), encrypted = Buffer.concat([cipher.update(ts), cipher.final()]);
  for (const bytes of [key, Buffer.alloc(15), Buffer.alloc(17)]) {
    const service = createPlayability({ request: async url => url.includes('.m3u8') ? response('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:7\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:10,\nsegment.ts\n') : url.includes('key.bin') ? response(bytes) : response(encrypted, 200, { 'content-type': 'video/mp2t' }) });
    assert.equal((await service.check(episode())).playable, bytes.length === 16);
  }
});

test('missing segment/key/map or disguised HTML is never considered playable', async () => {
  for (const failing of ['segment', 'map', 'key', 'html', 'invalid']) {
    const service = createPlayability({ request: async url => {
      if (url.includes('.m3u8')) return response(`#EXTM3U\n${failing === 'map' ? '#EXT-X-MAP:URI="init.mp4"\n' : ''}${failing === 'key' ? '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n' : ''}#EXTINF:10,\nsegment.ts\n`);
      if (url.includes('init.mp4') || url.includes('key.bin') || failing === 'segment') return response('not found', 404);
      return response(failing === 'html' ? '<!DOCTYPE html><html>denied</html>' : Buffer.alloc(1024), 200, { 'content-type': 'video/mp2t' });
    } });
    assert.equal((await service.check(episode())).playable, false, failing);
  }
});

test('HLS byte ranges include initialization and first segment offsets', async () => {
  const ranges = [];
  const service = createPlayability({ request: async (url, options) => {
    if (url.includes('.m3u8')) return response('#EXTM3U\n#EXT-X-MAP:URI="parts.mp4?part=init",BYTERANGE="64@16"\n#EXT-X-BYTERANGE:200@1000\n#EXTINF:10,\nparts.mp4?part=segment\n');
    ranges.push(options.headers.range);
    return response(mp4, 206, { 'content-type': 'video/mp4' });
  } });
  assert.equal((await service.check(episode())).playable, true);
  assert.deepEqual(ranges, ['bytes=16-79', 'bytes=1000-1199']);
});

test('rejects empty/oversized/malformed manifests, loops and more than three playlists', async () => {
  for (const body of ['<html>failed</html>', '#EXTM3U\n#EXT-X-ENDLIST', '#EXTM3U\n#' + 'x'.repeat(256 * 1024)]) {
    const service = createPlayability({ request: async () => response(body) });
    assert.equal((await service.check(episode())).playable, false);
  }
  let loops = 0;
  const loop = createPlayability({ request: async () => { loops++; return response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nvideo.m3u8?token=kept\n'); } });
  assert.equal((await loop.check(episode())).playable, false);
  assert.equal(loops, 1);
  let nested = 0;
  const deep = createPlayability({ request: async () => { nested++; return response(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlevel${nested}.m3u8\n`); } });
  assert.equal((await deep.check(episode())).playable, false);
  assert.equal(nested, 3);
});

test('validates every configured/child/key/map/final URL before private access', async () => {
  let requests = 0;
  const direct = createPlayability({ request: async () => { requests++; return successHead(); } });
  for (const url of ['http://127.0.0.1/video.mp4', 'http://192.168.1.2/v.mp4', 'file:///v.mp4', 'https://user:password@cdn.example/v.mp4']) assert.equal((await direct.check(episode(url, 'mp4'))).playable, false);
  assert.equal(requests, 0);
  for (const part of ['child', 'key', 'map', 'final']) {
    const calls = [];
    const service = createPlayability({ request: async url => {
      calls.push(url);
      if (!url.includes('.m3u8')) return response(ts, 200, { 'content-type': 'video/mp2t' });
      if (part === 'final') return response(manifest('segment.ts'), 200, {}, 'http://10.0.0.1/list.m3u8');
      if (part === 'child') return response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhttp://10.0.0.1/list.m3u8\n');
      return response(`#EXTM3U\n${part === 'map' ? '#EXT-X-MAP:URI="http://10.0.0.1/init.mp4"' : '#EXT-X-KEY:METHOD=AES-128,URI="http://10.0.0.1/key.bin"'}\n#EXTINF:10,\nsegment.ts\n`);
    } });
    assert.equal((await service.check(episode())).playable, false, part);
    assert.equal(calls.some(url => url.includes('10.0.0.1')), false);
  }
});

test('whole eight-second deadline destroys a stalled response body', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const body = Object.assign(new Readable({ read() {} }), { statusCode: 200, headers: {} });
  const service = createPlayability({ request: async () => body });
  const pending = service.check(episode());
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(8000);
  const value = await pending;
  assert.equal(value.playable, false);
  assert.match(value.error, /8 秒/);
  assert.equal(body.destroyed, true);
});

test('whole deadline also covers a request which never returns headers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const service = createPlayability({ request: () => new Promise(() => {}) });
  const pending = service.check(episode(undefined, 'mp4'));
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(8000);
  assert.equal((await pending).playable, false);
});

test('deduplicates same episode and admits at most two probes concurrently', async () => {
  const pending = [], calls = [];
  const service = createPlayability({ request: (url, options) => { calls.push(url); return new Promise(resolve => pending.push(resolve)); } });
  const first = service.check(episode('https://cdn.example/a.mp4', 'mp4'));
  assert.equal(service.check(episode('https://cdn.example/a.mp4', 'mp4')), first);
  const results = [first, ...['b', 'c', 'd'].map(id => service.check(episode(`https://cdn.example/${id}.mp4`, 'mp4')))];
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 2);
  pending.shift()(successHead());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 3);
  pending.shift()(successHead());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 4);
  for (const release of pending.splice(0)) release(successHead());
  assert.ok((await Promise.all(results)).every(value => value.playable));
});

test('positive and negative caches expire independently and cap at 500 entries', async () => {
  let clock = 1000, calls = 0;
  const service = createPlayability({ now: () => clock, request: async url => { calls++; return url.includes('/bad') ? response('', 500) : successHead(); } });
  const good = episode('https://cdn.example/good.mp4', 'mp4'), bad = episode('https://cdn.example/bad.mp4', 'mp4');
  await service.check(good); await service.check(bad);
  clock += 59999; await service.check(good); await service.check(bad); assert.equal(calls, 2);
  clock++; await service.check(bad); assert.equal(calls, 3);
  clock = 301000; await service.check(good); assert.equal(calls, 4);
  for (let index = 0; index < 501; index++) await service.check(episode(`https://cdn.example/other-${index}.mp4`, 'mp4'));
  const before = calls; await service.check(good); assert.equal(calls, before + 1);
});

test('actual decoder reports override cached and in-flight successes, then can recover', async () => {
  let release, calls = 0;
  const service = createPlayability({ request: () => { calls++; return new Promise(resolve => { release = resolve; }); } });
  const video = episode('https://cdn.example/report.mp4', 'mp4');
  const pending = service.check(video);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.report(video, false).playable, false);
  release(successHead());
  assert.equal((await pending).playable, false);
  assert.equal((await service.check(video)).playable, false);
  assert.equal(calls, 1);
  assert.equal(service.report(video, true).playable, true);
  assert.equal((await service.check(video)).playable, true);
});

const hdMaster = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360,CODECS="avc1.42e01e"\nsd.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080,CODECS="avc1.640028"\nhd.m3u8\n';

test('master validates the highest reasonable compatible rendition instead of the first low-quality URI', async () => {
  const calls = [];
  const service = createPlayability({ request: async url => {
    calls.push(url); if (url.includes('video.m3u8')) return response(hdMaster);
    if (url.endsWith('/hd.m3u8')) return response(manifest('hd.ts'));
    if (url.endsWith('/hd.ts')) return response(ts, 206, { 'content-type': 'video/mp2t' });
    throw new Error('不应访问低清分支');
  } });
  const result = await service.check(episode());
  assert.equal(result.playable, true); assert.deepEqual(result.quality, { width: 1920, height: 1080, bandwidth: 3000000, source: 'manifest' }); assert.equal(result.playbackUrl, 'https://cdn.example/hd.m3u8');
  assert.equal(calls.length, 3);
});

test('a failed highest rendition falls back to verified lower quality without using private rendition URLs', async () => {
  const called = [];
  const body = hdMaster.replace('sd.m3u8', 'low.m3u8').replace('640x360', '1280x720').replace('hd.m3u8', 'http://127.0.0.1/private.m3u8');
  const service = createPlayability({ request: async url => {
    called.push(url); if (url.includes('video.m3u8')) return response(body);
    if (url.endsWith('/low.m3u8')) return response(manifest('low.ts'));
    return response(ts, 206, { 'content-type': 'video/mp2t' });
  } });
  const result = await service.check(episode()); assert.equal(result.playable, true); assert.equal(result.quality.height, 720); assert.ok(called.every(url => !url.includes('127.0.0.1')));
});

test('independent audio and newly issued child queries retain the master entry instead of freezing video-only or temporary URLs', async () => {
  for (const independent of [false, true]) {
    const master = independent ? '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,AUDIO="aud"\nchild.m3u8\n' : '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720\nchild.m3u8?opaque=temporary\n';
    const service = createPlayability({ request: async url => url.includes('video.m3u8') ? response(master) : url.includes('child.m3u8') ? response(manifest('part.ts')) : response(ts, 206, { 'content-type': 'video/mp2t' }) });
    const result = await service.check(episode()); assert.equal(result.playable, true); assert.equal(result.playbackUrl, episode().url); assert.equal(result.quality.height, 720);
  }
});

test('stalled high-quality headers or body cannot consume the full deadline and block a ready lower rendition', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const flush = () => new Promise(done => setImmediate(done));
  for (const stalled of ['headers', 'body']) {
    let release;
    const hanging = new Readable({ read() {} }); Object.assign(hanging, { statusCode: 200, headers: {} });
    const service = createPlayability({ request: async url => {
      if (url.includes('video.m3u8')) return response(hdMaster.replace('640x360', '1280x720'));
      if (url.endsWith('/hd.m3u8')) return stalled === 'body' ? hanging : new Promise(done => { release = () => done(hanging); });
      if (url.endsWith('/sd.m3u8')) return response(manifest('low.ts'));
      return response(ts, 206, { 'content-type': 'video/mp2t' });
    } });
    const pending = service.check(episode()); await flush(); t.mock.timers.tick(4000); await flush();
    const result = await pending; assert.equal(result.playable, true); assert.equal(result.quality.height, 720);
    release?.(); await flush(); assert.equal(hanging.destroyed, true);
  }
});

function transportWithSps(nal) {
  const body = Buffer.alloc(188 * 4, 0xff);
  for (let offset = 0; offset < body.length; offset += 188) { body[offset] = 0x47; body[offset + 1] = 0; body[offset + 2] = 0x20; body[offset + 3] = 0x10; }
  body[189] = 0x41; body[190] = 0; body[191] = 0x10;
  Buffer.concat([Buffer.from('000001e0000080000000000001', 'hex'), nal, Buffer.from('000000016801', 'hex')]).copy(body, 192);
  return body;
}

test('a real H264 SPS yields actual 1080p dimensions without depending on the channel name or manifest labels', async () => {
  // 36-byte codec metadata from the bounded public Anhui sample; no video frames are embedded.
  const sps = Buffer.from('67640029acd100780227e59a2000000300200000065d5800ea60030d5259803c60c44800', 'hex');
  const service = createPlayability({ request: async url => url.includes('.m3u8') ? response(manifest('part.ts').replace('#EXT-X-ENDLIST\n', '')) : response(transportWithSps(sps), 206, { 'content-type': 'video/mp2t' }) });
  const result = await service.check(episode()); assert.equal(result.playable, true); assert.equal(result.live, true); assert.deepEqual(result.quality, { width: 1920, height: 1080, source: 'bitstream' });
});

test('truncated and oversized-exponent SPS omit unknown dimensions without looping or reading outside the bounded sample', async () => {
  for (const nal of [Buffer.from('67640029ac', 'hex'), Buffer.concat([Buffer.from('6742001f', 'hex'), Buffer.alloc(64)]), Buffer.from('67ffffffffffff', 'hex')]) {
    const service = createPlayability({ request: async url => url.includes('.m3u8') ? response(manifest('part.ts')) : response(transportWithSps(nal), 206, { 'content-type': 'video/mp2t' }) });
    const result = await service.check(episode()); assert.equal(result.playable, true); assert.equal(result.quality, undefined);
  }
});

test('explicit audio-only renditions cannot outrank real HEVC or unknown-codec video and an audio-only master is rejected', async () => {
  for (const codecs of ['CODECS="hvc1.1.6.L120"', '']) {
    const calls = [], master = `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS="mp4a.40.2"\naudio.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080${codecs ? ',' + codecs : ''}\nvideo.m3u8\n`;
    const service = createPlayability({ request: async url => { calls.push(url); return url.endsWith('/master.m3u8') ? response(master) : url.endsWith('/video.m3u8') ? response(manifest('video.ts')) : response(ts, 206, { 'content-type': 'video/mp2t' }); } });
    const result = await service.check(episode('https://cdn.example/master.m3u8'));
    assert.equal(result.playable, true); assert.equal(result.quality.height, 1080); assert.ok(result.playbackUrl.endsWith('/video.m3u8')); assert.equal(calls.some(url => url.includes('audio.m3u8')), false);
  }
  const service = createPlayability({ request: async () => response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS="mp4a.40.2,ec-3"\naudio.m3u8\n') });
  const result = await service.check(episode()); assert.equal(result.playable, false); assert.match(result.error, /视频分支/);
});
