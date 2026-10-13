import { Readable } from 'node:stream';
import { request as networkRequest, readText, validateUrl } from './network.mjs';
import { createQuarkSearchRequest } from './quark-search.mjs';
import { searchGoogleQuark } from './quark-google-search.mjs';

const KEY = 'quark-search-pool-v1', DAY = 86_400_000, HEALTH_INTERVAL = 6 * 60 * 60_000;
const RECALL_KEY = 'quark-search-recall-v2';
const OFFICIAL = 'https://so.252035.xyz/api/search';
const sources = [
  'https://api.github.com/repos/fish2018/pansou-web',
  'https://raw.githubusercontent.com/fish2018/pansou-web/main/README.md',
  ...['PanSou "api/search"', '夸克 搜索 "api/search" PanSou', '网盘搜索 公共 API PanSou "api/search"'].map(query => 'https://www.bing.com/search?' + new URLSearchParams({ format: 'rss', q: query })),
];
const searchFields = ['kw', 'cloud_types', 'res', 'src', 'conc', 'channels', 'plugins', 'refresh'];
const sensitive = key => /cookie|authorization|password|secret|api.?key|(?:^|_)token(?:$|_)/i.test(key);
const failure = (message, status = 502, local = false) => Object.assign(new Error(message), { status, quarkSafe: true, ...(local ? { quarkPoolLocal: true } : {}) });

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
    const link = (!value.type || value.type === 'quark') && share(value.url || value.link, value.password || '');
    if (link) mergeShare(found, { ...link, name: title, ...(publishedAt ? { publishedAt } : {}) });
    for (const key of ['results', 'links', 'data', 'merged_by_type', 'quark', 'list']) if (value[key] !== undefined) visit(value[key], title, depth + 1, publishedAt);
  }
  visit(data);
  return [...found.values()];
}
function compatible(body, at) {
  let data; try { data = JSON.parse(body); } catch { return; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return;
  const payload = data.data && typeof data.data === 'object' ? data.data : data;
  if (data.error || data.success === false || data.code !== undefined && ![0, 200, '0', '200'].includes(data.code)) return;
  if (!Array.isArray(payload) && !Array.isArray(payload.results) && !Array.isArray(payload.list) && !(payload.merged_by_type && typeof payload.merged_by_type === 'object' && !Array.isArray(payload.merged_by_type))) return;
  return shares(data, at);
}
function rssShares(body, at) {
  if (!/<rss\b/i.test(body) || /<!DOCTYPE\b|<!ENTITY\b|captcha|安全验证/i.test(body)) throw failure('公开网页搜索暂不可用');
  const rows = new Map(); let visited = 0;
  for (const item of body.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    if (++visited > 500) break;
    const title = (/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(item[1])?.[1] || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]*>/g, '').replace(/&(?:amp|quot|apos|lt|gt);/g, value => ({ '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' })[value]).slice(0, 300);
    const publishedAt = timestamp(/<pubDate\b[^>]*>([\s\S]*?)<\/pubDate>/i.exec(item[1])?.[1]?.trim(), at);
    for (const match of item[1].replace(/&amp;/g, '&').matchAll(/https:\/\/pan\.quark\.cn\/s\/[a-z0-9]{6,32}(?:\?pwd=[a-z0-9]{1,16})?/gi)) {
      const link = share(match[0]);
      if (link) mergeShare(rows, { ...link, name: title, ...(publishedAt ? { publishedAt } : {}) });
      if (rows.size >= 10_000) break;
    }
    if (rows.size >= 10_000) break;
  }
  return [...rows.values()];
}
const normalized = value => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
function queryTerms(keyword, values, yearHint) {
  const hinted = /^(?:19|20)\d{2}$/.test(String(yearHint || ''));
  const dated = yearHint !== undefined ? undefined : /^(.*?)\s+((?:19|20)\d{2})$/.exec(keyword), title = dated?.[1] || keyword;
  const aliases = (Array.isArray(values) ? values.slice(0, 10) : []).filter(value => typeof value === 'string' && value.trim() && value.length <= 300 && !/[\u0000-\u001f\u007f]/.test(value)).slice(0, 2).map(value => value.trim());
  const year = hinted ? String(yearHint) : dated?.[2];
  return { title, aliases, words: [...new Set([title, ...aliases, ...(year ? [title + ' ' + year] : [])])], titles: [...new Set([title, ...aliases].map(normalized).filter(Boolean))].map(word => ({ word, pattern: /^[a-z0-9]+$/.test(word) ? new RegExp('(?:^|[^a-z0-9])' + word.split('').join('[^a-z0-9]*') + '(?:$|[^a-z0-9])', 'i') : undefined })), year };
}
function relevance(row, query) {
  const title = normalized(row.name || '');
  return query?.titles.some(({ word, pattern }) => title.includes(word) && (!pattern || pattern.test((row.name || '').normalize('NFKC')))) ? 1 : 0;
}
const ranked = (rows, query) => [...rows].sort((a, b) => relevance(b, query) - relevance(a, query) || (b.publishedAt || 0) - (a.publishedAt || 0));
const result = (rows, query, reason) => {
  const found = ranked(rows, query).slice(0, 30).sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0)).map(row => ({ ...row, name: row.name || '未提供资源标题' }));
  const body = JSON.stringify({ results: found, ...(reason ? { reason } : {}) });
  return Object.assign(Readable.from([body]), { statusCode: 200, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } });
};

