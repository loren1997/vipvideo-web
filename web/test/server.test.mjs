import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import { createConnection } from 'node:net';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { createStore } from '../lib/store.mjs';
import { createQuarkMedia } from '../lib/quark-media.mjs';
import { createQuark } from '../lib/quark.mjs';
import { Readable } from 'node:stream';

const empty = { showAdult: false, sources: [], platforms: [], parsers: [], subscriptions: [], liveSources: [] };
const detail = { key: 'film', source: 'demo', id: '1', title: '测试影片', year: '2025', type: 'movie', poster: '', description: '简介',
  lines: [{ name: '线路', episodes: [{ name: '正片', url: 'https://media.example/video.m3u8?token=abc', type: 'hls' }] }] };
const catalog = { async search() { return { groups: [{ ...detail, items: [{ source: 'demo', id: '1' }] }], failedSources: [] }; },
  async detail() { return detail; } };

test('incomplete HTTP requests time out with 408 while malformed requests remain rejected', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'vipvideo-timeout-'));
  const app = createApp({ password: 'test-password', dataDir, initialConfig: empty, catalog });
  app.server.requestTimeout = 100; app.server.headersTimeout = 50; app.server.connectionsCheckingInterval = 25;
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const exchange = request => new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: app.server.address().port });
    let response = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('HTTP error response did not close the connection')); }, 2000);
    socket.on('connect', () => socket.write(request));
    socket.on('data', chunk => { response += chunk; });
    socket.on('error', error => { clearTimeout(timer); reject(error); });
    socket.on('end', () => { clearTimeout(timer); socket.end(); resolve(response); });
  });
  const expired = await exchange('GET /api/config HTTP/1.1\r\nHost: localhost\r\n');
  assert.match(expired, /^HTTP\/1\.1 408 Request Timeout\r\n/);
  assert.match(expired, /\r\nConnection: close\r\n/i);
  assert.match(await exchange('INVALID REQUEST\r\n\r\n'), /^HTTP\/1\.1 400 Bad Request\r\n/);
});

test('ad inspection resolves configured episodes and preserves ranges for older clients', async t => {
  const source = { id: 'demo', name: '演示', api: 'https://source.example/api', enabled: true };
  const calls = [], { call, login } = await running(t, { initialConfig: { ...empty, sources: [source] },
    adMarkers: { inspect: async episode => { calls.push(episode); return { supported: true, ranges: [{ start: 20, end: 30, kind: 'cue' }] }; } } });
  assert.equal((await call('/api/ads?source=demo&id=1')).status, 401);
  const cookie = await login();
  const ad = await call('/api/ads?source=demo&id=1&line=0&episode=0&url=http://127.0.0.1/private', undefined, cookie);
  assert.equal(ad.status, 200); assert.equal(calls[0].url, detail.lines[0].episodes[0].url);
  assert.equal((await call('/api/ads?source=missing&id=1', undefined, cookie)).status, 400);
  assert.equal((await call('/api/ads?source=demo&id=1&episode=-1', undefined, cookie)).status, 400);
  const range = { scope: 'specific-version', start: 20, end: 30 };
  assert.equal((await call('/api/player/preferences', { key: 'film', skipAds: true, adRanges: [range] }, cookie, 'PUT')).status, 200);
  const legacy = await call('/api/player/preferences', { key: 'film', speed: 2 }, cookie, 'PUT');
  assert.equal((await legacy.json()).skipAds, true);
  assert.deepEqual((await (await call('/api/player/preferences?key=film', undefined, cookie)).json()).adRanges, [range]);
  assert.equal((await call('/api/player/preferences', { key: 'film', skipAds: null }, cookie, 'PUT')).status, 400);
});

test('cloud routes protect account data, resolve trusted selections and proxy only server-created assets', async t => {
  const calls = [], source = { id: 'demo', name: '演示', api: 'https://source.example/api', enabled: true };
  const settings = () => ({ configured: true, enabled: true, account: { connected: true, label: '已连接账号' } });
  const quark = { settings, configure: async input => { calls.push(['configure', input]); return settings(); },
    resources: async (value, options) => { calls.push(['resources', value, options]); return { resources: [{ id: 'share', name: '影片' }] }; },
    files: async () => ({ files: [] }), prepare: async (value, options) => { calls.push(['prepare', options]); return { assetId: 'asset', status: 'ready' }; },
    playback: async () => ({ episode: { type: 'mp4', url: 'https://video.quark.cn/file.mp4', colorSpace: 'sdr' }, headers: { cookie: 'server-only-secret' },
      allowCookieOrigins: ['https://video.quark.cn'], metadata: { name: '影片', category: 'movie', version: 'quality-1' } }),
    progress: async (_id, input) => ({ saved: true, ended: input.ended }), cleanup: async () => ({ deleted: 0 }), clearAccount: async () => settings() };
  const cloud = createQuarkMedia({ quark, request: async () => Object.assign(Readable.from([Buffer.from('video')]), { statusCode: 200, headers: { 'content-type': 'video/mp4' } }) });
  const { call, login } = await running(t, { initialConfig: { ...empty, sources: [source] }, quark, quarkMedia: cloud });
  for (const path of ['/api/quark/settings', '/api/quark/resources?source=demo&id=1', '/api/quark/media/00000000000000000000000000000000?token=x']) assert.equal((await call(path)).status, 401);
  const cookie = await login();
  assert.equal((await call('/api/quark/settings', { cookie: 'server-only-secret', enabled: true }, cookie, 'PUT')).status, 200);
  assert.ok(!(await (await call('/api/config', undefined, cookie)).text()).includes('server-only-secret'));
  assert.equal((await call('/api/quark/resources?source=demo&id=1&episode=0', undefined, cookie)).status, 200);
  assert.equal(calls.find(row => row[0] === 'resources')[1].title, detail.title);
  assert.equal((await call('/api/quark/resources?source=demo&id=1&episode=99', undefined, cookie)).status, 400);
  assert.equal((await call('/api/quark/prepare', { source: 'demo', id: '1', auto: true }, cookie)).status, 200);
  assert.equal((await call('/api/quark/prepare', { source: 'demo', id: '1', auto: 'yes' }, cookie)).status, 400);
  const playback = await (await call('/api/quark/playback', { assetId: 'asset' }, cookie)).json();
  assert.ok(!JSON.stringify(playback).includes('server-only-secret')); assert.ok(!JSON.stringify(playback).includes('video.quark.cn'));
  assert.equal((await call(playback.url, undefined, cookie)).status, 200);
  assert.equal((await call('/api/quark/account', {}, cookie, 'DELETE')).status, 200);
  assert.equal((await call(playback.url, undefined, cookie)).status, 403);
});

