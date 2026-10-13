import { createHash } from 'node:crypto';
import { request as networkRequest, readText, validateUrl } from './network.mjs';
import { importConfig, validateConfig } from './config.mjs';
import { parsePlaylist } from './live.mjs';
import { repairAddress, subscriptionWindow } from './import-repair.mjs';

const KEY='source-discovery-v1', INTERVAL=15*60_000;
const roots=[['Stardm0','MoonTV'],['katelya77','KatelyaTV']];
const directory='https://raw.githubusercontent.com/loren1997/vipvideo-web/main/web/subscription-presets.json';
const empty={sources:[],platforms:[],parsers:[],subscriptions:[],liveSources:[]};
const ownerPattern=/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const repoPattern=/^[A-Za-z0-9_.-]{1,100}$/;
const branchPattern=/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const fail=message=>Object.assign(new Error(message),{status:502});
const errorText=error=>String(error?.message||'公开配置暂不可访问').slice(0,300);
const autoId=url=>'discover-'+createHash('sha256').update(url).digest('hex').slice(0,16);
const cleanTitle=text=>String(text||'公开配置').replace(/<[^>]*>/g,'').replace(/\s+/g,' ').trim().slice(0,160);
const failureFields=error=>({
  ...(['rate_limit','forbidden','not_found','invalid','network'].includes(error?.reason)?{reason:error.reason}:{}),
  ...(Number.isInteger(error?.httpStatus)&&error.httpStatus>=100&&error.httpStatus<=599?{httpStatus:error.httpStatus}:{}),
  ...(Number.isFinite(error?.retryAt)&&error.retryAt>=0?{retryAt:error.retryAt}:{}),
});
function rawRepository(value){
  const url=new URL(value),parts=url.pathname.split('/').filter(Boolean);
  return url.hostname==='raw.githubusercontent.com'&&parts.length>=4&&ownerPattern.test(parts[0])&&repoPattern.test(parts[1])&&branchPattern.test(parts[2])?parts:null;
}
function publicUrl(value) {
  if(typeof value!=='string'||value.length>8192)throw fail('公开配置链接无效');
  return validateUrl(repairAddress(value)).href;
}
function repository(item,fork=false) {
  if(item?.archived!==false||item.private!==false||item.disabled===true||(fork&&item.fork!==true)||
    typeof item.full_name!=='string'||typeof item.default_branch!=='string'||!branchPattern.test(item.default_branch))return null;
  const parts=item.full_name.split('/');
  return parts.length===2&&ownerPattern.test(parts[0])&&repoPattern.test(parts[1])&&!['.','..'].includes(parts[1])?[...parts,item.default_branch]:null;
}
function decodeXml(value) {
  value=value.replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/,'$1');
  return value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi,entity=>{
    const common={'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"};
    if(common[entity.toLowerCase()])return common[entity.toLowerCase()];
    const n=entity[2].toLowerCase()==='x'?parseInt(entity.slice(3,-1),16):Number(entity.slice(2,-1));
    return n>0&&n<=0x10ffff&&!(n>=0xd800&&n<=0xdfff)?String.fromCodePoint(n):'';
  });
}
function rssItems(xml) {
  if(/<!DOCTYPE\b|<!ENTITY\b|<\?xml-stylesheet\b/i.test(xml)||!/<rss\b/i.test(xml)||/captcha|安全验证|异常请求/i.test(xml))throw fail('公开搜索暂不可访问或需要验证');
  return [...xml.replace(/<!--[\s\S]*?-->/g,'').matchAll(/<item\b[^>]*>([\s\S]*?)<\/item\s*>/gi)].slice(0,10).map(match=>({
    title:cleanTitle(decodeXml(match[1].match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]||'公开搜索结果')),
    url:decodeXml(match[1].match(/<link\b[^>]*>([\s\S]*?)<\/link>/i)?.[1]||'').trim(),
  }));
}
function links(value,hint,name) {
  const url=new URL(publicUrl(value)),parts=url.pathname.split('/').filter(Boolean);
  if(url.hostname==='github.com'&&parts.length>=2&&ownerPattern.test(parts[0])&&repoPattern.test(parts[1])&&!['.','..'].includes(parts[1])){
    if(parts[2]==='blob'&&branchPattern.test(parts[3])&&parts.length>4&&parts.slice(4).every(part=>/^[A-Za-z0-9_.-]+$/.test(part)&&!['.','..'].includes(part)))
      return links('https://raw.githubusercontent.com/'+parts.join('/').replace('/blob/','/'),hint,name);
    if(parts.length===2)return(hint==='live'?['index.m3u','output/result.m3u']:['config.json']).map(path=>({
      name:cleanTitle(name||parts.join('/')),url:'https://raw.githubusercontent.com/'+parts[0]+'/'+parts[1]+'/main/'+path,kind:hint,status:'pending',added:false,
    }));
  }
  const kind=/\.json$/i.test(url.pathname)?'vod':/\.m3u8?$/i.test(url.pathname)?'live':null;
  return kind?[{name:cleanTitle(name),url:url.href,kind,status:'pending',added:false}]:[];
}

