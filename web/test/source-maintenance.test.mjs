import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSourceMaintenance } from '../lib/source-maintenance.mjs';
import { createStore } from '../lib/store.mjs';

const source = (id, extra = {}) => ({ id, name: `${id}源`, api: `https://${id}.example/api.php`, enabled: true, ...extra });
const subscription = (id = 'feed', extra = {}) => ({ id, name: '可信订阅', url: `https://${id}.example/sources.json`, enabled: true, ...extra });
const config = (extra = {}) => ({ showAdult: false, sources: [], platforms: [], parsers: [], subscriptions: [], ...extra });
const response = (body, statusCode = 200) => Object.assign(Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]), { statusCode, headers: {} });
const feed = (...sources) => ({ api_site: Object.fromEntries(sources.map(item => [item.id, { name: item.name, api: item.api }])) });
const feedRequest = callback => async (url, options) => url.pathname.endsWith('.json') ? callback(url, options) : response({ code: 1, list: [{ vod_id: 1, vod_name: '可用接口样例' }] });
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(setImmediate); };

function memoryStore(initial) {
  let current = structuredClone(initial);
  const meta = new Map();
  return {
    config: () => structuredClone(current), setConfig(value) { current = structuredClone(value); return value; },
    meta: key => meta.get(key), setMeta(key, value) { meta.set(key, value); },
  };
}

test('subscription refresh repairs JSONC and compatible TVBox sites before checking and adding APIs', async () => {
  const store=memoryStore(config({subscriptions:[subscription()]}));
  const maintenance=createSourceMaintenance({store,request:feedRequest(()=>response('{ /* comment */ "sites": [ {"key":"fixed","name":"可用源","type":1,"api":"fixed.example:8443/vod?token=1&amp;v=2",}, {"key":"spider","type":3,"api":"csp_Unsupported"}, ], }'))});
  const result=await maintenance.update();
  assert.equal(result.subscriptions[0].status,'ok');
  assert.equal(result.subscriptions[0].added,1);
  assert.equal(store.config().sources[0].api,'https://fixed.example:8443/vod?token=1&v=2');
});

test('probes only enabled APIs with clean list parameters, deduplicates work, and persists status', async () => {
  let clock = 1000;
  let active = 0;
  let maximum = 0;
  const calls = [];
  const store = memoryStore(config({ sources: [source('a', { api: 'https://a.example/api.php?token=keep&wd=old&ids=3&t=2&pg=4&ac=detail' }), ...['b', 'c', 'd'].map(id => source(id)), source('off', { enabled: false })] }));
  const maintenance = createSourceMaintenance({ store, now: () => clock, request: async (url, options) => {
    active++; maximum = Math.max(maximum, active); calls.push({ url, options });
    await new Promise(setImmediate); clock += 5; active--;
    return response({ code: 1, list: [], class: [{ type_id: 1, type_name: '电影' }] });
  } });
  assert.equal(maintenance.status().sources[0].status, 'unknown');
  const pending = maintenance.probe();
  assert.equal(maintenance.probe(), pending);
  assert.equal(maintenance.status().running, true);
  const result = await pending;
  assert.equal(result.running, false);
  assert.equal(maximum, 2);
  assert.equal(calls.length, 4);
  assert.ok(result.sources.slice(0, 4).every(row => row.status === 'ok' && row.latencyMs >= 5 && row.checkedAt > 1000));
  assert.equal(result.sources[4].status, 'disabled');
  assert.equal(calls[0].url.searchParams.get('token'), 'keep');
  assert.equal(calls[0].url.searchParams.get('ac'), 'list');
  assert.ok(['wd', 'ids', 't', 'pg'].every(key => !calls[0].url.searchParams.has(key)));
  assert.equal(calls[0].options.timeout, 8000);
  result.sources[0].status = 'error';
  const restarted = createSourceMaintenance({ store });
  assert.equal(restarted.status().sources[0].status, 'ok');
  assert.equal(restarted.status().lastProbe, clock);
  store.setConfig(config({ sources: [source('a', { api: 'https://changed.example/api' })] }));
  assert.equal(restarted.status().sources[0].status, 'unknown');
});

