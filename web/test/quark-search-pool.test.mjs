import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, PassThrough } from 'node:stream';
import { createQuarkSearchPool } from '../lib/quark-search-pool.mjs';
import { createQuarkSearchRequest } from '../lib/quark-search.mjs';
import { createRequest, readText } from '../lib/network.mjs';

const KEY = 'quark-search-pool-v1';
const official = 'https://so.252035.xyz/api/search', backup = 'https://backup.example/api/search';
const quarkUrl = 'https://pan.quark.cn/s/abcdef123456';
const json = (url = quarkUrl) => JSON.stringify({ code: 0, data: { results: [{ title: '资源名称', links: [{ type: 'quark', url, password: '1234' }] }] } });
const response = (body, statusCode = 200) => Object.assign(Readable.from([body]), { statusCode, headers: {} });
const rss = url => `<rss><channel><item><link>${url || 'https://example.org'}</link></item></channel></rss>`;
const flush = async () => { for (let index = 0; index < 5; index++) await new Promise(done => setImmediate(done)); };
function fixture({ request, discoveryRequest, saved, now = Date.now } = {}) {
  const metadata = new Map(saved ? [[KEY, JSON.stringify(saved)]] : []), calls = [], discoveryCalls = [];
  const store = { meta: key => metadata.get(key), setMeta: (key, value) => metadata.set(key, value) };
  const pool = createQuarkSearchPool({ store, now,
    request: async (url, options) => { calls.push({ url, options }); return request ? request(url, options) : response(json()); },
    discoveryRequest: async (url, options) => {
      discoveryCalls.push({ url, options });
      if (discoveryRequest) return discoveryRequest(url, options);
      if (url.includes('api.github.com')) return response(JSON.stringify({ homepage: 'https://published.example/' }));
      if (url.includes('raw.githubusercontent.com')) return response('Published endpoint https://readme.example/api/search');
      return response(rss('https://rss.example/api/search'));
    },
  });
  return { pool, metadata, store, calls, discoveryCalls };
}
const savedBackup = now => ({ candidates: [{ url: backup, automatic: true, status: 'healthy', addedAt: now - 100, checkedAt: now - 1, failures: 0, retryAt: 0 }] });
const lookup = async (pool, url = 'https://manual.example/api/search?kw=电影') => JSON.parse(await readText(await pool.request(url, { headers: { Cookie: 'user-cookie', Authorization: 'user-token' } })));

test('public metadata, README and RSS add bounded candidates and only compatible searches with Quark links establish health', async () => {
  const f = fixture({ request: url => response(new URL(url).hostname === 'so.252035.xyz' ? '{"status":"ok","auth_enabled":false}' : json()) });
  try {
    await f.pool.discover();
    const status = f.pool.status();
    assert.equal(f.discoveryCalls.length, 3); assert.equal(f.calls.length, 2);
    assert.ok(status.candidates.some(row => row.apiUrl === 'https://readme.example/api/search' && row.status === 'pending'));
    assert.ok(status.candidates.some(row => row.apiUrl === 'https://rss.example/api/search' && row.status === 'pending'));
    assert.ok(status.candidates.some(row => row.apiUrl === official && row.status === 'paused'));
    assert.ok(status.candidates.some(row => row.apiUrl === 'https://published.example/api/search' && row.status === 'healthy'));
    assert.equal(status.healthy, 1); assert.equal(status.suspended, 1);
    assert.ok(f.calls.every(call => new URL(call.url).searchParams.get('conc') === '1'));
    assert.ok([...f.calls, ...f.discoveryCalls].every(call => !/user-cookie|user-token|authorization|cookie/i.test(JSON.stringify(call.options))));
    await f.pool.discover(); assert.equal(f.discoveryCalls.length, 3);
  } finally { await f.pool.stop(); }
});

test('empty search JSON stays pending and HTML with a share cannot become a healthy API', async () => {
  const f = fixture({ request: url => response(new URL(url).hostname === 'so.252035.xyz' ? '{"results":[]}' : `<html>${quarkUrl}</html>`) });
  try {
    await f.pool.discover();
    assert.equal(f.pool.status().healthy, 0);
    assert.equal(f.pool.status().candidates.find(row => row.apiUrl === official).status, 'pending');
    assert.equal(f.pool.status().candidates.find(row => row.apiUrl.includes('published.example')).status, 'paused');
  } finally { await f.pool.stop(); }
});

