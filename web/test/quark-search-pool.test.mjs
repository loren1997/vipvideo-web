import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createQuarkSearchPool } from '../lib/quark-search-pool.mjs';
import { createQuarkSearchRequest } from '../lib/quark-search.mjs';
import { createRequest, readText } from '../lib/network.mjs';
import { searchGoogleQuark } from '../lib/quark-google-search.mjs';

const KEY = 'quark-search-pool-v1';
const official = 'https://so.252035.xyz/api/search', backup = 'https://backup.example/api/search';
const quarkUrl = 'https://pan.quark.cn/s/abcdef123456';
const json = (url = quarkUrl, title = '电影') => JSON.stringify({ code: 0, data: { results: [{ title, links: [{ type: 'quark', url, password: '1234' }] }] } });
const response = (body, statusCode = 200) => Object.assign(Readable.from([body]), { statusCode, headers: {} });
const rss = (url, title = '电影') => `<rss><channel><item><title>${title}</title><link>${url || 'https://example.org'}</link></item></channel></rss>`;
const flush = async () => { for (let index = 0; index < 5; index++) await new Promise(done => setImmediate(done)); };
function fixture({ request, discoveryRequest, googleSearch = async () => { throw new Error('Fixture Google search unavailable'); }, saved, now = Date.now } = {}) {
  const metadata = new Map(saved ? [[KEY, JSON.stringify(saved)]] : []), calls = [], discoveryCalls = [];
  const store = { meta: key => metadata.get(key), setMeta: (key, value) => metadata.set(key, value) };
  const pool = createQuarkSearchPool({ store, now, googleSearch,
    request: async (url, options) => { calls.push({ url, options }); return request ? request(url, options) : response(json(undefined, new URL(url).searchParams.get('kw') || '电影')); },
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

test('scheduled maintenance removes only automatic endpoints with failures spanning a day without new discovery', async t => {
  const day = 86_400_000, clock = 4 * day;
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: clock });
  const row = (url, changes = {}) => ({ url, automatic: true, status: 'paused', failures: 3, addedAt: day, firstFailedAt: day, checkedAt: 2 * day, retryAt: clock + 60_000, ...changes });
  const f = fixture({ saved: { lastDiscovery: clock, candidates: [
    row('https://expired.example/api/search'),
    row('https://transient.example/api/search', { firstFailedAt: clock - 1000, checkedAt: clock }),
    row('https://manual.example/api/search', { automatic: false }),
    row('http://pansou:8888/api/search', { automatic: false }),
  ] } });
  try {
    f.pool.start(); t.mock.timers.tick(0); await flush();
    const rows = f.pool.status().candidates;
    assert.ok(!rows.some(row => row.apiUrl.includes('expired.example')));
    for (const part of ['transient.example', 'manual.example', 'pansou:8888']) assert.ok(rows.some(row => row.apiUrl.includes(part)));
    assert.equal(f.discoveryCalls.length, 0);
    assert.ok(!JSON.parse(f.metadata.get(KEY)).candidates.some(row => row.url.includes('expired.example')));
  } finally { await f.pool.stop(); }
});

test('removed public interfaces stay retired for seven days while an explicit manual configuration remains usable', async () => {
  let clock = 4 * 86_400_000;
  const retiredUrl = 'https://expired.example/api/search';
  const f = fixture({ now: () => clock, saved: { retired: [{ url: retiredUrl, expires: clock + 7 * 86_400_000 }] }, discoveryRequest: url => response(url.includes('api.github.com') ? JSON.stringify({ homepage: 'https://expired.example/' }) : retiredUrl) });
  try {
    await f.pool.discover(); assert.ok(!f.pool.status().candidates.some(row => row.apiUrl === retiredUrl));
    const data = await lookup(f.pool, retiredUrl + '?kw=电影'); assert.equal(data.results.length, 1);
    const saved = JSON.parse(f.metadata.get(KEY));
    assert.equal(saved.candidates.find(row => row.url === retiredUrl).automatic, false);
    assert.ok(!saved.retired.some(row => row.url === retiredUrl));
    clock += 86_400_000; await f.pool.discover();
    assert.equal(JSON.parse(f.metadata.get(KEY)).candidates.find(row => row.url === retiredUrl).automatic, false);
  } finally { await f.pool.stop(); }
});

test('successful search clears the automatic endpoint failure window before later failures', async () => {
  let clock = 4 * 86_400_000;
  const f = fixture({ now: () => clock, saved: { candidates: [{ ...savedBackup(clock).candidates[0], failures: 2, firstFailedAt: clock - 86_400_000 }] } });
  try {
    await lookup(f.pool);
    const row = JSON.parse(f.metadata.get(KEY)).candidates.find(row => row.url === backup);
    assert.equal(row.failures, 0); assert.equal(row.firstFailedAt, undefined);
  } finally { await f.pool.stop(); }
});

test('rotating public repository metadata discovers deployment APIs but never calls an unverified candidate in the foreground', async () => {
  let clock = 4 * 86_400_000;
  const f = fixture({ now: () => clock, discoveryRequest: url => {
    if (url.includes('/search/repositories')) return response(JSON.stringify({ items: [
      { homepage: 'https://deployed.example/' }, { homepage: 'http://127.0.0.1/' }, { homepage: 'https://user:secret@unsafe.example/' },
    ] }));
    return response(url.includes('api.github.com') ? '{}' : '');
  } });
  try {
    await f.pool.discover();
    assert.ok(f.discoveryCalls.some(call => call.url.includes('/search/repositories')));
    assert.ok(f.pool.status().candidates.some(row => row.apiUrl === 'https://deployed.example/api/search'));
    assert.ok(f.pool.status().candidates.every(row => !/127\.0\.0\.1|unsafe/.test(row.apiUrl)));
    const saved = JSON.parse(f.metadata.get(KEY)), pending = saved.candidates.find(row => row.url.includes('deployed.example'));
    pending.status = 'pending';
    const foreground = fixture({ now: () => clock, saved });
    try { await lookup(foreground.pool); assert.ok(!foreground.calls.some(call => call.url.includes('deployed.example'))); }
    finally { await foreground.pool.stop(); }
    assert.ok(f.discoveryCalls.length <= 4); assert.ok(f.calls.length <= 2);
  } finally { await f.pool.stop(); }
});

test('documented Pansousuo API uses q and pan and validates items share URLs and access codes', async () => {
  const f = fixture({ request: url => {
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('q'), '遮天'); assert.equal(parsed.searchParams.get('pan'), 'quark'); assert.equal(parsed.searchParams.get('sort'), 'latest');
    assert.equal(parsed.searchParams.has('kw'), false);
    return response(JSON.stringify({ items: [
      { title: '遮天 4K', pan: 'quark', share_url: quarkUrl, access_code: 'abcd' },
      { title: '遮天', pan: 'baidu', share_url: quarkUrl },
      { title: '遮天', pan: 'quark', share_url: 'http://127.0.0.1/private' },
      { title: '遮天', pan: 'quark', share_url: 'https://user:secret@pan.quark.cn/s/abcdef123456' },
    ], total: 4 }));
  } });
  try {
    const data = await lookup(f.pool, 'https://www.pansousuo.com/api/search?kw=遮天');
    assert.equal(data.results.length, 1); assert.equal(data.results[0].name, '遮天 4K'); assert.equal(data.results[0].url, quarkUrl + '?pwd=abcd');
  } finally { await f.pool.stop(); }
});

