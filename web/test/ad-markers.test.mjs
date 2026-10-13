import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { gzipSync } from 'node:zlib';
import { setImmediate as turn } from 'node:timers/promises';
import { createAdMarkers } from '../lib/ad-markers.mjs';
import { createRequest } from '../lib/network.mjs';

const url = 'https://media.example/movie.m3u8?auth=hello%2Bworld&id=3';
const episode = { type: 'hls', url };
const segment = (duration, name = 'a') => '#EXTINF:' + duration + ',\n' + name + '.ts';
const vod = (...lines) => ['#EXTM3U', '#EXT-X-PLAYLIST-TYPE:VOD', ...lines, '#EXT-X-ENDLIST'].join('\n');
const cue = vod(segment(10), '#EXT-X-CUE-OUT:5', segment(5, 'ad'), '#EXT-X-CUE-IN', segment(10, 'b'));
const dateTag = attrs => '#EXT-X-DATERANGE:' + attrs;
const pdt = '#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:00Z';
function response(body, { status = 200, headers = {}, finalUrl } = {}) {
  return Object.assign(Readable.from([Buffer.isBuffer(body) ? body : Buffer.from(body)]), { statusCode: status, headers, finalUrl });
}
function fixture(text) {
  const calls = [], service = createAdMarkers({ request: async (value, options) => { calls.push({ value, options }); return response(text); } });
  return { calls, service };
}
const noRanges = result => { assert.equal(result.supported, false); assert.deepEqual(result.ranges, []); assert.equal(typeof result.reason, 'string'); };

test('closed CUE boundaries produce absolute source positions and a stable evidence contract', async () => {
  for (const declaration of ['#EXT-X-CUE-OUT:5', '#EXT-X-CUE-OUT:DURATION=5.0', '#EXT-X-CUE-OUT']) {
    const { service, calls } = fixture(cue.replace('#EXT-X-CUE-OUT:5', declaration));
    const result = await service.inspect(episode);
    assert.deepEqual(result, { ranges: [{ start: 10, end: 15, kind: 'cue' }], supported: true, label: 'HLS 明确广告标记', source: 'hls-markers' });
    assert.equal(calls[0].value, url); assert.ok(calls[0].options.timeout <= 8000);
  }
});

test('plain discontinuities, media names and metadata do not identify advertising', async () => {
  for (const text of [vod(segment(10, 'HAPPYTV-ad'), '#EXT-X-DISCONTINUITY', segment(10, 'movie')), vod(dateTag('ID="chapter",CLASS="chapter",START-DATE="2026-01-01T00:00:00Z",DURATION=5'), segment(10))]) noRanges(await fixture(text).service.inspect(episode));
});

test('live, EVENT, MP4, page and explicitly live episodes are unsupported without fetching unrelated assets', async () => {
  for (const value of [{ ...episode, type: 'mp4' }, { ...episode, type: 'page' }, { ...episode, type: 'livestream' }, { ...episode, live: true }, { ...episode, isLive: true }]) {
    const { service, calls } = fixture(cue); noRanges(await service.inspect(value)); assert.equal(calls.length, 0);
  }
  for (const text of [cue.replace('\n#EXT-X-ENDLIST', ''), cue.replace('PLAYLIST-TYPE:VOD', 'PLAYLIST-TYPE:EVENT')]) noRanges(await fixture(text).service.inspect(episode));
});

test('unclosed, nested, orphaned, malformed and inconsistent CUE markers fail closed', async () => {
  const texts = [
    cue.replace('#EXT-X-CUE-IN', ''), cue.replace('#EXT-X-CUE-OUT:5', ''), cue.replace('#EXT-X-CUE-OUT:5', '#EXT-X-CUE-OUT:5\n#EXT-X-CUE-OUT:5'),
    cue.replace('CUE-OUT:5', 'CUE-OUT:6'), cue.replace('CUE-OUT:5', 'CUE-OUT:-5'), cue.replace('CUE-OUT:5', 'CUE-OUT:Infinity'), cue.replace('CUE-OUT:5', 'CUE-OUT:'),
    vod('#EXT-X-CUE-OUT-CONT:ElapsedTime=5,Duration=10', segment(10)), vod('#EXT-X-CUE-OUT:601', segment(601), '#EXT-X-CUE-IN'),
    vod('#EXT-X-CUE-OUT', '#EXT-X-CUE-IN', segment(10)), cue.replace('#EXTINF:5,', '#EXTINF:NaN,'), cue.replace('ad.ts', ''),
    vod('#EXT-X-CUE-OUT:5', segment(5), '#EXT-X-CUE-IN', segment(86400)), cue.replace('#EXT-X-CUE-OUT:5', '#EXT-X-CUE-OUT:DURATION=5,DURATION=5'),
    cue.replace(segment(5, 'ad'), '#EXT-X-CUE-OUT-CONT:ElapsedTime=2,Duration=5\n' + segment(5, 'ad')),
    cue.replace(segment(5, 'ad'), '#EXT-X-CUE-OUT-CONT:ElapsedTime=0,Duration=Infinity\n' + segment(5, 'ad')),
    cue.replace(segment(5, 'ad'), '#EXT-X-CUE-OUT-CONT:0/5/10\n' + segment(5, 'ad')),
  ];
  for (const text of texts) noRanges(await fixture(text).service.inspect(episode));
});

