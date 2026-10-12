import { createHash } from 'node:crypto';
import { request as networkRequest, readText, validateUrl } from './network.mjs';
import { importConfig, validateConfig } from './config.mjs';
import { parsePlaylist } from './live.mjs';
import { repairAddress, repairImport } from './import-repair.mjs';

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
  let state={lastDiscovery:0,discoveryCursor:0,candidates:[],managed:Object.create(null)};
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
        try{return[{name:cleanTitle(row.name),url:publicUrl(row.url),kind:['vod','live','provider'].includes(row.kind)?row.kind:'vod',status:row.status.slice(0,30),added:row.added===true,...(row.error?{error:String(row.error).slice(0,300)}:{})}];}catch{return[];}
      });
      if(data.managed&&typeof data.managed==='object'&&!Array.isArray(data.managed))for(const[url,record]of Object.entries(data.managed)){
        try{if(record&&typeof record.id==='string'&&record.id.length<=200)state.managed[publicUrl(url)]={id:record.id,kind:record.kind==='live'?'live':'vod',blocked:record.blocked===true};}catch{/* 已保存的不可信地址不会用于发现或恢复。 */}
      }
    }
  }catch(error){logger.error('自动发现记录无法读取',error);}
  const persist=()=>store.setMeta(KEY,JSON.stringify(state));
  const status=()=>structuredClone({running:!!job,lastDiscovery:state.lastDiscovery,candidates:state.candidates.slice(0,20)});
  const sameUrl=(row,url)=>{try{return publicUrl(row.url)===url;}catch{return false;}};
  function reconcile(config){
    for(const[url,record]of Object.entries(state.managed)){
      const found=(record.kind==='live'?config.liveSources||[]:config.subscriptions||[]).find(row=>sameUrl(row,url));
      if(!found||found.enabled===false)record.blocked=true;else{record.id=found.id;record.blocked=false;}
    }
  }
  function configured(row){
    const config=store.config();reconcile(config);
    const vod=(config.subscriptions||[]).find(item=>sameUrl(item,row.url)),tv=(config.liveSources||[]).find(item=>sameUrl(item,row.url)),found=vod||tv;
    if(found){state.managed[row.url]={id:found.id,kind:vod?'vod':'live',blocked:found.enabled===false};row.status=found.enabled===false?'disabled':'existing';return true;}
    if(state.managed[row.url]?.blocked){row.status='skipped';row.error='此订阅已由用户删除、停用或更改';return true;}
    return false;
  }
  async function text(url,maxBytes=1024*1024){
    if(active>=2)await new Promise(resolve=>waiting.push(resolve));else active++;
    let response,timer,expired=false;
    try{
      if(stopping)throw fail('自动发现已停止');
      if(httpCount>=24)throw fail('本轮公开配置请求次数已达到上限');httpCount++;
      const parsed=validateUrl(url);
      return await Promise.race([
        (async()=>{
          response=await request(parsed,{timeout:8000,headers:{Accept:'application/json, application/rss+xml, text/plain, text/html','User-Agent':'VipVideo-Web-source-discovery'}});
          if(expired){response.destroy();throw fail('公开配置请求超时（8 秒）');}
          if(response.statusCode!==200)throw fail('公开配置返回 HTTP '+response.statusCode);
          return{body:await readText(response,maxBytes),url:publicUrl(response.finalUrl||parsed.href)};
        })(),
        new Promise((_,reject)=>{timer=setTimeout(()=>{expired=true;response?.destroy();reject(fail('公开配置请求超时（8 秒）'));},8000);}),
      ]);
    }finally{clearTimeout(timer);response?.destroy();const next=waiting.shift();if(next)next();else active--;}
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
      try{await handle(await text(url,maxBytes));}catch(error){providers.push({name,url,kind:'provider',status:'error',added:false,error:errorText(error)});}
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
    const unique=new Map(curated.concat(seeds,searched,github,forks).filter(Boolean).map(row=>[row.url,row]));
    const unknown=[],existing=[];
    for(const row of unique.values())(configured(row)?existing:unknown).push(row);
    const limit=20-Math.min(20,providers.length),start=unknown.length?state.discoveryCursor%unknown.length:0;
    const selected=Array.from({length:Math.min(limit,unknown.length)},(_,index)=>unknown[(start+index)%unknown.length]);
    // 请求预算耗尽后的候选留到下一轮，避免固定前缀的死链接长期挡住新订阅。
    state.discoveryCursor=unknown.length?(start+Math.min(selected.length,Math.max(0,24-httpCount)))%unknown.length:0;
    const rows=selected.concat(existing.slice(0,limit-selected.length));state.candidates=providers.slice(0,20).concat(rows);
    const checks=new Map(),known=maintenance.status?.().sources||[];let cursor=0,added=0;
    function verify(source){
      if(!checks.has(source.api)){
        const present=store.config().sources.some(item=>item.enabled!==false&&item.api===source.api);
        const healthy=known.find(item=>item.api===source.api&&item.status==='ok'&&Number.isFinite(item.checkedAt)&&item.checkedAt<=now()&&now()-item.checkedAt<=6*60*60_000);
        checks.set(source.api,present&&healthy?Promise.resolve(healthy):Promise.resolve().then(()=>maintenance.verify(source)));
      }
      return checks.get(source.api);
    }
    await Promise.all(Array.from({length:2},async()=>{
      while(!stopping&&cursor<rows.length){
        const row=rows[cursor++],field=row.kind==='live'?'liveSources':'subscriptions';
        if(configured(row))continue;
        if(added>=4||(store.config()[field]||[]).length>=20){row.status='skipped';row.error='本轮或当前订阅数量已达到上限';continue;}
        row.status='checking';
        try{
          const loaded=await text(row.url);let usable=false;
          if(row.kind==='vod'){
            const repaired=repairImport(loaded.body);
            if(repaired.warnings?.length)row.warnings=repaired.warnings.slice(0,10);
            const sources=importConfig(empty,repaired.config).sources;
            const sorted=[...new Map(sources.map(source=>[source.api,source])).values()].sort((a,b)=>Number(known.some(item=>item.api===b.api&&item.status==='ok'))-Number(known.some(item=>item.api===a.api&&item.status==='ok')));
            for(const source of sorted.slice(0,3)){if(stopping)break;const result=await verify(source);if(result?.status==='ok'&&result.api===source.api){usable=true;break;}}
          }else{
            const channels=parsePlaylist(loaded.body,{id:autoId(row.url),name:row.name,url:loaded.url});
            for(const episode of channels.flatMap(channel=>channel.streams).slice(0,3)){if(stopping)break;if((await playability.check(episode))?.playable){usable=true;break;}}
          }
          if(stopping){row.status='skipped';row.error='自动发现已停止';continue;}
          if(!usable)throw fail(row.kind==='live'?'电视列表未通过线路可播放性验证':'配置未通过影视接口可用性验证');
          if(configured(row))continue;
          const latest=store.config();
          if(added>=4||(latest[field]||[]).length>=20){row.status='skipped';row.error='本轮或当前订阅数量已达到上限';continue;}
          const id=autoId(row.url);
          if((latest[field]||[]).some(item=>item.id===id))throw fail('订阅标识已被使用，本次结果未应用');
          store.setConfig(validateConfig({...latest,[field]:[...(latest[field]||[]),{id,name:'自动发现 · '+row.name,url:row.url,enabled:true}]}));
          state.managed[row.url]={id,kind:row.kind,blocked:false};row.status='added';row.added=true;added++;persist();
        }catch(error){row.status='error';row.error=errorText(error);}
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
