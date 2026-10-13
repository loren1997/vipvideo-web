import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, PassThrough } from 'node:stream';
import { createQuarkSearchPool } from '../lib/quark-search-pool.mjs';
import { createQuarkSearchRequest } from '../lib/quark-search.mjs';
import { createRequest, readText } from '../lib/network.mjs';

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

test('a year-specific miss retries the complete title and excludes other titles or explicit conflicting years', async () => {
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
    assert.deepEqual(result.results.map(row => row.url), [quarkUrl]);
    assert.deepEqual(f.calls.map(call => new URL(call.url).searchParams.get('kw')), ['电影 2026', '电影']);
  } finally { await f.pool.stop(); }
});

test('only explicit bounded aliases extend matching and English titles require complete word boundaries', async () => {
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
    assert.deepEqual(result.results.map(row => row.url), [quarkUrl]);
    assert.deepEqual(f.calls.map(call => new URL(call.url).searchParams.get('kw')), ['小丑回魂 2017', '小丑回魂', 'IT']);
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

test('RSS fallback matches titles and years without accepting an unrelated or unnamed share', async () => {
  const f = fixture({ request: url => response(url.includes('bing.com') ? '<rss><channel>' +
    `<item><title><![CDATA[电影 (2026) 4K]]></title><link>${quarkUrl}?pwd=1234</link></item>` +
    '<item><title>电影 2025</title><link>https://pan.quark.cn/s/old12345678</link></item>' +
    '<item><title>另一个片名 2026</title><link>https://pan.quark.cn/s/wrong123456</link></item>' +
    '<item><link>https://pan.quark.cn/s/unnamed12345</link></item></channel></rss>' : '{"results":[]}') });
  try {
    const result = await lookup(f.pool, 'https://manual.example/api/search?kw=' + encodeURIComponent('电影 2026'));
    assert.deepEqual(result.results.map(row => row.url), [quarkUrl + '?pwd=1234']);
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
  const latest = Date.parse('2026-10-13T00:00:00Z'), older = Date.parse('2026-09-01T00:00:00Z');
  const f = fixture({ saved: savedBackup(Date.now()), request: async (url, options) => {
    assert.equal(/cookie|authorization|user-cookie|user-token/i.test(JSON.stringify(options)), false);
    peak = Math.max(peak, ++active); await new Promise(done => setImmediate(done)); active--;
    return response(url.includes('bing.com') ? `<rss><channel><item><title>电影 2026</title><pubDate>Tue, 01 Sep 2026 00:00:00 GMT</pubDate><link>${quarkUrl}?pwd=1234</link></item><item><title>电影 4K</title><link>https://pan.quark.cn/s/unknown12345</link></item></channel></rss>` : '<html>public index</html>');
  }, googleSearch: async (keyword, { read, deadline, now }) => {
    googleCalls++; assert.equal(keyword, '电影 2026'); assert.equal(deadline - now(), 7500);
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
    assert.deepEqual(result.results.map(row => row.url), [quarkUrl + '?pwd=1234', 'https://pan.quark.cn/s/old12345678', 'https://pan.quark.cn/s/unknown12345']);
    assert.deepEqual(result.results.map(row => row.publishedAt), [latest, older, undefined]);
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

test('daily public discovery rotates wider Chinese queries while retaining at most three directory requests', async () => {
  let clock = Date.now();
  const f = fixture({ now: () => clock });
  try {
    const queries = [];
    for (let day = 0; day < 4; day++) {
      const before = f.discoveryCalls.length;
      await f.pool.discover(); assert.equal(f.discoveryCalls.length - before, 3);
      queries.push(new URL(f.discoveryCalls.at(-1).url).searchParams.get('q'));
      await f.pool.discover(); assert.equal(f.discoveryCalls.length - before, 3);
      clock += DAY + 1;
    }
    assert.equal(new Set(queries.slice(0, 3)).size, 3); assert.equal(queries[0], queries[3]);
    assert.ok(queries.some(query => query.includes('夸克'))); assert.ok(queries.some(query => query.includes('网盘搜索')));
    assert.equal(JSON.parse(f.metadata.get(KEY)).discoveryCursor, 4);
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

const DAY = 86_400_000;