test('CUE continuation tags inside a complete closed range do not change its boundaries', async () => {
  for (const declaration of ['#EXT-X-CUE-OUT-CONT:ElapsedTime=0,Duration=5', '#EXT-X-CUE-OUT-CONT:0/5']) {
    const text = cue.replace(segment(5, 'ad'), declaration + '\n' + segment(5, 'ad'));
    assert.deepEqual((await fixture(text).service.inspect(episode)).ranges, [{ start: 10, end: 15, kind: 'cue' }]);
  }
});

test('advertisement DATERANGE requires actual closure and consistent PDT alignment', async () => {
  for (const declaration of [
    'ID="ad",CLASS="advertisement",START-DATE="2026-01-01T00:00:10Z",END-DATE="2026-01-01T00:00:15Z"',
    'ID="ad",SCTE35-OUT=0xF,START-DATE="2026-01-01T00:00:10Z",DURATION=5',
    'ID="ad",CLASS="ads",START-DATE="2026-01-01T00:00:10Z",DURATION=5,END-DATE="2026-01-01T00:00:15Z"',
  ]) {
    const result = await fixture(vod(pdt, dateTag(declaration), segment(10), '#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:10Z', segment(15, 'b'))).service.inspect(episode);
    assert.equal(result.supported, true); assert.deepEqual(result.ranges, [{ start: 10, end: 15, kind: 'daterange' }]);
  }
});

test('paired SCTE35 date tags close at the cue-in segment boundary without parsing payloads', async () => {
  const text = vod(pdt, segment(10), dateTag('ID="ad",SCTE35-OUT=0xF,START-DATE="2026-01-01T00:00:10Z"'), segment(5, 'ad'), dateTag('ID="ad",SCTE35-IN=0xA,START-DATE="2026-01-01T00:00:10Z"'), segment(10, 'b'));
  assert.deepEqual((await fixture(text).service.inspect(episode)).ranges, [{ start: 10, end: 15, kind: 'daterange' }]);
  const repeated = text.replace(segment(10, 'b'), segment(5, 'b') + '\n' + dateTag('ID="ad",SCTE35-IN=0xA,START-DATE="2026-01-01T00:00:10Z"') + '\n' + segment(5, 'c'));
  assert.deepEqual((await fixture(repeated).service.inspect(episode)).ranges, [{ start: 10, end: 15, kind: 'daterange' }]);
});

test('unreliable date ranges, incomplete updates and contradictory dates produce no skip ranges', async () => {
  const attrs = 'ID="ad",CLASS="ad",START-DATE="2026-01-01T00:00:10Z",DURATION=5';
  const texts = [
    vod(dateTag(attrs), segment(25)), vod(pdt, dateTag(attrs.replace('DURATION=5', 'PLANNED-DURATION=5')), segment(25)),
    vod(pdt, dateTag(attrs + ',END-DATE="2026-01-01T00:00:20Z"'), segment(25)), vod(pdt, dateTag(attrs.replace('DURATION=5', 'DURATION=601')), segment(700)),
    vod(pdt, dateTag(attrs.replace('00:00:10Z', '00:00:24Z')), segment(25)), vod(pdt, dateTag(attrs.replace('2026-01-01T00:00:10Z', '2026-02-30T00:00:10Z')), segment(25)),
    vod(pdt, dateTag(attrs), segment(10), '#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:10:10Z', segment(15, 'b')),
    vod(pdt, dateTag(attrs), dateTag(attrs.replace('DURATION=5', 'DURATION=6')), segment(25)),
    vod(pdt, dateTag(attrs + ',END-ON-NEXT=YES'), segment(25)), vod(pdt, dateTag(attrs.replace('DURATION=5', 'DURATION=0')), segment(25)),
    vod(pdt, dateTag(attrs.replace('CLASS="ad"', 'SCTE35-OUT=not-hex')), segment(25)),
    vod(pdt, dateTag(attrs.replace('00:00:10Z', '24:00:00Z')), segment(25)),
    vod(pdt, dateTag(attrs), '#EXT-X-GAP', segment(25)),
  ];
  for (const text of texts) noRanges(await fixture(text).service.inspect(episode));
});

