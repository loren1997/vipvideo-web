import { validateUrl } from './network.mjs';

const MAX_BODY = 512 * 1024;
export const quarkPasswordDate = Symbol('quarkPasswordDate');
const googleHost = host => /(?:^|\.)google\.(?:com|[a-z]{2}|(?:com|co)\.[a-z]{2})$/i.test(host) || /(?:^|\.)(?:gstatic|googleusercontent|googleapis|googleadservices)\.com$/i.test(host);
const bingHost = host => /(?:^|\.)bing\.com$/i.test(host);
const normalize = value => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const entities = value => value.replace(/&(?:#(x[\da-f]+|\d+)|(amp|quot|apos|lt|gt|nbsp|colon|sol|equals|quest));/gi, (match, numeric, named) => {
  if (!numeric) return { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', colon: ':', sol: '/', equals: '=', quest: '?' }[named.toLowerCase()];
  const number = numeric[0].toLowerCase() === 'x' ? parseInt(numeric.slice(1), 16) : Number(numeric);
  return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : match;
});
const visible = html => html.replace(/<(script|style|template|noscript|svg)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '').replace(/<!--[\s\S]*?-->/g, '');
const text = html => entities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const attribute = (html, name) => entities(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(html)?.slice(1).find(value => value !== undefined) || '');
const blocked = html => /g-recaptcha|h-captcha|cf-chl-|our systems have detected|unusual traffic|<title[^>]*>[^<]*(?:验证码|安全验证|登录|sign\s?in|log\s?in)|<title[^>]*>\s*人机验证\s*<\/title\s*>/i.test(html);
const resourceWords = /^(?:(?:电影|影视|电视剧|剧集|动漫|动画|国漫|日漫|韩剧|美剧|日剧|国产|韩国|日本|美国|中国|综艺|纪录片|科幻|动作|剧情|喜剧|惊悚|恐怖|悬疑|爱情|犯罪|战争|片|最新|新片|网盘|夸克|资源|链接|地址|下载|分享|转存|保存|查看|点击|立即|前往|访问|获取|提取|这里|此处|打开|视频|高清|超清|蓝光|原盘|国语|粤语|中字|中英字幕|完结|全集|4k|8k|hd|hdr|movie|tv|anime|未提供资源标题|未知标题)|(?:480|720|1080|2160)p|(?:19|20)\d{2})*$/i;

export function classifyQuarkCandidate(value, { title, aliases = [], year = '', requireYear = false } = {}) {
  const label = typeof value === 'string' ? value.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 1000) : '';
  const names = [title, ...(Array.isArray(aliases) ? aliases.slice(0, 10) : [])].filter(value => typeof value === 'string' && normalize(value));
  const candidates = names.map(name => ({ name }));
  for (const name of names) {
    const dated = /^([\p{Script=Han}]{2,})((?:19|20)\d{2})$/u.exec(name.normalize('NFKC').trim());
    if (dated && (!year || String(year) === dated[2])) candidates.push({ name: dated[1], requiredYear: dated[2] });
  }
  const joined = [];
  for (const chinese of candidates.filter(candidate => /^[\p{Script=Han}\p{N}]+$/u.test(normalize(candidate.name)))) {
    if (!/\p{Script=Han}/u.test(chinese.name)) continue;
    const compact = /^([\p{Script=Han}]{2,})((?:19|20)\d{2})$/u.exec(chinese.name.normalize('NFKC').trim());
    if (compact && (!year || String(year) === compact[2])) continue;
    const requiredYear = /^(?:19|20)\d{2}$/.test(String(year)) ? String(year) : chinese.requiredYear;
    if (!requiredYear) continue;
    for (const english of candidates.filter(candidate => /^[a-z][a-z\d]*$/i.test(normalize(candidate.name)))) {
      joined.push({ name: chinese.name + ' ' + english.name, requiredYear, bilingual: true }, { name: english.name + ' ' + chinese.name, requiredYear, bilingual: true });
    }
  }
  let bilingualSeen = false;
  for (const { name, requiredYear, bilingual } of [...joined, ...candidates]) {
    // 已知双语片名必须整体通过年份和边界校验，不能退回短片名匹配。
    if (!bilingual && bilingualSeen) return 'unrelated';
    const word = normalize(name), pattern = new RegExp([...word].join('[^\\p{L}\\p{N}]*'), 'giu');
    for (const match of label.matchAll(pattern)) {
      if (bilingual) bilingualSeen = true;
      const prefix = normalize(label.slice(0, match.index));
      let suffix = label.slice(match.index + match[0].length);
      if (!resourceWords.test(prefix.replace(/韩影/g, '电影'))) continue;
      if (requiredYear) {
        suffix = (bilingual ? suffix : suffix.replace(/^\s*[a-z]+(?=$|[^\p{L}\p{N}])/iu, '')).trimStart();
        const continuation = suffix.replace(/^[^\p{L}\p{N}]*/u, '');
        if (continuation && !/^(?:(?:19|20)\d{2}(?!\d)|(?:480|720|1080|2160)p|[48]k|hd(?:r)?|国语|粤语|中字|中英字幕|高清|超清|蓝光|原盘|完整版|全集|完结|资源|网盘|下载|夸克|科幻|动作|剧情|喜剧|惊悚|恐怖|悬疑|爱情|犯罪|战争)/i.test(continuation)) continue;
      }
      const continuation = suffix.replace(/^[^\p{L}\p{N}]*/u, '');
      if (continuation && (/^[\p{L}\p{N}]/u.test(suffix) || /^[a-z\d]+$/i.test(word) && /^[a-z\d]/i.test(continuation)) && !/^(?:(?:19|20)\d{2}(?!\d)|(?:480|720|1080|2160)p|[48]k|hd(?:r)?|国语|粤语|中字|中英字幕|高清|超清|蓝光|原盘|完整版|全集|合集|全季|完结|更新|第[零〇一二两三四五六七八九十百\d]+[季集话]|\d+[集话]|资源|网盘|下载|夸克)/i.test(continuation)) continue;
      const remaining = (label.slice(0, match.index) + suffix).replace(/(?:19|20)\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?/g, '').replace(/(?:页面|文章|发布|发表|更新)(?:日期|时间|于)?\s*[:：]?\s*(?:19|20)\d{2}年?/g, '');
      const years = [...new Set([...remaining.matchAll(/(?:^|[^\d])((?:19|20)\d{2})(?!\d)/g)].map(match => match[1]))];
      if (requireYear && (!/^(?:19|20)\d{2}$/.test(String(year || requiredYear)) || years.length !== 1 || years[0] !== String(year || requiredYear))) continue;
      if (requiredYear && (years.length !== 1 || years[0] !== requiredYear)) continue;
      if (/^(?:19|20)\d{2}$/.test(String(year)) && years.length && !years.includes(String(year)) && !/合集|全集|全季|更新|连载|collection|complete\s+series/i.test(label)) return 'unrelated';
      return 'matched';
    }
  }
  return !normalize(label) || resourceWords.test(normalize(label)) || /^https?:\/\/pan\.quark\.cn\/s\/\S+$/i.test(label) ? 'unknown' : 'unrelated';
}

