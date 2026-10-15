import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { readText } from './network.mjs';

const MAX_COMMENTS = 5000, MAX_BODY = 4 * 1024 * 1024;
const fail = message => Object.assign(new Error(message), { status: 502 });
const platforms = new Map([['v.qq.com','腾讯视频'],['www.iqiyi.com','爱奇艺'],['www.youku.com','优酷'],['v.youku.com','优酷'],['www.mgtv.com','芒果TV'],['www.bilibili.com','哔哩哔哩']]);
const normalize = value => String(value || '').normalize('NFKC').toLowerCase().replace(/<[^>]*>/g, '').replace(/[\p{P}\p{Z}\s]/gu, '');
const safeText = value => typeof value === 'string' && value.length <= 800 && !/<\/?[a-z!][^>]*>|javascript\s*:/i.test(value)
  ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) : '';
const extras = /预告|花絮|解说|剪辑|片花|片段|试看|试播|幕后|trailer|teaser|preview/i;

function number(value) {
  if (/^\d{1,4}$/.test(value)) return Number(value);
  if (!/^[零〇一二两三四五六七八九十百千]+$/.test(value)) return null;
  const digits = '零一二三四五六七八九', units = { 十:10, 百:100, 千:1000 }; let result = 0, last = 0;
  for (const char of value.replace(/两/g,'二').replace(/〇/g,'零')) {
    if (units[char]) { result += (last || 1) * units[char]; last = 0; } else last = digits.indexOf(char);
  }
  return result + last;
}
function episodeNumber(value, movie) {
  if (movie) return 1;
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 && value <= 9999 ? value + 1 : null;
  const text = String(value || '').trim();
  if (/^(正片|全集|剧场版|电影|movie)$/i.test(text)) return 1;
  const match = text.match(/(?:^|[^A-Za-z0-9])(?:S\d{1,2}E|EP?\s*)(\d{1,4})(?:\D|$)/i) || text.match(/第\s*([\d零〇一二两三四五六七八九十百千]+)\s*[集话話期]/) || text.match(/^([\d零〇一二两三四五六七八九十百千]+)$/) || text.match(/_(\d{1,4})$/);
  return match ? number(match[1]) : null;
}
function seasonNumber(value) {
  const match=String(value||'').match(/(?:^|[^A-Za-z0-9])S(\d{1,2})(?:E\d|(?=$|[^A-Za-z0-9]))/i)||String(value||'').match(/(?:^|[^A-Za-z0-9])Season[\s._-]*(\d{1,2})(?=$|[^A-Za-z0-9])/i)||String(value||'').match(/第\s*([\d零〇一二两三四五六七八九十百千]+)\s*季/);
  return match?number(match[1]):null;
}
function identity(value) {
  if (typeof value?.title !== 'string' || !value.title.trim() || value.title.length > 200 || /[\u0000-\u001f]/.test(value.title)) return null;
  let aliases = value.aliases || [];
  if (typeof aliases === 'string') { try { aliases = aliases.length <= 1200 ? JSON.parse(aliases) : []; } catch { aliases = []; } }
  const titles = [...new Set([value.title, ...(Array.isArray(aliases) ? aliases.filter(item => typeof item === 'string' && item.length <= 200).slice(0, 3) : [])])];
  const movie = /^(movie|电影)$/i.test(value.type || '');
  const episode = episodeNumber(value.episodeName || value.episode, movie);
  if (!episode || episode > 9999) return null;
  const titleSeason=seasonNumber(value.title),episodeSeason=seasonNumber(value.episodeName);
  if(!movie&&titleSeason&&episodeSeason&&titleSeason!==episodeSeason)return null;
  const year = /^(19|20)\d{2}$/.test(String(value.year)) ? String(value.year) : '';
  return { title:value.title.trim(), titles, movie, episode, year, season:movie?null:titleSeason||episodeSeason };
}
function platform(url) {
  try { const parsed = new URL(url); return parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.port ? platforms.get(parsed.hostname) : null; } catch { return null; }
}
export function matchesDanmakuTitle(title, info) {
  if (typeof title !== 'string' || title.length > 400 || extras.test(title)) return false;
  let season=seasonNumber(title);
  const year = [...title.matchAll(/[（(]((?:19|20)\d{2})[）)]/g)].at(-1)?.[1];
  if (info.year && info.year !== year) return false;
  const withoutYear = text => text.replace(/[（(](?:19|20)\d{2}[）)]/g,'').replace(new RegExp('(?<=\\p{L})'+info.year+'$','u'),'');
  const clean = withoutYear(title.replace(/【(?:电影|电视剧|(?:2D|3D)?动漫|动画|番剧|综艺|纪录片)】\s*from\s+(?:360|tencent|iqiyi|youku|imgo|bilibili)\s*$/i,'').replace(/[【\[][^【\[\]】]*(?:腾讯|爱奇艺|优酷|芒果|哔哩|bilibili|iqiyi|youku|mgtv|qq)[^【\[\]】]*[】\]]/gi, ''));
  if(!season&&info.season>1&&Number(clean.trim().match(/(?:^|\D)(\d{1,2})$/)?.[1])===info.season&&info.titles.some(name=>normalize(name)===normalize(clean)))season=info.season;
  if(info.season&&(season?season!==info.season:info.season!==1))return false;
  const stripSeason=text=>info.season&&season===info.season?text.replace(/第\s*[\d零〇一二两三四五六七八九十百千]+\s*季|\bSeason\s*\d{1,2}\b|\bS\d{1,2}\b/gi,''):text;
  return info.titles.some(name => normalize(stripSeason(withoutYear(name))) === normalize(stripSeason(clean)));
}
function fullMovieEpisode(title, info) {
  const clean=String(title||'').replace(/^【(?:qq|qiyi|youku|imgo|bilibili1)】\s*/,'').trim();
  return !extras.test(clean)&&(/^(正片|电影|剧场版|movie|full movie)$/i.test(clean)||matchesDanmakuTitle(clean+(info.year?`(${info.year})`:''),info));
}
function commentRows(data, source) {
  const rows = [], seen = new Set();
  for (const item of Array.isArray(data?.comments) ? data.comments.slice(0, 30000) : []) {
    const parts = typeof item.p === 'string' ? item.p.split(',') : [], time = Number(parts[0]), color = Number(parts[2]);
    const text = safeText(item.m);
    if (!text || !parts[0]?.trim() || !parts[2]?.trim() || !Number.isFinite(time) || time < 0 || time > 86400 || ![1,4,5,6].includes(Number(parts[1])) || !Number.isInteger(color) || color < 0 || color > 0xffffff) continue;
    const id = 'external:' + createHash('sha256').update(JSON.stringify([source,time,text,color])).digest('hex');
    if (seen.has(id)) continue;
    seen.add(id); rows.push({ id, time, text, color:'#'+color.toString(16).padStart(6,'0'), origin:source });
    if (rows.length >= MAX_COMMENTS) break;
  }
  return rows;
}

