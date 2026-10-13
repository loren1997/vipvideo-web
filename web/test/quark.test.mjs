import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, rm, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, sep, basename } from 'node:path';
import { setImmediate as turn } from 'node:timers/promises';
import { createQuark } from '../lib/quark.mjs';

const COOKIE = '__kp=synthetic-account-A-secret; __pus=synthetic-login; __puus=synthetic-session';
const COOKIE_B = '__kp=synthetic-account-B-secret; __pus=synthetic-login-B; __puus=synthetic-session-B';
const DAY = 86400000, GIB = 1024 ** 3;
const detail = { source: 'fixture', id: '1', title: '影片', year: '2026', category: 'movie', quarkShares: ['https://pan.quark.cn/s/abcdef123456'], lines: [{ episodes: [{ name: '正片', type: 'mp4', url: 'https://media.example/movie.mp4' }] }] };
function reply(data, { code = 0, status = 200, http = 200, headers = {}, finalUrl } = {}) { return Object.assign(Readable.from([Buffer.from(JSON.stringify({ code, status, data }))]), { statusCode: http, headers, finalUrl }); }
function textReply(value) { return Object.assign(Readable.from([Buffer.from(value)]), { statusCode: 200, headers: {} }); }
const sourceVideo = (fid = 'share-video', fileName = '影片.2026.mp4', size = 9 * 1024 * 1024) => ({ fid, file_name: fileName, size, file: true, category: 1, pdir_fid: '0', share_fid_token: 'synthetic-file-token-' + fid });
async function fixture(t, extra = {}) {
  const dataDir = await mkdtemp(resolve(tmpdir(), 'vipvideo-quark-test-'));
  t.after(async () => { const target = resolve(dataDir); assert.ok(target.startsWith(resolve(tmpdir()) + sep)); assert.ok(basename(target).startsWith('vipvideo-quark-test-')); await rm(target, { recursive: true, force: true }); });
  const metadata = new Map(), store = { meta: key => metadata.get(key), setMeta: (key, value) => metadata.set(key, value) };
  const state = { clock: Date.UTC(2026, 0, 1), calls: [], searchCalls: [], source: [sourceVideo()], folders: new Map(), files: [], tasks: new Map(), trash: [{ record_id: 'user-trash-record', fid: 'user-trash-file', file_name: '用户自己的视频.mp4', size: 100, pdir_fid: 'user-folder' }], saved: 0, deletes: [], purges: [], playError: false, pending: false, saveLost: false, beforeRequest: null, searchBody: '<rss></rss>', playUrl: 'https://video-cloud.quark.cn/movie.m3u8?sig=A%2BB&vip=platform', downloadUrl: 'https://download.quark.cn/movie.mp4?sign=original' };
  const userFolder = { fid: 'user-folder', file_name: '用户原有目录', file: false, pdir_fid: '0' };
  const userFile = { fid: 'user-file', file_name: '用户原有影片.mp4', file: true, size: 111, pdir_fid: 'user-folder' };
  async function request(value, options = {}) {
    const parsed = new URL(value), path = parsed.pathname.replace('/1/clouddrive', ''), body = options.body ? JSON.parse(options.body) : undefined;
    const account = (options.headers?.cookie || '').includes('account-B') ? 'B' : 'A';
    const call = { value, path, options, body, account }; state.calls.push(call);
    assert.equal(parsed.origin, 'https://drive.quark.cn'); assert.equal(options.followRedirects, false);
    if (state.beforeRequest) { const overridden = await state.beforeRequest(call); if (overridden) return overridden; }
    if (path === '/config') return reply({ uid: 'synthetic-profile-' + account });
    if (path === '/file/sort') {
      const parent = parsed.searchParams.get('pdir_fid'), size = Number(parsed.searchParams.get('_size') || 100), page = Number(parsed.searchParams.get('_page') || 1);
      const rows = parent === '0' ? [userFolder, ...(state.folders.has(account) ? [state.folders.get(account)] : [])] : parent === 'user-folder' ? [userFile] : state.files.filter(file => file.pdir_fid === parent && file.account === account);
      return Object.assign(reply({ list: rows.slice((page - 1) * size, page * size) }), { });
    }
    if (path === '/file' && options.method === 'POST') { assert.equal(body.pdir_fid, '0'); assert.match(body.file_name, /^VipVideo-[a-f0-9]{32}$/); const folder = { fid: 'app-folder-' + account, file_name: body.file_name, file: false, pdir_fid: '0' }; state.folders.set(account, folder); return reply({ fid: folder.fid }); }
    if (path === '/share/sharepage/token') return reply({ stoken: 'synthetic-share-token' });
    if (path === '/share/sharepage/detail') return reply({ list: state.source });
    if (path === '/share/sharepage/save') {
      assert.equal(body.fid_list.length, 1); assert.equal(body.fid_token_list.length, 1); assert.equal(body.to_pdir_fid, state.folders.get(account)?.fid);
      const source = state.source.find(file => file.fid === body.fid_list[0]); assert.ok(source && source.file);
      const fid = 'saved-' + (++state.saved), task = 'task-' + state.saved;
      const file = { ...source, fid, pdir_fid: body.to_pdir_fid, account }; delete file.share_fid_token;
      state.files.push(file); state.tasks.set(task, { fid, account });
      if (state.saveLost) throw new Error('lost reply with synthetic sensitive value ' + COOKIE);
      return reply({ task_id: task });
    }
    if (path === '/task') { const task = state.tasks.get(parsed.searchParams.get('task_id')); return reply(state.pending || !task ? { status: 1 } : { status: 2, save_as: { save_as_select_top_fids: [task.fid] } }); }
    if (path === '/file/v2/play/project') { if (state.playError) return reply(null, { code: 403, status: 403 }); return reply({ video_list: [{ resolution: 'high', video_info: { url: 'https://video-cloud.quark.cn/low.m3u8', width: 1280, height: 720, success: true } }, { resolution: 'super', video_info: { url: state.playUrl, width: 1920, height: 1080, success: true } }] }); }
    if (path === '/file/download') { assert.equal(body.fids.length, 1); return reply([{ fid: body.fids[0], download_url: state.downloadUrl }]); }
    if (path === '/file/delete') { assert.deepEqual(body.exclude_fids, []); assert.equal(body.action_type, 2); assert.equal(body.filelist.length, 1); const file = state.files.find(file => file.fid === body.filelist[0] && file.account === account); assert.ok(file); state.deletes.push(body.filelist[0]); state.files = state.files.filter(row => row !== file); state.trash.push({ ...file, record_id: 'trash-' + file.fid }); return reply({}); }
    if (path === '/file/recycle/list') return reply({ list: state.trash });
    if (path === '/file/recycle/remove') { assert.equal(body.select_mode, 2); assert.equal(body.record_list.length, 1); assert.notEqual(body.record_list[0], 'user-trash-record'); state.purges.push(body.record_list[0]); state.trash = state.trash.filter(row => !body.record_list.includes(row.record_id)); return reply({}); }
    throw new Error('Unexpected synthetic endpoint ' + path);
  }
  async function searchRequest(value, options) { state.searchCalls.push({ value, options }); assert.equal(options.headers.cookie, undefined); assert.equal(options.headers.authorization, undefined); return textReply(state.searchBody); }
  const options = { store, dataDir, request, searchRequest, now: () => state.clock, ...extra };
  const service = createQuark(options); t.after(() => service.stop());
  const connect = input => service.configure({ cookie: COOKIE, enabled: true, ...input });
  async function select(film = detail) { const resources = await service.resources(film); const shareId = resources.resources[0]?.id; const files = await service.files(film, { shareId, line: 0, episode: 0 }); return { shareId, fileId: files.files[0]?.id, files }; }
  async function save(film = detail) { const selected = await select(film); return service.prepare(film, { ...selected, line: 0, episode: 0 }); }
  return { service, options, state, metadata, store, dataDir, request, connect, select, save, userFolder, userFile };
}