test('Apple separate interstitial assets are never converted into primary movie ranges or fetched', async () => {
  const text = vod(pdt, dateTag('ID="ad",CLASS="com.apple.hls.interstitial",START-DATE="2026-01-01T00:00:10Z",DURATION=5,X-RESUME-OFFSET=0,X-ASSET-URI="http://127.0.0.1/ads.m3u8"'), segment(25));
  const { service, calls } = fixture(text); noRanges(await service.inspect(episode)); assert.equal(calls.length, 1);
});

test('overlapping reliable ranges merge while gaps remain and limits stay conservative', async () => {
  const tag = (id, start, end) => dateTag('ID="' + id + '",CLASS="ad",START-DATE="2026-01-01T00:00:' + String(start).padStart(2, '0') + 'Z",END-DATE="2026-01-01T00:00:' + String(end).padStart(2, '0') + 'Z"');
  const result = await fixture(vod(pdt, tag('a', 2, 8), tag('b', 6, 10), tag('c', 12, 15), segment(30))).service.inspect(episode);
  assert.deepEqual(result.ranges, [{ start: 2, end: 10, kind: 'daterange' }, { start: 12, end: 15, kind: 'daterange' }]);
  const many = Array.from({ length: 21 }, (_, i) => ['#EXT-X-CUE-OUT:1', segment(1, 'ad' + i), '#EXT-X-CUE-IN', segment(1, 'movie' + i)]).flat();
  noRanges(await fixture(vod(...many)).service.inspect(episode));
});

test('master inspection chooses video and preserves explicit child signatures and redirect bases', async () => {
  const calls = [], finalBase = 'https://other.example/path/master.m3u8?old=master';
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000,CODECS="mp4a.40.2"\naudio.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"\n../video.m3u8?sig=A%2BB&expires=22\n';
  const service = createAdMarkers({ request: async value => { calls.push(value); return response(value === url ? master : cue, value === url ? { finalUrl: finalBase } : {}); } });
  assert.equal((await service.inspect(episode)).supported, true);
  assert.deepEqual(calls, [url, 'https://other.example/video.m3u8?sig=A%2BB&expires=22']);
});

