import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';

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
const moviePage2 = fixture('晴天笔记', 'movie', 'movie-page2', '喜剧片');
const anime = fixture('动画旅人', 'series', 'anime', '国产动漫', '全2集');
const broken = fixture('故障换源', 'series', 'broken', '国产剧', '全2集');
const badDetail = fixture('详情重试', 'movie', 'bad-detail', '剧情片');
const doomed = fixture('有限重试', 'series', 'doomed', '国产剧', '全2集', ['first', 'second', 'third', 'fourth']);
const slow = fixture('慢响应', 'series', 'slow', '国产剧', '全2集');
const hlsPriority = fixture('HLS选择样例', 'series', 'hls-priority', '国产剧', '全2集');
const adult = fixture('限制级样例', 'movie', 'adult', '限制级', '样例');
adult.category = 'adult'; adult.items.forEach(item => { item.category = 'adult'; });
const categoryBoundary = fixture('分类边界样例', 'movie', 'category-normal', '剧情片', '样例');
const categoryAdult = { ...categoryBoundary.items[0], source: 'third', id: 'category-adult', category: 'adult', typeName: '限制级' };
const mixedCategory = { ...categoryBoundary, category: 'adult', typeName: '限制级', items: [...categoryBoundary.items, categoryAdult] };
const groups = [{ ...summary, items }, movie, moviePage2, anime, broken, badDetail, doomed, slow, hlsPriority, adult, mixedCategory];
let delayAdultDetail = false;
const catalogRequests = [];
const catalog = {
  async search(config, query) {
    return { groups: config.sources.length ? groups.filter(group => group.title.includes(query) && (config.showAdult === true || group.category !== 'adult')) : [], failedSources: [] };
  },
  async browse(config, { category, page, source }) {
    catalogRequests.push({ kind: 'browse', category, page: Number(page), source });
    if (source === 'fourth') throw Object.assign(new Error('固定分类接口故障'), { status: 502 });
    if (category === 'adult' && config.showAdult !== true) throw Object.assign(new Error('三级内容已隐藏，请先在设置中开启显示。'), { status: 403 });
    const list = category === 'adult' ? [adult] : category === 'movie' ? Number(page) === 1 ? [movie, badDetail, ...(config.showAdult === true ? [categoryBoundary] : [])] : [moviePage2, movie] : category === 'anime' ? [anime] : [{ ...summary, items }, broken, doomed, slow];
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
    const numbers = id === 'broken' && source === 'second' ? [2, 1] : [1, 2];
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
const app = createApp({ password: 'browser-test-password', dataDir: directory, catalog, initialConfig: { ...defaults, sources: [], parsers: [], showAdult: false } });
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
  async function context(viewport, nativeMedia = true) {
    const value = await browser.newContext({ viewport });
    await value.route('**/*', route => {
      const url = route.request().url();
      if (url.includes('/api/media?') || url.startsWith('https://fixtures.example/')) network.push(url);
      if (url === base + '/api/config/presets') return route.fulfill({ json: { api_site: {
        first: { name: '第一源', api: 'https://api.example.com/first' }, second: { name: '第二源', api: 'https://api.example.com/second' },
      } } });
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
  await page.getByRole('button', { name: '校验并导入', exact: true }).click();
  await until(() => app.store.config().sources.length === 4, '配置导入');
  await page.getByRole('button', { name: '添加内置影视源', exact: true }).click();
  await until(() => page.locator('#toast').textContent().then(text => text.includes('内置影视源已添加')), '添加内置源反馈');
  assert.equal(app.store.config().sources.length, 4, '添加内置源应按标识合并，保留其它自定义源');
  await page.locator('nav a[href="#home"]').click();
  await page.getByRole('button', { name: '播放 海风来信', exact: true }).waitFor();
  assert.equal(await page.locator('#browse-results .media-card').count(), 2);
  assert.match(await page.locator('#browse-results').textContent(), /剧情片/);
  assert.match(await page.locator('#browse-results').textContent(), /正片/);
  await page.getByRole('button', { name: '加载更多', exact: true }).click();
  await page.getByRole('button', { name: '播放 晴天笔记', exact: true }).waitFor();
  assert.equal(await page.locator('#browse-results .media-card').count(), 3, '分页应按片key去重');
  await page.getByLabel('浏览影视源', { exact: true }).selectOption('third');
  await page.getByRole('heading', { name: '这个分类暂时没有影片', exact: true }).waitFor();
  await page.getByLabel('浏览影视源', { exact: true }).selectOption('fourth');
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
  const requestStart = catalogRequests.length;
  await page.locator('#browse-results').getByRole('button', { name: '播放 有限重试', exact: true }).click();
  await until(() => page.locator('.player-note').textContent().then(text => text.includes('自动尝试已结束')).catch(() => false), '失败源有限自动重试', 20000);
  await page.waitForTimeout(350);
  const attempted = new Set(catalogRequests.slice(requestStart).filter(row => row.kind === 'detail' && row.id === 'doomed').map(row => row.source));
  assert.deepEqual([...attempted], ['first', 'second', 'third'], '每轮自动最多三个源，每个源一次');
  await page.locator('#source-row').getByRole('button', { name: '第四源', exact: true }).waitFor();
  console.log('PASS 详情接口失败换源、最多三个源自动尝试后保留手动操作');

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
  const policyRequestStart = catalogRequests.length;
  await policy.page.locator('#browse-results').getByRole('button', { name: '播放 海风来信', exact: true }).click();
  await until(() => policy.page.locator('.player-note').textContent().then(text => text.includes('需要你点击播放器')).catch(() => false), '浏览器自动播放政策反馈');
  assert.equal(new Set(catalogRequests.slice(policyRequestStart).filter(row => row.kind === 'detail' && row.id === 'movie').map(row => row.source)).size, 1, '自动播放政策不能被当作坏源');
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
  await page.locator('#source-row').getByRole('button', { name: '第二源', exact: true }).click();
  await page.getByRole('heading', { name: '自动尝试已结束', exact: true }).waitFor();
  assert.equal(await page.locator('video').count(), 0, '手动换源仍核验实际详情分类');
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
} finally {
  await browser?.close(); await app.close(); await rm(directory, { recursive: true, force: true });
}
