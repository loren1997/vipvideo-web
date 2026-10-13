import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createLive, parsePlaylist } from '../lib/live.mjs';
import { createStore } from '../lib/store.mjs';
import { DatabaseSync } from 'node:sqlite';

const source = { id: 'one', name: '公开电视源', url: 'https://tv.example/channels/list.m3u', enabled: true };
const response = (body, statusCode = 200) => Object.assign(Readable.from([body]), { statusCode, headers: {}, finalUrl: source.url });

test('low background probing limits network work while manual probing keeps its normal budget', async () => {
  const config = { liveSources: [source] }, checked = [];
  let active = 0, peak = 0;
  const live = createLive({ backgroundMode: 'low',
    request: async () => response('#EXTM3U\n' + Array.from({ length: 30 }, (_, i) => `#EXTINF:-1,频道${i}\nhttps://tv.example/${i}.m3u8`).join('\n')),
    playability: { async check({ url }) {
      peak = Math.max(peak, ++active); checked.push(url);
      await new Promise(resolve => setTimeout(resolve, 1)); active--;
      return { playable: true, checkedAt: Date.now() };
    } },
  });
  try {
    await live.probe(config, { background: true });
    assert.equal(checked.length, 5); assert.equal(peak, 1);
    const listing = await live.list(config);
    assert.equal(listing.probeIntervalMs, 60_000); assert.equal(listing.probeBudget, 5);
    await live.probe(config);
    assert.equal(checked.length, 25); assert.equal(peak, 2);
    assert.equal(checked[5], 'https://tv.example/5.m3u8');
  } finally { await live.stop(); }
});

test('live page polling cannot accelerate the low background probe timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const config = { liveSources: [source] }, metadata = new Map(), checked = [];
  const store = { config: () => config, meta: key => metadata.get(key), setMeta: (key, value) => metadata.set(key, value) };
  const live = createLive({ store, backgroundMode: 'low',
    request: async () => response('#EXTM3U\n' + Array.from({ length: 30 }, (_, i) => `#EXTINF:-1,频道${i}\nhttps://tv.example/${i}.m3u8`).join('\n')),
    playability: { async check({ url }) { checked.push(url); return { playable: true, checkedAt: Date.now() }; } },
  });
  try {
    await live.list(config); live.start(); t.mock.timers.tick(0);
    await new Promise(resolve => setImmediate(resolve)); assert.equal(checked.length, 5);
    for (let i = 0; i < 3; i++) {
      await live.list(config); t.mock.timers.tick(19_999);
      await new Promise(resolve => setImmediate(resolve)); assert.equal(checked.length, 5);
    }
    t.mock.timers.tick(3); await new Promise(resolve => setImmediate(resolve));
    assert.equal(checked.length, 10);
  } finally { await live.stop(); }
});

test('M3U preserves query parameters, quoted commas and channel classification while dropping unsupported addresses', () => {
  const channels = parsePlaylist(`#EXTM3U
#EXTINF:-1 tvg-id="CCTV1.cn@HD" tvg-logo="https://tv.example/logo.png" group-title="央视,综合",CCTV-1 (1080p)
../stream.m3u8?token=a%24b&part=1
#EXTINF:-1 group-title="卫视",高清频道
https://tv.example/linear.mp4?key=one
#EXTINF:-1,UDP频道
udp://239.1.2.3:1234
#EXTINF:-1,内网频道
http://127.0.0.1/live.m3u8
#EXTINF:-1 group-title="adult",限制级样例
https://tv.example/adult.m3u8
#EXTINF:-1,需自定义头
#EXTVLCOPT:http-user-agent=ignored
https://tv.example/plain.m3u8`, source);
  assert.equal(channels.length, 3);
  assert.equal(channels[0].group, '央视,综合');
  assert.equal(channels[0].name, 'CCTV-1');
  assert.equal(channels[0].streams[0].url, 'https://tv.example/stream.m3u8?token=a%24b&part=1');
  assert.equal(channels[1].streams[0].type, 'mp4');
  assert.throws(() => parsePlaylist('<html>error</html>', source), /M3U/);
});

test('live lists combine alternate lines, isolate source failures, share requests and invalidate on configuration changes', async () => {
  let calls = 0, active = 0, maxActive = 0, now = 100;
  const live = createLive({ now: () => now, request: async url => {
    calls++; active++; maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 5)); active--;
    if (url.includes('bad')) return response('error', 503);
    return response(`#EXTM3U\n#EXTINF:-1 tvg-id="CCTV1.cn@${url.includes('two') ? 'SD' : 'HD'}",央视综合\nhttps://tv.example/${url.includes('two') ? 'two' : 'one'}.m3u8?token=1`);
  } });
  const config = { liveSources: [source, { ...source, id: 'two', url: 'https://tv.example/two' }, { ...source, id: 'bad', url: 'https://tv.example/bad' }] };
  const [first, same] = await Promise.all([live.list(config), live.list(config)]);
  assert.equal(calls, 3); assert.equal(maxActive, 2);
  assert.deepEqual(first, same);
  assert.equal(first.channels.length, 1); assert.equal(first.channels[0].streams.length, 2);
  assert.equal(first.failedSources[0].source, 'bad');
  first.channels.length = 0;
  assert.equal((await live.list(config)).channels.length, 1);
  assert.equal(calls, 3);
  now += 10 * 60_000 + 1;
  await live.list(config); await live.list(config, { refresh: true }); assert.equal(calls, 6);
  await live.list({ liveSources: [{ ...source, enabled: false }] }); assert.equal(calls, 6);
  await live.list(config, { refresh: true }); assert.equal(calls, 9);
});

