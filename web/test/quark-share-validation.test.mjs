import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { createQuarkShareValidator } from '../lib/quark-share-validation.mjs';

const resource = (index = 1, password = '') => ({ pwdId: 'share' + String(index).padStart(6, '0'), password, url: 'https://pan.quark.cn/s/share' + String(index).padStart(6, '0') });
const isDirectory = row => row.file === false || row.dir === true;
const isVideo = row => row.file === true && /\.(?:mp4|mkv|ts)$/i.test(row.file_name);
const video = (id = 'video') => ({ fid: id, file: true, file_name: '影片.2026.mp4', size: 1000 });
const image = index => ({ fid: 'image' + index, file: true, file_name: '图片' + index + '.jpg', size: 100 });
const folder = id => ({ fid: id, file_name: id, file: false });
const token = { code: 0, data: { stoken: 'synthetic-private-share-token' } };
const list = (rows, total) => ({ code: 0, data: { list: rows }, ...(total === undefined ? {} : { metadata: { _total: total } }) });
function fixture(t, reply = () => list([video()]), options = {}) {
  const calls = [];
  const validator = createQuarkShareValidator({ isVideo, isDirectory, read: async (path, input) => {
    assert.ok(['/share/sharepage/token', '/share/sharepage/detail'].includes(path));
    assert.ok(input.signal instanceof AbortSignal);
    assert.ok(input.timeout > 0 && input.timeout <= 8000);
    assert.equal(input.credentials, undefined); assert.equal(input.headers, undefined);
    calls.push({ path, input });
    return path.endsWith('/token') ? token : reply(input);
  }, ...options });
  t.after(() => validator.stop());
  return { validator, calls };
}

test('a video share is checked through only the token and detail endpoints and never exposes tokens', async t => {
  const f = fixture(t), entry = f.validator.inspect(resource(1, 'A1B2'));
  assert.equal(entry.status, 'checking'); assert.equal(entry.pending, true);
  assert.equal(await entry.promise, entry);
  assert.deepEqual(entry, { status: 'valid', pending: false });
  assert.deepEqual(f.calls.map(call => [call.path, call.input.method]), [['/share/sharepage/token', 'POST'], ['/share/sharepage/detail', 'GET']]);
  assert.deepEqual(f.calls[0].input.body, { pwd_id: resource().pwdId, passcode: 'A1B2' });
  assert.equal(f.calls[1].input.query._size, '100');
  assert.equal(f.calls[1].input.query.stoken, token.data.stoken);
  assert.equal(f.calls[0].input.signal, f.calls[1].input.signal);
  assert.doesNotMatch(JSON.stringify(entry), /synthetic-private|stoken|A1B2/);
});

test('invalid identities never call the adapter', async t => {
  const f = fixture(t);
  for (const value of [null, {}, { pwdId: 'bad' }, { pwdId: resource().pwdId, password: 0 }, { pwdId: resource().pwdId, password: 'bad code' }]) {
    assert.deepEqual(f.validator.inspect(value), { status: 'unavailable', reason: '夸克分享地址或提取码无效', pending: false });
  }
  assert.equal(f.calls.length, 0);
  assert.throws(() => createQuarkShareValidator({ read: async () => {} }), /predicates/);
});

test('canceled, protected, denied and unknown shares stay unavailable without leaking upstream messages or retrying', async t => {
  for (const result of [
    Object.assign(new Error('synthetic-upstream-secret'), { quarkUpstreamCode: 41017 }),
    ...[401, 403, 429].map(status => Object.assign(new Error('synthetic-upstream-secret'), { quarkUpstreamStatus: status })),
    new Error('synthetic-upstream-secret'), { code: 123, data: { stoken: 'not-valid' } }, { code: 0, data: {} },
  ]) await t.test(String(result.quarkUpstreamStatus || result.quarkUpstreamCode || result.code || 'unknown'), async t => {
    let calls = 0;
    const f = fixture(t, undefined, { read: async () => { calls++; if (result instanceof Error) throw result; return result; } });
    const entry = f.validator.inspect(resource()); await entry.promise;
    assert.equal(entry.status, 'unavailable'); assert.equal(entry.pending, false);
    assert.doesNotMatch(JSON.stringify(entry), /synthetic-upstream-secret|not-valid/);
    assert.equal(calls, 1);
    assert.equal(f.validator.inspect(resource()), entry);
  });
});

test('complete empty and image-only listings are hidden, including folders named like videos', async t => {
  for (const rows of [[], [image(1)], [{ ...folder('fake'), file_name: 'fake.mp4' }]]) await t.test(JSON.stringify(rows.map(row => row.file_name)), async t => {
    const f = fixture(t, input => list(input.query.pdir_fid === '0' ? rows : []));
    const entry = f.validator.inspect(resource()); await entry.promise;
    assert.equal(entry.status, 'empty'); assert.equal(entry.pending, false);
    assert.doesNotMatch(JSON.stringify(entry), /synthetic-private/);
  });
});