test('connected share requests use the stored Cookie only at the fixed official API; anonymous and disabled accounts do not', async t => {
  const { service, state, connect, select } = await fixture(t);
  await select();
  assert.ok(state.calls.filter(call => call.path.startsWith('/share/')).every(call => call.options.headers.cookie === undefined));
  await connect(); state.calls.length = 0;
  state.beforeRequest = call => call.path.startsWith('/share/') && call.options.headers.cookie !== COOKIE ? reply({}, { http: 403 }) : undefined;
  const listing = await select(); assert.equal(listing.files.files.length, 1);
  const shared = state.calls.filter(call => call.path.startsWith('/share/'));
  assert.deepEqual(shared.map(call => call.path), ['/share/sharepage/token', '/share/sharepage/detail']);
  for (const call of shared) {
    assert.equal(call.options.headers.cookie, COOKIE); assert.equal(call.options.followRedirects, false);
    const target = new URL(call.value); assert.equal(target.origin, 'https://drive.quark.cn');
    assert.equal(target.searchParams.get('pr'), 'ucpro'); assert.equal(target.searchParams.get('fr'), 'pc');
    assert.equal(call.options.headers.referer, 'https://pan.quark.cn/'); assert.ok(!call.value.includes(COOKIE));
  }
  assert.ok(!JSON.stringify(listing).includes(COOKIE)); assert.equal(state.saved, 0); assert.deepEqual(state.deletes, []);
  state.beforeRequest = null; await service.configure({ enabled: false }); state.calls.length = 0; await select();
  assert.ok(state.calls.filter(call => call.path.startsWith('/share/')).every(call => call.options.headers.cookie === undefined));
  assert.ok(state.searchCalls.every(call => call.options.headers.cookie === undefined));
});

test('share failures distinguish authentication, denied access and throttling without leaking upstream messages or retrying', async t => {
  const { service, state, metadata, connect, select } = await fixture(t); await connect();
  const savedConfig = metadata.get('quark-settings-v1');
  assert.ok(savedConfig);
  for (const channel of ['http', 'json']) for (const status of [401, 403, 429]) {
    const before = state.calls.length;
    state.beforeRequest = call => call.path === '/share/sharepage/token' ? reply({ message: COOKIE }, channel === 'http' ? { http: status } : { code: 1, status }) : undefined;
    await assert.rejects(select(), error => {
      assert.equal(error.status, status); assert.equal(error.quarkAuth === true, status === 401);
      assert.ok(!error.message.includes(COOKIE));
      if (status !== 401) assert.match(error.message, new RegExp(String(status)));
      if (status === 403) assert.doesNotMatch(error.message, /登录已失效/);
      return true;
    });
    assert.equal(state.calls.length - before, 1, 'denials and throttling must not trigger automatic retries');
    assert.equal(metadata.get('quark-settings-v1'), savedConfig);
  }
  assert.equal((await service.settings()).account.connected, true);
  assert.equal(state.saved, 0); assert.deepEqual(state.deletes, []); assert.equal(state.folders.size, 0);
});

test('share reads cancel after account changes, shutdown or revoked authorization without continuing the old listing', async t => {
  for (const stage of ['token', 'detail']) for (const action of ['disconnect', 'disable', 'switch', 'stop']) await t.test(`${stage}-${action}`, async t => {
    const { service, state, connect, select } = await fixture(t); await connect();
    let release, entered; const reached = new Promise(resolve => { entered = resolve; });
    state.beforeRequest = async call => {
      if (call.path !== `/share/sharepage/${stage}`) return;
      entered(); await new Promise(resolve => { release = resolve; });
      return stage === 'token' ? reply({ stoken: 'synthetic-old-token' }) : reply({ list: [sourceVideo()] });
    };
    const rejected = assert.rejects(select(), error => error.status === 409);
    await reached;
    let stopping;
    try {
      if (action === 'disconnect') await service.clearAccount();
      else if (action === 'disable') await service.configure({ enabled: false });
      else if (action === 'switch') await connect({ cookie: COOKIE_B });
      else stopping = service.stop();
    } finally { release(); }
    await rejected; await stopping;
    assert.equal(state.calls.filter(call => call.path === '/share/sharepage/detail').length, stage === 'token' ? 0 : 1);
    assert.equal(state.saved, 0); assert.equal(state.folders.size, 0); assert.deepEqual(state.deletes, []);
  });
  const { service, state } = await fixture(t);
  const shares = await service.resources(detail); state.calls.length = 0;
  await assert.rejects(service.files(detail, { shareId: shares.resources[0].id, valid: () => false }), error => error.status === 409);
  assert.equal(state.calls.length, 0);
});

