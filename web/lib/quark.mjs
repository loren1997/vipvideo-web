import { randomBytes, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdir, open, readFile, chmod, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { request as networkRequest, readText, validateUrl } from './network.mjs';

const API = 'https://drive.quark.cn/1/clouddrive', REFERER = 'https://pan.quark.cn/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const PLAYBACK_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch';
const DAY = 86400000, GIB = 1024 ** 3, DAILY_BYTES = 3_000_000_000_000, SIDECAR = 'http://pansou:8888/api/search';
const defaults = { enabled: false, autoSave: false, cleanupEnabled: false, retentionDays: 7, maxDailyTransfers: 100, maxDailyBytes: DAILY_BYTES, searchApi: '' };
const id = () => randomBytes(16).toString('hex');
const hash = value => createHash('sha256').update(value).digest('hex');
const validFid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const name = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 300) : '';
const failure = (message, status = 502) => Object.assign(new Error(message), { status, quarkSafe: true });
const accountFailure = message => Object.assign(failure(message, 401), { quarkAuth: true });
const publicReason = error => error?.quarkSafe && typeof error.message === 'string' ? error.message : '夸克操作失败，请检查网络及登录状态后重试';
const directory = file => file?.dir === true || file?.dir === 1 || file?.file === false || file?.file_type === 0;
const video = file => !directory(file) && (file?.file === true || file?.dir === false || file?.dir === 0 || file?.file_type === 1 || file?.category === 1) && /\.(?:mp4|m4v|mkv|mov|webm|avi|ts|m2ts)$/i.test(file?.file_name || '');

function share(value, password = '') {
  try {
    const url = validateUrl(value), match = /^\/s\/([a-z0-9]{6,32})\/?$/i.exec(url.pathname);
    if (url.protocol !== 'https:' || url.hostname !== 'pan.quark.cn' || url.port || !match) return null;
    const pwd = password || url.searchParams.get('pwd') || '';
    if (!/^[A-Za-z0-9]{0,16}$/.test(pwd)) return null;
    return { pwdId: match[1], password: pwd, url: 'https://pan.quark.cn/s/' + match[1] + (pwd ? '?pwd=' + encodeURIComponent(pwd) : '') };
  } catch { return null; }
}