test('cloud subtitles expose only registered same-origin files after login', async t => {
  const content = '1\n00:00:01,000 --> 00:00:02,000\n中文字幕\n', calls = [];
  const quark = {
    subtitles: async (id, options) => { options.valid(); options.visible('movie'); calls.push(['list', id]); return [{ id: 'sub-1', name: '影片.zh.srt', type: 'srt', fid: 'private-fid', url: 'https://drive.quark.cn/private?token=secret' }]; },
    subtitle: async (id, subtitleId, options) => { options.valid(); options.visible('movie'); calls.push(['read', id, subtitleId]); return content; },
  };
  const { call, login } = await running(t, { quark }), path = '/api/quark/subtitles?assetId=asset';
  assert.equal((await call(path)).status, 401);
  assert.equal((await call('/api/quark/subtitle?assetId=asset&subtitleId=sub-1')).status, 401);
  assert.equal(calls.length, 0);
  const cookie = await login(), list = await (await call(path, undefined, cookie)).json();
  assert.deepEqual(list, { subtitles: [{ id: 'sub-1', name: '影片.zh.srt', type: 'srt', url: '/api/quark/subtitle?assetId=asset&subtitleId=sub-1' }] });
  const subtitle = await call(list.subtitles[0].url, undefined, cookie);
  assert.equal(subtitle.status, 200); assert.equal(await subtitle.text(), content);
  assert.equal(subtitle.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(subtitle.headers.get('content-length'), String(Buffer.byteLength(content)));
  assert.equal(subtitle.headers.get('cache-control'), 'private, no-store');
  assert.equal(subtitle.headers.get('x-content-type-options'), 'nosniff');
  const before = calls.length;
  for (const query of ['assetId=asset&url=http://127.0.0.1/private', 'assetId=asset&fid=arbitrary', 'assetId=asset&assetId=other', '']) assert.equal((await call('/api/quark/subtitles?' + query, undefined, cookie)).status, 400);
  for (const query of ['assetId=asset', 'assetId=asset&subtitleId=sub-1&subtitleId=sub-2', 'assetId=asset&subtitleId=sub-1&url=https://evil.example']) assert.equal((await call('/api/quark/subtitle?' + query, undefined, cookie)).status, 400);
  assert.equal(calls.length, before);
});

test('cloud subtitles obey hidden categories and bounded text responses', async t => {
  const quark = {
    subtitles: async (_id, { visible }) => { visible('adult'); return []; },
    subtitle: async () => '字'.repeat(Math.ceil(2 * 1024 * 1024 / 3)),
  };
  const { call, login } = await running(t, { quark }), cookie = await login();
  assert.equal((await call('/api/quark/subtitles?assetId=hidden', undefined, cookie)).status, 403);
  const oversized = await call('/api/quark/subtitle?assetId=asset&subtitleId=large', undefined, cookie);
  assert.equal(oversized.status, 400); assert.match((await oversized.json()).error, /2 MiB/);
});

test('cloud subtitle reads cannot finish after the household session is revoked', async t => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), paused = new Promise(resolve => { release = resolve; });
  const quark = { subtitle: async () => { entered(); await paused; return 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nprivate\n'; } };
  const { call, login } = await running(t, { quark }), cookie = await login();
  t.after(release);
  const response = call('/api/quark/subtitle?assetId=asset&subtitleId=sub-1', undefined, cookie);
  await started;
  try { assert.equal((await call('/api/auth/logout', {}, cookie)).status, 200); } finally { release(); }
  assert.equal((await response).status, 401);
});

test('Quark resource searches use the maintained pool and expose its status only after login', async t => {
  let searches = 0;
  const poolStatus = { healthy: 1, pending: 1, lastDiscovery: 123 };
  const quarkSearchPool = {
    status: () => poolStatus,
    request: async value => {
      searches++; assert.match(String(value), /测试影片|%E6%B5%8B%E8%AF%95/);
      return Object.assign(Readable.from([JSON.stringify({ results: [{ title: '测试影片 2025', url: 'https://pan.quark.cn/s/abcdef123456' }] })]), { statusCode: 200 });
    },
    stop: async () => {},
  };
  const source = { id: 'demo', name: '演示', api: 'https://source.example/api', enabled: true };
  const metadata = new Map(), quarkReads = [], cloudData = await mkdtemp(join(tmpdir(), 'vipvideo-quark-server-'));
  t.after(() => rm(cloudData, { recursive: true, force: true }));
  const quark = createQuark({ store: { meta: key => metadata.get(key), setMeta: (key, value) => metadata.set(key, value) }, dataDir: cloudData, searchRequest: quarkSearchPool.request, request: async value => {
    const url = new URL(value); assert.equal(url.origin, 'https://drive.quark.cn'); quarkReads.push(url.pathname);
    const data = url.pathname.endsWith('/token') ? { stoken: 'fixture-token' } : { list: [{ fid: 'video', file_name: '测试影片.2025.mp4', size: 1024, file: true }] };
    return Object.assign(Readable.from([JSON.stringify({ code: 0, status: 200, data })]), { statusCode: 200, headers: {} });
  } });
  const { app, call, login } = await running(t, { initialConfig: { ...empty, sources: [source] }, quarkSearchPool, quark });
  assert.equal(app.quarkSearch, quarkSearchPool);
  assert.equal((await call('/api/quark/settings')).status, 401);
  const cookie = await login();
  assert.deepEqual((await (await call('/api/quark/settings', undefined, cookie)).json()).searchPool, poolStatus);
  const resources = await call('/api/quark/resources?source=demo&id=1', undefined, cookie);
  assert.equal(resources.status, 200); const body = await resources.json(); assert.equal(body.resources.length, 1); assert.equal(body.resourceSnapshot, true);
  assert.deepEqual(quarkReads, ['/1/clouddrive/share/sharepage/token', '/1/clouddrive/share/sharepage/detail']);
  assert.equal(searches, 1);
});

test('explicit public webpage discovery is a validated option on the authenticated resource route', async t => {
  const options = [], source = { id: 'demo', name: '演示', api: 'https://source.example/api', enabled: true };
  const { call, login } = await running(t, { initialConfig: { ...empty, sources: [source] },
    quark: { resources: async (_, input) => { options.push(input); return { resources: [] }; } } });
  const path = '/api/quark/resources?source=demo&id=1';
  assert.equal((await call(path + '&web=1')).status, 401);
  const cookie = await login();
  assert.equal((await call(path + '&web=https://example.com', undefined, cookie)).status, 400);
  assert.equal(options.length, 0);
  assert.equal((await call(path + '&web=1', undefined, cookie)).status, 200);
  assert.deepEqual(options[0], { line: 0, episode: 0, webSearch: true });
  assert.equal((await call(path, undefined, cookie)).status, 200);
  assert.deepEqual(options[1], { line: 0, episode: 0 });
  assert.equal((await call(path + '&web=1&poll=1', undefined, cookie)).status, 200);
  assert.deepEqual(options[2], { line: 0, episode: 0, webSearch: true, poll: true });
  assert.equal((await call(path + '&poll=wrong', undefined, cookie)).status, 400);
  assert.equal(options.length, 3);
});

test('standalone Quark library uses trusted public metadata without a VOD source and permits only explicit single-file transfers', async t => {
  const film = { ...detail, key: 'quark-library:12345', source: 'quark-library', id: '12345', title: '独立影片', year: '2026', category: 'movie', douban: { id: '12345', score: 8.5 }, lines: [{ name: '夸克网盘', episodes: [{ name: '正片' }] }] };
  const calls = [], browseCalls = [];
  const quarkCatalog = { browse: async input => { browseCalls.push(input); return { items: [film], facets: { genres: ['喜剧'], years: ['2026'] }, hasMore: false, errors: [] }; }, detail: async id => {
    if (id !== film.id) throw Object.assign(new Error('无此可信豆瓣影片'), { status: 404 });
    return structuredClone(film);
  }, stop: async () => { calls.push(['stop']); } };
  const quark = { resources: async (value, options) => { calls.push(['resources', value, options]); return { resources: [{ id: 'share', name: '独立影片' }], resourceSnapshot: true }; },
    files: async (value, options) => { calls.push(['files', value, options]); return { files: [{ id: 'file', name: '独立影片.mp4' }] }; },
    prepare: async (value, options) => { calls.push(['prepare', value, options]); return { assetId: 'a'.repeat(32), status: 'ready', saved: true, position: 0, duration: 0 }; } };
  const ordinary = { detail: async () => { throw new Error('independent library must not query a VOD source'); } };
  const { app, call, login } = await running(t, { initialConfig: empty, catalog: ordinary, quarkCatalog, quark });
  for (const path of ['/api/quark/library', '/api/quark/library/detail?id=12345', '/api/quark/resources?source=quark-library&id=12345']) assert.equal((await call(path)).status, 401);
  assert.equal(browseCalls.length, 0); const cookie = await login();
  const listing = await call('/api/quark/library?category=movie&genre=喜剧&year=2026&sort=release-score&page=2', undefined, cookie);
  assert.equal(listing.status, 200); assert.equal((await listing.json()).items[0].douban.score, 8.5);
  assert.deepEqual(browseCalls[0], { category: 'movie', genre: '喜剧', year: '2026', sort: 'release-score', page: '2' });
  const ratings = await call('/api/ratings?source=quark-library&id=12345', undefined, cookie);
  assert.equal(ratings.status, 200); const rated = await ratings.json(); assert.equal(rated.douban.score, 8.5); assert.equal(rated.douban.url, 'https://movie.douban.com/subject/12345/'); assert.match(rated.douban.attribution, /豆瓣公开/);
  assert.equal((await call('/api/quark/library/detail?id=12345', undefined, cookie)).status, 200);
  assert.equal((await call('/api/quark/library/detail?id=https://evil.example/', undefined, cookie)).status, 400);
  assert.equal((await call('/api/quark/library/detail?id=54321', undefined, cookie)).status, 404);
  const selected = 'source=quark-library&id=12345';
  assert.equal((await call('/api/quark/resources?' + selected + '&web=1', undefined, cookie)).status, 200);
  assert.equal(calls.at(-1)[1].title, '独立影片'); assert.equal(calls.at(-1)[2].webSearch, true);
  assert.equal((await call('/api/quark/files?' + selected + '&shareId=share', undefined, cookie)).status, 200);
  const selection = { source: film.source, id: film.id, shareId: 'share', fileId: 'file' };
  assert.equal((await call('/api/quark/prepare', { ...selection, auto: true }, cookie)).status, 400);
  assert.equal((await call('/api/quark/prepare', { source: film.source, id: film.id, auto: false }, cookie)).status, 400);
  assert.equal(calls.some(row => row[0] === 'prepare'), false);
  assert.equal((await call('/api/quark/prepare', selection, cookie)).status, 200);
  assert.equal(calls.at(-1)[2].auto, false); assert.equal(calls.at(-1)[2].fileId, 'file');
  assert.equal((await call('/api/quark/resources?' + selected + '&episode=1', undefined, cookie)).status, 400);
  const history = await call('/api/history', { ...film, quarkAsset: 'a'.repeat(32), episodeName: '独立影片.mp4', position: 55, duration: 100, url: '' }, cookie);
  assert.equal(history.status, 200); assert.equal(app.store.list('history')[0].quarkAsset, 'a'.repeat(32)); assert.equal(app.store.list('history')[0].url, undefined);
  film.douban.score = null;
  const unrated = await (await call('/api/ratings?source=quark-library&id=12345', undefined, cookie)).json(); assert.equal(unrated.douban, null); assert.match(unrated.errors.join(''), /暂无评分/);
});

test('registered cloud posters require login, support private caching and never accept a target URL', async t => {
  const body = Buffer.from([0xff, 0xd8, 0xff, 0xe0]), calls = [];
  let resolvePoster, started;
  const reading = new Promise(resolve => { started = resolve; });
  const { call, login } = await running(t, { quarkPosters: { get: async id => {
    calls.push(id);
    if (id === '54321') { started(); await new Promise(resolve => { resolvePoster = resolve; }); }
    return { body, type: 'image/jpeg', etag: '"fixture-poster"' };
  } } });
  const path = '/api/quark/library/poster?id=12345';
  assert.equal((await call(path)).status, 401); assert.equal(calls.length, 0);
  const cookie = await login(), poster = await call(path, undefined, cookie);
  assert.equal(poster.status, 200); assert.equal(poster.headers.get('content-type'), 'image/jpeg');
  assert.match(poster.headers.get('cache-control'), /^private/); assert.equal(poster.headers.get('etag'), '"fixture-poster"');
  assert.deepEqual(Buffer.from(await poster.arrayBuffer()), body);
  const head = await call(path, undefined, cookie, 'HEAD');
  assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(body.length)); assert.equal(await head.text(), '');
  assert.equal((await call(path, undefined, cookie, 'GET', { 'If-None-Match': '"fixture-poster"' })).status, 304);
  const before = calls.length;
  assert.equal((await call(path + '&url=http://127.0.0.1/private', undefined, cookie)).status, 400);
  assert.equal(calls.length, before);
  const pending = call('/api/quark/library/poster?id=54321', undefined, cookie);
  await reading; await call('/api/auth/logout', {}, cookie); resolvePoster();
  assert.equal((await pending).status, 401);
});