test('old share selections cannot transfer after account replacement or disconnection', async t => {
  const { service, state, connect, select } = await fixture(t); await connect();
  const selected = await select(); await connect({ cookie: COOKIE_B });
  assert.equal((await service.prepare(detail, selected)).status, 'error');
  const next = await select(); await service.clearAccount(); await connect({ cookie: COOKIE_B });
  assert.equal((await service.prepare(detail, next)).status, 'error');
  assert.equal(state.saved, 0); assert.equal(state.folders.size, 0);
});

test('partially failed listings still evict old share candidates at the cache limit', async t => {
  const { service, state, connect, select } = await fixture(t); await connect();
  const oldest = await select();
  for (let batch = 0; batch < 3; batch++) {
    state.beforeRequest = call => {
      if (call.path !== '/share/sharepage/detail') return;
      const page = Number(new URL(call.value).searchParams.get('_page'));
      if (page === 5) return reply({}, { http: 403 });
      return Object.assign(Readable.from([JSON.stringify({ code: 0, status: 200, data: { list: Array.from({ length: 100 }, (_, i) => sourceVideo(`batch-${batch}-page-${page}-${i}`)) }, metadata: { _total: 600 } })]), { statusCode: 200, headers: {} });
    };
    await assert.rejects(select(), error => error.status === 403);
  }
  state.beforeRequest = null;
  assert.equal((await service.prepare(detail, oldest)).status, 'error');
  assert.equal(state.saved, 0); assert.equal(state.folders.size, 0);
});

test('defaults are disconnected and all automatic cloud mutations are disabled', async t => {
  const { service, state } = await fixture(t); const settings = await service.settings();
  assert.equal(settings.configured, false); assert.equal(settings.enabled, false); assert.equal(settings.autoSave, false); assert.equal(settings.cleanupEnabled, false); assert.equal(settings.retentionDays, 7);
  assert.equal(settings.maxDailyTransfers, 100); assert.equal(settings.maxDailyBytes, 20 * GIB); assert.equal(state.calls.length, 0);
  assert.equal((await service.cleanup()).checked, 0); assert.equal((await service.prepare(detail, { auto: true })).status, 'error'); assert.equal(state.saved, 0);
});

test('the old default limit upgrades once to 100 without resetting later choices or the encrypted account', async t => {
  const { service, options, metadata, state, connect } = await fixture(t);
  await connect({ maxDailyTransfers: 10, retentionDays: 30 }); await service.stop();
  metadata.delete('quark-transfer-default-100-v1');
  const before = JSON.parse(metadata.get('quark-settings-v1'));
  const migrated = createQuark(options); t.after(() => migrated.stop());
  const settings = await migrated.settings(), after = JSON.parse(metadata.get('quark-settings-v1'));
  assert.equal(settings.maxDailyTransfers, 100); assert.equal(settings.retentionDays, 30);
  assert.equal(settings.account.connected, true); assert.deepEqual(after.account, before.account);
  assert.equal(after.installId, before.installId); assert.equal(settings.maxDailyBytes, 20 * GIB);
  await migrated.configure({ maxDailyTransfers: 10 }); await migrated.stop();
  const reopened = createQuark(options); t.after(() => reopened.stop());
  assert.equal((await reopened.settings()).maxDailyTransfers, 10);
  await reopened.stop();
  for (const limit of [1, 25, 50, 100]) {
    metadata.delete('quark-transfer-default-100-v1');
    metadata.set('quark-settings-v1', JSON.stringify({ ...before, maxDailyTransfers: limit }));
    const custom = createQuark(options); t.after(() => custom.stop());
    assert.equal((await custom.settings()).maxDailyTransfers, limit); await custom.stop();
  }
  assert.equal(state.saved, 0); assert.deepEqual(state.deletes, []);
});

test('100 daily transfers persist across restart, reject invalid settings and stop the 101st transfer before saving', async t => {
  const { service, options, metadata, state, connect, save } = await fixture(t);
  await connect({ maxDailyTransfers: 100 }); await save();
  const settings = metadata.get('quark-settings-v1');
  for (const value of [0, 101, 1.5, '100']) await assert.rejects(service.configure({ maxDailyTransfers: value }), error => error.status === 400);
  assert.equal(metadata.get('quark-settings-v1'), settings);
  await service.stop();
  const registry = JSON.parse(metadata.get('quark-registry-v1')), first = registry.assets[0];
  registry.assets = [first, ...Array.from({ length: 98 }, (_, i) => ({ ...first, id: (i + 1).toString(16).padStart(32, '0'), fid: 'historical-' + i }))];
  metadata.set('quark-registry-v1', JSON.stringify(registry));
  const reopened = createQuark(options); t.after(() => reopened.stop());
  assert.equal((await reopened.settings()).maxDailyTransfers, 100);
  const prepare = async fid => {
    state.source = [sourceVideo(fid)];
    const shares = await reopened.resources(detail), shareId = shares.resources[0].id;
    const files = await reopened.files(detail, { shareId });
    return reopened.prepare(detail, { shareId, fileId: files.files[0].id });
  };
  assert.equal((await prepare('hundredth')).status, 'ready');
  assert.equal(JSON.parse(metadata.get('quark-registry-v1')).assets.length, 100);
  const count = state.saved;
  const denied = await prepare('hundred-and-first');
  assert.equal(denied.status, 'error'); assert.match(denied.reason, /上限/);
  assert.equal(state.saved, count); assert.deepEqual(state.deletes, []);
});

test('config plus authenticated root listing verifies Cookie before AES-GCM persistence and masked output', async t => {
  const { service, connect, metadata, dataDir, state } = await fixture(t); const settings = await connect();
  assert.equal(settings.configured, true); assert.deepEqual(state.calls.slice(0, 2).map(call => call.path), ['/config', '/file/sort']);
  const persisted = metadata.get('quark-settings-v1'); assert.ok(persisted.includes('ciphertext')); assert.ok(!persisted.includes(COOKIE)); assert.ok(!JSON.stringify(settings).includes('synthetic'));
  assert.equal((await readFile(resolve(dataDir, 'quark.key'))).length, 32); if (process.platform !== 'win32') assert.equal((await stat(resolve(dataDir, 'quark.key'))).mode & 0o777, 0o600);
  const reloaded = createQuark({ ...(await fixture(t)).options, store: { meta: key => metadata.get(key), setMeta: (key, value) => metadata.set(key, value) }, dataDir }); t.after(() => reloaded.stop());
  const copies = await Promise.all([reloaded.settings(), reloaded.settings()]); assert.ok(copies.every(copy => copy.configured));
  await service.clearAccount(); assert.equal((await service.settings()).configured, false); assert.equal(state.deletes.length, 0);
});