test('records HTTP, malformed JSON, and non-AppleCMS errors without dropping other probe results', async () => {
  const store = memoryStore(config({ sources: ['http', 'json', 'shape', 'good'].map(id => source(id)) }));
  const maintenance = createSourceMaintenance({ store, request: async url => {
    if (url.hostname === 'http.example') return response({}, 503);
    if (url.hostname === 'json.example') return response('<html>not JSON</html>');
    if (url.hostname === 'shape.example') return response({ list: ['invalid'] });
    return response({ list: [{ vod_id: 1, vod_name: '固定样例' }] });
  } });
  const rows = (await maintenance.probe()).sources;
  assert.deepEqual(rows.map(row => row.status), ['error', 'error', 'error', 'ok']);
  assert.match(rows[0].error, /503/);
  assert.match(rows[2].error, /AppleCMS/);
});

test('enforces the eight-second deadline before headers and during response body reads', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = memoryStore(config({ sources: [source('headers'), source('body')] }));
  const body = Object.assign(new Readable({ read() {} }), { statusCode: 200, headers: {} });
  const maintenance = createSourceMaintenance({ store, request: async url => url.hostname === 'headers.example' ? new Promise(() => {}) : body });
  const pending = maintenance.probe();
  await Promise.resolve();
  t.mock.timers.tick(8000);
  const rows = (await pending).sources;
  assert.ok(rows.every(row => row.status === 'error' && /超时/.test(row.error)));
  assert.equal(body.destroyed, true);
});

test('updates only owned APIs while keeping custom names, disabled sources, deletion choices, and absent remote sources', async () => {
  const custom = source('custom', { name: '用户自定义' });
  const store = memoryStore(config({ sources: [custom], subscriptions: [subscription()] }));
  let remote = feed(source('custom', { api: 'https://remote.example/custom' }), source('managed'), source('deleted'));
  const maintenance = createSourceMaintenance({ store, request: feedRequest(async () => response(remote)) });
  const first = await maintenance.update();
  assert.equal(first.subscriptions[0].added, 2);
  assert.deepEqual(store.config().sources[0], custom);
  store.setConfig({ ...store.config(), sources: [custom, source('managed', { name: '家中名称', enabled: false })] });
  remote = feed(source('managed', { api: 'https://new.example/managed' }), source('deleted'), source('new'));
  await maintenance.update();
  assert.deepEqual(store.config().sources.map(row => row.id), ['custom', 'managed', 'new']);
  assert.equal(store.config().sources[1].api, source('managed').api);
  assert.equal(store.config().sources[1].enabled, false);
  store.setConfig({ ...store.config(), sources: store.config().sources.map(row => row.id === 'managed' ? { ...row, enabled: true } : row) });
  const refreshed = await maintenance.update();
  assert.equal(refreshed.subscriptions[0].updated, 1);
  assert.equal(store.config().sources[1].api, 'https://new.example/managed');
  assert.equal(store.config().sources[1].name, '家中名称');
  store.setConfig({ ...store.config(), sources: store.config().sources.map(row => row.id === 'managed' ? { ...row, api: 'https://user.example/custom-api' } : row) });
  remote = feed(source('managed', { api: 'https://latest.example/managed' }));
  await maintenance.update();
  assert.equal(store.config().sources[1].api, 'https://user.example/custom-api');
  assert.ok(store.config().sources.some(row => row.id === 'new'));
});