test('live probing rotates a bounded sample, persists status and reports recent playback without changing line indices', async () => {
  const metadata = new Map();
  const config = { liveSources: [source] };
  const store = { config: () => config, meta: key => metadata.get(key), setMeta: (key, value) => metadata.set(key, value) };
  const checked = [];
  const request = async url => {
    if (String(url) === source.url) return response('#EXTM3U\n' + Array.from({ length: 25 }, (_, i) => `#EXTINF:-1,频道${i}\nhttps://tv.example/${i}.m3u8`).join('\n'));
    throw new Error('线路请求应交由共享可播放性模块');
  };
  const playability = { async check({ url }) { checked.push(url); return { playable: !url.endsWith('/0.m3u8'), checkedAt: Date.now(), error: '样例线路失败' }; } };
  const live = createLive({ store, request, playability });
  await Promise.all([live.probe(config), live.probe(config)]);
  assert.equal(checked.length, 20);
  let list = await live.list(config);
  assert.equal(list.channels.find(channel => channel.name === '频道0').streams[0].status, 'error');
  assert.equal(list.channels.find(channel => channel.name === '频道1').streams[0].status, 'ok');
  assert.equal(list.channels.find(channel => channel.name === '频道24').streams[0].status, 'unknown');
  await live.probe(config);
  assert.equal(checked.length, 25); assert.equal(checked[20], 'https://tv.example/20.m3u8');
  live.report('https://tv.example/0.m3u8', 'ok');
  list = await live.list(config);
  assert.equal(list.channels[0].streams[0].status, 'ok');
  const reopened = createLive({ store, request, playability });
  assert.equal(reopened.status(config)[0].status, 'ok');
  assert.equal((await reopened.list(config)).channels[0].streams[0].status, 'ok');
  await live.stop(); await reopened.stop();
});

test('live source deadlines cover both response headers and body reads', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const body = Object.assign(new Readable({ read() {} }), { statusCode: 200, headers: {} });
  const live = createLive({ request: async url => String(url).includes('headers') ? new Promise(() => {}) : body });
  const pending = live.list({ liveSources: [{ ...source, id: 'headers', url: 'https://tv.example/headers' }, source] });
  await Promise.resolve(); t.mock.timers.tick(8000);
  const result = await pending;
  assert.equal(result.channels.length, 0);
  assert.ok(result.failedSources.length === 2 && result.failedSources.every(row => /超时/.test(row.error)));
  assert.equal(body.destroyed, true);
});

test('stopping live refresh waits for active requests and leaves queued sources untouched', async () => {
  let release, calls = 0, stopped = false;
  const waiting = new Promise(resolve => { release = resolve; });
  const live = createLive({ request: async () => { calls++; await waiting; return response('#EXTM3U\n#EXTINF:-1,测试\nhttps://tv.example/live.m3u8'); } });
  const pending = live.list({ liveSources: Array.from({ length: 5 }, (_, i) => ({ ...source, id: String(i), url: `https://tv.example/${i}.m3u` })) });
  while (calls < 2) await new Promise(done => setImmediate(done));
  const stopping = live.stop().then(() => { stopped = true; });
  await Promise.resolve(); assert.equal(stopped, false);
  release(); await stopping; await pending;
  assert.equal(calls, 2);
});

test('live scheduling refreshes the remote list every thirty minutes and catches up after restart', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const metadata = new Map(), config = { liveSources: [source] };
  const store = { config: () => config, meta: key => metadata.get(key), setMeta: (key, value) => metadata.set(key, value) };
  let lists = 0, probes = 0;
  const request = async url => {
    if (String(url) === source.url) { lists++; return response('#EXTM3U\n#EXTINF:-1,测试\nhttps://tv.example/live.m3u8'); }
    throw new Error('线路请求应交由共享可播放性模块');
  };
  const playability = { async check() { probes++; return { playable: true, checkedAt: Date.now() }; } };
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const first = createLive({ store, request, playability });
  first.start(); first.start(); t.mock.timers.tick(0); await flush();
  assert.equal(lists, 1); assert.equal(probes, 1);
  t.mock.timers.tick(30 * 60_000); await flush();
  assert.equal(lists, 2); assert.equal(probes, 2);
  await first.stop(); t.mock.timers.tick(60 * 60_000);
  const restarted = createLive({ store, request, playability });
  restarted.start(); t.mock.timers.tick(0); await flush();
  assert.equal(lists, 3); assert.equal(probes, 3);
  await restarted.stop(); t.mock.timers.tick(24 * 60 * 60_000); await flush();
  assert.equal(lists, 3); assert.equal(probes, 3);
});

