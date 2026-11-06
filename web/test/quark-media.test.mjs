import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable, PassThrough } from 'node:stream';
import { createQuarkMedia } from '../lib/quark-media.mjs';

const descriptor = (extra = {}) => ({
  headers: { cookie: '__puus=account-secret', 'user-agent': 'Official-web-agent', referer: 'https://pan.quark.cn/', authorization: 'do-not-forward' },
  allowCookieOrigins: ['https://video.quark.cn'], metadata: { name: '影片', category: 'movie', version: 'stable-v1' }, ...extra,
  episode: { type: 'hls', url: 'https://video.quark.cn/main.m3u8?sign=keep', colorSpace: 'sdr', ...extra.episode } });
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

test('publishes an adaptive master without disclosing upstream links or account credentials', async t => {
  const variants = [
    { type: 'hls', colorSpace: 'sdr', url: 'https://video.quark.cn/720.m3u8?sign=720-secret', width: 1280, height: 720, bandwidth: 3000000 },
    { type: 'hls', colorSpace: 'sdr', url: 'https://video.quark.cn/1080.m3u8?sign=1080-secret', width: 1920, height: 1080, bandwidth: 6000000 },
    { type: 'hls', colorSpace: 'sdr', url: 'https://video.quark.cn/2160.m3u8?sign=2160-secret', width: 3840, height: 2160, bandwidth: 18000000 },
  ];
  const { cloud, calls, base } = await fixture(t, { quark: { playback: async () => descriptor({ variants: [...variants, variants[0]], qualityOptions: variants.map(row => ({ ...row, label: `${row.height}p` })) }) } });
  const lease = await cloud.playback('asset');
  assert.equal(lease.response.quality, '自动画质');
  const response = await fetch(base + lease.response.url), master = await response.text();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/vnd.apple.mpegurl; charset=utf-8');
  assert.ok(master.startsWith('#EXTM3U\n'));
  assert.equal(calls.length, 0, 'Generating the master must not fetch every quality');
  assert.ok(!master.includes('video.quark.cn') && !master.includes('secret'));
  assert.match(master, /BANDWIDTH=6000000,RESOLUTION=1920x1080/);
  const children = master.split('\n').filter(line => line.startsWith('/api/quark/media/'));
  assert.equal(children.length, 3, 'Duplicate upstream qualities are omitted');
  assert.ok(children.every(url => url.startsWith(lease.proxyPath + '?token=')));
  assert.deepEqual(children, lease.response.qualityOptions.map(row => row.url), 'manual HLS qualities reuse the master selectors');
  assert.equal((await fetch(base + children[1])).status, 200);
  assert.equal(calls[0].url, variants[1].url);
  assert.equal(calls[0].headers.cookie, '__puus=account-secret');
  const head = await fetch(base + lease.response.url, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  cloud.invalidate();
  assert.equal((await fetch(base + lease.response.url)).status, 403);
  assert.equal((await fetch(base + children[0])).status, 403);
});

test('manual official qualities use the current signed lease for MP4 and unmarked HLS', async t => {
  const options = [
    { type: 'mp4', url: 'https://video.quark.cn/4k.mp4?sign=private', colorSpace: 'unknown', width: 3840, height: 2160, label: '4K 2160p', videoCodec: 'hvc1.1.6.L153.B0', audioCodec: 'mp4a.40.2' },
    { type: 'hls', url: 'https://cdn.example/1080.m3u8?sign=private', colorSpace: 'unknown', width: 1920, height: 1080, label: '超清 1080p' },
    { type: 'mp4', url: 'https://video.quark.cn/low.mp4', colorSpace: 'unknown', label: '流畅' },
  ];
  let probes = 0;
  const f = await fixture(t, { quark: { playback: async () => descriptor({ episode: { type: 'hls', url: options[1].url, colorSpace: 'unknown' }, metadata: { sourceColorSpace: 'sdr' }, qualityOptions: options }) }, probeColor: async () => { probes++; throw new Error('ordinary sources must not probe'); } });
  const lease = await f.cloud.playback('asset', { owner: 'household' });
  assert.equal(probes, 0); assert.equal(lease.response.type, 'hls');
  assert.equal(lease.response.qualityOptions[0].videoCodec, 'hvc1.1.6.L153.B0');
  assert.equal(lease.response.qualityOptions[0].audioCodec, 'mp4a.40.2');
  assert.deepEqual(lease.response.qualityOptions.map(({ id, label, type }) => ({ id, label, type })), [
    { id: 'q0', label: '4K 2160p', type: 'mp4' }, { id: 'q1', label: '超清 1080p', type: 'hls' }, { id: 'q2', label: '流畅', type: 'mp4' },
  ]);
  assert.doesNotMatch(JSON.stringify(lease.response), /video\.quark\.cn|cdn\.example|account-secret|private/);
  for (const option of lease.response.qualityOptions) {
    assert.match(option.url, new RegExp(`^/api/quark/media/${lease.id}\\?token=q[0-7]$`));
    assert.equal((await fetch(f.base + option.url, { headers: { cookie: 'browser-secret', authorization: 'browser-secret' } })).status, 200);
  }
  assert.equal(lease.response.url, lease.response.qualityOptions[1].url, 'the selected 1080p default matches its own option rather than the first 4K option');
  assert.equal(f.calls[0].headers.cookie, '__puus=account-secret');
  assert.equal(f.calls[0].headers.authorization, undefined);
  assert.equal(f.calls.find(call => call.url.includes('cdn.example')).headers.cookie, undefined);
  const signed = lease.response.qualityOptions[0].url;
  assert.equal((await fetch(f.base + signed.replace(/token=./, 'token=x'))).status, 403);
  f.cloud.revoke('household'); assert.equal((await fetch(f.base + signed)).status, 403);
});

test('manual official qualities cannot bypass known Dolby color protection', async t => {
  const safe = { type: 'hls', url: 'https://video.quark.cn/sdr.m3u8', colorSpace: 'sdr', label: '超清 1080p', width: 1920, height: 1080 };
  const hidden = ['unknown', 'pq', 'hlg', 'dolby-vision'].map((colorSpace, index) => ({ type: 'mp4', url: `https://video.quark.cn/unsafe-${index}.mp4`, colorSpace, label: '4K', width: 3840, height: 2160 }));
  const f = await fixture(t, { quark: { playback: async () => descriptor({ episode: safe, metadata: { sourceColorSpace: 'dolby-vision' }, qualityOptions: [safe, ...hidden] }) } });
  const lease = await f.cloud.playback('asset');
  assert.deepEqual(lease.response.qualityOptions.map(row => row.label), ['超清 1080p']);
});

test('manual official qualities reject invalid lists before media reads and expire with household authorization', async t => {
  const safe = { type: 'mp4', url: 'https://video.quark.cn/sdr.mp4', colorSpace: 'sdr', label: '超清', width: 1920, height: 1080 };
  let reads = 0;
  for (const qualityOptions of [Array(9).fill(safe), [{ ...safe, url: 'http://127.0.0.1/private.mp4' }], [{ ...safe, type: 'page' }], [{ ...safe, label: 'bad\r\nheader' }], [{ ...safe, width: undefined }], [{ ...safe, height: 4321 }], [{ ...safe, colorSpace: 'unverified' }], [{ ...safe, videoCodec: 'bad\r\ncodec' }]]) {
    const cloud = createQuarkMedia({ quark: { playback: async () => descriptor({ qualityOptions }) }, request: async () => { reads++; throw new Error('invalid options must not fetch'); } });
    await assert.rejects(cloud.playback('asset'));
    cloud.invalidate();
  }
  assert.equal(reads, 0);
  let authorized = true;
  const f = await fixture(t, { quark: { playback: async () => descriptor({ qualityOptions: [safe] }) } });
  const lease = await f.cloud.playback('asset', { valid: () => authorized });
  assert.equal((await fetch(f.base + lease.response.qualityOptions[0].url)).status, 200);
  authorized = false;
  assert.equal((await fetch(f.base + lease.response.qualityOptions[0].url)).status, 403);
  assert.equal(f.calls.length, 1, 'a revoked quality never reaches the upstream media');
});

test('manual and adaptive official origins retain exact credentials within a bounded list', async t => {
  const variants = Array.from({ length: 8 }, (_, index) => ({ type: 'hls', colorSpace: 'sdr', url: `https://adaptive-${index}.quark.cn/video.m3u8`, width: 1280, height: 240 + index * 120, bandwidth: 3000000 }));
  const qualityOptions = Array.from({ length: 8 }, (_, index) => ({ type: 'mp4', colorSpace: 'sdr', url: `https://manual-${index}.quark.cn/video.mp4`, label: `${240 + index * 120}p`, width: 1280, height: 240 + index * 120 }));
  const allowCookieOrigins = ['https://video.quark.cn', ...qualityOptions.map(row => new URL(row.url).origin), ...variants.map(row => new URL(row.url).origin)];
  const f = await fixture(t, { quark: { playback: async () => descriptor({ variants, qualityOptions, allowCookieOrigins }) } });
  const lease = await f.cloud.playback('asset');
  const master = await (await fetch(f.base + lease.response.url)).text();
  const children = master.split('\n').filter(row => row.startsWith('/api/quark/media/'));
  assert.equal((await fetch(f.base + children.at(-1))).status, 200);
  assert.equal(f.calls.at(-1).headers.cookie, '__puus=account-secret', 'a valid adaptive origin after the first ten keeps its own account headers');
  assert.equal((await fetch(f.base + lease.response.qualityOptions.at(-1).url)).status, 200);
  assert.equal(f.calls.at(-1).headers.cookie, '__puus=account-secret');
  const cloud = createQuarkMedia({ quark: { playback: async () => descriptor({ allowCookieOrigins: Array.from({ length: 26 }, (_, index) => `https://v${index}.quark.cn`) }) } });
  await assert.rejects(cloud.playback('asset'), /凭证目标列表/); cloud.invalidate();
});

test('compatibility input quality selects real official source heights without probing or creating adaptive input', async t => {
  const qualityOptions = [
    { type: 'mp4', colorSpace: 'sdr', url: 'https://video.quark.cn/4k.mp4', label: '4K 2160p', width: 3840, height: 2160, videoCodec: 'hevc', audioCodec: 'aac' },
    { type: 'hls', colorSpace: 'sdr', url: 'https://video.quark.cn/1080.m3u8', label: '超清 1080p', width: 1920, height: 1080 },
    { type: 'hls', colorSpace: 'sdr', url: 'https://video.quark.cn/720.m3u8', label: '高清 720p', width: 1280, height: 720 },
  ];
  const variants = qualityOptions.slice(1).map(row => ({ ...row, bandwidth: 3000000 }));
  let lookups = 0, probes = 0;
  const f = await fixture(t, { quark: { playback: async () => { lookups++; return descriptor({ episode: qualityOptions[1], metadata: { sourceColorSpace: 'sdr' }, variants, qualityOptions }); } }, probeColor: async () => { probes++; throw new Error('ordinary source must not probe'); } });
  const ordinary = await f.cloud.playback('asset');
  assert.equal(ordinary.episode.url, qualityOptions[1].url); assert.equal(ordinary.response.quality, '自动画质');
  for (const quality of [720, 1080, 2160]) {
    const lease = await f.cloud.playback('asset', { quality });
    assert.equal(lease.episode.height, quality);
    assert.equal(lease.episode.url, qualityOptions.find(row => row.height === quality).url);
    assert.equal(lease.master, undefined, 'an explicit compatibility input never falls back through a lower ABR level');
    assert.equal(lease.response.url, lease.response.qualityOptions.find(row => row.height === quality).url);
  }
  assert.equal(lookups, 4); assert.equal(probes, 0); assert.equal(f.calls.length, 0);
  const only1080 = await fixture(t, { quark: { playback: async () => descriptor({ episode: qualityOptions[1], qualityOptions: [qualityOptions[1]] }) } });
  for (const quality of [720, 2160]) assert.equal((await only1080.cloud.playback('asset', { quality })).episode.height, 1080, 'the smallest actual source above a low cap and the only source below 4K both stay 1080p');
});

test('compatibility input quality never overrides the existing Dolby color decision', async t => {
  const safe = { type: 'hls', colorSpace: 'sdr', url: 'https://video.quark.cn/1080.m3u8', label: '超清', width: 1920, height: 1080 };
  const unverified = { type: 'mp4', colorSpace: 'unknown', url: 'https://video.quark.cn/4k.mp4', label: '4K', width: 3840, height: 2160, videoCodec: 'hevc', audioCodec: 'aac' };
  let probes = 0;
  const f = await fixture(t, { quark: { playback: async () => descriptor({ episode: safe, metadata: { sourceColorSpace: 'dolby-vision' }, qualityOptions: [unverified, safe] }) }, probeColor: async () => { probes++; throw new Error('verified SDR remains sufficient'); } });
  const lease = await f.cloud.playback('asset', { quality: 2160 });
  assert.equal(lease.episode.url, safe.url);
  assert.deepEqual(lease.response.qualityOptions.map(row => row.url), [lease.response.url]);
  assert.equal(probes, 0);
});

test('compatibility input quality rejects unsupported values before account lookup', async () => {
  let lookups = 0;
  const cloud = createQuarkMedia({ quark: { playback: async () => { lookups++; return descriptor(); } } });
  for (const quality of [null, '2160', 480, 0, Infinity]) await assert.rejects(cloud.playback('asset', { quality }), error => error.status === 400);
  assert.equal(lookups, 0); cloud.invalidate();
});

test('ordinary SDR, unknown and HDR Vivid HLS, MP4 and WebM play directly without color inspection', async t => {
  for (const type of ['hls', 'mp4', 'webm']) for (const colorSpace of [undefined, 'unknown', 'sdr', 'pq', 'hlg', 'hdr', 'browser-default']) {
    const { cloud, calls } = await fixture(t, { quark: { playback: async () => descriptor({ episode: { type, url: `https://video.quark.cn/movie.${type}`, colorSpace }, metadata: { sourceColorSpace: colorSpace === 'browser-default' ? 'unknown' : colorSpace, name: '2026.2160p.WEB-DL.AAC.HDR.Vivid.60FPS.H.265-FGTWeb.mp4' } }) },
      probeColor: async () => assert.fail('non-Dolby playback must not inspect or calibrate colors') });
    const lease = await cloud.playback('asset');
    assert.equal(lease.episode.colorSpace, colorSpace);
    assert.equal(lease.response.colorSpace, colorSpace);
    assert.equal(lease.response.requiresCompatibility, false);
    assert.equal(lease.colorProbe, undefined);
    assert.equal(lease.episode.sourceColorSpace, colorSpace === 'browser-default' || colorSpace === undefined ? 'unknown' : colorSpace);
    assert.equal(Object.hasOwn(lease.response, 'sourceColorSpace'), false);
    assert.equal(calls.length, 0);
    assert.ok(!JSON.stringify(lease.response).includes('account-secret'));
  }
  const vivid = await fixture(t, { quark: { playback: async () => descriptor({ episode: { type: 'mp4', colorSpace: 'unknown' }, metadata: { sourceColorSpace: 'hdr' } }) }, probeColor: async () => assert.fail('an HDR Vivid filename is not Dolby evidence') });
  const vividLease = await vivid.cloud.playback('vivid');
  assert.equal(vividLease.response.colorSpace, 'unknown'); assert.equal(vividLease.response.requiresCompatibility, false);
  const cloud = createQuarkMedia({ quark: { playback: async () => descriptor({ episode: { type: 'mp4', url: 'https://video.quark.cn/movie.mp4', colorSpace: 'untrusted color hint' } }) } });
  await assert.rejects(cloud.playback('asset'), /色彩信息无效/);
});

test('non-Dolby unsupported containers request compatibility for their format without probing color', async t => {
  for (const type of ['mkv', 'avi', 'mpegts']) {
    const { cloud } = await fixture(t, { quark: { playback: async () => descriptor({ episode: { type, colorSpace: 'hdr' }, metadata: { sourceColorSpace: 'hdr' } }) }, probeColor: async () => assert.fail('container compatibility does not require Dolby inspection') });
    const lease = await cloud.playback('asset');
    assert.equal(lease.response.requiresCompatibility, true); assert.equal(lease.response.colorSpace, 'hdr'); assert.equal(lease.colorProbe, undefined);
    assert.equal(lease.episode.sourceColorSpace, 'hdr'); assert.equal(Object.hasOwn(lease.response, 'sourceColorSpace'), false);
  }
});

test('non-Dolby playback preserves its selected source even when an SDR alternative uses an unsupported container', async t => {
  for (const colorSpace of ['unknown', 'hdr', 'pq']) {
    const primary = { type: 'mp4', url: 'https://video.quark.cn/selected.mp4', colorSpace };
    const alternative = { type: 'mkv', url: 'https://video.quark.cn/alternative.mkv', colorSpace: 'sdr' };
    const { cloud } = await fixture(t, { quark: { playback: async () => descriptor({ episode: primary, candidates: [alternative], metadata: { sourceColorSpace: colorSpace } }) }, probeColor: async () => assert.fail('ordinary playback must preserve the selected stream') });
    const lease = await cloud.playback('asset');
    assert.equal(lease.episode.url, primary.url); assert.equal(lease.response.type, 'mp4'); assert.equal(lease.response.colorSpace, colorSpace);
    assert.equal(lease.response.requiresCompatibility, false); assert.equal(lease.colorProbe, undefined);
  }
});

test('known Dolby source alternatives are decoded-color checked and cached by actual source identity', async t => {
  let probes = 0, clock = 100, revision = 'one';
  const { cloud, calls } = await fixture(t, { now: () => clock,
    quark: { playback: async () => descriptor({ episode: { colorSpace: undefined }, metadata: { sourceColorSpace: 'dolby-vision', version: revision, requiresCompatibility: true } }) },
    probeColor: async input => {
      probes++; assert.ok(input.timeout > 0 && input.timeout <= 6000); assert.equal(input.valid(), true);
      assert.match(input.proxyPath, /^\/api\/quark\/media\/[a-f0-9]{32}$/); assert.equal(typeof input.mediaOverride.serve, 'function');
      return { colorSpace: 'sdr', codec: 'h264', transfer: 'bt709', primaries: 'bt709', matrix: 'bt709' };
    } });
  const lease = await cloud.playback('asset', { owner: 'one' });
  assert.equal(probes, 1); assert.equal(lease.response.colorSpace, 'sdr'); assert.equal(lease.response.requiresCompatibility, false);
  assert.equal(lease.colorProbe.transfer, 'bt709'); assert.equal(calls.length, 0);
  await cloud.playback('asset', { owner: 'two' }); assert.equal(probes, 1, 'same signed stream can reuse verified metadata');
  revision = 'two'; await cloud.playback('asset'); assert.equal(probes, 2, 'a changed stream version must be rechecked');
  await cloud.playback('other-asset'); assert.equal(probes, 3, 'another asset cannot borrow color proof');
  clock += 600001; await cloud.playback('asset'); assert.equal(probes, 4, 'expired color proof must be rechecked');
  cloud.invalidate(); await cloud.playback('asset'); assert.equal(probes, 5, 'account/config invalidation clears the proof cache');
});

test('actual SDR alternatives beat unmarked DV/PQ and unknown variants cannot leak back through adaptive playback', async t => {
  const first = { type: 'hls', url: 'https://video.quark.cn/high.m3u8', colorSpace: 'unknown', width: 1920, height: 1080, bandwidth: 6000000 };
  const second = { ...first, url: 'https://video.quark.cn/low.m3u8', width: 1280, height: 720 };
  const third = { ...first, url: 'https://video.quark.cn/other.m3u8' };
  for (const detected of ['dolby-vision', 'pq']) {
    const seen = [];
    const { cloud } = await fixture(t, { quark: { playback: async () => descriptor({ episode: first, candidates: [first, second, third], variants: [first, second, third], metadata: { sourceColorSpace: 'dolby-vision' } }) },
      probeColor: async input => { seen.push(input.episode.url); return { colorSpace: input.episode.url === first.url ? detected : 'sdr', transfer: input.episode.url === first.url ? 'smpte2084' : 'bt709' }; } });
    const lease = await cloud.playback('asset');
    assert.deepEqual(seen, [first.url, second.url]); assert.equal(lease.episode.url, second.url);
    assert.equal(lease.response.colorSpace, 'sdr'); assert.equal(lease.response.requiresCompatibility, false); assert.equal(lease.response.quality, '1280×720');
    assert.equal(lease.master, undefined, 'unprobed alternatives must never be added to an SDR master');
    assert.ok(!JSON.stringify(lease.response).includes('video.quark.cn'));
  }
  let probes = 0;
  const { cloud } = await fixture(t, { quark: { playback: async () => descriptor({ episode: first, candidates: [first, { ...second, colorSpace: 'sdr' }], metadata: { sourceColorSpace: 'dolby-vision' } }) }, probeColor: async () => { probes++; throw Error('should not probe explicit SDR'); } });
  assert.equal((await cloud.playback('asset')).episode.url, second.url); assert.equal(probes, 0);
});

test('non-Dolby source hints stay unmodified while a new Dolby declaration requires real proof', async t => {
  const first = { type: 'hls', url: 'https://video.quark.cn/high.m3u8', colorSpace: 'unknown', width: 1920, height: 1080, bandwidth: 6000000 };
  const second = { ...first, url: 'https://video.quark.cn/low.m3u8', width: 1280, height: 720 };
  let sourceColorSpace = 'unknown', probes = 0;
  const proof = { colorSpace: 'browser-default', codec: 'h264', pixFmt: 'yuv420p', bitDepth: 8, transfer: '', primaries: '', matrix: '' };
  const { cloud } = await fixture(t, { quark: { playback: async () => descriptor({ episode: first, candidates: [first, second], variants: [first, second], metadata: { version: 'same-stream', sourceColorSpace } }) },
    probeColor: async input => { probes++; assert.equal(input.sourceColorSpace, sourceColorSpace); return proof; } });
  const lease = await cloud.playback('asset');
  assert.equal(lease.episode.colorSpace, 'unknown'); assert.equal(lease.response.requiresCompatibility, false); assert.equal(lease.response.colorSpace, 'unknown');
  assert.equal(lease.colorProbe, undefined); assert.equal(lease.master, undefined); assert.equal(probes, 0);
  for (const risk of ['sdr', 'hdr', 'pq', 'hlg']) {
    sourceColorSpace = risk;
    const direct = await cloud.playback('asset'); assert.equal(direct.response.colorSpace, 'unknown'); assert.equal(direct.response.requiresCompatibility, false);
  }
  assert.equal(probes, 0, 'ordinary source changes do not add a color probe');
  sourceColorSpace = 'dolby-vision';
  await assert.rejects(cloud.playback('asset'), error => error.status === 409 && error.code === 'QUARK_DOLBY_UNSUPPORTED');
  assert.equal(probes, 2, 'browser defaults cannot prove a known Dolby source is safe');
});

test('verified SDR still beats a browser default and invalid source color declarations fail before a probe', async t => {
  const first = { type: 'hls', url: 'https://video.quark.cn/high.m3u8', colorSpace: 'unknown' }, second = { ...first, url: 'https://video.quark.cn/low.m3u8' };
  const seen = [];
  const { cloud } = await fixture(t, { quark: { playback: async () => descriptor({ episode: first, candidates: [first, second], metadata: { sourceColorSpace: 'dolby-vision' } }) }, probeColor: async input => {
    seen.push(input.episode.url); return input.episode.url === first.url ? { colorSpace: 'browser-default', codec: 'h264', pixFmt: 'yuv420p', bitDepth: 8 } : { colorSpace: 'sdr', transfer: 'bt709' };
  } });
  const lease = await cloud.playback('asset'); assert.equal(lease.episode.url, second.url); assert.equal(lease.response.colorSpace, 'sdr'); assert.equal(seen.length, 2);
  for (const sourceColorSpace of ['browser-default', 'not-a-color']) {
    const f = await fixture(t, { quark: { playback: async () => descriptor({ metadata: { sourceColorSpace } }) }, probeColor: async () => assert.fail('invalid source must not be probed') });
    await assert.rejects(f.cloud.playback('asset'), { status: 502 });
  }
});

test('Dolby evidence on a candidate or variant triggers inspection but an already converted SDR stream plays directly', async t => {
  const first = { type: 'hls', url: 'https://video.quark.cn/main.m3u8', colorSpace: 'unknown' };
  const dolby = { ...first, url: 'https://video.quark.cn/dolby.m3u8', colorSpace: 'dolby-vision', width: 1920, height: 1080, bandwidth: 6000000 };
  for (const location of ['candidates', 'variants']) for (const detected of ['sdr', 'browser-default']) {
    let probes = 0;
    const { cloud } = await fixture(t, { quark: { playback: async () => descriptor({ episode: first, [location]: [dolby] }) }, probeColor: async input => {
      probes++; assert.equal(input.sourceColorSpace, 'dolby-vision'); assert.equal(input.timeout, 6000);
      return { colorSpace: detected, codec: 'h264' };
    } });
    if (detected === 'sdr') {
      const lease = await cloud.playback('asset');
      assert.equal(lease.episode.url, first.url); assert.equal(lease.response.colorSpace, 'sdr'); assert.equal(lease.response.requiresCompatibility, false);
      assert.equal(lease.episode.sourceColorSpace, 'dolby-vision'); assert.equal(Object.hasOwn(lease.response, 'sourceColorSpace'), false);
    } else await assert.rejects(cloud.playback('asset'), { status: 409, code: 'QUARK_DOLBY_UNSUPPORTED' });
    assert.equal(probes, 1);
  }
});

test('only decoded single-layer original HEVC Dolby P5 and P8.1 enter compatibility, never direct or adaptive playback', async t => {
  for (const [profile, compatibilityId, type, colorSpace] of [[5, 0, 'mkv', 'dolby-vision'], [8, 1, 'mp4', 'dolby-vision'], [5, 0, 'mkv', 'sdr'], [5, 0, 'mkv', 'pq']]) {
    const raw = { type, url: `https://video.quark.cn/original-${profile}.${type}?sign=synthetic`, colorSpace };
    const proof = { colorSpace: 'dolby-vision', codec: 'hevc', pixFmt: 'yuv420p10le', bitDepth: 10, dolbyVisionProfile: profile, dolbyVisionCompatibilityId: compatibilityId, rpuPresent: true, rpuSeen: true, blPresent: true, elPresent: false };
    let probes = 0;
    const { cloud, calls } = await fixture(t, { quark: { playback: async () => descriptor({ episode: raw, metadata: { mode: 'download', sourceColorSpace: 'dolby-vision', version: 'raw-' + profile } }) }, probeColor: async input => {
      probes++; assert.equal(input.sourceColorSpace, 'dolby-vision'); assert.equal(input.episode.url, raw.url); assert.ok(input.timeout > 6000 && input.timeout <= 14000); return proof;
    } });
    const lease = await cloud.playback('asset');
    assert.equal(lease.episode.url, raw.url); assert.equal(lease.episode.colorSpace, 'dolby-vision'); assert.equal(lease.response.requiresCompatibility, true);
    assert.equal(lease.master, undefined); assert.equal(lease.colorProbe.dolbyVisionProfile, profile); assert.equal(lease.colorProbe.rpuSeen, true); assert.equal(lease.episode.colorProbe, undefined);
    assert.equal(calls.length, 0); assert.equal(probes, 1); assert.ok(!JSON.stringify(lease.response).includes(raw.url));
    await cloud.playback('asset'); assert.equal(probes, 1, 'the same private source identity can reuse its verified metadata');
  }
});

test('original Dolby probe timeout and range failures stay retryable without reporting an unsupported profile', async t => {
  const raw = { type: 'mkv', url: 'https://video.quark.cn/original.mkv?sign=synthetic', colorSpace: 'dolby-vision' };
  for (const [status, code] of [[504, 'QUARK_COLOR_PROBE_TIMEOUT'], [502, 'QUARK_COLOR_PROBE_READ_FAILED']]) {
    let probes = 0;
    const { cloud } = await fixture(t, { quark: { playback: async () => descriptor({ episode: raw, metadata: { mode: 'download', sourceColorSpace: 'dolby-vision' } }) }, probeColor: async input => {
      probes++; assert.ok(input.timeout <= 14000);
      throw Object.assign(new Error('原文件色彩信息读取失败'), { status, code, colorProbe: { colorSpace: 'unknown' } });
    } });
    for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(cloud.playback('asset'), error => error.status === status && error.code === code && !error.message.includes(raw.url));
    assert.equal(probes, 2);
  }
});

test('original DV with absent RPU, enhancement layers, unsupported profile or codec stays unavailable and cloud AVC cannot borrow support', async t => {
  const raw = { type: 'mkv', url: 'https://video.quark.cn/original.mkv?sign=synthetic', colorSpace: 'dolby-vision' };
  const valid = { colorSpace: 'dolby-vision', codec: 'hevc', dolbyVisionProfile: 5, dolbyVisionCompatibilityId: 0, rpuPresent: true, rpuSeen: true, blPresent: true, elPresent: false };
  for (const change of [{ rpuPresent: false }, { rpuSeen: false }, { rpuSeen: undefined }, { elPresent: true }, { elPresent: undefined }, { blPresent: false }, { dolbyVisionProfile: 7 }, { dolbyVisionProfile: 8, dolbyVisionCompatibilityId: 4 }, { dolbyVisionCompatibilityId: 1 }, { codec: 'h264' }, { rpuPresent: '1' }, { colorSpace: 'sdr' }, { colorSpace: 'browser-default' }]) {
    const { cloud } = await fixture(t, { quark: { playback: async () => descriptor({ episode: raw, metadata: { mode: 'download', sourceColorSpace: 'dolby-vision' } }) }, probeColor: async () => ({ ...valid, ...change }) });
    await assert.rejects(cloud.playback('asset'), error => error.code === 'QUARK_DOLBY_UNSUPPORTED' && error.status === 409);
  }
  for (const colorSpace of ['unknown', 'dolby-vision']) {
    const { cloud } = await fixture(t, { quark: { playback: async () => descriptor({ episode: { colorSpace }, metadata: { mode: 'official', sourceColorSpace: 'dolby-vision' } }) }, probeColor: async () => valid });
    await assert.rejects(cloud.playback('asset'), error => error.code === 'QUARK_DOLBY_UNSUPPORTED');
  }
});

test('invalidation during original Dolby inspection cannot publish a compatible lease', async t => {
  let release, entered; const ready = new Promise(done => { entered = done; });
  const { cloud } = await fixture(t, { quark: { playback: async () => descriptor({ episode: { type: 'mkv', colorSpace: 'dolby-vision' }, metadata: { mode: 'download', sourceColorSpace: 'dolby-vision' } }) }, probeColor: async input => {
    entered(); await new Promise(done => { release = done; }); assert.equal(input.valid(), false);
    return { colorSpace: 'dolby-vision', codec: 'hevc', dolbyVisionProfile: 5, dolbyVisionCompatibilityId: 0, rpuPresent: true, rpuSeen: true, blPresent: true, elPresent: false };
  } });
  const pending = cloud.playback('asset'); await ready; cloud.invalidate(); release(); await assert.rejects(pending, { status: 409 });
});

test('checked PQ and HLG alternatives remain compatibility sources for known Dolby, while unverifiable Dolby never plays direct', async t => {
  for (const colorSpace of ['pq', 'hlg']) {
    const { cloud } = await fixture(t, { quark: { playback: async () => descriptor({ episode: { colorSpace: 'unknown' }, metadata: { sourceColorSpace: 'dolby-vision' } }) }, probeColor: async () => ({ colorSpace }) });
    const lease = await cloud.playback('asset'); assert.equal(lease.episode.colorSpace, colorSpace); assert.equal(lease.response.requiresCompatibility, true);
    assert.equal(lease.episode.sourceColorSpace, 'dolby-vision'); assert.equal(Object.hasOwn(lease.response, 'sourceColorSpace'), false);
  }
  for (const proof of [{ colorSpace: 'dolby-vision', dolbyVisionProfile: 5 }, null]) {
    let probes = 0;
    const candidates = Array.from({ length: 8 }, (_, index) => ({ type: 'hls', url: `https://video.quark.cn/${index}.m3u8`, colorSpace: 'unknown' }));
    const { cloud } = await fixture(t, { quark: { playback: async () => descriptor({ episode: candidates[0], candidates, metadata: { sourceColorSpace: 'dolby-vision' } }) }, probeColor: async () => { probes++; return proof; } });
    await assert.rejects(cloud.playback('asset'), error => {
      assert.equal(error.code, 'QUARK_DOLBY_UNSUPPORTED');
      assert.equal(error.colorProbe.colorSpace, proof ? 'dolby-vision' : 'unknown');
      assert.ok(!JSON.stringify(error.colorProbe).includes('video.quark.cn'));
      return error.status === 409 && /避免偏色|杜比视界/.test(error.message);
    });
    assert.equal(probes, 3, 'one playback attempts at most three unknown candidates');
  }
});

test('color inspection uses one queue, an overall deadline and existing account cancellation', async t => {
  let clock = 0, probes = 0;
  const candidates = [0, 1, 2].map(value => ({ type: 'hls', url: `https://video.quark.cn/${value}.m3u8`, colorSpace: 'unknown' }));
  const { cloud } = await fixture(t, { now: () => clock, quark: { playback: async () => descriptor({ episode: candidates[0], candidates, metadata: { sourceColorSpace: 'dolby-vision' } }) },
    probeColor: async input => { probes++; assert.equal(input.timeout, probes === 1 ? 6000 : 1000); clock += probes === 1 ? 14000 : 1000; throw Error('metadata unavailable'); } });
  await assert.rejects(cloud.playback('asset'), { status: 409 }); assert.equal(probes, 2, 'remaining candidates cannot each restart the overall deadline');
  let active = 0, maximum = 0, release, entered;
  const ready = new Promise(done => { entered = done; });
  const f = await fixture(t, { quark: { playback: async () => descriptor({ episode: { colorSpace: 'unknown' }, metadata: { sourceColorSpace: 'dolby-vision' } }) }, probeColor: async input => {
    active++; maximum = Math.max(maximum, active); entered();
    try { await new Promise((done, reject) => { release = done; input.signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true }); }); return { colorSpace: 'sdr' }; }
    finally { active--; }
  } });
  const first = f.cloud.playback('asset', { owner: 'one' }); await ready;
  const second = f.cloud.playback('other', { owner: 'two' }); f.cloud.invalidate(); release();
  await assert.rejects(first); await assert.rejects(second); assert.equal(maximum, 1); assert.equal(active, 0);
});