test('rejects an entire invalid or oversized subscription and leaves all existing sources unchanged', async () => {
  const initial = config({ sources: [source('existing')], subscriptions: [subscription()] });
  const store = memoryStore(initial);
  let remote = feed(source('valid'), source('bad', { api: 'http://127.0.0.1/private' }));
  const maintenance = createSourceMaintenance({ store, request: feedRequest(async () => response(remote)) });
  let result = await maintenance.update();
  assert.equal(result.subscriptions[0].status, 'error');
  assert.deepEqual(store.config(), initial);
  remote = JSON.stringify({ api_site: {}, padding: 'x'.repeat(1024 * 1024) });
  result = await maintenance.update();
  assert.match(result.subscriptions[0].error, /响应过大/);
  assert.deepEqual(store.config(), initial);
  remote = { unsupported: [source('valid')] };
  result = await maintenance.update();
  assert.match(result.subscriptions[0].error, /可识别的影视源 JSON/);
  assert.deepEqual(store.config(), initial);
});

test('registers only built-in baselines, preserves missing and customized initial sources, and keeps tombstones after failed fetches', async () => {
  const initialSources = ['managed', 'missing', 'custom', 'off'].map(id => source(id));
  const store = memoryStore(config({ sources: [source('managed', { name: '家中名称' }), source('custom', { api: 'https://user.example/api' }), source('off', { enabled: false })], subscriptions: [subscription('builtin-presets')] }));
  let failure = true;
  const request = feedRequest(async () => {
    if (failure) throw new Error('暂时不可用');
    return response(feed(...initialSources.map(item => ({ ...item, api: `https://new.example/${item.id}` }))));
  });
  const first = createSourceMaintenance({ store, initialSources, request });
  await first.update();
  store.setConfig({ ...store.config(), sources: store.config().sources.filter(item => item.id !== 'managed') });
  failure = false;
  const restarted = createSourceMaintenance({ store, initialSources, request });
  await restarted.update();
  assert.deepEqual(store.config().sources.map(item => item.id), ['custom', 'off']);
  assert.equal(store.config().sources[0].api, 'https://user.example/api');
  assert.equal(store.config().sources[1].api, source('off').api);
  store.setConfig({ ...store.config(), sources: [...store.config().sources, source('managed', { name: '明确恢复' })] });
  await restarted.update();
  assert.equal(store.config().sources[2].api, 'https://new.example/managed');
  assert.equal(store.config().sources[2].name, '明确恢复');
  const ordinary = memoryStore(config({ sources: [source('managed')], subscriptions: [subscription()] }));
  await createSourceMaintenance({ store: ordinary, initialSources, request }).update();
  assert.equal(ordinary.config().sources[0].api, source('managed').api);
});

test('re-reads the latest config after fetching and preserves simultaneous user changes', async () => {
  const store = memoryStore(config({ sources: [source('original')], subscriptions: [subscription()] }));
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const maintenance = createSourceMaintenance({ store, request: feedRequest(async () => { await waiting; return response(feed(source('remote'), source('collision'))); }) });
  const pending = maintenance.update();
  assert.equal(maintenance.update(), pending);
  const userConfig = { ...store.config(), showAdult: true, sources: [source('original', { name: '改过名称', enabled: false }), source('collision', { name: '并发新增', api: 'https://user.example/api' })], parsers: [{ id: 'manual', name: '解析', url: '', enabled: true }] };
  store.setConfig(userConfig);
  release();
  await pending;
  const current = store.config();
  assert.equal(current.showAdult, true);
  assert.deepEqual(current.parsers, userConfig.parsers);
  assert.deepEqual(current.subscriptions, userConfig.subscriptions);
  assert.deepEqual(current.sources.slice(0, 2), userConfig.sources);
  assert.equal(current.sources[2].id, 'remote');
});

test('does not apply stale subscription responses after disable, removal, or URL edits', async () => {
  for (const action of ['disable', 'remove', 'url']) {
    const initial = config({ subscriptions: [subscription()] });
    const store = memoryStore(initial);
    let release;
    const waiting = new Promise(resolve => { release = resolve; });
    const maintenance = createSourceMaintenance({ store, request: feedRequest(async () => { await waiting; return response(feed(source('stale'))); }) });
    const pending = maintenance.update();
    const changed = action === 'remove' ? [] : [subscription('feed', action === 'disable' ? { enabled: false } : { url: 'https://new.example/feed.json' })];
    store.setConfig({ ...initial, subscriptions: changed });
    release();
    await pending;
    assert.deepEqual(store.config().sources, [], action);
    if (action === 'disable') assert.equal(maintenance.status().subscriptions[0].status, 'disabled');
    if (action === 'url') assert.equal(maintenance.status().subscriptions[0].status, 'unknown');
  }
});

