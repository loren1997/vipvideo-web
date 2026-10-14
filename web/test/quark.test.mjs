import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, rm, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, sep, basename } from 'node:path';
import { setImmediate as turn } from 'node:timers/promises';
import { createQuark } from '../lib/quark.mjs';
import { createQuarkSearchPool } from '../lib/quark-search-pool.mjs';

const COOKIE = '__kp=synthetic-account-A-secret; __pus=synthetic-login; __puus=synthetic-session';
const COOKIE_B = '__kp=synthetic-account-B-secret; __pus=synthetic-login-B; __puus=synthetic-session-B';
const DAY = 86400000, GIB = 1024 ** 3, DAILY_BYTES = 3_000_000_000_000;
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
    if (path === '/file' && options.method === 'POST') { assert.equal(body.pdir_fid, '0'); assert.match(body.file_name, /^VipVideo-[a-f0-9]{32}(?:-[a-f0-9]{32})?$/); const count = state.calls.filter(row => row.path === '/file' && row.options.method === 'POST' && row.account === account).length; const folder = { fid: 'app-folder-' + account + (count > 1 ? '-' + count : ''), file_name: body.file_name, file: false, pdir_fid: '0' }; state.folders.set(account, folder); return reply({ fid: folder.fid }); }
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

test('managed mkdir waits for indexed visibility without repeating creation or transferring early', async t => {
  const { service, state, connect, select, metadata } = await fixture(t); await connect();
  const selected = await select(); let confirmations = 0;
  state.beforeRequest = call => {
    if (call.path !== '/file/sort') return;
    const query = new URL(call.value).searchParams;
    assert.equal(query.get('fetch_all_file'), '1'); assert.equal(query.get('_sort'), 'file_type:asc,updated_at:desc');
    if (query.get('pdir_fid') === '0' && state.folders.has('A') && ++confirmations < 3) {
      assert.equal(state.saved, 0); return reply({ list: [] });
    }
  };
  const result = await service.prepare(detail, { ...selected, line: 0, episode: 0 });
  assert.equal(result.status, 'ready'); assert.equal(state.saved, 1);
  assert.equal(state.calls.filter(call => call.path === '/file' && call.options.method === 'POST').length, 1);
  const folder = Object.values(JSON.parse(metadata.get('quark-registry-v1')).folders)[0];
  assert.equal(folder.fid, 'app-folder-A'); assert.equal(folder.mkdirStarted, undefined);
});

test('reliable totals keep scanning short directory pages until a registered folder on page three is verified', async t => {
  const { service, state, connect, save, select } = await fixture(t); await connect(); await save(); let pages = 0;
  state.beforeRequest = call => {
    if (call.path !== '/file/sort' || new URL(call.value).searchParams.get('pdir_fid') !== '0') return;
    const page = ++pages, rows = Array.from({ length: 50 }, (_, index) => page === 3 && index === 49 ? state.folders.get('A') : { fid: `other-${page}-${index}`, file_name: 'user-directory', file: false, pdir_fid: '0' });
    return Object.assign(Readable.from([JSON.stringify({ code: 0, data: { list: rows }, metadata: { _total: 150 } })]), { statusCode: 200, headers: {} });
  };
  assert.equal((await service.prepare(detail, { ...await select(), line: 0, episode: 0 })).status, 'ready');
  assert.equal(pages, 3); assert.equal(state.saved, 1);
});

test('repairing a confirmed missing directory creates a new managed namespace and retains old assets and daily quota', async t => {
  const { service, state, metadata, connect, save, select } = await fixture(t); await connect(); const first = await save();
  const before = JSON.parse(metadata.get('quark-registry-v1')), account = Object.keys(before.folders)[0], oldFolder = before.folders[account];
  state.folders.delete('A');
  const missing = await service.prepare(detail, { ...await select(), line: 0, episode: 0 });
  assert.equal(missing.status, 'error'); assert.equal(missing.code, 'QUARK_FOLDER_MISSING');
  await service.repairFolder();
  const after = JSON.parse(metadata.get('quark-registry-v1')), folder = after.folders[account];
  assert.match(folder.name, new RegExp('^' + oldFolder.name + '-[a-f0-9]{32}$')); assert.notEqual(folder.fid, oldFolder.fid);
  assert.equal(folder.retired.length, 1); assert.equal(folder.retired[0].fid, oldFolder.fid); assert.equal(folder.retired[0].name, oldFolder.name);
  assert.deepEqual(after.assets, before.assets); assert.equal(state.saved, 1);
  assert.equal((await service.settings()).managedFiles, 0);
  await assert.rejects(service.playback(first.assetId), /目录|登记/);
  for (const input of [{ maxDailyTransfers: 1 }, { maxDailyBytes: before.assets[0].size }]) {
    await service.configure(input);
    assert.match((await service.prepare(detail, { ...await select(), line: 0, episode: 0 })).reason, /每日转存数量或容量上限/);
    assert.equal(state.saved, 1); await service.configure({ maxDailyTransfers: 100, maxDailyBytes: DAILY_BYTES });
  }
  const replacement = await service.prepare(detail, { ...await select(), line: 0, episode: 0 });
  assert.equal(replacement.status, 'ready'); assert.notEqual(replacement.assetId, first.assetId); assert.equal(state.saved, 2);
  await service.repairFolder(); assert.equal(state.calls.filter(call => call.path === '/file' && call.options.method === 'POST').length, 2);
  assert.deepEqual(state.deletes, []); assert.deepEqual(state.purges, []);
});

test('repair is serialized and initializes an unregistered account only once', async t => {
  const { service, state, connect } = await fixture(t); await connect();
  await Promise.all([service.repairFolder(), service.repairFolder(), service.repairFolder()]);
  assert.equal(state.calls.filter(call => call.path === '/file' && call.options.method === 'POST').length, 1);
  assert.equal(state.saved, 0); assert.deepEqual(state.deletes, []);
});

test('pending repair survives restart and confirms the same journal without a second mkdir', async t => {
  const { service, options, state, metadata, connect, save } = await fixture(t); await connect(); await save(); state.folders.delete('A'); let invisible = true;
  state.beforeRequest = call => call.path === '/file/sort' && new URL(call.value).searchParams.get('pdir_fid') === '0' && state.folders.has('A') && invisible ? reply({ list: [] }) : undefined;
  await assert.rejects(service.repairFolder(), /专用目录暂未可见/);
  const before = JSON.parse(metadata.get('quark-registry-v1')), account = Object.keys(before.folders)[0];
  assert.equal(before.folders[account].mkdirStarted, true); assert.equal(before.folders[account].retired.length, 1);
  await service.stop(); const restored = createQuark(options); t.after(() => restored.stop()); invisible = false;
  await restored.repairFolder(); const after = JSON.parse(metadata.get('quark-registry-v1'));
  assert.equal(after.folders[account].name, before.folders[account].name); assert.equal(after.folders[account].fid, before.folders[account].fid);
  assert.equal(after.folders[account].mkdirStarted, undefined); assert.equal(state.calls.filter(call => call.path === '/file' && call.options.method === 'POST').length, 2);
  assert.equal(state.saved, 1); assert.deepEqual(state.deletes, []); assert.deepEqual(state.purges, []);
});

test('repair authorization and account guards cancel before mkdir and preserve a pre-send journal for retry', async t => {
  for (const mode of ['revoked-before-proof', 'revoked-after-journal', 'account-cleared', 'stopped']) await t.test(mode, async t => {
    const { service, state, metadata, connect, save } = await fixture(t); await connect(); await save(); state.folders.delete('A');
    const before = metadata.get('quark-registry-v1'); let valid = true, reads = 0;
    state.beforeRequest = async call => {
      if (call.path !== '/file/sort' || new URL(call.value).searchParams.get('pdir_fid') !== '0') return;
      reads++;
      if (mode === 'account-cleared') await service.clearAccount();
      else if (mode === 'stopped') void service.stop();
      else if (reads === (mode === 'revoked-after-journal' ? 2 : 1)) valid = false;
    };
    await assert.rejects(service.repairFolder({ valid: () => valid }), /授权|账号已变更|正在关闭/);
    assert.equal(state.calls.filter(call => call.path === '/file' && call.options.method === 'POST').length, 1);
    if (mode !== 'revoked-after-journal') assert.equal(metadata.get('quark-registry-v1'), before);
    else {
      const journal = Object.values(JSON.parse(metadata.get('quark-registry-v1')).folders)[0];
      assert.equal(journal.fid, undefined); assert.equal(journal.mkdirStarted, undefined); assert.equal(journal.retired.length, 1);
      state.beforeRequest = null; await service.repairFolder();
      assert.equal(Object.values(JSON.parse(metadata.get('quark-registry-v1')).folders)[0].name, journal.name);
      assert.equal(state.calls.filter(call => call.path === '/file' && call.options.method === 'POST').length, 2);
    }
    assert.equal(state.saved, 1); assert.deepEqual(state.deletes, []); assert.deepEqual(state.purges, []);
  });
});

test('repair refuses conflicting names, renamed fids, malformed pagination and an exhausted history without replacing registration', async t => {
  for (const mode of ['renamed', 'same-name-other-fid', 'empty-short-page', 'changed-total', 'duplicate-page-fid', 'contradictory-total', 'history-full', 'history-invalid']) await t.test(mode, async t => {
    const { service, options, state, metadata, connect, save } = await fixture(t); await connect(); await save();
    const registry = JSON.parse(metadata.get('quark-registry-v1')), account = Object.keys(registry.folders)[0], folder = registry.folders[account];
    if (mode === 'history-full') folder.retired = Array.from({ length: 16 }, (_, index) => ({ name: folder.name + '-' + index.toString(16).padStart(32, '0'), fid: 'old-history-' + index, createdAt: state.clock, retiredAt: state.clock }));
    if (mode === 'history-invalid') folder.retired = [{ name: 'unrelated-directory', fid: 'old-history' }];
    metadata.set('quark-registry-v1', JSON.stringify(registry)); await service.stop(); const restored = createQuark(options); t.after(() => restored.stop());
    if (mode === 'renamed') state.folders.get('A').file_name = 'user-renamed-directory';
    if (mode === 'same-name-other-fid') state.folders.get('A').fid = 'unknown-directory';
    if (mode.startsWith('history-')) state.folders.delete('A');
    if (['empty-short-page', 'changed-total', 'duplicate-page-fid', 'contradictory-total'].includes(mode)) state.beforeRequest = call => {
      if (call.path !== '/file/sort' || new URL(call.value).searchParams.get('pdir_fid') !== '0') return;
      const page = Number(new URL(call.value).searchParams.get('_page'));
      const rows = mode === 'empty-short-page' && page === 2 ? [] : Array.from({ length: 50 }, (_, index) => ({ fid: mode === 'duplicate-page-fid' && page === 2 && index === 0 ? 'private-1-0' : `private-${page}-${index}`, file_name: 'private-directory', file: false, pdir_fid: '0' }));
      const total = mode === 'contradictory-total' ? 49 : mode === 'changed-total' && page === 2 ? 151 : 150;
      return Object.assign(Readable.from([JSON.stringify({ code: 0, data: { list: rows }, metadata: { _total: total } })]), { statusCode: 200, headers: {} });
    };
    const before = metadata.get('quark-registry-v1');
    await assert.rejects(restored.repairFolder(), cause => cause.status === 409 && cause.code === undefined);
    assert.equal(metadata.get('quark-registry-v1'), before); assert.equal(state.calls.filter(call => call.path === '/file' && call.options.method === 'POST').length, 1);
    assert.equal(state.saved, 1); assert.deepEqual(state.deletes, []); assert.deepEqual(state.purges, []);
  });
});