test('leaving a poster request cancels its upstream work without an error response', async t => {
  let started, cancelled;
  const reading = new Promise(resolve => { started = resolve; }), stopped = new Promise(resolve => { cancelled = resolve; });
  const { base, login } = await running(t, { quarkPosters: { get: async (_id, { signal }) => {
    started();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => { cancelled(); reject(signal.reason); }, { once: true }));
  } } });
  const cookie = await login(), controller = new AbortController();
  const request = fetch(base + '/api/quark/library/poster?id=12345', { headers: { Cookie: cookie }, signal: controller.signal });
  await reading; controller.abort(); await assert.rejects(request, { name: 'AbortError' });
  let timer;
  try { await Promise.race([stopped, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(Error('Poster work did not stop after navigation')), 1000); })]); }
  finally { clearTimeout(timer); }
});

test('independent cloud details and searches recheck visibility and login before returning metadata', async t => {
  const film = { ...detail, source: 'quark-library', id: '12345', category: 'adult' };
  const { call, login } = await running(t, { quarkCatalog: { detail: async () => film }, quark: { resources: async () => { throw Error('hidden metadata must not reach public search'); } } });
  const cookie = await login();
  assert.equal((await call('/api/quark/library/detail?id=12345', undefined, cookie)).status, 403);
  assert.equal((await call('/api/quark/resources?source=quark-library&id=12345', undefined, cookie)).status, 403);
});