test('Google reader follows public regional redirects with DNS checks and no household credentials', async () => {
  for (const target of ['https://www.google.com.hk/search', 'http://127.0.0.1/private', 'https://rebound.example/search']) {
    const calls = [], lookups = [];
    const transport = (url, options, callback) => {
      const outgoing = new EventEmitter();
      outgoing.destroy = error => { if (error) queueMicrotask(() => outgoing.emit('error', error)); };
      outgoing.end = () => queueMicrotask(() => {
        calls.push({ url: url.href, headers: options.headers });
        const incoming = url.hostname === 'www.google.com' ? response('', 301) : response(`<a href="${quarkUrl}">电影 夸克资源</a>`);
        if (url.hostname === 'www.google.com') incoming.headers.location = target;
        callback(incoming);
      });
      return outgoing;
    };
    const guarded = createRequest({ lookup: async hostname => {
      lookups.push(hostname); return [{ address: hostname === 'rebound.example' ? '192.168.1.2' : '8.8.8.8', family: 4 }];
    }, httpRequest: transport, httpsRequest: transport });
    const search = createQuarkSearchRequest({ request: guarded });
    const f = fixture({ request: (url, options) => search(url, options), googleSearch: searchGoogleQuark });
    try {
      const data = JSON.parse(await readText(await f.pool.request('https://manual.example/api/search?kw=电影', { webSearch: true, headers: { Cookie: 'secret-cookie', Authorization: 'secret-token' } })));
      if (target.includes('google.com.hk')) { assert.equal(data.results.length, 1); assert.ok(lookups.includes('www.google.com.hk')); }
      else { assert.equal(data.results.length, 0); assert.match(data.reason, /安全检查拒绝/); assert.ok(!calls.some(call => call.url === target)); }
      assert.ok(calls.every(call => !/secret-cookie|secret-token|cookie|authorization/i.test(JSON.stringify(call.headers))));
      assert.ok(f.calls.filter(call => call.url.includes('bing.com')).every(call => call.options.followRedirects === false));
    } finally { await f.pool.stop(); }
  }
});