function target(value, base, allowGoogleGoto = false) {
  try {
    let url = validateUrl(new URL(value, base).href);
    if (allowGoogleGoto) {
      const source = validateUrl(base);
      if (source.protocol === 'https:' && !source.port && /^www\.google\.(?:com|[a-z]{2}|(?:com|co)\.[a-z]{2})$/i.test(source.hostname) && source.pathname === '/search' && url.origin === source.origin && url.pathname === '/goto' && [...url.searchParams.keys()].length === 1 && /^[a-z0-9_-]{16,2048}$/i.test(url.searchParams.get('url') || '')) return url;
    }
    if (googleHost(url.hostname) && url.pathname === '/url') url = validateUrl(url.searchParams.get('q') || url.searchParams.get('url'));
    if (bingHost(url.hostname) && url.pathname === '/ck/a') {
      const encoded = url.searchParams.get('u') || '';
      url = validateUrl(encoded.startsWith('a1') ? Buffer.from(encoded.slice(2), 'base64url').toString('utf8') : encoded);
    }
    if (googleHost(url.hostname) || bingHost(url.hostname) || !/[.:]/.test(url.hostname) || [...url.searchParams.keys()].some(key => /cookie|authorization|password|secret|api.?key|(?:^|_)token(?:$|_)/i.test(key))) return null;
    for (const key of ['url', 'target', 'redirect', 'redirect_url', 'u', 'to']) {
      const nested = url.searchParams.get(key);
      if (!nested) continue;
      try { const direct = validateUrl(nested); if (share(direct)) return direct; } catch { /* Only a canonical share can be unwrapped without a request. */ }
    }
    return url;
  } catch { return null; }
}