function cookieInput(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value)) throw failure('Cookie 格式无效，请复制 Request Headers 中的完整 Cookie 值', 400);
  const parts = value.trim().replace(/^cookie\s*:\s*/i, '').split(';').map(part => part.trim()).filter(Boolean);
  if (!parts.length || parts.some(part => !/^[!#$%&'*+\-.^_`|~A-Za-z0-9]+=[\x20-\x7e]*$/.test(part))) {
    throw failure('Cookie 格式无效，应为 key=value; key=value，请勿粘贴 JSON、Set-Cookie 或其他请求头', 400);
  }
  return parts.join('; ');
}

function accountId(config, root, cookie) {
  const uid = config?.data?.uid ?? config?.data?.user_id ?? config?.data?.member_config?.uid ?? root?.data?.uid;
  if (typeof uid === 'string' && uid.length > 0 && uid.length <= 128 || Number.isSafeInteger(uid) && uid > 0) return hash('uid:' + uid);
  const stable = cookie.split(';').map(part => part.trim()).filter(part => /^(?:__kp|__pus|__kps|__uid|uid)=/.test(part)).sort().join(';');
  if (!stable) throw accountFailure('无法可靠确认夸克账号');
  return hash('cookie:' + stable);
}

function detailInfo(detail, options = {}) {
  const rawTitle = name(detail?.title || detail?.name), year = String(detail?.year || '').slice(0, 4);
  if (!rawTitle) throw failure('影片详情缺少名称', 400);
  const key = hash(JSON.stringify([String(detail.source || ''), String(detail.id || ''), rawTitle, year]));
  const series = detail.type === 'series' || ['tv', 'anime'].includes(detail.category) || Array.isArray(detail.lines) && detail.lines.some(line => line.episodes?.length > 1);
  let title = rawTitle.normalize('NFKC');
  if (series) for (let count = 0; count < 6; count++) {
    const cleaned = title.replace(/(?:\s*[(\[【]?\s*(?:更新至\s*第?\s*[零〇一二两三四五六七八九十百\d]+\s*[集话]?|第[零〇一二两三四五六七八九十百\d]+[集话季]|(?:全|共)\d+集|\d+集全|完结季|国语|粤语|普通话|双语|中字|中英字幕)|[\s._-]+[(\[【]?\s*(?:s\d{1,2}(?:[ ._-]*e\d{1,3})?|(?:episode|ep|e)[ ._-]*\d{1,3}|\d{1,2}x\d{1,3}|完结|全集|高清|超清|日语|英语|1080p|2160p|4k|HD))\s*[)\]】]?\s*$/i, '').trim();
    if (cleaned === title || cleaned.length < 2) break; title = cleaned;
  }
  let searchTitle = title;
  if (!series) for (let count = 0; count < 4; count++) { const cleaned = searchTitle.replace(/\s*[(\[【]?\s*(?:国语|粤语|普通话|双语|中字|中英字幕|高清|超清)\s*[)\]】]?\s*$/i, '').trim(); if (cleaned === searchTitle || cleaned.length < 2) break; searchTitle = cleaned; }
  const aliases = [...new Set([...(searchTitle !== rawTitle ? [rawTitle] : []), ...(Array.isArray(detail.aliases) ? detail.aliases.slice(0, 10) : [])].filter(value => typeof value === 'string' && value.trim().length >= 2 && value.length <= 300 && !/[\u0000-\u001f\u007f]/.test(value) && episodeNumber(value) === undefined && !/更新至/.test(value)).map(value => value.trim()).filter(value => normalized(value) !== normalized(searchTitle)))].slice(0, 2);
  const line = options.line ?? 0, index = options.episode ?? 0;
  const selected = Number.isInteger(line) && line >= 0 && Number.isInteger(index) && index >= 0 ? detail.lines?.[line]?.episodes?.[index] : undefined;
  return { title, searchTitle: searchTitle.length >= 2 ? searchTitle : title, aliases, series, titleSeason: seasonNumber(rawTitle), year: /^(?:19|20)\d{2}$/.test(year) ? year : '', key, selected, line, index, season: detail.season };
}

function number(value) {
  if (/^\d{1,3}$/.test(value || '')) return Number(value);
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const hundreds = /^([一二两三四五六七八九])百([零〇一二两三四五六七八九十]*)$/.exec(value || '');
  if (hundreds) { const tail = hundreds[2], rest = !tail ? 0 : /^[零〇][一二三四五六七八九]$/.test(tail) ? digits[tail[1]] : tail.includes('十') ? number(tail) : undefined; return rest === undefined ? undefined : digits[hundreds[1]] * 100 + rest; }
  if (value === '十') return 10;
  if (/^[一二三四五六七八九]?十[一二三四五六七八九]?$/.test(value || '')) { const [left, right] = value.split('十'); return (digits[left] || 1) * 10 + (digits[right] || 0); }
  return Object.hasOwn(digits, value) ? digits[value] : undefined;
}
const seasonNumber = value => { const matches = [...String(value || '').normalize('NFKC').matchAll(/(?:^|[^a-z0-9])s(\d{1,2})(?=e\d|[^a-z0-9]|$)|(?:^|[^a-z0-9])(\d{1,2})x\d{1,3}(?!\d)|第([零〇一二两三四五六七八九十百\d]+)季/gi)].map(match => number(match[1] || match[2] || match[3])); return matches.some(value => value === undefined || value !== matches[0]) ? null : matches[0]; };
const episodeNumber = value => {
  const text = String(value || '').normalize('NFKC');
  if (/第[零〇一二两三四五六七八九十百\d]+\s*[-~～至到—–]\s*第?[零〇一二两三四五六七八九十百\d]+[集话]|(?:^|[^a-z0-9])(?:s\d{1,2}[ ._-]*)?(?:episode|ep|e)?[ ._-]*\d{1,3}[ ._]*[-~～至到—–][ ._]*(?:s\d{1,2}[ ._-]*)?(?:episode|ep|e)?[ ._-]*\d{1,3}(?![a-z0-9])/i.test(text)) return null;
  const matches = [...text.matchAll(/(?:^|[^a-z0-9])(?:s\d{1,2}[ ._-]*)?(?:episode|ep|e)[ ._-]*(\d{1,3})(?![a-z0-9])|(?:^|[^a-z0-9])\d{1,2}x(\d{1,3})(?![a-z0-9])|第([零〇一二两三四五六七八九十百\d]+)[集话]/gi)];
  if (matches.length) return matches.length === 1 ? number(matches[0][1] || matches[0][2] || matches[0][3]) ?? null : null;
  return /^(?:\d{1,3})(?:\.[a-z0-9]+)?$/i.test(text) ? Number(text.split('.')[0]) : undefined;
};
const normalized = value => String(value).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
function matches(info, file) {
  if (!info.selected || info.title.length < 2) return false;
  const parts = [...file.path, file.name], title = normalized(info.title);
  const suffix = /^(?:(?:19|20)\d{2}|s\d{1,2}(?:e\d{1,3})?|(?:episode|ep|e)\d{1,3}|\d{1,2}x\d{1,3}|(?:更新至第?)?[零〇一二两三四五六七八九十百\d]+[集话]|第[零〇一二两三四五六七八九十百\d]+[季集话]|(?:480|720|1080|2160)p|[48]k|hdr|dv|dolby|webdl|webrip|bluray|bdrip|[hx]26[45]|aac|ac3|国语|中字|中英字幕|正片|高清|超清|完整版|全集|完结季|完结|全\d+集)*$/i;
  if (!parts.some(part => { const stem = normalized(part.replace(/\.[a-z0-9]{2,5}$/i, '')); return stem.startsWith(title) && suffix.test(stem.slice(title.length)); })) return false;
  const years = parts.flatMap(part => [...part.matchAll(/(?:19|20)\d{2}/g)].map(match => match[0]));
  if (info.year && (!years.includes(info.year) || years.some(year => year !== info.year))) return false;
  const wantedEpisode = episodeNumber(info.selected.name);
  if (wantedEpisode === null) return false;
  const wantedSeasons = [Number.isInteger(info.season) ? info.season : undefined, info.titleSeason, seasonNumber(info.selected.name)].filter(value => value !== undefined), season = wantedSeasons[0];
  const seasons = parts.map(seasonNumber).filter(value => value !== undefined);
  if (wantedSeasons.some(value => value === null || value !== season) || seasons.some(value => value === null || season === undefined || value !== season) || season > 1 && !seasons.length) return false;
  if (wantedEpisode !== undefined) return episodeNumber(file.name.replace(/\.[^.]+$/, '')) === wantedEpisode;
  return !info.series && info.index === 0 && /^(?:正片|电影|完整版|全集)$/i.test(info.selected.name || '') && episodeNumber(file.name.replace(/\.[^.]+$/, '')) === undefined;
}

export function createQuark({ store, dataDir, request = networkRequest, searchRequest = networkRequest, defaultSearchApi = '', now = Date.now } = {}) {
  if (!store?.meta || !store?.setMeta || typeof dataDir !== 'string') throw new TypeError('Quark requires store and dataDir');
  const parse = (key, fallback) => { try { const text = store.meta(key); return text && text.length <= 2 * 1024 * 1024 ? JSON.parse(text) : fallback; } catch { return fallback; } };
  const initial = parse('quark-settings-v1', {}), config = { ...defaults, installId: /^[a-f0-9]{32}$/.test(initial.installId || '') ? initial.installId : id() };
  for (const field of ['enabled', 'autoSave', 'cleanupEnabled']) if (typeof initial[field] === 'boolean') config[field] = initial[field];
  for (const [field, minimum, maximum] of [['retentionDays', 1, 365], ['maxDailyTransfers', 1, 100], ['maxDailyBytes', 1024 * 1024, DAILY_BYTES]]) if (Number.isSafeInteger(initial[field]) && initial[field] >= minimum && initial[field] <= maximum) config[field] = initial[field];
  if (typeof initial.searchApi === 'string' && initial.searchApi.length <= 2048) config.searchApi = initial.searchApi;
  if (/^[a-f0-9]{64}$/.test(initial.account?.id || '') && ['iv', 'tag', 'ciphertext'].every(field => typeof initial.account[field] === 'string' && initial.account[field].length <= 16384)) config.account = { id: initial.account.id, iv: initial.account.iv, tag: initial.account.tag, ciphertext: initial.account.ciphertext };
  if (store.meta('quark-transfer-default-100-v1') !== '1') {
    if (initial.maxDailyTransfers === 10) { config.maxDailyTransfers = initial.maxDailyTransfers = 100; store.setMeta('quark-settings-v1', JSON.stringify(initial)); }
    store.setMeta('quark-transfer-default-100-v1', '1');
  }
  if (store.meta('quark-transfer-bytes-3tb-v1') !== '1') {
    if (initial.maxDailyBytes === 20 * GIB) { config.maxDailyBytes = initial.maxDailyBytes = DAILY_BYTES; store.setMeta('quark-settings-v1', JSON.stringify(initial)); }
    store.setMeta('quark-transfer-bytes-3tb-v1', '1');
  }
  const savedRegistry = parse('quark-registry-v1', {});
  const folders = Object.fromEntries(Object.entries(savedRegistry.folders || {}).filter(([account, folder]) => /^[a-f0-9]{64}$/.test(account) && folder?.name === 'VipVideo-' + config.installId && (!folder.fid || validFid(folder.fid))));
  const registry = { folders, assets: Array.isArray(savedRegistry.assets) ? savedRegistry.assets.filter(asset => /^[a-f0-9]{32}$/.test(asset.id || '') && /^[a-f0-9]{64}$/.test(asset.account || '') && asset.managed === true && validFid(asset.parent) && typeof asset.name === 'string' && Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size <= 100 * GIB && ['saving', 'ready', 'recycling', 'purging', 'deleted'].includes(asset.status) && (asset.status === 'saving' || validFid(asset.fid))).slice(0, 1000) : [], lastCleanup: savedRegistry.lastCleanup || null };
  const shares = new Map(), candidates = new Map(), searches = new Map(), searchFlights = new Map(), prepareFlights = new Map();
  let cookie = '', loaded = false, unlocking, key, epoch = 0, active = 0, tail = Promise.resolve(), timer, started = false, stopped = false, stopPromise, lastError = '';
  const waiters = [], jobs = new Set();
  const persist = () => { store.setMeta('quark-settings-v1', JSON.stringify(config)); store.setMeta('quark-registry-v1', JSON.stringify(registry)); };
  const serialize = operation => { const job = tail.then(operation, operation); tail = job.catch(() => {}); return job; };
  const error = value => { lastError = publicReason(value).slice(0, 180); return lastError; };
  async function encryptionKey(create = false) {
    if (key) return key;
    const path = resolve(dataDir, 'quark.key');
    try { const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink()) throw failure('夸克密钥必须是独立普通文件', 503); key = await readFile(path); } catch (cause) {
      if (cause.code !== 'ENOENT' || !create) throw failure('夸克加密密钥缺失，请恢复备份或重新配置账号', 503);
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      const generated = randomBytes(32);
      try { const file = await open(path, 'wx', 0o600); try { await file.writeFile(generated); } finally { await file.close(); } key = generated; } catch (cause) { if (cause.code !== 'EEXIST') throw failure('无法安全保存夸克加密密钥', 503); const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink()) throw failure('夸克密钥必须是独立普通文件', 503); key = await readFile(path); }
    }
    if (key.length !== 32) { key = undefined; throw failure('夸克加密密钥格式无效', 503); }
    await chmod(path, 0o600);
    return key;
  }
  async function encrypt(value) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', await encryptionKey(true), iv);
    cipher.setAAD(Buffer.from('vipvideo/quark-account/v1'));
    return { iv: iv.toString('base64'), ciphertext: Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]).toString('base64'), tag: cipher.getAuthTag().toString('base64') };
  }
  async function unlock() {
    if (loaded) return cookie;
    if (unlocking) return unlocking;
    const account = config.account, generation = epoch;
    unlocking = (async () => {
      if (!account) { loaded = true; return ''; }
      try {
        const decipher = createDecipheriv('aes-256-gcm', await encryptionKey(), Buffer.from(account.iv, 'base64'));
        decipher.setAAD(Buffer.from('vipvideo/quark-account/v1')); decipher.setAuthTag(Buffer.from(account.tag, 'base64'));
        const decoded = cookieInput(Buffer.concat([decipher.update(Buffer.from(account.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
        if (generation === epoch) { cookie = decoded; loaded = true; }
      } catch { if (generation === epoch) { cookie = ''; loaded = true; lastError = '无法解密夸克账号，请恢复 quark.key 或重新配置账号'; } }
      return cookie;
    })().finally(() => { unlocking = undefined; });
    return unlocking;
  }
  async function limited(operation) {
    if (active >= 2) { if (waiters.length >= 64) throw failure('夸克请求繁忙，请稍后重试', 429); await new Promise(resolve => waiters.push(resolve)); } else active++;
    try { return await operation(); } finally { const next = waiters.shift(); if (next) next(); else active--; }
  }
  async function api(path, { method = 'GET', body, query = {}, credentials = '', guard, beforeSend, userAgent = UA } = {}) {
    return limited(async () => {
      if (stopped) throw failure('夸克服务正在关闭', 503);
      guard?.();
      beforeSend?.();
      const target = new URL(API + path); target.search = new URLSearchParams({ pr: 'ucpro', fr: 'pc', ...query }).toString();
      let response, timeout, expired = false;
      try {
        const task = (async () => {
          response = await request(target.href, { method, body: body === undefined ? undefined : JSON.stringify(body), followRedirects: false, timeout: 8000, headers: { accept: 'application/json', 'content-type': 'application/json', referer: REFERER, 'user-agent': userAgent, ...(credentials ? { cookie: credentials } : {}) } });
          response.on('error', () => {});
          if (expired) { response.destroy(); throw failure('夸克接口请求超过8秒', 504); }
          if (response.finalUrl && new URL(response.finalUrl).origin !== new URL(API).origin) throw failure('夸克接口返回了非官方目标，已停止请求');
          if (response.statusCode !== 200) throw responseFailure(response.statusCode);
          const json = JSON.parse(await readText(response, 1024 * 1024));
          if (json.code !== 0 || Number(json.status || 200) >= 400) throw responseFailure(Number(json.status || 200), json.code, response.statusCode);
          return json;
        })();
        return await Promise.race([task, new Promise((_, reject) => { timeout = setTimeout(() => { expired = true; response?.destroy(); reject(failure('夸克接口请求超过8秒', 504)); }, 8000); })]);
      } catch (cause) { if (cause.quarkSafe) throw cause; throw failure('夸克接口连接失败，请稍后重试'); }
      finally { expired = true; clearTimeout(timeout); response?.destroy(); }
    });
    function responseFailure(status, code, httpStatus = status) {
      const cause = status === 401 ? accountFailure(credentials ? '夸克登录验证未通过，请在设置中更新网页登录 Cookie' : '此夸克分享需要登录，请在设置中连接并启用夸克账号')
        : status === 403 ? failure('夸克接口拒绝访问（403），可能存在分享权限或访问限制，请到夸克官方页面确认', 403)
          : status === 429 ? failure('夸克请求过于频繁（429），请稍后重试', 429)
            : failure(path.startsWith('/share/sharepage/') ? '夸克分享暂时不可读取，可能已失效、需要提取码或受访问限制，请打开公开分享确认' : '夸克接口暂时不可用，请稍后重试');
      if (Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599) cause.quarkUpstreamStatus = httpStatus;
      if (Number.isSafeInteger(code)) cause.quarkUpstreamCode = code;
      return cause;
    }
  }
  async function verify(value) {
    const profile = await api('/config', { credentials: value });
    const root = await api('/file/sort', { credentials: value, query: { pdir_fid: '0', _page: '1', _size: '1', _fetch_total: '1' } });
    if (!Array.isArray(root.data?.list)) throw accountFailure('未能确认夸克账号登录状态');
    return accountId(profile, root, value);
  }
  async function snapshot() {
    const value = await unlock();
    if (!config.enabled || !value || !config.account?.id) throw accountFailure('请先在设置中连接并启用夸克账号');
    return { cookie: value, account: config.account.id, epoch };
  }
  const current = context => {
    if (stopped || !config.enabled || context.epoch !== epoch || config.account?.id !== context.account) throw failure('夸克账号已变更或服务正在关闭，操作已取消', 409);
    if (context.valid) { try { if (context.valid() !== true) throw failure('影片观看授权已失效，已取消夸克操作', 409); } catch (cause) { throw failure('影片观看授权已失效，已取消夸克操作', [401, 403, 409].includes(cause.status) ? cause.status : 409); } }
  };
  const auth = (context, path, options = {}) => { current(context); return api(path, { ...options, credentials: context.cookie, guard: () => current(context) }); };
  const publicAsset = (asset, reused = false) => ({ assetId: asset.id, name: asset.name, category: asset.category || '', status: asset.status === 'ready' ? 'ready' : 'pending', saved: asset.status === 'ready', reused, ...(asset.status === 'ready' ? {} : { reason: asset.task ? '转存任务仍在处理，请稍后重试' : '上次转存响应不确定，为避免重复转存请稍后检查专用目录' }) });
  const findAsset = (assetId, context) => { const asset = registry.assets.find(value => value.id === assetId && value.account === context.account && value.managed === true); if (!asset) throw failure('未找到已登记的夸克视频', 404); return asset; };
  function searchUrl(value) {
    if (value === SIDECAR && searchRequest !== networkRequest) return value;
    try { const url = validateUrl(value); if (!url.hostname.includes('.') && !url.hostname.includes(':')) throw failure('公开搜索地址必须是公网域名或地址', 400); return url.href; }
    catch { throw failure('公开搜索地址不符合安全限制', 400); }
  }
  async function settings() {
    const value = await unlock();
    return { ...Object.fromEntries(Object.keys(defaults).map(field => [field, config[field]])), searchApi: config.searchApi || defaultSearchApi, configured: !!value, account: { connected: !!value, label: value ? '已连接账号' : '未连接' }, managedFiles: registry.assets.filter(asset => asset.account === config.account?.id && asset.status !== 'deleted').length, lastCleanup: registry.lastCleanup, lastError };
  }
  function schedule() {
    clearTimeout(timer); timer = undefined;
    if (started && !stopped && config.cleanupEnabled && config.enabled && config.account) {
      const previous = Number(registry.lastCleanup?.at), due = Number.isFinite(previous) && previous > 0 && previous <= now() ? previous + DAY : now();
      timer = setTimeout(() => { timer = undefined; cleanup().catch(cause => { error(cause); schedule(); }); }, Math.max(5000, Math.min(DAY, due - now())));
      timer.unref?.();
    }
  }
  async function configure(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw failure('夸克设置格式无效', 400);
    const next = { ...config };
    for (const field of ['enabled', 'autoSave', 'cleanupEnabled']) if (Object.hasOwn(input, field)) { if (typeof input[field] !== 'boolean') throw failure('夸克开关设置无效', 400); next[field] = input[field]; }
    for (const [field, minimum, maximum] of [['retentionDays', 1, 365], ['maxDailyTransfers', 1, 100], ['maxDailyBytes', 1024 * 1024, DAILY_BYTES]]) if (Object.hasOwn(input, field)) { if (!Number.isSafeInteger(input[field]) || input[field] < minimum || input[field] > maximum) throw failure('夸克容量或保留期设置无效', 400); next[field] = input[field]; }
    if (Object.hasOwn(input, 'searchApi')) { if (typeof input.searchApi !== 'string' || input.searchApi.length > 2048) throw failure('公开搜索地址无效', 400); next.searchApi = input.searchApi ? searchUrl(input.searchApi) : ''; }
    if (Object.hasOwn(input, 'cookie')) {
      const value = cookieInput(input.cookie), generation = ++epoch;
      candidates.clear();
      const account = await verify(value);
      if (generation !== epoch) throw failure('账号配置已被更新，本次验证已取消', 409);
      next.account = { id: account, ...await encrypt(value) };
      if (generation !== epoch) throw failure('账号配置已被更新，本次验证已取消', 409);
      cookie = value; loaded = true;
    }
    Object.assign(config, next); searches.clear(); lastError = ''; persist(); schedule(); return settings();
  }
  async function clearAccount() {
    epoch++; cookie = ''; loaded = true; delete config.account; config.enabled = false; config.autoSave = false; config.cleanupEnabled = false;
    candidates.clear();
    persist(); schedule(); return settings();
  }
  function addShare(info, link, label) {
    const parsed = share(link?.url || link, link?.password || link?.pwd || ''); if (!parsed) return null;
    const publishedAt = Number.isSafeInteger(link?.publishedAt) && link.publishedAt >= 0 && link.publishedAt <= now() + DAY ? link.publishedAt : undefined;
    const duplicate = [...shares.values()].find(value => value.detail === info.key && value.pwdId === parsed.pwdId);
    const row = duplicate || { id: id(), detail: info.key, ...parsed };
    if (!duplicate || !row.name || publishedAt !== undefined && publishedAt > (row.publishedAt ?? -1)) row.name = name(label || link?.name || link?.title) || info.title;
    if (parsed.password && (!row.password || publishedAt !== undefined && publishedAt > (row.passwordAt ?? -1))) { row.password = parsed.password; row.url = parsed.url; row.passwordAt = publishedAt ?? -1; }
    if (publishedAt !== undefined && publishedAt > (row.publishedAt ?? -1)) row.publishedAt = publishedAt;
    row.expires = now() + 10 * 60000; shares.set(row.id, row);
    while (shares.size > 128) shares.delete(shares.keys().next().value);
    return { id: row.id, name: row.name, url: row.url, ...(row.publishedAt === undefined ? {} : { publishedAt: row.publishedAt }) };
  }
  async function lookupResources(detail, options = {}) {
    const info = detailInfo(detail, options), rows = new Map();
    const provided = detail.quarkShares || detail.meta?.quarkShares || [];
    for (const link of (Array.isArray(provided) ? provided : [provided]).slice(0, 20)) { const row = addShare(info, link); if (row) rows.set(row.id, row); }
    let reason;
    const cached = searches.get(info.key);
    if (cached && cached.expires > now()) reason = cached.reason;
    if (cached && cached.expires > now()) for (const row of cached.rows) { const existing = shares.get(row.id); if (existing) { const fresh = addShare(info, existing, existing.name); rows.set(fresh.id, fresh); } }
    if (!cached || cached.expires <= now() || options.webSearch === true) {
      reason = undefined;
      let response, timeout, expired = false;
      try {
        const configured = config.searchApi || defaultSearchApi;
        const target = configured ? new URL(searchUrl(configured)) : new URL('https://www.bing.com/search');
        if (configured) { target.searchParams.set('kw', info.searchTitle); target.searchParams.set('cloud_types', 'quark'); target.searchParams.set('res', 'results'); target.searchParams.set('conc', '2'); }
        else { target.searchParams.set('q', info.searchTitle + ' site:pan.quark.cn/s'); target.searchParams.set('format', 'rss'); }
        const fetch = limited(async () => { if (expired) throw failure('公开夸克搜索超时', 504); response = await searchRequest(target.href, { method: 'GET', timeout: 8000, year: info.year, aliases: info.aliases, webSearch: options.webSearch === true, headers: { accept: configured ? 'application/json' : 'application/rss+xml, application/xml' } }); response.on('error', () => {}); if (expired) { response.destroy(); throw failure('公开夸克搜索超时', 504); } if (response.statusCode !== 200) throw failure('公开夸克搜索暂不可用'); return readText(response, 2 * 1024 * 1024); });
        const body = await Promise.race([fetch, new Promise((_, reject) => { timeout = setTimeout(() => { expired = true; response?.destroy(); reject(failure('公开夸克搜索超时', 504)); }, 8000); })]);
        let visited = 0;
        const found = [], visit = (value, label = '', depth = 0) => {
          if (++visited > 10000 || depth > 6 || found.length >= 30) return;
          if (typeof value === 'string') { for (const match of value.replace(/&amp;/g, '&').matchAll(/https:\/\/pan\.quark\.cn\/s\/[a-z0-9]{6,32}(?:\?pwd=[a-z0-9]{1,16})?/gi)) { if (found.length >= 30) break; found.push({ url: match[0], name: label }); } }
          else if (Array.isArray(value)) value.slice(0, 100).forEach(item => visit(item, label, depth + 1));
          else if (value && typeof value === 'object') {
            const title = name(value.work_title || value.title || value.name || value.file_name || value.note) || label;
            if ((!value.type || value.type === 'quark') && share(value.url || value.link, value.password || '')) found.push({ url: value.url || value.link, password: value.password || '', name: title, publishedAt: value.publishedAt });
            for (const [field, item] of Object.entries(value).slice(0, 30)) if (['links', 'results', 'data', 'merged_by_type', 'quark', 'list'].includes(field)) visit(item, title, depth + 1);
          }
        };
        try { const result = JSON.parse(body); visit(result); if (typeof result?.reason === 'string') reason = name(result.reason); } catch { visit(body); }
        for (const link of found) { const row = addShare(info, link, link.name); if (row) rows.set(row.id, row); }
        if (rows.size || !reason) searches.set(info.key, { rows: [...rows.values()], ...(reason ? { reason } : {}), expires: now() + 60000 });
        else searches.delete(info.key);
        while (searches.size > 64) searches.delete(searches.keys().next().value);
      } catch (cause) { reason = publicReason(cause); }
      finally { expired = true; clearTimeout(timeout); response?.destroy(); }
    }
    return { resources: [...rows.values()].sort((a, b) => (b.publishedAt ?? -1) - (a.publishedAt ?? -1)), ...(reason ? { reason } : {}) };
  }
  async function resources(detail, options = {}) {
    const key = detailInfo(detail, options).key + ':' + (config.searchApi || defaultSearchApi) + ':' + (options.webSearch === true ? 'web' : 'normal');
    if (searchFlights.has(key)) return structuredClone(await searchFlights.get(key));
    if (searchFlights.size >= 64) return { resources: [], reason: '公开夸克搜索繁忙，请稍后重试' };
    const job = lookupResources(detail, options).finally(() => searchFlights.delete(key)); searchFlights.set(key, job);
    return structuredClone(await job);
  }
  async function files(detail, options = {}) {
    const info = detailInfo(detail, options), resource = shares.get(options.shareId);
    if (!resource || resource.detail !== info.key || resource.expires <= now()) throw failure('分享资源已过期，请重新搜索', 404);
    const generation = epoch, context = config.enabled && config.account ? await snapshot() : undefined;
    if (context) context.valid = options.valid;
    const guard = () => {
      if (stopped || generation !== epoch) throw failure('夸克账号已变更或服务正在关闭，操作已取消', 409);
      if (context) current(context);
      else if (options.valid && options.valid() !== true) throw failure('影片观看授权已失效，已取消夸克操作', 409);
    };
    const read = (path, input) => context ? auth(context, path, input) : api(path, { ...input, guard });
    guard();
    const token = await read('/share/sharepage/token', { method: 'POST', body: { pwd_id: resource.pwdId, passcode: resource.password } });
    guard();
    if (typeof token.data?.stoken !== 'string' || !token.data.stoken || token.data.stoken.length > 4096) throw failure('夸克分享已失效或需要提取码');
    const queue = [{ fid: '0', path: [], depth: 0, page: 1 }], found = [], visited = new Set(); let requests = 1, truncated = false;
    while (queue.length && requests < 6) {
      const folder = queue.shift(), key = folder.fid + ':' + folder.page;
      if (visited.has(key)) { truncated = true; continue; } visited.add(key); requests++;
      const result = await read('/share/sharepage/detail', { query: { pwd_id: resource.pwdId, stoken: token.data.stoken, pdir_fid: folder.fid, _page: String(folder.page), _size: '100', _fetch_total: '1', ver: '2', force: '0' } });
      guard();
      if (!Array.isArray(result.data?.list) || result.data.list.length > 100) throw failure('夸克分享目录格式无效');
      for (const row of result.data.list) {
        if (!validFid(row.fid) || !name(row.file_name)) continue;
        if (directory(row)) { if (folder.depth < 2) queue.push({ fid: row.fid, path: [...folder.path, name(row.file_name)], depth: folder.depth + 1, page: 1 }); else truncated = true; }
        else if (video(row)) {
          const old = [...candidates.values()].find(file => file.detail === info.key && file.share === resource.id && file.fid === row.fid);
          const file = { id: old?.id || id(), detail: info.key, share: resource.id, fid: row.fid, parent: folder.fid, name: name(row.file_name), path: folder.path, size: Number(row.size), token: row.share_fid_token, stoken: token.data.stoken, expires: now() + 10 * 60000 };
          candidates.set(file.id, file); found.push(file);
          while (candidates.size > 1000) candidates.delete(candidates.keys().next().value);
        }
      }
      const total = Number(result.metadata?._total); if (Number.isFinite(total) && total > folder.page * 100) queue.push({ ...folder, page: folder.page + 1 });
    }
    truncated ||= queue.length > 0;
    const output = found.map(file => ({ id: file.id, name: file.name, size: Number.isSafeInteger(file.size) && file.size > 0 ? file.size : null, match: matches(info, file), episode: episodeNumber(file.name.replace(/\.[^.]+$/, '')) }));
    return { files: output, truncated, ambiguous: truncated || output.filter(file => file.match).length !== 1 };
  }
  async function ownList(context, parent) {
    const output = []; let complete = false;
    for (let page = 1; page <= 6; page++) {
      const result = await auth(context, '/file/sort', { query: { pdir_fid: parent, _page: String(page), _size: '100', _fetch_total: '1', fetch_all_file: '1', _sort: 'file_type:asc,updated_at:desc' } }); current(context);
      if (!Array.isArray(result.data?.list) || result.data.list.length > 100) throw failure('无法可靠核验夸克文件目录');
      output.push(...result.data.list);
      const total = Number(result.metadata?._total);
      if (result.data.list.length < 100 || Number.isSafeInteger(total) && total >= output.length && total <= page * 100) { complete = true; break; }
    }
    return { list: output, complete };
  }
  async function ownedFolder(context, create = false) {
    current(context);
    let folder = registry.folders[context.account];
    if (!folder) folder = { name: 'VipVideo-' + config.installId, createdAt: now() };
    const root = await ownList(context, '0'); current(context);
    const matches = root.list.filter(row => directory(row) && row.file_name === folder.name && (!folder.fid || row.fid === folder.fid) && (!row.pdir_fid || row.pdir_fid === '0'));
    if (matches.length === 1 && validFid(matches[0].fid) && (folder.fid || folder.mkdirStarted && !Object.entries(registry.folders).some(([account, entry]) => account !== context.account && entry.fid === matches[0].fid))) { folder.fid = matches[0].fid; delete folder.mkdirStarted; persist(); return folder; }
    if (!folder.fid && !folder.mkdirStarted && root.complete && matches.length === 1 && (matches[0].pdir_fid === '0' || matches[0].pdir_fid === 0) && !registry.assets.some(asset => asset.account === context.account)) {
      const previous = Object.entries(registry.folders).filter(([account, entry]) => account !== context.account && entry.name === folder.name && validFid(entry.fid) && !entry.mkdirStarted);
      if (previous.length === 1 && previous[0][1].fid === matches[0].fid) {
        current(context);
        const [account, entry] = previous[0]; folder = { ...entry };
        for (const asset of registry.assets) if (asset.account === account && asset.parent === folder.fid) {
          asset.account = context.account;
          if (asset.deleteIntent?.account === account && asset.deleteIntent.parent === folder.fid && asset.deleteIntent.fid === asset.fid) asset.deleteIntent.account = context.account;
        }
        delete registry.folders[account]; registry.folders[context.account] = folder; persist(); return folder;
      }
    }
    if (!create || folder.fid && !folder.mkdirStarted || !root.complete || root.list.some(row => row.file_name === folder.name)) {
      const reason = !root.complete ? '根目录列表超过核验范围，已停止操作'
        : matches.length > 1 ? '目录记录冲突，已停止操作'
          : folder.fid ? '已登记目录未找到或已改名、移动，请在夸克恢复原目录后重试'
            : matches.length ? '存在同名但未登记的目录，已停止操作' : '目录登记不完整，已停止操作';
      throw failure('无法确认本应用专用夸克目录：' + reason, 409);
    }
    if (!registry.folders[context.account]) { registry.folders[context.account] = folder; persist(); }
    if (!folder.mkdirStarted) {
      const created = await auth(context, '/file', { method: 'POST', body: { pdir_fid: '0', file_name: folder.name, dir_path: '', dir_init_lock: false }, beforeSend: () => { current(context); folder.mkdirStarted = true; persist(); } }); current(context);
      if (created.data?.fid !== undefined) { if (!validFid(created.data.fid)) throw failure('无法核验夸克创建目录的响应', 409); folder.fid = created.data.fid; persist(); }
    }
    // Quark can acknowledge mkdir before its directory listing is updated; retry reads, never creation.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, attempt * 500)); current(context);
      const confirmed = await ownList(context, '0'), rows = confirmed.list.filter(row => directory(row) && row.file_name === folder.name && (!folder.fid || row.fid === folder.fid) && (!row.pdir_fid || row.pdir_fid === '0'));
      if (rows.length === 1 && validFid(rows[0].fid)) { folder.fid = rows[0].fid; delete folder.mkdirStarted; persist(); return folder; }
      if (rows.length) throw failure('无法确认本应用专用夸克目录：创建后的目录记录冲突，已停止操作', 409);
    }
    throw failure('夸克专用目录暂未可见，请稍后重试', 409);
  }
  async function ownedFile(context, asset) {
    const folder = await ownedFolder(context); if (folder.fid !== asset.parent) throw failure('视频不在本应用专用目录，已停止操作', 409);
    const result = await ownList(context, folder.fid), file = result.list.find(row => row.fid === asset.fid);
    if (!file || !video(file) || file.file_name !== asset.name || Number(file.size) !== asset.size || file.pdir_fid && file.pdir_fid !== folder.fid) throw failure('无法核验本应用登记的单个视频，已停止操作', 409);
    return file;
  }
  async function resume(context, asset) {
    if (!asset.task) return publicAsset(asset, true);
    const result = await auth(context, '/task', { query: { task_id: asset.task, retry_index: '0' } }); current(context);
    const fids = result.data?.save_as?.save_as_select_top_fids || result.data?.save_as?.save_as_top_fids;
    if (!Array.isArray(fids) || fids.length !== 1 || !validFid(fids[0])) return publicAsset(asset, true);
    asset.fid = fids[0]; await ownedFile(context, asset); current(context);
    asset.status = 'ready'; persist(); return publicAsset(asset);
  }
  async function prepare(detail, options = {}) {
    const info = detailInfo(detail, options);
    const key = epoch + ':' + (config.account?.id || '') + ':' + info.key + ':' + JSON.stringify([options.shareId || '', options.fileId || '', info.line, info.index]);
    if (prepareFlights.has(key)) return prepareFlights.get(key);
    const job = serialize(async () => {
      let queuedAsset;
      try {
        const context = await snapshot(); context.valid = typeof options.valid === 'function' ? options.valid : undefined; current(context);
        if (!info.selected) return { status: 'needsSelection', saved: false, reason: '请先选择当前影片的单集' };
        if (!options.fileId && (!config.autoSave || options.auto === false)) return { status: 'needsSelection', saved: false, reason: '请选择单个文件，或在设置中开启自动转存' };
        let file;
        if (options.fileId) { file = candidates.get(options.fileId); if (!file || file.detail !== info.key || file.expires <= now() || options.shareId && file.share !== options.shareId) throw failure('所选单个视频已过期，请重新选取', 404); }
        else {
          const resourceRows = options.shareId ? [{ id: options.shareId }] : (await resources(detail, options)).resources;
          if (resourceRows.length !== 1) return { status: 'needsSelection', saved: false, reason: resourceRows.length ? '存在多个分享资源，请选择其中一个' : '未找到可用夸克分享资源' };
          const result = await files(detail, { ...options, shareId: resourceRows[0].id });
          if (result.ambiguous) return { status: 'needsSelection', saved: false, reason: '无法唯一匹配影片年份及当前单集，请手动选择文件' };
          file = candidates.get(result.files.find(row => row.match).id);
        }
        current(context);
        if (!validFid(file.fid) || typeof file.token !== 'string' || !file.token || file.token.length > 4096 || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > 100 * GIB) throw failure('视频大小或分享凭证无法核验，已停止转存', 400);
        const resource = shares.get(file.share); if (!resource || resource.detail !== info.key || resource.expires <= now()) throw failure('分享资源已过期，请重新搜索', 404);
        if (registry.assets.length >= 1000 && !registry.folders[context.account]?.fid) await ownedFolder(context);
        const source = hash(resource.pwdId + ':' + file.fid), existing = registry.assets.find(asset => asset.account === context.account && asset.source === source && asset.status !== 'deleted');
        if (existing) { if (detail.category === 'adult' || !existing.category) { existing.category = name(detail.category).slice(0, 32); persist(); } if (existing.status === 'ready') { await ownedFile(context, existing); return publicAsset(existing, true); } return resume(context, existing); }
        const day = new Date(now()).toISOString().slice(0, 10), retained = registry.assets.filter(asset => asset.status !== 'deleted' || asset.day === day);
        if (retained.length !== registry.assets.length) { registry.assets = retained; persist(); }
        const today = registry.assets.filter(asset => asset.account === context.account && asset.day === day && asset.status !== 'queued');
        if (today.length >= config.maxDailyTransfers || today.reduce((sum, asset) => sum + asset.size, 0) + file.size > config.maxDailyBytes || registry.assets.length >= 1000) throw failure('已达到本应用每日转存数量或容量上限', 429);
        const folder = await ownedFolder(context, true); current(context);
        const reconnected = registry.assets.find(asset => asset.account === context.account && asset.source === source && asset.status !== 'deleted');
        if (reconnected) { if (detail.category === 'adult' || !reconnected.category) { reconnected.category = name(detail.category).slice(0, 32); persist(); } if (reconnected.status === 'ready') { await ownedFile(context, reconnected); return publicAsset(reconnected, true); } return resume(context, reconnected); }
        const reconnectedToday = registry.assets.filter(asset => asset.account === context.account && asset.day === day && asset.status !== 'queued');
        if (reconnectedToday.length >= config.maxDailyTransfers || reconnectedToday.reduce((sum, asset) => sum + asset.size, 0) + file.size > config.maxDailyBytes || registry.assets.length >= 1000) throw failure('已达到本应用每日转存数量或容量上限', 429);
        const asset = { id: id(), account: context.account, managed: true, source, parent: folder.fid, name: file.name, size: file.size, category: name(detail.category).slice(0, 32), day, createdAt: now(), lastActivity: now(), status: 'queued' };
        queuedAsset = asset;
        registry.assets.push(asset); persist();
        const result = await auth(context, '/share/sharepage/save', { method: 'POST', body: { fid_list: [file.fid], fid_token_list: [file.token], to_pdir_fid: folder.fid, pwd_id: resource.pwdId, stoken: file.stoken, pdir_fid: file.parent, scene: 'link' }, beforeSend: () => { current(context); asset.status = 'saving'; persist(); } });
        if (validFid(result.data?.task_id)) { asset.task = result.data.task_id; persist(); }
        current(context); return resume(context, asset);
      } catch (cause) { if (queuedAsset?.status === 'queued') { registry.assets = registry.assets.filter(asset => asset !== queuedAsset); persist(); } return { status: 'error', saved: false, reason: error(cause) }; }
    }).finally(() => prepareFlights.delete(key));
    prepareFlights.set(key, job); return job;
  }
  async function playback(assetId, options = {}) {
    const context = await snapshot(); context.valid = typeof options.valid === 'function' ? options.valid : undefined; current(context);
    const asset = findAsset(assetId, context);
    if (asset.status !== 'ready') throw failure('夸克视频尚未就绪或正在清理', 409);
    asset.leaseUntil = now() + 120000; asset.lastActivity = now(); persist();
    await ownedFile(context, asset); current(context);
    let target, type, mode = 'official', quality, officialError;
    const diagnostic = cause => [Number.isInteger(cause?.quarkUpstreamStatus) ? 'HTTP ' + cause.quarkUpstreamStatus : '', Number.isSafeInteger(cause?.quarkUpstreamCode) ? 'API ' + cause.quarkUpstreamCode : ''].filter(Boolean).join('，');
    try {
      const result = await auth(context, '/file/v2/play/project', { method: 'POST', userAgent: PLAYBACK_UA, body: { fid: asset.fid, resolutions: 'low,normal,high,super,2k,4k', supports: 'fmp4_av,m3u8,dolby_vision' } }); current(context);
      const list = (Array.isArray(result.data?.video_list) ? result.data.video_list : []).filter(row => row?.accessable !== false).map(row => row?.video_info).filter(info => typeof info?.url === 'string' && info.success !== false && info.finish !== false).sort((a, b) => (Number(b.height) || 0) - (Number(a.height) || 0));
      for (const info of list) { try { target = validateUrl(info.url).href; type = /\.m3u8$/i.test(new URL(target).pathname) || /hls|m3u8/i.test(String(info.format || info.hls_type || '')) ? 'hls' : 'mp4'; if (Number.isSafeInteger(info.width) && Number.isSafeInteger(info.height) && info.width > 0 && info.width <= 8192 && info.height > 0 && info.height <= 4320) quality = { width: info.width, height: info.height }; break; } catch {} }
    } catch (cause) { current(context); if ([401, 429].includes(cause.status)) throw cause; officialError = cause; }
    if (!target) {
      mode = 'download'; let result;
      try { result = await auth(context, '/file/download', { method: 'POST', userAgent: PLAYBACK_UA, query: { uc_param_str: '' }, body: { fids: [asset.fid] } }); current(context); }
      catch (cause) {
        current(context); if ([401, 429].includes(cause.status)) throw cause;
        const project = diagnostic(officialError), download = diagnostic(cause);
        throw failure(`夸克官方在线播放未提供可用链接${project ? '（' + project + '）' : ''}；原文件链接获取也失败${download ? '（' + download + '）' : ''}。请在夸克官方客户端确认该文件可下载后重试`, [403, 504].includes(cause.status) ? cause.status : 502);
      }
      const row = Array.isArray(result.data) && result.data.length === 1 && result.data.find(row => (!row.fid || row.fid === asset.fid) && typeof row.download_url === 'string');
      if (!row) throw failure('夸克未返回可播放的原文件链接');
      try { target = validateUrl(row.download_url).href; } catch { throw failure('夸克返回的播放地址不符合安全限制'); }
      type = /\.mkv$/i.test(asset.name) ? 'mkv' : /\.webm$/i.test(asset.name) ? 'webm' : /\.avi$/i.test(asset.name) ? 'avi' : /\.(?:ts|m2ts)$/i.test(asset.name) ? 'mpegts' : 'mp4';
    }
    const parsed = new URL(target), firstParty = parsed.protocol === 'https:' && (parsed.hostname === 'quark.cn' || parsed.hostname.endsWith('.quark.cn') || parsed.hostname === 'uc.cn' || parsed.hostname.endsWith('.uc.cn'));
    current(context);
    return { episode: { url: target, type }, headers: { referer: REFERER, 'user-agent': PLAYBACK_UA, ...(firstParty ? { cookie: context.cookie } : {}) }, allowCookieOrigins: firstParty ? [parsed.origin] : [], metadata: { assetId: asset.id, name: asset.name, size: asset.size, category: asset.category || '', mode, version: hash(JSON.stringify([asset.fid, mode, quality || null])).slice(0, 24), ...(quality ? { quality } : {}), requiresCompatibility: !['hls', 'mp4', 'webm'].includes(type) } };
  }
  async function progress(assetId, input) {
    const context = await snapshot(), asset = findAsset(assetId, context);
    if (asset.status !== 'ready' || !input || typeof input.ended !== 'boolean' || !Number.isFinite(input.position) || !Number.isFinite(input.duration) || input.position < 0 || input.duration <= 0 || input.duration > 86400 || input.position > input.duration + 2) throw failure('夸克观看进度无效', 400);
    asset.leaseUntil = now() + 120000; asset.lastActivity = now(); asset.position = input.position; asset.duration = input.duration;
    const ended = input.ended && input.position >= input.duration - 2;
    if (ended) asset.watchedAt = now(); else if (input.position < input.duration - 2) delete asset.watchedAt;
    persist(); return { saved: true, ended, watchedAt: asset.watchedAt || null };
  }
  async function recycleList(context) {
    const list = []; let complete = false;
    for (let page = 1; page <= 6; page++) { const result = await auth(context, '/file/recycle/list', { query: { _page: String(page), _size: '100' } }); current(context); if (!Array.isArray(result.data?.list)) throw failure('无法可靠核验回收站中的单个文件'); list.push(...result.data.list); if (result.data.list.length < 100 || Number(result.metadata?._total) <= page * 100) { complete = true; break; } }
    return { list, complete };
  }
  async function cleanup() {
    return serialize(async () => {
      const result = { checked: 0, deleted: 0, recycled: 0, skipped: 0, errors: 0, at: now() };
      if (!config.cleanupEnabled || !config.enabled || !config.account) return result;
      try {
        const context = await snapshot();
        if (await verify(context.cookie) !== context.account) throw failure('夸克账号身份变化，已停止清理', 409); current(context); await ownedFolder(context);
        const eligible = registry.assets.filter(asset => asset.account === context.account && asset.managed && asset.watchedAt > 0 && now() - Math.max(asset.watchedAt, asset.lastActivity || 0) >= config.retentionDays * DAY && !(asset.leaseUntil > now()) && ['ready', 'recycling', 'purging'].includes(asset.status)).slice(0, 5);
        for (const asset of eligible) {
          result.checked++;
          try {
            current(context);
            if (asset.leaseUntil > now() || now() - Math.max(asset.watchedAt || 0, asset.lastActivity || 0) < config.retentionDays * DAY) { result.skipped++; continue; }
            if (asset.status === 'ready') {
              await ownedFile(context, asset); current(context);
              if (!config.cleanupEnabled || asset.leaseUntil > now() || !asset.watchedAt || now() - Math.max(asset.watchedAt, asset.lastActivity || 0) < config.retentionDays * DAY) { result.skipped++; continue; }
              asset.status = 'recycling'; asset.deleteIntent = { account: context.account, parent: asset.parent, fid: asset.fid, at: now() }; persist();
              const response = await auth(context, '/file/delete', { method: 'POST', body: { action_type: 2, filelist: [asset.fid], exclude_fids: [] } }); current(context);
              if (validFid(response.data?.task_id)) { asset.deleteTask = response.data.task_id; persist(); await auth(context, '/task', { query: { task_id: asset.deleteTask, retry_index: '0' } }); }
              result.recycled++;
            }
            if (!asset.deleteIntent || asset.deleteIntent.account !== context.account || asset.deleteIntent.parent !== asset.parent || asset.deleteIntent.fid !== asset.fid) throw failure('没有本应用单文件清理凭证，已停止操作', 409);
            const trash = await recycleList(context); current(context);
            const records = trash.list.filter(row => row.fid === asset.fid && row.file_name === asset.name && Number(row.size) === asset.size && (!row.pdir_fid || row.pdir_fid === asset.parent));
            if (records.length === 1 && validFid(records[0].record_id)) {
              if (!config.cleanupEnabled || asset.leaseUntil > now() || !asset.watchedAt || now() - Math.max(asset.watchedAt, asset.lastActivity || 0) < config.retentionDays * DAY) { result.skipped++; continue; }
              asset.status = 'purging'; asset.recycleId = records[0].record_id; persist();
              await auth(context, '/file/recycle/remove', { method: 'POST', body: { select_mode: 2, record_list: [asset.recycleId] } }); current(context); asset.purgeAcknowledged = true; persist();
              const after = await recycleList(context);
              const cloud = await ownList(context, asset.parent);
              if (cloud.list.some(row => row.fid === asset.fid)) { asset.status = 'ready'; asset.lastActivity = now(); delete asset.watchedAt; persist(); result.skipped++; }
              else if (after.complete && cloud.complete && !after.list.some(row => row.fid === asset.fid || row.record_id === asset.recycleId)) { asset.status = 'deleted'; asset.deletedAt = now(); result.deleted++; persist(); }
            } else if (asset.status === 'purging' && asset.purgeAcknowledged && trash.complete && !trash.list.some(row => row.fid === asset.fid || row.record_id === asset.recycleId)) { const cloud = await ownList(context, asset.parent); if (cloud.complete && !cloud.list.some(row => row.fid === asset.fid)) { asset.status = 'deleted'; asset.deletedAt = now(); result.deleted++; persist(); } else result.skipped++; }
            else { result.skipped++; }
          } catch (cause) { result.errors++; error(cause); }
        }
      } catch (cause) { result.errors++; error(cause); }
      registry.lastCleanup = result; persist(); schedule(); return result;
    });
  }
  const track = operation => (...args) => {
    if (stopped) return Promise.reject(failure('夸克服务已关闭', 503));
    const job = (async () => operation(...args))(); jobs.add(job);
    job.then(() => jobs.delete(job), () => jobs.delete(job));
    return job;
  };
  const start = () => { if (stopped) return; started = true; schedule(); };
  const stop = () => {
    if (stopPromise) return stopPromise;
    stopped = true; started = false; clearTimeout(timer); timer = undefined; epoch++;
    stopPromise = (async () => { await Promise.allSettled([...jobs]); await tail; })();
    return stopPromise;
  };
  return { settings: track(settings), configure: track(configure), clearAccount: track(clearAccount), resources: track(resources), files: track(files), prepare: track(prepare), playback: track(playback), progress: track(progress), cleanup: track(cleanup), start, stop };
}