test('Quark account authentication errors remain distinct from a revoked household session', async t => {
  const source = { id: 'demo', name: '演示', api: 'https://source.example/api', enabled: true };
  let upstreamStatus = 401;
  const quark = { files: async () => { throw Object.assign(new Error('夸克账号需要重新连接'), { status: upstreamStatus, quarkSafe: true, quarkAuth: true }); } };
  const { call, login } = await running(t, { initialConfig: { ...empty, sources: [source] }, quark });
  const path = '/api/quark/files?source=demo&id=1&shareId=share&line=0&episode=0';
  const anonymous = await call(path); assert.equal(anonymous.status, 401);
  assert.equal((await anonymous.json()).quarkAuth, undefined);
  const cookie = await login(), expiredCloud = await call(path, undefined, cookie);
  assert.equal(expiredCloud.status, 401); assert.equal((await expiredCloud.json()).quarkAuth, true);
  assert.equal((await (await call('/api/auth', undefined, cookie)).json()).authenticated, true);
  upstreamStatus = 403; const denied = await call(path, undefined, cookie);
  assert.equal(denied.status, 403); assert.equal((await denied.json()).quarkAuth, undefined);
  await call('/api/auth/logout', {}, cookie);
  const loggedOut = await call(path, undefined, cookie); assert.equal(loggedOut.status, 401);
  assert.equal((await loggedOut.json()).quarkAuth, undefined);
});