test('failed primaries are temporarily skipped, backups survive restart, and the current configured primary recovers automatically', async () => {
  let clock = 1000, broken = true;
  const f = fixture({ now: () => clock, saved: savedBackup(clock), request: url => response(new URL(url).hostname === 'manual.example' && broken ? 'private remote failure user-token <html>' : json(), new URL(url).hostname === 'manual.example' && broken ? 503 : 200) });
  let restarted;
  try {
    assert.equal((await lookup(f.pool)).results.length, 1);
    assert.equal(f.calls.filter(call => call.url.includes('manual.example')).length, 1);
    await lookup(f.pool); assert.equal(f.calls.filter(call => call.url.includes('manual.example')).length, 1);
    const view = JSON.stringify(f.pool.status()); assert.equal(view.includes('user-token'), false); assert.equal(view.includes('<html>'), false);
    await f.pool.stop();
    const calls = [];
    restarted = createQuarkSearchPool({ store: f.store, now: () => clock, request: async url => { calls.push(url); return response(json()); }, discoveryRequest: () => assert.fail('restart does not synchronously fetch public directories') });
    await lookup(restarted); assert.ok(calls.every(url => !url.includes('manual.example')));
    clock += 15 * 60_000 + 1; broken = false;
    await lookup(restarted); assert.ok(calls.some(url => url.includes('manual.example')));
    assert.equal(restarted.status().candidates.find(row => row.apiUrl.includes('manual.example')).status, 'healthy');
    const before = calls.length;
    await lookup(restarted, 'https://changed.example/api/search?kw=新影片');
    assert.ok(calls.slice(before).some(url => url.includes('changed.example')));
    assert.ok(calls.slice(before).every(url => !url.includes('manual.example')));
  } finally { await f.pool.stop(); await restarted?.stop(); }
});

test('empty successful searches preserve health and public RSS supplies results when APIs have no matching resource', async () => {
  const f = fixture({ saved: savedBackup(Date.now()), request: url => response(url.includes('bing.com') ? rss(quarkUrl) : '{"results":[]}') });
  try {
    const result = await lookup(f.pool);
    assert.equal(result.results[0].url, quarkUrl);
    assert.equal(f.pool.status().candidates.find(row => row.apiUrl === backup).status, 'healthy');
    const fallback = new URL(f.calls.at(-1).url); assert.equal(fallback.searchParams.get('q'), '电影 site:pan.quark.cn/s');
  } finally { await f.pool.stop(); }
});

test('a healthy fast primary returns before a slow backup and stop waits for the backup without further persistence', async () => {
  let clock = 1000, release;
  const f = fixture({ now: () => clock, saved: savedBackup(clock), request: url => url.includes('backup.example') ? new Promise(done => { release = done; }) : response(json()) });
  try {
    assert.equal((await lookup(f.pool)).results.length, 1);
    assert.equal(f.calls.length, 2); assert.equal(typeof release, 'function');
    let stopped = false; const pending = f.pool.stop().then(() => { stopped = true; });
    await flush(); assert.equal(stopped, false);
    const saved = f.metadata.get(KEY);
    clock = 2000; release(response(json())); await pending;
    assert.equal(stopped, true);
    assert.equal(f.metadata.get(KEY), saved);
  } finally { await f.pool.stop(); }
});

test('six-hour background health verification restores a paused automatic backup without rediscovering directories', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  let broken = true;
  const f = fixture({ saved: { ...savedBackup(Date.now()), lastDiscovery: Date.now() }, request: url => {
    if (url.includes('bing.com')) return response(rss(quarkUrl));
    if (url.includes('backup.example')) return response(broken ? 'offline' : json(), broken ? 503 : 200);
    return response('{"results":[]}');
  } });
  try {
    await lookup(f.pool); assert.equal(f.pool.status().candidates.find(row => row.apiUrl === backup).status, 'paused');
    f.pool.start(); t.mock.timers.tick(0); await flush();
    broken = false; t.mock.timers.tick(6 * 60 * 60_000); await flush();
    assert.equal(f.pool.status().candidates.find(row => row.apiUrl === backup).status, 'healthy');
    assert.equal(f.discoveryCalls.length, 0);
    assert.equal(JSON.parse(f.metadata.get(KEY)).candidates.find(row => row.url === backup).failures, 0);
  } finally { await f.pool.stop(); }
});

