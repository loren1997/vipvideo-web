import { validateUrl } from './network.mjs';

const MAX_BODY = 512 * 1024;
export const quarkPasswordDate = Symbol('quarkPasswordDate');
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
const resourceWords = /^(?:(?:电影|影视|电视剧|剧集|动漫|动画|国漫|日漫|韩剧|美剧|日剧|国产|综艺|纪录片|网盘|夸克|资源|链接|地址|下载|分享|转存|保存|查看|点击|立即|视频|高清|超清|蓝光|原盘|国语|粤语|中字|中英字幕|完结|全集|4k|8k|hd|hdr|movie|tv|anime|未提供资源标题|未知标题)|(?:480|720|1080|2160)p|(?:19|20)\d{2})*$/i;

export function classifyQuarkCandidate(value, { title, aliases = [], year = '' } = {}) {
  const label = typeof value === 'string' ? value.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 1000) : '';
  const names = [title, ...(Array.isArray(aliases) ? aliases.slice(0, 10) : [])].filter(value => typeof value === 'string' && normalize(value));
  for (const name of names) {
    const word = normalize(name), pattern = new RegExp([...word].join('[^\\p{L}\\p{N}]*'), 'giu');
    for (const match of label.matchAll(pattern)) {
      const prefix = normalize(label.slice(0, match.index)), suffix = label.slice(match.index + match[0].length);
      if (!resourceWords.test(prefix)) continue;
      if (suffix && /^[\p{L}\p{N}]/u.test(suffix) && !/^(?:(?:19|20)\d{2}(?!\d)|(?:480|720|1080|2160)p|[48]k|hd(?:r)?|国语|粤语|中字|中英字幕|高清|超清|蓝光|原盘|完整版|全集|合集|全季|完结|更新|第[零〇一二两三四五六七八九十百\d]+[季集话]|\d+[集话]|资源|网盘|下载|夸克)/i.test(suffix)) continue;
      const remaining = (label.slice(0, match.index) + suffix).replace(/(?:19|20)\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?/g, '');
      const years = [...new Set([...remaining.matchAll(/(?:^|[^\d])((?:19|20)\d{2})(?!\d)/g)].map(match => match[1]))];
      if (/^(?:19|20)\d{2}$/.test(String(year)) && years.length && !years.includes(String(year)) && !/合集|全集|全季|更新|连载|collection|complete\s+series/i.test(label)) return 'unrelated';
      return 'matched';
    }
  }
  return !normalize(label) || resourceWords.test(normalize(label)) || /^https?:\/\/pan\.quark\.cn\/s\/\S+$/i.test(label) ? 'unknown' : 'unrelated';
}