test('logout during a share directory read prevents further reads and candidate caching', async t => {
  let release, entered, continued = 0;
  const pending = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const source = { id: 'demo', name: '演示', api: 'https://source.example/api', enabled: true };
  const { call, login } = await running(t, { initialConfig: { ...empty, sources: [source] },
    quark: { files: async (_, options) => {
      entered(); await pending;
      if (options.valid) options.valid();
      continued++; return { files: [] };
    } } });
  t.after(release);
  const cookie = await login(), response = call('/api/quark/files?source=demo&id=1&shareId=share', undefined, cookie);
  await started;
  try { assert.equal((await call('/api/auth/logout', {}, cookie)).status, 200); } finally { release(); }
  const revoked = await response;
  assert.equal(revoked.status, 401); assert.equal((await revoked.json()).quarkAuth, undefined);
  assert.equal(continued, 0);
});

test('logout during delayed film lookup prevents a subsequent cloud transfer', async t => {
  let release, entered, transfers = 0;
  const pending = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const source = { id: 'demo', name: '演示', api: 'https://source.example/api', enabled: true };
  const { call, login } = await running(t, { initialConfig: { ...empty, sources: [source] },
    catalog: { detail: async () => { entered(); await pending; return detail; } },
    quark: { prepare: async () => { transfers++; return { status: 'ready' }; } } });
  const cookie = await login(), response = call('/api/quark/prepare', { source: 'demo', id: '1', auto: true }, cookie);
  await started; assert.equal((await call('/api/auth/logout', {}, cookie)).status, 200); release();
  assert.equal((await response).status, 401); assert.equal(transfers, 0);
});