test('public metadata, README and RSS add bounded candidates and only compatible searches with Quark links establish health', async () => {
  const f = fixture({ request: url => response(new URL(url).hostname === 'so.252035.xyz' ? '{"status":"ok","auth_enabled":false}' : json()) });
  try {
    await f.pool.discover();
    const status = f.pool.status();
    assert.equal(f.discoveryCalls.length, 4); assert.equal(f.calls.length, 2);
    assert.ok(status.candidates.some(row => row.apiUrl === 'https://readme.example/api/search' && row.status === 'pending'));
    assert.ok(status.candidates.some(row => row.apiUrl === 'https://rss.example/api/search' && row.status === 'pending'));
    assert.ok(status.candidates.some(row => row.apiUrl === official && row.status === 'paused'));
    assert.ok(status.candidates.some(row => row.apiUrl === 'https://published.example/api/search' && row.status === 'healthy'));
    assert.equal(status.healthy, 1); assert.equal(status.suspended, 1);
    assert.ok(f.calls.every(call => new URL(call.url).searchParams.get('conc') === '1'));
    assert.ok([...f.calls, ...f.discoveryCalls].every(call => !/user-cookie|user-token|authorization|cookie/i.test(JSON.stringify(call.options))));
    await f.pool.discover(); assert.equal(f.discoveryCalls.length, 4);
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
    const pending = lookup(f.pool); await flush();
    t.mock.timers.tick(5500); await flush(); assert.equal(stalled.length, 3);
    t.mock.timers.tick(2000); const result = await pending;
    assert.deepEqual(result.results, []); assert.match(result.reason, /超时/);
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
    await f.pool.discover(); assert.equal(f.pool.status().candidates.length, 3);
    assert.ok(f.pool.status().candidates.every(row => [official, 'https://pansou.252035.xyz/api/search', 'https://www.pansousuo.com/api/search'].includes(row.apiUrl)));
    const rebound = await lookup(f.pool, 'https://rebind.example/api/search?kw=x');
    assert.deepEqual(rebound.results, []); assert.match(rebound.reason, /安全检查拒绝/);
    assert.equal(JSON.stringify(f.pool.status()).includes('secret'), false);
    const sidecar = await lookup(f.pool, 'http://pansou:8888/api/search?kw=x');
    assert.deepEqual(sidecar.results, []); assert.match(sidecar.reason, /连接失败/);
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

test('complete titles are queried before year hints and weak or conflicting-year candidates stay visible', async () => {
  const f = fixture({ request: url => {
    const word = new URL(url).searchParams.get('kw');
    if (word === '电影 2026') return response(json('https://pan.quark.cn/s/wrong123456', '其他电影 2025'));
    assert.equal(word, '电影');
    return response(JSON.stringify({ results: [
      { name: '电影 (2026) 4K', url: quarkUrl },
      { name: '电影 2025 1080p', url: 'https://pan.quark.cn/s/old12345678' },
      { name: '另一个片名 2026', url: 'https://pan.quark.cn/s/other123456' },
    ] }));
  } });
  try {
    const result = await lookup(f.pool, 'https://manual.example/api/search?kw=' + encodeURIComponent('电影 2026'));
    assert.deepEqual(result.results.map(row => row.url), [quarkUrl, 'https://pan.quark.cn/s/old12345678', 'https://pan.quark.cn/s/other123456']);
    assert.deepEqual(f.calls.map(call => new URL(call.url).searchParams.get('kw')), ['电影']);
  } finally { await f.pool.stop(); }
});

test('explicit bounded aliases improve candidate ranking and English titles require complete word boundaries for relevance', async () => {
  const f = fixture({ request: url => {
    const word = new URL(url).searchParams.get('kw');
    return response(word === 'IT' ? JSON.stringify({ results: [
      { name: 'ＩＴ (2017) 4K', url: quarkUrl },
      { name: 'Reality (2017)', url: 'https://pan.quark.cn/s/wrong123456' },
      { name: 'It 1990', url: 'https://pan.quark.cn/s/old12345678' },
    ] }) : '{"results":[]}');
  } });
  try {
    const url = 'https://manual.example/api/search?kw=' + encodeURIComponent('小丑回魂 2017');
    const result = JSON.parse(await readText(await f.pool.request(url, { aliases: [null, 'IT', 'Bad\nAlias', '第二个别名', '不应搜索'], headers: { Cookie: 'user-cookie' } })));
    assert.deepEqual(result.results.map(row => row.url), [quarkUrl, 'https://pan.quark.cn/s/old12345678', 'https://pan.quark.cn/s/wrong123456']);
    assert.deepEqual(f.calls.map(call => new URL(call.url).searchParams.get('kw')), ['小丑回魂', 'IT']);
    assert.ok(f.calls.every(call => !JSON.stringify(call.options).includes('user-cookie')));
  } finally { await f.pool.stop(); }
});

test('fast APIs merge within 150 ms and duplicate share IDs retain the extraction password', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const another = 'https://pan.quark.cn/s/second123456';
  const f = fixture({ saved: savedBackup(Date.now()), request: async url => {
    if (!url.includes('backup.example')) return response(JSON.stringify({ results: [{ name: '电影', url: quarkUrl }] }));
    await new Promise(done => setTimeout(done, 100));
    return response(JSON.stringify({ results: [
      { name: '电影 4K', url: quarkUrl, password: '5678' },
      { name: '电影 HD', url: another },
      { name: '电影 duplicate', url: another + '?pwd=AB12' },
    ] }));
  } });
  try {
    let finished = false;
    const pending = lookup(f.pool).then(result => { finished = true; return result; });
    await flush(); t.mock.timers.tick(99); await flush(); assert.equal(finished, false);
    t.mock.timers.tick(1); await flush();
    const result = await pending;
    assert.equal(Date.now(), 1100); assert.equal(result.results.length, 2);
    assert.equal(result.results[0].url, quarkUrl + '?pwd=5678');
    assert.equal(result.results[1].url, another + '?pwd=AB12');
  } finally { await f.pool.stop(); }
});

test('a slow second API does not delay the first result and enriches a two-minute retry cache', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const another = 'https://pan.quark.cn/s/second123456';
  let release, delayed = true;
  const f = fixture({ saved: savedBackup(Date.now()), request: url => url.includes('backup.example') && delayed ? new Promise(done => { release = done; }) : response(json(url.includes('backup.example') ? another : quarkUrl)) });
  try {
    let finished = false;
    const pending = lookup(f.pool).then(result => { finished = true; return result; });
    await flush(); t.mock.timers.tick(149); await flush(); assert.equal(finished, false);
    t.mock.timers.tick(1); await flush(); assert.equal((await pending).results.length, 1);
    delayed = false; release(response(json(another))); await flush();
    assert.equal((await lookup(f.pool)).results.length, 2); assert.equal(f.calls.length, 2);
    t.mock.timers.tick(120_000);
    assert.equal((await lookup(f.pool)).results.length, 2); assert.equal(f.calls.length, 4);
  } finally { await f.pool.stop(); }
});

test('the retry cache stays bounded to 32 queries and is never persisted', async () => {
  const f = fixture();
  try {
    for (let index = 0; index < 33; index++) await lookup(f.pool, 'https://manual.example/api/search?kw=' + encodeURIComponent('影片' + index));
    assert.equal(f.calls.length, 33);
    await lookup(f.pool, 'https://manual.example/api/search?kw=' + encodeURIComponent('影片32'));
    assert.equal(f.calls.length, 33);
    await lookup(f.pool, 'https://manual.example/api/search?kw=' + encodeURIComponent('影片0'));
    assert.equal(f.calls.length, 34);
    assert.equal(f.metadata.get(KEY).includes('影片'), false);
    assert.equal(f.metadata.get(KEY).includes('pan.quark.cn'), false);
  } finally { await f.pool.stop(); }
});

test('concurrent requests for one film both receive their results while the cache remains replaceable', async () => {
  const f = fixture({ request: async () => { await new Promise(done => setImmediate(done)); return response(json()); } });
  try {
    const results = await Promise.all([lookup(f.pool), lookup(f.pool)]);
    assert.deepEqual(results.map(result => result.results.length), [1, 1]);
    assert.equal((await lookup(f.pool)).results.length, 1); assert.equal(f.calls.length, 2);
  } finally { await f.pool.stop(); }
});

test('RSS fallback ranks complete titles while retaining legal weak and unnamed candidates for review', async () => {
  const f = fixture({ request: url => response(url.includes('bing.com') ? '<rss><channel>' +
    `<item><title><![CDATA[电影 (2026) 4K]]></title><link>${quarkUrl}?pwd=1234</link></item>` +
    '<item><title>电影 2025</title><link>https://pan.quark.cn/s/old12345678</link></item>' +
    '<item><title>另一个片名 2026</title><link>https://pan.quark.cn/s/wrong123456</link></item>' +
    '<item><link>https://pan.quark.cn/s/unnamed12345</link></item></channel></rss>' : '{"results":[]}') });
  try {
    const result = await lookup(f.pool, 'https://manual.example/api/search?kw=' + encodeURIComponent('电影 2026'));
    assert.deepEqual(result.results.map(row => row.url), [quarkUrl + '?pwd=1234', 'https://pan.quark.cn/s/old12345678', 'https://pan.quark.cn/s/wrong123456', 'https://pan.quark.cn/s/unnamed12345']);
    assert.equal(result.results.at(-1).name, '未提供资源标题');
    assert.equal(new URL(f.calls.at(-1).url).searchParams.get('q'), '电影 site:pan.quark.cn/s');
  } finally { await f.pool.stop(); }
});

test('stop during a pending API prevents title and alias retries', async () => {
  let release;
  const f = fixture({ request: () => new Promise(done => { release = done; }) });
  const pending = assert.rejects(f.pool.request('https://manual.example/api/search?kw=' + encodeURIComponent('电影 2026'), { aliases: ['Movie'] }), /公开搜索已停止/);
  await flush(); assert.equal(typeof release, 'function');
  const saved = f.metadata.get(KEY), stopped = f.pool.stop();
  release(response('{"results":[]}')); await pending; await stopped;
  assert.equal(f.calls.length, 1); assert.equal(f.metadata.get(KEY), saved);
});

test('stop during pending RSS rejects a late result without cache or persistence writes', async () => {
  let release;
  const f = fixture({ request: url => url.includes('bing.com') ? new Promise(done => { release = done; }) : response('{"results":[]}') });
  const pending = assert.rejects(f.pool.request('https://manual.example/api/search?kw=' + encodeURIComponent('电影 2026'), { aliases: ['Movie'] }), /公开搜索已停止/);
  await flush(); assert.equal(typeof release, 'function');
  const before = f.calls.length, saved = f.metadata.get(KEY), stopped = f.pool.stop();
  release(response(rss(quarkUrl))); await pending; await stopped;
  assert.equal(f.calls.length, before); assert.equal(f.metadata.get(KEY), saved);
  await assert.rejects(lookup(f.pool), /公开搜索已停止/);
});

test('explicit web lookup skips APIs, shares two network slots and merges Google with RSS by date and share ID', async () => {
  let active = 0, peak = 0, googleCalls = 0;
  const at = Date.now();
  const latest = Date.parse('2026-10-13T00:00:00Z'), older = Date.parse('2026-09-01T00:00:00Z');
  const f = fixture({ now: () => at, saved: savedBackup(at), request: async (url, options) => {
    assert.equal(/cookie|authorization|user-cookie|user-token/i.test(JSON.stringify(options)), false);
    peak = Math.max(peak, ++active); await new Promise(done => setImmediate(done)); active--;
    return response(url.includes('bing.com') ? `<rss><channel><item><title>电影 2026</title><pubDate>Tue, 01 Sep 2026 00:00:00 GMT</pubDate><link>${quarkUrl}?pwd=1234</link></item><item><title>电影 4K</title><link>https://pan.quark.cn/s/unknown12345</link></item></channel></rss>` : '<html>public index</html>');
  }, googleSearch: async (keyword, { read, deadline, now }) => {
    googleCalls++; assert.equal(keyword, '电影'); assert.equal(deadline - now(), 7500);
    await read('https://www.google.com/search?q=' + encodeURIComponent(keyword), 3000, 512 * 1024, deadline);
    await read('https://index.example/movie', 3000, 512 * 1024, deadline);
    return [
      { name: '电影 (2026) 4K', url: quarkUrl, publishedAt: latest },
      { name: '电影 (2026) HD', url: 'https://pan.quark.cn/s/old12345678', publishedAt: older },
      { name: '电影 (2025)', url: 'https://pan.quark.cn/s/wrong123456', publishedAt: latest },
    ];
  } });
  try {
    const url = 'https://manual.example/api/search?kw=' + encodeURIComponent('电影 2026');
    const result = JSON.parse(await readText(await f.pool.request(url, { webSearch: true, headers: { Cookie: 'user-cookie' } })));
    assert.equal(googleCalls, 1); assert.equal(peak, 2);
    assert.ok(f.calls.every(call => !/manual\.example|backup\.example/.test(call.url)));
    assert.deepEqual(result.results.map(row => row.url), [quarkUrl + '?pwd=1234', 'https://pan.quark.cn/s/wrong123456', 'https://pan.quark.cn/s/old12345678', 'https://pan.quark.cn/s/unknown12345']);
    assert.deepEqual(result.results.map(row => row.publishedAt), [latest, latest, older, undefined]);
  } finally { await f.pool.stop(); }
});

test('successful API results avoid web scraping and preserve parent dates in newest-first stable order', async () => {
  const recent = Date.parse('2026-10-13T12:00:00Z');
  const f = fixture({ googleSearch: () => assert.fail('working APIs do not need Google'), request: () => response(JSON.stringify({ results: [
    { title: '电影', links: [{ type: 'quark', url: quarkUrl }] },
    { title: '电影 HD', datetime: '2025-01-01T00:00:00Z', links: [{ type: 'quark', url: 'https://pan.quark.cn/s/old12345678' }] },
    { title: '电影 4K', datetime: '2026-10-13T12:00:00Z', links: [{ type: 'quark', url: 'https://pan.quark.cn/s/latest123456' }] },
    { title: '电影 无日期', date: '2027', links: [{ type: 'quark', url: 'https://pan.quark.cn/s/unknown12345' }] },
  ] })) });
  try {
    const result = await lookup(f.pool);
    assert.deepEqual(result.results.map(row => row.url), ['https://pan.quark.cn/s/latest123456', 'https://pan.quark.cn/s/old12345678', quarkUrl, 'https://pan.quark.cn/s/unknown12345']);
    assert.equal(result.results[0].publishedAt, recent); assert.equal(f.calls.length, 1);
  } finally { await f.pool.stop(); }
});

test('web results survive one engine failing and API and web caches remain separate', async () => {
  let googleCalls = 0;
  const other = 'https://pan.quark.cn/s/second123456';
  const f = fixture({ request: url => response(url.includes('bing.com') ? 'blocked' : json(), url.includes('bing.com') ? 403 : 200), googleSearch: async () => { googleCalls++; return [{ name: '电影', url: other }]; } });
  try {
    assert.equal((await lookup(f.pool)).results[0].url, quarkUrl + '?pwd=1234'); assert.equal(googleCalls, 0);
    const web = JSON.parse(await readText(await f.pool.request('https://manual.example/api/search?kw=电影', { webSearch: true })));
    assert.equal(web.results[0].url, other); assert.equal(googleCalls, 1);
    await f.pool.request('https://manual.example/api/search?kw=电影', { webSearch: true }); assert.equal(googleCalls, 1);
    assert.equal((await lookup(f.pool)).results[0].url, quarkUrl + '?pwd=1234');
  } finally { await f.pool.stop(); }
});

test('unmatched APIs automatically use Google and its reads cannot exceed the remaining total budget', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const stalled = [];
  const f = fixture({ request: url => {
    if (url.includes('bing.com')) return response(rss(quarkUrl));
    const stream = Object.assign(new PassThrough(), { statusCode: 200, headers: {} }); stream.write('{'); stalled.push(stream); return stream;
  }, googleSearch: async (_keyword, { read, deadline }) => { await read('https://www.google.com/search?q=movie', 3000, 512 * 1024, deadline); return []; } });
  try {
    const pending = lookup(f.pool); await flush(); assert.equal(stalled.length, 1);
    t.mock.timers.tick(5500); await flush(); assert.equal(stalled.length, 2);
    assert.equal(f.calls.find(call => call.url.includes('google.com')).options.timeout, 2000);
    t.mock.timers.tick(2000); await flush();
    assert.equal((await pending).results[0].url, quarkUrl); assert.equal(Date.now(), 8500);
    assert.ok(stalled.every(stream => stream.destroyed));
  } finally { await f.pool.stop(); }
});

