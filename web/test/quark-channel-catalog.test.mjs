import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuarkChannelCatalog } from '../lib/quark-channel-catalog.mjs';
import { DEFAULT_QUARK_TELEGRAM_CHANNELS } from '../lib/quark-telegram-search.mjs';

const SOURCE = 'https://raw.githubusercontent.com/fish2018/pansou/main/docker-compose.yml';
const KEY = 'quark.public.channel.catalog.v1', NOW = 1792000000000, DAY = 86400000;
const seeds = [...DEFAULT_QUARK_TELEGRAM_CHANNELS];
const yaml = names => 'services:\n  pansou:\n    environment:\n      - CHANNELS=' + names.join(',') + '\n';
const post = (name, link = true) => `<div class="tgme_widget_message_wrap"><div class="tgme_widget_message" data-post="${name}/123"><div class="tgme_widget_message_text">名称：测试电影 (2026)${link ? '<br><a href="https://pan.quark.cn/s/abcdef123456">夸克</a>' : ''}</div></div></div>`;
function memory(initial) {
  const rows = new Map(initial ? [[KEY, initial]] : []), writes = [];
  return { meta: key => rows.get(key), setMeta(key, value) { rows.set(key, value); writes.push(value); }, writes, rows };
}
function saved(entries, extra = {}) {
  return JSON.stringify({ version: 1, updated: NOW, refresh: NOW + DAY, cursor: 0, error: '',
    entries: entries.map(name => ({ name, active: true, checked: NOW, due: NOW, failures: 0, reason: '' })), ...extra });
}

test('catalogue starts with the verified seed list and does not need a service or credentials', async () => {
  const catalog = createQuarkChannelCatalog({ now: () => NOW });
  assert.deepEqual(await catalog.resolve(), seeds);
  assert.equal(catalog.status().active, seeds.length);
});

test('strict directory parsing rejects URLs, commands, duplicate assignments and excessive lists', async t => {
  const bad = [yaml(['https://attacker.invalid/evil']), yaml(['GoodName', '$(whoami)']), yaml(['GoodName', 'bad-name']),
    yaml(['GoodName', 'tiny']), yaml(['GoodName']) + '      - CHANNELS=https://attacker.invalid\n',
    yaml([]), 'services: {}', yaml(Array.from({ length: 129 }, (_, i) => 'Film' + String(i).padStart(3, '0')))];
  for (const [index, body] of bad.entries()) await t.test(String(index), async () => {
    const store = memory(), calls = [];
    const catalog = createQuarkChannelCatalog({ store, now: () => NOW });
    assert.deepEqual(await catalog.resolve({ read: async url => { calls.push(url); return body; } }), seeds);
    assert.deepEqual(calls, [SOURCE]);
    assert.equal(catalog.status().reason, 'directory-failed');
  });
});

test('directory final URL and byte limit are enforced before activating anything', async t => {
  for (const value of [{ html: yaml(['NewFilm']), url: 'https://attacker.invalid/file.yml' },
    { html: yaml(['NewFilm']), url: SOURCE + '?redirected=1' }, yaml(['NewFilm']) + 'x'.repeat(65536)]) {
    await t.test(typeof value === 'string' ? 'size' : value.url, async () => {
      const catalog = createQuarkChannelCatalog({ now: () => NOW });
      assert.deepEqual(await catalog.resolve({ read: async () => value }), seeds);
      assert.equal(catalog.status().reason, 'directory-failed');
    });
  }
});

test('only same-channel posts with actual Quark links activate, in batches of at most two', async () => {
  const store = memory(), calls = [];
  const read = async (url, duration, maxBytes, deadline, signal) => {
    calls.push(url);
    assert.ok(duration > 0 && duration <= 3000);
    assert.equal(deadline, NOW + 6000);
    assert.equal(signal, undefined);
    if (url === SOURCE) { assert.equal(maxBytes, 65536); return { html: yaml([...seeds, 'FilmNew1', 'filmnew1', 'AnimeNew2', 'OtherNew3']).replace(/\n/g, '\r\n'), url }; }
    assert.equal(maxBytes, 524288);
    const name = new URL(url).pathname.split('/').at(-1);
    return { html: name === 'OtherNew3' ? post('WrongOwner') : post(name), url };
  };
  const catalog = createQuarkChannelCatalog({ store, now: () => NOW });
  const first = await catalog.resolve({ read });
  assert.ok(first.includes('filmnew1') && first.includes('AnimeNew2'));
  assert.equal(first.filter(name => name.toLowerCase() === 'filmnew1').length, 1);
  assert.deepEqual(calls, [SOURCE, 'https://t.me/s/filmnew1', 'https://t.me/s/AnimeNew2']);
  const restarted = createQuarkChannelCatalog({ store, now: () => NOW });
  assert.ok(!(await restarted.resolve({ read })).includes('OtherNew3'));
  assert.equal(calls.at(-1), 'https://t.me/s/OtherNew3');
  assert.equal(calls.filter(url => url === SOURCE).length, 1);
  assert.equal(restarted.status().sources.find(row => row.channel === 'OtherNew3').reason, 'unreadable');
});