export function createSourceDiscovery({store,maintenance,playability,request=networkRequest,now=Date.now,logger=console}={}) {
  if(!store?.config||!store?.setConfig||!store?.meta||!store?.setMeta||!maintenance?.verify||!maintenance?.update||!playability?.check)throw new Error('自动发现需要配置、影视验证和可播放性模块');
  let state={lastDiscovery:0,discoveryCursor:0,candidates:[],managed:Object.create(null),backoff:Object.create(null),paths:Object.create(null),sourceCursor:Object.create(null)};
  let job,timer,started=false,stopping=false,active=0,httpCount=0;const waiting=[];
  try{
    const saved=store.meta(KEY);
    if(saved){
      if(typeof saved!=='string'||saved.length>1024*1024)throw fail('自动发现记录过大');
      const data=JSON.parse(saved);
      if(!data||typeof data!=='object'||Array.isArray(data))throw fail('自动发现记录格式不正确');
      if(Number.isFinite(data.lastDiscovery)&&data.lastDiscovery>=0)state.lastDiscovery=data.lastDiscovery;
      if(Number.isSafeInteger(data.discoveryCursor)&&data.discoveryCursor>=0)state.discoveryCursor=data.discoveryCursor;
      if(Array.isArray(data.candidates))state.candidates=data.candidates.slice(0,20).filter(row=>row&&typeof row.name==='string'&&typeof row.status==='string').flatMap(row=>{
        try{return[{name:cleanTitle(row.name),url:publicUrl(row.url),kind:['vod','live','provider'].includes(row.kind)?row.kind:'vod',status:row.status.slice(0,30),added:row.added===true,...(row.error?{error:String(row.error).slice(0,300)}:{}),...failureFields(row)}];}catch{return[];}
      });
      if(data.managed&&typeof data.managed==='object'&&!Array.isArray(data.managed))for(const[url,record]of Object.entries(data.managed)){
        try{if(record&&typeof record.id==='string'&&record.id.length<=200)state.managed[publicUrl(url)]={id:record.id,kind:record.kind==='live'?'live':'vod',blocked:record.blocked===true,...(record.target?{target:publicUrl(record.target)}:{})};}catch{/* 已保存的不可信地址不会用于发现或恢复。 */}
      }
      for(const[url,record]of Object.entries(data.backoff||{}).slice(-200))try{
        if(record&&['rate_limit','forbidden','not_found','invalid','network'].includes(record.reason)&&Number.isFinite(record.retryAt)&&record.retryAt>=0)state.backoff[publicUrl(url)]={...failureFields(record),error:String(record.error||'公开配置暂不可访问').slice(0,300),failures:Math.min(8,Math.max(1,Number(record.failures)||1)),at:Number(record.at)||0};
      }catch{/* 不可信持久化地址不会被请求。 */}
      for(const[url,record]of Object.entries(data.paths||{}).slice(-40))try{
        const original=publicUrl(url),target=publicUrl(record.url),a=rawRepository(original),b=rawRepository(target);
        if(a&&b&&a[0]===b[0]&&a[1]===b[1])state.paths[original]={url:target};
      }catch{/* 路径修复只能留在同一个公开仓库。 */}
      for(const[url,cursor]of Object.entries(data.sourceCursor||{}).slice(-200))try{if(Number.isSafeInteger(cursor)&&cursor>=0)state.sourceCursor[publicUrl(url)]=cursor;}catch{/* 忽略无效游标。 */}
    }
  }catch(error){logger.error('自动发现记录无法读取',error);}
  const persist=()=>store.setMeta(KEY,JSON.stringify(state));
  const status=()=>structuredClone({running:!!job,lastDiscovery:state.lastDiscovery,candidates:state.candidates.slice(0,20)});
  const sameUrl=(row,url)=>{try{return publicUrl(row.url)===url;}catch{return false;}};
  function reconcile(config){
    for(const[url,record]of Object.entries(state.managed)){
      const found=(record.kind==='live'?config.liveSources||[]:config.subscriptions||[]).find(row=>sameUrl(row,record.target||url));
      if(!found||found.enabled===false)record.blocked=true;else{record.id=found.id;record.blocked=false;}
    }
  }
  function configured(row){
    const config=store.config();reconcile(config);
    const target=state.managed[row.url]?.target||row.url;
    const vod=(config.subscriptions||[]).find(item=>sameUrl(item,target)),tv=(config.liveSources||[]).find(item=>sameUrl(item,target)),found=vod||tv;
    if(found){state.managed[row.url]={id:found.id,kind:vod?'vod':'live',blocked:found.enabled===false,...(target!==row.url?{target}:{})};row.status=found.enabled===false?'disabled':'existing';return true;}
    if(state.managed[row.url]?.blocked){row.status='skipped';row.error='此订阅已由用户删除、停用或更改';return true;}
    return false;
  }
  async function text(url,maxBytes=1024*1024){
    url=publicUrl(String(url));
    const saved=state.backoff[url];
    if(saved?.retryAt>now())throw Object.assign(fail(saved.error),failureFields(saved),{fromCache:true});
    if(active>=2)await new Promise(resolve=>waiting.push(resolve));else active++;
    let response,timer,expired=false;
    try{
      if(stopping)throw fail('自动发现已停止');
      const quota=state.backoff[new URL(url).origin+'/'];
      if(new URL(url).hostname==='api.github.com'&&quota?.reason==='rate_limit'&&quota.retryAt>now())throw Object.assign(fail(quota.error),failureFields(quota),{fromCache:true});
      if(httpCount>=24)throw fail('本轮公开配置请求次数已达到上限');httpCount++;
      const parsed=validateUrl(url);
      return await Promise.race([
        (async()=>{
          response=await request(parsed,{timeout:8000,headers:{Accept:'application/json, application/rss+xml, text/plain, text/html','User-Agent':'VipVideo-Web-source-discovery'}});
          if(expired){response.destroy();throw fail('公开配置请求超时（8 秒）');}
          if(response.statusCode!==200){
            const code=response.statusCode,headers=response.headers||{};let body='';
            if(code===403||code===429)try{body=await readText(response,8192);}catch{/* 响应头仍可用于识别限流，错误正文大小不影响安全。 */}
            const limited=code===429||(code===403&&(String(headers['x-ratelimit-remaining'])==='0'||headers['retry-after']!==undefined||/rate limit|secondary rate/i.test(body)));
            const reason=limited?'rate_limit':code===403?'forbidden':code===404?'not_found':'network';
            const message=limited?'公开接口限流，稍后自动重试':code===403?'公开接口拒绝访问（HTTP 403）':code===404?'公开配置路径不存在或暂不可公开访问（HTTP 404）':'公开配置返回 HTTP '+code;
            let wait=limited?Math.min(6*60*60_000,60_000*2**Math.min(8,state.backoff[url]?.failures||0)):reason==='forbidden'?24*60*60_000:reason==='not_found'?6*60*60_000:INTERVAL;
            const after=headers['retry-after'];
            if(limited&&after!==undefined){const seconds=Number(after);const date=Date.parse(String(after));wait=Number.isFinite(seconds)&&seconds>=0?seconds*1000:Number.isFinite(date)?Math.max(0,date-now()):wait;}
            else if(limited&&String(headers['x-ratelimit-remaining'])==='0'&&Number.isFinite(Number(headers['x-ratelimit-reset'])))wait=Math.max(0,Number(headers['x-ratelimit-reset'])*1000-now());
            throw Object.assign(fail(message),{reason,httpStatus:code,retryAt:now()+Math.max(1000,Math.min(wait,24*60*60_000))});
          }
          const result={body:await readText(response,maxBytes),url:publicUrl(response.finalUrl||parsed.href)};
          delete state.backoff[url];return result;
        })(),
        new Promise((_,reject)=>{timer=setTimeout(()=>{expired=true;response?.destroy();reject(fail('公开配置请求超时（8 秒）'));},8000);}),
      ]);
    }catch(error){
      if(!stopping&&!error.fromCache&&httpCount<=24&&!/次数已达到上限/.test(errorText(error))){
        const failures=Math.min(8,(state.backoff[url]?.failures||0)+1);
        if(!error.reason)error.reason='network';
        if(!error.retryAt)error.retryAt=now()+Math.min(6*60*60_000,INTERVAL*2**(failures-1));
        state.backoff[url]={...failureFields(error),error:errorText(error),failures,at:now()};
        if(new URL(url).hostname==='api.github.com'&&error.reason==='rate_limit')state.backoff['https://api.github.com/']={...state.backoff[url]};
        for(const old of Object.keys(state.backoff).sort((a,b)=>state.backoff[a].at-state.backoff[b].at).slice(0,-200))delete state.backoff[old];
      }
      throw error;
    }finally{clearTimeout(timer);response?.destroy();const next=waiting.shift();if(next)next();else active--;}
  }
  async function repairedPath(url){
    const parts=rawRepository(url);if(!parts)return null;
    const [owner,repo,,...oldPath]=parts,base='https://api.github.com/repos/'+owner+'/'+repo;
    const metadata=JSON.parse((await text(base,256*1024)).body),actual=repository(metadata);
    if(!actual||actual[0].toLowerCase()!==owner.toLowerCase()||actual[1].toLowerCase()!==repo.toLowerCase())throw fail('公开仓库元数据无效');
    const branch=actual[2];let entries=JSON.parse((await text(base+'/contents?'+new URLSearchParams({ref:branch}),512*1024)).body);
    if(!Array.isArray(entries))throw fail('公开仓库文件列表无效');
    const valid=item=>item?.type==='file'&&typeof item.path==='string'&&/^[A-Za-z0-9_.\/-]{1,200}\.json$/i.test(item.path)&&!item.path.split('/').some(part=>['.','..'].includes(part))&&!/(?:example|sample|package|lock|tsconfig)/i.test(item.path)&&/(?:config|source|api|jin\d*)/i.test(item.name||item.path);
    if(!entries.some(valid)){
      const dir=entries.find(item=>item?.type==='dir'&&['config','configs'].includes(item.path));
      if(dir)entries=JSON.parse((await text(base+'/contents/'+dir.path+'?'+new URLSearchParams({ref:branch}),512*1024)).body);
    }
    const selected=Array.isArray(entries)?entries.filter(valid).sort((a,b)=>Number(b.path===oldPath.join('/'))-Number(a.path===oldPath.join('/'))||Number(b.path==='config.json')-Number(a.path==='config.json')||a.path.localeCompare(b.path))[0]:null;
    if(!selected)return null;
    const target=publicUrl('https://raw.githubusercontent.com/'+[owner,repo,branch,selected.path].join('/'));
    return target===url?null:target;
  }
  async function run(){
    httpCount=0;
    const baseline=store.config();reconcile(baseline);
    for(const[kind,rows]of[['vod',baseline.subscriptions||[]],['live',baseline.liveSources||[]]])for(const row of rows){
      try{state.managed[publicUrl(row.url)]={id:row.id,kind,blocked:row.enabled===false};}catch{/* 无效的现有链接不用于恢复。 */}
    }
    // 在首次联网前登记用户配置，抓取期间的删除也必须保留。
    persist();
    const providers=[],seeds=roots.map(([owner,repo])=>links('https://raw.githubusercontent.com/'+owner+'/'+repo+'/main/config.json','vod',owner+'/'+repo)[0]);
    const curated=[],searched=[],github=[],forks=[],pages=[];
    async function provider(name,url,handle,maxBytes){
      try{await handle(await text(url,maxBytes));}catch(error){
        if(!error.reason&&!stopping){error.reason='invalid';error.retryAt=now()+6*60*60_000;state.backoff[url]={...failureFields(error),error:errorText(error),failures:1,at:now()};}
        providers.push({name,url,kind:'provider',status:'error',added:false,error:errorText(error),...failureFields(error)});
      }
    }
    await Promise.all([
      provider('公开订阅目录',directory,async result=>{
        const data=JSON.parse(result.body);
        if(!data||!Array.isArray(data.subscriptions)||!Array.isArray(data.liveSources))throw fail('公开订阅目录格式不正确');
        const received=[];
        for(const[kind,entries]of[['vod',data.subscriptions],['live',data.liveSources]])for(const row of entries.slice(0,20)){
          if(!row||typeof row.name!=='string')throw fail('公开订阅目录项目无效');
          received.push({name:cleanTitle(row.name),url:publicUrl(row.url),kind,status:'pending',added:false});
        }
        curated.push(...received);
      }),
      ...roots.map(([owner,repo])=>provider(owner+'/'+repo+' 公开分支','https://api.github.com/repos/'+owner+'/'+repo+'/forks?per_page=5&sort=newest',async result=>{
        const data=JSON.parse(result.body);if(!Array.isArray(data))throw fail('公开分支列表无效');
        for(const item of data.slice(0,5)){const parts=repository(item,true);if(parts)forks.push(...links('https://raw.githubusercontent.com/'+parts.join('/')+'/config.json','vod',item.full_name));}
      })),
      ...[['vod','LibreTV config in:name,description,readme'],['live','IPTV China in:name,description']].map(([kind,query])=>{
        const url='https://api.github.com/search/repositories?'+new URLSearchParams({q:query,sort:'updated',order:'desc',per_page:'3'});
        return provider(kind==='vod'?'GitHub 影视配置搜索':'GitHub 电视订阅搜索',url,async result=>{
          const data=JSON.parse(result.body);if(!Array.isArray(data.items))throw fail('公开仓库搜索无效');
          for(const item of data.items.slice(0,3)){const parts=repository(item);if(!parts)continue;
            for(const path of kind==='vod'?['config.json']:['index.m3u','output/result.m3u'])github.push(...links('https://raw.githubusercontent.com/'+parts.join('/')+'/'+path,kind,item.full_name));
          }
        });
      }),
      ...[['vod','api_site config.json 影视 源'],['live','IPTV m3u 中国 电视 订阅']].map(([kind,query])=>{
        const url='https://www.bing.com/search?'+new URLSearchParams({format:'rss',q:query});
        return provider(kind==='vod'?'公开网页影视搜索':'公开网页电视搜索',url,async result=>{
          for(const item of rssItems(result.body)){try{const direct=links(item.url,kind,item.title);if(direct.length)searched.push(...direct);else if(pages.length<2)pages.push({...item,kind,url:publicUrl(item.url)});}catch{/* 私网和不支持协议不会进入请求队列。 */}}
        },512*1024);
      }),
    ]);
    await Promise.all(pages.slice(0,2).map(page=>provider('公开网页链接 · '+cleanTitle(page.title),page.url,async result=>{
      if(/captcha|安全验证|异常请求/i.test(result.body))throw fail('网页暂需验证，本轮跳过');
      const html=result.body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<!--[\s\S]*?-->/g,'');
      for(const match of[...html.matchAll(/<(?:a|link)\b[^>]*\bhref\s*=\s*(["'])(.*?)\1/gi)].slice(0,100)){
        try{searched.push(...links(new URL(decodeXml(match[2]),result.url).href,page.kind,page.title));}catch{/* 只提取显式配置地址，不递归浏览网页。 */}
      }
    },256*1024)));
    const unique=new Map(curated.concat(seeds,searched,github,forks).filter(Boolean).map(row=>{
      const resolved=state.paths[row.url];
      return[resolved?.url||row.url,resolved?{...row,originalUrl:row.url,url:resolved.url}:row];
    }));
    const unknown=[],existing=[];
    for(const row of unique.values())(configured(row)?existing:unknown).push(row);
    const limit=20-Math.min(20,providers.length),start=unknown.length?state.discoveryCursor%unknown.length:0;
    const selected=Array.from({length:Math.min(limit,unknown.length)},(_,index)=>unknown[(start+index)%unknown.length]);
    // 请求预算耗尽后的候选留到下一轮，避免固定前缀的死链接长期挡住新订阅。
    state.discoveryCursor=unknown.length?(start+Math.min(selected.length,Math.max(0,24-httpCount)))%unknown.length:0;
    const rows=selected.concat(existing.slice(0,limit-selected.length));state.candidates=providers.slice(0,20).concat(rows);
    const checks=new Map(),known=maintenance.status?.().sources||[];let cursor=0,added=0,verificationCount=0;
    function verify(source){
      if(!checks.has(source.api)){
        const present=store.config().sources.some(item=>item.enabled!==false&&item.api===source.api);
        const healthy=known.find(item=>item.api===source.api&&item.status==='ok'&&Number.isFinite(item.checkedAt)&&item.checkedAt<=now()&&now()-item.checkedAt<=6*60*60_000);
        checks.set(source.api,present&&healthy?.playable===true?Promise.resolve(healthy):verificationCount>=20?Promise.resolve({status:'pending',error:'本轮接口验证已达到上限'}):(verificationCount++,Promise.resolve().then(()=>maintenance.verify(source,{playback:true}))));
      }
      return checks.get(source.api);
    }
    function importedSources(body,url){
      const saved=state.sourceCursor[url]||0,page=Math.floor(saved/200)*200,offset=saved%200;
      const window=subscriptionWindow(body,page),sources=importConfig(empty,window.config).sources;
      return{sources,offset:offset<sources.length?offset:0,page,nextCursor:window.nextCursor,total:window.total,warnings:window.warnings};
    }
    await Promise.all(Array.from({length:2},async()=>{
      while(!stopping&&cursor<rows.length){
        const row=rows[cursor++],field=row.kind==='live'?'liveSources':'subscriptions';
        if(configured(row))continue;
        if(added>=4||(store.config()[field]||[]).length>=20){row.status='skipped';row.error='本轮或当前订阅数量已达到上限';continue;}
        row.status='checking';
        try{
          const original=row.originalUrl||row.url;let loaded;
          try{loaded=await text(row.url);}catch(error){
            if(error.reason!=='not_found'||error.fromCache||row.kind!=='vod')throw error;
            const target=await repairedPath(row.url);if(!target)throw error;
            if(configured({...row,url:original})||configured({...row,url:target})){
              row.status='skipped';row.error='修复后的订阅已配置，或已由用户删除、停用、更改';continue;
            }
            loaded=await text(target);state.paths[original]={url:target};row.originalUrl=original;row.url=target;
            for(const old of Object.keys(state.paths).slice(0,-40))delete state.paths[old];
          }
          let usable=false;
          if(row.kind==='vod'){
            const repaired=importedSources(loaded.body,row.url);
            if(repaired.warnings?.length)row.warnings=repaired.warnings.slice(0,10);
            const sources=repaired.sources;
            const sorted=[...new Map(sources.map(source=>[source.api,source])).values()];
            let attempted=0;
            for(const source of sorted.slice(repaired.offset,repaired.offset+3)){
              if(stopping)break;
              const result=await verify(source);
              if(result?.status==='pending')break;attempted++;
              if(result?.status==='ok'&&result.api===source.api&&result.playable===true){usable=true;break;}
            }
            state.sourceCursor[row.url]=repaired.offset+attempted>=sorted.length?repaired.nextCursor:repaired.page+repaired.offset+attempted;
            for(const old of Object.keys(state.sourceCursor).slice(0,-200))delete state.sourceCursor[old];
          }else{
            const channels=parsePlaylist(loaded.body,{id:autoId(row.url),name:row.name,url:loaded.url});
            for(const episode of channels.flatMap(channel=>channel.streams).slice(0,3)){if(stopping)break;if((await playability.check(episode))?.playable){usable=true;break;}}
          }
          if(stopping){row.status='skipped';row.error='自动发现已停止';continue;}
          if(!usable)throw fail(row.kind==='live'?'电视列表未通过线路可播放性验证':'配置未通过影视接口与媒体可播放性验证');
          if(original!==row.url&&configured({...row,url:original})){row.status='skipped';row.error='原订阅已由用户删除、停用或更改';continue;}
          if(configured(row))continue;
          const latest=store.config();
          if(added>=4||(latest[field]||[]).length>=20){row.status='skipped';row.error='本轮或当前订阅数量已达到上限';continue;}
          const id=autoId(row.url);
          if((latest[field]||[]).some(item=>item.id===id))throw fail('订阅标识已被使用，本次结果未应用');
          store.setConfig(validateConfig({...latest,[field]:[...(latest[field]||[]),{id,name:'自动发现 · '+row.name,url:row.url,enabled:true}]}));
          state.managed[row.url]={id,kind:row.kind,blocked:false};
          if(original!==row.url)state.managed[original]={id,kind:row.kind,blocked:false,target:row.url};
          row.status='added';row.added=true;added++;persist();
        }catch(error){row.status='error';row.error=errorText(error);if(!error.reason)error.reason='invalid';Object.assign(row,failureFields(error));}
      }
    }));
    if(added&&!stopping)try{await maintenance.update();}catch(error){logger.error('自动发现后的影视源更新失败',error);}
    state.lastDiscovery=now();reconcile(store.config());persist();
  }
  function discover(){
    if(stopping)return Promise.resolve(status());
    if(job)return job;
    job=(async()=>{try{await run();}finally{job=undefined;}return status();})();return job;
  }
  return{status,discover,
    start(){if(started)return;started=true;stopping=false;const schedule=delay=>{if(!started)return;timer=setTimeout(async()=>{try{await discover();}catch(error){logger.error('公开影视源自动发现失败',error);}finally{schedule(INTERVAL);}},delay);timer.unref?.();};schedule(0);},
    async stop(){started=false;stopping=true;clearTimeout(timer);await Promise.allSettled([job].filter(Boolean));},
  };
}