const day = 24 * 60 * 60_000;
const playlist = (count = 1, prefix = '缓存频道') => '#EXTM3U\n' + Array.from({ length: count }, (_, index) =>
  `#EXTINF:-1 tvg-id="${prefix}${index}",${prefix}${index}\nhttps://tv.example/${encodeURIComponent(prefix)}/${index}.m3u8?token=keep%24value`).join('\n');
function cacheStore(initial) {
  let config = initial;
  const metadata = new Map(), writes = [];
  return { metadata, writes, setConfig(value) { config = value; },
    store: { config: () => config, meta: key => metadata.get(key), setMeta(key, value) { metadata.set(key, value); writes.push(key); } } };
}

test('a transient failed subscription uses its last successful list while retaining error status and cache timestamp', async () => {
  const config = { liveSources: [source] }, state = cacheStore(config);
  let timestamp = 1000, available = true;
  const live = createLive({ store: state.store, now: () => timestamp,
    request: async () => response(available ? playlist() : 'temporary outage', available ? 200 : 503) });
  const first = await live.list(config);
  assert.equal(first.channels.length, 1);
  const lastGood = JSON.parse(state.metadata.get('live-playlists-v1'));
  assert.equal(lastGood.one.checkedAt, 1000);
  first.channels[0].streams[0].url = 'http://127.0.0.1/mutated';
  available = false; timestamp = 2000;
  const fallback = await live.list(config, { refresh: true });
  assert.equal(fallback.channels.length, 1);
  assert.match(fallback.channels[0].streams[0].url, /^https:\/\/tv\.example\//);
  assert.equal(fallback.channels[0].streams[0].stale, true);
  assert.equal(fallback.channels[0].streams[0].cachedAt, 1000);
  assert.deepEqual(fallback.failedSources, [{ source: 'one', name: source.name, error: '直播源返回 HTTP 503；使用最近可用列表', stale: true, cachedAt: 1000 }]);
  assert.equal(live.status(config)[0].status, 'error');
  assert.equal(live.status(config)[0].cachedAt, 1000);
  assert.deepEqual(JSON.parse(state.metadata.get('live-playlists-v1')), lastGood);
  await live.list(config, { refresh: true });
  assert.equal(state.writes.filter(key => key === 'live-playlists-v1').length, 1);
  await live.stop();
});

test('last successful lists expire after twenty-four hours even while a stale response is in the short-lived memory cache', async () => {
  const config = { liveSources: [source] }, state = cacheStore(config);
  let timestamp = 1000, available = true, calls = 0;
  const live = createLive({ store: state.store, now: () => timestamp,
    request: async () => { calls++; return response(available ? playlist() : 'offline', available ? 200 : 503); } });
  await live.list(config);
  available = false; timestamp += day - 1;
  assert.equal((await live.list(config, { refresh: true })).channels.length, 1);
  timestamp += 2;
  const expired = await live.list(config);
  assert.equal(expired.channels.length, 0);
  assert.equal(expired.failedSources[0].stale, undefined);
  assert.equal(calls, 3);
  assert.deepEqual(JSON.parse(state.metadata.get('live-playlists-v1')), {});
  await live.stop();
});

test('edited, removed, disabled and newly configured subscriptions cannot reuse an older source list', async t => {
  for (const change of ['url', 'id', 'deleted', 'disabled']) await t.test(change, async () => {
    const initial = { liveSources: [source] }, state = cacheStore(initial);
    let available = true;
    const live = createLive({ store: state.store, request: async () => response(available ? playlist() : 'offline', available ? 200 : 503) });
    await live.list(initial);
    available = false;
    const changed = { liveSources: change === 'deleted' ? [] : [{ ...source,
      ...(change === 'url' ? { url: 'https://tv.example/replaced.m3u' } : {}),
      ...(change === 'id' ? { id: 'replacement' } : {}), ...(change === 'disabled' ? { enabled: false } : {}) }] };
    state.setConfig(changed);
    assert.equal((await live.list(changed)).channels.length, 0);
    assert.deepEqual(JSON.parse(state.metadata.get('live-playlists-v1')), {});
    state.setConfig(initial);
    const restored = await live.list(initial, { refresh: true });
    assert.equal(restored.channels.length, 0);
    assert.equal(restored.failedSources[0].stale, undefined);
    await live.stop();
  });
  const initial = { liveSources: [source] }, state = cacheStore(initial);
  const fresh = createLive({ store: state.store, request: async () => response('offline', 503) });
  assert.equal((await fresh.list(initial)).channels.length, 0);
  assert.equal(state.metadata.get('live-playlists-v1'), undefined);
  await fresh.stop();
});

test('a last successful list survives reopening the actual SQLite database while the subscription is offline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vipvideo-live-cache-')), config = { liveSources: [source] };
  let store, live;
  try {
    store = createStore(directory, config);
    live = createLive({ store, now: () => 1000, request: async () => response(playlist()) });
    const good = await live.list(config); await live.stop(); store.close();
    store = createStore(directory, config);
    live = createLive({ store, now: () => 2000, request: async () => response('offline', 503) });
    const cached = await live.list(config, { refresh: true });
    assert.equal(cached.channels[0].id, good.channels[0].id);
    assert.equal(cached.channels[0].streams[0].url, good.channels[0].streams[0].url);
    assert.equal(cached.failedSources[0].stale, true);
    assert.equal(cached.failedSources[0].cachedAt, 1000);
  } finally {
    await live?.stop(); store?.close();
    const target = resolve(directory), root = resolve(tmpdir());
    assert.ok(target.startsWith(root + sep) && target.split(sep).at(-1).startsWith('vipvideo-live-cache-'));
    await rm(target, { recursive: true, force: true });
  }
});

