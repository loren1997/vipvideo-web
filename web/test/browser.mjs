import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
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
movie.poster = 'https://fixtures.example/movie-poster.svg'; movie.items.forEach(item => { item.poster = movie.poster; });
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
const compatibilityFilm = fixture('兼容播放样例', 'series', 'compatibility', '国产剧', '全2集', ['first']);
const adFilm = fixture('广告时段样例', 'series', 'ad-hls', '国产剧', '全2集');
const quarkFilm = fixture('网盘当前集样例', 'series', 'quark', '国产剧', '全2集');
const cloudFilm = { ...quarkFilm, key: JSON.stringify(['quark-library', '1234567']), source: 'quark-library', id: '1234567', poster: 'https://img3.doubanio.com/view/photo/m_ratio_poster/public/p2935800697.jpg', description: '暂无中文简介。2025年电视剧，剧情类型。', descriptionLanguage: 'unavailable', originalDescription: 'An official English synopsis.', douban: { id: '1234567', score: 8.3, url: 'https://movie.douban.com/subject/1234567/' }, aliases: [], genres: ['剧情'], episodeCount: 2, lines: [{ name: '夸克网盘', episodes: [{ name: '第1集' }, { name: '第2集' }] }] };
const cloudMovie = { ...cloudFilm, key: JSON.stringify(['quark-library', '7654321']), id: '7654321', title: '夸克电影样例', type: 'movie', category: 'movie', episodeCount: null, lines: [{ name: '夸克网盘', episodes: [{ name: '正片' }] }], douban: { id: '7654321', score: 7.2, url: 'https://movie.douban.com/subject/7654321/' } };
const cloudAssetId = (shareId, fileId) => createHash('md5').update(shareId + ':' + fileId).digest('hex');
const cloudPosterPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const cloudPosterReads = [], cloudPosterDirectReads = [];
const progressiveFast = fixture('渐进先到样例', 'movie', 'progressive-fast', '剧情片', '正片', ['first']);
const progressiveSlow = fixture('渐进后到样例', 'movie', 'progressive-slow', '剧情片', '正片', ['second']);
const progressiveAnime = fixture('动画后到样例', 'series', 'progressive-anime', '国产动漫', '全2集', ['second']);
const verifiedFilm = fixture('可播放验证样例', 'series', 'verified', '国产剧', '全2集', ['first', 'second', 'third']);
const adult = fixture('限制级样例', 'movie', 'adult', '限制级', '样例');
adult.category = 'adult'; adult.items.forEach(item => { item.category = 'adult'; });
const categoryBoundary = fixture('分类边界样例', 'movie', 'category-normal', '剧情片', '样例');
const categoryAdult = { ...categoryBoundary.items[0], source: 'third', id: 'category-adult', category: 'adult', typeName: '限制级' };
const mixedCategory = { ...categoryBoundary, category: 'adult', typeName: '限制级', items: [...categoryBoundary.items, categoryAdult] };
function facetFixture(title, id, year, genre, releaseDate = '') {
  const base = fixture(title, 'movie', id, `${genre}片`);
  const fields = { year, key: JSON.stringify([title, year, 'movie']), genres: [genre], releaseDate };
  return { ...base, ...fields, items: base.items.map(item => ({ ...item, ...fields })) };
}
const facetEarly = facetFixture('喜剧春日样例', 'facet-early', '2025', '喜剧', '2025-02-04');
const facetNew = facetFixture('喜剧新片样例', 'facet-new', '2025', '喜剧', '2025-12-02');
const facetUnknown = facetFixture('喜剧日期未知样例', 'facet-unknown', '2026', '喜剧');
const facetOld = facetFixture('惊悚旧片样例', 'facet-old', '2024', '惊悚', '2024-11-13');
const facetHorror = facetFixture('恐怖旧片样例', 'facet-horror', '2023', '恐怖');
const facetClassic = facetFixture('喜剧老片样例', 'facet-classic', '1960', '喜剧', '1960-01-01');
const facetFilms = [facetEarly, facetNew, facetUnknown, facetOld, facetHorror, facetClassic];
const groups = [{ ...summary, items }, movie, moviePage2, anime, variety, broken, badDetail, doomed, slow, hlsPriority, controlsFilm, compatibilityFilm, adFilm, quarkFilm, progressiveFast, progressiveSlow, progressiveAnime, verifiedFilm, adult, mixedCategory, ...facetFilms];
let delayAdultDetail = false;
const catalogRequests = [];
const maintenance = { probeCount: 0, updateCount: 0, discoverCount: 0, statusReads: 0, checkedAt: 0, updatedAt: 0 };
const liveRequests = [];
let liveFailures = [];
const liveReports = [], danmakuRequests = [], playerRequests = [];
const playabilityRequests = [], playabilityReports = [], playableResults = new Map();
const transcodeStarts = [], transcodeStops = [];
let transcodeMode = 'disabled', transcodeDuration = 1200, transcodeAcceleration = 'software', holdTranscode = false, releaseTranscode;
let holdCandidateSearch = false, releaseCandidateSearch;
let holdState = false, releaseStates = [], progressiveBrowse = null, progressiveSearch = null, liveProgress = null;
let facetScenario = false, facetProgress = null;
let metadataProgress = null;
const fixtureGenres = ['喜剧', '惊悚', '恐怖', '动作', '爱情', '科幻', '悬疑', '犯罪', '战争', '剧情', '动画', '冒险', '奇幻', '家庭', '历史', '纪录', '武侠', '古装', '音乐', '运动', '青春'];
const fixtureFacets = { genres: fixtureGenres, years: Array.from({ length: new Date().getFullYear() - 1899 }, (_value, index) => String(new Date().getFullYear() - index)) };
const apiReads = [], vendorReads = [];
let nextContextId = 0;
let holdVendor = false, releaseVendor;
let probeActive = 0, probeMax = 0, holdVerifiedProbe = false, releaseVerifiedProbes = [];
let holdDoomedProbe = false, holdDoomedMedia = false, releaseDoomedMedia;
const releaseDoomedProbes = [];
const preferences = new Map(), bindings = new Map(), comments = new Map();
const adRequests = [];
let adMetadataMode = 'none', holdAdMetadata = false, releaseAdMetadata, maintenanceHealth = false;
const quarkRequests = [], quarkProgress = [], quarkAssets = new Map();
let quarkCookie = '', quarkMode = 'matched', holdQuarkResources = false, releaseQuarkResources;
let quarkResourceReply = null;
let quarkAssetPosition = 0;
let quarkChoicesFixture = false, quarkFilesFixture = 'matched';
let holdQuarkPrepare = false, releaseQuarkPrepare, holdQuarkPlayback = false, releaseQuarkPlayback, quarkPendingChecks = 0;
let quarkFolderRepairFails = false, holdQuarkFolderRepair = false, releaseQuarkFolderRepair;
const heldQuarkFileReads = new Map();
const quarkSettings = { configured: false, enabled: false, autoSave: true, cleanupEnabled: true, retentionDays: 7, maxDailyTransfers: 10, maxDailyBytes: 3_000_000_000_000, searchApi: '', account: { connected: false, label: '' }, managedFiles: 0, lastCleanup: 0, lastError: '', searchPool: { enabled: true, discovering: false, lastDiscovery: 0, lastHealth: 0, healthy: 2, pending: 1, suspended: 1, candidates: [] } };
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
  { id: 'test-tv-one', name: '测试电视一', group: '测试频道', logo: 'https://fixtures.example/channel-logo.svg', streams: [
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
  async browse(config, { category, page, source, genre = '', year = '', sort = 'updated' }) {
    catalogRequests.push({ kind: 'browse', category, page: Number(page), source, genre, year, sort });
    if (source === 'fourth') throw Object.assign(new Error('固定分类接口故障'), { status: 502 });
    if (category === 'adult' && config.showAdult !== true) throw Object.assign(new Error('三级内容已隐藏，请先在设置中开启显示。'), { status: 403 });
    if (facetScenario) {
      assert.ok(!genre || fixtureGenres.includes(genre), 'fixture严格接收规范genre标签');
      assert.ok(!year || /^\d{4}$/.test(year) && Number(year) >= 1900 && Number(year) <= new Date().getFullYear() + 3);
      assert.ok(['updated', 'release', 'year'].includes(sort));
      const selected = facetFilms.filter(group => (!genre || group.genres.includes(genre)) && (!year || group.year === year));
      const list = Number(page) === 1 ? selected.filter(group => group !== facetNew) : selected.filter(group => group === facetNew);
      return { category, page: Number(page), groups: list.map(group => ({ ...group, category, items: group.items.filter(item => !source || item.source === source).map(item => ({ ...item, category })) })), failedSources: [], hasMore: Number(page) === 1 && selected.includes(facetNew), filters: { genre, year, sort }, facets: fixtureFacets, sortScope: 'loaded' };
    }
    const list = category === 'adult' ? [adult] : category === 'movie' ? Number(page) === 1 ? [movie, badDetail, ...(config.showAdult === true ? [categoryBoundary] : [])] : [moviePage2, movie] : category === 'anime' ? [anime] : category === 'variety' ? [variety] : [{ ...summary, items }, broken, doomed, slow, controlsFilm, verifiedFilm];
    return { category, page: Number(page), groups: list.map(group => ({ ...group, items: group.items.filter(item => (!source || item.source === source) && config.sources.some(row => row.id === item.source)) })).filter(group => group.items.length), failedSources: category === 'anime' ? [{ source: 'third', name: '第三源', error: '固定测试超时' }] : [], hasMore: category === 'movie' && Number(page) === 1, filters: { genre, year, sort }, facets: fixtureFacets, sortScope: 'loaded' };
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
    const failed = ['doomed', 'compatibility'].includes(id) || ['broken', 'hls-priority'].includes(id) && source === 'first';
    const numbers = ['broken', 'controls', 'ad-hls'].includes(id) && source === 'second' ? [2, 1] : [1, 2];
    const mediaType = failed || id === 'ad-hls' ? 'hls' : 'mp4';
    return { ...metadata, source, id, description: '固定浏览器测试影片。', lines: [
      { name: '原始网页', episodes: [1, 2].map(number => ({ name: `第${number}集`, type: 'page', url: `https://video.example/watch/${id}-${number}` })) },
      { name: '直连', episodes: numbers.map(number => ({ name: `第${number}集`, type: mediaType, url: `https://fixtures.example/${failed ? 'fail-' : ''}${id}-${source}-${number}.${mediaType === 'hls' ? 'm3u8' : 'mp4'}?token=fixture` })) },
      { name: '备用', episodes: numbers.map(number => ({ name: `第${number}集`, type: mediaType, url: `https://fixtures.example/${failed ? 'fail-' : ''}${id}-${source}-alt-${number}.${mediaType === 'hls' ? 'm3u8' : 'mp4'}?token=fixture` })) },
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
const failedConfigReads = [];
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
  async function context(viewport, nativeMedia = true, realServices = false, initialHash = '', userAgent = '') {
    const value = await browser.newContext({ viewport, ...(userAgent ? { userAgent } : {}) });
    const contextId = ++nextContextId;
    await value.route('**/*', async route => {
      const url = route.request().url();
      const parsed = new URL(url);
      if (parsed.origin === base && ['/api/config', '/api/state', '/api/browse', '/api/search', '/api/live', '/api/live/probe'].includes(parsed.pathname)) apiReads.push({ contextId, path: parsed.pathname, url, method: route.request().method() });
      if (parsed.origin === base && parsed.pathname === '/vendor/hls.min.js') { vendorReads.push({ contextId, url }); if (holdVendor) await new Promise(ok => { releaseVendor = ok; }); }
      if (parsed.origin === base && parsed.pathname === '/api/state' && holdState) await new Promise(ok => releaseStates.push(ok));
      if (parsed.origin === base && parsed.pathname === '/api/browse' && metadataProgress && parsed.searchParams.get('category') === 'movie' && parsed.searchParams.get('sort') === 'release' && !parsed.searchParams.has('genre')) {
        metadataProgress.reads++;
        const initial = facetFixture('聚合补全样例', 'metadata-enriched', '2025', '喜剧');
        initial.items = [initial.items[0]];
        const enriched = metadataProgress.stage === 0 ? initial : metadataProgress.stage === 3 ? { ...initial, releaseDate: '2025-11-05', genres: ['动作'], items: [{ ...initial.items[0], source: 'fourth', releaseDate: '2025-11-05', genres: ['动作'] }] } : { ...initial, releaseDate: metadataProgress.stage === 1 ? '2025-12-02' : '2025-08-03', genres: metadataProgress.stage === 1 ? ['喜剧', '惊悚'] : ['悬疑'], items: [initial.items[0], { ...initial.items[0], source: 'second', releaseDate: '2025-12-02', genres: ['惊悚'] }, ...(metadataProgress.stage === 2 ? [{ ...initial.items[0], source: 'third', releaseDate: '2025-08-03', genres: ['悬疑'] }] : [])] };
        const reference = facetFixture('日期排序参照样例', 'metadata-reference', '2025', '剧情', '2025-06-01');
        return route.fulfill({ json: { category: 'movie', page: Number(parsed.searchParams.get('page')), groups: [reference, enriched], failedSources: [], hasMore: metadataProgress.stage === 2, complete: metadataProgress.stage >= 2, pendingSources: metadataProgress.stage >= 2 ? [] : [{ source: 'second', name: '第二源' }], filters: { genre: '', year: '', sort: 'release' }, facets: fixtureFacets, sortScope: 'loaded' } });
      }
      if (parsed.origin === base && parsed.pathname === '/api/browse' && facetProgress && parsed.searchParams.get('category') === 'movie' && parsed.searchParams.get('genre') === '喜剧' && parsed.searchParams.get('sort') === 'release') {
        facetProgress.reads++;
        return route.fulfill({ json: { category: 'movie', page: 1, groups: [facetEarly, facetUnknown, ...(facetProgress.complete ? [facetNew, facetEarly] : [])], failedSources: [], hasMore: false, complete: facetProgress.complete, pendingSources: facetProgress.complete ? [] : [{ source: 'second', name: '第二源' }], filters: { genre: '喜剧', year: '', sort: 'release' }, facets: fixtureFacets, sortScope: 'loaded' } });
      }
      if (parsed.origin === base && parsed.pathname === '/api/browse' && progressiveBrowse && parsed.searchParams.get('category') === 'anime' && !parsed.searchParams.has('source')) {
        progressiveBrowse.reads++;
        return route.fulfill({ json: { category: 'anime', page: 1, groups: [{ ...anime, items: anime.items.filter(item => progressiveBrowse.complete || item.source === 'first') }, ...(progressiveBrowse.complete ? [progressiveAnime] : [])], failedSources: [], hasMore: false, complete: progressiveBrowse.complete, pendingSources: progressiveBrowse.complete ? [] : [{ source: 'second', name: '第二源' }] } });
      }
      if (parsed.origin === base && parsed.pathname === '/api/search' && progressiveSearch && parsed.searchParams.get('q') === '渐进') {
        progressiveSearch.reads++;
        return route.fulfill({ json: { groups: [progressiveFast, ...(progressiveSearch.complete ? [progressiveSlow] : [])], failedSources: [], complete: progressiveSearch.complete, pendingSources: progressiveSearch.complete ? [] : [{ source: 'second', name: '第二源' }] } });
      }
      if (parsed.origin === base && parsed.pathname === '/api/search' && holdCandidateSearch && parsed.searchParams.get('q') === broken.title) await new Promise(ok => { releaseCandidateSearch = ok; });
      if (realServices && parsed.origin === base && ['/api/player/preferences', '/api/danmaku', '/api/danmaku/binding'].includes(parsed.pathname)) return route.continue();
      if (parsed.origin === base && parsed.pathname === '/api/config' && route.request().method() === 'PUT') savedConfigBodies.push(route.request().postDataJSON());
      if (fixtureImportWarnings && parsed.origin === base && parsed.pathname === '/api/config/import') {
        fixtureImportWarnings = false;
        const response = await route.fetch();
        return route.fulfill({ response, json: { ...await response.json(), importWarnings: ['不支持的蜘蛛源样例已跳过。', '文字提示 <img src=x onerror=alert(1)>'] } });
      }
      if (url.startsWith(base + '/api/playback?')) playerRequests.push(url);
      if (parsed.origin === base && parsed.pathname === '/api/transcode/status') return route.fulfill({ json: { available: true, enabled: transcodeMode !== 'disabled', acceleration: transcodeAcceleration, running: 0 } });
      if (parsed.origin === base && parsed.pathname === '/api/transcode/stop') { transcodeStops.push(route.request().postDataJSON()); return route.fulfill({ json: { ok: true } }); }
      if (parsed.origin === base && parsed.pathname === '/api/transcode/start') {
        const body = route.request().postDataJSON(); transcodeStarts.push(body);
        if (transcodeMode === 'busy') return route.fulfill({ status: 409, json: { error: '兼容任务已被另一会话占用' } });
        if (transcodeMode === 'disabled') return route.fulfill({ status: 503, json: { error: '自动尝试已结束；兼容转码未启用' } });
        if (holdTranscode) await new Promise(ok => { releaseTranscode = ok; });
        if (transcodeMode === 'timeout') return route.fulfill({ status: 504, json: { error: '兼容播放启动超时' } });
        if (transcodeMode === 'not-seekable') return route.fulfill({ status: 409, json: { error: '原文件暂不支持定位续播，请从头播放或换官方在线线路', code: 'TRANSCODE_INPUT_NOT_SEEKABLE' } });
        assert.ok(body.liveId ? body.position === 0 && body.speed === 1 : body.quarkAsset ? typeof body.quarkAsset === 'string' && body.position >= 0 && body.position <= 86400 : typeof body.id === 'string' && Number.isInteger(body.line) && Number.isInteger(body.episode) && body.position >= 0 && body.position <= 86400);
        const id = `fixture-${transcodeStarts.length}`;
        return route.fulfill({ json: { id, url: `/api/transcode/${id}/index.m3u8`, type: 'hls', transcoded: true, startPosition: body.position, duration: transcodeDuration, acceleration: transcodeAcceleration } });
      }
      // 原生静音WAV只验证转码契约与媒体事件；FFmpeg实际HLS由独立转码集成测试覆盖。
      if (parsed.origin === base && /^\/api\/transcode\/fixture-\d+\/index\.(?:m3u8|mp4)$/.test(parsed.pathname)) return route.fulfill({ status: 200, contentType: 'audio/wav', body: media, headers: { 'Accept-Ranges': 'bytes' } });
      if (parsed.origin === base && parsed.pathname === '/api/ratings' && parsed.searchParams.get('source') === 'quark-library') return route.fulfill({ json: { douban: cloudFilm.douban, errors: [] } });
      if (parsed.origin === base && parsed.pathname.startsWith('/api/quark/')) {
        const method = route.request().method(), body = method === 'POST' || method === 'PUT' ? route.request().postDataJSON() : null;
        quarkRequests.push({ path: parsed.pathname, method, body, query: Object.fromEntries(parsed.searchParams) });
        if (parsed.pathname === '/api/quark/library') {
          const category = parsed.searchParams.get('category') || 'movie', page = Number(parsed.searchParams.get('page'));
          const newer = { ...cloudMovie, id: '7654322', title: '夸克新片样例', year: '2026', douban: { ...cloudMovie.douban, id: '7654322', score: 9.1 } };
          const peer = { ...cloudMovie, id: '7654324', title: '夸克同年样例', year: '2026', douban: { ...cloudMovie.douban, id: '7654324', score: 6.5 } };
          let rows = category === 'movie' ? page === 1 ? [cloudMovie, peer, newer] : [{ ...cloudMovie, id: '7654323', title: '夸克下一页样例' }] : [{ ...cloudFilm, category }];
          if (parsed.searchParams.get('sort') === 'score') rows = rows.sort((a, b) => b.douban.score - a.douban.score);
          if (parsed.searchParams.get('sort') === 'release') rows = rows.sort((a, b) => Number(b.year) - Number(a.year));
          if (parsed.searchParams.get('sort') === 'release-score') rows = rows.sort((a, b) => Number(b.year) - Number(a.year) || b.douban.score - a.douban.score);
          if (parsed.searchParams.get('year')) rows = rows.filter(row => row.year === parsed.searchParams.get('year'));
          return route.fulfill({ json: { items: rows, hasMore: category === 'movie' && page === 1, facets: { genres: ['剧情', '喜剧'], years: ['2026', '2025'] }, sortLabel: parsed.searchParams.get('sort') === 'score' ? '已上映片目，豆瓣高分优先' : parsed.searchParams.get('sort') === 'release' ? '热门已上映片目，上映年份优先' : '热门已上映片目，年份优先、同年高分优先', errors: [] } });
        }
        if (parsed.pathname === '/api/quark/library/detail') return route.fulfill({ json: parsed.searchParams.get('id') === cloudMovie.id ? cloudMovie : cloudFilm });
        if (parsed.pathname === '/api/quark/library/poster') {
          assert.deepEqual([...parsed.searchParams.keys()], ['id']); const id = parsed.searchParams.get('id'); cloudPosterReads.push(id);
          return route.fulfill({ status: [cloudFilm.id, cloudMovie.id, '7654322', '7654323', '7654324'].includes(id) ? 200 : 404, contentType: 'image/png', body: cloudPosterPng });
        }
        if (parsed.pathname === '/api/quark/settings') {
          if (body) {
            assert.ok(Number.isInteger(body.retentionDays) && body.retentionDays >= 1);
            assert.ok(Number.isInteger(body.maxDailyTransfers) && body.maxDailyTransfers >= 1 && body.maxDailyTransfers <= 100);
            assert.equal(Object.hasOwn(body, 'autoSave'), false, '手动独立影院设置不修改旧自动准备配置');
            Object.assign(quarkSettings, { enabled: body.enabled, cleanupEnabled: body.cleanupEnabled, retentionDays: body.retentionDays, maxDailyTransfers: body.maxDailyTransfers, searchApi: body.searchApi });
            if (body.cookie) { quarkCookie = body.cookie; quarkSettings.configured = true; quarkSettings.account = { connected: true, label: '测试账号' }; }
          }
          return route.fulfill({ json: quarkSettings });
        }
        if (parsed.pathname === '/api/quark/account') { assert.equal(method, 'DELETE'); quarkCookie = ''; quarkSettings.configured = false; quarkSettings.account = { connected: false, label: '' }; return route.fulfill({ json: { ok: true } }); }
        if (parsed.pathname === '/api/quark/cleanup') { assert.deepEqual(body, {}); quarkSettings.lastCleanup = Date.now(); return route.fulfill({ json: { removed: 0, failed: 0 } }); }
        if (parsed.pathname === '/api/quark/folder/repair') {
          assert.equal(method, 'POST'); assert.deepEqual(body, {});
          if (holdQuarkFolderRepair) await new Promise(ok => { releaseQuarkFolderRepair = ok; });
          if (quarkFolderRepairFails) return route.fulfill({ status: 503, json: { error: '固定目录恢复失败，请重试' } });
          quarkMode = 'matched'; return route.fulfill({ json: quarkSettings });
        }
        if (parsed.pathname === '/api/quark/resources') {
          if (['unverified', 'unverified-mixed'].includes(quarkMode)) return route.fulfill({ json: { resources: quarkMode === 'unverified-mixed' ? [{ id: 'share-fixture', name: '已匹配片名的分享', url: 'https://pan.quark.cn/s/fixture123' }] : [], reason: '固定搜索服务连接失败', unverified: [{ name: '', url: 'https://pan.quark.cn/s/unknown123?pwd=A1b2&token=redacted#secret' }, { name: '<img src=x onerror=alert(1)>', url: 'https://pan.quark.cn/s/unknown456' }, { name: '危险链接', url: 'https://pan.quark.cn.evil.example/s/unknown789' }, { name: '非法提取码', url: 'https://pan.quark.cn/s/unknown999?pwd=invalid%3D' }] } });
          const resourceReply = quarkResourceReply;
          if (holdQuarkResources) await new Promise(ok => { releaseQuarkResources = ok; });
          if (resourceReply) return route.fulfill({ json: resourceReply });
          if (parsed.searchParams.get('web') === '1') return route.fulfill({ json: { resources: [
            { id: 'share-new', name: '当前片新增公开资源', url: 'https://pan.quark.cn/s/new123456', publishedAt: Date.UTC(2026, 8, 20) },
            { id: 'share-old', name: '当前片已有公开资源', url: 'https://pan.quark.cn/s/old123456', publishedAt: Date.UTC(2025, 8, 20) },
            { id: 'share-undated', name: '当前片无日期资源', url: 'https://pan.quark.cn/s/nodate123' },
          ] } });
          if (quarkMode === 'search-empty') return route.fulfill({ json: { resources: [], reason: '搜索渠道暂不可用：API 返回非 JSON；Google 暂不可访问。' } });
          if (quarkChoicesFixture) return route.fulfill({ json: { resources: ['first', 'second'].map(id => ({ id: `share-${id}`, name: `${id === 'first' ? '第一' : '第二'}份分享 · 4K HQ 60FPS 高码率 DTS 环绕声 内嵌简英字幕 ${'完整长标题'.repeat(12)}`, url: `https://pan.quark.cn/s/${id}` })), reason: '' } });
          return route.fulfill({ json: { resources: [{ id: 'share-fixture', name: '当前片分享样例', url: 'https://pan.quark.cn/s/fixture' }], reason: '' } });
        }
        if (parsed.pathname === '/api/quark/files') {
          const episode = Number(parsed.searchParams.get('episode')); assert.ok(Number.isInteger(episode));
          if (quarkChoicesFixture) {
            const shareId = parsed.searchParams.get('shareId'), scenario = quarkFilesFixture;
            if (scenario === 'hold') await new Promise(ok => { heldQuarkFileReads.set(shareId, ok); });
            if (scenario === 'forbidden') return route.fulfill({ status: 403, json: { error: '夸克接口拒绝当前请求，请稍后重试或选择其他分享。' } });
            if (scenario === 'account') return route.fulfill({ status: 401, json: { error: '夸克账号登录已失效，请在设置中重新连接账号。', quarkAuth: true } });
            if (scenario === 'session') return route.fulfill({ status: 401, json: { error: '请先登录' } });
            if (scenario === 'empty') return route.fulfill({ json: { files: [], reason: '当前分享没有可选择的视频。' } });
            return route.fulfill({ json: { files: [{ id: `${shareId}-video`, name: `当前影片第${episode + 1}集 ${'4K高码率完整标题'.repeat(10)}.mkv`, size: 10485760, match: true }], ambiguous: false } });
          }
          return route.fulfill({ json: { files: [1, 2].map(number => ({ id: `file-${number}`, name: `网盘样例第${number}集.mp4`, size: 10485760, match: quarkMode === 'ambiguous' || number === episode + 1 })), ambiguous: quarkMode === 'ambiguous' } });
        }
        if (parsed.pathname === '/api/quark/prepare') {
          assert.ok(body.source && body.id && Number.isInteger(body.line) && Number.isInteger(body.episode)); assert.equal(typeof body.auto, 'boolean'); assert.ok(body.fileId && body.shareId);
          if (body.auto) assert.equal(body.fileId, `file-${body.episode + 1}`, '自动仅转当前选中的单集');
          if (body.source === 'quark-library') assert.equal(body.auto, false, '独立影院始终手动转存');
          if (holdQuarkPrepare) await new Promise(ok => { releaseQuarkPrepare = ok; });
          if (quarkMode === 'prepare-error') return route.fulfill({ json: { status: 'error', reason: '固定专用目录错误，未转存' } });
          if (quarkMode === 'folder-missing') return route.fulfill({ json: { status: 'error', code: 'QUARK_FOLDER_MISSING', reason: '已登记目录未找到，需恢复专用目录' } });
          const assetId = cloudAssetId(body.shareId, body.fileId);
          const seen = quarkAssets.has(assetId); quarkAssets.set(assetId, { body, name: `网盘样例第${body.episode + 1}集.mp4` }); quarkSettings.managedFiles = quarkAssets.size;
          const pending = quarkMode === 'pending-forever' || quarkMode === 'pending' && ++quarkPendingChecks === 1;
          return route.fulfill({ json: { assetId, name: quarkAssets.get(assetId).name, position: quarkAssetPosition, duration: 1200, status: pending ? 'pending' : 'ready', saved: !pending, reused: seen } });
        }
        if (parsed.pathname === '/api/quark/playback') { if (holdQuarkPlayback) await new Promise(ok => { releaseQuarkPlayback = ok; }); if (quarkMode === 'playback-error') return route.fulfill({ status: 502, json: { error: '固定夸克播放链接错误' } }); assert.ok(quarkAssets.has(body.assetId)); const type = quarkMode === 'requires' ? 'mkv' : ['webm', 'avi', 'mpegts'].includes(quarkMode) ? quarkMode : 'hls'; return route.fulfill({ json: { assetId: body.assetId, name: quarkAssets.get(body.assetId).name, url: `/api/quark/media/${body.assetId}/index.${type === 'hls' ? 'm3u8' : type}`, type, size: 10485760, version: 'official-fixture-h264-v1', requiresCompatibility: ['requires', 'avi', 'mpegts'].includes(quarkMode), duration: 30 } }); }
        if (parsed.pathname === '/api/quark/progress') { assert.ok(quarkAssets.has(body.assetId), `未知测试资产 ${body.assetId} / ${[...quarkAssets.keys()].join(',')}`); assert.ok(Number.isFinite(body.position) && Number.isFinite(body.duration) && typeof body.ended === 'boolean'); assert.ok(body.position >= 0 && body.duration > 0 && body.duration <= 86400 && body.position <= body.duration + 2, '观看进度遵守服务端时长及范围校验'); quarkProgress.push(body); return route.fulfill({ json: { ok: true } }); }
        if (parsed.pathname.startsWith('/api/quark/media/')) return route.fulfill({ contentType: 'audio/wav', body: media, headers: { 'Accept-Ranges': 'bytes' } });
      }
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
          if (value.id === 'doomed' && value.source === 'fourth' && holdDoomedProbe) await new Promise(ok => releaseDoomedProbes.push(ok));
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
          app.store.setConfig({ ...latest, subscriptions: [...latest.subscriptions.filter(item => item.id !== 'discovered-fixture'), { id: 'discovered-fixture', name: '新发现订阅样例', url: 'https://subscriptions.example/discovered.json', enabled: true }] });
        } else maintenance.statusReads++;
        const latest = app.store.config();
        return route.fulfill({ json: { running: false, backgroundMode: 'low', probeIntervalMinutes: 60, updateIntervalMinutes: 360, lastProbe: maintenance.checkedAt, lastUpdate: maintenance.updatedAt,
          sources: latest.sources.map(item => ({ ...item, status: item.enabled === false ? 'disabled' : maintenanceHealth && item.id === 'third' ? maintenanceHealth === 'restored' ? 'ok' : 'quarantined' : maintenance.checkedAt ? item.id === 'third' ? 'error' : 'ok' : 'unknown', failures: maintenanceHealth && maintenanceHealth !== 'restored' && item.id === 'third' ? 3 : 0, firstFailureAt: maintenanceHealth && item.id === 'third' ? Date.now() - 3600000 : null, retryAt: maintenanceHealth && maintenanceHealth !== 'restored' && item.id === 'third' ? Date.now() + 1800000 : null, latencyMs: maintenance.checkedAt ? 35 : null, checkedAt: maintenance.checkedAt, error: maintenanceHealth === 'restored' ? '' : maintenance.checkedAt && item.id === 'third' ? '固定检测失败' : '' })),
          subscriptions: (latest.subscriptions || []).map(item => ({ ...item, status: item.enabled === false ? 'disabled' : maintenance.updatedAt ? 'ok' : 'unknown', checkedAt: maintenance.updatedAt, lastUpdate: maintenance.updatedAt, error: '' })),
          liveSources: (latest.liveSources || []).map(item => ({ ...item, status: item.enabled === false ? 'disabled' : maintenance.checkedAt ? 'ok' : 'unknown', latencyMs: 12, checkedAt: maintenance.checkedAt, error: '' })),
          discovery: { running: false, backgroundMode: 'low', intervalMinutes: 60, lastDiscovery: maintenance.discoverCount ? Date.now() : null, retiredCount: maintenanceHealth ? 1 : 0, retired: maintenanceHealth ? [{ id: 'retired-fixture', name: '自动订阅撤下样例', kind: 'vod', reason: '跨7天连续404', retryAt: Date.now() + 86400000 }] : [], candidates: maintenanceHealth ? [{ name: '公开配置403样例', url: 'https://subscriptions.example/forbidden.json', status: 'error', httpStatus: 403, reason: '公开下载暂时受限', error: '固定403', retryAt: Date.now() + 1800000 }, { name: '公开配置404样例', url: 'https://subscriptions.example/missing.json', status: 'error', httpStatus: 404, reason: '上游路径已变更', error: '固定404' }, { name: '新发现订阅样例', url: 'https://subscriptions.example/discovered.json', status: 'ok', added: true }] : maintenance.discoverCount ? [{ name: '新发现订阅样例', url: 'https://subscriptions.example/discovered.json', status: 'ok', added: true }] : [] },
        } });
      }
      if (parsed.origin === base && parsed.pathname === '/api/player/preferences') {
        const body = route.request().method() === 'PUT' ? route.request().postDataJSON() : null;
        if (body) {
          assert.equal(typeof body.skipAds, 'boolean'); assert.ok(Array.isArray(body.adRanges) && body.adRanges.length <= 20);
          assert.ok(body.adRanges.every(range => typeof range.scope === 'string' && range.scope.length <= 4096 && Number.isFinite(range.start) && Number.isFinite(range.end) && range.start >= 0 && range.end <= 86400 && range.end > range.start && range.end - range.start <= 600));
          preferences.set(body.key, { introSeconds: body.introSeconds, outroSeconds: body.outroSeconds, speed: body.speed, autoNext: body.autoNext, danmakuEnabled: body.danmakuEnabled, skipAds: body.skipAds, adRanges: body.adRanges });
        }
        return route.fulfill({ json: preferences.get(body?.key || parsed.searchParams.get('key')) || { introSeconds: 0, outroSeconds: 0, speed: 1, autoNext: true, danmakuEnabled: true, skipAds: false, adRanges: [] } });
      }
      if (parsed.origin === base && parsed.pathname === '/api/ads') {
        const selection = Object.fromEntries(parsed.searchParams); selection.line = Number(selection.line); selection.episode = Number(selection.episode); adRequests.push(selection);
        assert.ok(selection.source && selection.id && Number.isInteger(selection.line) && Number.isInteger(selection.episode));
        if (holdAdMetadata) await new Promise(ok => { releaseAdMetadata = ok; });
        if (adMetadataMode === 'error') return route.fulfill({ status: 502, json: { error: '固定广告清单故障' } });
        return route.fulfill({ json: { supported: adMetadataMode === 'marked', ranges: adMetadataMode === 'marked' ? [{ start: 15, end: 18, kind: 'daterange' }] : [], reason: '无可信闭合VOD广告标记；不能移除片内台标' } });
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
        liveRequests.push(url);
        if (liveProgress) liveProgress.reads++;
        const available = (app.store.config().liveSources || []).some(item => item.enabled !== false) ? channels : [];
        return route.fulfill({ json: { channels: parsed.searchParams.get('verified') === '1' ? available.filter(channel => channel.streams.some(stream => stream.status === 'ok')) : available, failedSources: liveFailures, ...(liveProgress?.backgroundMode ? { backgroundMode: liveProgress.backgroundMode } : {}), probing: liveProgress?.probing || false, checkedStreams: liveProgress?.checkedStreams ?? (liveProgress?.probing ? 2 : 5), totalStreams: liveProgress?.totalStreams ?? 6, lastProbe: Date.now() } });
      }
      if (parsed.origin === base && parsed.pathname === '/api/live/playback') {
        liveRequests.push(url);
        const channel = channels.find(item => item.id === parsed.searchParams.get('id')); const stream = channel?.streams[Number(parsed.searchParams.get('line'))];
        if (channel?.id === 'test-tv-two') await new Promise(ok => setTimeout(ok, 350));
        return route.fulfill({ json: { ...stream, url: stream.playbackUrl || stream.url, proxyUrl: base + '/api/media?token=live-fixture' } });
      }
      if (parsed.origin === base && parsed.pathname === '/api/live/report') { liveReports.push(route.request().postDataJSON()); return route.fulfill({ json: { ok: true } }); }
      if (url.startsWith(base + '/api/media?')) return route.fulfill({ status: 404, body: 'fixture failed proxy' });
      if (url.startsWith(base + '/')) return route.continue();
      if (url === 'https://fixtures.example/channel-logo.svg') return route.fulfill({ status: 404, body: 'fixed unavailable logo' });
      if (url === cloudFilm.poster) { cloudPosterDirectReads.push(url); return route.abort('blockedbyclient'); }
      if (url === 'https://fixtures.example/movie-poster.svg') return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="270"><rect width="180" height="270" fill="#27454a"/><circle cx="90" cy="110" r="40" fill="#62dcc8"/></svg>' });
      if (url.startsWith('https://fixtures.example/fail-')) {
        if (holdDoomedMedia && url.includes('fail-doomed-')) await new Promise(ok => { releaseDoomedMedia = ok; });
        return route.fulfill({ status: 404, body: 'fixture failed media', headers: { 'Access-Control-Allow-Origin': '*' } });
      }
      if (url.startsWith('https://fixtures.example/')) return route.fulfill({ status: 200, contentType: 'audio/wav', body: media,
        headers: { 'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'bytes' } });
      return route.abort();
    });
    const page = await value.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', async response => {
      if (new URL(response.url()).pathname === '/api/config' && response.request().method() === 'GET' && response.status() >= 400) failedConfigReads.push({ contextId, status: response.status(), contentType: response.headers()['content-type'] || '', body: (await response.text().catch(error => error.message)).slice(0, 500) });
    });
    await page.goto(base + initialHash);
    // WAV只验证原生媒体事件，不冒充可被Hls.js解码的MPEG-TS。
    if (nativeMedia) await page.evaluate(() => { window.Hls = { isSupported: () => false, Events: { ERROR: 'hlsError', MANIFEST_PARSED: 'hlsManifestParsed' } }; });
    await page.locator('#password').fill('browser-test-password');
    if (userAgent.includes('VIPVideoWebTV')) {
      await page.locator('#password').focus(); await page.keyboard.press('ArrowDown');
      assert.equal(await page.locator('#login-form button').evaluate(element => element === document.activeElement), true, '旧TV APK登录页方向键可到登录按钮'); await page.keyboard.press('Enter');
    } else await page.locator('#login-form button').click();
    await page.locator('#app-view').waitFor({ state: 'visible' });
    return { value, page, contextId };
  }
  async function openSettingsSection(page, title) {
    const panel = page.locator('details.settings-section').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
    try { await panel.waitFor(); }
    catch (error) { console.error('SETTINGS_SECTION_DIAGNOSTIC', JSON.stringify({ title, state: await page.evaluate(() => ({ href: location.href, appHidden: document.querySelector('#app-view').hidden, loginHidden: document.querySelector('#login-view').hidden, busy: document.querySelector('#content').getAttribute('aria-busy'), headings: [...document.querySelectorAll('h2')].map(item => item.textContent), content: document.querySelector('#content')?.textContent.slice(0, 1000) })), auth: await (await page.request.get(base + '/api/auth')).json(), failedConfigReads, errors })); throw error; }
    if (!(await panel.evaluate(element => element.open))) await panel.locator(':scope > summary').click();
    await until(() => panel.evaluate(element => element.open), `展开设置分区 ${title}`); return panel;
  }
  async function verifyBitstreamInitialLevel() {
    const channel = { id: 'initial-level-satellite', name: '码流起始层样例', category: '卫视', group: '起始层样例', preferredLine: 0, streams: [{ name: '已验证H264动态主清单', status: 'ok', type: 'hls', url: 'https://fixtures.example/initial-level-master.m3u8?session=fixture', quality: { width: 1920, height: 1080, source: 'bitstream' } }] };
    channels.push(channel); let isolated;
    try {
      isolated = await context({ width: 1440, height: 1000 }, true, false, '#live?category=%E5%8D%AB%E8%A7%86'); const p = isolated.page;
      await p.evaluate(() => {
        window.__initialHls = []; window.__initialLevels = [];
        class InitialLevelFixtureHls {
          static isSupported() { return true; }
          static Events = { ERROR: 'hlsError', MANIFEST_PARSED: 'hlsManifestParsed' };
          constructor(options) { this.options = options; this.levels = window.__initialLevels; this.handlers = new Map(); this.currentLevel = -1; this.autoLevelEnabled = true; window.__initialHls.push(this); }
          loadSource(url) { this.url = url; }
          attachMedia(video) { this.video = video; if (this.options.autoStartLoad !== false) this.startMedia(); setTimeout(() => { if (!this.destroyed) this.handlers.get('hlsManifestParsed')?.('hlsManifestParsed', { levels: this.levels }); }, 0); }
          startMedia() { this.video.src = this.url.replace('.m3u8', '.mp4'); }
          startLoad() { this.startLoads = (this.startLoads || 0) + 1; this.startMedia(); }
          on(event, handler) { this.handlers.set(event, handler); }
          destroy() { this.destroyed = true; }
        }
        window.Hls = InitialLevelFixtureHls;
      });
      const card = p.getByRole('button', { name: '播放频道 码流起始层样例', exact: true }); await card.waitFor();
      const low = { width: 320, height: 180, videoCodec: 'avc1.42E01E' }, high = { width: 1920, height: 1080, videoCodec: 'avc1.640028' };
      const cases = [
        { name: '唯一AVC高清层', levels: [low, high], expected: 1 },
        { name: 'attrs CODECS明确AVC', levels: [low, { width: 1920, height: 1080, attrs: { CODECS: 'avc1.640028, mp4a.40.2' } }], expected: 1 },
        { name: '同尺寸多个AVC候选不猜', levels: [low, high, { ...high, videoCodec: 'avc1.4d4028' }], expected: undefined },
        { name: 'HEVC-only不猜', levels: [low, { ...high, videoCodec: 'hvc1.1.6.L123.B0' }], expected: undefined },
        { name: '未声明视频codec不猜', levels: [low, { width: 1920, height: 1080 }], expected: undefined },
        { name: '宽高不精确匹配不猜', levels: [low, { ...high, height: 1088 }], expected: undefined },
      ];
      for (const [index, sample] of cases.entries()) {
        await p.evaluate(levels => { window.__initialLevels = levels; }, sample.levels); await card.click();
        await until(() => p.evaluate(count => window.__initialHls.length === count, index + 1), sample.name);
        await until(() => p.locator('video').evaluate(video => video.readyState >= 2).catch(() => false), `${sample.name}媒体事件`);
        const selection = await p.evaluate(() => { const instance = window.__initialHls.at(-1); return { startLevel: instance.startLevel, currentLevel: instance.currentLevel, auto: instance.autoLevelEnabled, starts: instance.startLoads }; });
        assert.equal(selection.startLevel, sample.expected, sample.name); assert.equal(selection.currentLevel, -1, '不设置manual currentLevel'); assert.equal(selection.auto, true, '保持auto ABR'); assert.equal(selection.starts, 1);
      }
      channel.streams[0].quality.source = 'manifest';
      await p.locator('nav a[href="#home"]').click(); await p.getByRole('button', { name: '电视直播', exact: true }).click(); await card.locator('.channel-badge').filter({ hasText: '清单1080p' }).waitFor();
      await p.evaluate(() => { window.__initialLevels = [{ width: 320, height: 180 }, { width: 1920, height: 1080 }]; }); await card.click();
      await until(() => p.locator('video').evaluate(video => video.readyState >= 2).catch(() => false), '原manifest起始层路径');
      assert.equal(await p.evaluate(() => window.__initialHls.at(-1).startLevel), 1); assert.equal(await p.evaluate(() => window.__initialHls.at(-1).currentLevel), -1);
      console.log('PASS bitstream主清单唯一兼容AVC精确层启动1080、CODECS回退、歧义/HEVC/未知/不匹配不猜、保留auto ABR和原manifest路径（固定契约）');
    } finally { await isolated?.value.close(); channels.splice(channels.indexOf(channel), 1); }
  }

  async function verifyProgressiveMetadata() {
    metadataProgress = { reads: 0, stage: 0 }; let isolated;
    try {
      isolated = await context({ width: 1440, height: 1000 }, true, false, '#home?category=movie&sort=release'); const p = isolated.page; await p.clock.install();
      const titles = () => p.locator('#browse-results .card-title').allTextContents();
      const card = p.locator('#browse-results .media-card').filter({ hasText: '聚合补全样例' });
      await card.waitFor(); assert.deepEqual(await titles(), ['日期排序参照样例', '聚合补全样例']); assert.equal(await card.locator('.card-date').textContent(), '上映日期未知');
      metadataProgress.stage = 1; await p.clock.fastForward(1000);
      await until(async () => (await titles())[0] === '聚合补全样例', '后到同片日期补全后向前重排');
      assert.equal(await card.locator('.card-date').textContent(), '2025-12-02', '首源空日期不能覆盖聚合上映日期'); assert.equal(await card.locator('.card-meta').getAttribute('title'), '喜剧 · 惊悚');
      metadataProgress.stage = 2; await p.clock.fastForward(1000);
      await until(() => card.locator('.card-date').textContent().then(text => text === '2025-08-03'), '同片多个日期取最早有效首映');
      assert.equal(await card.locator('.card-meta').getAttribute('title'), '喜剧 · 惊悚 · 悬疑'); assert.match(await card.locator('.card-meta').textContent(), /3 个来源/);
      await until(() => p.getByRole('button', { name: '加载更多', exact: true }).isEnabled(), '渐进完成后可加载下一页');
      metadataProgress.stage = 3; await p.getByRole('button', { name: '加载更多', exact: true }).click();
      await until(() => card.locator('.card-meta').textContent().then(text => text.includes('4 个来源')), '下一页增加独立来源不替换原items');
      assert.equal(await card.locator('.card-date').textContent(), '2025-08-03', '较晚上映日期不覆盖既有最早日期'); assert.equal(await card.locator('.card-meta').getAttribute('title'), '喜剧 · 惊悚 · 悬疑 · 动作'); assert.deepEqual(await titles(), ['聚合补全样例', '日期排序参照样例']);
      console.log('PASS 同key渐进补全日期/合并类型即重排、首源未知不覆盖聚合信息、多源首映取最早有效日期及分页保留来源顺序');
    } finally { metadataProgress = null; await isolated?.value.close(); }
  }

  async function verifyAdSkipping() {
    const foreign = { scope: JSON.stringify(['second', 'ad-hls', '备用', '第2集']), start: 1, end: 2 };
    preferences.set(adFilm.key, { introSeconds: 0, outroSeconds: 0, autoNext: false, speed: 1.25, danmakuEnabled: true, skipAds: false, adRanges: [foreign] });
    const previousMode = transcodeMode, previousDuration = transcodeDuration; let isolated;
    try {
      isolated = await context({ width: 1440, height: 1000 }); const p = isolated.page;
      await p.evaluate(() => {
        window.Hls = class AdFixtureHls {
          static isSupported() { return true; }
          static Events = { ERROR: 'hlsError', MANIFEST_PARSED: 'hlsManifestParsed' };
          loadSource(url) { this.url = url; }
          attachMedia(video) { video.src = this.url.replace('.m3u8', '.mp4'); }
          on(event, callback) { if (event === 'hlsManifestParsed') queueMicrotask(() => callback(event)); }
          destroy() {}
        };
      });
      const beforeAds = adRequests.length;
      await p.evaluate(() => { location.hash = '#detail?source=first&id=ad-hls'; });
      const decoded = fragment => until(() => p.locator('video').evaluate((video, fragment) => video.readyState >= 2 && video.currentSrc.includes(fragment), fragment).catch(() => false), `广告样例媒体 ${fragment}`);
      await decoded('ad-hls-first-1'); await p.locator('video').evaluate(video => video.pause());
      assert.equal(adRequests.length, beforeAds, '默认不识别/跳过广告');
      await p.locator('.player-ads summary').click();
      await p.locator('video').evaluate(video => { video.currentTime = 4; }); await p.getByRole('button', { name: '标记开始', exact: true }).click();
      await p.locator('video').evaluate(video => { video.currentTime = 7; }); await p.getByRole('button', { name: '标记结束', exact: true }).click();
      assert.equal(await p.getByLabel('广告开始（原片秒）', { exact: true }).inputValue(), '4'); assert.equal(await p.getByLabel('广告结束（原片秒）', { exact: true }).inputValue(), '7');
      await p.getByRole('button', { name: '保存时段并跳过', exact: true }).click();
      await until(() => preferences.get(adFilm.key)?.adRanges.length === 2, '广告时段共享保存');
      assert.deepEqual(preferences.get(adFilm.key).adRanges[0], foreign); assert.equal(preferences.get(adFilm.key).speed, 1.25); assert.equal(preferences.get(adFilm.key).autoNext, false);
      assert.equal(preferences.get(adFilm.key).adRanges[1].scope, JSON.stringify(['first', 'ad-hls', '直连', '第1集']));
      await p.locator('video').evaluate(video => { video.currentTime = 5; video.dispatchEvent(new Event('timeupdate')); }); assert.equal(await p.locator('video').evaluate(video => video.currentTime), 5, '暂停时不自动跳');
      await p.locator('video').evaluate(async video => { await video.play(); video.dispatchEvent(new Event('timeupdate')); });
      await until(() => p.locator('video').evaluate(video => video.currentTime >= 7), '手动标记范围自动跳到结束'); await p.locator('video').evaluate(video => video.pause());
      await until(() => app.store.list('history').some(row => row.key === adFilm.key && row.position >= 7 && row.duration === 30), '跳过后原片进度保存');
      await p.getByLabel('自动跳过已标记广告', { exact: true }).uncheck(); await until(() => preferences.get(adFilm.key).skipAds === false, '关闭跳过持久保存');
      await p.locator('video').evaluate(async video => { video.currentTime = 5; await video.play(); video.dispatchEvent(new Event('timeupdate')); }); await p.waitForTimeout(150); assert.ok(await p.locator('video').evaluate(video => video.currentTime < 6), '关闭后正常播放已标记时段'); await p.locator('video').evaluate(video => video.pause());
      adMetadataMode = 'marked'; await p.getByLabel('自动跳过已标记广告', { exact: true }).check(); await p.locator('.player-ads').getByText('已识别 1 段清单中明确标记的广告。', { exact: true }).waitFor();
      await p.locator('video').evaluate(async video => { video.currentTime = 16; await video.play(); video.dispatchEvent(new Event('timeupdate')); }); await until(() => p.locator('video').evaluate(video => video.currentTime >= 18), '可信VOD标记自动跳'); await p.locator('video').evaluate(video => video.pause());
      await p.getByLabel('自动跳过已标记广告', { exact: true }).uncheck(); adMetadataMode = 'error'; await p.getByLabel('自动跳过已标记广告', { exact: true }).check(); await p.locator('.player-ads').getByText(/广告标记暂时不可用，继续正常播放/).waitFor();
      await p.locator('video').evaluate(async video => { video.currentTime = 16; await video.play(); video.dispatchEvent(new Event('timeupdate')); }); await p.waitForTimeout(150); assert.ok(await p.locator('video').evaluate(video => video.currentTime < 17), '标记接口失败继续原片'); await p.locator('video').evaluate(video => video.pause());
      adMetadataMode = 'none'; await p.locator('.line-tabs').getByRole('button', { name: '备用', exact: true }).click(); await decoded('ad-hls-first-alt-1'); await p.locator('video').evaluate(video => video.pause());
      await p.locator('.player-ads summary').click(); assert.equal(await p.locator('.ad-range-row').count(), 0, '不同线路不复用广告时段');
      await p.locator('#source-row').getByRole('button', { name: '第二源', exact: true }).click(); await decoded('ad-hls-second-alt-1'); await p.locator('video').evaluate(video => video.pause());
      await p.locator('.player-ads summary').click(); assert.equal(await p.locator('.ad-range-row').count(), 0, '同片换源重排集名后仍不误用其他版本');
      await p.locator('video').evaluate(async video => { video.currentTime = 5; await video.play(); video.dispatchEvent(new Event('timeupdate')); }); await p.waitForTimeout(150); assert.ok(await p.locator('video').evaluate(video => video.currentTime < 6), '其他来源相同时间不跳'); await p.locator('video').evaluate(video => video.pause());
      await p.locator('#source-row').getByRole('button', { name: '第一源', exact: true }).click(); await decoded('ad-hls-first-alt-1'); await p.locator('.line-tabs').getByRole('button', { name: '直连', exact: true }).click(); await decoded('ad-hls-first-1'); await p.locator('video').evaluate(video => video.pause());
      await p.locator('.player-ads summary').click(); await p.getByLabel('广告开始（原片秒）', { exact: true }).fill('100'); await p.getByLabel('广告结束（原片秒）', { exact: true }).fill('110'); await p.getByRole('button', { name: '保存时段并跳过', exact: true }).click(); await until(() => preferences.get(adFilm.key).adRanges.length === 3, '原片绝对秒范围保存');
      transcodeMode = 'enabled'; transcodeDuration = 1200; await p.getByRole('button', { name: '兼容播放', exact: true }).click(); await decoded('/api/transcode/');
      const beforeOffset = transcodeStarts.length; await p.getByLabel('原片进度', { exact: true }).fill('100'); await p.getByLabel('原片进度', { exact: true }).dispatchEvent('change');
      await until(() => transcodeStarts.slice(beforeOffset).some(body => Math.abs(body.position - 110) < 0.1), '转码广告跳过使用原片110秒而非相对10秒'); await decoded('/api/transcode/'); await p.locator('video').evaluate(video => video.pause());
      assert.equal(transcodeStarts.slice(beforeOffset).filter(body => Math.abs(body.position - 110) < 0.1).length, 1, '同一广告时段不重复兼容任务');
      await until(() => app.store.list('history').some(row => row.key === adFilm.key && row.position >= 110 && row.duration === 1200), '转码保存绝对进度和原片时长');
      await p.getByLabel('广告开始（原片秒）', { exact: true }).fill('1198'); await p.getByLabel('广告结束（原片秒）', { exact: true }).fill('1210'); await p.getByRole('button', { name: '保存时段并跳过', exact: true }).click(); await until(() => preferences.get(adFilm.key).adRanges.length === 4, '片尾范围保存');
      const beforeTail = transcodeStarts.length; await p.getByLabel('原片进度', { exact: true }).fill('1198'); await p.getByLabel('原片进度', { exact: true }).dispatchEvent('change');
      await until(() => transcodeStarts.slice(beforeTail).some(body => body.position === 1199), '跨片尾范围按转码时长夹到1199'); await decoded('/api/transcode/'); await p.locator('video').evaluate(video => video.pause()); await p.waitForTimeout(150);
      assert.equal(transcodeStarts.slice(beforeTail).filter(body => body.position === 1199).length, 1, '跨片尾不能重复启动同位置job');
      await p.screenshot({ path: join(output, 'desktop-ad-ranges.png'), fullPage: true }); await p.setViewportSize({ width: 390, height: 844 }); assert.ok(await p.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 1); await p.screenshot({ path: join(output, 'mobile-ad-ranges.png'), fullPage: true });
      await p.getByRole('button', { name: '删除广告时段 00:04–00:07', exact: true }).click(); await until(() => preferences.get(adFilm.key).adRanges.length === 3, '删除仅本scope广告范围'); assert.deepEqual(preferences.get(adFilm.key).adRanges[0], foreign);
      await p.getByLabel('自动跳过已标记广告', { exact: true }).uncheck(); holdAdMetadata = true; await p.getByLabel('自动跳过已标记广告', { exact: true }).check(); await until(() => Boolean(releaseAdMetadata), '广告元数据请求等待中');
      await p.locator('nav a[href="#favorites"]').click(); holdAdMetadata = false; releaseAdMetadata(); releaseAdMetadata = null; await p.getByRole('heading', { name: '我的收藏', exact: true }).waitFor(); assert.equal(await p.locator('.player-ads').count(), 0, '旧标记响应不能接管新路由');
      console.log('PASS 广告原片标记/开关/删除与共享保存、严格来源线路集scope、可信标记与失败回退、转码绝对秒及片尾单次guard、手机桌面与路由取消（WAV契约）');
    } finally { holdAdMetadata = false; releaseAdMetadata?.(); releaseAdMetadata = null; adMetadataMode = 'none'; transcodeMode = previousMode; transcodeDuration = previousDuration; await isolated?.value.close(); }
  }

  async function verifyQuarantineStatus() {
    let isolated; const before = app.store.config(); maintenanceHealth = true;
    try {
      isolated = await context({ width: 1440, height: 1000 }, true, false, '#settings'); const p = isolated.page; await openSettingsSection(p, '影视源维护');
      const row = p.locator('.maintenance-row').filter({ has: p.getByText('第三源', { exact: true }) });
      await row.getByText('已隔离', { exact: true }).waitFor(); await row.getByText(/连续失败 3 次/).waitFor(); await row.getByText(/首次失败.*下次重试/).waitFor();
      await p.locator('.maintenance-status').getByText(/HTTP 403：访问受限或限流/).waitFor(); await p.locator('.maintenance-status').getByText(/HTTP 404：配置路径不存在/).waitFor();
      await p.locator('.maintenance-status').getByText(/已撤下 1 个持续失效的自动订阅/).waitFor(); await p.locator('.maintenance-status').getByText(/自动订阅撤下样例.*跨7天连续404.*下次复查/).waitFor();
      await p.locator('.maintenance-status').getByText(/低负载模式.*后台检测每 60 分钟.*订阅更新每 360 分钟.*订阅发现每 60 分钟/).waitFor();
      assert.deepEqual(app.store.config().sources, before.sources, '隔离展示不会删除或停用用户配置');
      maintenanceHealth = 'restored'; await p.getByRole('button', { name: '立即检测影视源', exact: true }).click(); await row.getByText('可用', { exact: true }).waitFor(); assert.equal(await row.getByText('已隔离', { exact: true }).count(), 0);
      await p.getByRole('button', { name: '发现新订阅', exact: true }).click(); await p.locator('.maintenance-status').getByText(/验证通过，已自动加入订阅/).waitFor();
      assert.equal(app.store.config().subscriptions.filter(item => item.id === 'discovered-fixture').length, 1, '发现结果合并配置避免重复新增');
      await p.screenshot({ path: join(output, 'desktop-maintenance-status.png'), fullPage: true }); const count = maintenance.statusReads; await p.waitForTimeout(200); assert.equal(maintenance.statusReads, count, '维护页无常驻轮询');
      console.log('PASS 隔离/失败次数/首次失败/重试与恢复状态、403/404原因、新订阅验证后自动加入刷新配置、不删除用户源及无常驻轮询');
    } finally { maintenanceHealth = false; await isolated?.value.close(); }
  }

  const cloudPath = '#quark-detail?id=1234567';
  const quarkCount = path => quarkRequests.filter(request => request.path === path).length;
  async function withCloudFixture(run) {
    const settings = structuredClone(quarkSettings), mode = quarkMode, duration = transcodeDuration, transcode = transcodeMode, configBefore = app.store.config(), pref = preferences.get(cloudFilm.key), history = app.store.get('history', cloudFilm.key), favorite = app.store.get('favorites', cloudFilm.key);
    const contexts = [];
    Object.assign(quarkSettings, { enabled: true, configured: true, autoSave: true, account: { connected: true, label: '测试账号' } });
    quarkMode = 'webm'; quarkResourceReply = null; quarkAssetPosition = 0; app.store.remove('history', cloudFilm.key);
    preferences.set(cloudFilm.key, { introSeconds: 0, outroSeconds: 0, autoNext: true, speed: 1, danmakuEnabled: false });
    async function open({ viewport = { width: 1440, height: 1000 }, clock = false, hash = cloudPath, tv = false } = {}) {
      const c = await context(viewport, true, false, '#quark', tv ? 'Mozilla/5.0 (Linux; Android 12) VIPVideoWebTV/1.0' : ''); contexts.push(c); const p = c.page;
      if (clock) { await p.clock.install(); await p.clock.pauseAt(new Date()); }
      await p.evaluate(() => {
        window.Hls = class CloudFixtureHls {
          static Events = { ERROR: 'error', MANIFEST_PARSED: 'manifest' }; static isSupported() { return true; }
          loadSource(url) { this.url = url; } attachMedia(video) { video.src = this.url.replace('.m3u8', '.mp4'); }
          on(name, callback) { if (name === 'manifest') queueMicrotask(() => callback(name, { levels: [] })); } startLoad() {} destroy() {}
        };
      });
      if (hash !== '#quark') await p.evaluate(hash => { location.hash = hash; }, hash);
      return c;
    }
    try { await run(open); }
    finally {
      holdQuarkResources = holdQuarkPrepare = holdQuarkPlayback = holdTranscode = holdQuarkFolderRepair = false;
      releaseQuarkResources?.(); releaseQuarkPrepare?.(); releaseQuarkPlayback?.(); releaseTranscode?.(); releaseQuarkFolderRepair?.();
      releaseQuarkResources = releaseQuarkPrepare = releaseQuarkPlayback = releaseTranscode = releaseQuarkFolderRepair = null;
      for (const release of heldQuarkFileReads.values()) release(); heldQuarkFileReads.clear();
      for (const c of contexts) await c.value.close();
      quarkResourceReply = null; quarkChoicesFixture = false; quarkFilesFixture = 'matched'; quarkFolderRepairFails = false; quarkAssetPosition = 0;
      Object.assign(quarkSettings, settings); quarkMode = mode; transcodeDuration = duration; transcodeMode = transcode; app.store.setConfig(configBefore);
      if (pref === undefined) preferences.delete(cloudFilm.key); else preferences.set(cloudFilm.key, pref);
      if (history) app.store.save('history', history); else app.store.remove('history', cloudFilm.key);
      if (favorite) app.store.save('favorites', favorite); else app.store.remove('favorites', cloudFilm.key);
    }
  }
  async function chooseCloudFile(p, id = 'file-1') {
    const files = p.getByLabel('夸克视频文件', { exact: true }); await files.locator(`option[value="${id}"]`).waitFor({ state: 'attached' }); await files.selectOption(id);
    await until(() => p.getByRole('button', { name: '转存所选单集', exact: true }).isEnabled(), '手动选择文件后允许转存');
  }
  async function prepareCloudFile(p, id = 'file-1') {
    await chooseCloudFile(p, id); await p.getByRole('button', { name: '转存所选单集', exact: true }).click();
    await p.locator('#quark-resources').getByRole('button', { name: '夸克播放', exact: true }).waitFor();
  }
  async function playCloudFile(p) {
    await p.locator('#quark-resources').getByRole('button', { name: '夸克播放', exact: true }).click();
    await until(() => p.locator('video').evaluate(video => video.readyState >= 2 && !video.paused && video.currentSrc.includes('/api/')).catch(() => false), '手动播放后真实playing');
    await p.locator('#quark-resources').getByRole('button', { name: '正在夸克播放', exact: true }).waitFor();
  }

  async function verifyQuarkPublicSearch() {
    await withCloudFixture(async open => {
      app.store.setConfig({ ...app.store.config(), sources: [] });
      const ordinary = playerRequests.length, probes = playabilityRequests.length, prepares = quarkCount('/api/quark/prepare'), directPosters = cloudPosterDirectReads.length;
      const { page: p } = await open({ hash: '#quark' });
      const nav = await p.locator('nav a').allTextContents(); assert.ok(nav.findIndex(text => text.includes('夸克影院')) === nav.findIndex(text => text.includes('我的收藏')) + 1);
      await p.getByRole('button', { name: '查看 夸克电影样例', exact: true }).waitFor();
      assert.equal(await p.getByLabel('夸克影片排序', { exact: true }).inputValue(), 'release-score');
      assert.deepEqual(await p.locator('#quark-library-results .card-title').allTextContents(), ['夸克新片样例', '夸克同年样例', '夸克电影样例'], '默认年份优先且同年高分在前');
      await until(() => p.locator('#quark-library-results .poster-link img').evaluateAll(images => images.length === 3 && images.every(image => image.complete && image.naturalWidth > 0)), '同源目录海报实际完成解码');
      assert.ok((await p.locator('#quark-library-results .poster-link img').evaluateAll(images => images.map(image => image.src))).every(src => new URL(src).origin === base && new URL(src).pathname === '/api/quark/library/poster'));
      await p.locator('.filter-note').getByText(/热门已上映片目.*年份优先、同年高分优先.*当前已加载/).waitFor();
      assert.match(await p.locator('#quark-library-results').textContent(), /豆瓣 7.2/);
      await p.getByLabel('夸克影片排序', { exact: true }).selectOption('release'); await until(() => p.locator('#quark-library-results .card-title').first().textContent().then(text => text === '夸克同年样例'), '热门候选按上映年份排列');
      assert.deepEqual(await p.locator('#quark-library-results .card-title').allTextContents(), ['夸克同年样例', '夸克新片样例', '夸克电影样例'], '无精确日期时同年保留热门候选原顺序');
      await p.getByLabel('夸克影片排序', { exact: true }).selectOption('score'); await until(() => p.locator('#quark-library-results .card-title').first().textContent().then(text => text === '夸克新片样例'), '评分排序交给公开目录');
      assert.deepEqual(await p.locator('#quark-library-results .card-title').allTextContents(), ['夸克新片样例', '夸克电影样例', '夸克同年样例'], '纯评分顺序独立于年份');
      await p.getByLabel('夸克影片类型', { exact: true }).selectOption('剧情'); await until(() => quarkRequests.filter(row => row.path === '/api/quark/library').at(-1).query.genre === '剧情', '类型筛选传给目录');
      await p.getByLabel('夸克上映年份', { exact: true }).selectOption('2025'); await p.getByRole('button', { name: '查看 夸克电影样例', exact: true }).waitFor();
      await p.getByLabel('夸克上映年份', { exact: true }).selectOption(''); await p.getByRole('button', { name: '加载更多影片', exact: true }).click(); await p.getByRole('button', { name: '查看 夸克下一页样例', exact: true }).waitFor();
      for (const category of ['电视剧', '动漫', '综艺']) { await p.locator('.category-tabs').getByRole('button', { name: category, exact: true }).click(); await p.getByRole('button', { name: `查看 ${cloudFilm.title}`, exact: true }).waitFor(); }
      await p.getByRole('button', { name: `查看 ${cloudFilm.title}`, exact: true }).click();
      await until(() => p.locator('.detail-poster').evaluate(image => image.complete && image.naturalWidth > 0).catch(() => false), '同源详情海报实际完成解码'); assert.match(await p.locator('.detail-poster').getAttribute('src'), /\/api\/quark\/library\/poster\?id=1234567$/);
      await p.getByText('暂无中文简介。2025年电视剧，剧情类型。', { exact: true }).waitFor(); assert.equal(await p.locator('.detail-original-description').evaluate(element => element.open), false); assert.equal(await p.getByText('An official English synopsis.', { exact: true }).isVisible(), false);
      await p.getByLabel('夸克视频文件', { exact: true }).locator('option[value="file-1"]').waitFor({ state: 'attached' });
      assert.equal(await p.locator('video').count(), 0); assert.equal(await p.getByLabel('夸克视频文件', { exact: true }).inputValue(), ''); assert.equal(await p.getByRole('button', { name: '转存所选单集', exact: true }).isDisabled(), true);
      assert.equal(quarkCount('/api/quark/prepare'), prepares, '即使autoSave开启也必须手动选文件和转存'); assert.equal(playerRequests.length, ordinary); assert.equal(playabilityRequests.length, probes, '独立目录和详情不调用普通播放或来源验证');
      await p.getByRole('button', { name: '☆ 收藏', exact: true }).click(); await p.locator('nav a[href="#favorites"]').click(); await p.getByRole('button', { name: `查看 ${cloudFilm.title}`, exact: true }).click();
      await until(() => p.evaluate(() => location.hash === '#quark-detail?id=1234567'), '收藏回到独立夸克路由');
      await p.setViewportSize({ width: 390, height: 844 }); assert.ok(await p.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 1); await p.screenshot({ path: join(output, 'mobile-quark-library-detail.png'), fullPage: true });
      const tv = await open({ tv: true, viewport: { width: 1920, height: 1080 }, hash: '#quark' }); await tv.page.locator('nav a[href="#favorites"]').focus(); await tv.page.keyboard.press('ArrowDown'); assert.equal(await tv.page.evaluate(() => document.activeElement.getAttribute('href')), '#quark'); await tv.page.keyboard.press('Enter');
      await tv.page.getByRole('button', { name: '查看 夸克电影样例', exact: true }).waitFor(); await tv.page.screenshot({ path: join(output, 'tv-quark-library.png') });
      app.store.setConfig({ ...app.store.config(), sources: ['first', 'second'].map(id => ({ id, name: id, api: `https://api.example.com/${id}`, enabled: true })) });
      const normal = await open({ hash: '#detail?source=first&id=movie' }); await until(() => normal.page.locator('.detail-poster').evaluate(image => image.complete && image.naturalWidth > 0).catch(() => false), '普通外源海报仍直连并实际解码'); assert.equal(await normal.page.locator('.detail-poster').getAttribute('src'), movie.poster); assert.equal(await normal.page.locator('#quark-resources').count(), 0);
      await normal.page.locator('#source-row').getByRole('button', { name: 'second', exact: true }).waitFor(); await normal.page.getByText('正在验证可播放来源…', { exact: true }).waitFor({ state: 'hidden' });
      await until(() => normal.page.locator('video').evaluate(video => video.readyState >= 2).catch(() => false), '普通页面后台请求完成后恢复测试配置');
      assert.equal(cloudPosterDirectReads.length, directPosters); assert.ok(cloudPosterReads.includes(cloudFilm.id));
      console.log('PASS 独立夸克影院四分类/筛选/热门年份与评分排序/分页、列表和详情同源海报实际解码/普通外源海报直连、中文缺失说明与折叠原文、收藏回跳/手机/TV；无普通源可浏览且不自动转存播放');
    });
  }

  async function verifyQuarkSearchRetry() {
    await withCloudFixture(async open => {
      Object.assign(quarkSettings, { configured: false, enabled: false, account: { connected: false } }); quarkMode = 'search-empty';
      const { page: p } = await open(); const panel = p.locator('#quark-resources'); await panel.getByText(/API 返回非 JSON/).waitFor();
      await panel.getByRole('button', { name: '连接夸克账号', exact: true }).waitFor(); const count = quarkCount('/api/quark/resources'); quarkMode = 'webm';
      await panel.getByRole('button', { name: '重试搜索', exact: true }).click(); await p.getByLabel('夸克视频文件', { exact: true }).locator('option[value="file-1"]').waitFor({ state: 'attached' });
      assert.equal(quarkCount('/api/quark/resources'), count + 1); await p.getByLabel('夸克视频文件', { exact: true }).selectOption('file-1'); assert.equal(await panel.getByRole('button', { name: '转存所选单集', exact: true }).isDisabled(), true);
      const google = new URL(await panel.getByRole('link', { name: '用浏览器查 Google ↗', exact: true }).getAttribute('href')); assert.equal(google.searchParams.get('tbs'), 'sbd:1'); assert.equal(google.searchParams.get('udm'), '14');
      await panel.getByRole('button', { name: '查找更多公开资源', exact: true }).click(); await panel.getByText(/找到新增3条可用分享/).waitFor(); assert.equal(await p.locator('video').count(), 0);
      console.log('PASS 未连接账号仍查匿名分享/文件、失败可手动重试和更多搜索、Google日期参数；个人转存保持禁用且不加载播放器');
    });
  }

  async function verifyQuarkPendingSearch() {
    await withCloudFixture(async open => {
      const old = { id: 'share-fixture', name: '已选分享', url: 'https://pan.quark.cn/s/fixture123' }, fresh = { id: 'share-new', name: '新增分享', url: 'https://pan.quark.cn/s/new123456', publishedAt: Date.UTC(2026, 8, 20) };
      const pending = extra => ({ resources: [], pending: true, retryAfterMs: 1500, ...extra });
      quarkResourceReply = pending(); const { page: p } = await open({ clock: true }); const panel = p.locator('#quark-resources'); await panel.getByText(/正在继续查找/).waitFor(); const reads = quarkCount('/api/quark/resources'), prepares = quarkCount('/api/quark/prepare');
      await p.clock.fastForward(1499); assert.equal(quarkCount('/api/quark/resources'), reads); quarkResourceReply = { resources: [old], pending: false }; await p.clock.fastForward(1);
      await p.getByLabel('夸克视频文件', { exact: true }).locator('option[value="file-1"]').waitFor({ state: 'attached' }); assert.equal(quarkCount('/api/quark/prepare'), prepares); assert.equal(await p.getByLabel('夸克视频文件', { exact: true }).inputValue(), '');
      await chooseCloudFile(p); const files = p.getByLabel('夸克视频文件', { exact: true }), shares = p.getByLabel('夸克分享资源', { exact: true }); await files.evaluate(element => { window.__cloudFiles = element; }); const fileReads = quarkCount('/api/quark/files');
      quarkResourceReply = pending(); await panel.getByRole('button', { name: '查找更多公开资源', exact: true }).click(); await panel.getByText(/正在继续查找/).waitFor();
      quarkResourceReply = { resources: [fresh], pending: false }; await p.clock.fastForward(1500); await panel.getByText(/找到新增1条可用分享/).waitFor(); assert.equal(await shares.inputValue(), old.id); assert.equal(await files.inputValue(), 'file-1'); assert.equal(await files.evaluate(element => element === window.__cloudFiles), true); assert.equal(quarkCount('/api/quark/files'), fileReads);
      await panel.getByRole('button', { name: '转存所选单集', exact: true }).click(); await panel.getByRole('button', { name: '夸克播放', exact: true }).waitFor(); assert.equal(await p.locator('video').count(), 0); await playCloudFile(p); const source = await p.locator('video').evaluate(video => video.currentSrc);
      quarkResourceReply = { resourceSnapshot: true, resources: [fresh], pending: false, reason: '旧分享已取消' }; await panel.getByRole('button', { name: '查找更多公开资源', exact: true }).click(); await panel.getByText(/旧分享已取消/).waitFor();
      assert.equal(await shares.inputValue(), ''); assert.equal(await files.isDisabled(), true); assert.equal(await panel.getByRole('button', { name: '转存所选单集', exact: true }).isDisabled(), true); assert.equal(await p.locator('video').evaluate(video => video.currentSrc), source); await panel.getByRole('button', { name: '正在夸克播放', exact: true }).waitFor();
      assert.equal(quarkCount('/api/quark/prepare'), prepares + 1); await shares.selectOption(fresh.id); await until(() => files.isEnabled(), '手选替代分享后恢复文件'); assert.equal(await files.inputValue(), '', '替代文件仍需手选');
      quarkResourceReply = pending(); await panel.getByRole('button', { name: '查找更多公开资源', exact: true }).click(); await panel.getByText(/正在继续查找/).waitFor(); quarkResourceReply = { resources: [old], pending: false }; holdQuarkResources = true; await p.clock.fastForward(1500); await until(() => Boolean(releaseQuarkResources), '旧轮询在途');
      const release = releaseQuarkResources; releaseQuarkResources = null; holdQuarkResources = false; quarkResourceReply = { resources: [], reason: '新集暂无资源' }; await p.getByLabel('夸克当前集数', { exact: true }).selectOption('1'); release(); await panel.getByText('新集暂无资源', { exact: true }).waitFor(); assert.equal(await p.locator('video').count(), 0); assert.equal(await panel.locator('option[value="share-fixture"]').count(), 0);
      for (const [validation, limit] of [[false, 60000], [true, 100000]]) {
        quarkResourceReply = pending({ validationPending: validation, retryAfterMs: 5000 }); const c = await open({ clock: true }); await c.page.locator('#quark-resources').getByText(/正在继续查找/).waitFor(); const before = quarkCount('/api/quark/resources');
        for (let i = 1; i < limit / 5000; i++) { await c.page.clock.fastForward(5000); await until(() => quarkCount('/api/quark/resources') === before + i, '有界快照轮询'); await until(() => c.page.getByRole('button', { name: '查找更多公开资源', exact: true }).isEnabled(), '快照返回'); }
        await c.page.clock.fastForward(5000); await c.page.getByText(/已暂停自动检查/).waitFor(); await c.page.clock.fastForward(60000); assert.equal(quarkCount('/api/quark/resources'), before + limit / 5000 - 1);
      }
      assert.ok(quarkRequests.filter(row => row.path === '/api/quark/resources' && row.query.poll).every(row => row.query.poll === '1')); assert.equal(quarkCount('/api/quark/prepare'), prepares + 1);
      console.log('PASS 独立夸克pending只读poll/60秒与验证100秒上限、后台命中仍手选、更多保留选择DOM、不重复准备；失效分享清旧文件但保留已存播放、切集取消迟到响应');
    });
  }

  async function verifyQuarkChoices() {
    await withCloudFixture(async open => {
      quarkChoicesFixture = true;
      for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
        quarkFilesFixture = 'hold'; const { page: p } = await open({ viewport }); const share = p.getByLabel('夸克分享资源', { exact: true }), files = p.getByLabel('夸克视频文件', { exact: true }), transfer = p.getByRole('button', { name: '转存所选单集', exact: true });
        await until(() => heldQuarkFileReads.has('share-first'), '首分享文件加载中'); assert.equal(await files.isDisabled(), true); quarkFilesFixture = 'forbidden'; await share.selectOption('share-second'); await p.getByRole('button', { name: '重试读取文件', exact: true }).waitFor(); assert.equal(await transfer.isDisabled(), true);
        heldQuarkFileReads.get('share-first')(); heldQuarkFileReads.delete('share-first'); quarkFilesFixture = 'matched'; await p.getByRole('button', { name: '重试读取文件', exact: true }).click(); await files.locator('option[value="share-second-video"]').waitFor({ state: 'attached' }); assert.equal(await files.inputValue(), '');
        await files.selectOption('share-second-video'); assert.equal(await transfer.isEnabled(), true); assert.ok(await p.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 1); await p.screenshot({ path: join(output, `${viewport.width < 640 ? 'mobile' : 'desktop'}-quark-choices.png`), fullPage: true });
        const playCalls = quarkCount('/api/quark/playback'); await transfer.click(); await p.getByRole('button', { name: '夸克播放', exact: true }).waitFor(); assert.equal(quarkCount('/api/quark/playback'), playCalls); assert.equal(await p.locator('video').count(), 0); await playCloudFile(p);
        assert.deepEqual({ source: quarkRequests.filter(row => row.path === '/api/quark/prepare').at(-1).body.source, auto: quarkRequests.filter(row => row.path === '/api/quark/prepare').at(-1).body.auto }, { source: 'quark-library', auto: false });
        await p.getByLabel('夸克当前集数', { exact: true }).selectOption('1'); await until(() => files.isEnabled(), '切集重新列文件'); quarkFilesFixture = 'account'; await share.selectOption('share-first'); await p.getByText(/夸克账号登录已失效/).waitFor(); assert.equal(await p.locator('#app-view').isVisible(), true);
      }
      console.log('PASS 独立手选文件加载/403重试/旧响应隔离、切集账号401不退出家庭登录、长标题手机桌面无溢出、手动转存完成仍须明确播放');
    });
  }

  async function verifyQuarkAutoplay() {
    await withCloudFixture(async open => {
      quarkMode = 'pending'; quarkPendingChecks = 0; const { page: p } = await open({ clock: true }); await chooseCloudFile(p); const playCalls = quarkCount('/api/quark/playback'); await p.getByRole('button', { name: '转存所选单集', exact: true }).click(); await p.getByRole('button', { name: '刷新准备状态', exact: true }).waitFor(); const prepares = quarkCount('/api/quark/prepare');
      await p.getByRole('button', { name: '查找更多公开资源', exact: true }).click(); await until(() => p.getByRole('button', { name: '查找更多公开资源', exact: true }).isEnabled(), '更多查询完成'); assert.equal(quarkCount('/api/quark/prepare'), prepares);
      await p.clock.fastForward(4999); assert.equal(quarkCount('/api/quark/prepare'), prepares); await p.clock.fastForward(1); await p.getByRole('button', { name: '夸克播放', exact: true }).waitFor(); assert.equal(quarkCount('/api/quark/prepare'), prepares + 1); assert.equal(quarkCount('/api/quark/playback'), playCalls); assert.equal(await p.locator('video').count(), 0);
      quarkMode = 'webm'; await playCloudFile(p); const endPrepares = quarkCount('/api/quark/prepare'); await p.locator('video').evaluate(video => { video.pause(); video.currentTime = video.duration - 0.1; video.dispatchEvent(new Event('ended')); }); assert.equal(quarkCount('/api/quark/prepare'), endPrepares, '结束不自动准备下一集');
      await p.getByLabel('夸克当前集数', { exact: true }).selectOption('1'); await chooseCloudFile(p, 'file-2'); holdQuarkPrepare = true; await p.getByRole('button', { name: '转存所选单集', exact: true }).click(); await until(() => Boolean(releaseQuarkPrepare), '手动转存在途'); await p.getByLabel('夸克当前集数', { exact: true }).selectOption('0'); holdQuarkPrepare = false; releaseQuarkPrepare(); releaseQuarkPrepare = null; await p.getByLabel('夸克视频文件', { exact: true }).locator('option[value="file-1"]').waitFor({ state: 'attached' }); assert.equal(await p.locator('video').count(), 0); assert.equal(await p.getByRole('button', { name: '夸克播放', exact: true }).count(), 0);
      quarkMode = 'folder-missing'; await chooseCloudFile(p); await p.getByRole('button', { name: '转存所选单集', exact: true }).click(); await p.getByRole('button', { name: '恢复专用目录并重试', exact: true }).click(); await p.getByRole('button', { name: '夸克播放', exact: true }).waitFor(); assert.equal(await p.locator('video').count(), 0);
      console.log('PASS 手动转存pending每5秒幂等复查、更多不打断准备、完成不自动播放；结束不自动转存下一集、切集隔离在途转存、目录恢复后仍须明确播放');
    });
  }

  async function verifyQuarkFlow() {
    await withCloudFixture(async open => {
      const { page: p } = await open(); await prepareCloudFile(p); await playCloudFile(p); const asset = cloudAssetId('share-fixture', 'file-1');
      await p.locator('video').evaluate(video => { video.pause(); video.currentTime = 5; video.dispatchEvent(new Event('pause')); }); await until(() => quarkProgress.some(row => row.assetId === asset && row.position === 5), '保存已选资产的真实进度');
      await until(() => app.store.get('history', cloudFilm.key)?.quarkAsset === asset, '云端历史持久化资产'); const history = app.store.get('history', cloudFilm.key); assert.equal(history.source, 'quark-library'); assert.ok(history.url === undefined || history.url === '', '历史不保存临时播放URL'); assert.match(history.episodeName, /第1集/);
      await p.locator('nav a[href="#history"]').click(); await p.getByRole('button', { name: `继续观看 ${cloudFilm.title}`, exact: true }).click(); await p.getByRole('button', { name: '继续播放已转存文件', exact: true }).waitFor(); assert.equal(await p.locator('video').count(), 0); const prepares = quarkCount('/api/quark/prepare'); await p.getByRole('button', { name: '继续播放已转存文件', exact: true }).click(); await until(() => p.locator('video').evaluate(video => video.readyState >= 2 && video.currentTime >= 5).catch(() => false), '跨路由显式继续已转存文件'); assert.equal(quarkCount('/api/quark/prepare'), prepares);
      const reports = playabilityReports.length; await p.locator('video').evaluate(video => { video.pause(); Object.defineProperty(video, 'error', { configurable: true, value: { code: 2 } }); video.dispatchEvent(new Event('error')); }); await p.locator('#quark-resources').getByRole('button', { name: '重试夸克播放', exact: true }).waitFor(); assert.equal(playabilityReports.length, reports, '云端失败不报告普通影视源');
      await p.locator('.player-toolbar').getByRole('button', { name: '返回夸克资源', exact: true }).click(); assert.equal(await p.locator('video').count(), 0); await p.getByRole('button', { name: '夸克播放', exact: true }).waitFor();
      console.log('PASS 独立夸克真实进度/32hex已存资产历史与空URL、历史显式续播不重新转存、媒体失败保留重试且不影响普通源、返回独立资源保留准备状态');
    });
  }

  async function verifyCompactSettings() {
    const before = app.store.config(); let isolated;
    try {
      isolated = await context({ width: 1440, height: 1000 }, true, false, '#settings'); const p = isolated.page;
      const panels = p.locator('details.settings-section'); await panels.first().waitFor(); assert.equal(await panels.count(), 9); assert.equal(await p.locator('details.settings-section[open]').count(), 0, '长列表默认收起');
      const desktopHeight = await p.locator('.settings-directory').evaluate(element => element.getBoundingClientRect().height); assert.ok(desktopHeight < 650, '桌面首屏为简短设置目录');
      await p.screenshot({ path: join(output, 'desktop-settings-compact.png'), fullPage: true });
      await p.setViewportSize({ width: 390, height: 844 }); const phoneHeight = await p.locator('.settings-directory').evaluate(element => element.getBoundingClientRect().height); assert.ok(phoneHeight < 850, '手机设置目录无需翻多页'); assert.ok(await p.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 1);
      await p.screenshot({ path: join(output, 'mobile-settings-compact.png'), fullPage: true });
      await panels.evaluateAll(elements => elements.forEach(element => { element.open = true; })); await p.waitForTimeout(50);
      const expandedHeight = await p.locator('.settings-directory').evaluate(element => element.getBoundingClientRect().height); assert.ok(expandedHeight > phoneHeight * 3, '折叠后高度明显少于完整展开列表');
      await panels.evaluateAll(elements => elements.forEach(element => { element.open = false; })); await p.waitForTimeout(50);
      const sources = panels.filter({ has: p.getByRole('heading', { name: '影视源', exact: true }) }); await sources.locator(':scope > summary').focus(); await p.keyboard.press('Enter'); await until(() => sources.evaluate(element => element.open), '遥控器Enter展开源分区');
      await sources.getByRole('button', { name: '＋ 添加', exact: true }).click(); const index = before.sources.length + 1;
      await p.getByLabel(`影视源 ${index} 唯一标识`, { exact: true }).fill('settings-fold-fixture'); await p.getByLabel(`影视源 ${index} 显示名称`, { exact: true }).fill('设置展开样例'); await p.getByLabel(`影视源 ${index} 地址`, { exact: true }).fill('https://api.example.com/settings-fold'); assert.equal(await sources.evaluate(element => element.open), true, '新增仍留在当前展开分区');
      await p.getByRole('button', { name: '保存全部设置', exact: true }).click(); await until(() => app.store.config().sources.some(item => item.id === 'settings-fold-fixture'), '展开分区新增正常保存'); await p.getByLabel(`影视源 ${index} 显示名称`, { exact: true }).waitFor(); assert.equal(await sources.evaluate(element => element.open), true, '保存重绘保留源分区展开'); assert.equal(await p.locator('details.settings-section[open]').count(), 1);
      await openSettingsSection(p, '影视源维护'); await sources.evaluate(element => { window.__settingsPanelBeforeRefresh = element; }); await p.getByRole('button', { name: '发现新订阅', exact: true }).click(); await until(() => sources.evaluate(element => element !== window.__settingsPanelBeforeRefresh), '后端配置刷新实际重绘设置分区'); await p.locator('.maintenance-status').getByText(/验证通过，已自动加入订阅/).waitFor(); assert.equal(await sources.evaluate(element => element.open), true, '后端配置刷新保留正在编辑分区展开'); assert.equal(await p.locator('details.settings-section[open]').count(), 2);
      await openSettingsSection(p, '夸克网盘'); await p.getByText(/Request Headers 的 Cookie 完整值，支持 Cookie: 前缀/).waitFor(); assert.equal(await p.getByLabel('夸克账号 Cookie', { exact: true }).getAttribute('type'), 'password'); assert.equal(await p.getByLabel('夸克账号 Cookie', { exact: true }).inputValue(), '');
      await p.locator('nav a[href="#home"]').click(); await p.locator('nav a[href="#settings"]').click(); await sources.locator(':scope > summary').waitFor(); assert.equal(await sources.evaluate(element => element.open), true, '返回设置保留展开选择');
      console.log(`PASS 设置目录默认折叠/按需展开、遥控Enter、新增保存与维护刷新保留展开、Cookie完整请求头帮助及手机桌面明显减高 ${JSON.stringify({ desktopHeight, phoneHeight, expandedHeight })}`);
    } finally { await isolated?.value.close(); app.store.setConfig(before); }
  }

  async function verifyLowLoadLive() {
    const previous = liveProgress; let isolated; liveProgress = { backgroundMode: 'low', probing: true, checkedStreams: 2, totalStreams: 7, reads: 0 };
    try {
      isolated = await context({ width: 1440, height: 1000 }); const p = isolated.page; await p.clock.install();
      await p.getByRole('button', { name: '电视直播', exact: true }).click(); await p.locator('.resource-progress').filter({ hasText: '已检查 2/7' }).waitFor();
      const reads = () => apiReads.filter(item => item.contextId === isolated.contextId && item.path === '/api/live').length;
      const probes = () => apiReads.filter(item => item.contextId === isolated.contextId && item.path === '/api/live/probe').length;
      const card = p.locator('.channel-card').first(); await card.waitFor(); await card.evaluate(element => { window.__lowLiveCard = element; }); assert.equal(reads(), 1); assert.equal(probes(), 0);
      await p.clock.fastForward(4000); assert.equal(reads(), 1, '低负载即使pending也不每1/3秒请求');
      await p.clock.fastForward(26000); await until(() => reads() === 2, '低负载30秒同步'); assert.equal(await card.evaluate(element => element === window.__lowLiveCard), true, '低频同步仍保留频道卡片DOM');
      await p.getByRole('button', { name: '刷新频道', exact: true }).click(); await until(() => probes() === 1, '低负载手动探测仍即时'); await until(() => p.getByRole('button', { name: '刷新频道', exact: true }).isEnabled(), '手动探测完成');
      await p.clock.fastForward(4000); assert.equal(reads(), 2, '手动刷新后仍使用30秒巡检');
      const stopped = reads(); await p.locator('nav a[href="#home"]').click(); await p.clock.fastForward(30000); assert.equal(reads(), stopped, '离开低负载直播取消同步');
      console.log('PASS 低负载直播pending仍30秒同步、首4秒单请求、保留卡片DOM、手动刷新即时与离页取消（独立时钟）');
    } finally { liveProgress = previous; await isolated?.value.close(); }
  }

  async function verifyQuarkProgressReadiness() {
    await withCloudFixture(async open => {
      quarkMode = 'requires'; quarkAssetPosition = 5; transcodeMode = 'enabled'; transcodeDuration = null; holdTranscode = true;
      const { page: p } = await open({ clock: true }); await prepareCloudFile(p); const progress = quarkProgress.length;
      assert.equal(await p.locator('video').count(), 0); await p.getByRole('button', { name: '夸克播放', exact: true }).click(); await until(() => typeof releaseTranscode === 'function', '手动兼容启动在途');
      assert.equal(transcodeStarts.at(-1).position, 5); assert.equal(quarkProgress.length, progress, '真实playing前不发duration0进度'); assert.equal(await p.getByRole('button', { name: '正在夸克播放', exact: true }).count(), 0);
      holdTranscode = false; releaseTranscode(); releaseTranscode = null; const video = p.locator('video'); const playing = () => video.evaluate(video => video.readyState >= 2 && !video.paused && video.currentSrc.includes('/api/transcode/')).catch(() => false);
      await until(playing, '未知原时长仍可真实播放'); await p.getByRole('button', { name: '正在夸克播放', exact: true }).waitFor(); await p.clock.fastForward(10000); await video.evaluate(video => { video.pause(); video.currentTime = 2; video.dispatchEvent(new Event('pause')); });
      await p.locator('.player-clock').getByText(/总时长未知/).waitFor(); assert.equal(quarkProgress.length, progress, '不能以HLS局部片长伪造原总时长');
      transcodeDuration = 1200; await p.locator('.player-toolbar').getByRole('button', { name: '重新兼容播放', exact: true }).click(); await until(playing, '原时长已知后真实播放'); const offset = transcodeStarts.at(-1).position; assert.equal(offset, 7);
      await video.evaluate(video => { video.pause(); video.currentTime = 2; video.dispatchEvent(new Event('pause')); }); await until(() => quarkProgress.slice(progress).some(body => body.position === 9 && body.duration === 1200 && body.ended === false), '本地2秒只加一次原7秒偏移');
      assert.doesNotMatch(await p.locator('#toast').textContent(), /夸克观看状态未同步|观看进度无效/);
      console.log('PASS 独立手动播放仅按所选资产续播、真实playing前不报占位进度、未知原时长不伪造HLS总长、已知时长只加一次原偏移');
    });
  }

  async function verifyQuarkStartupFailure() {
    await withCloudFixture(async open => {
      quarkMode = 'requires'; quarkAssetPosition = 281; transcodeMode = 'enabled'; transcodeDuration = 1200; holdTranscode = true;
      const ordinary = playerRequests.length, reports = playabilityReports.length, progress = quarkProgress.length, jobs = transcodeStarts.length;
      const { page: p } = await open(); await prepareCloudFile(p); const panel = p.locator('#quark-resources'); await panel.getByRole('button', { name: '夸克播放', exact: true }).click();
      await until(() => typeof releaseTranscode === 'function', '所选文件281秒兼容启动在途'); assert.equal(transcodeStarts.at(-1).position, 281); assert.equal(await panel.getByRole('button', { name: '正在夸克播放', exact: true }).count(), 0);
      transcodeMode = 'timeout'; holdTranscode = false; releaseTranscode(); releaseTranscode = null; await p.locator('.player-note').getByText(/兼容播放启动超时/).waitFor(); await panel.getByRole('button', { name: '重试夸克播放', exact: true }).waitFor();
      assert.equal(await panel.getByRole('button', { name: '返回夸克资源', exact: true }).isEnabled(), true); assert.equal(quarkProgress.length, progress);
      transcodeMode = 'enabled'; await panel.getByRole('button', { name: '重试夸克播放', exact: true }).click(); const video = p.locator('video'); await until(() => video.evaluate(video => video.readyState >= 2 && !video.paused).catch(() => false), '重试仅一任务且真实playing'); await panel.getByRole('button', { name: '正在夸克播放', exact: true }).waitFor(); assert.equal(transcodeStarts.length, jobs + 2);
      await video.evaluate(video => { video.pause(); video.currentTime = 2; video.dispatchEvent(new Event('pause')); }); await until(() => quarkProgress.slice(progress).some(body => body.position === 283 && body.duration === 1200), '281秒续播本地2秒只加一次偏移');
      await video.evaluate(video => { video.currentTime = 0; }); await p.locator('.player-toolbar').getByRole('button', { name: '返回夸克资源', exact: true }).click(); assert.equal(await p.locator('video').count(), 0); await panel.getByRole('button', { name: '夸克播放', exact: true }).waitFor();
      transcodeMode = 'not-seekable'; await panel.getByRole('button', { name: '夸克播放', exact: true }).click(); const fromBeginning = panel.getByRole('button', { name: '从头兼容播放', exact: true }); await fromBeginning.waitFor(); assert.equal(transcodeStarts.at(-1).position, 281); assert.doesNotMatch(await p.locator('.player-note').textContent(), /另一台设备/);
      const beforeReset = quarkProgress.length; transcodeMode = 'enabled'; holdTranscode = true; await fromBeginning.click(); await until(() => typeof releaseTranscode === 'function', '显式从头启动挂起'); assert.equal(transcodeStarts.at(-1).position, 0);
      await video.evaluate(video => video.dispatchEvent(new Event('pause'))); assert.equal(quarkProgress.slice(beforeReset).some(body => body.position < 281), false); assert.ok(app.store.get('history', cloudFilm.key).position >= 281, 'playing前不清零历史');
      holdTranscode = false; releaseTranscode(); releaseTranscode = null; await until(() => video.evaluate(video => video.readyState >= 2 && !video.paused).catch(() => false), '显式从头后实际playing'); await video.evaluate(video => { video.pause(); video.currentTime = 1; video.dispatchEvent(new Event('pause')); }); await until(() => quarkProgress.slice(beforeReset).some(body => body.position === 1), 'playing后才存从头进度');
      const prepares = quarkCount('/api/quark/prepare'), reads = quarkCount('/api/quark/files'); quarkMode = 'unverified'; await panel.getByRole('button', { name: '查找更多公开资源', exact: true }).click(); await panel.getByText(/固定搜索服务连接失败.*找到2条待确认链接/).waitFor(); const unknown = panel.locator('.quark-unverified'); await unknown.locator('summary').click(); assert.equal(await unknown.locator('a').count(), 2); assert.equal(await unknown.locator('img').count(), 0); assert.equal(await unknown.getByRole('link', { name: '未标注片名的分享', exact: true }).getAttribute('href'), 'https://pan.quark.cn/s/unknown123?pwd=A1b2');
      assert.equal(quarkCount('/api/quark/prepare'), prepares); assert.equal(quarkCount('/api/quark/files'), reads); assert.equal(await p.getByLabel('夸克视频文件', { exact: true }).inputValue(), 'file-1'); assert.equal(playerRequests.length, ordinary); assert.equal(playabilityReports.length, reports);
      console.log('PASS 独立281秒所选文件续播、兼容挂起不冒充playing、504重试/返回资源、进度offset一次、409需显式从头且playing前不清零；更多保留已存文件/安全待确认链接且不触普通影视源');
    });
  }

  async function verifyTvRemote() {
    const before = app.store.config(), savedQuark = structuredClone(quarkSettings); let isolated;
    const tvChannel = { id: 'tv-remote-fixture', name: '遥控直播样例', group: '测试频道', streams: [{ name: '测试直连', type: 'mp4', status: 'ok', url: 'https://fixtures.example/tv-remote.mp4?token=fixture' }] };
    channels.push(tvChannel);
    const tvOutput = resolve('.test-output'); await mkdir(tvOutput, { recursive: true });
    app.store.setConfig({ ...before, sources: ['first', 'second'].map(id => ({ id, name: id, api: `https://api.example.com/${id}`, enabled: true })), liveSources: [{ id: 'fixture-live', name: '测试直播源', url: 'https://live.example/test.m3u', enabled: true }] });
    Object.assign(quarkSettings, { enabled: true, configured: true, autoSave: false, account: { connected: true, label: '测试账号' } });
    try {
      isolated = await context({ width: 1920, height: 1080 }, true, false, '#home', 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36 VIPVideoWebTV/1.0'); const p = isolated.page;
      await p.locator('.poster-link').first().waitFor(); assert.equal(await p.locator('html').getAttribute('data-tv'), 'true');
      assert.equal(await p.evaluate(() => window.__vipTvFocus), true, '既有APK不重复安装方向键处理');
      await p.locator('nav a[href="#home"]').focus(); await p.keyboard.press('ArrowDown');
      assert.equal(await p.evaluate(() => document.activeElement.getAttribute('href')), '#search'); await p.keyboard.press('Enter');
      const search = p.locator('.search-form input'); await search.waitFor(); await until(() => search.evaluate(element => element === document.activeElement), '搜索路由把焦点交给输入框');
      await p.keyboard.type('播放器样例'); const caret = await search.evaluate(element => element.selectionStart); await p.keyboard.press('ArrowLeft');
      assert.equal(await search.evaluate(element => element === document.activeElement && element.selectionStart), caret - 1, '文字输入左右保留光标'); await p.keyboard.press('End'); await p.keyboard.press('Enter');
      const poster = p.getByRole('button', { name: '播放 播放器样例', exact: true }); await poster.waitFor(); if (!(await poster.evaluate(element => element === document.activeElement))) await p.keyboard.press('ArrowDown');
      try { await until(() => poster.evaluate(element => element === document.activeElement), '搜索结果方向键直达海报'); }
      catch (error) { console.error('TV_FOCUS_DIAGNOSTIC', await p.evaluate(() => ({ active: [document.activeElement.tagName, document.activeElement.className, document.activeElement.getAttribute('aria-label'), document.activeElement.textContent.slice(0, 60)], controls: [...document.querySelectorAll('#content button,#content input')].slice(0, 8).map(element => ({ text: element.getAttribute('aria-label') || element.textContent, box: element.getBoundingClientRect().toJSON() })) }))); throw error; }
      await p.keyboard.press('Enter');
      await until(() => p.locator('video').evaluate(video => video.readyState >= 2).catch(() => false), 'TV播放固定媒体');
      const video = p.locator('video'); await video.evaluate(video => { video.pause(); video.currentTime = 3; }); await video.focus();
      await p.keyboard.press('ArrowRight'); assert.ok(Math.abs(await video.evaluate(video => video.currentTime) - 13) < 0.5);
      await p.keyboard.press('ArrowLeft'); assert.equal(Math.round(await video.evaluate(video => video.currentTime)), 3);
      await p.keyboard.press('Enter'); await until(() => video.evaluate(video => !video.paused), '遥控确定继续播放'); await p.keyboard.press('Enter'); assert.equal(await video.evaluate(video => video.paused), true);
      await p.keyboard.press('ArrowDown'); assert.equal(await p.evaluate(() => document.activeElement.closest('.player-toolbar') !== null), true, '下键进入播放按钮');
      const position = await video.evaluate(video => video.currentTime); await p.keyboard.press('ArrowRight'); assert.equal(await video.evaluate(video => video.currentTime), position, '按钮间左右导航不快进');
      await video.focus(); await p.screenshot({ path: join(tvOutput, 'tv-player.png') });
      await p.setViewportSize({ width: 1280, height: 720 }); assert.ok(await p.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 1, '1280电视无横向溢出');
      await p.locator('nav a[href="#home"]').focus(); await p.keyboard.press('ArrowDown'); assert.equal(await p.evaluate(() => document.activeElement.getAttribute('href')), '#search', '1280电视侧栏仍可遥控');
      await video.focus(); await p.keyboard.press('ArrowDown'); assert.equal(await p.evaluate(() => document.activeElement.closest('.player-toolbar') !== null), true, '1280电视播放器按钮可达');
      const line = p.locator('.line-tabs button').first(); await line.focus(); await p.keyboard.press('ArrowDown');
      assert.equal(await p.evaluate(() => document.activeElement.closest('.episode-grid') !== null), true, '线路到剧集方向键可达');
      await p.keyboard.press('Enter'); await until(() => video.evaluate(video => video.readyState >= 2).catch(() => false), '遥控选集后恢复播放'); assert.equal(await p.evaluate(() => document.activeElement === document.body), false, '选集重绘后保留可操作焦点');
      assert.equal(await p.locator('#quark-resources').count(), 0, '普通影片详情不再加载夸克面板');
      await p.setViewportSize({ width: 1920, height: 1080 });
      await video.focus(); await p.keyboard.press('Escape'); await poster.waitFor(); await until(() => poster.evaluate(element => element === document.activeElement), '返回保留原海报焦点');
      await p.locator('nav a[href="#home"]').focus(); await p.keyboard.press('Enter'); await p.locator('.poster-link').first().waitFor();
      await p.locator('.category-tabs button').first().focus(); await p.keyboard.press('ArrowRight'); assert.equal(await p.evaluate(() => document.activeElement.textContent), '电视剧'); await p.keyboard.press('Enter');
      await p.getByRole('button', { name: '播放 星海旅途', exact: true }).waitFor(); await p.screenshot({ path: join(tvOutput, 'tv-home.png') });
      await p.locator('nav a[href="#home"]').focus(); for (let index = 0; index < 5; index++) await p.keyboard.press('ArrowDown'); await p.keyboard.press('Enter');
      await p.getByLabel('本机界面模式', { exact: true }).waitFor(); const summary = p.locator('details.settings-section > summary').first(); await summary.focus(); await p.keyboard.press('Enter');
      assert.equal(await summary.evaluate(element => element.parentElement.open), true); await p.keyboard.press('ArrowDown'); assert.equal(await p.evaluate(() => document.activeElement.tagName), 'INPUT');
      const mode = p.getByLabel('本机界面模式', { exact: true }); await mode.selectOption('standard'); assert.equal(await p.locator('html').getAttribute('data-tv'), 'false');
      await p.reload(); await mode.waitFor(); assert.equal(await p.locator('html').getAttribute('data-tv'), 'false', '本机模式重启保留'); await mode.selectOption('auto'); assert.equal(await p.locator('html').getAttribute('data-tv'), 'true');
      await p.evaluate(() => {
        window.__tvHls = [];
        class TvFixtureHls {
          static isSupported() { return true; } static Events = { ERROR: 'error', MANIFEST_PARSED: 'manifest' };
          constructor(options) { this.options = options; this.levels = [{ height: 720, bitrate: 2000000 }, { height: 1080, bitrate: 4000000 }, { height: 2160, bitrate: 12000000 }]; this.handlers = new Map(); this.selected = -1; window.__tvHls.push(this); }
          loadSource(url) { this.url = url; } attachMedia(video) { this.video = video; setTimeout(() => this.handlers.get('manifest')?.('manifest', { levels: this.levels }), 0); }
          on(event, handler) { this.handlers.set(event, handler); } startLoad(position) { this.startPosition = position; this.video.src = this.url.replace('.m3u8', '.mp4'); }
          get currentLevel() { return this.selected; } set currentLevel(level) { this.selected = level; } get autoLevelEnabled() { return this.selected === -1; } destroy() { this.destroyed = true; }
        }
        window.Hls = TvFixtureHls;
      });
      await p.evaluate(() => { location.hash = '#detail?source=first&id=ad-hls'; });
      const quality = p.getByLabel('播放画质', { exact: true }); await quality.waitFor();
      assert.deepEqual(await quality.locator('option').allTextContents(), ['自动画质', '720p', '1080p', '4K']);
      assert.equal(await p.evaluate(() => window.__tvHls.at(-1).startLevel), 1); assert.equal(await p.evaluate(() => window.__tvHls.at(-1).autoLevelEnabled), true, '1080起播保持ABR自动');
      assert.equal(await p.evaluate(() => window.__tvHls.at(-1).options.maxBufferSize), 32 * 1024 * 1024); assert.equal(await p.evaluate(() => window.__tvHls.at(-1).options.backBufferLength), 20);
      await quality.focus(); for (let index = 0; index < 3; index++) await p.keyboard.press('ArrowDown'); assert.equal(await p.evaluate(() => window.__tvHls.at(-1).currentLevel), 2);
      await p.keyboard.press('Home'); assert.equal(await p.evaluate(() => window.__tvHls.at(-1).autoLevelEnabled), true);
      await p.locator('nav a[href="#home"]').focus(); await p.keyboard.press('Enter'); await p.locator('.poster-link').first().waitFor();
      assert.equal(await p.getByLabel('播放画质', { exact: true }).count(), 0); assert.equal(await p.evaluate(() => window.__tvHls.at(-1).destroyed), true);
      await p.evaluate(() => { delete window.Hls; location.hash = '#live'; }); const channel = p.locator('.channel-card[data-channel="tv-remote-fixture"]'); await channel.waitFor(); await channel.focus(); await p.keyboard.press('Enter');
      await until(() => p.locator('video').evaluate(video => video.readyState >= 2 && !video.paused && video.currentSrc.includes('/tv-remote.mp4')).catch(() => false), 'TV频道海报确定后直接播放');
      assert.equal(await channel.locator('.channel-caption strong').evaluate(element => getComputedStyle(element).fontSize), '18px');
      for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
        const ordinary = await context(viewport); try { assert.equal(await ordinary.page.locator('html').getAttribute('data-tv'), 'false'); assert.ok(await ordinary.page.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 1); } finally { await ordinary.value.close(); }
      }
      console.log('PASS 既有Android TV UA自动适配、侧栏/搜索/分类/海报/剧集/夸克/设置Dpad、输入caret、播放器确定与seek/按钮导航、返回焦点、本机切换与手机桌面；HLS有限缓冲/1080起播ABR/实际清晰度切换与释放');
    } finally { await isolated?.value.close(); app.store.setConfig(before); Object.assign(quarkSettings, savedQuark); channels.splice(channels.indexOf(tvChannel), 1); }
  }

  if (process.argv.includes('--quark-library-only')) await verifyQuarkPublicSearch();
  else if (process.argv.includes('--quark-only')) { for (const verify of [verifyQuarkPublicSearch, verifyQuarkSearchRetry, verifyQuarkPendingSearch, verifyQuarkChoices, verifyQuarkAutoplay, verifyQuarkFlow, verifyQuarkProgressReadiness, verifyQuarkStartupFailure]) await verify(); }
  else if (process.argv.includes('--quark-playback-only')) { for (const verify of [verifyQuarkFlow, verifyQuarkProgressReadiness, verifyQuarkStartupFailure]) await verify(); }
  else if (process.argv.includes('--quark-progress-only')) await verifyQuarkProgressReadiness();
  else if (process.argv.includes('--quark-search-only')) {
    app.store.setConfig({ ...app.store.config(), sources: ['first', 'second'].map((id, index) => ({ id, name: ['第一源', '第二源'][index], api: `https://api.example.com/${id}`, enabled: true })) });
    for (const verify of [verifyQuarkPublicSearch, verifyQuarkPendingSearch, verifyQuarkAutoplay]) { app.store.remove('history', cloudFilm.key); await verify(); }
  }
  else if (process.argv.includes('--quark-startup-only')) await verifyQuarkStartupFailure();
  else if (process.argv.includes('--tv-only')) await verifyTvRemote();
  else {
  const { page } = await context({ width: 1440, height: 1000 });
  await page.locator('.notice').filter({ hasText: '还没有影视源' }).waitFor();
  assert.equal(vendorReads.length, 0, '首页不预加载HLS组件');
  assert.equal(apiReads.filter(item => item.contextId === 1 && item.path === '/api/config').length, 1, '登录启动不重复读取配置');
  assert.equal(apiReads.filter(item => item.contextId === 1 && item.path === '/api/state').length, 1, '登录启动不重复读取共享记录');
  assert.equal(await page.getByRole('button', { name: '三级', exact: true }).count(), 0, '默认隐藏三级分类');
  await page.screenshot({ path: join(output, 'desktop-home.png'), fullPage: true });
  console.log('PASS 桌面登录与初始空配置');

  await page.locator('nav a[href="#settings"]').click();
  await openSettingsSection(page, '导入资源配置');
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
  await openSettingsSection(page, '影视源'); await page.getByLabel('影视源 1 地址', { exact: true }).fill('api.example.com/first?tag=1&amp;x=2');
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
  holdDoomedProbe = holdDoomedMedia = true;
  try {
    await page.locator('#browse-results').getByRole('button', { name: '播放 有限重试', exact: true }).click();
    await until(() => releaseDoomedProbes.length > 0 && typeof releaseDoomedMedia === 'function', '第四源验证在途，首源媒体暂缓失败');
    assert.equal(await page.locator('#source-row').getByRole('button', { name: '第四源', exact: true }).count(), 0, '未验证来源不提前显示');
    holdDoomedMedia = false; releaseDoomedMedia(); releaseDoomedMedia = null;
    await until(() => page.locator('.player-note').textContent().then(text => text.includes('自动尝试已结束')).catch(() => false), '失败源有限自动重试', 20000);
    const attempted = new Set(playerRequests.filter(url => new URL(url).searchParams.get('id') === 'doomed').map(url => new URL(url).searchParams.get('source')));
    assert.deepEqual([...attempted], ['first', 'second', 'third'], '每轮自动最多三个源，每个源一次');
    assert.ok(transcodeStarts.some(request => request.id === 'doomed'), '兼容请求已创建新播放代次并失败');
    holdDoomedProbe = false; for (const release of releaseDoomedProbes.splice(0)) release();
    await page.locator('#source-row').getByRole('button', { name: '第四源', exact: true }).waitFor();
    console.log('PASS 详情接口失败换源、最多三个源自动尝试、兼容失败换代后迟到验证仍保留手动来源');
  } catch (error) {
    console.error('第四源验证诊断', JSON.stringify({ sourceRow: await page.locator('#source-row').evaluate(element => element.outerHTML).catch(cause => cause.message), note: await page.locator('.player-note').textContent().catch(cause => cause.message), probes: playabilityRequests.filter(request => request.id === 'doomed'), reports: playabilityReports.filter(request => request.id === 'doomed'), probeActive, probeMax, transcodes: transcodeStarts.filter(request => request.id === 'doomed') }));
    throw error;
  } finally { holdDoomedProbe = holdDoomedMedia = false; releaseDoomedMedia?.(); releaseDoomedMedia = null; for (const release of releaseDoomedProbes.splice(0)) release(); }

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
    window.__hlsLoads = [];
    let constructor;
    Object.defineProperty(window, 'Hls', { configurable: true, get: () => constructor, set: RealHls => {
      window.__actualHlsSupported = RealHls.isSupported();
      constructor = class extends RealHls { loadSource(url) { window.__hlsLoads.push(url); super.loadSource(url); } };
    } });
    const nativeCanPlayType = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = function (type) { return type === 'application/vnd.apple.mpegurl' ? 'maybe' : nativeCanPlayType.call(this, type); };
  });
  assert.equal(vendorReads.filter(item => item.contextId === priority.contextId).length, 0, '普通页面不下载HLS组件');
  holdVendor = true;
  await priority.page.evaluate(() => { location.hash = '#detail?source=first&id=hls-priority'; });
  await until(() => releaseVendor, '首次HLS按需加载组件');
  await priority.page.locator('#episodes .episode-grid').getByRole('button', { name: '第2集', exact: true }).click();
  await until(() => playerRequests.some(url => new URL(url).searchParams.get('id') === 'hls-priority' && new URL(url).searchParams.get('episode') === '1'), '组件加载时第二个播放请求');
  holdVendor = false; releaseVendor(); releaseVendor = null;
  try { await until(() => priority.page.evaluate(() => window.__hlsLoads.some(url => url.includes('hls-priority-first-2.m3u8'))), 'MSE可用时优先Hls.js'); }
  catch (error) { console.error('LAZY_HLS_DEBUG', JSON.stringify({ page: await priority.page.evaluate(() => ({ hls: typeof window.Hls, loads: window.__hlsLoads, supported: window.__actualHlsSupported, note: document.querySelector('.player-note')?.textContent, scripts: [...document.scripts].map(script => script.src), src: document.querySelector('video')?.currentSrc })), requests: playerRequests.filter(url => new URL(url).searchParams.get('id') === 'hls-priority'), vendor: vendorReads, errors })); throw error; }
  assert.equal(await priority.page.evaluate(() => window.__hlsLoads.some(url => url.includes('hls-priority-first-1.m3u8'))), false, '旧播放请求不能在组件加载后接管');
  assert.equal(await priority.page.evaluate(() => window.__actualHlsSupported), true, '此回归需要真实MSE支持');
  assert.equal(vendorReads.filter(item => item.contextId === priority.contextId).length, 1, '首次HLS播放只下载一次组件');
  assert.equal(await priority.page.locator('video').evaluate(video => video.canPlayType('application/vnd.apple.mpegurl')), 'maybe');
  assert.ok(!(await priority.page.locator('video').getAttribute('src') || '').includes('.m3u8'), '不能把native maybe当作优先直连HLS的依据');
  await priority.value.close();
  console.log('PASS native HLS声明maybe时仍优先真实Hls.js分支（仅选择逻辑）');

  async function setAdultVisible(target, enabled) {
    await target.locator('nav a[href="#settings"]').click();
    await openSettingsSection(target, '分类显示');
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
  await openSettingsSection(page, '影视源订阅');
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
  await openSettingsSection(page, '电视直播源');
  await liveSources.getByRole('button', { name: '＋ 添加', exact: true }).click();
  await page.getByLabel('电视直播源 1 唯一标识', { exact: true }).fill('fixture-live');
  await page.getByLabel('电视直播源 1 显示名称', { exact: true }).fill('测试直播源');
  await page.getByLabel('电视直播源 1 地址', { exact: true }).fill('https://live.example/test.m3u');
  await page.getByRole('button', { name: '保存全部设置', exact: true }).click();
  await until(() => app.store.config().liveSources?.length === 1 && app.store.config().subscriptions?.length === 2, '直播源与订阅持久配置');
  assert.deepEqual(app.store.config().subscriptions.map(item => [item.id, item.enabled]), [['extra-subscription', false], ['main-subscription', true]]);
  assert.equal(app.store.config().showAdult, false, '新增配置不能覆盖共享显示偏好');
  await openSettingsSection(page, '影视源维护');
  await page.getByRole('button', { name: '立即检测影视源', exact: true }).click();
  await until(() => page.locator('.maintenance-status').textContent().then(text => text.includes('固定检测失败')), '检测结果持久展示');
  assert.equal(maintenance.probeCount, 1);
  await page.getByRole('button', { name: '立即更新订阅', exact: true }).click();
  await until(() => app.store.config().sources.some(item => item.id === 'subscription-imported'), '订阅按标识新增影视源');
  await until(() => page.getByLabel('影视源 5 显示名称', { exact: true }).inputValue().then(value => value === '订阅导入源').catch(() => false), '订阅更新后刷新可编辑配置');
  await page.locator('.maintenance-status').getByText(/最近订阅更新/).waitFor();
  assert.match(await page.locator('.maintenance-status').textContent(), /最近订阅更新/);
  await page.getByRole('button', { name: '发现新订阅', exact: true }).click();
  await until(() => app.store.config().subscriptions.some(item => item.id === 'discovered-fixture'), '公开订阅发现自动加入配置');
  await until(() => page.getByLabel('影视源订阅 3 显示名称', { exact: true }).inputValue().then(value => value === '新发现订阅样例').catch(() => false), '发现后刷新设置草稿');
  assert.equal(maintenance.discoverCount, 1);
  await page.locator('.maintenance-status').getByText(/新增 1 个订阅/).waitFor();
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
  assert.ok(liveRequests.filter(url => url.endsWith('/api/live/probe')).length >= 2, '手动刷新探测下一批线路');
  assert.ok(liveRequests.some(url => new URL(url).pathname === '/api/live' && new URL(url).searchParams.get('verified') === '1'), '进入直播先快速读取已验证频道');
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

  transcodeMode = 'enabled';
  preferences.set(compatibilityFilm.key, { introSeconds: 60, outroSeconds: 10, autoNext: true, speed: 1, danmakuEnabled: true });
  comments.set(episodeKey(compatibilityFilm.key, '第1集'), [{ id: 'offset-comment', time: 62, text: '原片六十二秒样例', origin: 'family' }]);
  const compat = await context({ width: 1440, height: 1000 }); const cp = compat.page;
  // 此适配器仅将固定任务URL交给原生WAV媒体事件；真实HLS解码由独立Hls.js/FFmpeg验收覆盖。
  await cp.evaluate(() => {
    const realHls = window.Hls;
    window.Hls = class FixtureHls {
      static Events = realHls.Events;
      static isSupported() { return true; }
      loadSource(url) { this.url = url; }
      attachMedia(video) { video.src = this.url.replace(/(\/api\/transcode\/fixture-\d+\/index)\.m3u8$/, '$1.mp4'); }
      on(event, callback) { if (event === realHls.Events.MANIFEST_PARSED) queueMicrotask(() => callback(event)); }
      destroy() {}
    };
  });
  const searchCompat = async title => {
    await cp.locator('nav a[href="#search"]').click(); await cp.getByLabel('影片名称', { exact: true }).fill(title);
    await cp.getByRole('button', { name: '搜索', exact: true }).click(); await cp.getByRole('button', { name: `播放 ${title}`, exact: true }).click();
  };
  const decodedCompat = async () => !await cp.locator('.player-note').textContent().then(value => value.includes('正在准备兼容播放')).catch(() => true) && cp.locator('video').evaluate((video, id) => video.readyState >= 2 && video.currentSrc.includes(`/api/transcode/${id}/`), `fixture-${transcodeStarts.length}`).catch(() => false);
  const compatStart = transcodeStarts.length;
  await searchCompat(compatibilityFilm.title);
  try { await until(decodedCompat, '直连/代理失败后自动兼容播放', 20000); }
  catch (error) { console.error('COMPAT_DEBUG', JSON.stringify({ starts: transcodeStarts.slice(compatStart), stops: transcodeStops, note: await cp.locator('.player-note').textContent(), video: await cp.locator('video').evaluate(video => ({ src: video.currentSrc, ready: video.readyState, error: video.error?.message, time: video.currentTime })).catch(() => null) })); throw error; }
  assert.equal(transcodeStarts.length, compatStart + 1, '自动转码仅一次');
  assert.equal(transcodeStarts.at(-1).position, 60, '首个兼容任务直接跳过片头');
  assert.equal(transcodeStarts.at(-1).speed, 1);
  assert.ok(playabilityReports.some(value => value.id === 'compatibility' && value.status === 'error'), '原流全部失败仍允许受限转码');
  const originalReports = playabilityReports.length;
  await cp.locator('video').evaluate(async video => { video.pause(); video.currentTime = 2; await video.play(); video.dispatchEvent(new Event('timeupdate')); });
  await cp.getByText('原片六十二秒样例', { exact: true }).waitFor();
  await cp.getByLabel('家庭弹幕', { exact: true }).fill('兼容原片时间'); await cp.getByRole('button', { name: '发送弹幕', exact: true }).click();
  await until(() => comments.get(episodeKey(compatibilityFilm.key, '第1集')).some(value => value.text === '兼容原片时间' && value.time >= 62 && value.time < 65), '兼容弹幕按原片绝对时间');
  await cp.locator('video').evaluate(video => video.pause());
  await until(() => app.store.list('history').some(value => value.key === compatibilityFilm.key && value.position >= 62 && value.duration === 1200), '兼容保存原片进度和总时长');
  assert.match(await cp.locator('.player-clock').textContent(), /软件兼容播放/);
  assert.equal(playabilityReports.length, originalReports, '转码成功不报告原始URL可播');
  await cp.screenshot({ path: join(output, 'desktop-compatible-player.png'), fullPage: true });
  await cp.setViewportSize({ width: 390, height: 844 });
  assert.ok(await cp.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 1, '手机兼容播放控件不能横向溢出');
  await cp.screenshot({ path: join(output, 'mobile-compatible-player.png'), fullPage: true });
  await cp.setViewportSize({ width: 1440, height: 1000 });
  await cp.getByRole('button', { name: '快进 10 秒', exact: true }).click(); await until(decodedCompat, '兼容快进重新启动');
  assert.ok(transcodeStarts.at(-1).position >= 72 && transcodeStarts.at(-1).position < 75, '快进使用offset+当前时间');
  await cp.locator('video').evaluate(video => video.pause());
  await cp.getByRole('button', { name: '快退 10 秒', exact: true }).click(); await until(decodedCompat, '兼容快退重新启动');
  assert.ok(transcodeStarts.at(-1).position >= 62 && transcodeStarts.at(-1).position < 66);
  await cp.locator('video').evaluate(video => video.pause());
  await cp.getByLabel('播放速度', { exact: true }).selectOption('3'); await until(decodedCompat, '兼容倍速按原片位置重启');
  assert.equal(transcodeStarts.at(-1).speed, 3); assert.equal(await cp.locator('video').evaluate(video => video.playbackRate), 3);
  await cp.getByLabel('原片进度', { exact: true }).fill('100'); await cp.getByLabel('原片进度', { exact: true }).dispatchEvent('change'); await until(decodedCompat, '原片进度条重新定位');
  assert.equal(transcodeStarts.at(-1).position, 100);
  await cp.locator('video').evaluate(video => { video.currentTime = 4; video.pause(); });
  await until(() => app.store.list('history').some(value => value.key === compatibilityFilm.key && value.position >= 104 && value.position < 108), '原生控件relative seek不重复加offset');
  const stoppedJob = await cp.locator('video').evaluate(video => new URL(video.currentSrc).pathname.split('/')[3]);
  await cp.locator('nav a[href="#home"]').click(); await until(() => transcodeStops.some(value => value.id === stoppedJob), '离开兼容播放器停止任务');
  await cp.getByRole('button', { name: `继续观看 ${compatibilityFilm.title}`, exact: true }).click(); await until(decodedCompat, '兼容影片续播');
  assert.ok(transcodeStarts.at(-1).position >= 104, '续播不从片段4秒开始');
  console.log('PASS 兼容自动回退仅一次、原片offset进度/总时长/弹幕/原生seek/续播、片头和3倍速、原流状态隔离');

  await cp.locator('nav a[href="#home"]').click();
  transcodeAcceleration = 'vaapi'; transcodeDuration = null;
  await searchCompat(controlsFilm.title); await until(() => cp.locator('video').evaluate(video => video.readyState >= 2).catch(() => false), '正常影片手动兼容前');
  await cp.locator('video').evaluate(video => { video.currentTime = 8; video.pause(); });
  const manualReports = playabilityReports.length;
  await cp.getByRole('button', { name: '兼容播放', exact: true }).click(); await until(decodedCompat, '手动硬件兼容播放');
  assert.ok(transcodeStarts.at(-1).position >= 8 && transcodeStarts.at(-1).position < 10);
  assert.match(await cp.locator('.player-clock').textContent(), /硬件兼容播放.*总时长未知/);
  assert.equal(await cp.getByLabel('原片进度', { exact: true }).isVisible(), false);
  await cp.getByLabel('自动下一集', { exact: true }).check(); await cp.getByLabel('跳过片尾（秒）', { exact: true }).fill('10');
  const unknownEpisode = transcodeStarts.at(-1).episode;
  await cp.locator('video').evaluate(async video => { video.currentTime = 25; await video.play(); video.dispatchEvent(new Event('timeupdate')); }); await cp.waitForTimeout(150); await cp.locator('video').evaluate(video => video.pause());
  assert.equal(transcodeStarts.at(-1).episode, unknownEpisode, '未知总时长不能把HLS窗口当片尾');
  await until(() => app.store.list('history').some(value => value.key === controlsFilm.key && value.duration === 0 && value.position >= 33), '未知原片时长保存0');
  assert.equal(playabilityReports.length, manualReports, '手动兼容不更新原流可播状态');
  await cp.locator('#source-row').getByRole('button', { name: '第二源', exact: true }).click();
  await until(() => cp.locator('video').evaluate(video => video.readyState >= 1 && video.currentSrc.includes('controls-second')).catch(() => false), '兼容后仍可按集名手动换源');
  assert.ok(app.store.list('history').some(value => value.key === controlsFilm.key && value.source === 'second'), '换源恢复正常线路记录');
  console.log('PASS 手动硬件兼容、未知时长不跳片尾/不误保存HLS窗口、按集名换源与任务清理');

  await cp.locator('video').evaluate(video => video.pause());
  transcodeMode = 'busy'; const busyCount = transcodeStarts.length;
  await cp.getByRole('button', { name: '兼容播放', exact: true }).click(); await cp.getByText('兼容播放正被另一台设备使用，请稍后再试。', { exact: true }).waitFor();
  await cp.waitForTimeout(150); assert.equal(transcodeStarts.length, busyCount + 1, '409不自动重复任务');
  transcodeMode = 'enabled'; holdTranscode = true; const pendingStart = transcodeStarts.length;
  await cp.getByRole('button', { name: '兼容播放', exact: true }).click(); await until(() => transcodeStarts.length > pendingStart && releaseTranscode, '兼容启动请求在途');
  await cp.locator('nav a[href="#home"]').click(); holdTranscode = false; releaseTranscode(); releaseTranscode = null;
  await until(() => transcodeStops.some(value => value.id === `fixture-${transcodeStarts.length}`), '取消旧启动响应也停止任务');
  assert.equal(await cp.locator('video').count(), 0, '旧转码请求不能接管首页');
  await searchCompat(movie.title); await until(() => cp.locator('video').evaluate(video => video.readyState >= 1).catch(() => false), 'pagehide兼容样例');
  await cp.getByRole('button', { name: '兼容播放', exact: true }).click(); await until(decodedCompat, 'pagehide前任务');
  const pagehideJob = `fixture-${transcodeStarts.length}`; await cp.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await until(() => transcodeStops.some(value => value.id === pagehideJob), 'pagehide keepalive停止兼容任务');
  await searchCompat(movie.title); await until(() => cp.locator('video').evaluate(video => video.readyState >= 1).catch(() => false), '过期恢复样例');
  await cp.getByRole('button', { name: '兼容播放', exact: true }).click(); await until(decodedCompat, '过期恢复前任务');
  await cp.clock.install(); await cp.locator('video').evaluate(video => video.pause());
  const expiryCount = transcodeStarts.length; await cp.clock.fastForward(120001);
  await cp.locator('video').evaluate(video => { void video.play().catch(() => {}); });
  await until(() => transcodeStarts.length === expiryCount + 1 && decodedCompat(), '暂停超时只恢复一次兼容任务');
  await cp.locator('video').evaluate(video => video.pause()); await cp.clock.fastForward(120001);
  await cp.locator('video').evaluate(video => { void video.play().catch(() => {}); }); await cp.waitForTimeout(150);
  assert.equal(transcodeStarts.length, expiryCount + 1, '过期恢复不能无限自动重启');
  await cp.locator('video').evaluate(video => video.pause());
  await cp.request.delete(`${base}/api/history?${new URLSearchParams({ key: broken.key })}`);
  await cp.locator('nav a[href="#home"]').click(); await cp.getByRole('button', { name: '电视剧', exact: true }).click();
  playableResults.delete(JSON.stringify(['first', 'broken', 1, 0])); playableResults.delete(JSON.stringify(['first', 'broken', 2, 0]));
  holdCandidateSearch = true; const pendingFallbackRequests = playerRequests.length;
  await cp.getByRole('button', { name: `播放 ${broken.title}`, exact: true }).click();
  await until(async () => releaseCandidateSearch && (await cp.locator('.player-note').textContent()).includes('正在查找其他影视源'), '旧自动换源搜索等待中');
  await cp.getByRole('button', { name: '兼容播放', exact: true }).click(); await until(decodedCompat, '旧搜索等待时手动兼容');
  holdCandidateSearch = false; releaseCandidateSearch(); releaseCandidateSearch = null;
  await cp.waitForTimeout(250); assert.equal(await decodedCompat(), true, '旧自动换源响应不能接管兼容播放器');
  assert.equal(playerRequests.slice(pendingFallbackRequests).some(url => new URL(url).searchParams.get('source') === 'second'), false, '旧换源请求已失效');
  console.log('PASS 兼容占用409不循环、导航取消在途任务、pagehide停止、暂停过期单次恢复与旧响应隔离');

  await cp.locator('nav a[href="#home"]').click(); await cp.getByRole('button', { name: '电视直播', exact: true }).click();
  const beforeLiveDecode = liveReports.length;
  await cp.getByRole('button', { name: '播放频道 测试电视一', exact: true }).click();
  await until(async () => liveReports.length > beforeLiveDecode && await cp.locator('video').evaluate(video => video.readyState >= 2).catch(() => false), '直播手动兼容前');
  const liveRecordCount = app.store.list('history').length, liveReportCount = liveReports.length;
  await cp.getByRole('button', { name: '兼容播放', exact: true }).click(); await until(decodedCompat, '直播手动兼容播放');
  assert.deepEqual(transcodeStarts.at(-1), { liveId: 'test-tv-one', line: 1, position: 0, speed: 1 });
  assert.equal(await cp.getByLabel('播放速度', { exact: true }).isDisabled(), true);
  assert.equal(await cp.getByRole('button', { name: '快进 10 秒', exact: true }).isDisabled(), true);
  assert.equal(await cp.locator('.danmaku-form').count(), 0);
  assert.equal(liveReports.length, liveReportCount, '转码成功不更新直播原流可播状态');
  assert.equal(app.store.list('history').length, liveRecordCount, '兼容直播不写影视续播记录');
  channels[1].streams[0].url = 'https://fixtures.example/fail-live-two.m3u8'; channels[1].streams[0].type = 'hls'; channels[1].streams[0].status = 'ok';
  const liveFallbackCount = transcodeStarts.length;
  await cp.locator('.channel-button').filter({ hasText: '测试电视二' }).click(); await until(() => transcodeStarts.length === liveFallbackCount + 1 && decodedCompat(), '直播直连和代理均失败后兼容');
  assert.deepEqual(transcodeStarts.at(-1), { liveId: 'test-tv-two', line: 0, position: 0, speed: 1 });
  assert.ok(liveReports.some(value => value.id === 'test-tv-two' && value.status === 'error'));
  assert.equal(app.store.list('history').length, liveRecordCount);
  const logoutJob = `fixture-${transcodeStarts.length}`; await cp.locator('#logout').click(); await cp.locator('#login-view').waitFor({ state: 'visible' });
  await until(() => transcodeStops.some(value => value.id === logoutJob), '退出登录停止直播兼容任务');
  await compat.value.close(); transcodeDuration = 1200; transcodeAcceleration = 'software'; transcodeMode = 'disabled';
  console.log('PASS 直播手动/最后兼容回退、稳定线路编号与0起点1倍速、原流状态隔离、无影视进度/弹幕、退出停止');

  holdState = true;
  await page.evaluate(() => { location.hash = '#home?category=movie&source=first'; });
  await page.locator('#browse-results').getByRole('button', { name: '播放 海风来信', exact: true }).waitFor();
  await until(() => releaseStates.length > 0, '共享记录请求等待中');
  const movieReads = () => apiReads.filter(item => item.contextId === 1 && item.path === '/api/browse' && new URL(item.url).searchParams.get('category') === 'movie' && new URL(item.url).searchParams.get('source') === 'first').length;
  const browseBeforeReturn = movieReads();
  const firstPoster = page.locator('#browse-results img').first();
  assert.equal(await firstPoster.getAttribute('loading'), 'eager'); assert.equal(await firstPoster.getAttribute('decoding'), 'async');
  await page.locator('nav a[href="#favorites"]').click();
  await page.locator('nav a[href="#home"]').click();
  await page.evaluate(() => { location.hash = '#home?category=movie&source=first'; });
  await page.locator('#browse-results').getByRole('button', { name: '播放 海风来信', exact: true }).waitFor();
  assert.equal(movieReads(), browseBeforeReturn, '短时返回同一分类复用结果，不重复请求');
  holdState = false; for (const release of releaseStates.splice(0)) release();
  await page.locator('.home-collections').getByRole('button', { name: '播放 星海旅途', exact: true }).waitFor();
  assert.equal(vendorReads.filter(item => item.contextId === 1).length, 0, '原生MP4与普通页面无需HLS组件');
  console.log('PASS 首页分类不等待共享记录、登录无重复配置/记录请求、短时分类缓存与首屏异步海报优先、MP4零HLS下载');

  await page.clock.fastForward(31000); progressiveBrowse = { reads: 0, complete: false };
  await page.evaluate(() => { location.hash = '#home?category=anime'; });
  await page.locator('#browse-results').getByRole('button', { name: '播放 动画旅人', exact: true }).waitFor();
  await page.locator('.resource-progress').waitFor();
  await page.clock.fastForward(1000); await until(() => progressiveBrowse.reads >= 2, '分类共用任务继续渐进返回');
  const pendingBrowseReads = progressiveBrowse.reads;
  await page.locator('nav a[href="#home"]').click(); await page.locator('#browse-results').getByRole('button', { name: '播放 海风来信', exact: true }).waitFor(); await page.clock.fastForward(3000);
  assert.equal(progressiveBrowse.reads, pendingBrowseReads, '离开分类不继续轮询');
  progressiveBrowse.complete = true;
  await page.evaluate(() => { location.hash = '#home?category=anime'; });
  await page.getByRole('button', { name: '播放 动画后到样例', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '播放 动画旅人', exact: true }).count(), 1, '渐进分组合并不重复');
  assert.equal(await page.locator('.resource-progress').count(), 0);
  progressiveSearch = { reads: 0, complete: false };
  await page.locator('nav a[href="#search"]').click(); await page.getByLabel('影片名称', { exact: true }).fill('渐进'); await page.getByRole('button', { name: '搜索', exact: true }).click();
  await page.getByRole('button', { name: '播放 渐进先到样例', exact: true }).waitFor(); await page.locator('.resource-progress').waitFor();
  await page.getByRole('button', { name: '播放 渐进先到样例', exact: true }).click();
  await until(() => page.locator('video').evaluate(video => video.readyState >= 2 && video.currentSrc.includes('progressive-fast')).catch(() => false), '慢源完成前先到影片即可播放');
  const pendingSearchReads = progressiveSearch.reads; await page.locator('nav a[href="#home"]').click(); await page.clock.fastForward(3000);
  assert.equal(progressiveSearch.reads, pendingSearchReads, '进入播放器或离开搜索取消渐进轮询');
  progressiveSearch.complete = true;
  await page.evaluate(() => { location.hash = '#search?q=%E6%B8%90%E8%BF%9B'; });
  await page.getByRole('button', { name: '播放 渐进后到样例', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '播放 渐进先到样例', exact: true }).count(), 1);
  progressiveBrowse = null; progressiveSearch = null;
  console.log('PASS 分类/搜索先显示快源、pending提示、后续结果去重合并、慢源完成前可播放、离页停止渐进请求');

  facetScenario = true;
  const facetsContext = await context({ width: 1440, height: 1000 }, true, false, '#home?category=movie&genre=%E5%96%9C%E5%89%A7'); const fp = facetsContext.page;
  await fp.getByRole('button', { name: '播放 喜剧春日样例', exact: true }).waitFor();
  assert.equal(await fp.getByLabel('影片类型', { exact: true }).inputValue(), '喜剧');
  assert.ok(await fp.getByLabel('上映年份', { exact: true }).locator('option[value="1960"]').count(), '可以主动选择早期影片年份');
  await fp.getByLabel('影片排序', { exact: true }).selectOption('release');
  await fp.locator('.filter-note').waitFor();
  const facetTitles = () => fp.locator('#browse-results .card-title').allTextContents();
  await until(async () => (await facetTitles()).join('|') === '喜剧春日样例|喜剧老片样例|喜剧日期未知样例', '首批按真实上映日期排序，未知日期末尾');
  await fp.getByRole('button', { name: '加载更多', exact: true }).click();
  await until(async () => (await facetTitles()).join('|') === '喜剧新片样例|喜剧春日样例|喜剧老片样例|喜剧日期未知样例', '第二页合并后重新按日期排序');
  await fp.getByLabel('上映年份', { exact: true }).selectOption('2025');
  await until(async () => (await facetTitles()).join('|') === '喜剧春日样例', '更改年份重置分页');
  assert.equal(new URLSearchParams(new URL(fp.url()).hash.split('?')[1]).get('year'), '2025');
  for (const category of ['电视剧', '动漫']) {
    await fp.getByRole('button', { name: category, exact: true }).click();
    await fp.getByRole('button', { name: '播放 喜剧春日样例', exact: true }).waitFor();
    assert.equal(await fp.getByLabel('影片类型', { exact: true }).inputValue(), '喜剧'); assert.equal(await fp.getByLabel('上映年份', { exact: true }).inputValue(), '2025'); assert.equal(await fp.getByLabel('影片排序', { exact: true }).inputValue(), 'release');
  }
  await fp.getByLabel('浏览影视源', { exact: true }).selectOption('second');
  await until(() => fp.locator('#browse-results .card-meta').first().textContent().then(text => text.includes('1 个来源')), '换影视源保留筛选且缩至指定来源');
  assert.equal(catalogRequests.at(-1).page, 1); assert.equal(catalogRequests.at(-1).genre, '喜剧'); assert.equal(catalogRequests.at(-1).year, '2025'); assert.equal(catalogRequests.at(-1).sort, 'release');
  await fp.getByLabel('上映年份', { exact: true }).selectOption(''); await fp.getByLabel('影片排序', { exact: true }).selectOption('year');
  await until(async () => (await facetTitles()).join('|') === '喜剧日期未知样例|喜剧春日样例|喜剧老片样例', '按年份降序且不依赖完整上映日期');
  for (const [genre, title] of [['惊悚', '惊悚旧片样例'], ['恐怖', '恐怖旧片样例']]) {
    await fp.getByLabel('影片类型', { exact: true }).selectOption(genre);
    await until(async () => (await facetTitles()).join('|') === title, `${genre}类型筛选`);
    assert.equal(await fp.getByRole('button', { name: '加载更多', exact: true }).isVisible(), false);
  }
  await fp.getByLabel('影片类型', { exact: true }).selectOption('喜剧'); await fp.getByLabel('上映年份', { exact: true }).selectOption('1960');
  await fp.getByRole('button', { name: '电影', exact: true }).click(); await fp.getByRole('button', { name: '播放 喜剧老片样例', exact: true }).waitFor();
  await fp.screenshot({ path: join(output, 'desktop-catalog-filters.png'), fullPage: true });
  await fp.setViewportSize({ width: 390, height: 844 }); assert.ok(await fp.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 1, '手机筛选布局无横向溢出'); await fp.screenshot({ path: join(output, 'mobile-catalog-filters.png'), fullPage: true });
  await fp.getByRole('button', { name: '播放 喜剧老片样例', exact: true }).click();
  await until(() => fp.locator('video').evaluate(video => video.readyState >= 2 && video.currentSrc.includes('facet-classic-second')).catch(() => false), '筛选卡片沿用单击自动播放');
  await fp.locator('video').evaluate(video => video.pause()); await until(() => app.store.list('history').some(row => row.key === facetClassic.key && row.year === '1960'), '筛选不改变影片key和续播记录');
  await facetsContext.value.close();
  console.log('PASS 类型喜剧/惊悚/恐怖与早期年份筛选、网址/分类/来源保留条件、分页重排与未知日期末尾、手机桌面和卡片自动播放');

  facetProgress = { reads: 0, complete: false };
  const progressiveFacets = await context({ width: 1440, height: 1000 }, true, false, '#home?category=movie&genre=%E5%96%9C%E5%89%A7&sort=release'); const pfp = progressiveFacets.page;
  await pfp.clock.install(); await pfp.getByRole('button', { name: '播放 喜剧春日样例', exact: true }).waitFor(); await pfp.locator('.resource-progress').waitFor();
  await pfp.getByLabel('影片类型', { exact: true }).evaluate(input => { window.__genreOptions = [...input.options]; });
  facetProgress.complete = true; await pfp.clock.fastForward(1000); await pfp.getByRole('button', { name: '播放 喜剧新片样例', exact: true }).waitFor();
  assert.deepEqual(await pfp.locator('#browse-results .card-title').allTextContents(), ['喜剧新片样例', '喜剧春日样例', '喜剧日期未知样例'], '渐进后到的新片插入最前，重复组去重');
  assert.equal(await pfp.getByLabel('影片类型', { exact: true }).evaluate(input => [...input.options].every((option, index) => option === window.__genreOptions[index])), true, '相同facets不重建正在使用的下拉选项');
  await pfp.locator('.media-card').filter({ hasText: '喜剧日期未知样例' }).getByText('上映日期未知', { exact: true }).waitFor();
  assert.equal(await pfp.locator('.resource-progress').count(), 0);
  await progressiveFacets.value.close(); facetProgress = null; facetScenario = false;
  console.log('PASS 渐进类型结果按已加载真实日期重新排序、重复影片去重、未知日期如实显示和稳定筛选DOM');

  liveProgress = { reads: 0, probing: true };
  await page.locator('nav a[href="#home"]').click(); const liveProbeBeforeCards = apiReads.filter(item => item.contextId === 1 && item.path === '/api/live/probe').length;
  await page.getByRole('button', { name: '电视直播', exact: true }).click();
  const liveCard = page.getByRole('button', { name: '播放频道 测试电视一', exact: true }); await liveCard.waitFor();
  assert.equal(await liveCard.locator('.channel-cover').count(), 1, '频道封面可点击');
  await until(() => liveCard.locator('img').count().then(count => count === 0), '频道logo错误回退');
  await liveCard.locator('.channel-fallback').getByText('测试电视一', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '播放频道 未验证电视样例', exact: true }).count(), 0);
  await page.locator('.resource-progress').filter({ hasText: '后台正在探测' }).waitFor();
  await page.getByLabel('频道分组', { exact: true }).selectOption('测试频道');
  await page.getByLabel('频道分组', { exact: true }).evaluate(element => { window.__liveGroupOptions = [...element.options]; });
  await liveCard.evaluate(element => { window.__liveCard = element; });
  await page.clock.fastForward(1000); await until(() => liveProgress.reads >= 2, '直播后台探测进度刷新');
  assert.equal(await liveCard.evaluate(element => element === window.__liveCard), true, '进度更新保留卡片DOM和图片');
  assert.equal(await page.getByLabel('频道分组', { exact: true }).evaluate(element => [...element.options].every((option, index) => option === window.__liveGroupOptions[index])), true, '轮询保留正在使用的分组选项节点');
  assert.equal(await page.getByLabel('频道分组', { exact: true }).inputValue(), '测试频道');
  assert.equal(apiReads.filter(item => item.contextId === 1 && item.path === '/api/live/probe').length, liveProbeBeforeCards, '进入直播无需等待整批探测');
  await liveCard.locator('.channel-cover').click(); await until(() => page.locator('video').evaluate(video => video.readyState >= 2 && video.currentSrc.includes('live-second')).catch(() => false), '海报点击直接自动播放');
  assert.equal(new URL(liveRequests.filter(url => url.includes('/api/live/playback')).at(-1)).searchParams.get('line'), '1');
  await page.locator('video').evaluate(video => video.pause()); await page.screenshot({ path: join(output, 'desktop-live-cards.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 1); await page.screenshot({ path: join(output, 'mobile-live-cards.png'), fullPage: true }); await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => { window.__originalLivePlay = HTMLMediaElement.prototype.play; HTMLMediaElement.prototype.play = function() { return Promise.reject(new DOMException('fixed policy', 'NotAllowedError')); }; });
  const policyLiveStart = liveRequests.filter(url => url.includes('/api/live/playback')).length;
  await liveCard.locator('.channel-cover').click(); await until(() => page.locator('.player-note').textContent().then(text => text.includes('浏览器需要你点击')), '直播自动播放被拦截时给播放键提示');
  assert.equal(liveRequests.filter(url => url.includes('/api/live/playback')).length, policyLiveStart + 1, '浏览器政策不误换直播源');
  await page.evaluate(() => { HTMLMediaElement.prototype.play = window.__originalLivePlay; });
  liveProgress.probing = false; liveProgress.checkedStreams = 6; liveProgress.totalStreams = 6;
  channels[0].streams[3].status = 'error'; channels[2].streams[0].status = 'error';
  await page.clock.fastForward(1000); await until(() => page.locator('.resource-progress').count().then(count => count === 0), '直播渐进探测完成');
  const stoppedLiveReads = liveProgress.reads; await page.locator('nav a[href="#home"]').click(); await page.clock.fastForward(3000); assert.equal(liveProgress.reads, stoppedLiveReads, '离开直播停止进度轮询');
  const directLive = await context({ width: 1440, height: 1000 }, true, false, '#live');
  await directLive.page.getByRole('button', { name: '播放频道 测试电视一', exact: true }).waitFor();
  await until(() => directLive.page.locator('#login-form button').isEnabled(), '直播深链接启动巡检不挂住登录boot');
  await directLive.value.close();
  const lateChannel = { id: 'test-tv-late', name: '晚到电视样例', group: '测试频道', streams: [{ name: '晚到已验证线路', type: 'mp4', status: 'unknown', url: 'https://fixtures.example/live-late.mp4?token=fixture' }] };
  channels.push(lateChannel); liveProgress = { reads: 0, probing: false, checkedStreams: 6, totalStreams: 7 };
  await page.getByRole('button', { name: '电视直播', exact: true }).click();
  await page.locator('.resource-progress').filter({ hasText: '已检查 6/7' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '播放频道 晚到电视样例', exact: true }).count(), 0, '批次间隙仍不显示未知频道');
  await liveCard.evaluate(element => { window.__gapCard = element; });
  await page.getByLabel('频道分组', { exact: true }).selectOption('测试频道'); await page.getByLabel('频道分组', { exact: true }).evaluate(element => { window.__gapGroupOptions = [...element.options]; });
  await liveCard.locator('.channel-cover').click(); await until(() => page.locator('video').evaluate(video => video.readyState >= 2 && video.currentSrc.includes('live-second')).catch(() => false), '批次间隙已验证频道仍可播放');
  await page.locator('video').evaluate(video => video.pause());
  lateChannel.streams[0].status = 'ok'; await page.clock.fastForward(1000);
  await page.getByRole('button', { name: '播放频道 晚到电视样例', exact: true }).waitFor();
  assert.equal(await liveCard.evaluate(element => element === window.__gapCard), true, '晚来频道追加时保留既有卡片和台标DOM');
  assert.equal(await page.getByLabel('频道分组', { exact: true }).evaluate(element => [...element.options].every((option, index) => option === window.__gapGroupOptions[index])), true, '同组晚来频道不重建分类菜单选项');
  assert.equal(await page.getByLabel('频道分组', { exact: true }).inputValue(), '测试频道');
  const ongoingSource = await page.locator('video').evaluate(video => video.currentSrc);
  channels[0].streams[1].status = 'error'; await page.clock.fastForward(1000);
  await until(() => page.locator('#live-lines button[data-line="1"]').count().then(count => count === 0), '后台失败移除原URL对应线路选项');
  assert.equal(await page.locator('video').evaluate(video => video.currentSrc), ongoingSource, '后台探测不停止正在播放的原流');
  assert.equal(await page.locator('#live-lines button[data-line="2"]').count(), 1, '其余同URL可用线路保留原数组编号');
  const reportsBeforeUrlChange = liveReports.length;
  channels[0].streams[1].url = 'https://fixtures.example/live-replaced.mp4?token=fixture'; channels[0].streams[1].status = 'ok';
  await page.clock.fastForward(1000); await until(() => liveProgress.reads >= 4, '后台URL变更列表同步');
  assert.equal(await page.locator('video').evaluate(video => video.currentSrc), ongoingSource, '新数组URL不能接管正在播放的原流');
  assert.equal(await page.locator('#live-lines button[data-line="1"]').count(), 0, '同编号不同URL不恢复旧线路按钮');
  await page.locator('video').evaluate(video => { Object.defineProperty(video, 'error', { value: { code: 4, message: '固定解码故障' }, configurable: true }); video.dispatchEvent(new Event('error')); delete video.error; });
  await until(() => page.locator('video').evaluate(video => video.readyState >= 2 && video.currentSrc.includes('live-third')).catch(() => false), '实际媒体失败仍使用原编号的可用备用');
  assert.equal(liveReports.slice(reportsBeforeUrlChange).some(report => report.id === 'test-tv-one' && report.line === 1 && report.status === 'error'), false, '原流错误不能报告新数组中另一个URL');
  await page.locator('video').evaluate(video => video.pause());
  liveProgress.checkedStreams = 7; await page.clock.fastForward(3000); await until(() => page.locator('.resource-progress').count().then(count => count === 0), '全部检查完成进入低频同步');
  const idleLiveReads = liveProgress.reads; await page.clock.fastForward(20000); assert.equal(liveProgress.reads, idleLiveReads, '完成状态不持续高频请求');
  await page.clock.fastForward(10000); await until(() => liveProgress.reads > idleLiveReads, '完成后30秒仍同步源新增或状态变化');
  const beforeIdleLeave = liveProgress.reads; await page.locator('nav a[href="#home"]').click(); await page.clock.fastForward(30000); assert.equal(liveProgress.reads, beforeIdleLeave, '离开直播取消30秒巡检');
  channels[0].streams[1].url = 'https://fixtures.example/live-second.mp4?token=fixture'; channels[0].streams[1].status = 'ok';
  channels.splice(channels.indexOf(lateChannel), 1);
  liveProgress = null;
  console.log('PASS 直播海报/批间gap晚来频道、仅ok选项、保持既有卡片与原流URL/编号、后台失败同步、1秒/3秒/30秒巡检、播放政策与离页取消');

  // 质量字段由后端清单/SPS测试证实；此处用WAV适配器只验证UI和原线路索引，不声称真实HD解码。
  const qualityChannel = { id: 'quality-satellite', name: '卫视清晰度样例', category: '卫视', group: '上游原始分组', preferredLine: 3, streams: [
    { name: '名字HD但未核实', type: 'mp4', status: 'ok', url: 'https://fixtures.example/quality-nameHD.mp4' },
    { name: '已失败的高清线', type: 'hls', status: 'error', url: 'https://fixtures.example/quality-error.m3u8', quality: { width: 1920, height: 1080, source: 'manifest' } },
    { name: '清单验证线路', type: 'hls', status: 'ok', url: 'https://fixtures.example/quality-master720.m3u8', playbackUrl: 'https://fixtures.example/quality-selected720.m3u8?token=720', quality: { width: 1280, height: 720, bandwidth: 2000000, source: 'manifest' } },
    { name: '码流验证线路', type: 'hls', status: 'ok', url: 'https://fixtures.example/quality-master1080.m3u8', playbackUrl: 'https://fixtures.example/quality-selected1080.m3u8?token=1080', quality: { width: 1920, height: 1080, source: 'bitstream' } },
    { name: '未知超高清线', type: 'hls', status: 'unknown', url: 'https://fixtures.example/quality-unknown.m3u8', quality: { width: 3840, height: 2160, source: 'manifest' } },
  ] };
  const qualityLocal = { id: 'quality-local', name: '地方HD名称样例', category: '地方', group: '上游原始分组', streams: [{ name: '可用未知分辨率', type: 'mp4', status: 'ok', url: 'https://fixtures.example/quality-local.mp4' }] };
  const qualityCctv = { id: 'quality-cctv', name: 'CCTV5栏目样例', category: '体育', group: '体育', streams: [{ name: '央视可用线', type: 'mp4', status: 'ok', url: 'https://fixtures.example/quality-cctv.mp4' }] };
  channels.push(qualityChannel, qualityLocal, qualityCctv);
  const qualityContext = await context({ width: 1440, height: 1000 }, true, false, '#live?category=%E5%8D%AB%E8%A7%86'); const qp = qualityContext.page;
  await qp.evaluate(() => {
    window.__qualityHls = [];
    class QualityFixtureHls {
      static isSupported() { return true; }
      static Events = { ERROR: 'hlsError', MANIFEST_PARSED: 'hlsManifestParsed' };
      constructor(options) { this.options = options; this.handlers = new Map(); this.levels = [{ width: 640, height: 360 }, { width: 1280, height: 720 }, { width: 1920, height: 1080 }]; window.__qualityHls.push(this); }
      loadSource(url) { this.url = url; }
      attachMedia(video) {
        this.video = video;
        if (this.options.autoStartLoad !== false) this.startMedia();
        setTimeout(() => { if (!this.destroyed) this.handlers.get('hlsManifestParsed')?.('hlsManifestParsed', { levels: this.levels }); }, 0);
      }
      startMedia() { this.video.src = this.url.replace('.m3u8', '.mp4'); }
      startLoad() { this.startLoads = (this.startLoads || 0) + 1; this.startMedia(); }
      on(event, handler) { this.handlers.set(event, handler); }
      destroy() { this.destroyed = true; }
    }
    window.Hls = QualityFixtureHls;
  });
  const qualityCard = qp.getByRole('button', { name: '播放频道 卫视清晰度样例', exact: true }); await qualityCard.waitFor();
  assert.equal(await qualityCard.locator('.channel-badge').textContent(), '码流1080p');
  assert.equal(await qp.getByRole('button', { name: '播放频道 地方HD名称样例', exact: true }).count(), 0, '卫视入口使用规范category，非原group或HD名称');
  await qualityCard.locator('.channel-cover').click();
  await until(() => qp.locator('video').evaluate(video => video.readyState >= 2 && video.currentSrc.includes('quality-selected1080')).catch(() => false), '频道自动选择preferredLine的真实派生播放URL');
  assert.equal(new URL(liveRequests.filter(url => url.includes('/api/live/playback') && url.includes('quality-satellite')).at(-1)).searchParams.get('line'), '3', '保留最高质量线路原始编号');
  assert.equal(await qp.locator('#live-lines button[data-line="1"]').count(), 0); assert.equal(await qp.locator('#live-lines button[data-line="4"]').count(), 0, 'failed/unknown即使分辨率更高仍隐藏');
  assert.equal(await qp.locator('#live-lines button[data-line="0"] .line-status').textContent(), '可用', '名称HD不生成分辨率标记');
  assert.equal(await qp.evaluate(() => window.__qualityHls[0].startLevel), undefined, '码流质量在没有明确AVC证据时不猜master层');
  const qualityReportsStart = liveReports.length;
  await qp.locator('video').evaluate(video => { Object.defineProperty(video, 'error', { value: { code: 4, message: '固定解码故障' }, configurable: true }); video.dispatchEvent(new Event('error')); delete video.error; });
  await until(() => qp.locator('video').evaluate(video => video.readyState >= 2 && video.currentSrc.includes('quality-selected720')).catch(() => false), '高清故障及代理失败后选择下一条已知最高质量');
  assert.equal(new URL(liveRequests.filter(url => url.includes('/api/live/playback') && url.includes('quality-satellite')).at(-1)).searchParams.get('line'), '2');
  await until(() => liveReports.slice(qualityReportsStart).some(report => report.id === qualityChannel.id && report.line === 3 && report.status === 'error'), '原master按raw编号上报失败');
  assert.equal(await qualityCard.locator('.channel-badge').textContent(), '清单720p');
  assert.equal(await qp.evaluate(() => window.__qualityHls.at(-1).options.autoStartLoad), false); assert.equal(await qp.evaluate(() => window.__qualityHls.at(-1).startLevel), 1, '匹配已验证720p起始层，不强制1080p且保留ABR');
  assert.equal(await qp.evaluate(() => window.__qualityHls.at(-1).startLoads), 1);
  await qp.locator('video').evaluate(video => video.pause());
  await qp.screenshot({ path: join(output, 'desktop-live-quality.png'), fullPage: true });
  await qp.setViewportSize({ width: 390, height: 844 }); assert.ok(await qp.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 1); await qp.screenshot({ path: join(output, 'mobile-live-quality.png'), fullPage: true });
  await qp.getByRole('button', { name: '地方', exact: true }).click(); await qp.getByRole('button', { name: '播放频道 地方HD名称样例', exact: true }).waitFor(); assert.equal(await qp.locator('.channel-badge').textContent(), '可播放');
  assert.equal(await qp.locator('video').evaluate(video => video.currentSrc.includes('quality-selected720')), true, '频道分类不会中断正在播放的原流');
  await qp.getByRole('button', { name: '央视', exact: true }).click(); await qp.getByRole('button', { name: '播放频道 CCTV5栏目样例', exact: true }).waitFor();
  assert.equal(await qp.getByRole('button', { name: '播放频道 卫视清晰度样例', exact: true }).count(), 0);
  await qualityContext.value.close(); channels.splice(channels.indexOf(qualityChannel), 3);
  console.log('PASS 卫视/地方/央视入口、manifest/bitstream可信质量标记、HD名称不冒充质量、最高质量raw选线和故障720p备用、派生URL及Hls起始层、手机桌面');
  await verifyBitstreamInitialLevel();
  await verifyProgressiveMetadata();
  await verifyAdSkipping();
  await verifyQuarantineStatus();
  await verifyQuarkAutoplay();
  await verifyQuarkFlow();
  await verifyQuarkProgressReadiness();
  await verifyQuarkPublicSearch();
  await verifyQuarkSearchRetry();
  await verifyQuarkPendingSearch();
  await verifyQuarkChoices();
  await verifyCompactSettings();
  await verifyLowLoadLive();

  // 回到原始独立无界面标签，结束已验收的其他会话，模拟用户实际回到该页操作。
  assert.equal((await (await page.request.get(base + '/api/auth')).json()).authenticated, true, '原会话仍有效，不通过重新登录恢复');
  for (const completed of browser.contexts()) if (completed !== page.context()) await completed.close();
  await page.bringToFront();
  await page.locator('nav a[href="#settings"]').click();
  await page.waitForURL('**/#settings');
  await openSettingsSection(page, '解析线路');
  const parsers = page.locator('.settings-section').filter({ has: page.getByRole('heading', { name: '解析线路', exact: true }) });
  try { await parsers.getByRole('heading', { name: '解析线路', exact: true }).waitFor(); }
  catch (error) { console.error('SETTINGS_RENDER_DIAGNOSTIC', JSON.stringify({ state: await page.evaluate(() => ({ href: location.href, headings: [...document.querySelectorAll('h2')].map(item => item.textContent), content: document.querySelector('#content')?.textContent.slice(0, 1000) })), errors })); throw error; }
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
  await verifyTvRemote();
  await verifyQuarkStartupFailure();
  }
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
  releaseTranscode?.(); releaseCandidateSearch?.();
  releaseVendor?.(); for (const release of releaseStates.splice(0)) release();
  for (const release of releaseVerifiedProbes.splice(0)) release();
  await browser?.close(); await app.close(); await rm(directory, { recursive: true, force: true });
}