test('request Cookie copies support prefixes, token names and repeated pairs while requiring remote account verification', async t => {
  const { service, state, metadata } = await fixture(t);
  const samples = [
    [' Cookie: ' + COOKIE + ' ; ', COOKIE],
    ['cookie: __puus=synthetic-session', '__puus=synthetic-session'],
    ['new.session=synthetic-session; __puus=synthetic-session', 'new.session=synthetic-session; __puus=synthetic-session'],
    ['__puus=first-synthetic; __puus=second-synthetic', '__puus=first-synthetic; __puus=second-synthetic'],
  ];
  for (const [input, expected] of samples) {
    const before = state.calls.length;
    assert.equal((await service.configure({ cookie: input, enabled: true })).configured, true);
    assert.deepEqual(state.calls.slice(before).map(call => call.path), ['/config', '/file/sort']);
    assert.ok(state.calls.slice(before).every(call => call.options.headers.cookie === expected));
  }
  const saved = metadata.get('quark-settings-v1');
  state.beforeRequest = call => call.path === '/file/sort' ? reply(null, { code: 401, status: 401 }) : null;
  await assert.rejects(service.configure({ cookie: '__puus=expired-synthetic' }), /拒绝|登录/);
  assert.equal(metadata.get('quark-settings-v1'), saved);
  assert.equal(state.saved, 0); assert.equal(state.deletes.length, 0);
});

test('malformed Cookie and header injection are rejected before any network call', async t => {
  const { service, state, metadata } = await fixture(t);
  for (const cookie of ['Cookie:', 'Cookie: ; ;', 'Set-Cookie: __puus=x; HttpOnly', '[{"name":"__puus","value":"x"}]',
    '__puus=x\r\nHost: evil', '__puus=x\tHost:evil', '__puus=x\u0001', '__puus=x\u007f', 'not-a-cookie']) {
    await assert.rejects(service.configure({ cookie }), error => error.status === 400 && /Cookie 格式无效/.test(error.message));
  }
  assert.equal(state.calls.length, 0); assert.equal(metadata.has('quark-settings-v1'), false);
});

test('anonymous config success is insufficient and invalid Cookie/settings are never persisted', async t => {
  const { service, state, metadata } = await fixture(t);
  state.beforeRequest = call => call.path === '/file/sort' ? reply(null, { code: 401, status: 401 }) : null;
  await assert.rejects(service.configure({ cookie: COOKIE, enabled: true }), /拒绝|登录/); assert.equal(metadata.has('quark-settings-v1'), false);
  for (const input of [{ cookie: '__puus=only-anonymous' }, { cookie: '__kp=x\r\nHost: evil' }, { cookie: '__kp=x; __kp=y' }, { retentionDays: 0 }, { retentionDays: 366 }, { maxDailyTransfers: 0 }, { cleanupEnabled: 'true' }, { searchApi: 'http://127.0.0.1:8888/api/search' }]) await assert.rejects(service.configure(input));
  assert.equal((await service.settings()).configured, false);
});

test('missing or tampered key/ciphertext fails closed while account replacement can reconnect', async t => {
  const { service, options, connect, metadata, dataDir } = await fixture(t); await connect();
  await unlink(resolve(dataDir, 'quark.key')); const missing = createQuark(options); t.after(() => missing.stop()); assert.equal((await missing.settings()).configured, false); assert.match((await missing.settings()).lastError, /密钥|解密/);
  await writeFile(resolve(dataDir, 'quark.key'), Buffer.alloc(32, 2)); const wrong = createQuark(options); t.after(() => wrong.stop()); assert.equal((await wrong.settings()).configured, false);
  const stored = JSON.parse(metadata.get('quark-settings-v1')); stored.account.tag = Buffer.alloc(16).toString('base64'); metadata.set('quark-settings-v1', JSON.stringify(stored)); const tampered = createQuark(options); t.after(() => tampered.stop()); assert.equal((await tampered.settings()).configured, false);
  await service.clearAccount(); assert.equal((await service.settings()).configured, false);
});

test('public search preserves PanSou password/work title, validates shares and never receives account Cookie', async t => {
  const { service, state, connect } = await fixture(t, { defaultSearchApi: 'https://search.example/api/search' }); await connect();
  state.searchBody = JSON.stringify({ total: 2, results: [{ title: '合集', links: [{ type: 'quark', url: 'https://pan.quark.cn/s/aaaabbbbcccc', password: 'Ab12', work_title: '影片 2026' }, { type: 'baidu', url: 'https://pan.quark.cn.evil/s/abcdef123456' }] }] });
  const film = { ...detail, quarkShares: [] }, result = await service.resources(film); assert.equal(result.resources.length, 1); assert.equal(result.resources[0].name, '影片 2026'); assert.equal(result.resources[0].url, 'https://pan.quark.cn/s/aaaabbbbcccc?pwd=Ab12');
  const target = new URL(state.searchCalls[0].value); assert.equal(target.searchParams.get('kw'), '影片 2026'); assert.equal(target.searchParams.get('cloud_types'), 'quark'); assert.equal(target.searchParams.get('conc'), '2');
  const list = await service.files(film, { shareId: result.resources[0].id }); assert.ok(list.files[0].id); const token = state.calls.find(call => call.path === '/share/sharepage/token'); assert.equal(token.body.passcode, 'Ab12'); assert.equal(token.options.headers.cookie, COOKIE);
  for (const bad of ['http://127.0.0.1/a', 'https://pan.quark.cn.evil/s/abcdef123456', 'https://evil.example/s/abcdef123456', 'file:///a', 'https://user:pw@pan.quark.cn/s/abcdef123456']) assert.equal((await service.resources({ ...detail, id: bad, quarkShares: [bad] })).resources.length, 1); // Only the safe search result survives.
});

test('fixed PanSou sidecar requires explicit safe DI and nonempty saved search setting overrides environment', async t => {
  const { service, state } = await fixture(t, { defaultSearchApi: 'http://pansou:8888/api/search' }); await service.resources(detail); assert.equal(new URL(state.searchCalls[0].value).origin, 'http://pansou:8888');
  await service.configure({ searchApi: 'https://preferred.example/api/search' }); await service.resources(detail); assert.equal(new URL(state.searchCalls.at(-1).value).origin, 'https://preferred.example');
  await service.configure({ searchApi: '' }); await service.resources(detail); assert.equal(new URL(state.searchCalls.at(-1).value).origin, 'http://pansou:8888');
  await assert.rejects(service.configure({ searchApi: 'http://pansou:9999/api/search' }));
});