test('video sizes must be positive safe integers and malformed sizes cannot masquerade as an empty share', async t => {
  for (const size of [undefined, null, NaN, -1, 0, '0', 'not-a-size', 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) await t.test(String(size), async t => {
    const f = fixture(t, () => list([{ ...video(), size }]));
    const entry = f.validator.inspect(resource()); await entry.promise;
    assert.equal(entry.status, 'unavailable'); assert.equal(entry.pending, false);
  });
  const f = fixture(t, () => list([{ ...video(), size: '1000' }]));
  const entry = f.validator.inspect(resource()); await entry.promise;
  assert.equal(entry.status, 'valid');
});

test('a video in a nested paginated folder is found without reading any further folders', async t => {
  const f = fixture(t, input => {
    const q = input.query;
    if (q.pdir_fid === '0') return list([folder('episodes')], 1);
    if (q._page === '1') return list(Array.from({ length: 100 }, (_, index) => image(index)), 101);
    return list([video()], 101);
  });
  const entry = f.validator.inspect(resource()); await entry.promise;
  assert.equal(entry.status, 'valid'); assert.equal(f.calls.length, 4);
  assert.deepEqual(f.calls.slice(1).map(call => [call.input.query.pdir_fid, call.input.query._page]), [['0', '1'], ['episodes', '1'], ['episodes', '2']]);
});

test('incomplete, duplicate and malformed listings are unavailable instead of falsely classified as empty', async t => {
  const images = Array.from({ length: 100 }, (_, index) => image(index));
  for (const [label, reply] of [
    ['full page without total', () => list(images)],
    ['duplicate files', () => list([image(1), image(1)])],
    ['invalid list', () => ({ data: { list: {} } })],
    ['invalid row', () => list([{ fid: 'bad/id', file: true, file_name: 'movie.mp4' }])],
    ['contradictory total', () => list([image(1)], 0)],
    ['empty but more expected', () => list([], 1)],
    ['changing total', input => input.query._page === '1' ? list([image(1)], 2) : list([image(2)], 3)],
    ['missing later total', input => input.query._page === '1' ? list([image(1)], 2) : list([image(2)])],
    ['depth limit', input => list([folder('deeper' + input.query.pdir_fid)])],
    ['directory request limit', input => input.query.pdir_fid === '0' ? list(Array.from({ length: 10 }, (_, index) => folder('folder' + index))) : list([])],
  ]) await t.test(label, async t => {
    const f = fixture(t, reply), entry = f.validator.inspect(resource()); await entry.promise;
    assert.equal(entry.status, 'unavailable'); assert.equal(entry.pending, false);
    assert.ok(f.calls.length <= 6, 'one token plus at most five directory requests');
  });
});

test('cache durations, password keys and force checks preserve a fresh valid result while deduplicating work', async t => {
  let clock = 1000, hold, check = false;
  const f = fixture(t, async () => { if (check) await new Promise(resolve => { hold = resolve; }); return list([video()]); }, { now: () => clock });
  const first = f.validator.inspect(resource()); await first.promise;
  assert.equal(f.validator.inspect(resource()), first); assert.equal(f.calls.length, 2);
  check = true;
  const forced = f.validator.inspect(resource(), { force: true });
  assert.notEqual(forced, first); assert.equal(forced.status, 'valid'); assert.equal(forced.pending, true);
  assert.equal(f.validator.inspect(resource(), { force: true }), forced);
  await turn(); hold(); await forced.promise; check = false;
  const protectedEntry = f.validator.inspect(resource(1, 'NEW1')); await protectedEntry.promise;
  assert.equal(f.calls.length, 6, 'a changed extraction code must be checked separately');
  clock += 120_000;
  const expired = f.validator.inspect(resource()); assert.equal(expired.status, 'checking'); await expired.promise;
  assert.equal(f.calls.length, 8);
  let noVideo = true;
  const negative = fixture(t, () => list(noVideo ? [] : [video()]), { now: () => clock });
  const empty = negative.validator.inspect(resource()); await empty.promise;
  clock += 29_999; assert.equal(negative.validator.inspect(resource()), empty);
  clock++; noVideo = false;
  const retry = negative.validator.inspect(resource()); assert.equal(retry.status, 'checking'); await retry.promise;
  assert.equal(retry.status, 'valid');
});

test('the eight-second active budget spans both token and directory reads and aborts the adapter', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  let releaseToken, signal, aborted = false;
  const calls = [];
  const f = fixture(t, undefined, { read: (path, input) => {
    calls.push(input.timeout); signal = input.signal;
    return path.endsWith('/token') ? new Promise(resolve => { releaseToken = () => resolve(token); }) : new Promise((_, reject) => input.signal.addEventListener('abort', () => { aborted = true; reject(input.signal.reason); }, { once: true }));
  } });
  const entry = f.validator.inspect(resource()); await turn();
  t.mock.timers.tick(3000); releaseToken(); await turn();
  assert.deepEqual(calls, [8000, 5000]);
  t.mock.timers.tick(4999); assert.equal(entry.pending, true);
  t.mock.timers.tick(1); await entry.promise;
  assert.equal(entry.status, 'unavailable'); assert.match(entry.reason, /8秒/);
  assert.equal(aborted, true); assert.equal(signal.aborted, true);
});

