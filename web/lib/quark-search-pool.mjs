import { Readable } from 'node:stream';
import { request as networkRequest, readText, validateUrl } from './network.mjs';
import { createQuarkSearchRequest } from './quark-search.mjs';
import { searchGoogleQuark, searchBingQuark, quarkPasswordDate, classifyQuarkCandidate } from './quark-google-search.mjs';

const KEY = 'quark-search-pool-v1', DAY = 86_400_000, HEALTH_INTERVAL = 6 * 60 * 60_000;
const RECALL_KEY = 'quark-search-availability-v3';
const SIDECAR = 'http://pansou:8888/api/search';
const OFFICIAL = 'https://so.252035.xyz/api/search';
const publishedApis = ['https://pansou.252035.xyz/api/search', 'https://www.pansousuo.com/api/search'];
const sources = [
  'https://api.github.com/repos/fish2018/pansou-web',
  'https://raw.githubusercontent.com/fish2018/pansou-web/main/README.md',
];
const deployments = [
  ...['pansou in:name fork:false', 'pansou in:name fork:only'].map(q => 'https://api.github.com/search/repositories?' + new URLSearchParams({ q, sort: 'updated', per_page: '5' })),
  'https://raw.githubusercontent.com/fish2018/pansou/main/plugin/quarkres/quarkres.go',
];
const directories = ['PanSou "api/search"', '夸克 搜索 "api/search" PanSou', '网盘搜索 公共 API PanSou "api/search"', 'PanSou 公共 部署 搜索 API', '夸克 网盘搜索 "api/search"', 'PanSou 网盘搜索 在线 服务'].map(q => 'https://www.bing.com/search?' + new URLSearchParams({ format: 'rss', q }));
const searchFields = ['kw', 'cloud_types', 'res', 'src', 'conc', 'channels', 'plugins', 'refresh'];
const sensitive = key => /cookie|authorization|password|secret|api.?key|(?:^|_)token(?:$|_)/i.test(key);
const failure = (message, status = 502, local = false) => Object.assign(new Error(message), { status, quarkSafe: true, quarkPoolReason: message, ...(local ? { quarkPoolLocal: true } : {}) });
function safeFailure(cause, reading = false) {
  if (cause?.quarkPoolReason) return cause;
  const code = cause?.code || cause?.cause?.code || cause?.cause?.cause?.code;
  if (code === 'ETIMEDOUT' || cause?.name === 'TimeoutError' || ['网盘搜索超时（8 秒）', '影视源请求超时', '影视源读取超时'].includes(cause?.message)) return failure('搜索请求超时', 504);
  if (code === 'ENOTFOUND') return failure('搜索服务域名解析失败');
  if (code === 'EAI_AGAIN') return failure('搜索服务域名暂时无法解析');
  if (code === 'ECONNREFUSED') return failure('搜索服务拒绝连接，请确认服务已启动');
  if (['ENETUNREACH', 'EHOSTUNREACH'].includes(code)) return failure('搜索服务网络不可达');
  if (['ECONNRESET', 'ECONNABORTED', 'EPIPE', 'ENETRESET'].includes(code)) return failure(reading ? '搜索响应读取中断' : '搜索服务连接中断');
  if (['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_TLS_HANDSHAKE_TIMEOUT', 'ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_SSL_PROTOCOL_ERROR'].includes(code)) return failure('搜索服务 TLS 验证或握手失败');
  if (['影视源响应过大', '搜索结果超过 2 MiB'].includes(cause?.message)) return failure('搜索响应内容异常（超过大小限制）');
  if (['Z_DATA_ERROR', 'Z_BUF_ERROR'].includes(code) || cause?.message === '影视源使用了不支持的内容编码') return failure('搜索响应内容异常（编码不支持或数据损坏）');
  if (cause?.status === 403) return failure('搜索地址被安全检查拒绝' + (cause.message === '不允许访问内网或保留地址' ? '（域名解析到内网或保留地址）' : ''), 403);
  return failure(reading ? '搜索响应正文读取失败' : '搜索服务连接失败');
}