test('file candidates expose opaque IDs only and complete exact movie evidence permits one automatic save', async t => {
  const { service, state, connect, select } = await fixture(t); await connect({ autoSave: true });
  const selected = await select(); assert.equal(selected.files.files[0].match, true); assert.match(selected.fileId, /^[a-f0-9]{32}$/); assert.ok(!JSON.stringify(selected.files).includes('synthetic-file-token')); assert.ok(!JSON.stringify(selected.files).includes('share-video'));
  const result = await service.prepare(detail, { shareId: selected.shareId, line: 0, episode: 0, auto: true }); assert.equal(result.status, 'ready'); assert.equal(result.saved, true); assert.equal(result.category, 'movie'); assert.equal(state.saved, 1);
  const save = state.calls.find(call => call.path === '/share/sharepage/save'); assert.deepEqual(save.body.fid_list, ['share-video']); assert.notEqual(save.body.to_pdir_fid, '0');
});

test('ambiguity, unknown years, mismatched seasons or episodes and incomplete selection prevent automatic saves', async t => {
  const { service, state, connect } = await fixture(t); await connect({ autoSave: true });
  for (const source of [[sourceVideo('x', '影片.mp4')], [sourceVideo('x', '影片.2025.mp4')], [sourceVideo('x', '影片2.2026.mp4')], [sourceVideo('x'), sourceVideo('y', '影片.2026.1080p.mp4')]]) { state.source = source; assert.equal((await service.prepare(detail, { auto: true })).status, 'needsSelection'); }
  state.source = [sourceVideo('x', '剧集.2026.S02E01.mp4')]; const series = { ...detail, id: 'series', title: '剧集', category: 'tv', lines: [{ episodes: [{ name: '第01集' }, { name: '第02集' }] }] };
  assert.equal((await service.prepare(series, { auto: true })).status, 'needsSelection'); assert.equal((await service.prepare({ ...series, season: 1 }, { auto: true })).status, 'needsSelection');
  state.source = [sourceVideo('x', '剧集.2026.S01E02.mp4')]; assert.equal((await service.prepare({ ...series, season: 1 }, { episode: 0, auto: true })).status, 'needsSelection');
  assert.equal((await service.prepare(detail, { line: 99, episode: 0, auto: true })).status, 'needsSelection'); assert.equal(state.saved, 0);
});

test('manually chosen opaque video is bound to its detail/share and saves exactly one file', async t => {
  const { service, connect, select, state } = await fixture(t); await connect(); state.source = [sourceVideo('x', '另一个文件.mkv')];
  const selected = await select(); assert.equal(selected.files.files[0].match, false);
  assert.equal((await service.prepare({ ...detail, id: 'different' }, { ...selected })).status, 'error');
  assert.equal((await service.prepare(detail, { fileId: 'user-file', shareId: selected.shareId })).status, 'error');
  assert.equal((await service.prepare(detail, { ...selected })).status, 'ready'); assert.equal(state.saved, 1);
});

test('share traversal stays within three directory levels and six requests and ignores nonvideo/folder leaves', async t => {
  const { service, state, select } = await fixture(t); state.source = [{ fid: 'folder', file_name: 'folder.mp4', file: false }, { fid: 'pdf', file_name: '影片.2026.pdf', file: true }, sourceVideo()];
  state.beforeRequest = call => call.path === '/share/sharepage/detail' ? reply({ list: [{ fid: 'next-' + state.calls.filter(value => value.path === call.path).length, file_name: 'deeper', file: false }, sourceVideo()] }) : null;
  const selected = await select(); assert.equal(selected.files.truncated, true); assert.ok(selected.files.files.every(file => /\.mp4$/.test(file.name))); assert.ok(state.calls.filter(call => call.path.startsWith('/share/sharepage')).length <= 6);
});

test('singleflight and durable pending tasks deduplicate saves and daily quota accounting', async t => {
  const { service, state, connect, select, metadata } = await fixture(t); await connect(); state.pending = true;
  const selected = await select(), options = { ...selected, line: 0, episode: 0 };
  const results = await Promise.all([service.prepare(detail, options), service.prepare(detail, options)]); assert.ok(results.every(result => result.status === 'pending')); assert.equal(state.saved, 1);
  assert.equal((await service.prepare(detail, options)).status, 'pending'); assert.equal(state.saved, 1); assert.equal(JSON.parse(metadata.get('quark-registry-v1')).assets.length, 1);
  state.pending = false; const ready = await service.prepare(detail, options); assert.equal(ready.status, 'ready'); assert.equal(state.saved, 1);
  await service.prepare(detail, options); assert.equal(state.saved, 1);
});

test('a lost save response persists an uncertain intent and restart never blindly repeats the transfer', async t => {
  const { service, state, connect, select, options, metadata } = await fixture(t); await connect(); const selected = await select(); state.saveLost = true;
  const first = await service.prepare(detail, selected); assert.equal(first.status, 'error'); assert.ok(!first.reason.includes(COOKIE)); assert.equal(state.saved, 1);
  assert.equal((await service.prepare(detail, selected)).status, 'pending'); assert.equal(state.saved, 1);
  const next = createQuark(options); t.after(() => next.stop()); const shares = await next.resources(detail), files = await next.files(detail, { shareId: shares.resources[0].id });
  const retry = await next.prepare(detail, { shareId: shares.resources[0].id, fileId: files.files[0].id }); assert.equal(retry.status, 'pending'); assert.equal(state.saved, 1); assert.ok(!JSON.stringify([...metadata.values()]).includes(COOKIE));
});

test('quota counts total daily bytes, never charges reuse and rejects unknown or excessive file sizes', async t => {
  const { service, state, connect, select } = await fixture(t); await connect({ maxDailyTransfers: 1, maxDailyBytes: 20 * GIB });
  const first = await select(); assert.equal((await service.prepare(detail, first)).status, 'ready'); assert.equal((await service.prepare(detail, first)).status, 'ready');
  state.source = [sourceVideo('second')]; const second = await select(); assert.match((await service.prepare(detail, second)).reason, /上限/); assert.equal(state.saved, 1);
  for (const size of [0, NaN, 21 * GIB]) { state.source = [sourceVideo('unknown', '影片.2026.mp4', size)]; const selected = await select(); assert.equal((await service.prepare(detail, selected)).status, 'error'); }
  await service.configure({ maxDailyTransfers: 10, maxDailyBytes: 5 * 1024 * 1024 }); state.source = [sourceVideo('bytes-limit')]; const selected = await select(); assert.match((await service.prepare(detail, selected)).reason, /上限/);
});