test('pending or repeatedly failed automatic records cannot fill the pool and block a new endpoint or remove the manual primary', async () => {
  let clock = 1000;
  const candidates = Array.from({ length: 8 }, (_, index) => ({ url: `https://old${index}.example/api/search`, automatic: true, status: 'pending', failures: 0, addedAt: index + 1, checkedAt: 0, retryAt: 0 }));
  const f = fixture({ now: () => clock, saved: { candidates }, request: url => response(url.includes('manual.example') ? 'bad' : url.includes('bing.com') ? rss() : json()) });
  try {
    await lookup(f.pool); clock++;
    await f.pool.discover();
    const rows = f.pool.status().candidates;
    assert.ok(rows.length <= 8); assert.ok(rows.some(row => row.apiUrl.includes('published.example')));
    assert.ok(rows.some(row => row.apiUrl.includes('manual.example')));
    assert.ok(rows.some(row => row.apiUrl.includes('readme.example')));
  } finally { await f.pool.stop(); }
});

test('one 7.5-second budget leaves time for RSS after two stalled APIs and destroys late responses', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const releases = [];
  const f = fixture({ saved: savedBackup(Date.now()), request: url => url.includes('bing.com') ? response(rss(quarkUrl)) : new Promise(done => releases.push(done)) });
  try {
    const pending = lookup(f.pool); await flush(); assert.equal(releases.length, 2);
    t.mock.timers.tick(5500); await flush();
    assert.equal((await pending).results[0].url, quarkUrl); assert.equal(Date.now(), 6500);
    assert.equal(f.calls.at(-1).options.timeout, 2000);
    for (const done of releases) { const late = response(json()); done(late); await flush(); assert.equal(late.destroyed, true); }
  } finally { await f.pool.stop(); }
});

test('a stalled RSS response cannot push API failover past 7.5 seconds', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const stalled = [];
  const f = fixture({ saved: savedBackup(Date.now()), request: () => { const stream = Object.assign(new PassThrough(), { statusCode: 200, headers: {} }); stream.write('{'); stalled.push(stream); return stream; } });
  try {
    const pending = assert.rejects(lookup(f.pool), /公开搜索接口和网页搜索暂不可用/); await flush();
    t.mock.timers.tick(5500); await flush(); assert.equal(stalled.length, 3);
    t.mock.timers.tick(2000); await pending;
    assert.equal(Date.now(), 8500); assert.ok(stalled.every(stream => stream.destroyed));
  } finally { await f.pool.stop(); }
});

test('all foreground requests share two network slots and caller credentials never reach the transport', async () => {
  let active = 0, peak = 0;
  const f = fixture({ saved: savedBackup(Date.now()), request: async (_url, options) => {
    assert.equal(/cookie|authorization|user-cookie|user-token/i.test(JSON.stringify(options)), false);
    peak = Math.max(peak, ++active); await new Promise(done => setImmediate(done)); active--; return response(json());
  } });
  try { await Promise.all([lookup(f.pool), lookup(f.pool), lookup(f.pool)]); assert.equal(peak, 2); }
  finally { await f.pool.stop(); }
});

test('local queue timeouts never suspend a healthy endpoint that did not receive a request', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const idle = 'https://idle.example/api/search';
  const saved = savedBackup(Date.now()); saved.candidates.push({ url: idle, automatic: false, status: 'healthy', addedAt: 1, checkedAt: 999, failures: 0, retryAt: 0 });
  const f = fixture({ saved, request: url => url.includes('bing.com') ? response(rss(quarkUrl)) : new Promise(() => {}) });
  try {
    const pending = Promise.all([lookup(f.pool, 'https://first.example/api/search?kw=一'), lookup(f.pool, 'https://second.example/api/search?kw=二'), lookup(f.pool, idle + '?kw=三')]);
    await flush(); t.mock.timers.tick(5500); await flush(); t.mock.timers.tick(200); await flush(); await pending;
    assert.ok(f.calls.every(call => !call.url.includes('idle.example')));
    assert.equal(f.pool.status().candidates.find(row => row.apiUrl === idle).status, 'healthy');
    assert.equal(JSON.parse(f.metadata.get(KEY)).candidates.find(row => row.url === idle).failures, 0);
  } finally { await f.pool.stop(); }
});

