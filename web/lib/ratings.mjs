import { createHash } from 'node:crypto';
import { request as networkRequest, readText } from './network.mjs';

const ORIGIN = 'https://movie.douban.com';
const CACHE_KEY = 'douban-ratings-cache-v1';
const DAY = 24 * 60 * 60 * 1000;
const SHORT = 5 * 60 * 1000;

const failure = message => Object.assign(new Error(message), { status: 502 });
const scalar = value => typeof value === 'number' || (typeof value === 'string' && value.trim() !== '');
const positiveId = value => scalar(value) && /^\d{1,16}$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? String(Number(value)) : null;
const scoreOf = value => scalar(value) && Number.isFinite(Number(value)) && Number(value) > 0 && Number(value) <= 10 ? Number(value) : null;
const votesOf = value => scalar(value) && Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : undefined;
const yearOf = value => /^\d{4}$/.test(String(value ?? '').trim()) ? String(value).trim() : null;
const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const subjectUrl = id => id ? `${ORIGIN}/subject/${id}/` : `${ORIGIN}/`;
const clone = value => JSON.parse(JSON.stringify(value));

function rating(score, id, attribution, votes) {
  return { score, ...(votes === undefined ? {} : { votes }), url: subjectUrl(id), attribution };
}

function sameTitle(value, title) {
  const names = Array.isArray(value) ? value : [value];
  return names.some(name => {
    if (typeof name !== 'string') return false;
    const decoded = name.replace(/&(?:amp|quot|apos|lt|gt);/g, entity => ({ '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' })[entity]);
    if (normalize(decoded) === title) return true;
    // 豆瓣条目有时以“中文名 Original Name”发布；仅拆明确的中英双语名。
    const bilingual = decoded.match(/^([\p{Script=Han}\p{N}\p{P}\p{Z}]+?)\s+([A-Za-z].*)$/u);
    return bilingual && [bilingual[1], bilingual[2]].some(part => normalize(part) === title);
  });
}