test('cached channel URLs and provenance are revalidated before fallback or live probing', async () => {
  const config = { liveSources: [source] }, state = cacheStore(config), requests = [];
  const rows = parsePlaylist(playlist(8), source);
  const unsafe = ['http://127.0.0.1/private', 'http://10.0.0.1/private', 'http://[::ffff:127.0.0.1]/private',
    'http://localhost/private', 'file:///private', 'https://name:secret@tv.example/private'];
  unsafe.forEach((url, index) => { rows[index].streams[0].url = url; });
  rows[6].streams[0].source = 'unconfigured-source';
  state.metadata.set('live-playlists-v1', JSON.stringify({ one: { url: source.url, checkedAt: 1000, channels: rows } }));
  const live = createLive({ store: state.store, now: () => 2000, playability: { async check({ url }) {
    requests.push(url); assert.equal(url, rows[7].streams[0].url); return { playable: true, checkedAt: 2000 };
  } }, request: async url => {
    requests.push(url);
    return url === source.url ? response('offline', 503) : response('#EXTM3U\n#EXTINF:4,\nsegment.ts');
  } });
  await live.probe(config);
  const result = await live.list(config);
  assert.equal(result.channels.length, 1);
  assert.equal(result.channels[0].streams[0].url, rows[7].streams[0].url);
  assert.equal(result.channels[0].streams[0].status, 'ok');
  assert.deepEqual(requests, [source.url, rows[7].streams[0].url]);
  assert.equal(JSON.parse(state.metadata.get('live-playlists-v1')).one.channels.length, 1);
  await live.stop();
});

test('live probing delegates HLS and MP4 checks without removing or reordering failed lines and forwards playback reports', async () => {
  const checked = [], reports = [];
  const live = createLive({ now: () => 1000, request: async () => response('#EXTM3U\n#EXTINF:-1 tvg-id="same",同一频道\nhttps://tv.example/dead.m3u8\n#EXTINF:-1 tvg-id="same",同一频道\nhttps://tv.example/good.mp4?token=keep'),
    playability: { async check(episode) { checked.push(episode); return { playable: episode.type === 'mp4', checkedAt: 1000, error: '首分片不可访问' }; },
      report(episode, playable) { reports.push([episode, playable]); } } });
  const config = { liveSources: [source] };
  await live.probe(config);
  await live.probe(config);
  const result = await live.list(config);
  assert.equal(result.channels.length, 1);
  assert.deepEqual(result.channels[0].streams.map(row => [row.url,row.status]), [['https://tv.example/dead.m3u8','error'],['https://tv.example/good.mp4?token=keep','ok']]);
  assert.deepEqual(checked, [{ url:'https://tv.example/dead.m3u8',type:'hls' },{ url:'https://tv.example/good.mp4?token=keep',type:'mp4' }]);
  live.report('https://tv.example/good.mp4?token=keep','error');
  assert.deepEqual(reports, [[{ url:'https://tv.example/good.mp4?token=keep',type:'mp4' },false]]);
  assert.equal((await live.list(config)).channels[0].streams[1].status,'error');
  await live.stop();
});

test('successful lists keep at most five thousand stored channel rows and prefer the newest source data', async () => {
  const second = { ...source, id: 'two', name: '第二电视源', url: 'https://tv.example/two/list.m3u' };
  const third = { ...source, id: 'three', name: '第三电视源', url: 'https://tv.example/three/list.m3u' };
  const initial = { liveSources: [source] }, state = cacheStore(initial);
  let timestamp = 1000, online = true;
  const live = createLive({ store: state.store, now: () => timestamp, request: async url => {
    timestamp++;
    return response(online ? playlist(2000, url === source.url ? '第一频道' : url === second.url ? '第二频道' : '第三频道') : 'offline', online ? 200 : 503);
  } });
  await live.list(initial);
  timestamp = 2000;
  const combined = { liveSources: [source, second] }; state.setConfig(combined);
  await live.list(combined, { refresh: true });
  timestamp = 3000; const all = { liveSources: [source, second, third] }; state.setConfig(all);
  await live.list(all, { refresh: true });
  const saved = JSON.parse(state.metadata.get('live-playlists-v1'));
  assert.equal(saved.three.channels.length, 2000);
  assert.equal(Object.values(saved).reduce((sum, record) => sum + record.channels.length, 0), 5000);
  online = false; timestamp = 4000;
  const fallback = await live.list(all, { refresh: true });
  assert.equal(fallback.channels.length, 5000);
  assert.equal(fallback.failedSources.length, 3);
  assert.ok(fallback.failedSources.every(item => item.stale));
  await live.stop();
});