test('playback uses the best officially returned quality and keeps stable category/version metadata', async t => {
  const { service, connect, save, state } = await fixture(t); await connect(); const saved = await save({ ...detail, category: 'adult' });
  const result = await service.playback(saved.assetId); assert.equal(result.episode.url, state.playUrl); assert.equal(result.episode.type, 'hls'); assert.deepEqual(result.metadata.quality, { width: 1920, height: 1080 }); assert.equal(result.metadata.category, 'adult'); assert.match(result.metadata.version, /^[a-f0-9]{24}$/);
  assert.deepEqual(result.allowCookieOrigins, ['https://video-cloud.quark.cn']); assert.equal(result.headers.cookie, COOKIE);
  const same = await service.playback(saved.assetId); assert.equal(same.metadata.version, result.metadata.version);
  await assert.rejects(service.playback('user-file'), /登记/); assert.equal(state.deletes.length, 0);
});

test('download fallback preserves the exact request Cookie snapshot and MKV compatibility metadata', async t => {
  const { service, state, connect, save } = await fixture(t); await connect(); state.source = [sourceVideo('mkv', '影片.2026.mkv')]; state.playError = true;
  const saved = await save(), result = await service.playback(saved.assetId);
  const request = state.calls.find(call => call.path === '/file/download'); assert.equal(result.headers.cookie, request.options.headers.cookie); assert.equal(result.episode.url, state.downloadUrl); assert.equal(result.episode.type, 'mkv'); assert.equal(result.metadata.requiresCompatibility, true); assert.equal(result.metadata.mode, 'download');
});

test('AVI, TS and M2TS downloads use explicit compatible demuxer types when official playback is unavailable', async t => {
  const { service, state, connect, save } = await fixture(t); await connect(); state.playError = true;
  for (const [extension, type] of [['avi', 'avi'], ['ts', 'mpegts'], ['m2ts', 'mpegts']]) {
    state.source = [sourceVideo('format-' + extension, '影片.2026.' + extension)];
    const saved = await save(), result = await service.playback(saved.assetId);
    assert.equal(result.episode.type, type); assert.equal(result.metadata.mode, 'download'); assert.equal(result.metadata.requiresCompatibility, true);
  }
});

test('unknown CDN, insecure first-party HTTP and deceptive suffixes never receive Cookie', async t => {
  const { service, state, connect, save } = await fixture(t); await connect(); const saved = await save(); state.playError = true;
  for (const target of ['https://unknown-cdn.example/movie.mp4?sig=ok', 'https://quark.cn.evil.example/movie.mp4', 'http://download.quark.cn/movie.mp4']) { state.downloadUrl = target; const result = await service.playback(saved.assetId); assert.equal(result.headers.cookie, undefined); assert.deepEqual(result.allowCookieOrigins, []); }
  state.downloadUrl = 'http://127.0.0.1/movie.mp4'; await assert.rejects(service.playback(saved.assetId), /安全/);
});

test('only ended plus a known near-end position marks watched; replay and active leases block deletion', async t => {
  const { service, state, connect, save } = await fixture(t); await connect({ cleanupEnabled: true }); const saved = await save();
  assert.equal((await service.progress(saved.assetId, { position: 99, duration: 100, ended: false })).ended, false); assert.equal((await service.progress(saved.assetId, { position: 50, duration: 100, ended: true })).watchedAt, null);
  const finished = await service.progress(saved.assetId, { position: 100, duration: 100, ended: true }); assert.equal(finished.ended, true);
  state.clock += 6 * DAY; assert.equal((await service.cleanup()).checked, 0);
  state.clock += 2 * DAY; await service.playback(saved.assetId); assert.equal((await service.cleanup()).checked, 0);
  await service.progress(saved.assetId, { position: 0, duration: 100, ended: false }); state.clock += 8 * DAY; assert.equal((await service.cleanup()).checked, 0); assert.equal(state.deletes.length, 0);
  for (const input of [{ position: NaN, duration: 100, ended: true }, { position: 999, duration: 100, ended: true }, { position: 1, duration: 0, ended: true }, { position: 1, duration: 100, ended: 'yes' }]) await assert.rejects(service.progress(saved.assetId, input));
});

test('retained watched files remove only the registered single video and its matching recycle record', async t => {
  const { service, state, connect, save, userFile } = await fixture(t); await connect({ cleanupEnabled: true }); const saved = await save();
  await service.progress(saved.assetId, { position: 100, duration: 100, ended: true }); state.clock += 8 * DAY;
  const result = await service.cleanup(); assert.equal(result.deleted, 1); assert.deepEqual(state.deletes, ['saved-1']); assert.deepEqual(state.purges, ['trash-saved-1']); assert.ok(state.trash.some(file => file.record_id === 'user-trash-record')); assert.ok(userFile.fid === 'user-file');
  assert.equal((await service.settings()).managedFiles, 0); assert.equal((await service.cleanup()).deleted, 0);
});

test('cleanup caps each pass at five and leaves unwatched files and the user trash untouched', async t => {
  const { service, state, connect, select } = await fixture(t); await connect({ cleanupEnabled: true });
  for (let i = 0; i < 7; i++) { state.source = [sourceVideo('video-' + i, '影片.2026.' + i + '.mp4')]; const selected = await select(), saved = await service.prepare(detail, selected); assert.equal(saved.status, 'ready'); if (i < 6) await service.progress(saved.assetId, { position: 100, duration: 100, ended: true }); }
  state.clock += 8 * DAY; const result = await service.cleanup(); assert.equal(result.checked, 5); assert.equal(result.deleted, 5); assert.equal(state.files.length, 2); assert.equal(state.trash.length, 1); assert.equal(state.trash[0].record_id, 'user-trash-record');
});