function target(value, base) {
  try {
    let url = validateUrl(new URL(value, base).href);
    if (googleHost(url.hostname) && url.pathname === '/url') url = validateUrl(url.searchParams.get('q') || url.searchParams.get('url'));
    if (googleHost(url.hostname) || !/[.:]/.test(url.hostname) || [...url.searchParams.keys()].some(key => /cookie|authorization|password|secret|api.?key|(?:^|_)token(?:$|_)/i.test(key))) return null;
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

async function searchWebQuark(engine, keyword, { read, deadline, now = Date.now, aliases = [], year, titleOnly = false } = {}) {
  if (typeof keyword !== 'string' || !keyword.trim() || keyword.length > 1000 || typeof read !== 'function') return [];
  const title = titleOnly === true ? keyword.trim() : keyword.trim().replace(/\s+(?:19|20)\d{2}$/, ''), term = normalize(title);
  const end = Math.min(Number.isFinite(deadline) ? deadline : Infinity, now() + 3000);
  if (!term || end <= now()) return [];
  const names = [...new Set([title, ...(Array.isArray(aliases) ? aliases.slice(0, 10) : []).filter(value => typeof value === 'string' && value.length <= 300 && !/[\u0000-\u001f\u007f]/.test(value)).map(value => value.trim()).filter(Boolean)])];
  const terms = names.map(normalize).filter(Boolean), query = { title, aliases: names.slice(1), year: year ?? (!titleOnly ? /\s+((?:19|20)\d{2})$/.exec(keyword)?.[1] : '') };
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
    if (end <= now()) return '';
    try {
      const html = await read(url, Math.min(duration, end - now()), MAX_BODY, end);
      if (now() > end) throw Object.assign(new Error(), { quarkPoolReason: '搜索请求超时' });
      if (typeof html !== 'string' || Buffer.byteLength(html) > MAX_BODY) throw Object.assign(new Error(), { quarkPoolReason: '搜索响应内容异常（超过大小限制或非网页响应）' });
      if (blocked(html)) throw Object.assign(new Error(), { quarkPoolReason: '搜索页面要求登录或人机验证，已停止自动读取' });
      return html;
    } catch (cause) { if (required) throw Object.assign(new Error(engine + ' 公开搜索暂不可用，请稍后重试', { cause }), cause?.quarkPoolReason ? { quarkPoolReason: cause.quarkPoolReason } : {}); lastPageError = cause?.quarkPoolReason || '资源网页暂不可访问'; return ''; }
  };
  const search = new URL(engine === 'Google' ? 'https://www.google.com/search' : 'https://www.bing.com/search'), pages = new Map();
  const addResult = (value, name, publishedAt) => {
    const url = target(value, search.href);
    if (!url) return;
    const direct = share(url, name);
    const identity = classifyQuarkCandidate(name, query);
    if (identity === 'unrelated' || identity === 'unknown' && !direct) return;
    if (direct) add(direct, name, publishedAt, identity === 'unknown');
    else if (pages.size < 3 && !pages.has(url.href)) pages.set(url.href, name);
  };
  const queries = names.slice(0, 2).map(word => `${word} 夸克`);
  if (engine === 'Google' && queries.length === 1) queries.push(`${title} 网盘`);
  for (const q of queries) {
    search.search = new URLSearchParams(engine === 'Google' ? { q, hl: 'zh-CN', num: '10' } : { q, format: 'rss' }).toString();
    // Retrieve by relevance; sort the extracted resources by their verified publication dates later.
    const raw = await load(search.href, 2000, true), html = visible(raw);
    if (engine === 'Google') {
      javascriptOnly ||= /httpservice\/retry\/enablejs|please\s+enable\s+javascript|enable\s+javascript\s+to\s+(?:use|continue)/i.test(raw);
      for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) addResult(attribute(match[1], 'href'), text(/<h3\b[^>]*>([\s\S]*?)<\/h3\s*>/i.exec(match[2])?.[1] || match[2]));
    } else {
      if (!/<rss\b/i.test(html) || /<!DOCTYPE\b|<!ENTITY\b/i.test(html)) throw Object.assign(new Error('Bing 公开搜索暂不可用，请稍后重试'), { quarkPoolReason: '公开网页搜索暂不可用' });
      for (const item of [...html.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].slice(0, 10)) {
        const field = key => entities((new RegExp(`<${key}\\b[^>]*>([\\s\\S]*?)<\\/${key}>`, 'i').exec(item[1])?.[1] || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'));
        const name = text(field('title')), date = field('pubDate').trim();
        const stamp = /^(?:[A-Za-z]{3},?\s+)?\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s/.test(date) ? Date.parse(date) : NaN;
        const publishedAt = Number.isSafeInteger(stamp) && stamp > 0 && stamp <= now() + 86400_000 ? stamp : undefined;
        addResult(field('link').trim(), name, publishedAt);
        for (const match of entities(item[1]).matchAll(/https?:\/\/pan\.quark\.cn\/s\/[a-z0-9]{6,32}(?:\?pwd=[a-z0-9]{1,16})?/gi)) addResult(match[0], name, publishedAt);
      }
    }
    if ([...rows.values()].some(row => relevant(row.name)) || pages.size || end - now() < 250) break;
  }
  await Promise.all([...pages].map(async ([url, resultName]) => {
    const html = await load(url, 1800);
    if (!html) return;
    readPages++;
    const content = visible(html), article = /<(?:article|main)\b[^>]*>([\s\S]*?)<\/(?:article|main)\s*>/i.exec(content)?.[1] || content;
    const headings = ['title', 'h1'].map(tag => text(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, 'i').exec(content)?.[1] || ''));
    for (const meta of content.matchAll(/<meta\b[^>]*>/gi)) if (attribute(meta[0], 'property').toLowerCase() === 'og:title') headings.push(attribute(meta[0], 'content'));
    const opening = text(/<(?:p|h2|strong)\b[^>]*>([\s\S]*?)<\/(?:p|h2|strong)\s*>/i.exec(article)?.[1] || '').slice(0, 300);
    if (article !== content && relevant(opening) && terms.some(term => normalize(opening).startsWith(term))) headings.push(opening);
    const title = headings.find(relevant) || headings.find(Boolean) || resultName;
    if (!relevant(title)) return;
    matchedPages++;
    const date = published(html, now());
    const body = article.replace(/<(aside|nav|footer)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '').replace(/<(div|section)\b[^>]*(?:class|id)\s*=\s*["'][^"']*(?:related|recommend)[^"']*["'][^>]*>[\s\S]*?<\/\1\s*>/gi, '').replace(/<a\b[^>]*>[\s\S]*?<\/a\s*>/gi, anchor => anchor.replace(/(<\/?)h[1-4](?=[\s>])/gi, '$1span'));
    for (const section of body.split(/(?=<h[1-4]\b)/i)) {
      const heading = text(/^<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]\s*>/i.exec(section)?.[1] || '');
      if (heading && !relevant(heading) && classifyQuarkCandidate(heading, query) !== 'unknown' && !/^(?:剧情|影片|资源|视频)?(?:介绍|简介|详情|信息)$/.test(heading)) continue;
      for (const match of section.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
        const candidate = target(attribute(match[1], 'href'), url), label = text(match[2]), context = text(section.slice(match.index, match.index + match[0].length + 100));
        if (candidate && classifyQuarkCandidate(label, query) !== 'unrelated') add(share(candidate, context), relevant(label) ? label : title, date);
      }
      const plain = entities(section.replace(/<a\b[^>]*>[\s\S]*?<\/a\s*>/gi, '').replace(/<br\b[^>]*>|<\/(?:p|div|li|tr|h[1-6])\s*>/gi, '\n').replace(/<[^>]*>/g, ' '));
      for (const match of plain.matchAll(/https?:\/\/pan\.quark\.cn\/s\/[a-z0-9]{6,32}(?:\?[^\s<>"'，。]*)?/gi)) {
        const prefix = plain.slice(plain.lastIndexOf('\n', match.index) + 1, match.index).trim();
        if (classifyQuarkCandidate(prefix, query) === 'unrelated') continue;
        const candidate = target(match[0], url);
        if (candidate) add(share(candidate, plain.slice(match.index, match.index + match[0].length + 100)), title, date);
      }
    }
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