function endpoint(value, internal = false) {
  if (typeof value !== 'string' || value.length > 8192 || value.includes('#')) throw failure('搜索地址无效', 400);
  const exactSidecar = /^http:\/\/pansou:8888\/api\/search(?:\?[^#]*)?$/.test(value);
  const url = validateUrl(value);
  if ([...url.searchParams.keys()].some(sensitive)) throw failure('搜索地址不能包含账号凭证', 400);
  if ((!internal || !exactSidecar) && !url.hostname.includes('.') && !url.hostname.includes(':')) throw failure('自动搜索仅接受公网地址', 403);
  for (const field of searchFields) url.searchParams.delete(field);
  return url.href;
}
function candidate(value) {
  const url = new URL(endpoint(value));
  if (!/^\/api\/search\/?$/.test(url.pathname) || url.search) throw failure('公开候选不是 PanSou 搜索接口', 400);
  url.pathname = '/api/search';
  return url.href;
}
function share(value, password = '') {
  try {
    const url = validateUrl(value);
    if (url.protocol !== 'https:' || url.hostname !== 'pan.quark.cn' || url.port || !/^\/s\/[a-z0-9]{6,32}\/?$/i.test(url.pathname)) return;
    const pwd = password || url.searchParams.get('pwd') || '';
    if (typeof pwd !== 'string' || !/^[A-Za-z0-9]{0,16}$/.test(pwd)) return;
    return { url: url.origin + url.pathname.replace(/\/$/, '') + (pwd ? '?pwd=' + encodeURIComponent(pwd) : ''), ...(pwd ? { password: pwd } : {}) };
  } catch { return; }
}
function timestamp(value, at = Date.now()) {
  const parsed = typeof value === 'number' && value > 9999 ? value < 1e12 ? value * 1000 : value : typeof value === 'string' && value.length <= 100 && /^(?:\d{4}-\d{2}-\d{2}(?:[T\s]|$)|(?:[A-Za-z]{3},?\s+)?\d{1,2}\s+[A-Za-z]{3}\s+\d{4}(?:\s|$))/.test(value) ? Date.parse(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= at + DAY ? parsed : undefined;
}
// A newer post without a code must not make an older code appear newer.
const passwordDate = Symbol('passwordDate');
function mergeShare(rows, row) {
  const link = share(row.url, row.password || ''); if (!link) return;
  row = { ...row, ...link };
  const key = new URL(row.url).pathname, previous = rows.get(key);
  const codeDate = row[passwordDate] ?? row.publishedAt ?? 0, previousCodeDate = previous?.[passwordDate] ?? previous?.publishedAt ?? 0;
  const replace = !previous || row.password && (!previous.password || codeDate > previousCodeDate);
  const selected = replace ? { ...row } : previous, date = Math.max(row.publishedAt || 0, previous?.publishedAt || 0);
  if (selected.password) selected[passwordDate] = replace ? codeDate : previousCodeDate;
  if (date) selected.publishedAt = date;
  rows.set(key, selected);
}
function shares(data, at) {
  const found = new Map(); let visited = 0;
  function visit(value, title = '', depth = 0, publishedAt) {
    if (++visited > 10_000 || depth > 6) return;
    if (Array.isArray(value)) { for (const item of value.slice(0, 500)) visit(item, title, depth + 1, publishedAt); return; }
    if (!value || typeof value !== 'object') return;
    title = String(value.work_title || value.title || value.name || value.file_name || title || value.note || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 300);
    publishedAt = timestamp(value.publishedAt ?? value.published_at ?? value.datetime ?? value.date, at) ?? publishedAt;
    const link = (!value.type || value.type === 'quark') && (!value.pan || value.pan === 'quark') && share(value.url || value.link || value.share_url, value.password || value.access_code || '');
    if (link) mergeShare(found, { ...link, name: title, ...(publishedAt ? { publishedAt } : {}) });
    for (const key of ['results', 'links', 'data', 'merged_by_type', 'quark', 'list', 'items']) if (value[key] !== undefined) visit(value[key], title, depth + 1, publishedAt);
  }
  visit(data);
  return [...found.values()];
}
function compatible(body, at) {
  let data; try { data = JSON.parse(body); } catch { throw failure('搜索接口未返回 JSON'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return;
  const payload = data.data && typeof data.data === 'object' ? data.data : data;
  if (data.error || data.success === false || data.code !== undefined && ![0, 200, '0', '200'].includes(data.code)) return;
  if (Object.hasOwn(payload, 'results') && !Array.isArray(payload.results) || Object.hasOwn(payload, 'items') && !Array.isArray(payload.items) || Object.hasOwn(payload, 'merged_by_type') && (!payload.merged_by_type || typeof payload.merged_by_type !== 'object' || Array.isArray(payload.merged_by_type))) return;
  if (payload === data.data && !Array.isArray(payload) && payload.total === 0 && [0, 200, '0', '200'].includes(data.code) && !['results', 'merged_by_type', 'list'].some(key => Object.hasOwn(payload, key))) return [];
  if (!Array.isArray(payload) && !Array.isArray(payload.results) && !Array.isArray(payload.list) && !Array.isArray(payload.items) && !(payload.merged_by_type && typeof payload.merged_by_type === 'object' && !Array.isArray(payload.merged_by_type))) return;
  return shares(data, at);
}
function queryTerms(keyword, values, yearHint) {
  const hinted = /^(?:19|20)\d{2}$/.test(String(yearHint || ''));
  const dated = yearHint !== undefined ? undefined : /^(.*?)\s+((?:19|20)\d{2})$/.exec(keyword), title = dated?.[1] || keyword;
  const aliases = (Array.isArray(values) ? values.slice(0, 10) : []).filter(value => typeof value === 'string' && value.trim() && value.length <= 300 && !/[\u0000-\u001f\u007f]/.test(value)).slice(0, 2).map(value => value.trim());
  const year = hinted ? String(yearHint) : dated?.[2];
  return { title, aliases, words: [...new Set([title, ...aliases, ...(year ? [title + ' ' + year] : [])])], year };
}
function relevance(row, query) {
  return classifyQuarkCandidate(row.name, query) === 'matched' ? 1 : 0;
}
const ranked = (rows, query) => [...rows].sort((a, b) => relevance(b, query) - relevance(a, query) || (b.publishedAt || 0) - (a.publishedAt || 0));
const result = (rows, query, reason, pending = false) => {
  const found = ranked(rows, query).slice(0, 30).sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));
  const results = found.filter(row => classifyQuarkCandidate(row.name, query) === 'matched');
  const unverified = found.filter(row => classifyQuarkCandidate(row.name, query) === 'unknown').slice(0, 10).map(row => ({ ...row, name: row.name || '未提供资源标题' }));
  const body = JSON.stringify({ results, ...(unverified.length ? { unverified } : {}), ...(reason ? { reason } : {}), ...(pending ? { pending: true, retryAfterMs: 1500 } : {}) });
  return Object.assign(Readable.from([body]), { statusCode: 200, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } });
};

export function createQuarkSearchPool({ store, request = createQuarkSearchRequest(), discoveryRequest = networkRequest, webRequest = networkRequest, googleSearch = searchGoogleQuark, renderSearch, now = Date.now } = {}) {
  if (!store?.meta || !store?.setMeta) throw new TypeError('Search pool requires store metadata');
  let state = { candidates: [], retired: [], lastDiscovery: 0, lastHealth: 0, healthCursor: 0, discoveryCursor: 0, discoveryError: '' };
  let active = 0, timer, started = false, stopping = false, discoveryJob, currentPrimary;
  const waiting = [], jobs = new Set(), recent = new Map(), rendered = new Map();
  try {
    const text = store.meta(KEY);
    if (typeof text === 'string' && text.length <= 64 * 1024) {
      const saved = JSON.parse(text);
      for (const key of ['lastDiscovery', 'lastHealth', 'healthCursor', 'discoveryCursor']) if (Number.isSafeInteger(saved[key]) && saved[key] >= 0 && saved[key] <= now()) state[key] = saved[key];
      for (const row of Array.isArray(saved.candidates) ? saved.candidates.slice(0, 8) : []) {
        try {
          const url = row.automatic === false ? endpoint(row.url, true) : candidate(row.url);
          state.candidates.push({ url, automatic: row.automatic !== false, source: row.automatic === false ? '手动配置' : row.source === '官方项目' ? '官方项目' : '公开目录',
            status: ['healthy', 'pending', 'paused'].includes(row.status) ? row.status : 'pending', failures: Math.min(8, Math.max(0, Number(row.failures) || 0)),
            addedAt: Math.max(0, Math.min(now(), Number(row.addedAt) || 0)), checkedAt: Math.max(0, Math.min(now(), Number(row.checkedAt) || 0)), retryAt: Math.max(0, Math.min(now() + HEALTH_INTERVAL, Number(row.retryAt) || 0)),
            ...(Number.isSafeInteger(row.firstFailedAt) && row.firstFailedAt > 0 && row.firstFailedAt <= now() ? { firstFailedAt: row.firstFailedAt } : {}) });
        } catch { /* Saved endpoints are revalidated before reuse. */ }
      }
      for (const row of Array.isArray(saved.retired) ? saved.retired.slice(-8) : []) {
        try { if (Number.isSafeInteger(row.expires) && row.expires > now() && row.expires <= now() + 7 * DAY) state.retired.push({ url: candidate(row.url), expires: row.expires }); }
        catch { /* Invalid retirement records never suppress configured interfaces. */ }
      }
    }
  } catch { state.discoveryError = '已保存的搜索接口记录无法读取'; }
  const persist = () => { if (!stopping) store.setMeta(KEY, JSON.stringify(state)); };
  function prune() {
    const before = state.candidates.length, retired = state.retired.length;
    state.retired = state.retired.filter(row => row.expires > now());
    state.candidates = state.candidates.filter(row => {
      if (!row.automatic || row.url === SIDECAR || row.url === currentPrimary || row.status !== 'paused' || row.failures < 3 || !row.firstFailedAt || row.checkedAt - row.firstFailedAt < DAY) return true;
      state.retired = [...state.retired.filter(item => item.url !== row.url), { url: row.url, expires: now() + 7 * DAY }].slice(-8); return false;
    });
    return state.candidates.length !== before || state.retired.length !== retired;
  }
  function add(url, source, automatic = true) {
    if (automatic && state.retired.some(row => row.url === url && row.expires > now())) return;
    if (!automatic) state.retired = state.retired.filter(row => row.url !== url);
    const existing = state.candidates.find(row => row.url === url);
    if (existing) { if (!automatic) { existing.automatic = false; existing.source = source; } else if (existing.automatic) existing.source = source; return existing; }
    prune();
    if (state.candidates.length >= 8) {
      const removable = state.candidates.filter(row => row.url !== currentPrimary && row.url !== SIDECAR && row.automatic && (row.status !== 'healthy' || !automatic)).sort((a, b) => Number(a.status === 'healthy') - Number(b.status === 'healthy') || a.addedAt - b.addedAt);
      if (!removable.length) return;
      state.candidates.splice(state.candidates.indexOf(removable[0]), 1);
    }
    const row = { url, source, automatic, status: 'pending', failures: 0, addedAt: now(), checkedAt: 0, retryAt: 0 };
    state.candidates.push(row); return row;
  }
  add(OFFICIAL, '官方项目');
  function track(work) {
    const job = Promise.resolve().then(work); jobs.add(job);
    job.then(() => jobs.delete(job), () => jobs.delete(job)); return job;
  }
  async function slot(deadline) {
    if (stopping || deadline <= now()) throw failure('公开搜索已停止或超时', 503, true);
    if (active < 2) { active++; return; }
    if (waiting.length >= 16) throw failure('公开搜索繁忙，请稍后重试', 503, true);
    await new Promise((resolve, reject) => {
      const entry = { resolve: () => { clearTimeout(entry.timer); resolve(); }, reject: error => { clearTimeout(entry.timer); reject(error); } };
      entry.timer = setTimeout(() => { const index = waiting.indexOf(entry); if (index >= 0) waiting.splice(index, 1); entry.reject(failure('公开搜索排队超时', 504, true)); }, Math.max(1, deadline - now()));
      waiting.push(entry);
    });
  }
  function release() { const next = waiting.shift(); if (next) next.resolve(); else active--; }
  function text(url, duration, transport = request, maxBytes = 2 * 1024 * 1024, deadline = now() + duration, followRedirects = false) {
    return track(async () => {
      await slot(deadline);
      let response, timeout, remaining = 0, reading = false, expired = false;
      try {
        if (stopping || deadline <= now()) throw failure('公开搜索已停止或超时', 503, true);
        remaining = Math.max(1, Math.min(duration, deadline - now()));
        const work = (async () => {
          const browser = followRedirects && transport === request;
          response = await (browser ? webRequest : transport)(url, { method: 'GET', timeout: remaining, followRedirects, headers: browser
            ? { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'accept-language': 'zh-CN,zh;q=0.9', 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' }
            : { accept: 'application/json, application/rss+xml, text/plain', 'user-agent': 'VipVideo-Web-quark-search' } });
          if (expired) { response.destroy(); throw failure('公开搜索超时', 504); }
          if (response.statusCode !== 200) throw failure('搜索接口返回 HTTP ' + (Number.isInteger(response.statusCode) && response.statusCode >= 100 && response.statusCode <= 599 ? response.statusCode : 502));
          reading = true;
          return await readText(response, maxBytes);
        })();
        return await Promise.race([work, new Promise((_, reject) => { timeout = setTimeout(() => { expired = true; response?.destroy(); reject(failure('公开搜索超时', 504)); }, remaining); })]);
      } catch (cause) { throw Object.assign(safeFailure(cause, reading), { searchBudgetMs: remaining }); }
      finally { expired = true; clearTimeout(timeout); response?.destroy(); release(); }
    });
  }
  function checked(row, links) {
    if (stopping) return;
    row.checkedAt = now(); row.failures = 0; row.retryAt = 0; delete row.error; delete row.firstFailedAt;
    if (links.length) row.status = 'healthy'; else if (row.status !== 'healthy') row.status = 'pending';
    persist();
  }
  function failed(row, cause) {
    if (stopping || cause?.quarkPoolLocal) return;
    row.firstFailedAt ??= now();
    row.checkedAt = now(); row.failures = Math.min(8, row.failures + 1); row.status = 'paused';
    const delay = row.url === SIDECAR ? Math.min(60_000, 10_000 * 2 ** (row.failures - 1)) : Math.min(HEALTH_INTERVAL, 15 * 60_000 * 2 ** (row.failures - 1));
    row.retryAt = now() + delay; row.error = '接口未通过搜索验证，已暂时避开'; prune(); persist();
  }
  function apiUrl(base, keyword) {
    const url = new URL(base);
    const params = ['www.pansousuo.com', 'pansousuo.com'].includes(url.hostname) ? { q: keyword, pan: 'quark', sort: 'latest' } : { kw: keyword, cloud_types: 'quark', res: 'results', conc: '1' };
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.href;
  }
  async function verifyCandidates() {
    if (stopping) return;
    if (prune()) persist();
    const rows = state.candidates.filter(row => row.automatic && row.retryAt <= now() && (row.status !== 'healthy' || now() - row.checkedAt >= HEALTH_INTERVAL));
    for (let count = 0; count < Math.min(2, rows.length) && !stopping; count++) {
      const row = rows[(state.healthCursor + count) % rows.length];
      try { const links = compatible(await text(apiUrl(row.url, '星际穿越'), 4000), now()); if (stopping) break; if (links === undefined) throw failure('搜索接口格式不兼容'); checked(row, links); }
      catch (cause) { if (stopping) break; failed(row, cause); }
    }
    if (!stopping) { state.healthCursor += Math.min(2, rows.length); state.lastHealth = now(); persist(); }
  }
  function status() {
    const automatic = state.candidates.filter(row => row.automatic && row.url !== currentPrimary);
    return { enabled: !stopping, discovering: !!discoveryJob, lastDiscovery: state.lastDiscovery, lastHealth: state.lastHealth,
      healthy: automatic.filter(row => row.status === 'healthy' && row.retryAt <= now()).length,
      pending: automatic.filter(row => row.status === 'pending').length,
      suspended: automatic.filter(row => row.status === 'paused').length,
      candidates: state.candidates.map(row => { const url = new URL(row.url); return { apiUrl: url.origin + url.pathname, source: row.source, status: row.status, checkedAt: row.checkedAt, retryAt: row.retryAt, ...(row.error ? { reason: '接口未通过搜索验证，已暂时避开' } : {}) }; }),
      ...(state.discoveryError ? { reason: state.discoveryError } : {}) };
  }
  function discover() {
    if (discoveryJob) return discoveryJob;
    if (stopping || state.lastDiscovery && now() - state.lastDiscovery < DAY) return Promise.resolve(status());
    discoveryJob = track(async () => {
      state.lastDiscovery = now(); state.discoveryError = '';
      const pages = [...sources, deployments[state.discoveryCursor % deployments.length], directories[state.discoveryCursor++ % directories.length]];
      for (const url of pages) {
        if (stopping) break;
        try {
          const body = await text(url, 2500, discoveryRequest, 512 * 1024);
          if (stopping) break;
          const found = [];
          if (url.startsWith('https://api.github.com/')) {
            const metadata = JSON.parse(body);
            for (const { homepage } of Array.isArray(metadata.items) ? metadata.items.slice(0, 5) : [metadata]) {
              try { if (typeof homepage === 'string' && homepage) { const published = new URL(endpoint(homepage)); published.pathname = '/api/search'; published.search = ''; found.push(published.href); } }
              catch { /* A bad published homepage must not hide other deployments. */ }
            }
          }
          for (const match of body.replace(/&amp;/g, '&').matchAll(/https?:\/\/[^\s<>"'()\\]+/gi)) found.push(match[0].replace(/[.,;\]}]+$/, ''));
          for (const value of found.slice(0, 40)) { try { add(candidate(value), sources.includes(url) ? '官方项目' : '公开目录'); } catch { /* Only explicitly published public API endpoints become candidates. */ } }
        } catch { if (stopping) break; state.discoveryError = '部分公开接口目录暂不可访问，保留现有接口'; }
      }
      for (const url of publishedApis) add(url, '公开目录');
      await verifyCandidates(); persist(); return status();
    });
    discoveryJob.then(() => { discoveryJob = undefined; }, () => { discoveryJob = undefined; });
    return discoveryJob;
  }
  function schedule(delay = HEALTH_INTERVAL) {
    clearTimeout(timer);
    if (!started || stopping) return;
    timer = setTimeout(() => {
      const job = !state.lastDiscovery || now() - state.lastDiscovery >= DAY ? discover() : track(verifyCandidates);
      job.catch(() => { if (!stopping) { state.discoveryError = '搜索接口后台验证暂未完成'; persist(); } }).finally(() => schedule());
    }, delay);
    timer.unref?.();
  }
  function render(entry, query, merge, report, forceRefresh = false) {
    if (stopping || typeof renderSearch !== 'function') return;
    const key = JSON.stringify([query.title, query.aliases, query.year]);
    for (const [key, work] of rendered) if (!work.pending && work.expires <= now()) rendered.delete(key);
    let work = rendered.get(key);
    if (work && !work.pending && (forceRefresh || !work.useful)) { rendered.delete(key); work = undefined; }
    if (!work) {
      if (rendered.size >= 32) for (const [key, item] of rendered) if (!item.pending) { rendered.delete(key); break; }
      if (rendered.size >= 32) { report('公开网页搜索繁忙，请稍后重试'); return; }
      const controller = new AbortController(), deadline = now() + 45000;
      work = { controller, pending: true, page: entry.page, expires: now() + 2 * 60_000 }; rendered.set(key, work);
      work.promise = track(async () => {
        if (controller.signal.aborted) throw controller.signal.reason;
        let abort;
        const timeout = setTimeout(() => controller.abort(failure('公开网页搜索超时', 504)), 45000);
        try {
          const rows = await Promise.race([
            track(() => { if (controller.signal.aborted) throw controller.signal.reason; return renderSearch({ title: query.title, aliases: query.aliases, year: query.year, page: work.page }, { signal: controller.signal, deadline }); }),
            new Promise((_, reject) => { abort = () => reject(controller.signal.reason || failure('公开网页搜索已停止', 503, true)); controller.signal.addEventListener('abort', abort, { once: true }); }),
          ]);
          if (!Array.isArray(rows)) throw failure('公开网页搜索响应格式不兼容');
          work.useful = rows.some(row => share(row.url, row.password || '') && classifyQuarkCandidate(row.name, query) !== 'unrelated');
          return rows;
        } finally { clearTimeout(timeout); controller.signal.removeEventListener('abort', abort); work.pending = false; }
      });
    }
    entry.pending = true;
    track(async () => {
      try { const rows = await work.promise; merge(rows); if (rows.reason) report('公开网页搜索：' + rows.reason); }
      catch (cause) { if (!stopping) report('公开网页搜索：' + safeFailure(cause).quarkPoolReason); }
      finally { entry.pending = false; entry.expires = now() + 2 * 60_000; }
    });
  }
  return {
    request(value, _options = {}) {
      return track(async () => {
        if (stopping) throw failure('公开搜索已停止', 503, true);
        const input = value instanceof URL ? value.href : value, base = endpoint(input, true), parsed = new URL(input);
        const webUrl = parsed.hostname === 'www.bing.com' && parsed.pathname === '/search', web = webUrl || _options.webSearch === true;
        const keyword = (parsed.searchParams.get(webUrl ? 'q' : 'kw') || '').replace(/\s+site:pan\.quark\.cn\/s\b/gi, '').trim().slice(0, 1000);
        if (!keyword) throw failure('搜索关键词不能为空', 400);
        const query = queryTerms(keyword, _options.aliases, _options.year), cacheKey = JSON.stringify([base, keyword, query.words, query.year, web]);
        const cached = recent.get(cacheKey);
        if (_options.poll === true) return cached && cached.expires > now() ? result([...cached.rows.values()], query, cached.reason, cached.pending || !!cached.fast) : result([], query, '公开搜索检查已结束，请重试搜索');
        const forceRefresh = _options.forceRefresh === true;
        if (cached && cached.expires > now() && (cached.fast || cached.pending || !forceRefresh && cached.rows.size)) {
          if (cached.fast) await cached.fast;
          if (stopping) throw failure('公开搜索已停止', 503, true);
          return result([...cached.rows.values()], query, cached.reason, cached.pending);
        }
        currentPrimary = web ? undefined : base;
        const primary = web ? undefined : add(base, '手动配置', false), deadline = now() + 7500;
        if (primary && store.meta(RECALL_KEY) !== '1') {
          store.setMeta(RECALL_KEY, '1');
          if (!primary.automatic && primary.status === 'paused') { primary.status = 'pending'; primary.retryAt = 0; persist(); }
        }
        if (primary?.url === SIDECAR && primary.status === 'paused' && primary.retryAt > now() + 60_000) { primary.status = 'pending'; primary.retryAt = 0; persist(); }
        for (const [key, entry] of recent) if (entry.expires <= now()) recent.delete(key);
        const previousRender = rendered.get(JSON.stringify([query.title, query.aliases, query.year]));
        const previousPage = cached?.page ?? previousRender?.page;
        const page = previousRender?.pending ? previousRender.page : forceRefresh && previousPage !== undefined ? (previousPage + 1) % 3 : previousPage ?? 0;
        const entry = { rows: new Map(forceRefresh && cached?.expires > now() ? cached.rows : []), page, expires: now() + 2 * 60_000 };
        let finish;
        entry.fast = new Promise(resolve => { finish = resolve; });
        const notes = new Set(), report = message => { notes.add(message); entry.reason = [...notes].join('；'); };
        if (primary && primary.retryAt > now()) report('已配置搜索接口正在暂缓重试，约 ' + (primary.url === SIDECAR ? Math.ceil((primary.retryAt - now()) / 1000) + ' 秒' : Math.ceil((primary.retryAt - now()) / 60_000) + ' 分钟') + '后重试');
        recent.set(cacheKey, entry); while (recent.size > 32) recent.delete(recent.keys().next().value);
        const merge = rows => {
          if (stopping || entry.expires <= now()) return;
          for (const row of rows) {
            if (!share(row.url, row.password || '') || classifyQuarkCandidate(row.name, query) === 'unrelated') continue;
            const { publishedAt: rawDate, ...item } = row, publishedAt = timestamp(rawDate, now());
            const previous = entry.rows.get(new URL(row.url).pathname);
            mergeShare(entry.rows, { ...item, ...(publishedAt ? { publishedAt } : {}), ...(row[quarkPasswordDate] === undefined ? {} : { [passwordDate]: row[quarkPasswordDate] }) });
            if (relevance(row, query) && !relevance(previous || {}, query)) entry.rows.get(new URL(row.url).pathname).name = row.name;
          }
          entry.rows = new Map(ranked(entry.rows.values(), query).slice(0, 30).map(row => [new URL(row.url).pathname, row]));
        };
        try {
          const backups = state.candidates.filter(row => row.automatic && row.url !== base && row.status === 'healthy' && row.retryAt <= now()).sort((a, b) => b.checkedAt - a.checkedAt);
          const selected = web ? [] : [...(primary && primary.retryAt <= now() ? [primary] : []), ...backups].slice(0, 2);
          const attempts = selected.map(row => track(async () => {
            let answered = false;
            for (const [index, word] of query.words.entries()) {
              if (stopping || index && deadline - 1800 - now() < 250) break;
              const budget = Math.min(5500, deadline - 1800 - now());
              try {
                const links = compatible(await text(apiUrl(row.url, word), 5500, request, 2 * 1024 * 1024, deadline - 1800), now());
                if (links === undefined) throw failure('搜索接口响应格式不兼容'); answered = true; checked(row, links);
                merge(links); const matched = links.filter(link => relevance(link, query)); if (matched.length) return matched;
              } catch (cause) {
                // A short optional query does not establish a site-wide failure.
                if (!answered && (cause?.searchBudgetMs ?? budget) >= 5000) failed(row, cause);
                const reason = safeFailure(cause).quarkPoolReason;
                report((row === primary ? '已配置搜索接口：' : '备用搜索接口：') + (row.url === SIDECAR && reason === '搜索服务域名解析失败' ? '找不到搜索助手，请确认 pansou 服务已启动' : reason)); break;
              }
            }
            return [];
          }));
          const first = await new Promise(resolve => {
            let remaining = attempts.length;
            if (!remaining) resolve([]);
            for (const attempt of attempts) attempt.then(links => { if (links.length) resolve(links); else if (!--remaining) resolve([]); }, () => { if (!--remaining) resolve([]); });
          });
          if (stopping) throw failure('公开搜索已停止', 503, true);
          if (first.length) {
            let timer;
            try { await Promise.race([Promise.allSettled(attempts), new Promise(done => { timer = setTimeout(done, Math.max(1, Math.min(150, deadline - now()))); })]); }
            finally { clearTimeout(timer); }
            if (stopping) throw failure('公开搜索已停止', 503, true);
            return result([...entry.rows.values()], query, entry.reason);
          }
          const pages = await Promise.allSettled([
            googleSearch(query.title, { aliases: query.aliases, year: query.year, page, titleOnly: true, read: (url, duration, maxBytes, limit) => text(url, duration, request, maxBytes, Math.min(deadline, limit ?? deadline), true), deadline, now }),
            searchBingQuark(query.title, { aliases: query.aliases, year: query.year, page, titleOnly: true, read: (url, duration, maxBytes, limit) => text(url, duration, request, maxBytes, Math.min(deadline, limit ?? deadline), true), deadline, now }),
          ]);
          if (stopping) throw failure('公开搜索已停止', 503, true);
          for (const [index, page] of pages.entries()) {
            const name = index === 0 ? 'Google 公开搜索：' : 'Bing 公开搜索：';
            if (page.status === 'fulfilled') { merge(page.value); if (page.value.reason) report(name + page.value.reason); }
            else report(name + safeFailure(page.reason).quarkPoolReason);
          }
          if (web || ![...entry.rows.values()].some(row => relevance(row, query))) render(entry, query, merge, report, forceRefresh);
          return result([...entry.rows.values()], query, entry.reason, entry.pending);
        } finally { delete entry.fast; finish(); }
      });
    },
    status, discover,
    start() { if (!started) { started = true; stopping = false; schedule(0); } },
    async stop() { stopping = true; started = false; clearTimeout(timer); for (const work of rendered.values()) work.controller.abort(failure('公开网页搜索已停止', 503, true)); recent.clear(); rendered.clear(); for (const entry of waiting.splice(0)) entry.reject(failure('公开搜索已停止', 503, true)); while (jobs.size) await Promise.allSettled([...jobs]); },
  };
}