test('failed or disabled subscriptions retain previous owned sources while another subscription can succeed', async () => {
  const store = memoryStore(config({ subscriptions: [subscription('first'), subscription('second'), subscription('off', { enabled: false })] }));
  let failing = false;
  const calls = [];
  const maintenance = createSourceMaintenance({ store, request: feedRequest(async url => {
    calls.push(url.hostname);
    if (url.hostname === 'first.example' && failing) throw new Error('网络不可用');
    return response(feed(source(url.hostname === 'first.example' ? 'a' : failing ? 'c' : 'b')));
  }) });
  await maintenance.update();
  failing = true;
  const result = await maintenance.update();
  assert.deepEqual(store.config().sources.map(row => row.id), ['a', 'b', 'c']);
  assert.deepEqual(result.subscriptions.map(row => row.status), ['error', 'ok', 'disabled']);
  assert.equal(calls.includes('off.example'), false);
});

test('shares a two-request limit across simultaneous probes and updates', async () => {
  const store = memoryStore(config({ sources: ['a', 'b', 'c', 'd'].map(id => source(id)), subscriptions: [subscription()] }));
  let active = 0;
  let maximum = 0;
  const maintenance = createSourceMaintenance({ store, request: async url => {
    active++; maximum = Math.max(maximum, active);
    await new Promise(setImmediate); active--;
    return response(url.pathname.endsWith('.json') ? feed(source('new')) : { list: [] });
  } });
  const probe = maintenance.probe();
  const update = maintenance.update();
  await Promise.all([probe, update]);
  await maintenance.stop();
  assert.equal(maximum, 2);
  assert.equal(maintenance.status().running, false);
  assert.ok(store.config().sources.some(row => row.id === 'new'));
});

test('stop waits for current requests and prevents starting remaining queued sources', async () => {
  const store = memoryStore(config({ sources: ['a', 'b', 'c', 'd'].map(id => source(id)) }));
  let release;
  let calls = 0;
  let stopped = false;
  const waiting = new Promise(resolve => { release = resolve; });
  const maintenance = createSourceMaintenance({ store, request: async () => { calls++; await waiting; return response({ list: [] }); } });
  const pending = maintenance.probe();
  const stopping = maintenance.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  release(); await stopping; await pending;
  assert.equal(calls, 2);
  assert.equal(maintenance.status().running, false);
  assert.deepEqual(maintenance.status().sources.map(row => row.status), ['ok', 'ok', 'unknown', 'unknown']);
});

test('persists source status and ownership in SQLite across restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'vipvideo-maintenance-'));
  let openStore;
  t.after(async () => { openStore?.close(); await rm(directory, { recursive: true, force: true }); });
  const initial = config({ sources: [source('existing')], subscriptions: [subscription()] });
  const store = createStore(directory, initial);
  openStore = store;
  const first = createSourceMaintenance({ store, now: () => 1000, request: async url => response(url.pathname.endsWith('.json') ? feed(source('managed'), source('deleted')) : { list: [] }) });
  await first.update(); await first.probe(); await first.stop();
  store.setConfig({ ...store.config(), sources: store.config().sources.filter(row => row.id !== 'deleted').map(row => row.id === 'managed' ? { ...row, name: '持久名称' } : row) });
  store.close();
  openStore = null;
  const reopened = createStore(directory, initial);
  openStore = reopened;
  const second = createSourceMaintenance({ store: reopened, now: () => 2000, request: feedRequest(async () => response(feed(source('managed', { api: 'https://updated.example/api' }), source('deleted')))) });
  assert.equal(second.status().lastProbe, 1000);
  assert.equal(second.status().lastUpdate, 1000);
  assert.equal(second.status().sources[0].status, 'ok');
  await second.update();
  assert.equal(reopened.config().sources.find(row => row.id === 'managed').api, 'https://updated.example/api');
  assert.equal(reopened.config().sources.find(row => row.id === 'managed').name, '持久名称');
  assert.equal(reopened.config().sources.some(row => row.id === 'deleted'), false);
});

