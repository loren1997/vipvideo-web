import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';
import { parsePlaylist } from '../lib/live.mjs';

// 用浏览器可解码的静音 WAV 验证媒体事件，HLS 转发与真实 URL 解析由模块测试覆盖。
function silentMedia(seconds = 30) {
  const samples = seconds * 8000;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  return bytes;
}

const key = JSON.stringify(['星海旅途', '2025', 'series']);
const summary = { key, title: '星海旅途', year: '2025', type: 'series', category: 'tv', typeName: '国产剧', remarks: '更新至2集', poster: '' };
const items = [{ ...summary, source: 'first', id: '1' }, { ...summary, source: 'second', id: '2' }];
function fixture(title, type, id, typeName, remarks = '正片', sources = ['first', 'second']) {
  const value = { key: JSON.stringify([title, '2025', type]), title, year: '2025', type, category: typeName.includes('动漫') ? 'anime' : type === 'series' ? 'tv' : 'movie', typeName, remarks, poster: '' };
  return { ...value, items: sources.map(source => ({ ...value, source, id })) };
}
const movie = fixture('海风来信', 'movie', 'movie', '剧情片');
movie.douban = { id: 'fixture-subject', score: 7.7, votes: 123 }; movie.items.forEach(item => { item.douban = movie.douban; });
const moviePage2 = fixture('晴天笔记', 'movie', 'movie-page2', '喜剧片');
const anime = fixture('动画旅人', 'series', 'anime', '国产动漫', '全2集');
const variety = fixture('周末栏目样例', 'series', 'variety', '综艺', '更新至2期');
variety.category = 'variety'; variety.items.forEach(item => { item.category = 'variety'; });
const broken = fixture('故障换源', 'series', 'broken', '国产剧', '全2集');
const badDetail = fixture('详情重试', 'movie', 'bad-detail', '剧情片');
const doomed = fixture('有限重试', 'series', 'doomed', '国产剧', '全2集', ['first', 'second', 'third', 'fourth']);
const slow = fixture('慢响应', 'series', 'slow', '国产剧', '全2集');
const hlsPriority = fixture('HLS选择样例', 'series', 'hls-priority', '国产剧', '全2集');
const controlsFilm = fixture('播放器样例', 'series', 'controls', '国产剧', '全2集');
const verifiedFilm = fixture('可播放验证样例', 'series', 'verified', '国产剧', '全2集', ['first', 'second', 'third']);
const adult = fixture('限制级样例', 'movie', 'adult', '限制级', '样例');
adult.category = 'adult'; adult.items.forEach(item => { item.category = 'adult'; });
const categoryBoundary = fixture('分类边界样例', 'movie', 'category-normal', '剧情片', '样例');
const categoryAdult = { ...categoryBoundary.items[0], source: 'third', id: 'category-adult', category: 'adult', typeName: '限制级' };
const mixedCategory = { ...categoryBoundary, category: 'adult', typeName: '限制级', items: [...categoryBoundary.items, categoryAdult] };
const groups = [{ ...summary, items }, movie, moviePage2, anime, variety, broken, badDetail, doomed, slow, hlsPriority, controlsFilm, verifiedFilm, adult, mixedCategory];
let delayAdultDetail = false;
const catalogRequests = [];
const maintenance = { probeCount: 0, updateCount: 0, discoverCount: 0, statusReads: 0, checkedAt: 0, updatedAt: 0 };
const liveRequests = [];
let liveFailures = [];
const liveReports = [], danmakuRequests = [], playerRequests = [];
const playabilityRequests = [], playabilityReports = [], playableResults = new Map();
let probeActive = 0, probeMax = 0, holdVerifiedProbe = false, releaseVerifiedProbes = [];
const preferences = new Map(), bindings = new Map(), comments = new Map();
const episodeKey = (film, episode) => JSON.stringify([film, episode]);
function fixtureEpisode(value) {
  if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim())) value = Number(value.trim());
  if (typeof value === 'string' && value.trim() && value.length <= 500 && !/[\u0000-\u001f]/.test(value)) return value.trim();
  return Number.isInteger(value) && value >= 0 && value <= 10000 ? value : null;
}
comments.set(episodeKey(controlsFilm.key, '第1集'), [
  { id: 'family-seed', time: 2, text: '家庭样例', color: '#ffffff', origin: 'family' },
  ...Array.from({ length: 16 }, (_value, index) => ({ id: `family-cap-${index}`, time: 8, text: `同屏样例 ${index}`, color: '#ffffff', origin: 'family' })),
]);
let holdMovieRatings = false, releaseMovieRatings;
let fixtureImportWarnings = false;
const savedConfigBodies = [];
const channels = [
  { id: 'test-tv-one', name: '测试电视一', group: '测试频道', streams: [
    { name: '故障线路', type: 'hls', status: 'error', url: 'https://fixtures.example/fail-live.m3u8?token=fixture' },
    { name: '测试直连', type: 'mp4', status: 'ok', url: 'https://fixtures.example/live-second.mp4?token=fixture' },
    { name: '备用测试线路', type: 'mp4', status: 'ok', url: 'https://fixtures.example/live-third.mp4?token=fixture' },
    { name: '未知测试线路', type: 'mp4', status: 'unknown', url: 'https://fixtures.example/live-unknown.mp4?token=fixture' },
  ] },
  { id: 'test-tv-two', name: '测试电视二', group: '测试频道', streams: [{ name: '测试直连', type: 'mp4', status: 'ok', url: 'https://fixtures.example/live-two.mp4?token=fixture' }] },
  { id: 'test-tv-unknown', name: '未验证电视样例', group: '测试频道', streams: [{ name: '未知线路', type: 'hls', status: 'unknown', url: 'https://fixtures.example/live-unknown.m3u8' }] },
];
const catalog = {
  async search(config, query) {
    return { groups: config.sources.length ? groups.filter(group => group.title.includes(query) && (config.showAdult === true || group.category !== 'adult')) : [], failedSources: [] };
  },
  async browse(config, { category, page, source }) {
    catalogRequests.push({ kind: 'browse', category, page: Number(page), source });
    if (source === 'fourth') throw Object.assign(new Error('固定分类接口故障'), { status: 502 });
    if (category === 'adult' && config.showAdult !== true) throw Object.assign(new Error('三级内容已隐藏，请先在设置中开启显示。'), { status: 403 });
    const list = category === 'adult' ? [adult] : category === 'movie' ? Number(page) === 1 ? [movie, badDetail, ...(config.showAdult === true ? [categoryBoundary] : [])] : [moviePage2, movie] : category === 'anime' ? [anime] : category === 'variety' ? [variety] : [{ ...summary, items }, broken, doomed, slow, controlsFilm, verifiedFilm];
    return { category, page: Number(page), groups: list.map(group => ({ ...group, items: group.items.filter(item => (!source || item.source === source) && config.sources.some(row => row.id === item.source)) })).filter(group => group.items.length), failedSources: category === 'anime' ? [{ source: 'third', name: '第三源', error: '固定测试超时' }] : [], hasMore: category === 'movie' && Number(page) === 1 };
  },
  async detail(config, source, id) {
    catalogRequests.push({ kind: 'detail', source, id });
    assert.ok(config.sources.some(row => row.id === source));
    if (id === 'bad-detail' && source === 'first') throw Object.assign(new Error('详情坏地址'), { status: 502 });
    if (id === 'category-normal' && source === 'first') throw Object.assign(new Error('分类边界固定详情故障'), { status: 502 });
    if (id === 'slow') await new Promise(ok => setTimeout(ok, 350));
    if (id === 'adult' && config.showAdult !== true) throw Object.assign(new Error('三级内容已隐藏，请先在设置中开启显示。'), { status: 403 });
    if (id === 'adult' && delayAdultDetail) await new Promise(ok => setTimeout(ok, 700));
    const metadata = id === 'category-normal' || id === 'category-adult' ? { ...categoryBoundary, category: 'adult', typeName: '限制级' } : groups.find(group => group.items.some(item => item.source === source && item.id === id)) || { ...summary, items };
    const failed = id === 'doomed' || ['broken', 'hls-priority'].includes(id) && source === 'first';
    const numbers = ['broken', 'controls'].includes(id) && source === 'second' ? [2, 1] : [1, 2];
    return { ...metadata, source, id, description: '固定浏览器测试影片。', lines: [
      { name: '原始网页', episodes: [1, 2].map(number => ({ name: `第${number}集`, type: 'page', url: `https://video.example/watch/${id}-${number}` })) },
      { name: '直连', episodes: numbers.map(number => ({ name: `第${number}集`, type: failed ? 'hls' : 'mp4', url: `https://fixtures.example/${failed ? 'fail-' : ''}${id}-${source}-${number}.${failed ? 'm3u8' : 'mp4'}?token=fixture` })) },
      { name: '备用', episodes: numbers.map(number => ({ name: `第${number}集`, type: failed ? 'hls' : 'mp4', url: `https://fixtures.example/${failed ? 'fail-' : ''}${id}-${source}-alt-${number}.${failed ? 'm3u8' : 'mp4'}?token=fixture` })) },
    ] };
  },
};

async function until(check, label, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await new Promise(ok => setTimeout(ok, 100)); }
  throw new Error(`等待失败：${label}`);
}