test('oversized stored lists are trimmed by recency on load and invalid future cache timestamps are rejected', async () => {
  const second = { ...source, id: 'two', name: '第二源', url: 'https://tv.example/two/list.m3u' };
  const third = { ...source, id: 'three', name: '第三源', url: 'https://tv.example/three/list.m3u' };
  const future = { ...source, id: 'future', url: 'https://tv.example/future/list.m3u' };
  const config = { liveSources: [source, second, third, future] }, state = cacheStore(config);
  state.metadata.set('live-playlists-v1', JSON.stringify({
    one: { url: source.url, checkedAt: 1000, channels: parsePlaylist(playlist(2000, '较早频道'), source) },
    two: { url: second.url, checkedAt: 2000, channels: parsePlaylist(playlist(2000, '较新频道'), second) },
    three: { url: third.url, checkedAt: 2500, channels: parsePlaylist(playlist(2000, '最新频道'), third) },
    future: { url: future.url, checkedAt: 4000, channels: parsePlaylist(playlist(1, '未来频道'), future) },
  }));
  const live = createLive({ store: state.store, now: () => 3000, request: async () => response('offline', 503) });
  const result = await live.list(config, { refresh: true });
  assert.equal(result.channels.length, 5000);
  assert.equal(result.failedSources.find(item => item.source === 'future').stale, undefined);
  const saved = JSON.parse(state.metadata.get('live-playlists-v1'));
  assert.equal(saved.one.channels.length, 1000);
  assert.equal(saved.two.channels.length, 2000);
  assert.equal(saved.future, undefined);
  await live.stop();
});

test('cached lists return immediately during an expired refresh and after restart without trusting unknown streams', async () => {
  let time = 1000, release, online = true, calls = 0;
  const config = { liveSources: [source] }, state = cacheStore(config);
  const request = async () => { calls++; return online ? response(playlist()) : new Promise(done => { release = () => done(response('offline', 503)); }); };
  let live = createLive({ store: state.store, now: () => time, request });
  try {
    await live.list(config); live.report('https://tv.example/%E7%BC%93%E5%AD%98%E9%A2%91%E9%81%93/0.m3u8?token=keep%24value', 'ok');
    time += 10 * 60_000 + 1; online = false;
    const fast = await Promise.race([live.list(config), new Promise(done => setImmediate(() => done(null)))]);
    assert.ok(fast); assert.equal(fast.probing, true); assert.equal(fast.totalStreams, 1); assert.equal(fast.checkedStreams, 1); assert.equal(fast.channels[0].streams[0].status, 'ok');
    await live.list(config); assert.equal(calls, 2); release(); await live.list(config, { refresh: true }); await live.stop();
    live = createLive({ store: state.store, now: () => time, request });
    const reopened = await Promise.race([live.list(config), new Promise(done => setImmediate(() => done(null)))]);
    assert.ok(reopened); assert.equal(reopened.channels.length, 1); assert.equal(reopened.probing, true); release(); await live.stop();
  } finally { release?.(); await live.stop(); }
});

test('background batches cover more than five hundred streams without downloading every batch and keep refreshing results', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const config = { liveSources: [source] }, state = cacheStore(config); let lists = 0, checked = 0, healthy = true;
  const live = createLive({ store: state.store, request: async () => { lists++; return response(playlist(650)); }, playability: { async check() { checked++; return { playable: healthy, checkedAt: Date.now(), error: '本次线路失败' }; } } });
  const flush = () => new Promise(done => setImmediate(done));
  try {
    live.start(); t.mock.timers.tick(0); await flush(); assert.equal(checked, 20);
    for (let batch = 1; batch < 33; batch++) { t.mock.timers.tick(5000); await flush(); }
    const complete = await live.list(config);
    assert.equal(checked, 650); assert.equal(lists, 1); assert.equal(complete.checkedStreams, 650); assert.equal(complete.totalStreams, 650); assert.equal(complete.channels.filter(channel => channel.streams[0].status === 'ok').length, 650);
    assert.equal(Object.keys(JSON.parse(state.metadata.get('live-health')).streams).length, 650);
    healthy = false; t.mock.timers.tick(30 * 60_000); await flush();
    const updated = await live.list(config); assert.ok(updated.channels.some(channel => channel.streams[0].status === 'error')); assert.ok(updated.channels.some(channel => channel.streams[0].status === 'ok')); assert.ok(lists >= 2);
    await live.stop(); const count = checked; t.mock.timers.tick(day); await flush(); assert.equal(checked, count);
  } finally { await live.stop(); }
});

test('progressive probing prioritizes each channel before backup lines and rejects results after source disable', async () => {
  const second = { ...source, id: 'two', url: 'https://tv.example/two/list.m3u' }, config = { liveSources: [source, second] }, state = cacheStore(config);
  const checked = [], releases = [];
  const request = async target => response('#EXTM3U\n' + Array.from({ length: 25 }, (_, index) => `#EXTINF:-1 tvg-id="Channel${index}.cn",频道${index}\nhttps://tv.example/${target === source.url ? 'one' : 'two'}/${index}.m3u8`).join('\n'));
  let delayed = false;
  const live = createLive({ store: state.store, request, playability: { async check({ url }) { checked.push(url); if (delayed) await new Promise(done => releases.push(done)); return { playable: true, checkedAt: Date.now() }; } } });
  try {
    await live.probe(config); assert.equal(checked.length, 20); assert.ok(checked.every(url => url.includes('/one/')));
    delayed = true; const pending = live.probe(config); while (releases.length < 2) await new Promise(done => setImmediate(done));
    state.setConfig({ liveSources: [source, { ...second, enabled: false }] }); releases.forEach(done => done()); await pending;
    assert.equal(checked.length, 22); assert.equal(Object.keys(JSON.parse(state.metadata.get('live-health')).streams).length, 20);
    assert.ok((await live.list(state.store.config())).channels.every(channel => channel.streams.length === 1));
  } finally { releases.forEach(done => done()); await live.stop(); }
});