function share(url, context = '') {
  const match = /^\/s\/([a-z0-9]{6,32})\/?$/i.exec(url.pathname);
  if (url.hostname !== 'pan.quark.cn' || url.port || !match) return null;
  const pwd = url.searchParams.get('pwd') || /(?:提取码|访问码|密码)\s*[:：]?\s*([a-z0-9]{1,16})(?![a-z0-9])/i.exec(context)?.[1] || '';
  if (!/^[a-z0-9]{0,16}$/i.test(pwd)) return null;
  return `https://pan.quark.cn/s/${match[1]}${pwd ? '?pwd=' + encodeURIComponent(pwd) : ''}`;
}

function published(html, now, body = html, query) {
  const dates = [];
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) if (attribute(match[0], 'property').toLowerCase() === 'article:published_time' || attribute(match[0], 'itemprop').toLowerCase() === 'datepublished') dates.push(attribute(match[0], 'content'));
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (attribute(match[1], 'type').toLowerCase() !== 'application/ld+json') continue;
    try {
      const visit = (value, depth = 0) => {
        if (!value || typeof value !== 'object' || depth > 8) return;
        const headline = value.headline || value.name;
        if (typeof value.datePublished === 'string' && (!query || !headline || typeof headline === 'string' && classifyQuarkCandidate(headline, query) === 'matched')) dates.push(value.datePublished);
        for (const child of Object.values(value).slice(0, 100)) visit(child, depth + 1);
      };
      visit(JSON.parse(match[2]));
    } catch {}
  }
  for (const match of body.matchAll(/<time\b[^>]*>/gi)) dates.push(attribute(match[0], 'datetime'));
  for (const value of dates) {
    if (!/^\d{4}-\d{2}-\d{2}(?:T[\d:.+-]+Z?)?$/.test(value)) continue;
    const stamp = Date.parse(value), day = Date.parse(value.slice(0, 10) + 'T00:00:00Z');
    if (Number.isSafeInteger(stamp) && stamp >= 0 && stamp <= now + 86400_000 && new Date(day).toISOString().slice(0, 10) === value.slice(0, 10)) return stamp;
  }
}

function articleBody(html) {
  const tags = /<\/?([a-z][\w:-]*)\b[^>]*>/gi;
  let result = '', start = 0, omitted = '', depth = 0;
  for (const match of html.matchAll(tags)) {
    const name = match[1].toLowerCase(), closing = /^<\//.test(match[0]);
    if (omitted) {
      if (name === omitted && (closing ? --depth : ++depth) === 0) { start = match.index + match[0].length; omitted = ''; }
      continue;
    }
    if (!closing && (/^(?:aside|nav|footer)$/.test(name) || /^(?:div|section)$/.test(name) && /related|recommend/i.test(attribute(match[0], 'class') + ' ' + attribute(match[0], 'id')))) {
      result += html.slice(start, match.index); omitted = name; depth = 1;
    }
  }
  return result + (omitted ? '' : html.slice(start));
}