function parseSubject(html, target, id) {
  if (/sec\.douban\.com|captcha[-_ ]?(?:form|input)|请输入验证码|安全验证|异常请求/i.test(html)) throw failure('豆瓣网页暂需验证，暂无可读取评分');
  const candidates = [];
  for (const block of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (!/\btype\s*=\s*(?:["']application\/ld\+json["']|application\/ld\+json(?=\s|$))/i.test(block[1])) continue;
    let data;
    try { data = JSON.parse(block[2]); } catch { continue; }
    const queue = [data];
    for (let visited = 0; queue.length && visited < 200; visited++) {
      const node = queue.shift();
      if (Array.isArray(node)) { queue.push(...node.slice(0,200)); continue; }
      if (!node || typeof node !== 'object') continue;
      if (node['@graph']) queue.push(node['@graph']);
      const types = (Array.isArray(node['@type']) ? node['@type'] : [node['@type']]).map(value => String(value).replace(/^https?:\/\/schema\.org\//, ''));
      if (!types.includes(target.type === 'movie' ? 'Movie' : 'TVSeries')) continue;
      if (!sameTitle([node.name, ...(Array.isArray(node.alternateName) ? node.alternateName : [node.alternateName])], target.title)) continue;
      if (String(node.datePublished ?? '').slice(0,4) !== target.year) continue;
      if (node.url) {
        let url;
        try { url = new URL(node.url, ORIGIN); } catch { continue; }
        if (url.origin !== ORIGIN || positiveId(url.pathname.match(/^\/subject\/(\d+)\/?$/)?.[1]) !== id) continue;
      }
      const aggregate = node.aggregateRating;
      const score = scoreOf(aggregate?.ratingValue), votes = votesOf(aggregate?.ratingCount);
      if (score === null || votes === 0 || (aggregate.bestRating !== undefined && Number(aggregate.bestRating) !== 10)) continue;
      candidates.push(rating(score, id, '豆瓣公开条目', votes));
    }
  }
  const unique = new Map(candidates.map(value => [JSON.stringify(value), value]));
  if (unique.size !== 1) throw failure(unique.size ? '豆瓣条目评分不明确，暂不展示' : '暂无与片名、年份和类型相符的豆瓣条目评分');
  return [...unique.values()][0];
}

export function createRatings({ store, request = networkRequest, now = Date.now } = {}) {
  if (!store?.meta || !store?.setMeta) throw new Error('评分模块需要 SQLite 存储');
  const cache = new Map(), pending = new Map(), waiting = [];
  let active = 0;
  const saved = store.meta(CACHE_KEY);
  if (saved && saved.length <= 1024 * 1024) {
    try {
      const entries = JSON.parse(saved);
      if (Array.isArray(entries)) for (const [key, entry] of entries.slice(-500)) {
        if (typeof key === 'string' && entry && Number.isFinite(entry.expires) && entry.expires > now() && entry.expires <= now() + DAY) cache.set(key, entry);
      }
    } catch { console.error('豆瓣评分缓存无法读取，已重新建立缓存'); }
  }

  function remember(key, value, ttl) {
    for (const [name, entry] of cache) if (entry.expires <= now()) cache.delete(name);
    cache.delete(key);
    cache.set(key, { expires: now() + ttl, value });
    while (cache.size > 500) cache.delete(cache.keys().next().value);
    store.setMeta(CACHE_KEY, JSON.stringify([...cache]));
    return value;
  }

  async function cached(key, fetchValue, ttl = value => value.douban ? DAY : SHORT) {
    const entry = cache.get(key);
    if (entry && entry.expires > now()) return clone(entry.value);
    if (pending.has(key)) return clone(await pending.get(key));
    const work = (async () => { const value = await fetchValue(); return remember(key, value, ttl(value)); })();
    pending.set(key, work);
    try { return clone(await work); } finally { pending.delete(key); }
  }

  async function fetchText(url, maxBytes) {
    if (active < 2) active++;
    else await new Promise(resolve => waiting.push(resolve));
    let upstream, expired = false, timer;
    try {
      return await Promise.race([
        (async () => {
          upstream = await request(url, { timeout: 8000 });
          if (expired) { upstream.destroy(); throw failure('豆瓣评分读取超时，请稍后再试'); }
          if (upstream.statusCode !== 200) { upstream.destroy(); throw failure([403,429].includes(upstream.statusCode) ? '豆瓣网页暂不可访问，暂无评分' : `豆瓣评分服务返回 HTTP ${upstream.statusCode}`); }
          const finalUrl = new URL(upstream.finalUrl || url);
          if (finalUrl.origin !== ORIGIN || finalUrl.pathname !== new URL(url).pathname) { upstream.destroy(); throw failure('豆瓣网页暂需验证，暂无可读取评分'); }
          return await readText(upstream, maxBytes);
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => { expired = true; upstream?.destroy(); reject(failure('豆瓣评分读取超时，请稍后再试')); }, 8000); }),
      ]);
    } finally {
      clearTimeout(timer);
      const next = waiting.shift();
      if (next) next(); else active--;
    }
  }

  async function fromFeed(target, id) {
    const kind = target.type === 'movie' ? 'movie' : 'tv';
    const feed = await cached(`feed:${kind}`, async () => {
      try {
        const url = new URL('/j/search_subjects', ORIGIN);
        for (const [key,value] of Object.entries({ type:kind, tag:'热门', sort:'recommend', page_limit:'50', page_start:'0' })) url.searchParams.set(key,value);
        const data = JSON.parse(await fetchText(url.href,512 * 1024));
        if (!Array.isArray(data.subjects)) throw failure('豆瓣公开列表暂不可读取');
        return { subjects: data.subjects.slice(0,50).map(item => ({ id:positiveId(item.id), title:String(item.title ?? ''), score:scoreOf(item.rate) })).filter(item => item.id && item.score !== null) };
      } catch (error) { return { subjects: [], error: error.status ? error.message : '豆瓣公开列表暂不可读取' }; }
    }, () => SHORT);
    const matches = feed.subjects.filter(item => item.id === id && normalize(item.title) === target.title);
    if (matches.length !== 1) throw failure(feed.error || '公开热门列表未包含此条目，暂无评分');
    return rating(matches[0].score, id, '豆瓣公开热门列表（按影视源条目 ID 核对）');
  }

  return {
    async get(detail) {
      const id = positiveId(detail?.douban?.id), supplied = scoreOf(detail?.douban?.score);
      if (supplied !== null) return { douban: rating(supplied,id,'豆瓣评分（影视源提供，未独立验证）',votesOf(detail.douban.votes)), tmdb:null, errors:[], configured:true };
      if (!id) return { douban:null, tmdb:null, errors:['影视源未提供可核对的豆瓣条目，暂无评分'], configured:true };
      if (detail.category === 'adult') return { douban:null, tmdb:null, errors:['该分类仅展示影视源提供的评分'], configured:true };
      const target = { title:normalize(detail.title), year:yearOf(detail.year), type:detail.type };
      if (!target.title || !target.year || !['movie','series'].includes(target.type)) return { douban:null, tmdb:null, errors:['影片信息不足，暂无法核对豆瓣评分'], configured:true };
      const key = 'subject:' + createHash('sha256').update(JSON.stringify({ ...target, id })).digest('hex');
      return cached(key, async () => {
        const errors = [];
        try { return { douban:parseSubject(await fetchText(subjectUrl(id),1024 * 1024),target,id), tmdb:null, errors:[], configured:true }; }
        catch (error) { errors.push(error.status ? error.message : '豆瓣公开条目暂不可读取'); }
        try { return { douban:await fromFeed(target,id), tmdb:null, errors:[], configured:true }; }
        catch (error) { errors.push(error.status ? error.message : '豆瓣公开列表暂不可读取'); }
        return { douban:null, tmdb:null, errors:[...new Set(errors)], configured:true };
      });
    },
  };
}