test('daily public discovery rotates wider Chinese queries and deployment sources with four bounded directory requests', async () => {
  let clock = Date.now();
  const f = fixture({ now: () => clock });
  try {
    const queries = [];
    for (let day = 0; day < 7; day++) {
      const before = f.discoveryCalls.length;
      await f.pool.discover(); assert.equal(f.discoveryCalls.length - before, 4);
      queries.push(new URL(f.discoveryCalls.at(-1).url).searchParams.get('q'));
      await f.pool.discover(); assert.equal(f.discoveryCalls.length - before, 4);
      clock += DAY + 1;
    }
    assert.equal(new Set(queries.slice(0, 6)).size, 6); assert.equal(queries[0], queries[6]);
    assert.ok(queries.some(query => query.includes('夸克'))); assert.ok(queries.some(query => query.includes('网盘搜索')));
    assert.equal(JSON.parse(f.metadata.get(KEY)).discoveryCursor, 7);
    assert.ok(f.pool.status().candidates.length <= 8);
  } finally { await f.pool.stop(); }
});

test('duplicate dated API shares keep the latest extraction code even when a newer post has no code', async () => {
  const old = { name: '电影 旧码', url: quarkUrl + '?pwd=OLD1', datetime: '2026-10-10T00:00:00Z' };
  const fresh = { name: '电影 新码', url: quarkUrl + '?pwd=NEW2', datetime: '2026-10-11T00:00:00Z' };
  const noCode = { name: '电影 最新帖子无码', url: quarkUrl, datetime: '2026-10-12T00:00:00Z' };
  for (const rows of [[old, fresh], [fresh, old], [old, noCode, fresh], [fresh, noCode, old]]) {
    const f = fixture({ request: () => response(JSON.stringify({ results: rows })) });
    try {
      const result = await lookup(f.pool);
      assert.equal(result.results.length, 1); assert.equal(result.results[0].url, quarkUrl + '?pwd=NEW2');
      assert.equal(result.results[0].name, '电影 新码');
      assert.equal(result.results[0].publishedAt, Date.parse(rows.includes(noCode) ? noCode.datetime : fresh.datetime));
      assert.deepEqual(Object.keys(result.results[0]).sort(), ['name', 'password', 'publishedAt', 'url']);
    } finally { await f.pool.stop(); }
  }
});