test('stop after acquiring work slots prevents dispatch and any persistence', async () => {
  const f = fixture({ saved: savedBackup(Date.now()) }), saved = f.metadata.get(KEY);
  const pending = assert.rejects(lookup(f.pool), /公开搜索已停止/);
  for (let count = 0; count < 3; count++) await Promise.resolve();
  assert.equal(f.calls.length, 0);
  await f.pool.stop(); await pending;
  assert.equal(f.calls.length, 0); assert.equal(f.metadata.get(KEY), saved);
  assert.equal(f.pool.status().candidates.find(row => row.apiUrl === backup).status, 'healthy');
});

test('long encoded movie titles fit the existing request URL budget and never appear in the public pool status', async () => {
  const title = '电影'.repeat(150), url = 'https://manual.example/api/search?' + new URLSearchParams({ kw: title });
  assert.ok(url.length > 2048);
  const f = fixture();
  try {
    assert.equal((await lookup(f.pool, url)).results.length, 1);
    assert.equal(new URL(f.calls[0].url).searchParams.get('kw'), title);
    assert.equal(JSON.stringify(f.pool.status()).includes(title), false);
  } finally { await f.pool.stop(); }
});

test('public discovery and query URLs reject credentials, private literals and DNS rebinding while retaining only the exact existing sidecar exception', async () => {
  let publicCalls = 0;
  const guarded = createRequest({ lookup: async () => [{ address: '172.20.0.5', family: 4 }], httpRequest: () => assert.fail('private address must never be connected'), httpsRequest: () => assert.fail('private address must never be connected') });
  const search = createQuarkSearchRequest({ request: guarded, httpTransport: () => { throw new Error('fixture sidecar unavailable'); } });
  const f = fixture({ request: async (url, options) => { publicCalls++; return search(url, options); }, discoveryRequest: url => {
    if (url.includes('api.github.com')) return response('{"homepage":"http://127.0.0.1"}');
    return response('http://127.0.0.1/api/search https://bad.example/api/search?token=secret http://pansou:8888/api/search');
  } });
  try {
    for (const url of ['http://127.0.0.1/api/search?kw=x', 'http://PANSOU:8888/api/search?kw=x', 'http://pansou:8889/api/search?kw=x', 'https://public.example/api/search?kw=x&token=secret', 'https://user:secret@public.example/api/search?kw=x']) await assert.rejects(lookup(f.pool, url));
    assert.equal(publicCalls, 0);
    await f.pool.discover(); assert.equal(f.pool.status().candidates.length, 1);
    await assert.rejects(lookup(f.pool, 'https://rebind.example/api/search?kw=x'), /公开搜索接口和网页搜索暂不可用/);
    assert.equal(JSON.stringify(f.pool.status()).includes('secret'), false);
    await assert.rejects(lookup(f.pool, 'http://pansou:8888/api/search?kw=x'), /公开搜索接口和网页搜索暂不可用/);
    assert.ok(f.calls.some(call => call.url.startsWith('http://pansou:8888/api/search?')));
  } finally { await f.pool.stop(); }
});

test('stop waits for current jobs, scheduled discovery stays single flight, and the stopped pool accepts no further work', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  let release;
  const f = fixture({ discoveryRequest: () => new Promise(done => { release = done; }) });
  f.pool.start(); t.mock.timers.tick(0); await flush();
  const discovery = f.pool.discover(); assert.equal(f.discoveryCalls.length, 1);
  let stopped = false; const pending = f.pool.stop().then(() => { stopped = true; }); await flush(); assert.equal(stopped, false);
  release(response('{"homepage":"https://published.example/"}')); await discovery; await pending;
  assert.equal(stopped, true); assert.equal(f.pool.status().enabled, false);
  assert.equal(f.calls.length, 0); assert.equal(f.discoveryCalls.length, 1);
  t.mock.timers.tick(7 * DAY); await flush(); assert.equal(f.discoveryCalls.length, 1);
  await assert.rejects(lookup(f.pool), /公开搜索已停止/);
});

const DAY = 86_400_000;