test('an exhausted color deadline retains verified HDR playback and drains the probe before retrying', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let probes = 0, active = 0, maximum = 0, finishCleanup, entered, signal;
  const ready = new Promise(done => { entered = done; });
  const candidates = [0, 1, 2].map(value => ({ type: 'hls', url: `https://video.quark.cn/${value}.m3u8`, colorSpace: 'unknown' }));
  const { cloud } = await fixture(t, { quark: { playback: async () => descriptor({ episode: candidates[0], candidates, metadata: { version: 'dolby-alternatives', sourceColorSpace: 'dolby-vision' } }) },
    probeColor: async input => {
      probes++; active++; maximum = Math.max(maximum, active);
      try {
        assert.equal(input.timeout, 6000);
        if (probes === 1) return { colorSpace: 'pq', transfer: 'smpte2084' };
        if (probes === 2) {
          signal = input.signal;
          await new Promise(done => { signal.addEventListener('abort', done, { once: true }); entered(); });
          await new Promise(done => { finishCleanup = done; });
        }
        return { colorSpace: 'sdr' };
      } finally { active--; }
    } });
  const pending = cloud.playback('asset'); await ready;
  t.mock.timers.tick(15000);
  const lease = await pending;
  assert.equal(signal.aborted, true); assert.equal(lease.valid(), true);
  assert.equal(lease.response.colorSpace, 'pq'); assert.equal(lease.response.requiresCompatibility, true);
  assert.equal(probes, 2, 'the deadline cancels remaining candidates');
  const retry = cloud.playback('asset'); await Promise.resolve();
  assert.equal(probes, 2, 'a retry must wait for the cancelled inspector to finish cleaning up');
  finishCleanup();
  assert.equal((await retry).response.colorSpace, 'sdr');
  assert.equal(probes, 3, 'a late aborted SDR result must not enter the proof cache');
  assert.equal(maximum, 1); assert.equal(active, 0);
});