test('cross-engine merging preserves the actual code date through a newer RSS post without a password', async () => {
  const f = fixture({ googleSearch: async () => [{ name: '电影 新码', url: quarkUrl + '?pwd=NEW2', publishedAt: Date.parse('2026-10-11T00:00:00Z') }], request: () => response('<rss><channel>' +
    `<item><title>电影 旧码</title><pubDate>Sat, 10 Oct 2026 00:00:00 GMT</pubDate><link>${quarkUrl}?pwd=OLD1</link></item>` +
    `<item><title>电影 新帖子无码</title><pubDate>Mon, 12 Oct 2026 00:00:00 GMT</pubDate><link>${quarkUrl}</link></item></channel></rss>`) });
  try {
    const result = JSON.parse(await readText(await f.pool.request('https://manual.example/api/search?kw=电影', { webSearch: true })));
    assert.equal(result.results.length, 1); assert.equal(result.results[0].url, quarkUrl + '?pwd=NEW2');
    assert.equal(result.results[0].name, '电影 新码');
    assert.equal(result.results[0].publishedAt, Date.parse('2026-10-12T00:00:00Z'));
    const cached = JSON.parse(await readText(await f.pool.request('https://manual.example/api/search?kw=电影', { webSearch: true })));
    assert.deepEqual(cached, result); assert.equal(f.calls.length, 1);
  } finally { await f.pool.stop(); }
});

test('untrusted future dates and numeric bare years cannot lead API sorting or enter its retry cache', async () => {
  const clock = Date.parse('2026-10-14T00:00:00Z'), recent = clock - DAY;
  const f = fixture({ now: () => clock, request: () => response(JSON.stringify({ results: [
    { name: '电影 超远未来', publishedAt: Date.parse('2099-01-01T00:00:00Z'), url: quarkUrl },
    { name: '电影 裸年份', publishedAt: 2026, url: 'https://pan.quark.cn/s/bare12345678' },
    { name: '电影 真实日期', publishedAt: recent / 1000, url: 'https://pan.quark.cn/s/recent123456' },
    { name: '电影 明天以内', publishedAt: clock + DAY, url: 'https://pan.quark.cn/s/edge12345678' },
  ] })) });
  try {
    const result = await lookup(f.pool);
    assert.deepEqual(result.results.map(row => row.url), ['https://pan.quark.cn/s/edge12345678', 'https://pan.quark.cn/s/recent123456', quarkUrl, 'https://pan.quark.cn/s/bare12345678']);
    assert.deepEqual(result.results.map(row => row.publishedAt), [clock + DAY, recent, undefined, undefined]);
    assert.deepEqual(await lookup(f.pool), result); assert.equal(f.calls.length, 1);
  } finally { await f.pool.stop(); }
});

test('future dates are discarded before web results merge and cached ordering', async () => {
  const clock = Date.parse('2026-10-14T00:00:00Z'), recent = clock - DAY;
  const f = fixture({ now: () => clock, googleSearch: async () => [
    { name: '电影 未来', publishedAt: clock + DAY + 1, url: quarkUrl },
    { name: '电影 最近', publishedAt: recent, url: 'https://pan.quark.cn/s/recent123456' },
  ], request: () => response(`<rss><channel><item><title>电影 未来RSS</title><pubDate>Thu, 01 Jan 2099 00:00:00 GMT</pubDate><link>https://pan.quark.cn/s/rss123456789</link></item></channel></rss>`) });
  try {
    const url = 'https://manual.example/api/search?kw=电影';
    const result = JSON.parse(await readText(await f.pool.request(url, { webSearch: true })));
    assert.equal(result.results[0].url, 'https://pan.quark.cn/s/recent123456');
    assert.deepEqual(result.results.map(row => row.publishedAt), [recent, undefined, undefined]);
    assert.deepEqual(JSON.parse(await readText(await f.pool.request(url, { webSearch: true }))), result);
  } finally { await f.pool.stop(); }
});

test('discovery retains valid Quark candidates for real catalogue naming variations and incomplete API metadata', async () => {
  const cases = [
    ['quality note', '遮天', { results: [{ title: '遮天 全季合集', links: [{ type: 'quark', url: quarkUrl, note: '4K1080P' }] }] }, '遮天'],
    ['missing title', '遮天', { results: [{ links: [{ type: 'quark', url: quarkUrl }] }] }, '未提供资源标题'],
    ['mixed collection years', '遮天', { results: [{ title: '遮天 动画持续更新至EP150 全季合集2022-2026', url: quarkUrl }] }, '遮天'],
    ['season status suffix', '一念永恒 完结季', { results: [{ title: '一念永恒 第一二三季合集', url: quarkUrl }] }, '一念永恒'],
    ['abbreviated catalogue name', '转生成为哥布林有什么问题吗？', { results: [{ title: '转生成为哥布林', url: quarkUrl }] }, '转生成为哥布林'],
    ['recognizable data array', '遮天', { code: 200, data: [{ title: '遮天 全季合集', url: quarkUrl }] }, '遮天'],
    ['target after first 30 links', '遮天', { results: [...Array.from({ length: 30 }, (_, index) => ({ title: '公开资源' + index, url: 'https://pan.quark.cn/s/abcdef' + String(index).padStart(6, '0') })), { title: '遮天 全季合集', url: quarkUrl }] }, '遮天'],
    ['target after first 100 rows', '遮天', { results: [...Array.from({ length: 100 }, () => ({ title: '其他记录', links: [{ type: 'baidu', url: 'https://example.org' }] })), { title: '遮天 全季合集', url: quarkUrl }] }, '遮天'],
  ];
  for (const [label, keyword, body, expectedName] of cases) {
    const f = fixture({ request: url => response(url.includes('bing.com') ? rss() : JSON.stringify(body)) });
    try {
      const result = JSON.parse(await readText(await f.pool.request('https://manual.example/api/search?' + new URLSearchParams({ kw: keyword }), { year: '2023' })));
      assert.ok(result.results.length > 0, label); assert.ok(result.results.length <= 30, label);
      assert.equal(result.results[0].url, quarkUrl, label); assert.ok(result.results[0].name.includes(expectedName), label);
    } finally { await f.pool.stop(); }
  }
});