test('channel redirects and header-only or script links cannot activate a discovered channel', async () => {
  const catalog = createQuarkChannelCatalog({ now: () => NOW });
  const read = async url => url === SOURCE ? yaml(['Redirected', 'ScriptOnly', 'HeaderOnly'])
    : url.endsWith('Redirected') ? { html: post('Redirected'), url: 'https://elsewhere.invalid/s/Redirected' }
      : url.endsWith('ScriptOnly') ? post('ScriptOnly', false).replace('</div>', '<script>https://pan.quark.cn/s/abcdef123456</script></div>')
        : '<a href="https://pan.quark.cn/s/abcdef123456">Header</a>' + post('HeaderOnly', false);
  assert.deepEqual(await catalog.resolve({ read }), seeds);
  assert.deepEqual(await catalog.resolve({ read }), seeds);
});

test('known unrelated entries from the upstream list never become candidates or receive requests', async () => {
  const catalog = createQuarkChannelCatalog({ now: () => NOW }), calls = [];
  await catalog.resolve({ read: async url => { calls.push(url); return yaml(['dianyingshare', 'MCPH02', 'KaiPanshare', 'dzsgx']); } });
  assert.deepEqual(calls, [SOURCE]);
  assert.equal(catalog.status().candidates, seeds.length);
});

test('failed directory refresh preserves activated sources and is retried after a bounded delay', async () => {
  let clock = NOW;
  const store = memory(saved(['PriorFilm'], { refresh: NOW })), calls = [];
  const catalog = createQuarkChannelCatalog({ store, now: () => clock });
  const read = async url => { calls.push(url); if (url === SOURCE) throw Object.assign(new Error('limited'), { status: 429 }); return post('PriorFilm'); };
  assert.ok((await catalog.resolve({ read })).includes('PriorFilm'));
  assert.equal(catalog.status().reason, 'directory-failed');
  await catalog.resolve({ read });
  assert.equal(calls.filter(url => url === SOURCE).length, 1);
  clock += 300000;
  await catalog.resolve({ read });
  assert.equal(calls.filter(url => url === SOURCE).length, 2);
});

test('source failures temporarily avoid the channel and retry without treating an empty film query as health', async () => {
  let clock = NOW, healthy = false, reads = 0;
  const catalog = createQuarkChannelCatalog({ store: memory(saved(['PriorFilm'])), now: () => clock });
  const read = async url => {
    assert.equal(new URL(url).search, '');
    reads++;
    if (!healthy) throw Object.assign(new Error('limited'), { status: 429 });
    return post('PriorFilm');
  };
  assert.ok(!(await catalog.resolve({ read, keyword: 'not-a-match' })).includes('PriorFilm'));
  assert.equal(reads, 1);
  await catalog.resolve({ read, keyword: '' });
  assert.equal(reads, 1);
  clock += 300000; healthy = true;
  assert.ok((await catalog.resolve({ read, keyword: '' })).includes('PriorFilm'));
  assert.equal(reads, 2);
});

test('readable channels with no Quark links are deferred rather than permanently deleted', async () => {
  const store = memory(), catalog = createQuarkChannelCatalog({ store, now: () => NOW });
  const read = async url => url === SOURCE ? yaml(['MixedFilm']) : post('MixedFilm', false);
  assert.ok(!(await catalog.resolve({ read })).includes('MixedFilm'));
  const row = catalog.status().sources.find(row => row.channel === 'MixedFilm');
  assert.equal(row.reason, 'no-quark');
  assert.equal(row.nextCheckAt, NOW + DAY);
  assert.ok(JSON.parse(store.rows.get(KEY)).entries.some(row => row.name === 'MixedFilm' && !row.active && row.failures === 0));
});

test('an established mixed-cloud channel remains active when its readable homepage currently has only Aliyun posts', async () => {
  const store = memory(saved(['PriorFilm'])), catalog = createQuarkChannelCatalog({ store, now: () => NOW });
  const calls = [];
  const rows = await catalog.resolve({ read: async url => {
    calls.push(url);
    return post('PriorFilm', false).replace('</div>', '<br><a href="https://www.alipan.com/s/fictionalshare">阿里云盘</a></div>');
  } });
  assert.ok(rows.includes('PriorFilm'));
  assert.deepEqual(calls, ['https://t.me/s/PriorFilm']);
  const entry = JSON.parse(store.rows.get(KEY)).entries.find(row => row.name === 'PriorFilm');
  assert.equal(entry.active, true); assert.equal(entry.failures, 0);
  assert.equal(entry.reason, 'no-quark'); assert.equal(entry.due, NOW + DAY);
});

test('active channels receive periodic homepage health checks without querying any movie', async () => {
  const catalog = createQuarkChannelCatalog({ store: memory(saved(['PriorFilm'])), now: () => NOW });
  const calls = [];
  assert.ok((await catalog.resolve({ read: async url => { calls.push(url); return post('PriorFilm'); } })).includes('PriorFilm'));
  assert.deepEqual(calls, ['https://t.me/s/PriorFilm']);
  assert.equal(catalog.status().sources.find(row => row.channel === 'PriorFilm').nextCheckAt, NOW + DAY);
});