test('a new repair directory cannot claim a retired fid and preserves the conflicting pending journal across restart', async t => {
  const { service, options, state, metadata, connect, save } = await fixture(t); await connect(); await save();
  const old = state.folders.get('A'); state.folders.delete('A');
  state.beforeRequest = call => {
    if (call.path !== '/file' || call.options.method !== 'POST') return;
    state.folders.set('A', { ...old, file_name: call.body.file_name }); return reply({ fid: old.fid });
  };
  await assert.rejects(service.repairFolder(), /历史记录冲突/);
  const journal = Object.values(JSON.parse(metadata.get('quark-registry-v1')).folders)[0]; assert.equal(journal.fid, undefined); assert.equal(journal.mkdirStarted, true);
  await service.stop(); const restored = createQuark(options); t.after(() => restored.stop()); state.beforeRequest = null;
  await assert.rejects(restored.repairFolder(), /无法确认/); assert.equal(state.calls.filter(call => call.path === '/file' && call.options.method === 'POST').length, 2);
  assert.equal(Object.values(JSON.parse(metadata.get('quark-registry-v1')).folders)[0].name, journal.name);
  assert.equal(state.saved, 1); assert.deepEqual(state.deletes, []); assert.deepEqual(state.purges, []);
});

test('pending repair fids colliding with another account active or retired registration remain unclaimed after restart', async t => {
  for (const mode of ['active', 'retired']) await t.test(mode, async t => {
    const { service, options, state, metadata, connect, save } = await fixture(t); await connect(); await save();
    const registry = JSON.parse(metadata.get('quark-registry-v1')), account = Object.keys(registry.folders)[0], folder = registry.folders[account]; folder.mkdirStarted = true;
    registry.folders['f'.repeat(64)] = mode === 'active' ? { ...folder, mkdirStarted: false } : { name: folder.name + '-' + 'a'.repeat(32), fid: 'other-active', retired: [{ name: folder.name, fid: folder.fid }] };
    metadata.set('quark-registry-v1', JSON.stringify(registry)); await service.stop(); const restored = createQuark(options); t.after(() => restored.stop());
    const before = metadata.get('quark-registry-v1'); await assert.rejects(restored.repairFolder(), /无法确认/);
    assert.equal(metadata.get('quark-registry-v1'), before); assert.equal(state.calls.filter(call => call.path === '/file' && call.options.method === 'POST').length, 1);
    assert.equal(state.saved, 1); assert.deepEqual(state.deletes, []); assert.deepEqual(state.purges, []);
  });
});

test('rotated Cookie identity reconnects a suffixed active directory with its retired quota history while cleanup excludes retired assets', async t => {
  const { service, options, state, metadata, connect, save, select } = await fixture(t);
  state.beforeRequest = call => call.path === '/config' ? reply({}) : undefined; await connect({ cleanupEnabled: true, retentionDays: 1 }); await save();
  state.folders.delete('A'); await service.repairFolder();
  const active = await service.prepare(detail, { ...await select(), line: 0, episode: 0 }); assert.equal(active.status, 'ready');
  const before = JSON.parse(metadata.get('quark-registry-v1')), oldAccount = Object.keys(before.folders)[0], old = before.assets[0];
  old.status = 'purging'; old.watchedAt = old.lastActivity = state.clock - 2 * DAY;
  old.deleteIntent = { account: oldAccount, parent: old.parent, fid: old.fid, at: state.clock - DAY };
  await connect({ cookie: COOKIE.replace('synthetic-account-A-secret', 'synthetic-account-A-repaired-rotated') });
  const account = JSON.parse(metadata.get('quark-settings-v1')).account.id;
  metadata.set('quark-registry-v1', JSON.stringify(before)); await service.stop(); const restored = createQuark(options); t.after(() => restored.stop());
  const shareId = (await restored.resources(detail)).resources[0].id, fileId = (await restored.files(detail, { shareId, line: 0, episode: 0 })).files[0].id;
  assert.equal((await restored.prepare(detail, { shareId, fileId, line: 0, episode: 0 })).assetId, active.assetId);
  const after = JSON.parse(metadata.get('quark-registry-v1')); assert.equal(after.folders[oldAccount], undefined); assert.deepEqual(after.folders[account], before.folders[oldAccount]);
  assert.ok(after.assets.every(asset => asset.account === account)); assert.equal(after.assets[0].deleteIntent.account, account);
  for (let index = 0; index < 2; index++) for (const field of ['parent', 'day', 'size', 'createdAt']) assert.equal(after.assets[index][field], before.assets[index][field]);
  assert.equal((await restored.settings()).managedFiles, 1); assert.equal((await restored.cleanup()).checked, 0);
  await assert.rejects(restored.playback(old.id), /当前专用目录/);
  assert.equal(state.saved, 2); assert.deepEqual(state.deletes, []); assert.deepEqual(state.purges, []);
});

test('invisible managed mkdir stops at three confirmation reads and recovers later without creating another folder', async t => {
  const { service, state, connect, select } = await fixture(t); await connect();
  const selected = await select(); let confirmations = 0, invisible = true;
  state.beforeRequest = call => {
    if (call.path === '/file/sort' && new URL(call.value).searchParams.get('pdir_fid') === '0' && state.folders.has('A') && invisible) {
      confirmations++; return reply({ list: [] });
    }
  };
  const first = await service.prepare(detail, { ...selected, line: 0, episode: 0 });
  assert.equal(first.status, 'error'); assert.match(first.reason, /专用目录暂未可见/); assert.equal(confirmations, 3); assert.equal(state.saved, 0);
  const second = await service.prepare(detail, { ...selected, line: 0, episode: 0 });
  assert.equal(second.status, 'error'); assert.equal(confirmations, 7); assert.equal(state.saved, 0);
  invisible = false;
  assert.equal((await service.prepare(detail, { ...selected, line: 0, episode: 0 })).status, 'ready');
  assert.equal(state.saved, 1); assert.equal(state.calls.filter(call => call.path === '/file' && call.options.method === 'POST').length, 1);
  assert.deepEqual(state.deletes, []);
});

test('managed mkdir pins the returned fid and refuses to adopt a different same-name folder', async t => {
  const { service, state, connect, select } = await fixture(t); await connect(); const selected = await select();
  state.beforeRequest = call => {
    if (call.path === '/file' && call.options.method === 'POST') {
      state.folders.set('A', { fid: 'different-folder', file_name: call.body.file_name, file: false, pdir_fid: '0' });
      return reply({ fid: 'created-folder' });
    }
  };
  const result = await service.prepare(detail, { ...selected, line: 0, episode: 0 });
  assert.equal(result.status, 'error'); assert.equal(state.saved, 0); assert.deepEqual(state.deletes, []);
  assert.equal(state.calls.filter(call => call.path === '/file' && call.options.method === 'POST').length, 1);
});

test('a pre-existing same-name root directory is not adopted before this application has created it', async t => {
  const { service, state, connect, select, metadata } = await fixture(t); await connect(); const selected = await select();
  const installId = JSON.parse(metadata.get('quark-settings-v1')).installId;
  state.beforeRequest = call => {
    if (call.path === '/file/sort' && new URL(call.value).searchParams.get('pdir_fid') === '0') {
      return reply({ list: [{ fid: 'user-owned-same-name', file_name: 'VipVideo-' + installId, file: false, pdir_fid: '0' }] });
    }
  };
  const result = await service.prepare(detail, { ...selected, line: 0, episode: 0 });
  assert.equal(result.status, 'error'); assert.match(result.reason, /同名但未登记/); assert.equal(state.saved, 0);
  assert.equal(state.calls.filter(call => call.path === '/file' && call.options.method === 'POST').length, 0); assert.deepEqual(state.deletes, []);
});

test('missing, renamed and conflicting registered folders report safe reasons without recreating or deleting files', async t => {
  for (const mode of ['missing', 'renamed', 'conflicting']) await t.test(mode, async t => {
    const { service, state, connect, select, save } = await fixture(t); await connect();
    assert.equal((await save()).status, 'ready');
    if (mode === 'missing') state.folders.delete('A');
    else if (mode === 'renamed') state.folders.get('A').file_name = 'user-renamed-private-directory';
    else state.beforeRequest = call => call.path === '/file/sort' && new URL(call.value).searchParams.get('pdir_fid') === '0' ? reply({ list: [state.folders.get('A'), state.folders.get('A')] }) : undefined;
    const result = await service.prepare(detail, { ...await select(), line: 0, episode: 0 });
    assert.equal(result.status, 'error'); assert.match(result.reason, mode === 'conflicting' ? /目录记录冲突/ : mode === 'missing' ? /可恢复专用目录/ : /已登记目录未找到或已改名、移动/);
    assert.ok(!result.reason.includes('private-directory'));
    assert.equal(state.saved, 1); assert.equal(state.calls.filter(call => call.path === '/file' && call.options.method === 'POST').length, 1);
    assert.deepEqual(state.deletes, []); assert.deepEqual(state.purges, []);
  });
});

test('an incomplete root directory listing reports its bound and cannot authorize a new managed folder', async t => {
  const { service, state, connect, select } = await fixture(t); await connect(); const selected = await select(); let pages = 0;
  state.beforeRequest = call => {
    if (call.path !== '/file/sort' || new URL(call.value).searchParams.get('pdir_fid') !== '0') return;
    const page = ++pages;
    return Object.assign(Readable.from([JSON.stringify({ code: 0, status: 200, data: { list: Array.from({ length: 100 }, (_, index) => ({ fid: `private-${page}-${index}`, file_name: 'private-user-directory', file: false, pdir_fid: '0' })) }, metadata: { _total: 601 } })]), { statusCode: 200, headers: {} });
  };
  const result = await service.prepare(detail, { ...selected, line: 0, episode: 0 });
  assert.equal(result.status, 'error'); assert.match(result.reason, /根目录列表超过核验范围/); assert.equal(pages, 6);
  assert.ok(!result.reason.includes('private-user-directory'));
  assert.equal(state.saved, 0); assert.equal(state.calls.filter(call => call.path === '/file' && call.options.method === 'POST').length, 0);
  assert.deepEqual(state.deletes, []); assert.deepEqual(state.purges, []);
});