test('canonical titles keep numeric endings when an explicit release year is supplied', async () => {
  for (const title of ['银翼杀手 2049', '希望2026']) {
    const f = fixture({ request: url => response(url.includes('bing.com') ? rss() : json(undefined, title)) });
    try {
      const url = 'https://manual.example/api/search?' + new URLSearchParams({ kw: title });
      const result = JSON.parse(await readText(await f.pool.request(url, { year: title.startsWith('银翼') ? '2017' : '2026' })));
      assert.equal(result.results.length, 1); assert.equal(new URL(f.calls[0].url).searchParams.get('kw'), title);
      assert.equal(f.calls.length, 1);
    } finally { await f.pool.stop(); }
  }
});

test('canonical web titles and explicit aliases reach Google without stripping numeric endings twice', async () => {
  const f = fixture({ request: () => response('<rss><channel></channel></rss>'), googleSearch: async (title, options) => {
    assert.equal(title, '银翼杀手 2049'); assert.equal(options.titleOnly, true);
    assert.deepEqual(options.aliases, ['Blade Runner 2049']);
    return [{ name: '银翼杀手 2049', url: quarkUrl }];
  } });
  try {
    const url = 'https://manual.example/api/search?' + new URLSearchParams({ kw: '银翼杀手 2049' });
    const result = JSON.parse(await readText(await f.pool.request(url, { year: '2017', aliases: ['Blade Runner 2049'], webSearch: true })));
    assert.equal(result.results.length, 1);
    assert.equal(new URL(f.calls[0].url).searchParams.get('q'), '银翼杀手 2049 site:pan.quark.cn/s');
  } finally { await f.pool.stop(); }
});

test('an explicit unknown year still marks a numeric-ending title as canonical and stays separate from legacy queries', async () => {
  const f = fixture();
  try {
    const url = 'https://manual.example/api/search?' + new URLSearchParams({ kw: '银翼杀手 2049' });
    const canonical = JSON.parse(await readText(await f.pool.request(url, { year: '' })));
    assert.equal(canonical.results.length, 1);
    assert.equal(new URL(f.calls[0].url).searchParams.get('kw'), '银翼杀手 2049');
    await f.pool.request(url, { year: '' }); assert.equal(f.calls.length, 1);
    const legacy = JSON.parse(await readText(await f.pool.request(url)));
    assert.equal(legacy.results.length, 1);
    assert.equal(new URL(f.calls[1].url).searchParams.get('kw'), '银翼杀手');
    assert.equal(f.calls.length, 2);
  } finally { await f.pool.stop(); }
});

test('weak candidates remain visible while a necessary explicit alias is still searched', async () => {
  const f = fixture({ request: url => response(new URL(url).searchParams.get('kw') === 'IT' ? json(quarkUrl, 'IT (2017)') : json('https://pan.quark.cn/s/weak12345678', '网盘资源链接')) });
  try {
    const result = JSON.parse(await readText(await f.pool.request('https://manual.example/api/search?' + new URLSearchParams({ kw: '小丑回魂' }), { year: '2017', aliases: ['IT'] })));
    assert.deepEqual(f.calls.map(call => new URL(call.url).searchParams.get('kw')), ['小丑回魂', 'IT']);
    assert.deepEqual(result.results.map(row => row.url), [quarkUrl + '?pwd=1234', 'https://pan.quark.cn/s/weak12345678?pwd=1234']);
  } finally { await f.pool.stop(); }
});

test('empty API searches expose fixed web failures instead of disguising them as a plain no-result response', async () => {
  const f = fixture({ request: url => response(url.includes('bing.com') ? 'blocked user-cookie' : '{"results":[]}', url.includes('bing.com') ? 403 : 200), googleSearch: async () => { throw new Error('private upstream failure user-token'); } });
  try {
    const result = await lookup(f.pool);
    assert.deepEqual(result.results, []); assert.equal(result.reason, 'Google 公开搜索：搜索服务连接失败；Bing 公开搜索：搜索接口返回 HTTP 403');
    assert.equal(/user-cookie|user-token|private upstream|https?:/i.test(result.reason), false);
    assert.equal(f.pool.status().candidates.find(row => row.apiUrl.includes('manual.example')).status, 'pending');
  } finally { await f.pool.stop(); }
});

test('upgrading retries the current paused manual API once while preserving automatic backoff and failed restart backoff', async () => {
  const clock = Date.now(), manual = 'https://manual.example/api/search';
  const saved = { candidates: [
    { url: manual, automatic: false, status: 'paused', failures: 3, addedAt: clock - 1000, checkedAt: clock - 100, retryAt: clock + 6 * 60 * 60_000 },
    { url: backup, automatic: true, status: 'paused', failures: 2, addedAt: clock - 1000, checkedAt: clock - 100, retryAt: clock + 60 * 60_000 },
  ] };
  const f = fixture({ saved, now: () => clock, request: url => response(url.includes('bing.com') ? '<rss><channel></channel></rss>' : 'offline', url.includes('bing.com') ? 200 : 503) });
  let restarted;
  try {
    f.metadata.set('quark-search-recall-v2', '1');
    await lookup(f.pool);
    assert.equal(f.calls.filter(call => call.url.includes('manual.example')).length, 1);
    assert.equal(f.metadata.get('quark-search-availability-v3'), '1');
    assert.equal(f.metadata.get('quark-search-recall-v2'), '1');
    const failed = JSON.parse(f.metadata.get(KEY)).candidates.find(row => row.url === manual);
    assert.equal(failed.failures, 4); assert.equal(failed.status, 'paused'); assert.ok(failed.retryAt > clock);
    const automatic = JSON.parse(f.metadata.get(KEY)).candidates.find(row => row.url === backup);
    assert.equal(automatic.failures, 2); assert.equal(automatic.retryAt, clock + 60 * 60_000); assert.equal(automatic.status, 'paused');
    await f.pool.stop();
    const calls = [];
    restarted = createQuarkSearchPool({ store: f.store, now: () => clock, googleSearch: async () => [], request: async url => { calls.push(url); return response('<rss><channel></channel></rss>'); } });
    await lookup(restarted);
    assert.ok(calls.every(url => !url.includes('manual.example') && !url.includes('backup.example')));
    assert.equal(JSON.parse(f.metadata.get(KEY)).candidates.find(row => row.url === manual).failures, 4);
  } finally { await f.pool.stop(); await restarted?.stop(); }
});