test('a pending old probe cannot replace a newer real playback failure report', async () => {
  const config = { liveSources: [source] }, state = cacheStore(config); let release;
  const url = 'https://tv.example/live.m3u8';
  const live = createLive({ store: state.store, request: async () => response(`#EXTM3U\n#EXTINF:-1,普通直播\n${url}`), playability: { check: async () => new Promise(done => { release = () => done({ playable: true, checkedAt: Date.now() }); }), report() {} } });
  try {
    const pending = live.probe(config); while (!release) await new Promise(done => setImmediate(done));
    live.report(url, 'error'); release(); await pending;
    assert.equal((await live.list(config)).channels[0].streams[0].status, 'error');
    assert.equal(JSON.parse(state.metadata.get('live-health')).streams[url].status, 'error');
  } finally { release?.(); await live.stop(); }
});

test('an entirely fresh probe batch makes no upstream requests or database writes and retains lastProbe', async () => {
  const config = { liveSources: [source] }, state = cacheStore(config); let time = 1000, lists = 0, checked = 0;
  const live = createLive({ store: state.store, now: () => time, request: async () => { lists++; return response(playlist(2)); }, playability: { async check() { checked++; return { playable: true, checkedAt: time }; } } });
  try {
    await live.probe(config); const writes = state.writes.length, lastProbe = JSON.parse(state.metadata.get('live-health')).lastProbe;
    time += 1000; await live.probe(config);
    assert.equal(lists, 1); assert.equal(checked, 2); assert.equal(state.writes.length, writes); assert.equal(JSON.parse(state.metadata.get('live-health')).lastProbe, lastProbe);
  } finally { await live.stop(); }
});

test('playlist refresh and stream probes share the same two live work slots', async () => {
  const second = { ...source, id: 'two', url: 'https://tv.example/two/list.m3u' }, config = { liveSources: [source, second] }, state = cacheStore(config);
  let time = 1000, delayed = false, active = 0, maximum = 0, checked = 0; const releases = [];
  const live = createLive({ store: state.store, now: () => time, request: async target => {
    active++; maximum = Math.max(maximum, active);
    if (delayed) await new Promise(done => releases.push(done)); active--;
    return response(`#EXTM3U\n#EXTINF:-1,${target}\n${target.replace('list.m3u', 'live.m3u8')}`);
  }, playability: { async check() { checked++; active++; maximum = Math.max(maximum, active); await new Promise(done => setImmediate(done)); active--; return { playable: true, checkedAt: time }; } } });
  try {
    await live.list(config); delayed = true; time += 10 * 60_000 + 1; await live.list(config);
    while (releases.length < 2) await new Promise(done => setImmediate(done));
    const refresh = live.list(config, { refresh: true }), pending = live.probe(config); await new Promise(done => setImmediate(done)); assert.equal(checked, 0);
    releases.forEach(done => done()); await Promise.all([pending, refresh]); assert.equal(checked, 2); assert.ok(maximum <= 2);
  } finally { releases.forEach(done => done()); await live.stop(); }
});

test('only the unchanged built-in source uses its packaged seed and every seed line remains unverified', async () => {
  const builtin = { id: 'live-presets', name: '内置', url: 'https://raw.githubusercontent.com/loren1997/vipvideo-web/main/web/live-presets.m3u', enabled: true };
  const config = { liveSources: [builtin] }, state = cacheStore(config); let release;
  const live = createLive({ store: state.store, request: async () => new Promise(done => { release = () => done(response('offline', 503)); }) });
  try {
    const first = await Promise.race([live.list(config), new Promise(done => setTimeout(() => done(null), 100))]);
    assert.ok(first?.channels.length); assert.ok(first.channels.every(channel => channel.streams.every(stream => stream.status === 'unknown'))); release();
    const offline = await live.list(config, { refresh: true }); assert.match(offline.failedSources[0].error, /内置频道列表/);
    state.setConfig({ liveSources: [{ ...builtin, enabled: false }] }); assert.equal((await live.list(state.store.config())).channels.length, 0);
    assert.equal(state.metadata.get('live-playlists-v1'), undefined);
  } finally { release?.(); await live.stop(); }
});

test('reliable CCTV names share existing canonical IDs across subscriptions while unrelated numeric TVG IDs stay distinct', async () => {
  const left = parsePlaylist('#EXTM3U\n#EXTINF:-1 tvg-id="CCTV1.cn" group-title="央视",CCTV-1 综合\nhttps://tv.example/one.m3u8\n', source);
  const right = parsePlaylist('#EXTM3U\n#EXTINF:-1 tvg-id="1" group-title="央视频道",CCTV1\nhttps://tv.example/two.m3u8\n#EXTINF:-1 tvg-id="1" group-title="地方",其他地方台\nhttps://tv.example/local.m3u8\n', { ...source, id: 'two' });
  assert.equal(left[0].id, right[0].id); assert.notEqual(right[0].id, right[1].id);
});