test('static gzip and conditional cache preserve bytes, HEAD, representation tags and file updates', async t => {
  const { base, call } = await running(t);
  const raw = (path, headers = {}) => new Promise((resolve, reject) => {
    get(base + path, { headers }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
  const plain = await raw('/app.js', { 'Accept-Encoding': 'identity' });
  const compressed = await raw('/app.js', { 'Accept-Encoding': 'gzip' });
  assert.equal(compressed.status, 200); assert.equal(compressed.headers['content-encoding'], 'gzip');
  assert.deepEqual(gunzipSync(compressed.body), plain.body);
  assert(compressed.body.length < plain.body.length / 2); assert.equal(compressed.headers.vary, 'Accept-Encoding');
  assert.notEqual(plain.headers.etag, compressed.headers.etag);
  const revalidated = await raw('/app.js', { 'Accept-Encoding': 'gzip', 'If-None-Match': `W/${compressed.headers.etag}` });
  assert.equal(revalidated.status, 304); assert.equal(revalidated.body.length, 0);
  assert.equal((await raw('/app.js', { 'If-Modified-Since': plain.headers['last-modified'], 'Accept-Encoding': 'identity' })).status, 304);
  assert.equal((await raw('/app.js', { 'If-None-Match': '"different"', 'If-Modified-Since': 'Tue, 01 Jan 2099 00:00:00 GMT' })).status, 200);
  assert.equal((await raw('/app.js', { 'Accept-Encoding': 'gzip;q=0, identity' })).headers['content-encoding'], undefined);
  const head = await call('/app.js', undefined, undefined, 'HEAD', { 'Accept-Encoding': 'gzip' });
  assert.equal(head.status, 200); assert.equal(await head.text(), ''); assert.equal(Number(head.headers.get('content-length')), compressed.body.length);
  const name = `cache-test-${randomBytes(6).toString('hex')}.svg`;
  const file = fileURLToPath(new URL(`../public/${name}`, import.meta.url));
  t.after(() => rm(file, { force: true }));
  await writeFile(file, '<svg>first</svg>'); const before = await raw('/' + name);
  await writeFile(file, '<svg>second changed</svg>'); const after = await raw('/' + name, { 'If-None-Match': before.headers.etag });
  assert.equal(after.status, 200); assert.notEqual(after.headers.etag, before.headers.etag); assert.equal(after.body.toString(), '<svg>second changed</svg>');
});

test('progressive browsing/search forward their flag and private API responses stay uncached', async t => {
  const received = [];
  const mock = { ...catalog,
    async browse(_config, options) { received.push(options); return { groups: [], failedSources: [], complete: false, pendingSources: [] }; },
    async search(_config, q, options) { received.push({ q, ...options }); return { groups: [], failedSources: [], complete: true, pendingSources: [] }; } };
  const { call, login } = await running(t, { catalog: mock });
  assert.equal((await call('/api/browse?progressive=1')).status, 401);
  const cookie = await login();
  const browse = await call('/api/browse?category=movie&progressive=1', undefined, cookie);
  assert.equal(browse.headers.get('cache-control'), 'no-store'); assert.equal(browse.headers.get('etag'), null);
  assert.equal((await browse.json()).complete, false);
  await call('/api/search?q=sample&progressive=1', undefined, cookie);
  assert.equal(received[0].progressive, true); assert.deepEqual(received[1], { q: 'sample', progressive: true });
});

test('pending browse/search responses are rejected when their configured sources change', async t => {
  for (const route of ['/api/browse?progressive=1', '/api/search?q=sample&progressive=1']) {
    let release, entered;
    const blocked = new Promise(resolve => { release = resolve; });
    const began = new Promise(resolve => { entered = resolve; });
    const load = async () => { entered(); await blocked; return { groups: [], failedSources: [] }; };
    const { app, call, login } = await running(t, { catalog: { ...catalog, browse: load, search: load } });
    const cookie = await login(); const pending = call(route, undefined, cookie); await began;
    app.store.setConfig({ ...empty, sources: [{ id: 'new', name: '新增', api: 'https://example.org/api' }] });
    release(); assert.equal((await pending).status, 409);
  }
});

test('verified live listing omits unverified channels while preserving original playback line indices', async t => {
  const streams = [{ url: 'https://media.example/a.m3u8', status: 'error' }, { url: 'https://media.example/b.m3u8', status: 'ok' }];
  const result = { channels: [{ id: 'ready', streams }, { id: 'unknown', streams: [{ status: 'unknown' }] },
    { id: 'failed', streams: [{ status: 'error' }] }], probing: true, checkedStreams: 3, totalStreams: 4 };
  const live = { async list() { return structuredClone(result); }, start() {}, async stop() {} };
  const { call, login } = await running(t, { live });
  const cookie = await login();
  const response = await (await call('/api/live?verified=1', undefined, cookie)).json();
  assert.deepEqual(response.channels.map(channel => channel.id), ['ready']);
  assert.deepEqual(response.channels[0].streams, streams); assert.equal(response.channels[0].streams[1].status, 'ok');
  assert.equal(response.totalStreams, 4); assert.equal(response.checkedStreams, 3);
  assert.equal((await (await call('/api/live', undefined, cookie)).json()).channels.length, 3);
});

test('browse passes category, page and selected source to the configured catalog', async (t) => {
  let received;
  const { call, login } = await running(t, { catalog: { ...catalog, async browse(config, options) {
    received = { config, options };
    return { category: options.category, page: Number(options.page), groups: [], failedSources: [], hasMore: false };
  } } });
  const cookie = await login();
  const response = await call('/api/browse?category=anime&page=2&source=demo', undefined, cookie);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).page, 2);
  assert.deepEqual(received, { config: empty, options: { category: 'anime', page: '2', source: 'demo' } });
  assert.equal((await call('/api/browse?category=tv&genre=%E5%96%9C%E5%89%A7&year=2024&sort=release', undefined, cookie)).status, 200);
  assert.deepEqual(received.options, { category: 'tv', page: '1', source: undefined, genre: '喜剧', year: '2024', sort: 'release' });
});

test('live playback and compatible playback use the verified quality variant while reports keep the original line', async t => {
  const stream = { url: 'https://media.example/master.m3u8?token=origin', playbackUrl: 'https://media.example/1080.m3u8?token=high', type: 'hls', status: 'ok' };
  let reported, transcoded;
  const live = { async list() { return { channels: [{ id: 'hd', streams: [stream] }] }; }, start() {}, async stop() {}, report(url) { reported = url; } };
  const transcoder = { async start(options) { transcoded = options.episode; return { id: 'test' }; }, async stop() {} };
  const { call, login } = await running(t, { live, transcoder });
  const cookie = await login();
  const result = await (await call('/api/live/playback?id=hd&line=0', undefined, cookie)).json();
  assert.equal(result.url, stream.playbackUrl);
  assert.equal((await call('/api/transcode/start', { liveId: 'hd', line: 0 }, cookie)).status, 200);
  assert.equal(transcoded.url, stream.playbackUrl);
  assert.equal((await call('/api/live/report', { id: 'hd', line: 0, status: 'ok' }, cookie)).status, 200);
  assert.equal(reported, stream.url);
});

test('builtin source presets can be merged without deleting customized sources', async (t) => {
  const builtin = { id: 'builtin', name: '内置样例', api: 'https://example.com/builtin' };
  const custom = { id: 'custom', name: '自定义样例', api: 'https://example.com/custom' };
  const { call, login } = await running(t, { initialConfig: { ...empty, sources: [builtin] } });
  const cookie = await login();
  assert.equal((await call('/api/config', { ...empty, sources: [custom] }, cookie, 'PUT')).status, 200);
  const presets = await (await call('/api/config/presets', undefined, cookie)).json();
  assert.deepEqual(presets, { api_site: { builtin: { name: builtin.name, api: builtin.api } } });
  const response = await call('/api/config/import', { config: presets }, cookie);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).sources.map(item => item.id), ['custom', 'builtin']);
});