test('a successful one-time manual API retry clears failure count through normal health validation', async () => {
  const clock = Date.now();
  const f = fixture({ now: () => clock, saved: { candidates: [{ url: 'https://manual.example/api/search', automatic: false, status: 'paused', failures: 5, addedAt: clock - 1000, checkedAt: clock - 100, retryAt: clock + 60 * 60_000 }] } });
  try {
    assert.equal((await lookup(f.pool)).results.length, 1);
    const current = JSON.parse(f.metadata.get(KEY)).candidates.find(row => row.url.includes('manual.example'));
    assert.equal(current.status, 'healthy'); assert.equal(current.failures, 0); assert.equal(current.retryAt, 0);
    assert.equal(f.metadata.get('quark-search-availability-v3'), '1');
  } finally { await f.pool.stop(); }
});

test('real PanSou omitted empty arrays preserve a usable API for the next film', async () => {
  const f = fixture({ request: url => {
    const parsed = new URL(url);
    if (parsed.hostname.includes('bing.com')) return response('blocked', 403);
    return response(parsed.searchParams.get('kw') === '电影' ? '{"code":0,"message":"success","data":{"total":0}}' : json(undefined, '遮天'));
  } });
  try {
    const empty = await lookup(f.pool);
    assert.deepEqual(empty.results, []); assert.ok(!/格式|JSON/.test(empty.reason));
    assert.equal(f.pool.status().candidates.find(row => row.apiUrl.includes('manual.example')).status, 'pending');
    assert.equal((await lookup(f.pool, 'https://manual.example/api/search?kw=遮天')).results.length, 1);
    assert.equal(f.calls.filter(call => call.url.includes('manual.example')).length, 2);
  } finally { await f.pool.stop(); }
});

test('an optional keyword exhausting its short budget cannot disable an API that already answered another keyword', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const f = fixture({ request: async url => {
    const parsed = new URL(url), keyword = parsed.searchParams.get('kw');
    if (parsed.hostname.includes('bing.com')) return response('blocked', 403);
    if (keyword === '你我对抗全世界') { await new Promise(done => setTimeout(done, 4000)); return response('{"code":0,"message":"success","data":{"total":0,"results":[]}}'); }
    if (keyword === '遮天') return response(json(undefined, '遮天'));
    const stream = Object.assign(new PassThrough(), { statusCode: 200, headers: {} }); stream.write('{'); return stream;
  } });
  try {
    const pending = f.pool.request('https://manual.example/api/search?kw=' + encodeURIComponent('你我对抗全世界'), { year: '2026' });
    await flush(); t.mock.timers.tick(4000); await flush();
    assert.equal(f.calls.filter(call => call.url.includes('manual.example'))[1].options.timeout, 1700);
    t.mock.timers.tick(1700); await flush();
    const first = JSON.parse(await readText(await pending));
    assert.deepEqual(first.results, []); assert.match(first.reason, /超时/);
    const primary = JSON.parse(f.metadata.get(KEY)).candidates.find(row => row.url.includes('manual.example'));
    assert.equal(primary.status, 'pending'); assert.equal(primary.failures, 0); assert.equal(primary.retryAt, 0);
    assert.equal((await lookup(f.pool, 'https://manual.example/api/search?kw=遮天')).results.length, 1);
    assert.equal(f.calls.filter(call => call.url.includes('manual.example')).length, 3);
  } finally { await f.pool.stop(); }
});

test('only explicit valid PanSou zero-result responses can omit the arrays', async () => {
  const invalid = [
    { code: 0, data: { total: 0, results: null } },
    { code: 0, data: { total: 0, merged_by_type: [] } },
    { code: 0, data: { total: '0' } },
    { code: 0, data: { total: 1 } },
    { code: 500, message: 'private user-cookie', data: { total: 0 } },
    { success: true, data: { total: 0 } },
    { status: 'ok', total: 0, auth_enabled: false },
  ];
  for (const body of invalid) {
    const f = fixture({ request: url => response(url.includes('bing.com') ? '<rss><channel></channel></rss>' : JSON.stringify(body)) });
    try {
      const result = await lookup(f.pool);
      assert.deepEqual(result.results, []); assert.match(result.reason, /响应格式不兼容/);
      assert.equal(result.reason.includes('user-cookie'), false);
      assert.equal(f.pool.status().candidates.find(row => row.apiUrl.includes('manual.example')).status, 'paused');
    } finally { await f.pool.stop(); }
  }
  const f = fixture({ request: () => response(JSON.stringify({ code: 0, data: { total: 0, results: [{ title: '电影', links: [{ type: 'quark', url: quarkUrl }] }] } })) });
  try { assert.equal((await lookup(f.pool)).results.length, 1); }
  finally { await f.pool.stop(); }
});

test('a genuine full-budget connection failure still backs off and the next film explains the retry window safely', async () => {
  const f = fixture({ request: url => {
    if (url.includes('bing.com')) return response('upstream private user-cookie', 503);
    throw Object.assign(new Error('connect http://private.example user-token user-cookie'), { code: 'ECONNREFUSED' });
  } });
  try {
    const first = await lookup(f.pool);
    assert.deepEqual(first.results, []); assert.match(first.reason, /已配置搜索接口：搜索服务拒绝连接/);
    assert.match(first.reason, /HTTP 503/);
    const primary = f.pool.status().candidates.find(row => row.apiUrl.includes('manual.example'));
    assert.equal(primary.status, 'paused'); assert.ok(primary.retryAt > Date.now());
    const second = await lookup(f.pool, 'https://manual.example/api/search?kw=遮天');
    assert.deepEqual(second.results, []); assert.match(second.reason, /15 分钟后重试/);
    assert.equal(f.calls.filter(call => call.url.includes('manual.example')).length, 1);
    assert.equal(/private\.example|user-token|user-cookie/.test(JSON.stringify([first, second])), false);
  } finally { await f.pool.stop(); }
});

test('a first request with little budget left after queuing cannot pause an untested API', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const f = fixture({ request: async url => {
    const parsed = new URL(url);
    if (parsed.hostname.includes('bing.com')) return response('<rss><channel></channel></rss>');
    if (parsed.hostname === 'short.example') throw Object.assign(new Error('private connection detail'), { code: 'ECONNREFUSED' });
    await new Promise(done => setTimeout(done, 2700)); return response(json());
  } });
  try {
    const pending = Promise.all(['https://busy1.example/api/search?kw=电影', 'https://busy2.example/api/search?kw=电影', 'https://short.example/api/search?kw=电影'].map(url => lookup(f.pool, url)));
    await flush(); assert.equal(f.calls.length, 2);
    t.mock.timers.tick(2700); await flush();
    const results = await pending;
    assert.deepEqual(results.map(row => row.results.length), [1, 1, 0]);
    const short = f.calls.find(call => call.url.includes('short.example'));
    assert.equal(short.options.timeout, 3000);
    const state = JSON.parse(f.metadata.get(KEY)).candidates.find(row => row.url.includes('short.example'));
    assert.equal(state.status, 'pending'); assert.equal(state.failures, 0); assert.equal(state.retryAt, 0);
  } finally { await f.pool.stop(); }
});