test('all-audio masters, cyclic masters and more than three master layers are rejected', async () => {
  const audio = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS="mp4a.40.2"\naudio.m3u8';
  noRanges(await fixture(audio).service.inspect(episode));
  const loop = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\n' + url;
  const { service, calls } = fixture(loop); noRanges(await service.inspect(episode)); assert.equal(calls.length, 1);
  let count = 0;
  const deep = createAdMarkers({ request: async () => response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nlevel' + (++count) + '.m3u8') });
  noRanges(await deep.inspect(episode)); assert.equal(count, 4);
});

test('three master layers and an unknown video codec remain supported within four playlist requests', async () => {
  let count = 0;
  const service = createAdMarkers({ request: async () => response(++count < 4 ? '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nlevel' + count + '.m3u8?sig=keep%2Bvalue' : cue) });
  assert.deepEqual((await service.inspect(episode)).ranges, [{ start: 10, end: 15, kind: 'cue' }]); assert.equal(count, 4);
});

test('initial, child and redirect private or unsupported URLs cannot be fetched', async () => {
  for (const value of ['http://127.0.0.1/a.m3u8', 'http://10.0.0.5/a.m3u8', 'http://[::1]/a.m3u8', 'file:///tmp/a.m3u8', 'https://user:pass@media.example/a.m3u8']) {
    const { service, calls } = fixture(cue); noRanges(await service.inspect({ type: 'hls', url: value })); assert.equal(calls.length, 0);
  }
  for (const child of ['http://192.168.1.2/a.m3u8', 'file:///tmp/a.m3u8']) {
    const { service, calls } = fixture('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000\n' + child); noRanges(await service.inspect(episode)); assert.equal(calls.length, 1);
  }
  const redirected = response(cue, { finalUrl: 'http://127.0.0.1/a.m3u8' });
  noRanges(await createAdMarkers({ request: async () => redirected }).inspect(episode)); assert.equal(redirected.destroyed, true);
});

test('safe network still blocks private DNS targets and public-to-private HTTP redirects', async () => {
  let transports = 0;
  const forbiddenTransport = () => { transports++; throw new Error('private transport must not run'); };
  const privateDns = createRequest({ lookup: async () => [{ address: '10.0.0.8', family: 4 }], httpsRequest: forbiddenTransport });
  noRanges(await createAdMarkers({ request: privateDns }).inspect(episode)); assert.equal(transports, 0);
  const redirectTransport = (_url, _options, callback) => {
    transports++; const outgoing = new EventEmitter();
    outgoing.end = () => queueMicrotask(() => { const value = response('', { status: 302, headers: { location: 'http://127.0.0.1/private' } }); callback(value); outgoing.emit('response', value); });
    outgoing.destroy = error => outgoing.emit('error', error);
    return outgoing;
  };
  const redirects = createRequest({ lookup: async () => [{ address: '93.184.216.34', family: 4 }], httpsRequest: redirectTransport });
  noRanges(await createAdMarkers({ request: redirects }).inspect(episode)); assert.equal(transports, 1);
});

test('HTTP errors, HTML, malformed manifests and oversized compressed playlists fail without affecting playback', async () => {
  for (const value of [response('upstream failed', { status: 403 }), response(cue, { status: 206 }), response('<html>challenge</html>'), response('not HLS'), response(gzipSync(Buffer.alloc(1024 * 1024 + 1, 65)), { headers: { 'content-encoding': 'gzip' } })]) {
    noRanges(await createAdMarkers({ request: async () => value }).inspect(episode)); assert.equal(value.destroyed, true);
  }
});

test('one eight-second deadline covers late headers and closes the eventual response', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
  let finish; const gate = new Promise(resolve => { finish = resolve; });
  const service = createAdMarkers({ request: async () => gate });
  const pending = service.inspect(episode); await turn(); t.mock.timers.tick(8000);
  const result = await pending; noRanges(result); assert.match(result.reason, /8秒/);
  const late = response(cue); finish(late); await turn(); assert.equal(late.destroyed, true);
});

test('the same deadline stops a stalled body and queued work, then releases both slots', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
  const stalled = [], calls = [];
  let ready = false;
  const service = createAdMarkers({ request: async value => { calls.push(value); if (ready) return response(cue); const stream = Object.assign(new Readable({ read() {} }), { statusCode: 200, headers: {} }); stalled.push(stream); return stream; } });
  const pending = [0, 1, 2].map(i => service.inspect({ type: 'hls', url: 'https://media.example/' + i + '.m3u8' }));
  await turn(); assert.equal(calls.length, 2); t.mock.timers.tick(8000);
  for (const result of await Promise.all(pending)) noRanges(result);
  assert.equal(calls.length, 2); assert.ok(stalled.every(stream => stream.destroyed));
  ready = true; assert.equal((await service.inspect({ type: 'hls', url: 'https://media.example/new.m3u8' })).supported, true);
});

test('singleflight, two slots and defensive cache copies avoid duplicate work or mutable evidence', async () => {
  let finish, active = 0, maximum = 0, count = 0, clock = 0;
  const gate = new Promise(resolve => { finish = resolve; });
  const service = createAdMarkers({ now: () => clock, request: async () => { count++; active++; maximum = Math.max(maximum, active); await gate; active--; return response(cue); } });
  const first = service.inspect(episode), same = service.inspect(episode), second = service.inspect({ ...episode, url: 'https://media.example/second.m3u8' }), third = service.inspect({ ...episode, url: 'https://media.example/third.m3u8' });
  await turn(); assert.equal(count, 2); finish();
  const results = await Promise.all([first, same, second, third]); assert.equal(maximum, 2); assert.equal(count, 3);
  results[0].ranges[0].end = 999; assert.equal((await service.inspect(episode)).ranges[0].end, 15);
  clock = 60001; assert.equal((await service.inspect(episode)).supported, true); assert.equal(count, 4);
});

test('short failure cache and the 64-item cache limit allow bounded rechecks', async () => {
  let clock = 0, count = 0;
  const service = createAdMarkers({ now: () => clock, request: async () => { count++; return response(vod(segment(10))); } });
  noRanges(await service.inspect(episode)); noRanges(await service.inspect(episode)); assert.equal(count, 1);
  clock = 10001; noRanges(await service.inspect(episode)); assert.equal(count, 2);
  for (let i = 0; i < 64; i++) await service.inspect({ type: 'hls', url: 'https://media.example/cache' + i + '.m3u8' });
  noRanges(await service.inspect(episode)); assert.equal(count, 67);
});