test('directory rename, moved files, disabled cleanup and account replacement all stop destructive operations', async t => {
  const { service, state, connect, save } = await fixture(t); await connect({ cleanupEnabled: true }); const saved = await save(); await service.progress(saved.assetId, { position: 100, duration: 100, ended: true }); state.clock += 8 * DAY;
  state.folders.get('A').file_name = '用户改名'; assert.equal((await service.cleanup()).deleted, 0); assert.equal(state.deletes.length, 0);
  state.folders.get('A').file_name = state.calls.find(call => call.path === '/file').body.file_name; state.files[0].pdir_fid = 'user-folder'; assert.equal((await service.cleanup()).deleted, 0); assert.equal(state.deletes.length, 0);
  await service.configure({ cleanupEnabled: false }); assert.equal((await service.cleanup()).checked, 0);
  await service.configure({ cookie: COOKIE_B, enabled: true, cleanupEnabled: true }); await assert.rejects(service.playback(saved.assetId), /登记/); assert.equal((await service.cleanup()).deleted, 0); assert.equal(state.deletes.length, 0); assert.equal(state.purges.length, 0);
});

test('a missing or ambiguous recycle identity never invokes all-trash removal or claims freed storage', async t => {
  const { service, state, connect, save } = await fixture(t); await connect({ cleanupEnabled: true }); const saved = await save(); await service.progress(saved.assetId, { position: 100, duration: 100, ended: true }); state.clock += 8 * DAY;
  state.beforeRequest = call => call.path === '/file/recycle/list' ? reply({ list: state.trash.filter(row => row.record_id === 'user-trash-record') }) : null;
  const result = await service.cleanup(); assert.equal(result.recycled, 1); assert.equal(result.deleted, 0); assert.equal(state.purges.length, 0); assert.equal(state.deletes.length, 1);
});

test('clearAccount during an in-flight save cancels later task/play actions and never switches credentials', async t => {
  const { service, state, connect, select } = await fixture(t); await connect(); const selected = await select();
  let reached, finish; const called = new Promise(resolve => { reached = resolve; }), gate = new Promise(resolve => { finish = resolve; });
  state.beforeRequest = async call => { if (call.path === '/share/sharepage/save') { reached(); await gate; } return null; };
  const pending = service.prepare(detail, selected); await called; await service.clearAccount(); finish(); const result = await pending; assert.equal(result.status, 'error'); assert.match(result.reason, /账号|取消/);
  assert.equal(state.calls.filter(call => call.path === '/task').length, 0); assert.equal(state.deletes.length, 0); assert.equal((await service.settings()).configured, false);
});

test('whole-request timeout handles late API headers and body stalls without persisting credentials', async t => {
  const { service, state, metadata } = await fixture(t); t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
  let finish; const gate = new Promise(resolve => { finish = resolve; }); state.beforeRequest = call => call.path === '/config' ? gate : null;
  const pending = service.configure({ cookie: COOKIE, enabled: true }); await turn(); t.mock.timers.tick(8000); await assert.rejects(pending, /8秒/);
  const late = reply({ uid: 'A' }); finish(late); await turn(); assert.equal(late.destroyed, true); assert.equal(metadata.has('quark-settings-v1'), false);
  const stalled = Object.assign(new Readable({ read() {} }), { statusCode: 200, headers: {} }); state.beforeRequest = call => call.path === '/config' ? stalled : null;
  const body = service.configure({ cookie: COOKIE, enabled: true }); await turn(); t.mock.timers.tick(8000); await assert.rejects(body); assert.equal(stalled.destroyed, true);
});

test('public search has singleflight, two slots, no credentials and destroys late responses', async t => {
  const { options } = await fixture(t); let finish, count = 0, active = 0, maximum = 0;
  const gate = new Promise(resolve => { finish = resolve; });
  const service = createQuark({ ...options, searchRequest: async (_url, request) => { assert.equal(request.headers.cookie, undefined); count++; active++; maximum = Math.max(maximum, active); await gate; active--; return textReply('<rss></rss>'); } }); t.after(() => service.stop());
  const requests = [service.resources(detail), service.resources(detail), service.resources({ ...detail, id: '2' }), service.resources({ ...detail, id: '3' })]; await turn(); assert.equal(count, 2); finish(); await Promise.all(requests); assert.equal(maximum, 2); assert.equal(count, 3);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 }); let resolveLate; const delayed = new Promise(resolve => { resolveLate = resolve; }); const lateService = createQuark({ ...options, searchRequest: async () => delayed }); t.after(() => lateService.stop());
  const pending = lateService.resources(detail); await turn(); t.mock.timers.tick(8000); const result = await pending; assert.match(result.reason, /超时/); const late = textReply('<rss></rss>'); resolveLate(late); await turn(); assert.equal(late.destroyed, true);
});

test('stop drains pending transfer writers before SQLite closes and rejects new operations', async t => {
  const { service, state, connect, select, store } = await fixture(t); await connect(); const selected = await select();
  let reached, finish, closed = false, writes = 0;
  const called = new Promise(resolve => { reached = resolve; }), gate = new Promise(resolve => { finish = resolve; });
  const original = store.setMeta; store.setMeta = (key, value) => { assert.equal(closed, false, 'SQLite write after stop returned'); writes++; original(key, value); };
  state.beforeRequest = async call => { if (call.path === '/share/sharepage/save') { reached(); await gate; } return null; };
  const pending = service.prepare(detail, selected); await called;
  let stopped = false; const stopping = service.stop().then(() => { stopped = true; closed = true; }); await turn(); assert.equal(stopped, false);
  await assert.rejects(service.configure({ enabled: true }), /关闭/); await assert.rejects(service.cleanup(), /关闭/);
  finish(); await stopping; await pending; const count = writes; await turn(); assert.equal(writes, count); assert.equal(state.calls.filter(call => call.path === '/task').length, 0);
  assert.equal(await service.stop(), undefined); assert.equal(state.deletes.length, 0);
});