test('only two checks run, at most 64 wait, and queued checks expire after thirty seconds', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  let calls = 0, running = 0, maximum = 0;
  const f = fixture(t, undefined, { read: (_, input) => new Promise((_, reject) => {
    calls++; maximum = Math.max(maximum, ++running);
    input.signal.addEventListener('abort', () => { running--; reject(input.signal.reason); }, { once: true });
  }) });
  const entries = Array.from({ length: 66 }, (_, index) => f.validator.inspect(resource(index)));
  const settled = entries.map(entry => entry.promise);
  const overflow = f.validator.inspect(resource(100));
  assert.equal(overflow.status, 'unavailable'); assert.equal(overflow.pending, false); assert.match(overflow.reason, /繁忙/);
  await turn(); assert.equal(calls, 2); assert.equal(maximum, 2);
  t.mock.timers.tick(8000); await turn(); assert.equal(calls, 4); assert.equal(maximum, 2);
  t.mock.timers.tick(22_000); await Promise.all(settled); await turn();
  assert.ok(entries.every(entry => !entry.pending && entry.status === 'unavailable'));
  assert.ok(entries.some(entry => /排队超过30秒/.test(entry.reason)));
  assert.equal(calls, 4); assert.equal(running, 0);
});

test('completed cache entries never grow beyond 128', async t => {
  const f = fixture(t), saved = [];
  for (let index = 0; index < 129; index++) { const entry = f.validator.inspect(resource(index)); await entry.promise; saved.push(entry); }
  assert.equal(f.validator.inspect(resource(128)), saved[128]);
  const oldest = f.validator.inspect(resource(0));
  assert.notEqual(oldest, saved[0]); assert.equal(oldest.pending, true); await oldest.promise;
  assert.equal(f.calls.length, 260);
});

test('clear and stop abort active reads, settle queued work and prevent later directory requests', async t => {
  let calls = 0, aborted = 0;
  const f = fixture(t, undefined, { read: (_, input) => new Promise((_, reject) => {
    calls++; input.signal.addEventListener('abort', () => { aborted++; reject(input.signal.reason); }, { once: true });
  }) });
  const entries = [1, 2, 3].map(index => f.validator.inspect(resource(index))), settled = entries.map(entry => entry.promise);
  await turn(); assert.equal(calls, 2);
  f.validator.clear(); await Promise.all(settled); await turn();
  assert.equal(aborted, 2); assert.ok(entries.every(entry => entry.status === 'unavailable' && !entry.pending));
  const restarted = f.validator.inspect(resource(1)); assert.notEqual(restarted, entries[0]); await turn();
  const stop = f.validator.stop(); assert.equal(f.validator.stop(), stop); await stop;
  assert.equal(aborted, 3); assert.equal(restarted.pending, false);
  assert.equal(f.validator.inspect(resource(4)).status, 'unavailable'); assert.equal(calls, 3);
});

test('a failed real read invalidates a fresh valid share for thirty seconds without permanently removing it', async t => {
  let clock = 1000;
  const f = fixture(t, undefined, { now: () => clock });
  const entry = f.validator.inspect(resource()); await entry.promise;
  assert.equal(entry.status, 'valid');
  assert.equal(f.validator.invalidate(resource()), entry);
  assert.equal(entry.status, 'unavailable'); assert.equal(entry.pending, false);
  assert.equal(f.validator.inspect(resource()), entry); assert.equal(f.calls.length, 2);
  clock += 29_999; assert.equal(f.validator.inspect(resource()), entry);
  clock++;
  const retry = f.validator.inspect(resource()); await retry.promise;
  assert.equal(retry.status, 'valid'); assert.equal(f.calls.length, 4);
});

test('invalidation aborts pending checks and late videos cannot overwrite the unavailable result', async t => {
  let release, signal;
  const f = fixture(t, input => { signal = input.signal; return new Promise(resolve => { release = () => resolve(list([video()])); }); });
  const entry = f.validator.inspect(resource()), settled = entry.promise;
  await turn(); assert.equal(entry.pending, true);
  f.validator.invalidate(resource());
  assert.equal(signal.aborted, true); assert.equal(entry.pending, false);
  release(); await settled; await turn();
  assert.equal(entry.status, 'unavailable'); assert.equal(f.validator.inspect(resource()), entry);
  assert.equal(f.calls.length, 2);
});

test('queued invalidation cancels only that share and never sends its token request', async t => {
  let calls = 0;
  const f = fixture(t, undefined, { read: (_, input) => new Promise((_, reject) => {
    calls++; input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true });
  }) });
  f.validator.inspect(resource(1)); f.validator.inspect(resource(2));
  const queued = f.validator.inspect(resource(3)), settled = queued.promise;
  await turn(); f.validator.invalidate(resource(3)); await settled;
  assert.equal(queued.status, 'unavailable'); assert.equal(queued.pending, false); assert.equal(calls, 2);
  await f.validator.stop(); assert.equal(calls, 2);
});