test('a rotated fallback Cookie identity reconnects only the registered root folder and reuses its saved video', async t => {
  for (const mode of ['ready', 'ready-with-empty-registration', 'ready-with-numeric-root', 'pending']) await t.test(mode, async t => {
    const { service, options, state, metadata, connect, save } = await fixture(t);
    state.beforeRequest = call => call.path === '/config' ? reply({}) : undefined;
    await connect(); state.pending = mode === 'pending';
    assert.equal((await save()).status, state.pending ? 'pending' : 'ready');
    const before = JSON.parse(metadata.get('quark-registry-v1')), oldAccount = Object.keys(before.folders)[0], oldAsset = before.assets[0];
    await connect({ cookie: COOKIE.replace('synthetic-account-A-secret', 'synthetic-account-A-rotated') });
    const config = JSON.parse(metadata.get('quark-settings-v1')), account = config.account.id; assert.notEqual(account, oldAccount);
    if (mode === 'ready-with-empty-registration') {
      before.folders[account] = { name: 'VipVideo-' + config.installId, createdAt: state.clock };
      metadata.set('quark-registry-v1', JSON.stringify(before));
    }
    await service.stop(); const restored = createQuark(options); t.after(() => restored.stop());
    if (mode === 'ready-with-numeric-root') state.folders.get('A').pdir_fid = 0;
    const selectRestored = async instance => {
      const shareId = (await instance.resources(detail)).resources[0].id;
      const fileId = (await instance.files(detail, { shareId, line: 0, episode: 0 })).files[0].id;
      return instance.prepare(detail, { shareId, fileId, line: 0, episode: 0 });
    };
    const result = await selectRestored(restored);
    assert.equal(result.status, state.pending ? 'pending' : 'ready'); assert.equal(result.assetId, oldAsset.id); assert.equal(result.reused, true);
    const after = JSON.parse(metadata.get('quark-registry-v1'));
    assert.equal(after.folders[oldAccount], undefined); assert.equal(after.folders[account].fid, before.folders[oldAccount].fid);
    assert.equal(after.assets.length, 1); assert.equal(after.assets[0].account, account);
    for (const field of ['id', 'parent', 'source', 'name', 'day', 'size', 'createdAt', 'status']) assert.deepEqual(after.assets[0][field], oldAsset[field]);
    assert.equal(state.saved, 1); assert.equal(state.calls.filter(call => call.path === '/file' && call.options.method === 'POST').length, 1);
    assert.deepEqual(state.deletes, []); assert.deepEqual(state.purges, []);
    await restored.stop(); const restarted = createQuark(options); t.after(() => restarted.stop());
    assert.equal((await selectRestored(restarted)).assetId, oldAsset.id); assert.equal(state.saved, 1);
  });
});

test('reconnecting a Cookie identity preserves daily count and byte quotas while still reusing an existing video', async t => {
  for (const limit of ['count', 'bytes']) await t.test(limit, async t => {
    const { service, options, state, metadata, connect, save } = await fixture(t);
    state.beforeRequest = call => call.path === '/config' ? reply({}) : undefined; await connect(); await save();
    const before = JSON.parse(metadata.get('quark-registry-v1')), original = before.assets[0];
    for (let index = 1; index < (limit === 'count' ? 100 : 28); index++) before.assets.push({ ...original, id: index.toString(16).padStart(32, '0'), source: index.toString(16).padStart(64, '0'), fid: 'other-managed-' + index, size: limit === 'bytes' ? 100 * GIB : original.size });
    await connect({ cookie: COOKIE.replace('synthetic-account-A-secret', 'synthetic-account-A-quota-rotated') });
    metadata.set('quark-registry-v1', JSON.stringify(before)); await service.stop(); const restored = createQuark(options); t.after(() => restored.stop());
    const prepare = async film => {
      const shareId = (await restored.resources(film)).resources[0].id, fileId = (await restored.files(film, { shareId, line: 0, episode: 0 })).files[0].id;
      return restored.prepare(film, { shareId, fileId, line: 0, episode: 0 });
    };
    const reused = await prepare(detail); assert.equal(reused.status, 'ready'); assert.equal(reused.assetId, original.id); assert.equal(reused.reused, true);
    state.source = [sourceVideo('next-video', '影片.2026.mp4', limit === 'bytes' ? 100 * GIB : original.size)];
    const denied = await prepare({ ...detail, id: 'quota-next' }); assert.equal(denied.status, 'error'); assert.match(denied.reason, /每日转存数量或容量上限/);
    const after = JSON.parse(metadata.get('quark-registry-v1')); assert.equal(after.assets.length, before.assets.length);
    for (let index = 0; index < before.assets.length; index++) for (const field of ['day', 'size', 'createdAt', 'parent', 'source']) assert.deepEqual(after.assets[index][field], before.assets[index][field]);
    assert.equal(state.saved, 1); assert.equal(state.calls.filter(call => call.path === '/file' && call.options.method === 'POST').length, 1);
    assert.deepEqual(state.deletes, []); assert.deepEqual(state.purges, []);
  });
});

test('a full registry reconnects a rotated identity to reuse an existing video while refusing new saves', async t => {
  const { service, options, state, metadata, connect, save } = await fixture(t);
  state.beforeRequest = call => call.path === '/config' ? reply({}) : undefined; await connect(); await save();
  const before = JSON.parse(metadata.get('quark-registry-v1')), original = before.assets[0];
  for (let index = 1; index < 1000; index++) before.assets.push({ ...original, id: index.toString(16).padStart(32, '0'), source: index.toString(16).padStart(64, '0'), fid: 'historical-' + index, day: '2025-12-01' });
  await connect({ cookie: COOKIE.replace('synthetic-account-A-secret', 'synthetic-account-A-full-rotated') });
  metadata.set('quark-registry-v1', JSON.stringify(before)); await service.stop(); const restored = createQuark(options); t.after(() => restored.stop());
  const prepare = async film => {
    const shareId = (await restored.resources(film)).resources[0].id, fileId = (await restored.files(film, { shareId, line: 0, episode: 0 })).files[0].id;
    return restored.prepare(film, { shareId, fileId, line: 0, episode: 0 });
  };
  const reused = await prepare(detail); assert.equal(reused.status, 'ready'); assert.equal(reused.assetId, original.id); assert.equal(reused.reused, true);
  state.source = [sourceVideo('next-video')];
  assert.match((await prepare({ ...detail, id: 'full-registry-next' })).reason, /每日转存数量或容量上限/);
  assert.equal(JSON.parse(metadata.get('quark-registry-v1')).assets.length, 1000);
  assert.equal(state.saved, 1); assert.equal(state.calls.filter(call => call.path === '/file' && call.options.method === 'POST').length, 1);
  assert.deepEqual(state.deletes, []); assert.deepEqual(state.purges, []);
});

test('reconnecting a Cookie identity refuses every incomplete or conflicting folder proof without cloud mutations', async t => {
  for (const mode of ['different-fid', 'no-old-fid', 'old-mkdir-pending', 'current-mkdir-pending', 'multiple-old-fids', 'multiple-old-accounts', 'missing-parent', 'non-root-parent', 'non-directory', 'duplicate-row', 'incomplete-root', 'invalid-total', 'conflicting-current-asset']) await t.test(mode, async t => {
    const { service, options, state, metadata, connect, save } = await fixture(t);
    state.beforeRequest = call => call.path === '/config' ? reply({}) : undefined; await connect(); await save();
    const before = JSON.parse(metadata.get('quark-registry-v1')), oldAccount = Object.keys(before.folders)[0], entry = before.folders[oldAccount];
    await connect({ cookie: COOKIE.replace('synthetic-account-A-secret', 'synthetic-account-A-denied-rotated') });
    const account = JSON.parse(metadata.get('quark-settings-v1')).account.id;
    if (mode === 'no-old-fid') delete entry.fid;
    if (mode === 'old-mkdir-pending') entry.mkdirStarted = true;
    if (mode === 'current-mkdir-pending') before.folders[account] = { name: entry.name, createdAt: state.clock, mkdirStarted: true };
    if (mode.startsWith('multiple-old')) before.folders['f'.repeat(64)] = { ...entry, ...(mode === 'multiple-old-fids' ? { fid: 'different-registered-fid' } : {}) };
    if (mode === 'conflicting-current-asset') before.assets.push({ ...before.assets[0], id: 'e'.repeat(32), account, parent: 'different-parent', source: 'e'.repeat(64) });
    metadata.set('quark-registry-v1', JSON.stringify(before)); await service.stop(); const restored = createQuark(options); t.after(() => restored.stop());
    const row = { ...state.folders.get('A') };
    if (mode === 'different-fid') row.fid = 'unregistered-same-name';
    if (mode === 'missing-parent') delete row.pdir_fid;
    if (mode === 'non-root-parent') row.pdir_fid = 'not-root';
    if (mode === 'non-directory') row.file = true;
    state.beforeRequest = call => {
      if (call.path === '/config') return reply({});
      if (call.path !== '/file/sort' || new URL(call.value).searchParams.get('pdir_fid') !== '0') return;
      if (['incomplete-root', 'invalid-total'].includes(mode)) {
        const page = Number(new URL(call.value).searchParams.get('_page'));
        const list = Array.from({ length: 100 }, (_, index) => page === 1 && index === 0 ? row : { fid: `private-${page}-${index}`, file_name: 'private-directory', file: false, pdir_fid: '0' });
        return Object.assign(Readable.from([JSON.stringify({ code: 0, status: 200, data: { list }, metadata: { _total: mode === 'invalid-total' ? 0 : 601 } })]), { statusCode: 200, headers: {} });
      }
      return reply({ list: mode === 'duplicate-row' ? [row, row] : [row] });
    };
    const shareId = (await restored.resources(detail)).resources[0].id, fileId = (await restored.files(detail, { shareId, line: 0, episode: 0 })).files[0].id;
    const snapshot = metadata.get('quark-registry-v1');
    const result = await restored.prepare(detail, { shareId, fileId, line: 0, episode: 0 });
    assert.equal(result.status, 'error'); assert.equal(metadata.get('quark-registry-v1'), snapshot);
    assert.equal(state.saved, 1); assert.equal(state.calls.filter(call => call.path === '/file' && call.options.method === 'POST').length, 1);
    assert.deepEqual(state.deletes, []); assert.deepEqual(state.purges, []);
  });
});

test('revoking viewing authorization during folder identity proof cannot rebind the registry', async t => {
  const { service, options, state, metadata, connect, save } = await fixture(t);
  state.beforeRequest = call => call.path === '/config' ? reply({}) : undefined; await connect(); await save();
  await connect({ cookie: COOKIE.replace('synthetic-account-A-secret', 'synthetic-account-A-cancelled-rotated') });
  await service.stop(); const restored = createQuark(options); t.after(() => restored.stop());
  const shareId = (await restored.resources(detail)).resources[0].id, fileId = (await restored.files(detail, { shareId, line: 0, episode: 0 })).files[0].id;
  const snapshot = metadata.get('quark-registry-v1'); let valid = true;
  state.beforeRequest = call => { if (call.path === '/file/sort' && new URL(call.value).searchParams.get('pdir_fid') === '0') valid = false; };
  const result = await restored.prepare(detail, { shareId, fileId, line: 0, episode: 0, valid: () => valid });
  assert.equal(result.status, 'error'); assert.match(result.reason, /授权已失效/); assert.equal(metadata.get('quark-registry-v1'), snapshot);
  assert.equal(state.saved, 1); assert.equal(state.calls.filter(call => call.path === '/file' && call.options.method === 'POST').length, 1);
  assert.deepEqual(state.deletes, []); assert.deepEqual(state.purges, []);
});