test('an exhausted color deadline without proof cancels inspection and keeps a retryable timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let entered, signal;
  const ready = new Promise(done => { entered = done; });
  const { cloud } = await fixture(t, { quark: { playback: async () => descriptor({ episode: { colorSpace: 'unknown' }, metadata: { sourceColorSpace: 'dolby-vision' } }) },
    probeColor: async input => { signal = input.signal; await new Promise(done => { signal.addEventListener('abort', done, { once: true }); entered(); }); return { colorSpace: 'sdr' }; } });
  const pending = cloud.playback('asset'); await ready;
  t.mock.timers.tick(15000);
  await assert.rejects(pending, error => error.status === 504 && error.code === 'QUARK_COLOR_PROBE_TIMEOUT');
  assert.equal(signal.aborted, true);
});

test('a failed official color probe preserves its retryable cause and can try a lower SDR candidate', async t => {
  const candidates = [0, 1].map(value => ({ type: 'hls', url: `https://video.quark.cn/${value}.m3u8`, colorSpace: 'unknown' }));
  for (const code of ['QUARK_COLOR_PROBE_TIMEOUT', 'QUARK_COLOR_PROBE_READ_FAILED']) {
    const error = Object.assign(Error('metadata unavailable'), { status: code.endsWith('TIMEOUT') ? 504 : 502, code, colorProbe: { colorSpace: 'unknown' } });
    let sdr = false;
    const { cloud } = await fixture(t, { quark: { playback: async () => descriptor({ episode: candidates[0], candidates, metadata: { sourceColorSpace: 'dolby-vision' } }) },
      probeColor: async input => { if (sdr && input.episode.url === candidates[1].url) return { colorSpace: 'sdr' }; throw error; } });
    await assert.rejects(cloud.playback('asset'), failure => failure === error);
    sdr = true;
    assert.equal((await cloud.playback('asset')).response.colorSpace, 'sdr');
  }
});