test('schedules due work at restart and at the required intervals, then stops scheduling', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const store = memoryStore(config({ sources: [source('a')], subscriptions: [subscription()] }));
  let probes = 0;
  let updates = 0;
  const request = async url => {
    if (url.pathname.endsWith('.json')) { updates++; return response(feed(source('a'))); }
    probes++; return response({ list: [] });
  };
  const first = createSourceMaintenance({ store, request });
  first.start(); first.start(); t.mock.timers.tick(0); await flush();
  assert.equal(probes, 1); assert.equal(updates, 1);
  t.mock.timers.tick(30 * 60 * 1000); await flush();
  assert.equal(probes, 2); assert.equal(updates, 1);
  await first.stop();
  t.mock.timers.tick(6 * 60 * 60 * 1000);
  const restarted = createSourceMaintenance({ store, request });
  restarted.start(); t.mock.timers.tick(0); await flush();
  assert.equal(probes, 3); assert.equal(updates, 2);
  await restarted.stop(); t.mock.timers.tick(24 * 60 * 60 * 1000); await flush();
  assert.equal(probes, 3); assert.equal(updates, 2);
});

test('discovery verifies new and changed APIs before adding and keeps the last working address on failure', async () => {
  const store = memoryStore(config({ subscriptions: [subscription()] }));
  let changed = false, failed = true;
  const service = createSourceMaintenance({ store, request: async url => {
    if (url.pathname.endsWith('.json')) return response(feed(source('good', changed ? { api: 'https://replacement.example/api' } : {}), source('bad'), source('duplicate', { api: source('good').api })));
    if (url.hostname === 'bad.example' || url.hostname === 'replacement.example' && failed) return response({}, 503);
    return response({ list: [{ vod_id: 1, vod_name: '可用样例' }] });
  } });
  let result = await service.update();
  assert.deepEqual(store.config().sources.map(item => item.id), ['good']);
  assert.equal(result.subscriptions[0].added, 1);
  assert.equal(result.sources[0].status, 'ok');
  changed = true;
  await service.update();
  assert.equal(store.config().sources[0].api, source('good').api);
  failed = false;
  result = await service.update();
  assert.equal(store.config().sources[0].api, 'https://replacement.example/api');
  assert.equal(result.subscriptions[0].updated, 1);
});

test('bounded discovery rotates beyond failing candidates and cannot be starved by the first twenty', async () => {
  const store = memoryStore(config({ subscriptions: [subscription()] }));
  const service = createSourceMaintenance({ store, request: async url => {
    if (url.pathname.endsWith('.json')) return response(feed(...Array.from({ length: 21 }, (_, i) => source('new' + i))));
    return url.hostname === 'new20.example' ? response({ list: [] }) : response({}, 503);
  } });
  await service.update(); assert.equal(store.config().sources.length, 0);
  await service.update(); assert.deepEqual(store.config().sources.map(item => item.id), ['new20']);
});

test('source verification rechecks user changes made while a new API is being probed', async () => {
  const store = memoryStore(config({ subscriptions: [subscription()] }));
  let release, probing;
  const waiting = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { probing = resolve; });
  const service = createSourceMaintenance({ store, request: async url => {
    if (url.pathname.endsWith('.json')) return response(feed(source('new')));
    probing(); await waiting; return response({ list: [] });
  } });
  const pending = service.update(); await started;
  const custom = source('new', { api: 'https://user.example/api', enabled: false });
  store.setConfig({ ...store.config(), showAdult: true, sources: [custom] });
  release(); await pending;
  assert.deepEqual(store.config().sources, [custom]);
  assert.equal(store.config().showAdult, true);
});