test('new live defaults migrate once without restoring removed, disabled or tombstoned user sources', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vipvideo-live-migration-'));
  const additions = [{ ...source, id: 'vbskycn-ipv4', url: 'https://tv.example/new-one.m3u' }, { ...source, id: 'tvbox-live', url: 'https://tv.example/new-two.m3u' }];
  const original = { showAdult: false, sources: [{ id: 'user-source' }], liveSources: [{ ...additions[0], enabled: false }] };
  let store;
  const clearMigrationMarker = () => { const db = new DatabaseSync(join(directory, 'app.sqlite')); db.prepare('DELETE FROM meta WHERE key=?').run('builtin-live-sources-v2'); db.close(); };
  try {
    store = createStore(directory, original); store.close(); clearMigrationMarker();
    store = createStore(directory, { ...original, liveSources: additions });
    assert.equal(store.config().liveSources.length, 2); assert.equal(store.config().liveSources[0].enabled, false); assert.deepEqual(store.config().sources, original.sources);
    store.setConfig({ ...store.config(), liveSources: [store.config().liveSources[0]] }); store.close();
    store = createStore(directory, { ...original, liveSources: additions }); assert.equal(store.config().liveSources.length, 1);
    store.setMeta('source-discovery-v1', JSON.stringify({ managed: { [additions[1].url]: { blocked: true } } })); store.close(); clearMigrationMarker();
    store = createStore(directory, { ...original, liveSources: additions }); assert.equal(store.config().liveSources.length, 1);
  } finally { store?.close(); const target = resolve(directory), root = resolve(tmpdir()); assert.ok(target.startsWith(root + sep) && target.split(sep).at(-1).startsWith('vipvideo-live-migration-')); await rm(target, { recursive: true, force: true }); }
});

test('long public stream URLs cannot exceed the persistent playlist byte budget', async () => {
  const sources = Array.from({ length: 16 }, (_, index) => ({ ...source, id: 'bounded-' + index, url: `https://tv.example/list-${index}.m3u` }));
  const config = { liveSources: sources }, state = cacheStore(config); let time = 1000;
  const live = createLive({ store: state.store, now: () => time, request: async target => {
    time++;
    const body = '#EXTM3U\n' + Array.from({ length: 300 }, (_, index) => `#EXTINF:-1,${target}-${index}\nhttps://tv.example/${index}.m3u8?source=${encodeURIComponent(target)}&token=${'a'.repeat(6000)}`).join('\n');
    assert.ok(Buffer.byteLength(body) < 2 * 1024 * 1024); return response(body);
  } });
  try {
    await live.list(config, { refresh: true });
    const saved = state.metadata.get('live-playlists-v1'), rows = Object.values(JSON.parse(saved)).reduce((count, record) => count + record.channels.length, 0);
    assert.ok(Buffer.byteLength(saved) <= 24 * 1024 * 1024); assert.ok(rows > 3000 && rows < 4800);
  } finally { await live.stop(); }
});

test('the first batch fairly covers satellite and local channels behind a long CCTV prefix', async () => {
  const rows = Array.from({ length: 100 }, (_, index) => `#EXTINF:-1 group-title="央视",央视样例${index}\nhttps://tv.example/cctv-${index}.m3u8`).concat(['#EXTINF:-1 group-title="卫视",湖南卫视\nhttps://tv.example/satellite.m3u8', '#EXTINF:-1 group-title="地方",普通地方新闻\nhttps://tv.example/local.m3u8']);
  const checked = [], live = createLive({ request: async () => response('#EXTM3U\n' + rows.join('\n')), playability: { async check({ url }) { checked.push(url); return { playable: true, live: true, checkedAt: Date.now() }; } } });
  try {
    await live.probe({ liveSources: [source] }); assert.equal(checked.length, 20); assert.ok(checked.includes('https://tv.example/satellite.m3u8')); assert.ok(checked.includes('https://tv.example/local.m3u8'));
    const list = await live.list({ liveSources: [source] }); assert.equal(list.channels.find(channel => channel.name === '湖南卫视').category, '卫视');
  } finally { await live.stop(); }
});

test('a failed satellite primary receives a timely HD backup without waiting behind hundreds of other channels', async () => {
  const second = { ...source, id: 'backup', url: 'https://tv.example/backup.m3u' }, checked = [];
  const live = createLive({ now: () => 1000, request: async target => response('#EXTM3U\n#EXTINF:-1 tvg-id="HunanTV.cn" group-title="卫视",湖南卫视\n' + (target === source.url ? 'https://tv.example/dead.m3u8\n' + Array.from({ length: 500 }, (_, index) => `#EXTINF:-1 group-title="央视",央视样例${index}\nhttps://tv.example/cctv-${index}.m3u8`).join('\n') : 'https://tv.example/hd.m3u8')), playability: { async check({ url }) { checked.push(url); return { playable: !url.includes('dead'), live: true, checkedAt: 1000, quality: { width: 1920, height: 1080, source: 'bitstream' }, playbackUrl: url }; } } });
  const config = { liveSources: [source, second] };
  try {
    await live.probe(config); assert.equal(checked.length, 20); await live.probe(config); assert.equal(checked[20], 'https://tv.example/hd.m3u8');
    const channel = (await live.list(config)).channels.find(item => item.name === '湖南卫视'); assert.equal(channel.preferredLine, 1); assert.equal(channel.streams[0].url, 'https://tv.example/dead.m3u8'); assert.equal(channel.streams[1].quality.height, 1080);
  } finally { await live.stop(); }
});