test('persistent lastCleanup schedules initial, remaining and overdue runs across daily restarts', async t => {
  const { service, state, options, connect, save } = await fixture(t); await connect({ cleanupEnabled: true }); await save();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: state.clock });
  const before = state.calls.length; service.start(); t.mock.timers.tick(4999); await turn(); assert.equal(state.calls.length, before);
  state.clock += 5000; t.mock.timers.tick(1); await turn(); const first = await service.settings(); assert.equal(first.lastCleanup.at, state.clock); assert.ok(state.calls.length > before);
  await service.stop(); state.clock += 12 * 60 * 60 * 1000;
  const halfway = createQuark(options); t.after(() => halfway.stop()); assert.equal((await halfway.settings()).configured, true); const start = state.calls.length; halfway.start(); t.mock.timers.tick(5000); await turn(); assert.equal(state.calls.length, start);
  await halfway.stop(); state.clock += 2 * DAY;
  const restarted = createQuark(options); t.after(() => restarted.stop()); assert.equal((await restarted.settings()).configured, true); const previous = state.calls.length; restarted.start(); t.mock.timers.tick(4999); await turn(); assert.equal(state.calls.length, previous);
  state.clock += 5000; t.mock.timers.tick(1); await turn(); assert.ok(state.calls.length > previous); assert.equal((await restarted.settings()).lastCleanup.at, state.clock);
  const once = state.calls.length; t.mock.timers.tick(5000); await turn(); assert.equal(state.calls.length, once);
});

test('a revoked session/source hook after the file-list await prevents mkdir, save and quota charges', async t => {
  const { service, state, connect, metadata } = await fixture(t); await connect({ autoSave: true });
  let valid = true, reached, finish; const called = new Promise(resolve => { reached = resolve; }), gate = new Promise(resolve => { finish = resolve; });
  state.beforeRequest = async call => { if (call.path === '/share/sharepage/detail') { reached(); await gate; } return null; };
  const pending = service.prepare(detail, { auto: true, valid: () => valid }); await called; valid = false; finish();
  const result = await pending; assert.equal(result.status, 'error'); assert.match(result.reason, /授权/);
  assert.equal(state.calls.filter(call => ['/file', '/share/sharepage/save'].includes(call.path)).length, 0); assert.equal(JSON.parse(metadata.get('quark-registry-v1')).assets.length, 0);
});

test('slot-queued transfer rechecks authorization and removes its uncharged intent before a retry', async t => {
  let blocked = false, finish; const gate = new Promise(resolve => { finish = resolve; });
  const { service, state, connect, save, select, store, metadata } = await fixture(t, { searchRequest: async () => { if (blocked) await gate; return textReply('<rss></rss>'); } });
  await connect({ maxDailyTransfers: 2 }); await save(); state.source = [sourceVideo('second')]; const selected = await select();
  let valid = true, occupied = false, reached; const called = new Promise(resolve => { reached = resolve; });
  const original = store.setMeta, searches = [];
  store.setMeta = (key, value) => {
    original(key, value);
    if (!occupied && key === 'quark-registry-v1' && JSON.parse(value).assets.some(asset => asset.status === 'queued')) {
      occupied = true; blocked = true;
      searches.push(service.resources({ ...detail, id: 'hold-one', quarkShares: [] }), service.resources({ ...detail, id: 'hold-two', quarkShares: [] })); reached();
    }
  };
  const pending = service.prepare(detail, { ...selected, valid: () => valid }); await called; await turn(); valid = false; finish();
  const result = await pending; await Promise.all(searches); assert.equal(result.status, 'error'); assert.equal(state.saved, 1);
  const assets = JSON.parse(metadata.get('quark-registry-v1')).assets; assert.equal(assets.length, 1); assert.equal(assets[0].status, 'ready');
  assert.equal((await service.prepare(detail, { ...selected, valid: () => true })).status, 'ready'); assert.equal(state.saved, 2);
});

test('a forty-GiB video is allowed under a raised daily budget and restored safely; total bytes still cap saves', async t => {
  const { service, state, connect, save, select, options } = await fixture(t); await connect({ maxDailyBytes: 60 * GIB }); state.source = [sourceVideo('large', '影片.2026.mkv', 40 * GIB)];
  const saved = await save(); assert.equal(saved.status, 'ready'); assert.equal(state.saved, 1);
  state.source = [sourceVideo('over-total', '影片.2026.mkv', 41 * GIB)]; const selected = await select(); assert.match((await service.prepare(detail, selected)).reason, /上限/); assert.equal(state.saved, 1);
  await service.stop(); const restarted = createQuark(options); t.after(() => restarted.stop()); assert.equal((await restarted.settings()).managedFiles, 1); assert.equal((await restarted.playback(saved.assetId)).metadata.size, 40 * GIB);
});

test('old deleted ledger entries are pruned before the thousand-item cap while active records survive', async t => {
  const { service, state, connect, save, options, metadata } = await fixture(t); await connect(); await save(); await service.stop();
  const registry = JSON.parse(metadata.get('quark-registry-v1')), template = registry.assets[0];
  registry.assets = Array.from({ length: 999 }, (_, i) => ({ ...template, id: i.toString(16).padStart(32, '0'), fid: 'deleted-' + i, source: 'deleted-source-' + i, status: 'deleted', day: '2025-01-01' }));
  registry.assets.push(template); metadata.set('quark-registry-v1', JSON.stringify(registry));
  const next = createQuark(options); t.after(() => next.stop()); state.source = [sourceVideo('new')];
  const resources = await next.resources(detail), files = await next.files(detail, { shareId: resources.resources[0].id });
  assert.equal((await next.prepare(detail, { shareId: resources.resources[0].id, fileId: files.files[0].id })).status, 'ready');
  const remaining = JSON.parse(metadata.get('quark-registry-v1')).assets; assert.equal(remaining.length, 2); assert.ok(remaining.every(asset => asset.status === 'ready')); assert.equal(state.saved, 2);
});

test('today deleted entries retain their daily quota until the next day', async t => {
  const { service, state, connect, save, options, metadata } = await fixture(t); await connect({ maxDailyTransfers: 1 }); await save(); await service.stop();
  const registry = JSON.parse(metadata.get('quark-registry-v1')); registry.assets[0].status = 'deleted'; metadata.set('quark-registry-v1', JSON.stringify(registry));
  const next = createQuark(options); t.after(() => next.stop()); state.source = [sourceVideo('next')];
  const resources = await next.resources(detail), files = await next.files(detail, { shareId: resources.resources[0].id }), selected = { shareId: resources.resources[0].id, fileId: files.files[0].id };
  assert.match((await next.prepare(detail, selected)).reason, /上限/); assert.equal(state.saved, 1);
  state.clock += DAY; const again = await next.resources(detail), listed = await next.files(detail, { shareId: again.resources[0].id }); assert.equal((await next.prepare(detail, { shareId: again.resources[0].id, fileId: listed.files[0].id })).status, 'ready'); assert.equal(state.saved, 2);
});