test('folder identity reconnection preserves cleanup intent guards and never triggers deletion itself', async t => {
  for (const mode of ['valid', 'wrong-account', 'wrong-parent', 'wrong-fid']) await t.test(mode, async t => {
    const { service, options, state, metadata, connect, save } = await fixture(t);
    state.beforeRequest = call => call.path === '/config' ? reply({}) : undefined; await connect({ maxDailyTransfers: 1 }); await save();
    const before = JSON.parse(metadata.get('quark-registry-v1')), oldAccount = Object.keys(before.folders)[0], asset = before.assets[0];
    asset.status = 'purging'; asset.watchedAt = state.clock - 2 * DAY; asset.lastActivity = asset.watchedAt;
    asset.deleteIntent = { account: mode === 'wrong-account' ? 'f'.repeat(64) : oldAccount, parent: mode === 'wrong-parent' ? 'not-owned-parent' : asset.parent, fid: mode === 'wrong-fid' ? 'not-owned-file' : asset.fid, at: state.clock - DAY, record_id: 'kept-record' };
    const intent = { ...asset.deleteIntent };
    await connect({ cookie: COOKIE.replace('synthetic-account-A-secret', 'synthetic-account-A-intent-rotated') });
    const account = JSON.parse(metadata.get('quark-settings-v1')).account.id;
    metadata.set('quark-registry-v1', JSON.stringify(before)); await service.stop(); const restored = createQuark(options); t.after(() => restored.stop());
    state.source = [sourceVideo('new-video')];
    const shareId = (await restored.resources(detail)).resources[0].id, fileId = (await restored.files(detail, { shareId, line: 0, episode: 0 })).files[0].id;
    assert.match((await restored.prepare(detail, { shareId, fileId, line: 0, episode: 0 })).reason, /每日转存数量或容量上限/);
    const migrated = JSON.parse(metadata.get('quark-registry-v1')).assets[0];
    assert.equal(migrated.account, account); assert.equal(migrated.status, 'purging');
    assert.deepEqual(migrated.deleteIntent, { ...intent, ...(mode === 'valid' ? { account } : {}) });
    assert.equal(state.saved, 1); assert.deepEqual(state.deletes, []); assert.deepEqual(state.purges, []);
    if (mode !== 'valid') {
      await restored.configure({ cleanupEnabled: true, retentionDays: 1 });
      assert.equal((await restored.cleanup()).deleted, 0); assert.deepEqual(state.deletes, []); assert.deepEqual(state.purges, []);
    }
  });
});

test('cleanup can reconnect a rotated identity but still refuses a changed managed file and leaves untracked files untouched', async t => {
  const { service, options, state, metadata, connect, save } = await fixture(t);
  state.beforeRequest = call => call.path === '/config' ? reply({}) : undefined;
  await connect({ cleanupEnabled: true, retentionDays: 1 }); await save();
  const before = JSON.parse(metadata.get('quark-registry-v1'));
  before.assets[0].watchedAt = state.clock - 2 * DAY; before.assets[0].lastActivity = before.assets[0].watchedAt;
  await connect({ cookie: COOKIE.replace('synthetic-account-A-secret', 'synthetic-account-A-cleanup-rotated') });
  const account = JSON.parse(metadata.get('quark-settings-v1')).account.id;
  metadata.set('quark-registry-v1', JSON.stringify(before)); await service.stop(); const restored = createQuark(options); t.after(() => restored.stop());
  state.files[0].file_name = 'user-renamed-managed-video.mp4';
  state.files.push({ ...state.files[0], fid: 'untracked-user-video', file_name: 'untracked-user-video.mp4' });
  const result = await restored.cleanup(); assert.equal(result.deleted, 0); assert.equal(result.errors, 1);
  const after = JSON.parse(metadata.get('quark-registry-v1'));
  assert.equal(after.assets.length, 1); assert.equal(after.assets[0].account, account); assert.equal(after.assets[0].status, 'ready');
  assert.equal(after.assets[0].deleteIntent, undefined); assert.deepEqual(state.deletes, []); assert.deepEqual(state.purges, []);
  assert.equal(state.saved, 1); assert.equal(state.calls.filter(call => call.path === '/file' && call.options.method === 'POST').length, 1);
});

test('revoking the viewing authorization during directory indexing cancels all later reads and transfers', async t => {
  const { service, state, connect, select } = await fixture(t); await connect(); const selected = await select();
  let valid = true, confirmations = 0;
  state.beforeRequest = call => {
    if (call.path === '/file/sort' && new URL(call.value).searchParams.get('pdir_fid') === '0' && state.folders.has('A')) {
      confirmations++; setImmediate(() => { valid = false; }); return reply({ list: [] });
    }
  };
  const result = await service.prepare(detail, { ...selected, line: 0, episode: 0, valid: () => valid });
  assert.equal(result.status, 'error'); assert.match(result.reason, /授权已失效/); assert.equal(confirmations, 1); assert.equal(state.saved, 0);
  assert.equal(state.calls.filter(call => call.path === '/file' && call.options.method === 'POST').length, 1); assert.deepEqual(state.deletes, []);
});