export const googleQueryUrl = (q, page = 0) => 'https://www.google.com/search?' + new URLSearchParams({ q: q.replace(/^"([^"]+)"/, '$1'), hl: 'zh-CN', tbs: 'sbd:1', ...(page ? { start: String(Math.min(2, Math.max(0, page)) * 10) } : {}) });
export const bingQueryUrl = (q, page = 0, rss = false) => (rss ? 'https://www.bing.com/search?' : 'https://cn.bing.com/search?') + new URLSearchParams({ q, ...(rss ? { format: 'rss' } : { setlang: 'zh-hans', ensearch: '0' }), ...(page ? { first: String(Math.min(2, Math.max(0, page)) * 10 + 1) } : {}) });

export function quarkSearchQueries({ title, aliases = [], year = '' } = {}) {
  if (typeof title !== 'string' || !title.trim()) return [];
  const compact = /^([\p{Script=Han}]{2,})((?:19|20)\d{2})$/u.exec(title.trim());
  const split = compact && (!year || String(year) === compact[2]);
  const names = [...new Set([split ? compact[1] : title.trim(), ...(Array.isArray(aliases) ? aliases : [])].filter(value => typeof value === 'string' && value.trim() && value.length <= 300).map(value => value.trim().replace(/["“”\u0000-\u001f\u007f]/g, ' ')))].slice(0, 3);
  const stamp = /^(?:19|20)\d{2}$/.test(String(year)) ? String(year) : split ? compact[2] : '';
  const exact = name => `"${name}"${stamp ? ' ' + stamp : ''}`;
  return [...names.map(name => exact(name) + ' 夸克 网盘'), `"${names[0]}" 夸克`];
}

export function quarkSearchPageState(html, url = '') {
  if (blocked(html) || /b_captcha|id=["'](?:captcha|b_captcha)/i.test(html) || /google\.[^/]+\/sorry(?:\/|\?)/i.test(url)) return 'blocked';
  if (/httpservice\/retry\/enablejs|please\s+enable\s+javascript|enable\s+javascript\s+to\s+(?:use|continue)/i.test(html)) return 'javascript';
  return 'ready';
}

export function extractQuarkSearchResults(raw, { engine = 'Google', url = engine === 'Google' ? 'https://www.google.com/search' : 'https://www.bing.com/search', title, aliases = [], year, now = Date.now() } = {}) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_BODY || blocked(raw)) return [];
  const html = articleBody(visible(raw)), results = [], query = { title, aliases, year };
  const add = (value, name, publishedAt) => {
    const candidate = target(value, url, engine === 'Google' && classifyQuarkCandidate(name, query) === 'matched');
    if (!candidate || results.length >= 40) return;
    const direct = share(candidate, name), identity = classifyQuarkCandidate(name, query);
    if (identity === 'unrelated' || identity === 'unknown' && !direct) return;
    results.push({ url: direct || candidate.href, name, ...(googleHost(candidate.hostname) ? { googleRedirect: true } : {}), ...(publishedAt === undefined ? {} : { publishedAt }) });
  };
  if (engine === 'Google') {
    for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) add(attribute(match[1], 'href'), text(/<h3\b[^>]*>([\s\S]*?)<\/h3\s*>/i.exec(match[2])?.[1] || match[2]));
  } else if (/<rss\b/i.test(html)) {
    if (!/<rss\b/i.test(html) || /<!DOCTYPE\b|<!ENTITY\b/i.test(html)) throw Object.assign(new Error('Bing 公开搜索暂不可用，请稍后重试'), { quarkPoolReason: '公开网页搜索暂不可用' });
    for (const item of [...html.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].slice(0, 10)) {
      const field = key => entities((new RegExp(`<${key}\\b[^>]*>([\\s\\S]*?)<\\/${key}>`, 'i').exec(item[1])?.[1] || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'));
      const name = text(field('title')), date = field('pubDate').trim();
      const stamp = /^(?:[A-Za-z]{3},?\s+)?\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s/.test(date) ? Date.parse(date) : NaN;
      const publishedAt = Number.isSafeInteger(stamp) && stamp > 0 && stamp <= now + 86400_000 ? stamp : undefined;
      add(field('link').trim(), name, publishedAt);
    }
  } else if (/<!ENTITY\b/i.test(html)) {
    throw Object.assign(new Error('Bing 公开搜索响应无效'), { quarkPoolReason: '公开网页搜索暂不可用' });
  } else {
    for (const block of html.matchAll(/<li\b[^>]*\bclass\s*=\s*["'][^"']*\bb_algo\b[^"']*["'][^>]*>([\s\S]*?)<\/li\s*>/gi)) {
      const heading = /<h2\b[^>]*>([\s\S]*?)<\/h2\s*>/i.exec(block[1])?.[1] || '';
      const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/i.exec(heading);
      if (anchor) add(attribute(anchor[1], 'href'), text(anchor[2]));
    }
  }
  return results.sort((a, b) => Number(/夸克|网盘|资源|下载|分享/i.test(b.name)) - Number(/夸克|网盘|资源|下载|分享/i.test(a.name)));
}

// shortcut: reads complete JSON Flight records, add bounded stream assembly when a resource spans chunks.
function nextQuarkResources(html, query, base) {
  const rows = [];
  let nodes = 0, frames = 0, scripts = 0;
  const visit = (value, depth = 0) => {
    // React children wrappers can place an unchanged resource nine levels below a Flight record.
    if (++nodes > 2000 || !value || typeof value !== 'object' || depth > 12 || rows.length >= 40) return;
    if (value.provider === 'quark' && value.resourceType === 'cloud_share' && value.status === 'active'
      && typeof value.title === 'string' && value.title.length <= 500 && typeof value.shareUrl === 'string'
      && classifyQuarkCandidate(value.title, { ...query, requireYear: true }) === 'matched') {
      try {
        const original = new URL(value.shareUrl), candidate = target(value.shareUrl, base), code = value.accessCode;
        if (candidate && candidate.origin === 'https://pan.quark.cn' && candidate.href === original.href
          && !original.hash && candidate.searchParams.size <= 1 && [...candidate.searchParams.keys()].every(key => key === 'pwd')
          && (code === undefined || code === null || typeof code === 'string' && /^[a-z0-9]{0,16}$/i.test(code))) {
          const link = share(candidate, code ? '提取码：' + code : '');
          if (link) rows.push({ url: link, name: value.title });
        }
      } catch { /* Invalid resource objects cannot contribute a share. */ }
    }
    for (const child of Object.values(value).slice(0, 100)) visit(child, depth + 1);
  };
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    if (++scripts > 80 || nodes >= 2000 || frames >= 128) break;
    const push = /^\s*self\.__next_f\.push\((\[[\s\S]*\])\)\s*;?\s*$/.exec(match[1]);
    if (!push) continue;
    try {
      const payload = JSON.parse(push[1]);
      if (!Array.isArray(payload) || payload.length !== 2 || payload[0] !== 1 || typeof payload[1] !== 'string') continue;
      for (const line of payload[1].split('\n')) {
        if (++frames > 128 || nodes >= 2000) break;
        const frame = /^[\da-f]{1,8}:([\s\S]+)$/i.exec(line);
        if (!frame) continue;
        try { visit(JSON.parse(frame[1])); } catch { /* Only standard JSON Flight records are inspected. */ }
      }
    } catch { /* The push argument must be JSON, never executable JavaScript. */ }
  }
  return rows;
}

export function extractQuarkArticle(html, { url, title, aliases = [], year, requireYear = false, now = Date.now() } = {}) {
  const rows = [], query = { title, aliases, year, requireYear }, relevant = name => classifyQuarkCandidate(name, query) === 'matched';
  if (typeof html !== 'string' || Buffer.byteLength(html) > MAX_BODY || blocked(html) || !target(url, url) || googleHost(new URL(url).hostname) || bingHost(new URL(url).hostname)) return { rows, matched: false };
  const content = visible(html), article = /<(?:article|main)\b[^>]*>([\s\S]*?)<\/(?:article|main)\s*>/i.exec(content)?.[1] || content;
  const body = articleBody(article);
  const headings = ['title', 'h1'].map(tag => text(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, 'i').exec(tag === 'h1' ? body : content)?.[1] || ''));
  for (const meta of content.matchAll(/<meta\b[^>]*>/gi)) if (attribute(meta[0], 'property').toLowerCase() === 'og:title') headings.push(attribute(meta[0], 'content'));
  const opening = text(/<(?:p|h2|strong)\b[^>]*>([\s\S]*?)<\/(?:p|h2|strong)\s*>/i.exec(body)?.[1] || '').slice(0, 300);
  if (article !== content && relevant(opening)) headings.push(opening);
  const firstAnchor = /<a\b[^>]*>([\s\S]*?)<\/a\s*>/i.exec(body);
  if (article !== content && firstAnchor && !text(body.slice(0, firstAnchor.index)) && relevant(text(firstAnchor[1]))) headings.push(text(firstAnchor[1]));
  const name = headings.find(relevant);
  if (!name) return { rows, matched: false };
  const date = published(html, now, body, query);
  const add = (value, label) => { if (value && rows.length < 40) rows.push({ url: value, name: label, ...(date === undefined ? {} : { publishedAt: date }) }); };
  for (const section of body.replace(/<a\b[^>]*>[\s\S]*?<\/a\s*>/gi, anchor => anchor.replace(/(<\/?)h[1-4](?=[\s>])/gi, '$1span')).split(/(?=<h[1-4]\b)/i)) {
    const heading = text(/^<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]\s*>/i.exec(section)?.[1] || '');
    if (heading && !relevant(heading) && classifyQuarkCandidate(heading, query) !== 'unknown' && !/^(?:剧情|影片|资源|视频)?(?:介绍|简介|详情|信息)$/.test(heading)) continue;
    for (const match of section.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
      const candidate = target(attribute(match[1], 'href'), url), label = text(match[2]), context = text(section.slice(match.index, match.index + match[0].length + 100));
      if (candidate && classifyQuarkCandidate(label, query) !== 'unrelated') add(share(candidate, context), relevant(label) ? label : name);
    }
    const plain = entities(section.replace(/<a\b[^>]*>[\s\S]*?<\/a\s*>/gi, '').replace(/<br\b[^>]*>|<\/(?:p|div|li|tr|h[1-6])\s*>/gi, '\n').replace(/<[^>]*>/g, ' '));
    for (const match of plain.matchAll(/https?:\/\/pan\.quark\.cn\/s\/[a-z0-9]{6,32}(?:\?[^\s<>"'，。]*)?/gi)) {
      const prefix = plain.slice(plain.lastIndexOf('\n', match.index) + 1, match.index).trim();
      if (classifyQuarkCandidate(prefix, query) === 'unrelated') continue;
      const candidate = target(match[0], url);
      if (candidate) add(share(candidate, plain.slice(match.index, match.index + match[0].length + 100)), name);
    }
  }
  for (const resource of nextQuarkResources(html, query, url)) add(resource.url, resource.name);
  return { rows, matched: true };
}

async function searchWebQuark(engine, keyword, { read, deadline, now = Date.now, aliases = [], year, titleOnly = false, page = 0 } = {}) {
  if (typeof keyword !== 'string' || !keyword.trim() || keyword.length > 1000 || typeof read !== 'function') return [];
  const title = titleOnly === true ? keyword.trim() : keyword.trim().replace(/\s+(?:19|20)\d{2}$/, ''), term = normalize(title);
  const end = Math.min(Number.isFinite(deadline) ? deadline : Infinity, now() + 3000);
  if (!term || end <= now()) return [];
  const names = [...new Set([title, ...(Array.isArray(aliases) ? aliases.slice(0, 10) : []).filter(value => typeof value === 'string' && value.length <= 300 && !/[\u0000-\u001f\u007f]/.test(value)).map(value => value.trim()).filter(Boolean)])];
  const query = { title, aliases: names.slice(1), year: year ?? (!titleOnly ? /\s+((?:19|20)\d{2})$/.exec(keyword)?.[1] : '') };
  const relevant = name => classifyQuarkCandidate(name, query) === 'matched';
  const rows = new Map(), passwordDates = new Map();
  const add = (url, name, publishedAt, unknown = false) => {
    if (!url || !unknown && !relevant(name)) return;
    const key = url.split('?')[0], old = rows.get(key);
    if (!old && rows.size >= 40) return;
    const newer = publishedAt !== undefined && (old?.publishedAt === undefined || publishedAt > old.publishedAt);
    const preferPassword = url.includes('?pwd=') && (!old?.url.includes('?pwd=') || publishedAt !== undefined && (passwordDates.get(key) === undefined || publishedAt > passwordDates.get(key)));
    if (preferPassword) passwordDates.set(key, publishedAt);
    rows.set(key, { ...old, url: !old || preferPassword ? url : old.url, name: !old || newer ? name.slice(0, 500) : old.name, ...(newer ? { publishedAt } : {}) });
  };
  let readPages = 0, matchedPages = 0, lastPageError, javascriptOnly = false;
  const load = async (url, duration, required = false) => {
    if (end <= now()) return { html: '', url };
    try {
      const result = await read(url, Math.min(duration, end - now()), MAX_BODY, end);
      const html = typeof result === 'string' ? result : result?.html, finalUrl = typeof result?.url === 'string' ? result.url : url;
      if (now() > end) throw Object.assign(new Error(), { quarkPoolReason: '搜索请求超时' });
      if (typeof html !== 'string' || Buffer.byteLength(html) > MAX_BODY) throw Object.assign(new Error(), { quarkPoolReason: '搜索响应内容异常（超过大小限制或非网页响应）' });
      if (quarkSearchPageState(html, finalUrl) === 'blocked') throw Object.assign(new Error(), { quarkPoolReason: '搜索页面要求登录或人机验证，已停止自动读取' });
      return { html, url: finalUrl };
    } catch (cause) { if (required) throw Object.assign(new Error(engine + ' 公开搜索暂不可用，请稍后重试', { cause }), cause?.quarkPoolReason ? { quarkPoolReason: cause.quarkPoolReason } : {}); lastPageError = cause?.quarkPoolReason || '资源网页暂不可访问'; return { html: '', url }; }
  };
  const search = new URL(engine === 'Google' ? 'https://www.google.com/search' : 'https://www.bing.com/search'), pages = new Map();
  const addResult = (value, name, publishedAt) => {
    const url = target(value, search.href, engine === 'Google' && classifyQuarkCandidate(name, query) === 'matched');
    if (!url) return;
    const direct = share(url, name);
    const identity = classifyQuarkCandidate(name, query);
    if (identity === 'unrelated' || identity === 'unknown' && !direct) return;
    if (direct) add(direct, name, publishedAt, identity === 'unknown');
    else if (pages.size < 3 && !pages.has(url.href)) pages.set(url.href, { name, requireYear: googleHost(url.hostname) });
  };
  const queries = quarkSearchQueries(query);
  for (const q of queries) {
    search.href = engine === 'Google' ? googleQueryUrl(q, page) : bingQueryUrl(q, page);
    let result = await load(search.href, 1500, true);
    search.href = result.url;
    if (engine === 'Google' && quarkSearchPageState(result.html, search.href) === 'javascript') { javascriptOnly = true; break; }
    if (engine === 'Bing' && !extractQuarkSearchResults(result.html, { ...query, engine, url: search.href, now: now() }).length && end - now() >= 500) {
      search.href = bingQueryUrl(q, page, true);
      result = await load(search.href, 1000, true);
      search.href = result.url;
    }
    for (const row of extractQuarkSearchResults(result.html, { ...query, engine, url: search.href, now: now() })) addResult(row.url, row.name, row.publishedAt);
    if ([...rows.values()].some(row => relevant(row.name)) || pages.size || end - now() < 250) break;
  }
  await Promise.all([...pages].map(async ([url, { requireYear }]) => {
    const result = await load(url, 1800);
    if (!result.html) return;
    readPages++;
    const extracted = extractQuarkArticle(result.html, { ...query, url: result.url, requireYear, now: now() });
    if (!extracted.matched) return;
    matchedPages++;
    for (const row of extracted.rows) add(row.url, row.name, row.publishedAt);
  }));
  const output = [...rows.entries()].map(([key, row]) => {
    if (row.url.includes('?pwd=')) Object.defineProperty(row, quarkPasswordDate, { value: passwordDates.get(key) ?? 0 });
    return row;
  });
  if (!output.some(row => relevant(row.name))) Object.defineProperty(output, 'reason', { value: !pages.size ? javascriptOnly ? 'Google 搜索页面需要 JavaScript，当前未能读取搜索结果' : '未找到与片名相符的公开网页结果' : !readPages ? '资源网页读取未完成：' + (lastPageError || '已到搜索时间上限') : !matchedPages ? '搜索结果网页未通过片名核验' : '已读取相关网页，但未找到可核验的夸克分享链接' });
  return output;
}

export const searchGoogleQuark = (keyword, options) => searchWebQuark('Google', keyword, options);
export const searchBingQuark = (keyword, options) => searchWebQuark('Bing', keyword, options);