test('HTML search failures expose a fixed non-JSON diagnostic without echoing upstream content', async () => {
  const f = fixture({ request: url => response(url.includes('bing.com') ? '<rss><channel></channel></rss>' : '<html>Cookie user-cookie Authorization user-token</html>') });
  try {
    const result = await lookup(f.pool);
    assert.deepEqual(result.results, []); assert.match(result.reason, /搜索接口未返回 JSON/);
    assert.equal(/user-cookie|user-token|Authorization|<html>/.test(result.reason), false);
  } finally { await f.pool.stop(); }
});

test('the fixed built-in helper backs off for 10, 20, 40 and at most 60 seconds after DNS startup failures', async () => {
  let clock = 1000;
  const f = fixture({ now: () => clock, request: url => {
    if (!url.startsWith('http://pansou:8888/')) return response('<rss><channel></channel></rss>');
    throw Object.assign(new Error('private http://pansou:8888/ Cookie user-cookie'), { status: 502, cause: Object.assign(new Error('private DNS detail'), { code: 'ENOTFOUND' }) });
  } });
  try {
    for (const delay of [10_000, 20_000, 40_000, 60_000, 60_000]) {
      const result = await lookup(f.pool, 'http://pansou:8888/api/search?kw=电影');
      assert.match(result.reason, /找不到搜索助手，请确认 pansou 服务已启动/);
      const current = f.pool.status().candidates.find(row => row.apiUrl === 'http://pansou:8888/api/search');
      assert.equal(current.retryAt - clock, delay);
      const before = f.calls.filter(call => call.url.startsWith('http://pansou:8888/')).length;
      const paused = await lookup(f.pool, 'http://pansou:8888/api/search?kw=遮天');
      assert.match(paused.reason, new RegExp((delay / 1000) + ' 秒后重试'));
      assert.equal(f.calls.filter(call => call.url.startsWith('http://pansou:8888/')).length, before);
      assert.equal(/private|user-cookie|http:\/\//.test(result.reason), false);
      clock = current.retryAt;
    }
  } finally { await f.pool.stop(); }
});

test('an old long pause on the fixed helper is lifted without another migration marker', async () => {
  const clock = Date.now(), sidecar = 'http://pansou:8888/api/search';
  const f = fixture({ now: () => clock, saved: { candidates: [{ url: sidecar, automatic: false, status: 'paused', failures: 5, addedAt: clock - 1000, checkedAt: clock - 100, retryAt: clock + 30 * 60_000 }] } });
  f.metadata.set('quark-search-availability-v3', '1');
  const beforeKeys = [...f.metadata.keys()].sort();
  try {
    const result = await lookup(f.pool, sidecar + '?kw=遮天');
    assert.equal(result.results.length, 1);
    assert.equal(f.calls.filter(call => call.url.startsWith(sidecar)).length, 1);
    const current = f.pool.status().candidates.find(row => row.apiUrl === sidecar);
    assert.equal(current.status, 'healthy'); assert.equal(current.retryAt, 0);
    assert.deepEqual([...f.metadata.keys()].sort(), beforeKeys);
  } finally { await f.pool.stop(); }
});

test('public network diagnostics use fixed categories without confusing a public DNS failure with the built-in helper', async () => {
  const cases = [
    ['ENOTFOUND', /域名解析失败/], ['EAI_AGAIN', /域名暂时无法解析/],
    ['ECONNREFUSED', /拒绝连接/], ['ENETUNREACH', /网络不可达/], ['EHOSTUNREACH', /网络不可达/],
    ['ECONNRESET', /连接中断/], ['EPIPE', /连接中断/], ['ETIMEDOUT', /请求超时/],
    ['CERT_HAS_EXPIRED', /TLS 验证或握手失败/], ['ERR_TLS_CERT_ALTNAME_INVALID', /TLS 验证或握手失败/],
    ['UNRECOGNIZED_PRIVATE_CODE', /连接失败/],
  ];
  for (const [code, expected] of cases) {
    const clock = Date.now();
    const f = fixture({ now: () => clock, request: url => {
      if (url.includes('bing.com')) return response('<rss><channel></channel></rss>');
      throw Object.assign(new Error('private http://private.example Cookie user-cookie'), { status: 502, cause: Object.assign(new Error('private DNS Authorization user-token'), { code }) });
    } });
    try {
      const result = await lookup(f.pool, 'https://pansou.example/api/search?kw=电影');
      assert.match(result.reason, expected);
      assert.equal(/private|user-cookie|user-token|Authorization|https?:|pansou/.test(result.reason), false);
      const current = f.pool.status().candidates.find(row => row.apiUrl === 'https://pansou.example/api/search');
      assert.equal(current.retryAt - clock, 15 * 60_000);
    } finally { await f.pool.stop(); }
  }
});

test('Google DNS diagnostics stay generic and unsupported content encoding has a fixed response error', async () => {
  const f = fixture({ request: url => {
    if (url.includes('bing.com')) return response('<rss><channel></channel></rss>');
    const upstream = response('private body user-cookie'); upstream.headers['content-encoding'] = 'unsupported'; return upstream;
  }, googleSearch: async () => { throw Object.assign(new Error('private Google DNS user-token'), { code: 'ENOTFOUND' }); } });
  try {
    const result = await lookup(f.pool);
    assert.match(result.reason, /搜索响应内容异常/); assert.match(result.reason, /Google 公开搜索：搜索服务域名解析失败/);
    assert.equal(/private|user-cookie|user-token|pansou|http/.test(result.reason), false);
  } finally { await f.pool.stop(); }
});

test('a short persisted helper pause survives restart while old public pauses remain unchanged', async () => {
  let clock = Date.now();
  const sidecar = 'http://pansou:8888/api/search', publicApi = 'https://manual.example/api/search';
  for (const [url, delay] of [[sidecar, 60_000], [publicApi, 30 * 60_000]]) {
    const f = fixture({ now: () => clock, saved: { candidates: [{ url, automatic: false, status: 'paused', failures: 6, addedAt: clock - 1000, checkedAt: clock - 100, retryAt: clock + delay }] } });
    f.metadata.set('quark-search-availability-v3', '1');
    try {
      const result = await lookup(f.pool, url + '?kw=电影');
      assert.match(result.reason, url === sidecar ? /60 秒后重试/ : /30 分钟后重试/);
      assert.ok(f.calls.every(call => !call.url.startsWith(url)));
      const current = f.pool.status().candidates.find(row => row.apiUrl === url);
      assert.equal(current.retryAt, clock + delay);
      assert.equal(JSON.parse(f.metadata.get(KEY)).candidates.find(row => row.url === url).failures, 6);
    } finally { await f.pool.stop(); }
  }
});

const DAY = 86_400_000;