// The base is deployment configuration, never a URL supplied by a viewer.
export function createDanmakuApiRequest(base, { httpRequest=http.request, httpsRequest=https.request }={}) {
  const expected = new URL(base);
  if (!['http:','https:'].includes(expected.protocol) || expected.username || expected.password || expected.search || expected.hash) throw new Error('弹幕服务地址无效');
  const prefix = expected.pathname.replace(/\/$/,'');
  return (input, { timeout=15000 }={}) => new Promise((resolve,reject) => {
    const url = new URL(input);
    const suffix = url.pathname.slice(prefix.length);
    if (url.origin !== expected.origin || !url.pathname.startsWith(prefix + '/') || !/^\/api\/v2\/(?:search\/episodes|comment\/[1-9]\d{0,15})$/.test(suffix) || url.username || url.password || url.hash) return reject(fail('弹幕服务请求地址无效'));
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method:'GET', headers:{accept:'application/json','user-agent':'VipVideo-Web-danmaku'} }, response => { clearTimeout(timer); response.finalUrl = url.href; resolve(response); });
    const timer=setTimeout(() => req.destroy(fail('自动弹幕服务读取超时')),timeout);
    req.on('error',error=>{clearTimeout(timer);reject(error);}); req.end();
  });
}

export function createAutoDanmaku({ apiBase=process.env.DANMAKU_API_URL || 'http://danmaku:9321', request, fallback, now=Date.now }={}) {
  const base = new URL(apiBase); base.pathname = base.pathname.replace(/\/$/,'') + '/';
  const token = process.env.DANMAKU_API_TOKEN || '';
  if (token) { if (!/^[\w-]{8,128}$/.test(token)) throw new Error('弹幕服务令牌格式无效'); base.pathname += token + '/'; }
  const transport = request || createDanmakuApiRequest(base), cache = new Map(), pending = new Map();
  let active = 0; const waiting = [];
  async function acquire(end) {
    if (active < 2) { active++; return; }
    if (waiting.length >= 16 || end <= now()) throw fail('自动弹幕请求繁忙，请稍后重试');
    await new Promise((resolve,reject) => {
      const entry={resolve,timer:setTimeout(() => {
        const index=waiting.indexOf(entry);if(index>=0)waiting.splice(index,1);
        reject(fail('自动弹幕匹配超时'));
      },end-now())};waiting.push(entry);
    });
  }
  async function json(path, end) {
    await acquire(end);
    let response, timer, expired=false;
    try {
      const left = Math.min(15000, end - now()); if (left <= 0) throw fail('自动弹幕匹配超时');
      const url = new URL(path, base);
      return await Promise.race([(async () => {
        response = await transport(url.href, { timeout:left });
        if (expired) { response.destroy(); throw fail('自动弹幕匹配超时'); }
        if (response.statusCode !== 200) { response.destroy(); throw fail(`自动弹幕服务暂不可用（HTTP ${response.statusCode}）`); }
        if (response.finalUrl && response.finalUrl !== url.href) { response.destroy(); throw fail('自动弹幕服务返回未允许的跳转'); }
        try { return JSON.parse(await readText(response, MAX_BODY)); } catch (cause) { throw fail('自动弹幕服务返回无效数据'); }
      })(), new Promise((_,reject) => { timer=setTimeout(() => { expired=true;response?.destroy();reject(fail('自动弹幕匹配超时')); },left); })]);
    } finally { clearTimeout(timer); const next = waiting.shift(); if (next) { clearTimeout(next.timer);next.resolve(); } else active--; }
  }
  return { async list(value) {
    const info = identity(value); if (!info) return { comments:[], errors:[], sources:[] };
    const key = JSON.stringify(info), saved = cache.get(key); if (saved?.expires > now()) return saved.value;
    if (pending.has(key)) return pending.get(key);
    const work = (async () => {
      const end = now()+32000, errors=[], sources=[], comments=[];
      try {
        const data = await json('api/v2/search/episodes?' + new URLSearchParams({anime:info.title,episode:info.movie?'movie':String(info.episode)}),end);
        if (data.success === false || !Array.isArray(data.animes)) throw fail('自动弹幕搜索暂不可用');
        const candidates = [], seen = new Set();
        for (const anime of data.animes.slice(0,100)) {
          if (!matchesDanmakuTitle(anime.animeTitle,info)) continue;
          if (info.movie && !/电影|剧场版|movie/i.test(anime.typeDescription || anime.type || '')) continue;
          for (const episode of (Array.isArray(anime.episodes) ? anime.episodes : []).slice(0,2000)) {
            const name = episode.episodeTitle, origin = platform(episode.url);
            if (!origin || seen.has(origin) || !/^[1-9]\d{0,15}$/.test(String(episode.episodeId)) || extras.test(name || '')) continue;
            const season=seasonNumber(name);if(season&&season!==(info.season||1))continue;
            if(info.movie&&!fullMovieEpisode(name,info))continue;
            if (!info.movie && episodeNumber(name,false) !== info.episode) continue;
            seen.add(origin); candidates.push({ id:String(episode.episodeId), origin });
          }
        }
        let index=0;
        while(index<candidates.length&&sources.filter(row=>row.count>0).length<2&&end-now()>500) {
          const batch=candidates.slice(index,index+Math.min(2,2-sources.filter(row=>row.count>0).length));index+=batch.length;
          await Promise.all(batch.map(async candidate => {
            try {
              const data = await json('api/v2/comment/'+candidate.id+'?format=json',end);
              if (data.success === false || !Array.isArray(data.comments)) throw fail(candidate.origin+'弹幕暂不可用');
              const rows = commentRows(data,candidate.origin); comments.push(...rows); sources.push({platform:candidate.origin,count:rows.length,mode:'auto'});
            } catch (error) { errors.push(candidate.origin+'弹幕暂不可用'); }
          }));
        }
      } catch (error) { errors.push(error.status ? error.message : '自动弹幕服务暂不可用'); }
      if (!comments.length && fallback && end-now()>1000) {
        try { const result=await fallback(info,end); comments.push(...result.comments); sources.push(...result.sources); }
        catch { errors.push('哔哩哔哩自动弹幕暂不可用'); }
      }
      const seen = new Set();
      const rows=comments.sort((a,b)=>a.time-b.time).filter(row => { const key=JSON.stringify([row.time,row.text,row.color]); if(seen.has(key))return false;seen.add(key);return true; }).slice(0,MAX_COMMENTS);
      const result = {comments:rows,errors,sources:sources.map(source=>({...source,count:rows.filter(row=>row.origin===source.platform).length})).filter(source=>source.count>0)};
      cache.set(key,{expires:now()+(result.comments.length?300000:30000),value:result}); if(cache.size>128)cache.delete(cache.keys().next().value);
      return result;
    })(); pending.set(key,work);
    try { return await work; } finally { pending.delete(key); }
  } };
}