test('upgrading an empty legacy config seeds sources once and preserves later user changes', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'vipvideo-upgrade-'));
  const legacy = createStore(dataDir, empty);
  legacy.close();
  const seeded = { ...empty, sources: [{ id: 'builtin', name: '内置样例', api: 'https://example.com/api' }] };
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  app = createApp({ password: 'test-password', dataDir, initialConfig: seeded, catalog });
  assert.equal(app.store.config().sources[0].id, 'builtin');
  app.store.setConfig(empty);
  await app.close(); app = null;
  app = createApp({ password: 'test-password', dataDir, initialConfig: seeded, catalog });
  assert.deepEqual(app.store.config().sources, []);
  app.store.setConfig({ ...empty, sources: [{ id: 'custom', name: '自定义', api: 'https://example.com/custom' }] });
  app.store.setMeta('builtin-sources-v1', '');
  await app.close(); app = null;
  app = createApp({ password: 'test-password', dataDir, initialConfig: seeded, catalog });
  assert.equal(app.store.config().sources[0].id, 'custom');
});

async function running(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'vipvideo-test-'));
  const app = createApp({ password: 'test-password', dataDir, initialConfig: empty, catalog, ...options });
  await new Promise((ok) => app.server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const call = (path, body, cookie, method = body === undefined ? 'GET' : 'POST', headers = {}) => fetch(base + path, {
    method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const login = async () => {
    const response = await call('/api/auth/login', { password: 'test-password' });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  };
  return { app, call, login, dataDir, base };
}

test('authentication protects all data and proxy endpoints; logout revokes cookie', async (t) => {
  const { call, login } = await running(t);
  for (const path of ['/api/config', '/api/config/presets', '/api/browse?category=movie', '/api/search?q=film', '/api/detail?source=demo&id=1', '/api/state', '/api/media?token=anything']) {
    assert.equal((await call(path)).status, 401);
  }
  assert.equal((await call('/health')).status, 200);
  assert.deepEqual(await (await call('/api/auth')).json(), { authenticated: false });
  const response = await call('/api/auth/login', { password: 'test-password' });
  const header = response.headers.get('set-cookie');
  assert.match(header, /HttpOnly/); assert.match(header, /SameSite=Lax/); assert.doesNotMatch(header, /test-password/);
  const cookie = await login();
  assert.equal((await call('/api/config', undefined, cookie)).status, 200);
  assert.equal((await call('/api/auth/logout', {}, cookie)).status, 200);
  assert.equal((await call('/api/config', undefined, cookie)).status, 401);
});

test('bad login is rate limited and foreign origins cannot mutate', async (t) => {
  const { call, login } = await running(t);
  for (let i = 0; i < 5; i++) assert.equal((await call('/api/auth/login', { password: 'bad' })).status, 401);
  assert.equal((await call('/api/auth/login', { password: 'test-password' })).status, 429);
  // Login from another fresh instance avoids relying on the limiter's clock.
  const second = await running(t);
  const cookie = await second.login();
  assert.equal((await second.call('/api/config', empty, cookie, 'PUT', { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await second.call('/api/config', empty, cookie, 'PUT', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await second.call('/api/config', empty, cookie, 'PUT')).status, 200);
});

test('config import is atomic; collections sync and last saved position wins', async (t) => {
  const { call, login } = await running(t);
  const cookie = await login();
  const valid = { config: { api_site: { demo: { name: '示例', api: 'https://example.com/api' } } } };
  assert.equal((await call('/api/config/import', valid, cookie)).status, 200);
  assert.equal((await call('/api/config/import', { config: { api_site: { demo: { name: '坏源', api: 'file:///secret' } } } }, cookie)).status, 400);
  assert.equal((await (await call('/api/config', undefined, cookie)).json()).sources[0].name, '示例');
  assert.equal((await call('/api/favorites', detail, cookie)).status, 200);
  assert.equal((await call('/api/history', { ...detail, position: 90, duration: 100 }, cookie)).status, 200);
  assert.equal((await call('/api/history', { ...detail, position: 20, duration: 100 }, cookie)).status, 200);
  let state = await (await call('/api/state', undefined, cookie)).json();
  assert.equal(state.favorites.length, 1); assert.equal(state.history[0].position, 20);
  assert.equal((await call('/api/history', { key: 'link:https://example.org/', title: '解析网页', url: 'https://example.org/', mode: 'parser' }, cookie)).status, 200);
  assert.equal((await call('/api/history?key=film', undefined, cookie, 'DELETE')).status, 200);
  state = await (await call('/api/state', undefined, cookie)).json();
  assert.equal(state.history.length, 1); assert.equal(state.history[0].mode, 'parser');
});

test('hiding adult records applies to every collection endpoint and preserves them for later', async (t) => {
  const { app, call, login } = await running(t);
  const cookie = await login();
  const limited = { ...detail, key: 'limited-fixture', title: '限制级样例', category: 'adult' };
  for (const kind of ['favorites', 'history']) {
    assert.equal((await call(`/api/${kind}`, { ...detail, category: 'movie' }, cookie)).status, 200);
    assert.equal((await call(`/api/${kind}`, { ...limited, position: 42 }, cookie)).status, 200);
    assert.deepEqual((await (await call(`/api/${kind}`, undefined, cookie)).json()).map(row => row.key), ['film']);
    assert.equal(app.store.list(kind).length, 2);
  }
  let state = await (await call('/api/state', undefined, cookie)).json();
  assert.equal(state.favorites.length, 1); assert.equal(state.history.length, 1);
  assert.equal((await call('/api/config', { ...empty, showAdult: true }, cookie, 'PUT')).status, 200);
  state = await (await call('/api/state', undefined, cookie)).json();
  assert.equal(state.favorites.length, 2); assert.equal(state.history.find(row => row.key === limited.key).position, 42);
  assert.equal((await call('/api/config/import', { config: { api_site: {} } }, cookie)).status, 200);
  assert.equal((await (await call('/api/config', undefined, cookie)).json()).showAdult, true);
  assert.equal((await call('/api/config', empty, cookie, 'PUT')).status, 200);
  for (const kind of ['favorites', 'history']) {
    assert.deepEqual((await (await call(`/api/${kind}`, undefined, cookie)).json()).map(row => row.key), ['film']);
    assert.equal(app.store.list(kind).length, 2);
  }
});

test('closing adult visibility during an upstream request rechecks every response before returning', async (t) => {
  const limited = { ...detail, key: 'limited-fixture', title: '限制级样例', category: 'adult' };
  const normal = { ...detail, source: 'normal', category: 'movie' };
  for (const path of ['/api/browse?category=adult', '/api/search?q=fixture', '/api/detail?source=demo&id=1', '/api/playback?source=demo&id=1']) {
    let started, release;
    const pendingSource = new Promise(resolve => { release = resolve; });
    const sourceStarted = new Promise(resolve => { started = resolve; });
    const pause = async () => { started(); await pendingSource; };
    const mixed = { ...limited, key: normal.key, items: [limited, normal] };
    const blockedCatalog = {
      async browse() { await pause(); return { category: 'adult', page: 1, groups: [mixed], failedSources: [], hasMore: false }; },
      async search() { await pause(); return { groups: [{ ...limited, items: [limited] }, mixed], failedSources: [] }; },
      async detail() { await pause(); return limited; },
    };
    const { call, login } = await running(t, { initialConfig: { ...empty, showAdult: true }, catalog: blockedCatalog });
    const cookie = await login();
    const pending = call(path, undefined, cookie);
    await sourceStarted;
    assert.equal((await call('/api/config', empty, cookie, 'PUT')).status, 200);
    release();
    const response = await pending;
    if (path.includes('/search')) {
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.groups.length, 1);
      assert.equal(result.groups[0].category, 'movie');
      assert.equal(result.groups[0].title, normal.title);
      assert.deepEqual(result.groups[0].items.map(item => item.source), ['normal']);
    } else {
      assert.equal(response.status, 403, path);
      assert.match((await response.json()).error, /三级内容已隐藏/);
    }
  }
});

test('SQLite survives close/reopen; changed password revokes previous sessions', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'vipvideo-persist-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const first = createApp({ password: 'original-password', dataDir, initialConfig: empty });
  first.store.save('history', { key: 'film', title: '持久化', position: 40 });
  first.store.setConfig({ ...empty, sources: [{ id: 'demo', name: '示例', api: 'https://example.com', enabled: true }] });
  first.store.session('old-token', Date.now() + 60_000);
  await first.close();
  const reopened = createApp({ password: 'original-password', dataDir, initialConfig: empty });
  assert.equal(reopened.store.list('history')[0].position, 40);
  assert.equal(reopened.store.config().sources[0].id, 'demo');
  assert.equal(reopened.store.authenticated('old-token'), true);
  await reopened.close();
  const rotated = createApp({ password: 'changed-password', dataDir, initialConfig: empty });
  assert.equal(rotated.store.authenticated('old-token'), false);
  assert.equal(rotated.store.list('history').length, 1);
  await rotated.close();
});

test('playback accepts only an episode selection, not a free proxy URL', async (t) => {
  const { call, login } = await running(t);
  const cookie = await login();
  const response = await call('/api/playback?source=demo&id=1&line=0&episode=0', undefined, cookie);
  assert.equal(response.status, 200);
  assert.match((await response.json()).proxyUrl, /^\/api\/media\?token=/);
  assert.equal((await call('/api/playback?source=demo&id=1&line=-1', undefined, cookie)).status, 400);
  assert.equal((await call('/api/media?url=https://example.com', undefined, cookie)).status, 403);
});