const directory = await mkdtemp(join(tmpdir(), 'vipvideo-browser-'));
const output = resolve('test-results');
await mkdir(output, { recursive: true });
const defaults = JSON.parse(readFileSync(fileURLToPath(new URL('../defaults.json', import.meta.url)), 'utf8'));
const app = createApp({ password: 'browser-test-password', dataDir: directory, catalog, initialConfig: { ...defaults, sources: [], parsers: [], subscriptions: [], liveSources: [], showAdult: false } });
await new Promise(ok => app.server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${app.server.address().port}`;
const candidates = [process.env.BROWSER_EXECUTABLE, chromium.executablePath(),
  'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'];
const executablePath = candidates.find(value => value && existsSync(value));
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath, args: ['--mute-audio', '--noerrdialogs'] });
  const errors = [];
  const network = [];
  const media = silentMedia();
  async function context(viewport, nativeMedia = true, realServices = false) {
    const value = await browser.newContext({ viewport });
    await value.route('**/*', async route => {
      const url = route.request().url();
      const parsed = new URL(url);
      if (realServices && parsed.origin === base && ['/api/player/preferences', '/api/danmaku', '/api/danmaku/binding'].includes(parsed.pathname)) return route.continue();
      if (parsed.origin === base && parsed.pathname === '/api/config' && route.request().method() === 'PUT') savedConfigBodies.push(route.request().postDataJSON());
      if (fixtureImportWarnings && parsed.origin === base && parsed.pathname === '/api/config/import') {
        fixtureImportWarnings = false;
        const response = await route.fetch();
        return route.fulfill({ response, json: { ...await response.json(), importWarnings: ['不支持的蜘蛛源样例已跳过。', '文字提示 <img src=x onerror=alert(1)>'] } });
      }
      if (url.startsWith(base + '/api/playback?')) playerRequests.push(url);
      if (parsed.origin === base && parsed.pathname === '/api/playability/report') {
        const body = route.request().postDataJSON(); playabilityReports.push(body);
        playableResults.set(JSON.stringify([body.source, body.id, body.line, body.episode]), body.status === 'ok');
        return route.fulfill({ json: { playable: body.status === 'ok', checkedAt: Date.now() } });
      }
      if (parsed.origin === base && parsed.pathname === '/api/playability') {
        const value = Object.fromEntries(parsed.searchParams); value.line = Number(value.line); value.episode = Number(value.episode);
        playabilityRequests.push(value); probeActive++; probeMax = Math.max(probeMax, probeActive);
        try {
          if (value.id === 'verified') { if (holdVerifiedProbe) await new Promise(ok => releaseVerifiedProbes.push(ok)); await new Promise(ok => setTimeout(ok, 40)); }
          const saved = playableResults.get(JSON.stringify([value.source, value.id, value.line, value.episode]));
          const playable = saved ?? (value.line > 0 && !(value.id === 'verified' && (value.source === 'third' || value.source === 'first' && value.line === 1)));
          return route.fulfill({ json: { playable, checkedAt: Date.now(), ...(!playable ? { error: '固定片段验证失败' } : {}) } });
        } finally { probeActive--; }
      }
      if (url.includes('/api/media?') || url.startsWith('https://fixtures.example/')) network.push(url);
      if (url === base + '/api/config/presets') return route.fulfill({ json: { api_site: {
        first: { name: '第一源', api: 'https://api.example.com/first' }, second: { name: '第二源', api: 'https://api.example.com/second' },
      } } });
      if (url.startsWith(base + '/api/sources/')) {
        const action = parsed.pathname.split('/').at(-1);
        if (action === 'probe') { maintenance.probeCount++; maintenance.checkedAt = Date.now(); }
        else if (action === 'update') {
          maintenance.updateCount++; maintenance.updatedAt = Date.now();
          const latest = app.store.config(); app.store.setConfig({ ...latest, sources: [...latest.sources.filter(item => item.id !== 'subscription-imported'), { id: 'subscription-imported', name: '订阅导入源', api: 'https://api.example.com/subscription', enabled: true }] });
        } else if (action === 'discover') {
          maintenance.discoverCount++;
          const latest = app.store.config();
          app.store.setConfig({ ...latest, subscriptions: [...latest.subscriptions, { id: 'discovered-fixture', name: '新发现订阅样例', url: 'https://subscriptions.example/discovered.json', enabled: true }] });
        } else maintenance.statusReads++;
        const latest = app.store.config();
        return route.fulfill({ json: { running: false, lastProbe: maintenance.checkedAt, lastUpdate: maintenance.updatedAt,
          sources: latest.sources.map(item => ({ ...item, status: item.enabled === false ? 'disabled' : maintenance.checkedAt ? item.id === 'third' ? 'error' : 'ok' : 'unknown', latencyMs: maintenance.checkedAt ? 35 : null, checkedAt: maintenance.checkedAt, error: maintenance.checkedAt && item.id === 'third' ? '固定检测失败' : '' })),
          subscriptions: (latest.subscriptions || []).map(item => ({ ...item, status: item.enabled === false ? 'disabled' : maintenance.updatedAt ? 'ok' : 'unknown', checkedAt: maintenance.updatedAt, lastUpdate: maintenance.updatedAt, error: '' })),
          liveSources: (latest.liveSources || []).map(item => ({ ...item, status: item.enabled === false ? 'disabled' : maintenance.checkedAt ? 'ok' : 'unknown', latencyMs: 12, checkedAt: maintenance.checkedAt, error: '' })),
          discovery: { running: false, lastDiscovery: maintenance.discoverCount ? Date.now() : null, candidates: maintenance.discoverCount ? [{ name: '新发现订阅样例', url: 'https://subscriptions.example/discovered.json', status: 'ok', added: true }] : [] },
        } });
      }
      if (parsed.origin === base && parsed.pathname === '/api/player/preferences') {
        const body = route.request().method() === 'PUT' ? route.request().postDataJSON() : null;
        if (body) preferences.set(body.key, { introSeconds: body.introSeconds, outroSeconds: body.outroSeconds, speed: body.speed, autoNext: body.autoNext, danmakuEnabled: body.danmakuEnabled });
        return route.fulfill({ json: preferences.get(body?.key || parsed.searchParams.get('key')) || { introSeconds: 0, outroSeconds: 0, speed: 1, autoNext: true, danmakuEnabled: true } });
      }
      if (parsed.origin === base && parsed.pathname === '/api/danmaku/binding') {
        const body = route.request().method() === 'PUT' ? route.request().postDataJSON() : null;
        const episode = fixtureEpisode(body ? body.episode : parsed.searchParams.get('episode'));
        if (episode === null) return route.fulfill({ status: 400, json: { error: '请选择有效的影片和剧集' } });
        const key = episodeKey(body?.key || parsed.searchParams.get('key'), episode);
        if (body) bindings.set(key, { url: body.url, offset: body.offset });
        return route.fulfill({ json: bindings.get(key) || { url: '', offset: 0 } });
      }
      if (parsed.origin === base && parsed.pathname === '/api/danmaku') {
        const body = route.request().method() === 'POST' ? route.request().postDataJSON() : null;
        const episode = fixtureEpisode(body ? body.episode : parsed.searchParams.get('episode'));
        if (episode === null) return route.fulfill({ status: 400, json: { error: '请选择有效的影片和剧集' } });
        const key = episodeKey(body?.key || parsed.searchParams.get('key'), episode);
        danmakuRequests.push({ method: route.request().method(), key });
        const list = comments.get(key) || [];
        if (body) { const comment = { id: `family-${danmakuRequests.length}`, time: body.time, text: body.text, color: '#fff', origin: 'family' }; comments.set(key, [...list, comment]); return route.fulfill({ json: comment }); }
        const binding = bindings.get(key);
        return route.fulfill({ json: { comments: [...list, ...(binding?.url ? [{ id: 'bilibili-seed', time: Math.max(0, 6 + binding.offset), text: '外部样例 <img src=x onerror=alert(1)>', color: '#fff', origin: 'bilibili' }] : [])], updated: Date.now(), errors: [] } });
      }
      if (parsed.origin === base && parsed.pathname === '/api/ratings') {
        if (holdMovieRatings && parsed.searchParams.get('id') === 'movie') await new Promise(ok => { releaseMovieRatings = ok; });
        const douban = parsed.searchParams.get('id') === 'movie' ? { score: 7.7, votes: 123, url: 'https://movie.douban.com/subject/fixture-subject/', attribution: '豆瓣评分由影视源提供，可能存在更新延迟。' } : null;
        return route.fulfill({ json: { douban, errors: [] } });
      }
      if (parsed.origin === base && ['/api/live', '/api/live/probe'].includes(parsed.pathname)) {
        liveRequests.push(url); return route.fulfill({ json: { channels: (app.store.config().liveSources || []).some(item => item.enabled !== false) ? channels : [], failedSources: liveFailures } });
      }
      if (parsed.origin === base && parsed.pathname === '/api/live/playback') {
        liveRequests.push(url);
        const channel = channels.find(item => item.id === parsed.searchParams.get('id')); const stream = channel?.streams[Number(parsed.searchParams.get('line'))];
        if (channel?.id === 'test-tv-two') await new Promise(ok => setTimeout(ok, 350));
        return route.fulfill({ json: { ...stream, proxyUrl: base + '/api/media?token=live-fixture' } });
      }
      if (parsed.origin === base && parsed.pathname === '/api/live/report') { liveReports.push(route.request().postDataJSON()); return route.fulfill({ json: { ok: true } }); }
      if (url.startsWith(base + '/api/media?')) return route.fulfill({ status: 404, body: 'fixture failed proxy' });
      if (url.startsWith(base + '/')) return route.continue();
      if (url.startsWith('https://fixtures.example/fail-')) return route.fulfill({ status: 404, body: 'fixture failed media', headers: { 'Access-Control-Allow-Origin': '*' } });
      if (url.startsWith('https://fixtures.example/')) return route.fulfill({ status: 200, contentType: 'audio/wav', body: media,
        headers: { 'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'bytes' } });
      return route.abort();
    });
    const page = await value.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    // WAV只验证原生媒体事件，不冒充可被Hls.js解码的MPEG-TS。
    if (nativeMedia) await page.evaluate(() => { window.Hls.isSupported = () => false; });
    await page.locator('#password').fill('browser-test-password');
    await page.locator('#login-form button').click();
    await page.locator('#app-view').waitFor({ state: 'visible' });
    return { value, page };
  }
  const { page } = await context({ width: 1440, height: 1000 });
  await page.locator('.notice').filter({ hasText: '还没有影视源' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '三级', exact: true }).count(), 0, '默认隐藏三级分类');
  await page.screenshot({ path: join(output, 'desktop-home.png'), fullPage: true });
  console.log('PASS 桌面登录与初始空配置');

  await page.locator('nav a[href="#settings"]').click();
  await page.locator('textarea[aria-label="配置 JSON"]').fill(JSON.stringify({ api_site: {
    first: { name: '第一源', api: 'https://api.example.com/first' }, second: { name: '第二源', api: 'https://api.example.com/second' },
    third: { name: '第三源', api: 'https://api.example.com/third' }, fourth: { name: '第四源', api: 'https://api.example.com/fourth' },
  } }));
  const jsonInput = page.locator('textarea[aria-label="配置 JSON"]');
  await jsonInput.fill('\uFEFF```json\n' + await jsonInput.inputValue() + '\n```');
  fixtureImportWarnings = true;
  await page.getByRole('button', { name: '校验并导入', exact: true }).click();
  await until(() => app.store.config().sources.length === 4, '配置导入');
  await page.locator('.import-warnings').getByText('不支持的蜘蛛源样例已跳过。', { exact: true }).waitFor();
  assert.match(await page.locator('.import-warnings').textContent(), /2 条/);
  assert.equal(await page.locator('.import-warnings img').count(), 0, '导入提示只显示纯文字');
  await page.getByRole('button', { name: '保存全部设置', exact: true }).click();
  await until(() => savedConfigBodies.length > 0, '保存导入后的配置');
  assert.equal(Object.hasOwn(savedConfigBodies.at(-1), 'importWarnings'), false, '导入提示不混入持久配置');
  console.log('PASS 导入警告数量/文本回显、textContent防注入、警告不写入配置');
  await page.getByRole('button', { name: '添加内置影视源', exact: true }).click();
  await until(() => page.locator('#toast').textContent().then(text => text.includes('内置影视源已添加')), '添加内置源反馈');
  assert.equal(await page.locator('.import-warnings').count(), 0, '无警告的新导入清除上次提示');
  assert.equal(app.store.config().sources.length, 4, '添加内置源应按标识合并，保留其它自定义源');
  await page.getByLabel('影视源 1 地址', { exact: true }).fill('api.example.com/first?tag=1&amp;x=2');
  await page.getByRole('button', { name: '保存全部设置', exact: true }).click();
  await until(() => app.store.config().sources[0].api === 'https://api.example.com/first?tag=1&x=2', '服务端修复无协议地址及HTML参数转义');
  await until(() => page.getByLabel('影视源 1 地址', { exact: true }).inputValue().then(value => value === 'https://api.example.com/first?tag=1&x=2'), '修复地址回填设置表单');
  await page.getByLabel('影视源 1 地址', { exact: true }).fill('http://127.0.0.1:3000/api.php');
  const privateSave = page.waitForResponse(response => response.url() === base + '/api/config' && response.request().method() === 'PUT');
  await page.getByRole('button', { name: '保存全部设置', exact: true }).click();
  assert.ok([400, 403].includes((await privateSave).status()), '私网地址经实际后端拒绝');
  assert.equal(app.store.config().sources[0].api, 'https://api.example.com/first?tag=1&x=2');
  await page.getByLabel('影视源 1 地址', { exact: true }).fill('javascript:alert(1)');
  const unsafeSave = page.waitForResponse(response => response.url() === base + '/api/config' && response.request().method() === 'PUT');
  await page.getByRole('button', { name: '保存全部设置', exact: true }).click();
  assert.ok([400, 403].includes((await unsafeSave).status()), '不安全协议仍拒绝');
  await page.locator('#toast.error').waitFor({ state: 'visible' });
  assert.equal(app.store.config().sources[0].api, 'https://api.example.com/first?tag=1&x=2');
  await page.getByLabel('影视源 1 地址', { exact: true }).fill('https://api.example.com/first');
  await page.getByRole('button', { name: '保存全部设置', exact: true }).click();
  await until(() => app.store.config().sources[0].api === 'https://api.example.com/first', '恢复样例影视源地址');
  await page.locator('textarea[aria-label="配置 JSON"]').fill('{"api_site":');
  await page.getByRole('button', { name: '校验并导入', exact: true }).click();
  await until(() => page.locator('#toast').textContent().then(text => text.includes('导入失败')), '无效JSON仍拒绝');
  assert.equal(app.store.config().sources.length, 4, '无效格式不覆盖原配置');
  console.log('PASS 原始文本由实际后端修复BOM/代码块JSON与无协议/HTML参数地址，私网/不安全协议/坏JSON仍拒绝');
  await page.locator('nav a[href="#home"]').click();
  await page.getByRole('button', { name: '播放 海风来信', exact: true }).waitFor();
  assert.equal(await page.locator('#browse-results .media-card').count(), 2);
  assert.match(await page.locator('#browse-results').textContent(), /剧情片/);
  assert.match(await page.locator('#browse-results').textContent(), /正片/);
  await page.getByRole('button', { name: '加载更多', exact: true }).click();
  await page.getByRole('button', { name: '播放 晴天笔记', exact: true }).waitFor();
  assert.equal(await page.locator('#browse-results .media-card').count(), 3, '分页应按片key去重');
  assert.equal(await page.getByLabel('浏览影视源', { exact: true }).locator('option[value="third"]').count(), 0, '尚无成功API结果的源不显示');
  assert.equal(await page.getByLabel('浏览影视源', { exact: true }).locator('option[value="fourth"]').count(), 0);
  await page.evaluate(() => { location.hash = '#home?category=movie&source=third'; });
  await page.getByRole('heading', { name: '这个分类暂时没有影片', exact: true }).waitFor();
  await page.evaluate(() => { location.hash = '#home?category=movie&source=fourth'; });
  await page.getByRole('heading', { name: '分类内容暂时不可用', exact: true }).waitFor();
  await page.getByLabel('浏览影视源', { exact: true }).selectOption('second');
  await until(() => catalogRequests.some(row => row.kind === 'browse' && row.source === 'second'), '手动选择浏览源');
  await page.getByRole('button', { name: '播放 海风来信', exact: true }).click();
  await until(() => page.locator('video').evaluate(video => video.readyState >= 1).catch(() => false), '卡片自动选择直连播放');
  assert.equal(await page.locator('iframe').count(), 0, '有MP4线路时优先直连而非原始网页');
  await page.locator('nav a[href="#home"]').click();
  await page.getByRole('button', { name: '动漫', exact: true }).click();
  await page.getByRole('button', { name: '播放 动画旅人', exact: true }).waitFor();
  assert.equal(await page.locator('#browse-results .media-card').count(), 1);
  assert.match(await page.locator('#browse-results .failure-list').textContent(), /固定测试超时/);
  await page.getByRole('button', { name: '电视剧', exact: true }).click();
  await page.getByRole('button', { name: '播放 星海旅途', exact: true }).waitFor();
  await page.screenshot({ path: join(output, 'desktop-categories.png'), fullPage: true });
  await page.getByRole('button', { name: '播放 星海旅途', exact: true }).click();
  await until(() => page.locator('video').evaluate(video => video.readyState >= 1).catch(() => false), '电视剧分类自动播放');
  console.log('PASS 分类海报、元数据、分页去重、选择来源、点击自动优先直连');

  await page.locator('nav a[href="#search"]').click();
  await page.locator('input[aria-label="影片名称"]').fill('星海');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await page.getByRole('button', { name: '播放 星海旅途', exact: true }).click();
  await page.locator('.detail-summary h2').waitFor();
  await page.getByRole('button', { name: '☆ 收藏', exact: true }).click();
  await until(() => app.store.list('favorites').length === 1, '收藏保存');
  console.log('PASS 源导入、聚合搜索、详情与收藏');

  await page.locator('video').waitFor();
  await until(() => page.locator('video').evaluate(video => video.readyState >= 1), '原生媒体解码');
  await page.locator('video').evaluate(video => { video.muted = true; video.currentTime = 8; video.pause(); });
  await until(() => app.store.list('history')[0]?.position >= 7.5, '暂停进度同步');
  await page.locator('select[aria-label="播放速度"]').selectOption('1.5');
  assert.equal(await page.locator('video').evaluate(video => video.playbackRate), 1.5);
  await page.getByRole('button', { name: '下一集 →', exact: true }).click();
  await until(() => app.store.list('history')[0]?.episode === 1, '下一集');
  await until(() => page.locator('video').evaluate(video => video.readyState >= 1), '第二集解码');
  await page.locator('video').evaluate(video => { video.currentTime = 12; video.pause(); });
  await until(() => app.store.list('history')[0]?.position >= 11.5, '第二集进度');
  await page.locator('#source-row').getByRole('button', { name: '第二源', exact: true }).click();
  await until(() => page.locator('video').evaluate(video => video.readyState >= 1 && video.currentTime >= 11), '换源保留进度');
  await until(() => app.store.list('history')[0]?.position >= 20, '每十秒自动保存', 13000);
  await page.locator('video').evaluate(video => video.pause());
  await until(() => app.store.list('history')[0]?.source === 'second', '换源记录');
  await page.screenshot({ path: join(output, 'desktop-player.png'), fullPage: true });
  console.log('PASS 选集、播放事件、倍速、下一集、换源续播');

  const mobile = await context({ width: 390, height: 844 });
  await mobile.page.locator('nav a[href="#favorites"]').click();
  await mobile.page.getByRole('button', { name: '播放 星海旅途', exact: true }).waitFor();
  await mobile.page.locator('nav a[href="#home"]').click();
  await mobile.page.locator('#browse-results').getByRole('button', { name: '播放 海风来信', exact: true }).waitFor();
  const overflow = await mobile.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `手机页面横向溢出 ${overflow}px`);
  await mobile.page.screenshot({ path: join(output, 'mobile-home.png'), fullPage: true });
  await mobile.page.getByRole('button', { name: '继续观看 星海旅途', exact: true }).click();
  await until(() => mobile.page.locator('video').evaluate(video => video.readyState >= 1 && video.currentTime >= 11).catch(() => false), '另一设备自动续播');
  await mobile.page.locator('video').evaluate(video => video.pause());
  await mobile.page.locator('nav a[href="#history"]').click();
  await until(() => mobile.page.locator('#content').getByRole('button', { name: /清空/ }).count(), '观看记录页');
  console.log('PASS 手机布局、跨会话收藏和进度同步');

  await page.request.post(base + '/api/history', { data: { ...broken.items[0], line: 1, episode: 0, position: 9, duration: 30, url: 'https://fixtures.example/fail-broken-first-1.m3u8?token=fixture', mode: 'direct' } });
  await page.locator('nav a[href="#home"]').click();
  await page.getByRole('button', { name: '电视剧', exact: true }).click();
  const fallbackNetworkStart = network.length;
  await page.locator('#browse-results').getByRole('button', { name: '播放 故障换源', exact: true }).click();
  await until(() => page.locator('video').evaluate(video => video.readyState >= 1 && video.currentTime >= 8.5 && video.currentSrc.includes('broken-second-1')).catch(() => false), 'HLS失败经代理再换源续播', 20000);
  await page.locator('video').evaluate(video => video.pause());
  await until(() => app.store.list('history').find(row => row.key === broken.key)?.source === 'second', '自动换源保存');
  const recovered = app.store.list('history').find(row => row.key === broken.key);
  assert.equal(recovered.episode, 1, '换源优先按剧集名匹配，不能错误复用序号');
  assert.ok(recovered.position >= 8.5, '自动换源应保留进度');
  const fallbackNetwork = network.slice(fallbackNetworkStart);
  const proxyIndex = fallbackNetwork.findIndex(url => url.includes('/api/media?'));
  const recoveredIndex = fallbackNetwork.findIndex(url => url.includes('broken-second-1.mp4'));
  assert.ok(proxyIndex >= 0 && recoveredIndex > proxyIndex, '失败直链必须先经已有签名代理再换源');
  assert.equal(fallbackNetwork.filter(url => url.includes('/api/media?')).length, 1, '代理自动尝试一次');
  console.log('PASS HLS故障→签名代理→其他源，按集名换序并保留进度');

  await page.locator('nav a[href="#home"]').click();
  await page.locator('#browse-results').getByRole('button', { name: '播放 详情重试', exact: true }).click();
  await until(() => page.locator('video').evaluate(video => video.readyState >= 1 && video.currentSrc.includes('bad-detail-second')).catch(() => false), '详情失败自动尝试其他源');
  await page.locator('video').evaluate(video => video.pause());
  await page.locator('nav a[href="#home"]').click();
  await page.getByRole('button', { name: '电视剧', exact: true }).click();
  await page.locator('#browse-results').getByRole('button', { name: '播放 有限重试', exact: true }).click();
  await until(() => page.locator('.player-note').textContent().then(text => text.includes('自动尝试已结束')).catch(() => false), '失败源有限自动重试', 20000);
  await page.waitForTimeout(350);
  const attempted = new Set(playerRequests.filter(url => new URL(url).searchParams.get('id') === 'doomed').map(url => new URL(url).searchParams.get('source')));
  assert.deepEqual([...attempted], ['first', 'second', 'third'], '每轮自动最多三个源，每个源一次');
  await page.locator('#source-row').getByRole('button', { name: '第四源', exact: true }).waitFor();
  console.log('PASS 详情接口失败换源、最多三个源自动尝试后保留手动操作');

  await page.locator('nav a[href="#home"]').click();
  await page.getByRole('button', { name: '电视剧', exact: true }).click();
  holdVerifiedProbe = true;
  await page.locator('#browse-results').getByRole('button', { name: '播放 可播放验证样例', exact: true }).click();
  await until(() => releaseVerifiedProbes.length > 0, '固定片段探测进行中');
  assert.equal(await page.locator('#source-row').getByRole('button', { name: '第一源', exact: true }).count(), 0, '待探测来源先隐藏');
  assert.equal(await page.locator('#episodes .line-tabs button').count(), 0, '待探测线路先隐藏');
  assert.equal(await page.locator('video').count(), 0, '片段验证通过前不挂载播放器');
  await page.locator('nav a[href="#home"]').click();
  holdVerifiedProbe = false; for (const release of releaseVerifiedProbes.splice(0)) release();
  await page.waitForTimeout(200);
  assert.equal(await page.locator('video').count(), 0, '离开后旧探测不能接管首页');
  await page.getByRole('button', { name: '电视剧', exact: true }).click();
  await page.locator('#browse-results').getByRole('button', { name: '播放 可播放验证样例', exact: true }).click();
  await until(() => page.locator('video').evaluate(video => video.readyState >= 1 && video.currentSrc.includes('verified-first-alt-1')).catch(() => false), '先验证失败线路，再选择可用备用线路');
  await page.locator('#source-row').getByRole('button', { name: '第二源', exact: true }).waitFor();
  await page.getByText('正在验证可播放来源…', { exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#source-row').getByRole('button', { name: '第三源', exact: true }).count(), 0, '片段验证失败来源隐藏');
  assert.equal(await page.locator('#episodes .line-tabs').getByRole('button', { name: '原始网页', exact: true }).count(), 0);
  assert.equal(await page.locator('#episodes .line-tabs').getByRole('button', { name: '直连', exact: true }).count(), 0, '当前剧集验证失败线路隐藏');
  assert.equal(await page.locator('#episodes .line-tabs').getByRole('button', { name: '备用', exact: true }).count(), 1);
  await until(() => playabilityReports.some(item => item.id === 'verified' && item.source === 'first' && item.line === 2 && item.status === 'ok'), '实际解码报告覆盖片段验证状态');
  assert.ok(probeMax <= 2, '浏览器并行验证最多两个请求');
  assert.ok(playabilityRequests.filter(item => item.id === 'verified').every(item => item.episode === 0), '不逐集批量探测');
  await page.locator('#source-row').getByRole('button', { name: '第二源', exact: true }).click();
  await until(() => page.locator('video').evaluate(video => video.readyState >= 1 && video.currentSrc.includes('verified-second')).catch(() => false), '已验证来源可以手动换源');
  await page.locator('video').evaluate(video => video.pause());
  console.log('PASS 待验证/失败源线路隐藏、备用线路预检、片段通过前不播放、两并发仅当前集、真实结果上报与旧探测取消');

  await page.locator('nav a[href="#home"]').click();
  await page.getByRole('button', { name: '电视剧', exact: true }).click();
  await page.locator('#browse-results').getByRole('button', { name: '播放 慢响应', exact: true }).click();
  await page.locator('nav a[href="#home"]').click();
  await page.locator('#browse-results').getByRole('button', { name: '播放 海风来信', exact: true }).waitFor();
  await page.waitForTimeout(500);
  assert.equal(await page.locator('video').count(), 0, '旧详情请求不能接管新的首页');
  assert.equal(await page.locator('#page-title').textContent(), '首页');

  const policy = await context({ width: 390, height: 844 });
  await policy.page.locator('#browse-results').getByRole('button', { name: '播放 海风来信', exact: true }).waitFor();
  await policy.page.evaluate(() => { HTMLMediaElement.prototype.play = () => Promise.reject(new DOMException('Autoplay blocked', 'NotAllowedError')); });
  const policyRequestStart = playerRequests.length;
  await policy.page.locator('#browse-results').getByRole('button', { name: '播放 海风来信', exact: true }).click();
  await until(() => policy.page.locator('.player-note').textContent().then(text => text.includes('需要你点击播放器')).catch(() => false), '浏览器自动播放政策反馈');
  assert.equal(new Set(playerRequests.slice(policyRequestStart).filter(url => new URL(url).searchParams.get('id') === 'movie').map(url => new URL(url).searchParams.get('source'))).size, 1, '探测可读其它详情，但自动播放政策不能引起实际换源');
  assert.ok(await policy.page.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 1, '手机播放器不能横向溢出');
  await policy.value.close();
  console.log('PASS 导航取消旧请求、自动播放被禁止时保留播放按钮、手机播放器布局');

  const priority = await context({ width: 1440, height: 1000 }, false);
  await priority.page.evaluate(() => {
    const RealHls = window.Hls;
    window.__actualHlsSupported = RealHls.isSupported();
    window.__hlsLoads = [];
    window.Hls = class extends RealHls {
      loadSource(url) { window.__hlsLoads.push(url); super.loadSource(url); }
    };
    const nativeCanPlayType = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = function (type) { return type === 'application/vnd.apple.mpegurl' ? 'maybe' : nativeCanPlayType.call(this, type); };
  });
  assert.equal(await priority.page.evaluate(() => window.__actualHlsSupported), true, '此回归需要真实MSE支持');
  await priority.page.evaluate(() => { location.hash = '#detail?source=first&id=hls-priority'; });
  await until(() => priority.page.evaluate(() => window.__hlsLoads.some(url => url.includes('hls-priority-first-1.m3u8'))), 'MSE可用时优先Hls.js');
  assert.equal(await priority.page.locator('video').evaluate(video => video.canPlayType('application/vnd.apple.mpegurl')), 'maybe');
  assert.ok(!(await priority.page.locator('video').getAttribute('src') || '').includes('.m3u8'), '不能把native maybe当作优先直连HLS的依据');
  await priority.value.close();
  console.log('PASS native HLS声明maybe时仍优先真实Hls.js分支（仅选择逻辑）');

  async function setAdultVisible(target, enabled) {
    await target.locator('nav a[href="#settings"]').click();
    await target.getByLabel('显示“三级”分类', { exact: true }).setChecked(enabled);
    await target.getByRole('button', { name: '保存全部设置', exact: true }).click();
    await until(() => app.store.config().showAdult === enabled, '家庭三级显示设置保存');
  }
  await page.clock.install();
  await setAdultVisible(page, true);
  await page.locator('nav a[href="#search"]').click();
  await page.getByLabel('影片名称', { exact: true }).fill('分类边界样例');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  const mixedRequestStart = catalogRequests.length;
  await page.getByRole('button', { name: '播放 分类边界样例', exact: true }).click();
  await until(() => page.locator('video').evaluate(video => video.readyState >= 1 && video.currentSrc.includes('category-adult-third')).catch(() => false), '混合搜索组按组分类选择三级来源');
  assert.deepEqual([...new Set(catalogRequests.slice(mixedRequestStart).filter(row => row.kind === 'detail').map(row => row.source))], ['third'], '混合组首个普通条目不能抢先打开');
  assert.equal(await page.locator('#source-row').getByRole('button', { name: '第一源', exact: true }).count(), 0, '三级影片不显示普通换源候选');
  await page.locator('video').evaluate(video => { video.currentTime = 4; video.pause(); });
  await until(() => app.store.list('history').some(row => row.key === categoryBoundary.key && row.category === 'adult'), '同key三级记录保存');
  await page.locator('nav a[href="#home"]').click();
  const boundaryRequestStart = catalogRequests.length;
  await page.locator('#browse-results').getByRole('button', { name: '播放 分类边界样例', exact: true }).click();
  await page.getByRole('heading', { name: '自动尝试已结束', exact: true }).waitFor();
  assert.equal(await page.locator('video').count(), 0, '候选标记普通但实际详情三级时拒绝播放');
  assert.deepEqual([...new Set(catalogRequests.slice(boundaryRequestStart).filter(row => row.kind === 'detail').map(row => row.source))], ['first', 'second'], '普通失败不尝试同key三级源，也不续播三级记录');
  assert.equal(await page.locator('#source-row').getByRole('button', { name: '第三源', exact: true }).count(), 0, '普通影片不显示三级手动换源按钮');
  await page.getByText('正在验证可播放来源…', { exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#source-row').getByRole('button', { name: '第二源', exact: true }).count(), 0, '实际详情跨分类来源不显示手动按钮');
  assert.equal(await page.locator('video').count(), 0, '跨分类详情保持停止播放');
  assert.ok(!catalogRequests.slice(boundaryRequestStart).some(row => row.kind === 'detail' && row.source === 'third'), '自动或手动均不得跨普通与三级分类');
  console.log('PASS 同key混合搜索组选同类来源、候选和实际详情隔离、续播与手动换源分类保护');
  await page.locator('nav a[href="#home"]').click();
  await page.getByRole('button', { name: '三级', exact: true }).waitFor();
  for (const category of ['电影', '电视剧', '动漫']) {
    await page.getByRole('button', { name: category, exact: true }).click();
    await until(() => page.getByRole('button', { name: category, exact: true }).getAttribute('aria-pressed').then(value => value === 'true'), '分类切换完成');
    await page.locator('#content[aria-busy="false"]').waitFor();
    assert.equal(await page.locator('#browse-results').getByRole('button', { name: '播放 限制级样例', exact: true }).count(), 0, '普通分类不能混入三级内容');
  }
  await page.getByRole('button', { name: '三级', exact: true }).click();
  await page.locator('#browse-results').getByRole('button', { name: '播放 限制级样例', exact: true }).click();
  await until(() => page.locator('video').evaluate(video => video.readyState >= 1).catch(() => false), '中性限制级fixture自动播放');
  await page.getByRole('button', { name: '☆ 收藏', exact: true }).click();
  await page.locator('video').evaluate(video => { video.currentTime = 5; video.pause(); });
  await until(() => app.store.list('history').some(row => row.key === adult.key && row.category === 'adult' && row.position >= 4.5), '分类随共享记录持久保存');
  await page.locator('video').evaluate(video => video.play());
  await setAdultVisible(mobile.page, false);
  await page.clock.fastForward(10000);
  await until(async () => await page.locator('#page-title').textContent() === '首页' && await page.locator('video').count() === 0, '原有10秒定时器同步另一设备关闭并停止三级播放');
  await page.locator('#content[aria-busy="false"]').waitFor();
  assert.equal(await page.getByRole('button', { name: '三级', exact: true }).count(), 0);
  await page.locator('nav a[href="#favorites"]').click();
  await page.locator('#content[aria-busy="false"]').waitFor();
  assert.equal(await page.getByRole('button', { name: '播放 限制级样例', exact: true }).count(), 0);
  await page.locator('nav a[href="#history"]').click();
  await page.locator('#content[aria-busy="false"]').waitFor();
  assert.equal(await page.getByRole('button', { name: '继续观看 限制级样例', exact: true }).count(), 0);
  assert.ok(app.store.list('favorites').some(row => row.key === adult.key), '隐藏分类保留收藏数据');
  await setAdultVisible(mobile.page, true);
  await page.locator('nav a[href="#favorites"]').click();
  await page.getByRole('button', { name: '播放 限制级样例', exact: true }).waitFor();
  await page.locator('nav a[href="#history"]').click();
  await page.getByRole('button', { name: '继续观看 限制级样例', exact: true }).waitFor();
  console.log('PASS 三级默认隐藏、开关全家庭同步、普通分类隔离、收藏历史隐藏后恢复');

  delayAdultDetail = true;
  await page.locator('nav a[href="#home"]').click();
  await page.getByRole('button', { name: '三级', exact: true }).click();
  await page.locator('#browse-results').getByRole('button', { name: '播放 限制级样例', exact: true }).click();
  await mobile.page.request.put(base + '/api/config', { data: { ...app.store.config(), showAdult: false } });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.locator('#browse-results').getByRole('button', { name: '播放 海风来信', exact: true }).waitFor();
  await page.waitForTimeout(900);
  assert.equal(await page.locator('video').count(), 0, '隐藏时旧详情请求不能重新接管播放器');
  assert.ok(!(await page.locator('#content').textContent()).includes('限制级样例'), '旧请求不能回填隐藏内容');
  delayAdultDetail = false;
  const forbidden = page.waitForResponse(response => response.url().includes('/api/detail?') && response.status() === 403);
  await page.evaluate(() => { location.hash = '#detail?source=first&id=adult'; });
  await forbidden;
  await until(() => page.url().includes('#home?category=movie'), '隐藏三级的详情403明确返回电影页');
  await page.request.delete(base + '/api/favorites?' + new URLSearchParams({ key: adult.key }));
  console.log('PASS 隐藏三级取消进行中的详情、清分类缓存、403显示设置同步');

  await page.locator('nav a[href="#home"]').click();
  await page.getByRole('button', { name: '综艺·栏目', exact: true }).click();
  await page.locator('#browse-results').getByRole('button', { name: '播放 周末栏目样例', exact: true }).click();
  await until(() => page.locator('video').evaluate(video => video.readyState >= 1 && video.currentSrc.includes('variety-first')).catch(() => false), '综艺栏目点播');
  await page.getByRole('link', { name: '在豆瓣查找 ↗', exact: true }).waitFor();
  assert.match(await page.locator('.film-ratings').textContent(), /暂无豆瓣评分/);
  assert.equal(new URL(await page.getByRole('link', { name: '在豆瓣查找 ↗', exact: true }).getAttribute('href')).hostname, 'search.douban.com');
  await page.locator('nav a[href="#home"]').click();
  assert.match(await page.locator('#browse-results .rating-badge').first().textContent(), /豆瓣 7.7/);
  holdMovieRatings = true;
  await page.locator('#browse-results').getByRole('button', { name: '播放 海风来信', exact: true }).click();
  await until(() => page.locator('video').evaluate(video => video.readyState >= 1).catch(() => false), '评分请求未完成时照常自动播放');
  await until(() => Boolean(releaseMovieRatings), '评分请求被固定样例挂起');
  assert.match(await page.locator('.film-ratings').textContent(), /正在读取评分/);
  holdMovieRatings = false; releaseMovieRatings(); releaseMovieRatings = null;
  const scoreLink = page.getByRole('link', { name: '豆瓣 7.7', exact: true }); await scoreLink.waitFor();
  assert.equal(new URL(await scoreLink.getAttribute('href')).hostname, 'movie.douban.com');
  assert.match(await page.locator('.rating-attribution').textContent(), /由影视源提供/);
  assert.equal(await page.getByLabel('TMDB Read Token', { exact: true }).count(), 0);
  console.log('PASS 综艺栏目点播、无凭证豆瓣评分和出处、评分不阻塞播放、缺评分官方搜索');

  await page.locator('nav a[href="#settings"]').click();
  const subscriptions = page.locator('.settings-section').filter({ has: page.getByRole('heading', { name: '影视源订阅', exact: true }) });
  for (const [index, id, name] of [[1, 'main-subscription', '测试订阅'], [2, 'extra-subscription', '备用订阅']]) {
    await subscriptions.getByRole('button', { name: '＋ 添加', exact: true }).click();
    await page.getByLabel(`影视源订阅 ${index} 唯一标识`, { exact: true }).fill(id);
    await page.getByLabel(`影视源订阅 ${index} 显示名称`, { exact: true }).fill(name);
    await page.getByLabel(`影视源订阅 ${index} 地址`, { exact: true }).fill(`https://subscriptions.example/${id}.json`);
  }
  await subscriptions.locator('.config-row').nth(1).getByRole('button', { name: '↑ 上移', exact: true }).click();
  await subscriptions.locator('.config-row').nth(0).getByRole('checkbox').uncheck();
  const liveSources = page.locator('.settings-section').filter({ has: page.getByRole('heading', { name: '电视直播源', exact: true }) });
  await liveSources.getByRole('button', { name: '＋ 添加', exact: true }).click();
  await page.getByLabel('电视直播源 1 唯一标识', { exact: true }).fill('fixture-live');
  await page.getByLabel('电视直播源 1 显示名称', { exact: true }).fill('测试直播源');
  await page.getByLabel('电视直播源 1 地址', { exact: true }).fill('https://live.example/test.m3u');
  await page.getByRole('button', { name: '保存全部设置', exact: true }).click();
  await until(() => app.store.config().liveSources?.length === 1 && app.store.config().subscriptions?.length === 2, '直播源与订阅持久配置');
  assert.deepEqual(app.store.config().subscriptions.map(item => [item.id, item.enabled]), [['extra-subscription', false], ['main-subscription', true]]);
  assert.equal(app.store.config().showAdult, false, '新增配置不能覆盖共享显示偏好');
  await page.getByRole('button', { name: '立即检测影视源', exact: true }).click();
  await until(() => page.locator('.maintenance-status').textContent().then(text => text.includes('固定检测失败')), '检测结果持久展示');
  assert.equal(maintenance.probeCount, 1);
  await page.getByRole('button', { name: '立即更新订阅', exact: true }).click();
  await until(() => app.store.config().sources.some(item => item.id === 'subscription-imported'), '订阅按标识新增影视源');
  await until(() => page.getByLabel('影视源 5 显示名称', { exact: true }).inputValue().then(value => value === '订阅导入源').catch(() => false), '订阅更新后刷新可编辑配置');
  assert.match(await page.locator('.maintenance-status').textContent(), /最近订阅更新/);
  await page.getByRole('button', { name: '发现新订阅', exact: true }).click();
  await until(() => app.store.config().subscriptions.some(item => item.id === 'discovered-fixture'), '公开订阅发现自动加入配置');
  await until(() => page.getByLabel('影视源订阅 3 显示名称', { exact: true }).inputValue().then(value => value === '新发现订阅样例').catch(() => false), '发现后刷新设置草稿');
  assert.equal(maintenance.discoverCount, 1);
  assert.match(await page.locator('.maintenance-status').textContent(), /新增 1 个订阅/);
  const reads = maintenance.statusReads; await page.waitForTimeout(250); assert.equal(maintenance.statusReads, reads, '设置页不启用常驻状态轮询');
  console.log('PASS 订阅和直播源新增编辑排序停用、手动检测失败状态、订阅更新刷新配置');

  await page.locator('nav a[href="#home"]').click();
  await page.getByRole('button', { name: '电视直播', exact: true }).click();
  const beforeLiveHistory = app.store.list('history').length;
  const liveStart = liveRequests.length;
  await page.getByRole('button', { name: '播放频道 测试电视一', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '播放频道 未验证电视样例', exact: true }).count(), 0);
  assert.equal(await page.locator('#live-lines').getByRole('button', { name: '故障线路', exact: true }).count(), 0, '失败直播线路隐藏');
  assert.equal(await page.locator('#live-lines').getByRole('button', { name: '未知测试线路', exact: true }).count(), 0, '未知直播线路隐藏');
  await until(() => page.locator('video').evaluate(video => video.readyState >= 1 && video.currentSrc.includes('live-second')).catch(() => false), '直播首选已检测可用线路');
  assert.equal(new URL(liveRequests.slice(liveStart).find(url => url.includes('/api/live/playback'))).searchParams.get('line'), '1', '可用线路优先且保持原数组索引');
  await until(() => liveReports.some(report => report.id === 'test-tv-one' && report.line === 1 && report.status === 'ok'), '实际媒体解码后报告成功');
  const reportStart = liveReports.length;
  channels[0].streams[0].status = 'ok';
  await page.getByRole('button', { name: '刷新频道', exact: true }).click();
  await until(async () => !(await page.getByRole('button', { name: '刷新频道', exact: true }).isDisabled()), '新一轮探测结束');
  await page.getByRole('button', { name: '播放频道 测试电视一', exact: true }).click();
  await until(() => page.locator('video').evaluate(video => video.readyState >= 1 && video.currentSrc.includes('live-second')).catch(() => false), '手动故障直播线路经代理后自动备用');
  await until(() => liveReports.slice(reportStart).some(report => report.line === 0 && report.status === 'error'), '直连及代理均失败后报告');
  assert.equal(liveReports.slice(reportStart).filter(report => report.line === 0 && report.status === 'error').length, 1);
  assert.equal(await page.getByRole('button', { name: '下一集 →', exact: true }).count(), 0, '直播不展示点播下一集');
  await page.locator('#live-lines').getByRole('button', { name: '备用测试线路', exact: true }).click();
  await until(() => page.locator('video').evaluate(video => video.readyState >= 1 && video.currentSrc.includes('live-third')).catch(() => false), '直播手动切换线路');
  await page.locator('video').evaluate(video => video.pause());
  liveFailures = [{ source: 'test-live', name: '测试直播', error: '临时不可用，使用最近可用列表', stale: true, cachedAt: Date.now() }];
  await page.getByRole('button', { name: '刷新频道', exact: true }).click();
  assert.ok(liveRequests.filter(url => url.endsWith('/api/live/probe')).length >= 3, '进入直播和手动刷新都先探测');
  await page.getByText('临时不可用，使用最近可用列表', { exact: false }).waitFor();
  assert.equal(await page.getByRole('button', { name: '播放频道 测试电视一', exact: true }).count(), 1, '最近可用频道与刷新故障提示同时显示');
  liveFailures = [];
  assert.equal(app.store.list('history').length, beforeLiveHistory, '直播播放和暂停不写影片续播记录');
  assert.ok(!app.store.list('history').some(record => record.source === 'live'));
  await page.getByRole('button', { name: '播放频道 测试电视二', exact: true }).click();
  await page.locator('nav a[href="#home"]').click();
  await page.locator('#browse-results').getByRole('button', { name: '播放 海风来信', exact: true }).waitFor();
  await page.waitForTimeout(450); assert.equal(await page.locator('video').count(), 0, '直播旧播放请求不能接管首页');
  await mobile.page.locator('nav a[href="#home"]').click();
  await mobile.page.getByRole('button', { name: '电视直播', exact: true }).click();
  await mobile.page.getByRole('button', { name: '播放频道 测试电视一', exact: true }).waitFor();
  assert.ok(await mobile.page.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 1, '手机直播布局不能溢出');
  await mobile.page.locator('nav a[href="#home"]').click();
  console.log('PASS 电视直播状态选线及解码/失败上报、代理备用与手动换线、无影片记录、导航取消和手机布局');

  await page.getByRole('button', { name: '电视剧', exact: true }).click();
  await page.locator('#browse-results').getByRole('button', { name: '播放 播放器样例', exact: true }).click();
  await until(() => page.locator('video').evaluate(video => video.readyState >= 1).catch(() => false), '播放器增强样例');
  await page.locator('video').evaluate(video => { video.currentTime = 3; video.pause(); });
  assert.equal(await page.getByLabel('跳过片头（秒）', { exact: true }).inputValue(), '0');
  assert.equal(await page.getByLabel('跳过片尾（秒）', { exact: true }).inputValue(), '0');
  await page.getByRole('button', { name: '快进 10 秒', exact: true }).click();
  assert.ok(Math.abs(await page.locator('video').evaluate(video => video.currentTime) - 13) < 0.5);
  await page.getByRole('button', { name: '快退 10 秒', exact: true }).click();
  assert.ok(Math.abs(await page.locator('video').evaluate(video => video.currentTime) - 3) < 0.5);
  await page.getByLabel('播放速度', { exact: true }).selectOption('3');
  assert.equal(await page.locator('video').evaluate(video => video.playbackRate), 3);
  const forward = page.getByRole('button', { name: '快进 10 秒', exact: true }); await forward.focus(); await forward.press('ArrowLeft');
  assert.equal(await page.locator('video').evaluate(video => video.currentTime), 0);
  await forward.press('ArrowRight'); assert.ok(Math.abs(await page.locator('video').evaluate(video => video.currentTime) - 10) < 0.5);
  await forward.press('ArrowDown'); assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), '播放速度');
  const intro = page.getByLabel('跳过片头（秒）', { exact: true }); await intro.fill('5'); await intro.focus(); await intro.press('ArrowRight');
  assert.ok(Math.abs(await page.locator('video').evaluate(video => video.currentTime) - 10) < 0.5, '输入框方向键不能被播放器拦截');
  await page.getByLabel('跳过片尾（秒）', { exact: true }).fill('6'); await page.getByLabel('自动下一集', { exact: true }).uncheck();
  await page.getByRole('button', { name: '保存播放偏好', exact: true }).click();
  await until(() => preferences.get(controlsFilm.key)?.introSeconds === 5 && preferences.get(controlsFilm.key)?.autoNext === false, '本影片偏好持久保存');
  await page.locator('video').evaluate(video => { video.currentTime = 3; video.pause(); });
  await page.locator('nav a[href="#home"]').click();
  await page.getByRole('button', { name: '继续观看 播放器样例', exact: true }).click();
  await until(() => page.locator('video').evaluate(video => video.readyState >= 1 && video.currentTime >= 2.9).catch(() => false), '片头偏好尊重已保存续播');
  await page.locator('video').evaluate(video => video.pause());
  assert.ok(await page.locator('video').evaluate(video => video.currentTime) < 5, '续播3秒不能被片头5秒覆盖');
  await page.locator('video').evaluate(video => { video.currentTime = 0; return video.play(); }); await page.waitForTimeout(200); await page.locator('video').evaluate(video => video.pause());
  assert.ok(await page.locator('video').evaluate(video => video.currentTime) < 3, '手动回到片头不能再次自动跳过');
  await page.getByRole('button', { name: '下一集 →', exact: true }).click();
  await until(() => page.locator('video').evaluate(video => video.readyState >= 1 && video.currentTime >= 4.9 && video.currentSrc.includes('controls-first-2')).catch(() => false), '新一集片头跳过一次');
  await page.locator('video').evaluate(video => video.pause());
  await page.locator('#episodes .episode-grid').getByRole('button', { name: '第1集', exact: true }).click();
  await until(() => page.locator('video').evaluate(video => video.readyState >= 1 && video.currentSrc.includes('controls-first-1')).catch(() => false), '回第一集验证片尾开关');
  await page.locator('video').evaluate(video => { video.currentTime = 26; return video.play(); }); await page.waitForTimeout(200);
  assert.match(await page.locator('video').evaluate(video => video.currentSrc), /controls-first-1/, '自动下一集关闭时不跳片尾');
  await page.locator('video').evaluate(video => video.pause()); await page.getByLabel('自动下一集', { exact: true }).check();
  const autoNextStart = playerRequests.length;
  await page.locator('video').evaluate(async video => { video.currentTime = 26; await video.play(); video.dispatchEvent(new Event('timeupdate')); video.dispatchEvent(new Event('timeupdate')); });
  await until(() => page.locator('video').evaluate(video => video.readyState >= 1 && video.currentSrc.includes('controls-first-2')).catch(() => false), '片尾阈值自动进入下一集');
  assert.equal(playerRequests.slice(autoNextStart).filter(url => new URL(url).searchParams.get('id') === 'controls' && new URL(url).searchParams.get('episode') === '1').length, 1, '重复timeupdate不能重复下一集请求');
  await page.locator('video').evaluate(video => video.pause());
  console.log('PASS 快进快退、3倍速、遥控方向键与输入隔离、偏好保存、续播优先、片头一次和片尾next去重');

  await page.getByLabel('跳过片头（秒）', { exact: true }).fill('0'); await page.getByLabel('跳过片尾（秒）', { exact: true }).fill('0');
  await page.getByLabel('自动下一集', { exact: true }).uncheck(); await page.getByLabel('播放速度', { exact: true }).selectOption('1');
  await page.getByRole('button', { name: '保存播放偏好', exact: true }).click();
  await until(() => preferences.get(controlsFilm.key)?.introSeconds === 0 && preferences.get(controlsFilm.key)?.speed === 1, '弹幕样例偏好');
  await page.locator('#episodes .episode-grid').getByRole('button', { name: '第1集', exact: true }).click();
  await until(() => page.locator('video').evaluate(video => video.readyState >= 1 && video.currentSrc.includes('controls-first-1')).catch(() => false), '本集家庭弹幕加载');
  await page.locator('video').evaluate(video => { video.currentTime = 1.9; return video.play(); });
  await until(() => page.locator('.danmaku-overlay').getByText('家庭样例', { exact: true }).count(), '按影片时间显示家庭弹幕');
  await page.locator('video').evaluate(video => video.pause());
  await page.locator('.danmaku-binding summary').click();
  await page.getByLabel('外部弹幕链接', { exact: true }).fill('https://comment.bilibili.com/123.xml');
  await page.getByLabel('弹幕时间偏移（秒）', { exact: true }).fill('-2');
  await page.getByRole('button', { name: '保存本集弹幕绑定', exact: true }).click();
  await until(() => bindings.get(episodeKey(controlsFilm.key, '第1集'))?.offset === -2, '本集官方外部弹幕绑定');
  await page.locator('video').evaluate(video => { video.currentTime = 4.1; return video.play(); });
  await until(() => page.locator('.danmaku-overlay').getByText('外部样例 <img src=x onerror=alert(1)>', { exact: true }).count(), '外部弹幕偏移及纯文字渲染');
  assert.equal(await page.locator('.danmaku-overlay img').count(), 0, '弹幕不能创建HTML');
  await page.getByLabel('家庭弹幕', { exact: true }).fill('<b>家庭文本</b>');
  await page.getByRole('button', { name: '发送弹幕', exact: true }).click();
  await until(() => (comments.get(episodeKey(controlsFilm.key, '第1集')) || []).some(comment => comment.text === '<b>家庭文本</b>' && comment.origin === 'family'), '家庭评论只写本服务');
  assert.equal(await page.locator('.danmaku-overlay b').count(), 0);
  await page.locator('video').evaluate(video => video.pause());
  await page.locator('#source-row').getByRole('button', { name: '第二源', exact: true }).click();
  await until(() => page.locator('video').evaluate(video => video.readyState >= 1 && video.currentSrc.includes('controls-second-1')).catch(() => false), '换源重排仍选择同名第1集');
  assert.equal(await page.locator('#episodes .episode-grid button[aria-pressed="true"]').textContent(), '第1集');
  await page.locator('video').evaluate(video => video.pause());
  await page.locator('.danmaku-binding summary').click();
  await until(() => page.getByLabel('外部弹幕链接', { exact: true }).inputValue().then(value => value === 'https://comment.bilibili.com/123.xml'), '重排源按集名保留绑定');
  assert.equal(await page.getByLabel('弹幕时间偏移（秒）', { exact: true }).inputValue(), '-2');
  await page.locator('video').evaluate(video => { video.currentTime = 2.1; return video.play(); });
  await until(() => page.locator('.danmaku-overlay').getByText('家庭样例', { exact: true }).count(), '重排源按集名保留家庭弹幕');
  await page.locator('video').evaluate(video => video.pause());
  await page.locator('#source-row').getByRole('button', { name: '第一源', exact: true }).click();
  await until(() => page.locator('video').evaluate(video => video.readyState >= 1 && video.currentSrc.includes('controls-first-1')).catch(() => false), '换回原源集名仍不变');
  await page.locator('.danmaku-binding summary').click();
  await page.locator('video').evaluate(video => { video.pause(); video.currentTime = 8.1; return video.play(); });
  await until(() => page.locator('.danmaku-comment').count().then(count => count > 0), '密集固定弹幕');
  assert.ok(await page.locator('.danmaku-comment').count() <= 12, '弹幕同屏最多12条');
  await page.locator('video').evaluate(video => { video.pause(); video.currentTime = 2.1; return video.play(); });
  await until(() => page.locator('.danmaku-overlay').getByText('家庭样例', { exact: true }).count(), 'seek后重置弹幕索引');
  await page.locator('video').evaluate(video => video.pause());
  const pausedReads = danmakuRequests.filter(request => request.method === 'GET' && request.key === episodeKey(controlsFilm.key, '第1集')).length;
  await page.clock.fastForward(20000); assert.equal(danmakuRequests.filter(request => request.method === 'GET' && request.key === episodeKey(controlsFilm.key, '第1集')).length, pausedReads, '暂停取消20秒同步');
  await page.locator('video').evaluate(video => video.play()); await page.clock.fastForward(20000);
  await until(() => danmakuRequests.filter(request => request.method === 'GET' && request.key === episodeKey(controlsFilm.key, '第1集')).length > pausedReads, '播放中20秒轻量同步');
  await page.getByLabel('显示弹幕', { exact: true }).uncheck(); assert.equal(await page.locator('.danmaku-comment').count(), 0, '关闭弹幕即清overlay');
  await page.getByLabel('显示弹幕', { exact: true }).check();
  await page.getByRole('button', { name: '清除本集弹幕绑定', exact: true }).click();
  await until(() => bindings.get(episodeKey(controlsFilm.key, '第1集'))?.url === '', '清除仅本集外部绑定');
  assert.ok((comments.get(episodeKey(controlsFilm.key, '第1集')) || []).some(comment => comment.origin === 'family'), '清外部绑定保留家庭评论');
  await page.locator('video').evaluate(video => video.pause());
  await page.evaluate(() => { window.scrollTo(0, 0); document.activeElement?.blur(); });
  await page.screenshot({ path: join(output, 'desktop-enhanced-player.png'), fullPage: true });
  await page.locator('nav a[href="#home"]').click();
  await page.locator('#browse-results').getByRole('button', { name: '播放 海风来信', exact: true }).waitFor();
  const stoppedReads = danmakuRequests.length; await page.clock.fastForward(20000); assert.equal(danmakuRequests.length, stoppedReads, '离开播放器取消同步');
  await mobile.page.locator('nav a[href="#history"]').click();
  await mobile.page.locator('nav a[href="#home"]').click();
  await mobile.page.getByRole('button', { name: '继续观看 播放器样例', exact: true }).click();
  await until(() => mobile.page.locator('video').evaluate(video => video.readyState >= 1).catch(() => false), '手机读取共享偏好');
  assert.equal(await mobile.page.getByLabel('自动下一集', { exact: true }).isChecked(), false);
  assert.ok(await mobile.page.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 1, '手机增强播放器不能溢出');
  await mobile.page.screenshot({ path: join(output, 'mobile-enhanced-player.png'), fullPage: true });
  await mobile.page.locator('nav a[href="#home"]').click();
  console.log('PASS 家庭/本集外部弹幕绑定与偏移、重排源集名一致、textContent防注入、同屏限流、seek索引、暂停停止同步、共享偏好和手机布局');

  const real = await context({ width: 1440, height: 1000 }, true, true);
  await real.page.getByRole('button', { name: '继续观看 播放器样例', exact: true }).click();
  await until(() => real.page.locator('video').evaluate(video => video.readyState >= 1).catch(() => false), '实际服务器播放器启动');
  await real.page.locator('video').evaluate(video => video.pause());
  await real.page.getByLabel('跳过片头（秒）', { exact: true }).fill('2');
  await real.page.getByLabel('跳过片尾（秒）', { exact: true }).fill('1');
  await real.page.getByLabel('自动下一集', { exact: true }).uncheck();
  await real.page.getByLabel('播放速度', { exact: true }).selectOption('1.25');
  const savedPreferences = real.page.waitForResponse(response => response.url().endsWith('/api/player/preferences') && response.request().method() === 'PUT');
  await real.page.getByRole('button', { name: '保存播放偏好', exact: true }).click();
  assert.equal((await savedPreferences).status(), 200);
  const actualPreferences = await real.page.request.get(`${base}/api/player/preferences?${new URLSearchParams({ key: controlsFilm.key })}`);
  assert.equal((await actualPreferences.json()).introSeconds, 2);
  assert.equal((await actualPreferences.json()).speed, 1.25);
  await real.page.getByLabel('家庭弹幕', { exact: true }).fill('真实路由家庭样例');
  const postedComment = real.page.waitForResponse(response => response.url().endsWith('/api/danmaku') && response.request().method() === 'POST');
  await real.page.getByRole('button', { name: '发送弹幕', exact: true }).click();
  assert.equal((await postedComment).status(), 200);
  const scope = { key: controlsFilm.key, episode: '第1集' };
  const actualComments = await real.page.request.get(`${base}/api/danmaku?${new URLSearchParams(scope)}`);
  assert.equal(actualComments.status(), 200);
  assert.ok((await actualComments.json()).comments.some(comment => comment.text === '真实路由家庭样例' && comment.origin === 'family'));
  await real.page.getByLabel('显示弹幕', { exact: true }).uncheck();
  const cidBinding = await real.page.request.put(`${base}/api/danmaku/binding`, { data: { ...scope, url: 'https://comment.bilibili.com/123.xml', offset: 1.5 } });
  assert.equal(cidBinding.status(), 200, '实际CID绑定只保存，不抓取外部XML');
  const actualBinding = await real.page.request.get(`${base}/api/danmaku/binding?${new URLSearchParams(scope)}`);
  assert.deepEqual(await actualBinding.json(), { url: 'https://comment.bilibili.com/123.xml', offset: 1.5 });
  assert.equal((await real.page.request.put(`${base}/api/danmaku/binding`, { data: { ...scope, url: '', offset: 0 } })).status(), 200);
  assert.equal((await real.page.request.post(`${base}/api/danmaku`, { data: { ...scope, episode: null, time: 1, text: '无效集数样例' } })).status(), 400);
  assert.equal((await real.page.request.get(`${base}/api/danmaku?${new URLSearchParams({ key: controlsFilm.key, episode: '0' })}`)).status(), 200, '保留旧数字集数兼容');
  await real.value.close();
  console.log('PASS 实际服务器路由保存偏好、家庭弹幕POST/GET、集名CID绑定保存清除与非法集数拒绝');

  await page.locator('nav a[href="#settings"]').click();
  const parsers = page.locator('.settings-section').filter({ has: page.getByRole('heading', { name: '解析线路', exact: true }) });
  await parsers.getByRole('button', { name: '＋ 添加', exact: true }).click();
  await page.getByLabel('解析线路 1 显示名称', { exact: true }).fill('测试线路');
  await page.getByLabel('解析线路 1 地址', { exact: true }).fill('https://parse.example/player?url={url}');
  await page.getByRole('button', { name: '保存全部设置', exact: true }).click();
  await until(() => app.store.config().parsers.length === 1, '解析线路保存');
  await page.locator('nav a[href="#home"]').click();
  await page.getByLabel('视频链接', { exact: true }).fill('https://video.example/watch?id=123&token=abc');
  await page.getByRole('button', { name: '播放链接 →', exact: true }).click();
  const frame = page.locator('iframe[title="第三方视频解析播放器"]');
  await frame.waitFor();
  const embedded = new URL(await frame.getAttribute('src'));
  assert.equal(embedded.searchParams.get('url'), 'https://video.example/watch?id=123&token=abc');
  assert.ok(!(await frame.getAttribute('sandbox')).includes('allow-top-navigation'));
  assert.match(await page.getByRole('link', { name: '外部打开 ↗', exact: true }).getAttribute('rel'), /noopener/);
  await until(() => app.store.list('history').some(row => row.mode === 'parser' && row.url.includes('id=123')), '解析链接历史');
  await page.locator('nav a[href="#history"]').click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '清空观看记录', exact: true }).click();
  await until(() => app.store.list('history').length === 0, '清空观看记录');
  assert.equal(app.store.list('favorites').length, 1);
  console.log('PASS 解析线路编辑、带参数页面嵌入、链接历史与清空记录');
  assert.deepEqual(errors, [], '页面不能有未处理脚本异常');
  await page.locator('#logout').click();
  await page.locator('#login-view').waitFor({ state: 'visible' });
  console.log('PASS 退出登录；浏览器验收完成');
  // 显式启用联网验收；固定样例保持可离线重复，不把清单200等同于实际解码。
  if (process.env.VIPVIDEO_REAL_LIVE === '1') {
    const source = defaults.liveSources.find(item => item.id === 'live-presets');
    const samples = parsePlaylist(readFileSync(fileURLToPath(new URL('../live-presets.m3u', import.meta.url)), 'utf8'), source).slice(0, 2);
    for (const sample of samples) for (const stream of sample.streams) stream.status = 'ok';
    const reports = [];
    const liveApp = createApp({ password: 'browser-test-password', dataDir: join(directory, 'real-live'),
      initialConfig: { ...defaults, sources: [], subscriptions: [], liveSources: [source], parsers: [], showAdult: false },
      live: { list: async () => ({ channels: samples, failedSources: [] }), probe: async () => {}, report: (url, status) => reports.push({ url, status }) },
    });
    await new Promise(ok => liveApp.server.listen(0, '127.0.0.1', ok));
    const liveBase = `http://127.0.0.1:${liveApp.server.address().port}`;
    const liveContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const livePage = await liveContext.newPage();
    livePage.setDefaultTimeout(10000);
    const diagnostics = [];
    livePage.on('pageerror', error => diagnostics.push(error.message));
    livePage.on('requestfailed', request => { if (diagnostics.length < 20) diagnostics.push(`${request.failure()?.errorText}: ${request.url()}`); });
    try {
      await livePage.goto(liveBase);
      await livePage.locator('#password').fill('browser-test-password');
      await livePage.locator('#login-form button').click();
      await livePage.locator('#app-view').waitFor({ state: 'visible' });
      await livePage.getByRole('button', { name: '电视直播', exact: true }).click();
      let decoded = false;
      for (const sample of samples) {
        const started = Date.now();
        try {
          await livePage.getByRole('button', { name: `播放频道 ${sample.name}`, exact: true }).click();
          await livePage.waitForFunction(() => { const video = document.querySelector('video'); return video && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0 && !video.paused; }, null, { timeout: 30000 });
          const baseline = await livePage.locator('video').evaluate(video => video.currentTime);
          await livePage.waitForFunction(start => { const video = document.querySelector('video'); return video && video.readyState >= 2 && video.currentTime > start + 2 && !video.paused; }, baseline, { timeout: Math.max(1, 30000 - (Date.now() - started)) });
          const media = await livePage.locator('video').evaluate(video => ({ width: video.videoWidth, height: video.videoHeight, time: video.currentTime, readyState: video.readyState }));
          assert.ok(reports.some(item => item.url === sample.streams[0].url && item.status === 'ok'), '真实解码后线路状态报告');
          assert.equal(liveApp.store.list('history').length, 0, '真实直播仍不写电影历史');
          console.log(`PASS 真实精选直播实际解码 ${sample.name} ${JSON.stringify({ ...media, advanced: media.time - baseline })} elapsedMs=${Date.now() - started}`);
          decoded = true;
          await livePage.locator('video').evaluate(video => video.pause());
          await livePage.screenshot({ path: join(output, 'real-live-player.png'), fullPage: true });
          break;
        } catch (error) {
          const media = await livePage.locator('video').evaluate(video => ({ width: video.videoWidth, height: video.videoHeight, time: video.currentTime, readyState: video.readyState, error: video.error?.message })).catch(() => null);
          console.log(`WARN 真实直播未完成解码 ${sample.name} ${JSON.stringify({ message: error.message.split('\n')[0], media, diagnostics, elapsedMs: Date.now() - started })}`);
          await livePage.locator('nav a[href="#home"]').click();
          await livePage.getByRole('button', { name: '电视直播', exact: true }).click();
        }
      }
      if (!decoded) console.log('WARN 两个精选直播样例在每个30秒限时内均未完成解码，源和网络可用性不能保证。');
    } finally { await liveContext.close(); await liveApp.close(); }
  }
} finally {
  releaseMovieRatings?.();
  for (const release of releaseVerifiedProbes.splice(0)) release();
  await browser?.close(); await app.close(); await rm(directory, { recursive: true, force: true });
}