export function createQuarkSearchPool({ store, request = createQuarkSearchRequest(), discoveryRequest = networkRequest, googleSearch = searchGoogleQuark, now = Date.now } = {}) {
  if (!store?.meta || !store?.setMeta) throw new TypeError('Search pool requires store metadata');
  let state = { candidates: [], lastDiscovery: 0, lastHealth: 0, healthCursor: 0, discoveryCursor: 0, discoveryError: '' };
  let active = 0, timer, started = false, stopping = false, discoveryJob, currentPrimary;
  const waiting = [], jobs = new Set(), recent = new Map();
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
            addedAt: Math.max(0, Math.min(now(), Number(row.addedAt) || 0)), checkedAt: Math.max(0, Math.min(now(), Number(row.checkedAt) || 0)), retryAt: Math.max(0, Math.min(now() + HEALTH_INTERVAL, Number(row.retryAt) || 0)) });
        } catch { /* Saved endpoints are revalidated before reuse. */ }
      }
    }
  } catch { state.discoveryError = '已保存的搜索接口记录无法读取'; }
  const persist = () => { if (!stopping) store.setMeta(KEY, JSON.stringify(state)); };
  function add(url, source, automatic = true) {
    const existing = state.candidates.find(row => row.url === url);
    if (existing) { if (automatic) { existing.automatic = true; existing.source = source; } return existing; }
    state.candidates = state.candidates.filter(row => row.url === currentPrimary || !row.automatic || row.status === 'healthy' || row.failures < 3 && now() - row.addedAt < 7 * DAY);
    if (state.candidates.length >= 8) {
      const removable = state.candidates.filter(row => row.url !== currentPrimary && (row.automatic && row.status !== 'healthy' || !row.automatic)).sort((a, b) => a.addedAt - b.addedAt);
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
  function text(url, duration, transport = request, maxBytes = 2 * 1024 * 1024, deadline = now() + duration) {
    return track(async () => {
      await slot(deadline);
      let response, timeout, expired = false;
      try {
        if (stopping || deadline <= now()) throw failure('公开搜索已停止或超时', 503, true);
        const remaining = Math.max(1, Math.min(duration, deadline - now()));
        const work = (async () => {
          response = await transport(url, { method: 'GET', timeout: remaining, followRedirects: false, headers: { accept: 'application/json, application/rss+xml, text/plain', 'user-agent': 'VipVideo-Web-quark-search' } });
          if (expired) { response.destroy(); throw failure('公开搜索超时', 504); }
          if (response.statusCode !== 200) throw failure(response.statusCode === 401 || response.statusCode === 403 ? '公开接口需要认证或拒绝访问' : '公开搜索接口暂不可用');
          return await readText(response, maxBytes);
        })();
        return await Promise.race([work, new Promise((_, reject) => { timeout = setTimeout(() => { expired = true; response?.destroy(); reject(failure('公开搜索超时', 504)); }, remaining); })]);
      } finally { expired = true; clearTimeout(timeout); response?.destroy(); release(); }
    });
  }
  function checked(row, links) {
    if (stopping) return;
    row.checkedAt = now(); row.failures = 0; row.retryAt = 0; delete row.error;
    if (links.length) row.status = 'healthy'; else if (row.status !== 'healthy') row.status = 'pending';
    persist();
  }
  function failed(row, cause) {
    if (stopping || cause?.quarkPoolLocal) return;
    row.checkedAt = now(); row.failures = Math.min(8, row.failures + 1); row.status = 'paused';
    row.retryAt = now() + Math.min(HEALTH_INTERVAL, 15 * 60_000 * 2 ** (row.failures - 1)); row.error = '接口未通过搜索验证，已暂时避开'; persist();
  }
  function apiUrl(base, keyword) {
    const url = new URL(base);
    for (const [key, value] of Object.entries({ kw: keyword, cloud_types: 'quark', res: 'results', conc: '1' })) url.searchParams.set(key, value);
    return url.href;
  }
  async function verifyCandidates() {
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
      const directories = [...sources.slice(0, 2), sources[2 + state.discoveryCursor++ % (sources.length - 2)]];
      for (const url of directories) {
        if (stopping) break;
        try {
          const body = await text(url, 2500, discoveryRequest, 512 * 1024);
          if (stopping) break;
          const found = [];
          if (url === sources[0]) {
            const homepage = JSON.parse(body).homepage;
            if (typeof homepage === 'string' && homepage) { const published = new URL(endpoint(homepage)); published.pathname = '/api/search'; published.search = ''; found.push(published.href); }
          }
          for (const match of body.replace(/&amp;/g, '&').matchAll(/https?:\/\/[^\s<>"'()\\]+/gi)) found.push(match[0].replace(/[.,;\]}]+$/, ''));
          for (const value of found.slice(0, 40)) { try { add(candidate(value), sources.slice(0, 2).includes(url) ? '官方项目' : '公开目录'); } catch { /* Only explicitly published public API endpoints become candidates. */ } }
        } catch { if (stopping) break; state.discoveryError = '部分公开接口目录暂不可访问，保留现有接口'; }
      }
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
  return {
    request(value, _options = {}) {
      return track(async () => {
        if (stopping) throw failure('公开搜索已停止', 503, true);
        const input = value instanceof URL ? value.href : value, base = endpoint(input, true), parsed = new URL(input);
        const webUrl = parsed.hostname === 'www.bing.com' && parsed.pathname === '/search', web = webUrl || _options.webSearch === true;
        const keyword = (parsed.searchParams.get(webUrl ? 'q' : 'kw') || '').replace(/\s+site:pan\.quark\.cn\/s\b/gi, '').trim().slice(0, 1000);
        if (!keyword) throw failure('搜索关键词不能为空', 400);
        currentPrimary = web ? undefined : base;
        const primary = web ? undefined : add(base, '手动配置', false), deadline = now() + 7500;
        if (primary && store.meta(RECALL_KEY) !== '1') {
          store.setMeta(RECALL_KEY, '1');
          if (!primary.automatic && primary.status === 'paused') { primary.status = 'pending'; primary.retryAt = 0; persist(); }
        }
        const query = queryTerms(keyword, _options.aliases, _options.year), cacheKey = JSON.stringify([base, keyword, query.words, query.year, web]);
        for (const [key, entry] of recent) if (entry.expires <= now()) recent.delete(key);
        const cached = recent.get(cacheKey);
        if (cached?.rows.size) return result([...cached.rows.values()], query, cached.reason);
        const entry = { rows: new Map(), expires: now() + 2 * 60_000 };
        const notes = new Set(), report = message => { notes.add(message); entry.reason = [...notes].join('；'); };
        recent.set(cacheKey, entry); while (recent.size > 32) recent.delete(recent.keys().next().value);
        const merge = rows => {
          if (stopping || entry.expires <= now()) return;
          for (const row of rows) {
            const { publishedAt: rawDate, ...item } = row, publishedAt = timestamp(rawDate, now());
            mergeShare(entry.rows, { ...item, ...(publishedAt ? { publishedAt } : {}) });
          }
          entry.rows = new Map(ranked(entry.rows.values(), query).slice(0, 30).map(row => [new URL(row.url).pathname, row]));
        };
        const backups = state.candidates.filter(row => row.automatic && row.url !== base && row.status === 'healthy' && row.retryAt <= now()).sort((a, b) => b.checkedAt - a.checkedAt);
        const selected = web ? [] : [...(primary && primary.retryAt <= now() ? [primary] : []), ...backups].slice(0, 2);
        let valid = false;
        const attempts = selected.map(row => track(async () => {
          for (const [index, word] of query.words.entries()) {
            if (stopping || index && deadline - 1800 - now() < 250) break;
            try {
              const links = compatible(await text(apiUrl(row.url, word), 5500, request, 2 * 1024 * 1024, deadline - 1800), now());
              if (links === undefined) throw failure('搜索接口格式不兼容'); valid = true; checked(row, links);
              merge(links); const matched = links.filter(link => relevance(link, query)); if (matched.length) return matched;
            } catch (cause) { failed(row, cause); report(cause?.quarkPoolLocal ? '夸克搜索繁忙，请稍后重试' : '部分夸克搜索接口暂不可用'); break; }
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
        const fallback = new URL('https://www.bing.com/search'); fallback.search = new URLSearchParams({ q: query.title + ' site:pan.quark.cn/s', format: 'rss' }).toString();
        const pages = await Promise.allSettled([
          googleSearch(query.title, { aliases: query.aliases, titleOnly: true, read: (url, duration, maxBytes, limit) => text(url, duration, request, maxBytes, Math.min(deadline, limit ?? deadline)), deadline, now }),
          text(fallback.href, Math.max(1, deadline - now()), request, 2 * 1024 * 1024, deadline).then(body => rssShares(body, now())),
        ]);
        if (stopping) throw failure('公开搜索已停止', 503, true);
        for (const [index, page] of pages.entries()) if (page.status === 'fulfilled') { valid = true; merge(page.value); } else report(index === 0 ? 'Google 公开搜索暂不可用' : 'Bing 公开搜索暂不可用');
        if (valid) return result([...entry.rows.values()], query, entry.reason);
        throw failure('公开搜索接口和网页搜索暂不可用，请稍后重试');
      });
    },
    status, discover,
    start() { if (!started) { started = true; stopping = false; schedule(0); } },
    async stop() { stopping = true; started = false; clearTimeout(timer); recent.clear(); for (const entry of waiting.splice(0)) entry.reject(failure('公开搜索已停止', 503, true)); while (jobs.size) await Promise.allSettled([...jobs]); },
  };
}
