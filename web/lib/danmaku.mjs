import { createHash, randomUUID } from 'node:crypto';
import { inflateRawSync, inflateSync } from 'node:zlib';
import { request as networkRequest, readText, validateUrl } from './network.mjs';

const LIMIT = 5000;
const BODY_LIMIT = 4 * 1024 * 1024;
const CACHE_TIME = 5 * 60 * 1000;
const fail = (message,status=400,cause) => Object.assign(new Error(message,{cause}),{status});
const numericId = value => /^\d{1,16}$/.test(String(value ?? '')) && Number.isSafeInteger(Number(value)) && Number(value)>0 ? String(Number(value)) : null;

function scope(value={}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('请选择有效的影片和剧集');
  let { key, episode } = value;
  if (typeof episode === 'string' && /^-?\d+(?:\.\d+)?$/.test(episode.trim())) episode = Number(episode.trim());
  const validEpisode = typeof episode === 'string'
    ? !!episode.trim() && episode.length <= 500 && !/[\u0000-\u001f]/.test(episode)
    : Number.isInteger(episode) && episode >= 0 && episode <= 10000;
  if (typeof key!=='string' || !key || key.length>8192 || /[\u0000-\u001f]/.test(key) || !validEpisode) throw fail('请选择有效的影片和剧集');
  if (typeof episode === 'string') episode = episode.trim();
  return createHash('sha256').update(JSON.stringify([key,episode])).digest('hex');
}
function cleanText(value) {
  if (typeof value!=='string' || value.length>800) return null;
  const text=value.replace(/[\u0000-\u001f\u007f-\u009f]/g,' ').replace(/\s+/g,' ').trim();
  return text && Array.from(text).length<=200 && !/<\/?[a-z!][^>]*>|javascript\s*:/i.test(text) ? text : null;
}
function colorOf(value) { return typeof value==='string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null; }
function decodeEntities(value) {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi,entity=>{
    const common={'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"};
    if(common[entity.toLowerCase()])return common[entity.toLowerCase()];
    const code=entity[2].toLowerCase()==='x'?parseInt(entity.slice(3,-1),16):Number(entity.slice(2,-1));
    return code>0 && code<=0x10ffff && !(code>=0xd800&&code<=0xdfff) ? String.fromCodePoint(code) : '';
  });
}
function parseXml(xml,cid) {
  if (/<!DOCTYPE\b|<!ENTITY\b|<\?xml-stylesheet\b/i.test(xml)) throw fail('外部弹幕包含不安全的 XML 声明',502);
  xml=xml.replace(/<!--[\s\S]*?-->/g,'');
  if (!/<i(?:\s[^>]*)?>[\s\S]*<\/i\s*>/i.test(xml) || /<html\b|<script\b/i.test(xml)) throw fail('外部弹幕返回的内容不是有效 XML',502);
  const comments=[],ids=new Set();
  for(const match of xml.matchAll(/<d\b([^>]*)>([\s\S]*?)<\/d\s*>/gi)) {
    const parameters=match[1].match(/\bp\s*=\s*(["'])(.*?)\1/i)?.[2]?.split(',');
    if(!parameters || !parameters[0]?.trim() || !parameters[3]?.trim() || ![1,4,5,6].includes(Number(parameters[1])))continue;
    const time=Number(parameters[0]),decimal=Number(parameters[3]);
    const body=match[2].replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/,'$1');
    const text=cleanText(decodeEntities(body));
    if(!text || !Number.isFinite(time) || time<0 || time>86400 || !Number.isInteger(decimal) || decimal<0 || decimal>0xffffff)continue;
    const color='#'+decimal.toString(16).padStart(6,'0');
    const id='bilibili:'+createHash('sha256').update(JSON.stringify([cid,parameters[7]||'',time,text,color])).digest('hex');
    if(ids.has(id))continue;
    ids.add(id);comments.push({id,time,text,color,origin:'bilibili'});
    if(comments.length>=LIMIT)break;
  }
  return comments;
}

export function createDanmaku({store,request=networkRequest,now=Date.now}={}) {
  if(!store?.meta || !store?.setMeta || !store?.list || !store?.save || !store?.remove)throw new Error('弹幕模块需要 SQLite 存储');
  const pending=new Map(),waiting=[];let active=0;
  const familyKind=id=>'danmaku-family:'+id;
  const externalKind=id=>'danmaku-external:'+id;
  const bindingKey=id=>'danmaku-binding-v1:'+id;
  function readBinding(id) {
    const raw=store.meta(bindingKey(id));
    if(!raw)return{url:'',offset:0};
    try {
      const value=JSON.parse(raw);
      if(typeof value.url==='string' && /^https:\/\/comment\.bilibili\.com\/\d{1,16}\.xml$/.test(value.url) && Number.isFinite(value.offset) && Math.abs(value.offset)<=600)return value;
    } catch { console.error('外部弹幕绑定无法读取，请重新绑定'); }
    return{url:'',offset:0};
  }
  async function fetchBody(url,xml=false) {
    if(active<2)active++;else await new Promise(resolve=>waiting.push(resolve));
    let upstream,timer,expired=false;
    try {
      return await Promise.race([
        (async()=>{
          upstream=await request(url,{timeout:8000});
          if(expired){upstream.destroy();throw fail('外部弹幕读取超时',502);}
          if(upstream.statusCode!==200){upstream.destroy();throw fail(`外部弹幕暂不可访问（HTTP ${upstream.statusCode}）`,502);}
          const final=new URL(upstream.finalUrl||url),expected=new URL(url);
          if(final.origin!==expected.origin || final.pathname!==expected.pathname){upstream.destroy();throw fail('外部弹幕来源跳转到未允许地址',502);}
          if(xml && String(upstream.headers['content-encoding']||'').toLowerCase()==='deflate'){
            const chunks=[];let size=0;
            for await(const chunk of upstream){size+=chunk.length;if(size>BODY_LIMIT){upstream.destroy();throw fail('外部弹幕响应过大',502);}chunks.push(Buffer.from(chunk));}
            const body=Buffer.concat(chunks);
            // B站经典 XML 实际使用 raw-deflate；普通 zlib 封装也保留兼容。
            const wrapped=body.length>=2 && (body[0]&15)===8 && ((body[0]<<8|body[1])%31)===0;
            try{return (wrapped?inflateSync:inflateRawSync)(body,{maxOutputLength:BODY_LIMIT}).toString('utf8');}
            catch(cause){throw fail('外部弹幕解压失败或响应过大',502,cause);}
          }
          return readText(upstream,xml?BODY_LIMIT:512*1024);
        })(),
        new Promise((_,reject)=>{timer=setTimeout(()=>{expired=true;upstream?.destroy();reject(fail('外部弹幕读取超时',502));},8000);}),
      ]);
    } finally {
      clearTimeout(timer);const next=waiting.shift();if(next)next();else active--;
    }
  }
  function family(id) {
    return store.list(familyKind(id)).slice(0,LIMIT).filter(row=>row.origin==='family' && Number.isFinite(row.time) && row.time>=0 && row.time<=86400 && cleanText(row.text) && colorOf(row.color)).map(({id,time,text,color,origin})=>({id,time,text,color,origin}));
  }
  async function remote(url) {
    if(pending.has(url))return pending.get(url);
    const cid=new URL(url).pathname.match(/^\/(\d+)\.xml$/)?.[1];
    if(!numericId(cid))throw fail('外部弹幕 CID 无效');
    const work=(async()=>parseXml(await fetchBody(url,true),cid))();pending.set(url,work);
    try{return await work;}finally{pending.delete(url);}
  }
  return {
    binding(value) {const {url,offset}=readBinding(scope(value));return{url,offset};},
    async bind(value) {
      const id=scope(value),offset=value.offset??0;
      if(typeof offset!=='number' || !Number.isFinite(offset) || Math.abs(offset)>600)throw fail('弹幕时间偏移必须在 -600 到 600 秒之间');
      if(typeof value.url!=='string' || value.url.length>2048)throw fail('请输入有效的 B站 CID 或视频链接');
      let input=value.url.trim(),url='';
      if(input){
        const cid=numericId(input);
        if(cid)url=`https://comment.bilibili.com/${cid}.xml`;
        else {
          if(/^BV[0-9A-Za-z]{10}$/.test(input))input='https://www.bilibili.com/video/'+input+'/';
          const parsed=validateUrl(input);
          const xmlId=parsed.hostname==='comment.bilibili.com' && parsed.pathname.match(/^\/(\d+)\.xml$/)?.[1];
          if(xmlId && !parsed.port && !parsed.search){if(!numericId(xmlId))throw fail('外部弹幕 CID 无效');url=`https://comment.bilibili.com/${numericId(xmlId)}.xml`;}
          else {
            const bvid=['www.bilibili.com','m.bilibili.com'].includes(parsed.hostname) && !parsed.port && parsed.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10})\/?$/)?.[1];
            if(!bvid)throw fail('仅支持 B站官方 CID XML 地址或 BV 视频链接');
            const explicit=parsed.searchParams.get('p');
            if(explicit!==null && (!/^\d+$/.test(explicit) || Number(explicit)<1 || Number(explicit)>10000))throw fail('B站分 P 编号无效');
            let data;
            try{data=JSON.parse(await fetchBody('https://api.bilibili.com/x/player/pagelist?'+new URLSearchParams({bvid})));}
            catch(error){throw error.status?error:fail('B站分 P 列表暂不可读取',502,error);}
            if(data.code!==0 || !Array.isArray(data.data) || !data.data.length)throw fail('B站暂未返回可用的视频分 P',502);
            if(explicit===null && data.data.length>1)throw fail('该视频有多个分 P，请在链接中指定 ?p=编号');
            const selected=data.data.find(part=>Number(part.page)===(explicit===null?1:Number(explicit))),selectedCid=numericId(selected?.cid);
            if(!selectedCid)throw fail('所选 B站分 P 不存在');
            url=`https://comment.bilibili.com/${selectedCid}.xml`;
          }
        }
      }
      store.setMeta(bindingKey(id),JSON.stringify({url,offset}));store.remove(externalKind(id),null);
      return{url,offset};
    },
    send(value) {
      const id=scope(value),text=cleanText(value.text),color=colorOf(value.color??'#ffffff');
      if(typeof value.time!=='number' || !Number.isFinite(value.time) || value.time<0 || value.time>86400 || !text || !color)throw fail('弹幕内容、时间或颜色无效；文字最多 200 字');
      const comment={id:'family:'+randomUUID(),time:value.time,text,color,origin:'family'};
      const kind=familyKind(id),rows=store.list(kind);
      for(const row of rows.slice(LIMIT-1))store.remove(kind,row.key);
      store.save(kind,{key:comment.id,...comment});return comment;
    },
    async list(value) {
      const id=scope(value),bound=readBinding(id),errors=[];let external=[];
      if(bound.url){
        const cached=store.list(externalKind(id))[0];
        if(cached?.url===bound.url && cached.expires>now() && Array.isArray(cached.comments))external=cached.comments.slice(0,LIMIT);
        else try {
          external=await remote(bound.url);
          if(readBinding(id).url!==bound.url)throw fail('外部弹幕绑定已变更，请重新读取',502);
          store.save(externalKind(id),{key:'cache',url:bound.url,expires:now()+CACHE_TIME,comments:external});
        } catch(error){errors.push(error.status?error.message:'外部弹幕暂不可读取');external=[];}
      }
      const local=family(id);
      const current=readBinding(id);
      if(current.url!==bound.url){external=[];if(!errors.length)errors.push('外部弹幕绑定已变更，请重新读取');}
      const comments=[...local,...external.slice(0,LIMIT-local.length).map(comment=>({...comment,time:comment.time+current.offset}))].filter(comment=>Number.isFinite(comment.time)&&comment.time>=0&&comment.time<=86400&&cleanText(comment.text)&&colorOf(comment.color)).sort((a,b)=>a.time-b.time);
      return{comments,updated:now(),errors};
    },
  };
}