test('directory refresh is on demand and resumes its persisted scan instead of retesting the first candidates', async () => {
  let clock = NOW;
  const store = memory(), calls = [];
  const read = async url => { calls.push(url); return url === SOURCE ? yaml(['NewFilmA', 'NewFilmB', 'NewFilmC', 'NewFilmD']) : post(new URL(url).pathname.split('/').at(-1)); };
  await createQuarkChannelCatalog({ store, now: () => clock }).resolve({ read });
  await createQuarkChannelCatalog({ store, now: () => clock }).resolve({ read });
  assert.deepEqual(calls.filter(url => url !== SOURCE), ['NewFilmA', 'NewFilmB', 'NewFilmC', 'NewFilmD'].map(name => 'https://t.me/s/' + name));
  assert.equal(calls.filter(url => url === SOURCE).length, 1);
  clock += DAY;
  await createQuarkChannelCatalog({ store, now: () => clock }).resolve({ read });
  assert.equal(calls.filter(url => url === SOURCE).length, 2);
});

test('aborted work does not advance the pending channel cursor or enable unverified rows', async () => {
  const store = memory(), controller = new AbortController(), calls = [];
  const catalog = createQuarkChannelCatalog({ store, now: () => NOW });
  await assert.rejects(catalog.resolve({ signal: controller.signal, read: async url => {
    calls.push(url);
    if (url === SOURCE) return yaml(['NewFilmA', 'NewFilmB']);
    controller.abort(); return post('NewFilmA');
  } }), { name: 'AbortError' });
  assert.equal(catalog.status().active, seeds.length);
  const resumed = [];
  await createQuarkChannelCatalog({ store, now: () => NOW }).resolve({ read: async url => { resumed.push(url); return post(new URL(url).pathname.split('/').at(-1)); } });
  assert.deepEqual(resumed, ['https://t.me/s/NewFilmA', 'https://t.me/s/NewFilmB']);
});

test('expired deadlines and already aborted signals perform no reads or persistence', async () => {
  const store = memory(), catalog = createQuarkChannelCatalog({ store, now: () => NOW }), controller = new AbortController();
  let calls = 0;
  const read = async () => { calls++; return ''; };
  assert.deepEqual(await catalog.resolve({ read, deadline: NOW }), seeds);
  controller.abort();
  await assert.rejects(catalog.resolve({ read, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 0); assert.equal(store.writes.length, 0);
});

test('results arriving beyond the shared deadline are not enabled', async () => {
  let clock = NOW;
  const catalog = createQuarkChannelCatalog({ now: () => clock });
  const rows = await catalog.resolve({ deadline: NOW + 100, read: async url => {
    if (url === SOURCE) return yaml(['TooLateFilm']);
    clock += 101; return post('TooLateFilm');
  } });
  assert.ok(!rows.includes('TooLateFilm'));
  assert.equal(catalog.status().sources.find(row => row.channel === 'TooLateFilm').nextCheckAt, 0);
});

test('parallel resolution shares ongoing work and never duplicates source or homepage probes', async () => {
  const catalog = createQuarkChannelCatalog({ now: () => NOW });
  let finish, calls = 0;
  const first = catalog.resolve({ read: async url => { calls++; if (url === SOURCE) return new Promise(resolve => { finish = resolve; }); return post('NewFilmA'); } });
  assert.deepEqual(await catalog.resolve({ read: async () => { throw new Error('duplicate request'); } }), seeds);
  finish(yaml(['NewFilmA']));
  assert.ok((await first).includes('NewFilmA'));
  assert.equal(calls, 2);
});

test('metadata remains bounded and invalid snapshots retain the verified seed fallback', async () => {
  const store = memory(), catalog = createQuarkChannelCatalog({ store, now: () => NOW });
  await catalog.resolve({ read: async url => url === SOURCE ? yaml(Array.from({ length: 128 }, (_, i) => 'Film' + String(i).padStart(3, '0'))) : post(new URL(url).pathname.split('/').at(-1)) });
  assert.ok(catalog.status().candidates <= 128);
  assert.ok(Buffer.byteLength(store.rows.get(KEY)) <= 65536);
  for (const text of ['not-json', 'x'.repeat(65537), saved(Array.from({ length: 129 }, (_, i) => 'Film' + String(i).padStart(3, '0'))), saved(['Invalid/URL'])]) {
    const invalid = createQuarkChannelCatalog({ store: memory(text), now: () => NOW });
    assert.deepEqual(await invalid.resolve(), seeds);
    assert.equal(invalid.status().reason, 'metadata-invalid');
  }
});

test('persistence and store access errors are not swallowed as source failures', async () => {
  const failure = new Error('store unavailable');
  assert.throws(() => createQuarkChannelCatalog({ store: { meta() { throw failure; } } }), error => error === failure);
  const catalog = createQuarkChannelCatalog({ now: () => NOW, store: { meta() {}, setMeta() { throw failure; } } });
  await assert.rejects(catalog.resolve({ read: async () => yaml(seeds) }), error => error === failure);
});
