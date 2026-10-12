import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createLive, parsePlaylist } from '../lib/live.mjs';
import { createStore } from '../lib/store.mjs';

const source = { id: 'one', name: '公开电视源', url: 'https://tv.example/channels/list.m3u', enabled: true };
const response = (body, statusCode = 200) => Object.assign(Readable.from([body]), { statusCode, headers: {}, finalUrl: source.url });

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
  await live.list(config); assert.equal(calls, 6);
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
  assert.equal(list.channels[0].streams[0].status, 'error');
  assert.equal(list.channels[1].streams[0].status, 'ok');
  assert.equal(list.channels[24].streams[0].status, 'unknown');
  await live.probe(config);
  assert.equal(checked.length, 40); assert.equal(checked[20], 'https://tv.example/20.m3u8');
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
    const cached = await live.list(config);
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
  const result = await live.list(config);
  assert.equal(result.channels.length, 1);
  assert.deepEqual(result.channels[0].streams.map(row => [row.url,row.status]), [['https://tv.example/dead.m3u8','error'],['https://tv.example/good.mp4?token=keep','ok']]);
  assert.deepEqual(checked, [{ url:'https://tv.example/dead.m3u8',type:'hls' },{ url:'https://tv.example/good.mp4?token=keep',type:'mp4' }]);
  live.report('https://tv.example/good.mp4?token=keep','error');
  assert.deepEqual(reports, [[{ url:'https://tv.example/good.mp4?token=keep',type:'mp4' },false]]);
  assert.equal((await live.list(config)).channels[0].streams[1].status,'error');
  await live.stop();
});

test('successful lists keep at most two thousand stored channel rows and prefer the newest source data', async () => {
  const second = { ...source, id: 'two', name: '第二电视源', url: 'https://tv.example/two/list.m3u' };
  const initial = { liveSources: [source] }, state = cacheStore(initial);
  let timestamp = 1000, originalOnline = true, secondOnline = true;
  const live = createLive({ store: state.store, now: () => timestamp, request: async url => {
    const online = url === source.url ? originalOnline : secondOnline;
    return response(online ? playlist(1500, url === source.url ? '第一频道' : '第二频道') : 'offline', online ? 200 : 503);
  } });
  await live.list(initial);
  timestamp = 2000; originalOnline = false;
  const combined = { liveSources: [source, second] }; state.setConfig(combined);
  await live.list(combined);
  const saved = JSON.parse(state.metadata.get('live-playlists-v1'));
  assert.equal(saved.one.channels.length, 500);
  assert.equal(saved.two.channels.length, 1500);
  assert.equal(Object.values(saved).reduce((sum, record) => sum + record.channels.length, 0), 2000);
  secondOnline = false; timestamp = 3000;
  const fallback = await live.list(combined, { refresh: true });
  assert.equal(fallback.channels.length, 2000);
  assert.equal(fallback.failedSources.length, 2);
  assert.ok(fallback.failedSources.every(item => item.stale));
  await live.stop();
});

test('oversized stored lists are trimmed by recency on load and invalid future cache timestamps are rejected', async () => {
  const second = { ...source, id: 'two', name: '第二源', url: 'https://tv.example/two/list.m3u' };
  const future = { ...source, id: 'future', url: 'https://tv.example/future/list.m3u' };
  const config = { liveSources: [source, second, future] }, state = cacheStore(config);
  state.metadata.set('live-playlists-v1', JSON.stringify({
    one: { url: source.url, checkedAt: 1000, channels: parsePlaylist(playlist(1500, '较早频道'), source) },
    two: { url: second.url, checkedAt: 2000, channels: parsePlaylist(playlist(1500, '较新频道'), second) },
    future: { url: future.url, checkedAt: 4000, channels: parsePlaylist(playlist(1, '未来频道'), future) },
  }));
  const live = createLive({ store: state.store, now: () => 3000, request: async () => response('offline', 503) });
  const result = await live.list(config);
  assert.equal(result.channels.length, 2000);
  assert.equal(result.failedSources.find(item => item.source === 'future').stale, undefined);
  const saved = JSON.parse(state.metadata.get('live-playlists-v1'));
  assert.equal(saved.one.channels.length, 500);
  assert.equal(saved.two.channels.length, 1500);
  assert.equal(saved.future, undefined);
  await live.stop();
});