test('adaptive master rejects invalid qualities and refuses the master token without variants', async t => {
  const variant = { type: 'hls', url: 'https://video.quark.cn/720.m3u8', width: 1280, height: 720, bandwidth: 3000000 };
  for (const variants of ['bad', Array(9).fill(variant), [{ ...variant, url: 'http://127.0.0.1/private' }],
    [{ ...variant, type: 'mp4' }], [{ ...variant, width: Infinity }], [{ ...variant, bandwidth: -1 }], [{ ...variant, height: 90000 }]]) {
    const cloud = createQuarkMedia({ quark: { playback: async () => descriptor({ variants }) } });
    await assert.rejects(cloud.playback('asset'));
  }
  const { cloud, base } = await fixture(t), lease = await cloud.playback('asset');
  assert.equal((await fetch(base + lease.proxyPath + '?token=master')).status, 403);
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

test('account invalidation aborts pending quality requests before any headers arrive', async t => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const { cloud, base } = await fixture(t, { request: async (_url, options) => {
    entered();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('uncancelled account request')), 100);
      options.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(options.signal.reason); }, { once: true });
    });
  } });
  const lease = await cloud.playback('asset'), pending = fetch(base + lease.response.url);
  await started; cloud.invalidate();
  const response = await pending;
  assert.equal(response.status, 403);
  assert.match(await response.text(), /会话已变更/);
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