test('quality selects the best verified original line, ignores fabricated metadata, and refuses ended VOD playlists as live', async () => {
  const config = { liveSources: [source] }, state = cacheStore(config), urls = ['low', 'high', 'bad-metadata', 'ended'].map(name => `https://tv.example/${name}.m3u8`);
  const live = createLive({ store: state.store, now: () => 1000, request: async () => response('#EXTM3U\n' + urls.map(url => `#EXTINF:-1 tvg-id="QualityTV.cn",质量样例\n${url}`).join('\n')), playability: { async check({ url }) {
    if (url.includes('bad-metadata')) return { playable: true, live: true, checkedAt: 1000, quality: { width: '1920', height: 1080, source: 'name' }, playbackUrl: 'http://127.0.0.1/private.m3u8' };
    return { playable: true, live: !url.includes('ended'), checkedAt: 1000, quality: { width: url.includes('high') ? 1920 : 1280, height: url.includes('high') ? 1080 : 720, source: 'manifest' }, playbackUrl: url.replace('tv.example', 'cdn.example') };
  }, report() {} } });
  try {
    for (let index = 0; index < 4; index++) await live.probe(config);
    const channel = (await live.list(config)).channels[0]; assert.deepEqual(channel.streams.map(stream => stream.url), urls); assert.equal(channel.preferredLine, 1); assert.equal(channel.streams[1].playbackUrl, 'https://cdn.example/high.m3u8'); assert.equal(channel.streams[2].quality, undefined); assert.equal(channel.streams[2].playbackUrl, undefined); assert.equal(channel.streams[3].status, 'error');
    live.report(urls[1], 'error'); assert.equal((await live.list(config)).channels[0].preferredLine, 0);
    await live.stop();
    const saved = JSON.parse(state.metadata.get('live-health')); saved.streams[urls[0]].quality = { width: 999999, height: 1080, source: 'bitstream' }; saved.streams[urls[0]].playbackUrl = 'http://10.0.0.1/private.m3u8'; state.metadata.set('live-health', JSON.stringify(saved));
    const reopened = createLive({ store: state.store, now: () => 1000, request: async () => response('offline', 503) });
    try { const restored = await reopened.list(config); assert.equal(restored.channels[0].streams[0].quality, undefined); assert.equal(restored.channels[0].streams[0].playbackUrl, undefined); }
    finally { await reopened.stop(); }
  } finally { await live.stop(); }
});

test('packaged seed upgrades an old builtin SQLite playlist and preserves old and new backup indices when GitHub is offline', async () => {
  const builtin = { id: 'live-presets', name: '内置', url: 'https://raw.githubusercontent.com/loren1997/vipvideo-web/main/web/live-presets.m3u', enabled: true };
  const config = { liveSources: [builtin] }, state = cacheStore(config), oldUrl = 'https://tv.example/old-hebei.m3u8';
  state.metadata.set('live-playlists-v1', JSON.stringify({ 'live-presets': { url: builtin.url, checkedAt: 1000, channels: parsePlaylist(`#EXTM3U\n#EXTINF:-1 tvg-id="HebeiTV.cn" group-title="卫视",河北卫视\n${oldUrl}`, builtin) } }));
  const live = createLive({ store: state.store, now: () => 2000, request: async () => response('GitHub offline', 503), playability: { async check({ url }) { return { playable: true, live: true, checkedAt: 2000, quality: { width: url === oldUrl ? 640 : 1920, height: url === oldUrl ? 360 : 1080, source: 'bitstream' }, playbackUrl: url }; } } });
  try {
    const cached = await live.list(config), heb = cached.channels.find(channel => channel.name === '河北卫视');
    assert.ok(cached.channels.some(channel => channel.name === '安徽卫视')); assert.ok(cached.channels.some(channel => channel.name === '浙江卫视')); assert.equal(heb.streams[0].url, oldUrl); assert.ok(heb.streams.some(stream => stream.url === 'http://204.12.221.218:8181/3m1080p/hews.m3u8'));
    await live.list(config, { refresh: true }); await live.probe(config); await live.probe(config);
    const upgraded = (await live.list(config)).channels.find(channel => channel.name === '河北卫视'); assert.equal(upgraded.streams[0].url, oldUrl); assert.ok(upgraded.preferredLine > 0); assert.equal(upgraded.streams[upgraded.preferredLine].quality.height, 1080);
    state.setConfig({ liveSources: [{ ...builtin, url: 'https://tv.example/user-edited.m3u' }] }); assert.equal((await live.list(state.store.config(), { refresh: true })).channels.length, 0);
  } finally { await live.stop(); }
});
