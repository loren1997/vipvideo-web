import { validateUrl } from './network.mjs';

const MAX_BODY = 512 * 1024;
const googleHost = host => /(?:^|\.)google\.(?:com|[a-z]{2}|(?:com|co)\.[a-z]{2})$/i.test(host) || /(?:^|\.)(?:gstatic|googleusercontent|googleapis|googleadservices)\.com$/i.test(host);
const normalize = value => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const entities = value => value.replace(/&(?:#(x[\da-f]+|\d+)|(amp|quot|apos|lt|gt|nbsp|colon|sol|equals|quest));/gi, (match, numeric, named) => {
  if (!numeric) return { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', colon: ':', sol: '/', equals: '=', quest: '?' }[named.toLowerCase()];
  const number = numeric[0].toLowerCase() === 'x' ? parseInt(numeric.slice(1), 16) : Number(numeric);
  return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : match;
});
const visible = html => html.replace(/<(script|style|template|noscript|svg)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '').replace(/<!--[\s\S]*?-->/g, '');
const text = html => entities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const attribute = (html, name) => entities(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(html)?.slice(1).find(value => value !== undefined) || '');
const blocked = html => /g-recaptcha|h-captcha|cf-chl-|our systems have detected|unusual traffic|<title[^>]*>[^<]*(?:验证码|安全验证|登录|sign\s?in|log\s?in)/i.test(html);

function target(value, base) {
  try {
    let url = validateUrl(new URL(value, base).href);
    if (googleHost(url.hostname) && url.pathname === '/url') url = validateUrl(url.searchParams.get('q') || url.searchParams.get('url'));
    if (googleHost(url.hostname) || !/[.:]/.test(url.hostname) || [...url.searchParams.keys()].some(key => /cookie|authorization|password|secret|api.?key|(?:^|_)token(?:$|_)/i.test(key))) return null;
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

function published(html, now) {
  const dates = [];
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) if (attribute(match[0], 'property').toLowerCase() === 'article:published_time') dates.push(attribute(match[0], 'content'));
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (attribute(match[1], 'type').toLowerCase() !== 'application/ld+json') continue;
    try {
      const visit = (value, depth = 0) => {
        if (!value || typeof value !== 'object' || depth > 8) return;
        if (typeof value.datePublished === 'string') dates.push(value.datePublished);
        for (const child of Object.values(value).slice(0, 100)) visit(child, depth + 1);
      };
      visit(JSON.parse(match[2]));
    } catch {}
  }
  for (const match of html.matchAll(/<time\b[^>]*>/gi)) dates.push(attribute(match[0], 'datetime'));
  for (const value of dates) {
    if (!/^\d{4}-\d{2}-\d{2}(?:T[\d:.+-]+Z?)?$/.test(value)) continue;
    const stamp = Date.parse(value), day = Date.parse(value.slice(0, 10) + 'T00:00:00Z');
    if (Number.isSafeInteger(stamp) && stamp >= 0 && stamp <= now + 86400_000 && new Date(day).toISOString().slice(0, 10) === value.slice(0, 10)) return stamp;
  }
}

export async function searchGoogleQuark(keyword, { read, deadline, now = Date.now, aliases = [], titleOnly = false } = {}) {
  if (typeof keyword !== 'string' || !keyword.trim() || keyword.length > 1000 || typeof read !== 'function') return [];
  const title = titleOnly === true ? keyword.trim() : keyword.trim().replace(/\s+(?:19|20)\d{2}$/, ''), term = normalize(title);
  const end = Math.min(Number.isFinite(deadline) ? deadline : Infinity, now() + 3000);
  if (!term || end <= now()) return [];
  const terms = [term, ...(Array.isArray(aliases) ? aliases.slice(0, 10) : []).filter(value => typeof value === 'string' && value.length <= 300 && !/[\u0000-\u001f\u007f]/.test(value)).map(normalize).filter(Boolean)];
  const relevant = name => terms.some(term => normalize(name).includes(term));
  const rows = new Map(), passwordDates = new Map();
  const add = (url, name, publishedAt) => {
    if (!url || !relevant(name)) return;
    const key = url.split('?')[0], old = rows.get(key);
    if (!old && rows.size >= 40) return;
    const newer = publishedAt !== undefined && (old?.publishedAt === undefined || publishedAt > old.publishedAt);
    const preferPassword = url.includes('?pwd=') && (!old?.url.includes('?pwd=') || publishedAt !== undefined && (passwordDates.get(key) === undefined || publishedAt > passwordDates.get(key)));
    if (preferPassword) passwordDates.set(key, publishedAt);
    rows.set(key, { ...old, url: !old || preferPassword ? url : old.url, name: !old || newer ? name.slice(0, 500) : old.name, ...(newer ? { publishedAt } : {}) });
  };
  const load = async (url, duration, required = false) => {
    if (end <= now()) return '';
    try {
      const html = await read(url, Math.min(duration, end - now()), MAX_BODY, end);
      if (now() > end || typeof html !== 'string' || Buffer.byteLength(html) > MAX_BODY || blocked(html)) throw new Error();
      return html;
    } catch { if (required) throw new Error('Google 公开搜索暂不可用，请稍后重试'); return ''; }
  };
  const search = new URL('https://www.google.com/search');
  search.search = new URLSearchParams({ q: `${title} 夸克`, hl: 'zh-CN', num: '10', tbs: 'sbd:1' }).toString();
  // Google can ignore date sorting or require CAPTCHA; never bypass either restriction.
  const html = visible(await load(search.href, 1200, true)), pages = new Map();
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const name = text(match[2]), url = target(attribute(match[1], 'href'), search.href);
    if (!url || !relevant(name)) continue;
    const direct = share(url, name);
    if (direct) add(direct, name);
    else if (pages.size < 3 && !pages.has(url.href)) pages.set(url.href, name);
  }
  await Promise.all([...pages].map(async ([url, resultName]) => {
    const html = await load(url, 1800);
    if (!html) return;
    const content = visible(html), title = text(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(content)?.[1] || /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(content)?.[1] || resultName);
    if (!relevant(title)) return;
    const date = published(html, now());
    const article = /<(?:article|main)\b[^>]*>([\s\S]*?)<\/(?:article|main)\s*>/i.exec(content)?.[1] || content;
    for (const match of article.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
      const candidate = target(attribute(match[1], 'href'), url), label = text(match[2]), context = text(article.slice(match.index, match.index + match[0].length + 100));
      const generic = /^https?:\/\/pan\.quark\.cn\/s\/\S+$/i.test(label) || !normalize(label.replace(/夸克|网盘|下载|资源|链接|查看|打开|点击|保存|转存|分享|地址|高清|立即|视频|电影|电视剧|动漫/g, ''));
      if (candidate && (relevant(label) || generic || !label)) add(share(candidate, context), relevant(label) ? label : title, date);
    }
    const plain = text(article);
    for (const match of plain.matchAll(/https?:\/\/pan\.quark\.cn\/s\/[a-z0-9]{6,32}(?:\?[^\s<>"'，。]*)?/gi)) {
      const candidate = target(match[0], url);
      if (candidate) add(share(candidate, plain.slice(match.index, match.index + match[0].length + 100)), title, date);
    }
  }));
  return [...rows.values()];
}
