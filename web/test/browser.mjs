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
const summary = { key, title: '星海旅途', year: '2025', type: 'series', poster: '' };
const items = [{ ...summary, source: 'first', id: '1' }, { ...summary, source: 'second', id: '2' }];
const catalog = {
  async search(config) {
    return { groups: config.sources.length ? [{ ...summary, items }] : [], failedSources: [] };
  },
  async detail(config, source, id) {
    assert.ok(config.sources.some(row => row.id === source));
    return { ...summary, source, id, description: '浏览器测试影片，不包含第三方内容。', lines: [
      { name: '直连', episodes: [1, 2].map(number => ({ name: `第${number}集`, type: 'mp4', url: `https://fixtures.example/${source}-${number}.mp4?token=fixture` })) },
      { name: '备用', episodes: [1, 2].map(number => ({ name: `第${number}集`, type: 'mp4', url: `https://fixtures.example/${source}-alt-${number}.mp4?token=fixture` })) },
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
const app = createApp({ password: 'browser-test-password', dataDir: directory, catalog, initialConfig: { ...defaults, parsers: [] } });
await new Promise(ok => app.server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${app.server.address().port}`;
const candidates = [process.env.BROWSER_EXECUTABLE, chromium.executablePath(),
  'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'];
const executablePath = candidates.find(value => value && existsSync(value));
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath, args: ['--mute-audio', '--noerrdialogs'] });
  const errors = [];
  const media = silentMedia();
  async function context(viewport) {
    const value = await browser.newContext({ viewport });
    await value.route('**/*', route => {
      const url = route.request().url();
      if (url.startsWith(base + '/')) return route.continue();
      if (url.startsWith('https://fixtures.example/')) return route.fulfill({ status: 200, contentType: 'audio/wav', body: media,
        headers: { 'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'bytes' } });
      return route.abort();
    });
    const page = await value.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    await page.locator('#password').fill('browser-test-password');
    await page.locator('#login-form button').click();
    await page.locator('#app-view').waitFor({ state: 'visible' });
    return { value, page };
  }
  const { page } = await context({ width: 1440, height: 1000 });
  await page.locator('.notice').filter({ hasText: '还没有影视源' }).waitFor();
  await page.screenshot({ path: join(output, 'desktop-home.png'), fullPage: true });
  console.log('PASS 桌面登录与初始空配置');

  await page.locator('nav a[href="#settings"]').click();
  await page.locator('textarea[aria-label="配置 JSON"]').fill(JSON.stringify({ api_site: {
    first: { name: '第一源', api: 'https://api.example.com/first' }, second: { name: '第二源', api: 'https://api.example.com/second' },
  } }));
  await page.getByRole('button', { name: '校验并导入', exact: true }).click();
  await until(() => app.store.config().sources.length === 2, '配置导入');
  await page.locator('nav a[href="#search"]').click();
  await page.locator('input[aria-label="影片名称"]').fill('星海');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await page.getByRole('button', { name: '查看 星海旅途', exact: true }).click();
  await page.locator('.detail-summary h2').waitFor();
  await page.getByRole('button', { name: '☆ 收藏', exact: true }).click();
  await until(() => app.store.list('favorites').length === 1, '收藏保存');
  console.log('PASS 源导入、聚合搜索、详情与收藏');

  await page.getByRole('button', { name: '▷ 播放第一集', exact: true }).click();
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
  await mobile.page.getByRole('button', { name: '查看 星海旅途', exact: true }).waitFor();
  await mobile.page.locator('nav a[href="#home"]').click();
  const overflow = await mobile.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `手机页面横向溢出 ${overflow}px`);
  await mobile.page.screenshot({ path: join(output, 'mobile-home.png'), fullPage: true });
  await mobile.page.getByRole('button', { name: '继续观看 星海旅途', exact: true }).click();
  await until(() => mobile.page.locator('video').evaluate(video => video.readyState >= 1 && video.currentTime >= 11).catch(() => false), '另一设备自动续播');
  await mobile.page.locator('video').evaluate(video => video.pause());
  await mobile.page.locator('nav a[href="#history"]').click();
  await until(() => mobile.page.locator('#content').getByRole('button', { name: /清空/ }).count(), '观看记录页');
  console.log('PASS 手机布局、跨会话收藏和进度同步');

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