test('connected share requests use the stored Cookie only at the fixed official API; anonymous and disabled accounts do not', async t => {
  const { service, state, connect, select } = await fixture(t);
  await select();
  assert.ok(state.calls.filter(call => call.path.startsWith('/share/')).every(call => call.options.headers.cookie === undefined));
  await connect(); state.calls.length = 0;
  state.beforeRequest = call => call.path.startsWith('/share/') && call.options.headers.cookie !== COOKIE ? reply({}, { http: 403 }) : undefined;
  const listing = await select(); assert.equal(listing.files.files.length, 1);
  const shared = state.calls.filter(call => call.path.startsWith('/share/'));
  assert.deepEqual(shared.map(call => call.path), ['/share/sharepage/token', '/share/sharepage/detail', '/share/sharepage/token', '/share/sharepage/detail']);
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
  const selected = await select();
  const savedConfig = metadata.get('quark-settings-v1');
  assert.ok(savedConfig);
  for (const channel of ['http', 'json']) for (const status of [401, 403, 429]) {
    const before = state.calls.length;
    state.beforeRequest = call => call.path === '/share/sharepage/token' ? reply({ message: COOKIE }, channel === 'http' ? { http: status } : { code: 1, status }) : undefined;
    await assert.rejects(service.files(detail, { shareId: selected.shareId }), error => {
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
    const selected = await select(); state.calls.length = 0;
    let release, entered; const reached = new Promise(resolve => { entered = resolve; });
    state.beforeRequest = async call => {
      if (call.path !== `/share/sharepage/${stage}`) return;
      entered(); await new Promise(resolve => { release = resolve; });
      return stage === 'token' ? reply({ stoken: 'synthetic-old-token' }) : reply({ list: [sourceVideo()] });
    };
    const rejected = assert.rejects(service.files(detail, { shareId: selected.shareId }), error => error.status === 409);
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
    await assert.rejects(service.files(detail, { shareId: oldest.shareId }), error => error.status === 403);
  }
  state.beforeRequest = null;
  assert.equal((await service.prepare(detail, oldest)).status, 'error');
  assert.equal(state.saved, 0); assert.equal(state.folders.size, 0);
});

test('defaults are disconnected and all automatic cloud mutations are disabled', async t => {
  const { service, state } = await fixture(t); const settings = await service.settings();
  assert.equal(settings.configured, false); assert.equal(settings.enabled, false); assert.equal(settings.autoSave, false); assert.equal(settings.cleanupEnabled, false); assert.equal(settings.retentionDays, 7);
  assert.equal(settings.maxDailyTransfers, 100); assert.equal(settings.maxDailyBytes, DAILY_BYTES); assert.equal(state.calls.length, 0);
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
  assert.equal(after.installId, before.installId); assert.equal(settings.maxDailyBytes, DAILY_BYTES);
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

test('the old default daily bytes upgrade once to 3 TB without losing other migrations or account data', async t => {
  const { service, options, metadata, state, connect } = await fixture(t);
  await connect({ maxDailyTransfers: 10, maxDailyBytes: 20 * GIB, retentionDays: 30 }); await service.stop();
  metadata.delete('quark-transfer-default-100-v1'); metadata.delete('quark-transfer-bytes-3tb-v1');
  const before = JSON.parse(metadata.get('quark-settings-v1'));
  const migrated = createQuark(options); t.after(() => migrated.stop());
  const settings = await migrated.settings(), after = JSON.parse(metadata.get('quark-settings-v1'));
  assert.equal(settings.maxDailyBytes, DAILY_BYTES); assert.equal(settings.maxDailyTransfers, 100);
  assert.equal(after.maxDailyBytes, DAILY_BYTES); assert.equal(after.maxDailyTransfers, 100);
  assert.equal(settings.retentionDays, 30); assert.deepEqual(after.account, before.account); assert.equal(after.installId, before.installId);
  await migrated.configure({ maxDailyBytes: 20 * GIB }); await migrated.stop();
  const reopened = createQuark(options); t.after(() => reopened.stop());
  assert.equal((await reopened.settings()).maxDailyBytes, 20 * GIB); await reopened.stop();
  for (const limit of [1024 * 1024, 60 * GIB, DAILY_BYTES]) {
    metadata.delete('quark-transfer-bytes-3tb-v1');
    metadata.set('quark-settings-v1', JSON.stringify({ ...after, maxDailyBytes: limit }));
    const custom = createQuark(options); t.after(() => custom.stop());
    assert.equal((await custom.settings()).maxDailyBytes, limit); await custom.stop();
  }
  assert.equal(state.saved, 0); assert.deepEqual(state.deletes, []);
});

test('3 TB daily byte settings persist and reject values beyond the supported budget', async t => {
  const { service, options, connect } = await fixture(t); await connect({ maxDailyBytes: DAILY_BYTES });
  for (const limit of [DAILY_BYTES + 1, DAILY_BYTES + 0.5, Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(() => service.configure({ maxDailyBytes: limit }), /容量/);
  await service.stop(); const reopened = createQuark(options); t.after(() => reopened.stop());
  assert.equal((await reopened.settings()).maxDailyBytes, DAILY_BYTES);
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
  const target = new URL(state.searchCalls[0].value); assert.equal(target.searchParams.get('kw'), '影片'); assert.equal(state.searchCalls[0].options.year, '2026'); assert.equal(target.searchParams.get('cloud_types'), 'quark'); assert.equal(target.searchParams.get('conc'), '2');
  const list = await service.files(film, { shareId: result.resources[0].id }); assert.ok(list.files[0].id); const token = state.calls.find(call => call.path === '/share/sharepage/token'); assert.equal(token.body.passcode, 'Ab12'); assert.equal(token.options.headers.cookie, COOKIE);
  for (const bad of ['http://127.0.0.1/a', 'https://pan.quark.cn.evil/s/abcdef123456', 'https://evil.example/s/abcdef123456', 'file:///a', 'https://user:pw@pan.quark.cn/s/abcdef123456']) assert.equal((await service.resources({ ...detail, id: bad, quarkShares: [bad] })).resources.length, 1); // Only the safe search result survives.
});

test('external search requires the film title or an explicit alias and never registers unverified links for transfer', async t => {
  const { service, state } = await fixture(t);
  const film = { ...detail, title: '一路超平安', aliases: ['Known Alternate Title'], quarkShares: [] };
  state.searchBody = JSON.stringify({ results: [
    { title: '一路超平安 (2026) 4K', url: 'https://pan.quark.cn/s/matched123' },
    { title: 'Known Alternate Title 2026', url: 'https://pan.quark.cn/s/aliased123' },
    { title: '一路平安 2026', url: 'https://pan.quark.cn/s/wrongfilm123' },
    { title: '一路超平安 (2016)', url: 'https://pan.quark.cn/s/wrongyear123' },
    { url: 'https://pan.quark.cn/s/untitled123' },
    { title: '资源链接', url: 'https://pan.quark.cn/s/generic123' },
  ], unverified: [{ url: 'https://pan.quark.cn/s/poolunknown123' }, { url: 'https://pan.quark.cn.evil/s/unsafe123' }] });
  const result = await service.resources(film);
  assert.deepEqual(result.resources.map(row => new URL(row.url).pathname), ['/s/matched123', '/s/aliased123']);
  assert.deepEqual(result.unverified.map(row => new URL(row.url).pathname), ['/s/untitled123', '/s/generic123', '/s/poolunknown123']);
  assert.equal(result.unverified.every(row => !Object.hasOwn(row, 'id')), true);
  assert.equal(result.unverified.some(row => row.name === film.title), false);
  await assert.rejects(service.files(film, { shareId: 'untitled123' }), /分享资源/);
  assert.deepEqual(await service.resources(film), result); assert.equal(state.searchCalls.length, 1);
  const provided = await service.resources({ ...film, id: 'trusted-catalog', quarkShares: ['https://pan.quark.cn/s/provided123'] });
  assert.ok(provided.resources.some(row => new URL(row.url).pathname === '/s/provided123'));
  assert.equal((await service.resources({ ...film, id: 'wrong-catalog', quarkShares: [{ title: '其他影片', url: 'https://pan.quark.cn/s/wrongcatalog123' }] })).resources.some(row => new URL(row.url).pathname === '/s/wrongcatalog123'), false);
});

test('irrelevant, unverified and duplicate entries cannot exhaust the matched-resource budget', async t => {
  const { service, state } = await fixture(t);
  state.searchBody = JSON.stringify({ results: [
    ...Array.from({ length: 110 }, (_, i) => ({ title: '其他电影', url: `https://pan.quark.cn/s/wrongfilm${i}` })),
    ...Array.from({ length: 35 }, (_, i) => ({ url: `https://pan.quark.cn/s/untitled${i}` })),
    ...Array.from({ length: 35 }, () => ({ title: '影片 2026', url: 'https://pan.quark.cn/s/duplicate123' })),
    { work_title: '影片 2026', links: [{ note: '4K1080P', url: 'https://pan.quark.cn/s/lastmatch123' }] },
  ] });
  const result = await service.resources({ ...detail, quarkShares: [] });
  assert.deepEqual(result.resources.map(row => new URL(row.url).pathname), ['/s/duplicate123', '/s/lastmatch123']);
  assert.equal(result.resources[1].name, '影片 2026'); assert.equal(result.unverified.length, 10);
  state.searchBody = JSON.stringify({ title: '影片 2026', unverified: [{ url: 'https://pan.quark.cn/s/inherited123' }, { title: '影片 2026', url: 'https://pan.quark.cn/s/forcedunknown123' }] });
  const forced = await service.resources({ ...detail, id: 'force-unverified', quarkShares: [] });
  assert.equal(forced.resources.length, 0); assert.equal(forced.unverified.length, 2);
  assert.equal(forced.unverified.every(row => !Object.hasOwn(row, 'id')), true);
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

test('series searches use complete work titles without episode/update suffixes and keep the selected episode for file matching', async t => {
  for (const [title, query, fileTitle] of [
    ['遮天', '遮天'], ['遮天 第42集', '遮天'], ['遮天 EP42', '遮天'], ['遮天 S01E42', '遮天'], ['遮天 更新至第56集', '遮天'], ['遮天（更新至第56集） 高清', '遮天'],
    ['一念永恒 完结季', '一念永恒', '一念永恒 完结季'], ['转生成为哥布林有什么问题吗？', '转生成为哥布林有什么问题吗?'], ['希望2026', '希望2026'],
  ]) await t.test(title, async t => {
    const { service, state, connect } = await fixture(t, { defaultSearchApi: 'https://search.example/api/search' }); await connect({ autoSave: true });
    const series = { ...detail, id: title, title, type: 'series', category: 'anime', lines: [{ episodes: [{ name: '第12集' }, { name: '第13集' }] }] };
    state.source = [sourceVideo('twelve', (fileTitle || query) + '.2026.EP12.mkv'), sourceVideo('thirteen', (fileTitle || query) + '.2026.EP13.mkv')];
    assert.equal((await service.prepare(series, { auto: true, episode: 0 })).status, 'ready');
    assert.equal((await service.prepare(series, { auto: true, episode: 1 })).status, 'ready');
    assert.equal(state.searchCalls.length, 1); assert.equal(new URL(state.searchCalls[0].value).searchParams.get('kw'), query); assert.equal(state.searchCalls[0].options.year, '2026');
    assert.equal(state.searchCalls[0].options.aliases.some(value => /第(?:12|13|42|56)集|更新至/.test(value)), false);
    assert.deepEqual(state.calls.filter(call => call.path === '/share/sharepage/save').map(call => call.body.fid_list), [['twelve'], ['thirteen']]);
  });
});

test('a series share folder update count never replaces the exact episode number selected inside it', async t => {
  const { service, state, connect } = await fixture(t); await connect({ autoSave: true });
  const series = { ...detail, title: '遮天 更新至第56集', type: 'series', category: 'anime', lines: [{ episodes: [{ name: '第12集' }] }] };
  state.source = [sourceVideo('twelve', '012.mkv'), sourceVideo('latest', '056.mkv')];
  state.beforeRequest = call => call.path === '/share/sharepage/detail' ? reply({ list: new URL(call.value).searchParams.get('pdir_fid') === '0' ? [{ fid: 'updated-folder', file_name: '遮天.2026.更新至56集', file: false }] : state.source }) : undefined;
  assert.equal((await service.prepare(series, { auto: true })).status, 'ready');
  assert.deepEqual(state.calls.find(call => call.path === '/share/sharepage/save').body.fid_list, ['twelve']);
});

test('canonical series searches retain raw-title binding, original year and explicitly known season for automatic transfer', async t => {
  for (const [title, fileName, season, expected] of [
    ['遮天第2季', '遮天.2026.S02E12.mkv', undefined, 'ready'],
    ['遮天 第二季 更新至第56集', '遮天.2026.S02E12.mkv', undefined, 'ready'],
    ['遮天第2季', '遮天.2026.S01E12.mkv', undefined, 'needsSelection'],
    ['遮天第2季', '遮天.2026.S02E12.mkv', 1, 'needsSelection'],
    ['遮天第2季', '遮天.2025.S02E12.mkv', undefined, 'needsSelection'],
    ['一念永恒 完结季', '一念永恒.2026.S02E12.mkv', undefined, 'needsSelection'],
  ]) await t.test(title + ' / ' + fileName + ' / ' + season, async t => {
    const { service, state, connect } = await fixture(t, { defaultSearchApi: 'https://search.example/api/search' }); await connect({ autoSave: true });
    const series = { ...detail, id: 'season', title, type: 'series', category: 'anime', season, lines: [{ episodes: [{ name: '第12集' }] }] };
    state.source = [sourceVideo('season-twelve', fileName)];
    assert.equal((await service.prepare(series, { auto: true })).status, expected);
    assert.equal(new URL(state.searchCalls[0].value).searchParams.get('kw'), title.startsWith('遮天') ? '遮天' : '一念永恒');
    assert.equal(state.saved, expected === 'ready' ? 1 : 0);
  });
  const { service, state, connect, select } = await fixture(t); await connect();
  const series = { ...detail, title: '遮天 更新至第56集', type: 'series', category: 'anime', lines: [{ episodes: [{ name: '第12集' }] }] };
  state.source = [sourceVideo('twelve', '遮天.2026.EP12.mkv')]; const selected = await select(series);
  assert.equal((await service.prepare({ ...series, title: '遮天 第12集' }, selected)).status, 'error'); assert.equal(state.saved, 0);
});

test('generic main-feature labels in known series never auto-transfer a season pack as a movie', async t => {
  for (const metadata of [{ type: 'series', category: 'movie' }, { category: 'tv' }, { category: 'anime' }, { category: 'movie', multiple: true }]) await t.test(JSON.stringify(metadata), async t => {
    const { service, state, connect } = await fixture(t); await connect({ autoSave: true });
    const series = { ...detail, title: '遮天', ...metadata, lines: [{ episodes: [{ name: '正片' }, ...(metadata.multiple ? [{ name: '正片' }] : [])] }] };
    state.source = [sourceVideo('pack', '遮天.2026.全集.mkv')];
    assert.equal((await service.prepare(series, { auto: true })).status, 'needsSelection'); assert.equal(state.saved, 0);
  });
});

test('movie query language suffixes become search aliases while exact file-title checks and embedded numeric titles remain intact', async t => {
  const { service, state, connect } = await fixture(t, { defaultSearchApi: 'https://search.example/api/search' }); await connect({ autoSave: true });
  const film = { ...detail, title: '一个部门的诞生国语', type: 'movie' };
  state.source = [sourceVideo('base-title', '一个部门的诞生.2026.mp4')]; assert.equal((await service.prepare(film, { auto: true })).status, 'needsSelection');
  state.source = [sourceVideo('exact-title', '一个部门的诞生国语.2026.mp4')]; assert.equal((await service.prepare(film, { auto: true })).status, 'ready');
  assert.equal(new URL(state.searchCalls[0].value).searchParams.get('kw'), '一个部门的诞生'); assert.deepEqual(state.searchCalls[0].options.aliases, ['一个部门的诞生国语']);
  await service.resources({ ...film, id: 'movie-aliases', aliases: ['正式别名', 'Another Title'] }); assert.deepEqual(state.searchCalls.at(-1).options.aliases, ['一个部门的诞生国语', '正式别名']);
  await service.resources({ ...detail, id: 'numeric-title', title: '希望2026', type: 'movie' }); assert.equal(new URL(state.searchCalls.at(-1).value).searchParams.get('kw'), '希望2026');
});

test('safe empty pool failures are not cached and the same work can recover immediately', async t => {
  const { service, state } = await fixture(t); const film = { ...detail, quarkShares: [] };
  state.searchBody = JSON.stringify({ results: [], reason: '\u0000Google 公开搜索暂不可用；' + '网络失败'.repeat(100), error: 'remote raw error must stay hidden', message: 'remote secret message' });
  const first = await service.resources(film); assert.equal(first.resources.length, 0); assert.ok(first.reason.startsWith('Google')); assert.ok(first.reason.length <= 300); assert.equal(first.reason.includes('remote'), false);
  state.searchBody = JSON.stringify({ results: [{ name: '影片', url: 'https://pan.quark.cn/s/recovered123' }] });
  const recovered = await service.resources(film); assert.equal(recovered.resources.length, 1); assert.equal(recovered.reason, undefined); assert.equal(state.searchCalls.length, 2);
  assert.deepEqual(await service.resources(film), recovered); assert.equal(state.searchCalls.length, 2);
  state.searchBody = JSON.stringify({ results: [] }); const refreshed = await service.resources(film, { webSearch: true }); assert.equal(refreshed.reason, undefined);
  assert.deepEqual(await service.resources(film), refreshed); assert.equal(state.searchCalls.length, 3);
  const emptyFilm = { ...film, id: 'empty', title: '正常空结果' }, empty = await service.resources(emptyFilm); assert.equal(empty.resources.length, 0); assert.equal(empty.reason, undefined);
  assert.deepEqual(await service.resources(emptyFilm), empty); assert.equal(state.searchCalls.length, 4);
});

test('pending public searches refresh their pool snapshot while completed share identities stay cached', async t => {
  const { service, state } = await fixture(t), film = { ...detail, quarkShares: [] };
  state.searchBody = JSON.stringify({ results: [], reason: '正在继续查找', pending: true, retryAfterMs: 1500 });
  const first = await service.resources(film); assert.deepEqual(first.resources, []); assert.equal(first.pending, true); assert.equal(first.retryAfterMs, 1500);
  assert.deepEqual(await service.resources(film), first); assert.equal(state.searchCalls.length, 2);
  state.searchBody = JSON.stringify({ results: [{ name: '影片 2026', url: 'https://pan.quark.cn/s/completed123', publishedAt: state.clock }] });
  const complete = await service.resources(film, { poll: true });
  assert.equal(complete.pending, undefined); assert.equal(complete.resources.length, 1); assert.equal(complete.resources[0].publishedAt, state.clock);
  assert.equal(state.searchCalls.length, 3); assert.equal(state.searchCalls.at(-1).options.poll, true);
  assert.deepEqual(await service.resources(film), complete); assert.equal(state.searchCalls.length, 3); assert.equal(state.saved, 0);
});

test('web and normal callers subscribe to their pool snapshots while sharing one rendered search and share identity', async t => {
  const metadata = new Map(), store = { meta: key => metadata.get(key), setMeta: (key, value) => metadata.set(key, value) };
  let release, renders = 0, requests = 0;
  const request = async url => { requests++; return textReply(url.includes('bing.com') ? '<rss><channel></channel></rss>' : '{"results":[]}'); };
  const pool = createQuarkSearchPool({ store, request, webRequest: request, googleSearch: async () => [], renderSearch: () => { renders++; return new Promise(resolve => { release = resolve; }); } });
  t.after(async () => { release?.([]); await pool.stop(); });
  const { service, state } = await fixture(t, { searchRequest: pool.request, defaultSearchApi: 'https://manual.example/api/search' });
  const film = { ...detail, quarkShares: [] };
  assert.equal((await service.resources(film, { webSearch: true })).pending, true);
  assert.equal((await service.resources(film)).pending, true, 'another normal caller subscribes to its own pool snapshot');
  assert.equal(renders, 1);
  const pendingRequests = requests;
  assert.equal((await service.resources(film)).pending, true);
  assert.equal(requests, pendingRequests, 'repeated normal subscribers read the existing pending snapshot without public requests');
  assert.equal(renders, 1);
  release([{ name: '影片 2026', url: 'https://pan.quark.cn/s/completed123', publishedAt: state.clock }]);
  for (let index = 0; index < 5; index++) await turn();
  const beforePoll = requests;
  const normal = await service.resources(film, { poll: true });
  const web = await service.resources(film, { webSearch: true, poll: true });
  assert.equal(normal.pending, undefined); assert.equal(web.pending, undefined);
  assert.equal(normal.resources.length, 1); assert.deepEqual(normal.resources, web.resources);
  assert.equal(normal.resources[0].publishedAt, state.clock);
  assert.equal(requests, beforePoll, 'polls read completed snapshots without making new public requests');
  assert.equal(renders, 1); assert.equal(state.saved, 0);
  assert.deepEqual(state.calls.map(call => call.path), ['/share/sharepage/token', '/share/sharepage/detail'], 'only the new candidate is checked at the official read-only endpoints');
});

test('pending cache expires at its bounded retry interval and never remains pending for a minute', async t => {
  const { service, state } = await fixture(t), film = { ...detail, quarkShares: [] };
  state.searchBody = JSON.stringify({ results: [], pending: true, retryAfterMs: 'unsafe' });
  assert.equal((await service.resources(film)).retryAfterMs, 1500); state.clock += 1501;
  state.searchBody = JSON.stringify({ results: [] });
  const complete = await service.resources(film); assert.equal(complete.pending, undefined); assert.equal(state.searchCalls.length, 2);
  await service.resources(film, { poll: true }); assert.equal(state.searchCalls.length, 3, 'poll bypasses the completed one-minute cache too');
  for (const [delay, expected] of [[1, 500], [999999, 5000]]) {
    state.searchBody = JSON.stringify({ results: [], pending: true, retryAfterMs: delay });
    assert.equal((await service.resources({ ...film, id: 'delay-' + delay })).retryAfterMs, expected);
  }
});

test('explicit web polling passes the existing query scope without another transfer or normal-search substitution', async t => {
  const { service, state } = await fixture(t), film = { ...detail, quarkShares: [] };
  state.searchBody = JSON.stringify({ results: [], pending: true });
  assert.equal((await service.resources(film, { webSearch: true })).pending, true);
  state.searchBody = JSON.stringify({ results: [{ name: '影片 2026', url: 'https://pan.quark.cn/s/webcomplete123' }] });
  const complete = await service.resources(film, { webSearch: true, poll: true });
  assert.equal(complete.pending, undefined); assert.equal(complete.resources.length, 1);
  assert.equal(state.searchCalls.at(-1).options.webSearch, true); assert.equal(state.searchCalls.at(-1).options.poll, true);
  assert.equal(state.searchCalls.at(-1).options.year, '2026'); assert.equal(state.saved, 0);
});

test('automatic single-episode transfers recognize bounded episode notation and Chinese hundreds through the share listing', async t => {
  for (const [selected, fileName, season, folder] of [
    ['第12集', '剧集.2026.S01E012.1080p.H265.mkv', 1],
    ['EP12', '剧集.2026.EP12.mkv'],
    ['Episode 12', '剧集.2026.Episode12.mkv'],
    ['第十二集', '剧集.2026.1x12.mkv', 1],
    ['第十二话', '剧集.2026.第十二话.mkv'],
    ['第101话', '剧集.2026.第一百零一话.mkv'],
    ['第一百二十集', '剧集.2026.EP120.mkv'],
    ['第999集', '剧集.2026.第九百九十九集.mkv'],
    ['第201集', '剧集.2026.第两百零一集.mkv'],
    ['ＥＰ１２', '剧集.2026.EP12.mkv'],
    ['S01E012', '012.mkv', 1, '剧集.2026'],
  ]) await t.test(selected + ' / ' + fileName, async t => {
    const { service, state, connect } = await fixture(t); await connect({ autoSave: true });
    const series = { ...detail, id: 'episodes', title: '剧集', category: 'tv', season, lines: [{ episodes: [{ name: selected }] }] };
    state.source = [sourceVideo('target', fileName), sourceVideo('other', '剧集.2026.EP121.mkv')];
    if (folder) state.beforeRequest = call => call.path === '/share/sharepage/detail' ? reply({ list: new URL(call.value).searchParams.get('pdir_fid') === '0' ? [{ fid: 'series-folder', file_name: folder, file: false }] : state.source }) : undefined;
    const resources = await service.resources(series), listing = await service.files(series, { shareId: resources.resources[0].id });
    assert.deepEqual(listing.files.filter(file => file.match).map(file => file.name), [fileName]); assert.equal(listing.ambiguous, false);
    const result = await service.prepare(series, { auto: true }); assert.equal(result.status, 'ready'); assert.equal(result.name, fileName);
    const transfer = state.calls.find(call => call.path === '/share/sharepage/save'); assert.deepEqual(transfer.body.fid_list, ['target']); assert.equal(state.saved, 1);
  });
});

test('episode ranges, metadata numbers and conflicting or ambiguous seasons never choose an automatic transfer', async t => {
  for (const [selected, names, season, folder] of [
    ['第12集', ['剧集.2026.EP120.mkv']],
    ['第12集', ['剧集.2026.EP1200.mkv']],
    ['第1集', ['2026.2160p60fps.H265.DTS5.1.mkv'], undefined, '剧集.2026'],
    ['第12集', ['剧集.2025.EP12.mkv']],
    ['第1集', ['剧集.2026.E01-E02.mkv']],
    ['第1集', ['01-02.mkv'], undefined, '剧集.2026'],
    ['第1集', ['剧集.2026.第1-2集.mkv']],
    ['第十二集', ['剧集.2026.第十二至十三集.mkv']],
    ['第1集', ['剧集.2026.E01+E02.mkv']],
    ['第1集', ['剧集.2026.S02E01.mkv'], 1],
    ['第1集', ['剧集.2026.S02E01.mkv']],
    ['第1集', ['剧集.2026.EP01.mkv'], 2],
    ['第1集', ['剧集.2026.S01E01.S02E01.mkv'], 1],
    ['S02E01', ['剧集.2026.S01E01.mkv'], 1],
    ['第12集', ['剧集.2026.EP12.720p.mkv', '剧集.2026.EP12.1080p.mkv']],
    ['第1-2集', ['剧集.2026.EP01.mkv']],
  ]) await t.test(selected + ' / ' + names.join(',') + ' / ' + season, async t => {
    const { service, state, connect } = await fixture(t); await connect({ autoSave: true });
    const series = { ...detail, id: 'ambiguous-episodes', title: '剧集', category: 'anime', season, lines: [{ episodes: [{ name: selected }] }] };
    state.source = names.map((value, index) => sourceVideo('candidate-' + index, value));
    if (folder) state.beforeRequest = call => call.path === '/share/sharepage/detail' ? reply({ list: new URL(call.value).searchParams.get('pdir_fid') === '0' ? [{ fid: 'series-folder', file_name: folder, file: false }] : state.source }) : undefined;
    const result = await service.prepare(series, { auto: true }); assert.equal(result.status, 'needsSelection'); assert.equal(state.saved, 0);
    assert.equal(state.calls.some(call => call.path === '/share/sharepage/save' || call.path === '/file' && call.options.method === 'POST'), false);
  });
});

test('explicit catalog aliases reach the search pool as local options without entering the public URL or headers', async t => {
  const { service, state } = await fixture(t); const aliases = ['公开别名', 'Known Alternate Title'];
  await service.resources({ ...detail, aliases }); assert.equal(state.searchCalls.length, 1);
  assert.deepEqual(state.searchCalls[0].options.aliases, aliases);
  assert.equal(aliases.some(alias => decodeURIComponent(state.searchCalls[0].value).includes(alias)), false);
  assert.equal(JSON.stringify(state.searchCalls[0].options.headers).includes('Known Alternate Title'), false);
});

test('public share dates are bounded, sorted newest first and merged without losing extraction passwords', async t => {
  const { service, state } = await fixture(t); const at = state.clock;
  const row = (id, label, publishedAt, password) => ({ url: 'https://pan.quark.cn/s/' + id, name: '影片 ' + label, publishedAt, password });
  state.searchBody = JSON.stringify({ results: [
    row('aaaaaa', '较旧有提取码', at - 20, 'A1'), row('aaaaaa', '较新无提取码', at - 10), row('aaaaaa', '最新无提取码', at - 2), row('aaaaaa', '最新提取码', at - 5, 'B2'), row('aaaaaa', '过时提取码', at - 30, 'C3'),
    row('bbbbbb', '最新资源', at), row('cccccc', '无日期资源', undefined),
    row('dddddd', '错误未来日期', at + DAY + 1), row('eeeeee', '错误负日期', -1), row('ffffff', '错误字符串日期', String(at)),
  ] });
  const film = { ...detail, quarkShares: [] }, result = await service.resources(film);
  assert.deepEqual(result.resources.map(row => new URL(row.url).pathname), ['/s/bbbbbb', '/s/aaaaaa', '/s/cccccc', '/s/dddddd', '/s/eeeeee', '/s/ffffff']);
  assert.equal(result.resources[1].name, '影片 最新无提取码'); assert.equal(result.resources[1].publishedAt, at - 2); assert.equal(new URL(result.resources[1].url).searchParams.get('pwd'), 'B2');
  assert.equal(Object.hasOwn(result.resources[1], 'passwordAt'), false);
  assert.equal(result.resources.slice(2).every(row => !Object.hasOwn(row, 'publishedAt')), true);
  assert.deepEqual(await service.resources(film), result); assert.equal(state.searchCalls.length, 1);
});

test('an explicit web search bypasses the ordinary resource cache and preserves already found API shares', async t => {
  const { service, state } = await fixture(t); const film = { ...detail, quarkShares: [] };
  state.searchBody = JSON.stringify({ results: [{ url: 'https://pan.quark.cn/s/aaaaaa', name: '影片 API 资源', publishedAt: state.clock - 10 }] });
  const ordinary = await service.resources(film); assert.equal(ordinary.resources.length, 1);
  assert.deepEqual(await service.resources(film), ordinary); assert.equal(state.searchCalls.length, 1);
  state.searchBody = JSON.stringify({ results: [{ url: 'https://pan.quark.cn/s/bbbbbb', name: '影片 公开网页资源', publishedAt: state.clock }] });
  const result = await service.resources(film, { webSearch: true });
  assert.equal(state.searchCalls.length, 2); assert.equal(state.searchCalls[1].options.webSearch, true);
  assert.equal(state.searchCalls[1].options.forceRefresh, true);
  assert.deepEqual(result.resources.map(row => row.name), ['影片 公开网页资源', '影片 API 资源']);
  assert.deepEqual(await service.resources(film), result); assert.equal(state.searchCalls.length, 2);
});

test('only accessible shares containing a video appear, including untitled public links', async t => {
  const { service, state, connect } = await fixture(t); await connect();
  const film = { ...detail, quarkShares: [] };
  state.searchBody = JSON.stringify({ results: [
    { title: '影片 2026 可用', url: 'https://pan.quark.cn/s/available123' },
    { title: '影片 2026 已取消', url: 'https://pan.quark.cn/s/canceled123' },
    { title: '影片 2026 图片', url: 'https://pan.quark.cn/s/images123' },
    { url: 'https://pan.quark.cn/s/unknownbad123' },
  ] });
  state.beforeRequest = call => {
    if (!call.path.startsWith('/share/sharepage/')) return;
    assert.equal(call.options.headers.cookie, COOKIE, 'account credentials go only to the fixed official share API');
    const pwdId = call.body?.pwd_id || new URL(call.value).searchParams.get('pwd_id');
    if (pwdId === 'canceled123' || pwdId === 'unknownbad123') return reply(null, { code: 41001, status: 404 });
    if (pwdId === 'images123' && call.path.endsWith('/detail')) return reply({ list: [{ fid: 'poster', file_name: '海报.jpg', file: true, size: 1024 }] });
  };
  const result = await service.resources(film);
  assert.equal(result.resourceSnapshot, true); assert.equal(result.pending, undefined);
  assert.deepEqual(result.resources.map(row => new URL(row.url).pathname), ['/s/available123']);
  assert.equal(result.unverified, undefined); assert.match(result.reason, /已隐藏 3 条/);
  assert.equal(state.calls.some(call => ['/file', '/share/sharepage/save', '/file/delete', '/file/recycle/remove'].includes(call.path)), false);
  assert.deepEqual(await service.resources(film), result, 'hidden entries stay out of cached snapshots');
});

test('slow share verification returns a pending snapshot and polling reveals it without another search or probe', async t => {
  const { service, state } = await fixture(t);
  let release; const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  state.beforeRequest = async call => { if (call.path === '/share/sharepage/token') await gate; };
  const initial = await service.resources(detail);
  assert.deepEqual(initial.resources, []); assert.equal(initial.validationPending, true); assert.equal(initial.resourceSnapshot, true);
  assert.equal(state.calls.filter(call => call.path.endsWith('/token')).length, 1);
  release(); await turn();
  const complete = await service.resources(detail, { poll: true });
  assert.equal(complete.resources.length, 1); assert.equal(complete.pending, undefined);
  assert.equal(state.calls.filter(call => call.path.endsWith('/token')).length, 1);
  assert.equal(state.saved, 0);
});

test('a share canceled after its first verified search is removed by more and does not lose other shares', async t => {
  const { service, state } = await fixture(t);
  const film = { ...detail, quarkShares: [] };
  state.searchBody = JSON.stringify({ results: [{ title: '影片 2026 原分享', url: 'https://pan.quark.cn/s/original123' }] });
  const first = await service.resources(film); assert.equal(first.resources.length, 1);
  state.searchBody = JSON.stringify({ results: [{ title: '影片 2026 新分享', url: 'https://pan.quark.cn/s/newshare123' }] });
  state.beforeRequest = call => call.path.endsWith('/token') && call.body.pwd_id === 'original123' ? reply(null, { status: 404, code: 41001 }) : undefined;
  const more = await service.resources(film, { webSearch: true });
  assert.deepEqual(more.resources.map(row => new URL(row.url).pathname), ['/s/newshare123']);
  assert.equal(more.resourceSnapshot, true); assert.equal(state.searchCalls.at(-1).options.forceRefresh, true);
  assert.deepEqual((await service.resources(film)).resources, more.resources);
});

test('a failed fresh file listing invalidates a previously verified share only temporarily', async t => {
  const { service, state } = await fixture(t);
  const first = await service.resources(detail), selected = first.resources[0]; assert.ok(selected);
  state.beforeRequest = call => call.path.endsWith('/token') ? reply(null, { status: 403, code: 403 }) : undefined;
  await assert.rejects(service.files(detail, { shareId: selected.id }), /拒绝访问/);
  assert.equal((await service.resources(detail)).resources.length, 0);
  state.beforeRequest = null; state.clock += 30001;
  assert.equal((await service.resources(detail)).resources[0].id, selected.id, 'temporary errors never permanently delete a resource');
});

test('a late old-account listing failure cannot invalidate a new account share snapshot', async t => {
  const { service, state, connect, select } = await fixture(t); await connect();
  const selected = await select();
  let release, entered; const reached = new Promise(resolve => { entered = resolve; });
  state.beforeRequest = async call => {
    if (call.path.endsWith('/token') && call.account === 'A') { entered(); await new Promise(resolve => { release = resolve; }); }
  };
  const oldRead = assert.rejects(service.files(detail, { shareId: selected.shareId }), cause => cause.status === 409);
  await reached;
  try {
    await connect({ cookie: COOKIE_B });
    assert.equal((await service.resources(detail)).resources.length, 1);
  } finally { release(); }
  await oldRead;
  assert.equal((await service.resources(detail)).resources.length, 1, 'old-epoch errors must not poison the current validator');
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
  const resource = (await service.resources(detail)).resources[0]; state.calls.length = 0;
  const listing = await service.files(detail, { shareId: resource.id }); assert.equal(listing.truncated, true); assert.ok(listing.files.every(file => /\.mp4$/.test(file.name))); assert.ok(state.calls.filter(call => call.path.startsWith('/share/sharepage')).length <= 6);
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

test('the default daily budget permits large files up to exactly 3 TB and still enforces total bytes', async t => {
  const { service, state, connect, select, save } = await fixture(t); await connect();
  let used = 0, count = 0;
  while (used < DAILY_BYTES) {
    const size = Math.min(100 * GIB, DAILY_BYTES - used);
    state.source = [sourceVideo('quota-' + count, '影片.2026.mp4', size)];
    assert.equal((await save()).status, 'ready'); used += size; count++;
  }
  assert.equal(used, DAILY_BYTES); assert.equal(state.saved, count);
  assert.equal((await service.prepare(detail, await select())).status, 'ready'); assert.equal(state.saved, count);
  state.source = [sourceVideo('over-three-tb', '影片.2026.mp4', 1024 * 1024)];
  assert.match((await service.prepare(detail, await select())).reason, /上限/); assert.equal(state.saved, count);
});

test('official desktop playback protocol accepts completed accessible video_info and keeps the matching media User-Agent', async t => {
  const { service, state, connect, save } = await fixture(t); await connect(); const saved = await save();
  const signed = 'https://video-cloud.quark.cn/stream.m3u8?auth_key=A%2BB%2FC&x=1';
  state.beforeRequest = call => {
    if (call.path !== '/file/v2/play/project') return;
    assert.match(call.options.headers['user-agent'], /quark-cloud-drive\/2\.5\.20/);
    assert.equal(call.options.headers.cookie, COOKIE); assert.equal(call.options.headers.referer, 'https://pan.quark.cn/');
    assert.deepEqual(call.body, { fid: 'saved-1', resolutions: 'low,normal,high,super,2k,4k', supports: 'fmp4_av,m3u8,dolby_vision' });
    return reply({ default_resolution: 'high', origin_default_resolution: '4k', file_name: '影片.2026.mkv', video_list: [
      null,
      { resolution: '4k', accessable: false, video_info: { url: 'https://video-cloud.quark.cn/denied.m3u8', width: 3840, height: 2160, success: true, finish: true } },
      { resolution: '4k', accessable: true, video_info: { url: 'https://video-cloud.quark.cn/unfinished.m3u8', width: 3840, height: 2160, success: true, finish: false } },
      { resolution: 'super', accessable: true, supports_format: 'fmp4_av,m3u8', video_info: { url: signed, width: 1920, height: 1080, format: 'm3u8', codec: 'h264', fps: 25, audio: { codec: 'aac', channels: 2 }, success: true, finish: true } },
      { resolution: 'high', video_info: { url: 'https://video-cloud.quark.cn/lower.m3u8', width: 1280, height: 720, success: true, finish: true } },
    ] });
  };
  const result = await service.playback(saved.assetId, { valid: () => true });
  assert.equal(result.episode.url, signed); assert.equal(result.episode.type, 'hls'); assert.equal(result.metadata.mode, 'official');
  assert.deepEqual(result.metadata.quality, { width: 1920, height: 1080 });
  const project = state.calls.find(call => call.path === '/file/v2/play/project');
  assert.equal(result.headers['user-agent'], project.options.headers['user-agent']); assert.equal(result.headers.cookie, COOKIE);
  assert.equal(state.calls.filter(call => call.path === '/file/download').length, 0);
});

test('manual cloud transfers resume only their own saved asset and a different file starts at zero', async t => {
  const { service, state, connect, select } = await fixture(t); await connect();
  const film = { ...detail, source: 'quark-library', id: '12345' };
  const firstSelection = await select(film), first = await service.prepare(film, { ...firstSelection, auto: false });
  assert.equal(first.position, 0); assert.equal(first.duration, 0);
  await service.progress(first.assetId, { position: 281, duration: 1200, ended: false });
  const again = await service.prepare(film, { ...firstSelection, auto: false });
  assert.equal(again.assetId, first.assetId); assert.equal(again.position, 281); assert.equal(again.duration, 1200);
  state.source = [sourceVideo('different-video', '影片.2026.1080p.mkv')];
  const secondSelection = await select(film), second = await service.prepare(film, { ...secondSelection, auto: false });
  assert.notEqual(second.assetId, first.assetId); assert.equal(second.position, 0); assert.equal(second.duration, 0);
  assert.equal(state.saved, 2);
});

test('a normal official download fallback uses desktop credentials and returns the signed MKV for NAS compatibility', async t => {
  const { service, state, connect, save } = await fixture(t); await connect(); state.source = [sourceVideo('mkv-original', '影片.2026.HEVC10bit.DTS.mkv', 16 * GIB)]; const saved = await save();
  const signed = 'https://download.quark.cn/original?auth_key=A%2BB&filename=movie.mkv';
  state.beforeRequest = call => {
    if (call.path === '/file/v2/play/project') return reply(null, { status: 403, code: 32003 });
    if (call.path === '/file/download') {
      assert.match(call.options.headers['user-agent'], /quark-cloud-drive\//); assert.equal(call.options.headers.cookie, COOKIE);
      assert.deepEqual(call.body, { fids: ['saved-1'] }); assert.equal(new URL(call.value).searchParams.get('uc_param_str'), '');
      return reply([{ fid: 'saved-1', file_name: '影片.2026.HEVC10bit.DTS.mkv', pdir_fid: 'app-folder-A', size: 16 * GIB, format_type: 'video/x-matroska', download_url: signed }]);
    }
  };
  const result = await service.playback(saved.assetId);
  assert.equal(result.episode.url, signed); assert.equal(result.episode.type, 'mkv'); assert.equal(result.metadata.mode, 'download'); assert.equal(result.metadata.requiresCompatibility, true);
  assert.equal(result.headers['user-agent'], state.calls.find(call => call.path === '/file/download').options.headers['user-agent']);
  assert.equal(result.headers.cookie, COOKIE); assert.deepEqual(result.allowCookieOrigins, ['https://download.quark.cn']);
  assert.equal(state.calls.filter(call => call.path === '/file/download').length, 1);
});

test('official playback login rejection and rate limits never continue to the download endpoint', async t => {
  for (const status of [401, 429]) for (const http of [200, status]) await t.test(`${status} / HTTP ${http}`, async t => {
    const { service, state, connect, save } = await fixture(t); await connect(); const saved = await save();
    state.beforeRequest = call => call.path === '/file/v2/play/project' ? reply(null, { code: status, status, http }) : undefined;
    await assert.rejects(service.playback(saved.assetId), error => error.status === status && (status !== 401 || error.quarkAuth === true));
    assert.equal(state.calls.filter(call => call.path === '/file/download').length, 0); assert.equal((await service.settings()).configured, true);
  });
});

test('Quark playback cancellation across official and download awaits never returns a URL or continues a revoked request', async t => {
  for (const phase of ['project', 'download']) for (const mutation of ['view', 'session', 'account', 'disable']) await t.test(`${phase} / ${mutation}`, async t => {
    const { service, state, connect, save } = await fixture(t); await connect(); const saved = await save();
    let valid = true, revoked, release; const entered = new Promise(resolve => { revoked = resolve; });
    state.beforeRequest = async call => {
      if (call.path === '/file/v2/play/project' && phase === 'download') return reply({ video_list: [] });
      if (call.path === (phase === 'project' ? '/file/v2/play/project' : '/file/download')) { revoked(); await new Promise(resolve => { release = resolve; }); }
    };
    const validHook = () => { if (!valid && mutation === 'session') throw Object.assign(new Error('family login ended'), { status: 401 }); return valid; };
    const pending = service.playback(saved.assetId, { valid: validHook }); await entered;
    if (mutation === 'account') await service.clearAccount();
    else if (mutation === 'disable') await service.configure({ enabled: false });
    else valid = false;
    release(); await assert.rejects(pending, error => error.status === (mutation === 'session' ? 401 : 409));
    assert.equal(state.calls.filter(call => call.path === '/file/download').length, phase === 'download' ? 1 : 0);
    assert.equal(state.deletes.length, 0);
  });
});

test('a revoked playback authorization is checked before file validation or leasing the asset', async t => {
  const { service, state, connect, save, metadata } = await fixture(t); await connect(); const saved = await save();
  const before = metadata.get('quark-registry-v1'), calls = state.calls.length;
  await assert.rejects(service.playback(saved.assetId, { valid: () => false }), error => error.status === 409);
  assert.equal(state.calls.length, calls); assert.equal(metadata.get('quark-registry-v1'), before);
});

test('failure of both normal playback routes reports safe phases and numeric codes without exposing upstream secrets', async t => {
  const { service, state, connect, save } = await fixture(t); await connect(); const saved = await save();
  state.beforeRequest = call => {
    if (call.path === '/file/v2/play/project' || call.path === '/file/download') return textReply(JSON.stringify({ status: 500, code: call.path === '/file/download' ? 31105 : 32003, message: COOKIE + ' https://private.example/video?secret=sensitive-upstream' }));
  };
  await assert.rejects(service.playback(saved.assetId), error => error.status === 502 && /官方在线播放.*HTTP 200，API 32003.*原文件链接获取也失败.*HTTP 200，API 31105/.test(error.message) && !error.message.includes(COOKIE) && !error.message.includes('private.example') && !error.message.includes('sensitive-upstream'));
  assert.equal(state.calls.filter(call => call.path === '/file/download').length, 1);
});

test('playback retains official adaptive qualities and keeps stable category/version metadata', async t => {
  const { service, connect, save, state } = await fixture(t); await connect(); const saved = await save({ ...detail, category: 'adult' });
  const result = await service.playback(saved.assetId); assert.equal(result.episode.url, state.playUrl); assert.equal(result.episode.type, 'hls'); assert.deepEqual(result.metadata.quality, { width: 1920, height: 1080 }); assert.equal(result.metadata.category, 'adult'); assert.match(result.metadata.version, /^[a-f0-9]{24}$/);
  assert.deepEqual(result.allowCookieOrigins, ['https://video-cloud.quark.cn']); assert.equal(result.headers.cookie, COOKIE);
  const same = await service.playback(saved.assetId); assert.equal(same.metadata.version, result.metadata.version);
  await assert.rejects(service.playback('user-file'), /登记/); assert.equal(state.deletes.length, 0);
});

test('official multi-quality HLS starts at 1080p while preserving 4K and excluding invalid or unfinished streams', async t => {
  const { service, connect, save, state } = await fixture(t); await connect(); const saved = await save();
  state.beforeRequest = call => call.path === '/file/v2/play/project' ? reply({ video_list: [
    { video_info: { url: 'https://fourk.quark.cn/movie.m3u8?sig=4K%2B', width: 3840, height: 2160, bitrate: 24000000 } },
    { video_info: { url: state.playUrl, width: 1920, height: 1080, bitrate: 6000000 } },
    { video_info: { url: 'https://public-cdn.example/720.m3u8?token=a%2Fb', width: 1280, height: 720, bitrate: 2500000 } },
    { video_info: { url: state.playUrl, width: 1920, height: 1080 } },
    { video_info: { url: 'http://127.0.0.1/private.m3u8', width: 8192, height: 4320 } },
    { video_info: { url: 'https://pending.quark.cn/unfinished.m3u8', width: 7680, height: 4320, finish: false } },
    { accessable: false, video_info: { url: 'https://locked.quark.cn/locked.m3u8', width: 7680, height: 4320 } },
  ] }) : undefined;
  const result = await service.playback(saved.assetId);
  assert.equal(result.episode.url, state.playUrl); assert.deepEqual(result.metadata.quality, { width: 1920, height: 1080 });
  assert.deepEqual(result.variants.map(({ height, bandwidth }) => ({ height, bandwidth })), [{ height: 720, bandwidth: 2500000 }, { height: 1080, bandwidth: 6000000 }, { height: 2160, bandwidth: 24000000 }]);
  assert.match(result.variants[0].url, /token=a%2Fb$/); assert.match(result.variants.at(-1).url, /sig=4K%2B$/);
  assert.deepEqual(new Set(result.allowCookieOrigins), new Set(['https://video-cloud.quark.cn', 'https://fourk.quark.cn'])); assert.equal(result.headers.cookie, COOKIE);
  assert.equal(state.calls.filter(call => call.path === '/file/download').length, 0);
});

test('official nonadaptive qualities also prefer 1080p instead of forcing 4K', async t => {
  const { service, connect, save, state } = await fixture(t); await connect(); const saved = await save();
  state.beforeRequest = call => call.path === '/file/v2/play/project' ? reply({ video_list: [
    { video_info: { url: 'https://video-cloud.quark.cn/4k.mp4', width: 3840, height: 2160 } },
    { video_info: { url: 'https://video-cloud.quark.cn/1080.mp4', width: 1920, height: 1080 } },
  ] }) : undefined;
  const result = await service.playback(saved.assetId);
  assert.equal(result.episode.url, 'https://video-cloud.quark.cn/1080.mp4'); assert.equal(result.episode.type, 'mp4');
  assert.deepEqual(result.metadata.quality, { width: 1920, height: 1080 }); assert.equal(result.variants, undefined);
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
