import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createSourceDiscovery } from '../lib/source-discovery.mjs';
import { createSourceMaintenance } from '../lib/source-maintenance.mjs';
import { createStore } from '../lib/store.mjs';
import { repairImport, subscriptionWindow } from '../lib/import-repair.mjs';
import { importConfig } from '../lib/config.mjs';

const empty={showAdult:false,sources:[],platforms:[],parsers:[],subscriptions:[],liveSources:[]};
const directory='https://raw.githubusercontent.com/loren1997/vipvideo-web/main/web/subscription-presets.json';
const forkUrl='https://raw.githubusercontent.com/ResearchUser/PublicConfig/main/config.json';
const payload=(api='https://catalog.example/api.php/provide/vod')=>({api_site:{neutral:{name:'中性影视源',api}}});
const playlist='#EXTM3U\n#EXTINF:-1,公共频道\nhttp://127.0.0.1/private.m3u8\n#EXTINF:-1,普通频道\nhttps://tv.example/dead.m3u8\n#EXTINF:-1,普通频道二\nhttps://tv.example/live.m3u8?token=a%24b';
const xml=items=>'<rss><channel>'+items.map(([url,title='公开配置'])=>'<item><title>'+title+'</title><link>'+url.replaceAll('&','&amp;')+'</link></item>').join('')+'</channel></rss>';
const repo=(full_name,extra={})=>({full_name,default_branch:'main',fork:true,archived:false,private:false,...extra});
const response=(body,statusCode=200,url='')=>Object.assign(Readable.from([typeof body==='string'?body:JSON.stringify(body)]),{statusCode,headers:{},finalUrl:url});
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
function memoryStore(initial=empty){
  let config=structuredClone(initial);const metadata=new Map();
  return{metadata,config:()=>config,setConfig(value){config=structuredClone(value);return config;},meta:key=>metadata.get(key),setMeta:(key,value)=>metadata.set(key,value)};
}
function fixture({store=memoryStore(),files=new Map(),curated={subscriptions:[],liveSources:[]},forks=[],searchVod=[],searchTv=[],rssVod=[],rssTv=[],verify,play,override,now=()=>1000,backgroundMode='normal',maintenance:providedMaintenance}={}){
  const seen=[],verified=[],played=[],errors=[],listeners=new Set();let updates=0,active=0,maxActive=0;
  const request=async(input,options)=>{
    const url=String(input),parsed=new URL(url);seen.push(url);assert.equal(options.timeout,8000);assert.equal(options.headers.Authorization,undefined);
    active++;maxActive=Math.max(maxActive,active);await new Promise(done=>setImmediate(done));active--;
    const custom=await override?.(url,options);if(custom)return custom;
    if(url===directory)return response(curated,200,url);
    if(parsed.hostname==='api.github.com'&&parsed.pathname.endsWith('/forks'))return response(forks,200,url);
    if(parsed.hostname==='api.github.com'&&parsed.pathname==='/search/repositories')return response({items:parsed.searchParams.get('q').includes('IPTV')?searchTv:searchVod},200,url);
    if(parsed.hostname==='www.bing.com')return response(xml(parsed.searchParams.get('q').includes('IPTV')?rssTv:rssVod),200,url);
    if(files.has(url))return response(files.get(url),200,url);
    return response('not found',404,url);
  };
  const maintenance=providedMaintenance||{status:()=>({sources:[]}),async verify(source,options){verified.push(source);assert.deepEqual(options,{playback:true});return verify?verify(source):{api:source.api,status:'ok',playable:true,checkedAt:now()};},async update(){updates++;},observeSubscriptions(listener){listeners.add(listener);return()=>listeners.delete(listener);}};
  const playability={async check(episode){played.push(episode);return play?play(episode):{playable:episode.url.includes('/live.m3u8'),checkedAt:now()};}};
  const service=createSourceDiscovery({store,maintenance,playability,request,now,backgroundMode,logger:{error:(...value)=>errors.push(value)}});
  return{service,store,seen,verified,played,errors,maintenance,playability,request,emitSubscription(result){for(const listener of listeners)listener(result);},get listeners(){return listeners.size;},get updates(){return updates;},get maxActive(){return maxActive;}};
}

test('unconfigured public forks are verified before automatic subscription and share a concurrent discovery cycle',async()=>{
  const f=fixture({forks:[repo('ResearchUser/PublicConfig')],files:new Map([[forkUrl,payload()]])});
  assert.equal(f.seen.length,0);
  const first=f.service.discover(),same=f.service.discover();assert.equal(first,same);
  assert.equal(f.service.status().running,true);
  const result=await first;
  assert.equal(result.running,false);assert.equal(result.lastDiscovery,1000);
  assert.equal(f.store.config().subscriptions.length,1);
  assert.equal(f.store.config().subscriptions[0].url,forkUrl);assert.match(f.store.config().subscriptions[0].id,/^discover-[0-9a-f]{16}$/);
  assert.equal(f.verified.length,1);assert.equal(f.updates,1);assert.ok(f.maxActive<=2);
  assert.equal(result.candidates.find(row=>row.url===forkUrl).added,true);
  await f.service.stop();
});

test('independent curated VOD and TV subscriptions join only after API and playable stream verification',async()=>{
  const json='https://config.example/independent.json',m3u='https://tv.example/channels.m3u';
  const f=fixture({curated:{subscriptions:[{name:'独立公开配置',url:json}],liveSources:[{name:'独立电视列表',url:m3u}]},files:new Map([[json,payload()],[m3u,playlist]])});
  const result=await f.service.discover();
  assert.equal(f.store.config().subscriptions[0].url,json);assert.equal(f.store.config().liveSources[0].url,m3u);
  assert.equal(f.played.length,2);assert.ok(f.played.every(row=>row.url.startsWith('https://tv.example/')));
  assert.ok(result.candidates.filter(row=>row.added).every(row=>['vod','live'].includes(row.kind)));assert.equal(f.updates,1);
  await f.service.stop();
});

test('Bing RSS finds direct GitHub blobs and one-hop HTML subscription links without scripts or recursive navigation',async()=>{
  const blob='https://github.com/OutsideUser/Independent/blob/main/public.json',raw='https://raw.githubusercontent.com/OutsideUser/Independent/main/public.json';
  const page='https://directory.example/links.html',second='https://directory.example/another.html';
  const a='https://config.example/a.json?part=1&token=public',b='https://config.example/b.json',tv='https://tv.example/web.m3u';
  const f=fixture({rssVod:[[blob],[page],[second]],files:new Map([[raw,payload()],[page,'<script>const x="<a href=\'https://config.example/script.json\'>"</script><a href="'+a.replaceAll('&','&amp;')+'">配置</a><a href="'+tv+'">电视</a><a href="/nested.html">递归页</a><a href="http://127.0.0.1/private.json">无效</a>'],[second,'<a href="'+b+'">备用</a>'],[a,payload()],[b,payload()],[tv,playlist]])});
  await f.service.discover();
  assert.equal(f.store.config().subscriptions.length+f.store.config().liveSources.length,4);
  assert.ok(f.seen.includes(raw)&&f.seen.includes(a)&&f.seen.includes(tv));
  assert.ok(!f.seen.some(url=>/script\.json|nested\.html|127\.0\.0\.1/.test(url)));
  assert.ok(f.maxActive<=2);assert.ok(f.seen.length<=24);await f.service.stop();
});

test('general GitHub repository search validates metadata and uses the actual default branch',async()=>{
  const json='https://raw.githubusercontent.com/Independent/FilmConfig/master/config.json',m3u='https://raw.githubusercontent.com/Independent/PublicTV/main/index.m3u';
  const f=fixture({searchVod:[repo('Independent/FilmConfig',{fork:false,default_branch:'master'}),repo('Unsafe/Repo',{default_branch:'../private'})],searchTv:[repo('Independent/PublicTV',{fork:false})],files:new Map([[json,payload()],[m3u,playlist]])});
  await f.service.discover();assert.ok(f.store.config().subscriptions.some(row=>row.url===json));assert.ok(f.store.config().liveSources.some(row=>row.url===m3u));
  assert.ok(!f.seen.some(url=>url.includes('/Unsafe/')));await f.service.stop();
});

test('format repair supports simple address presentation and API aliases before the same validation boundary',async()=>{
  const url='https://config.example/repaired.json';
  const f=fixture({curated:{subscriptions:[{name:'修复配置',url:'config.example/repaired.json'}],liveSources:[]},files:new Map([[url,{api_site:{simple:'catalog.example/api.php/provide/vod',alias:{name:'地址别名',url:'https://catalog.example/another'}}}]])});
  const result=await f.service.discover();assert.equal(f.store.config().subscriptions[0].url,url);
  assert.equal(f.verified[0].api,'https://catalog.example/api.php/provide/vod');assert.ok(result.candidates.find(row=>row.url===url).warnings.length);
  await f.service.stop();
});

test('an existing GitHub blob presentation matches its repaired raw URL without being duplicated or reactivated',async()=>{
  const raw='https://raw.githubusercontent.com/ExistingUser/Config/main/public.json',blob='https://github.com/ExistingUser/Config/blob/main/public.json';
  const store=memoryStore({...empty,subscriptions:[{id:'manual',name:'用户停用',url:blob,enabled:false}]});
  const f=fixture({store,curated:{subscriptions:[{name:'同一公开地址',url:raw}],liveSources:[]},files:new Map([[raw,payload()]])});
  const result=await f.service.discover();assert.equal(store.config().subscriptions.length,1);assert.equal(store.config().subscriptions[0].enabled,false);
  assert.equal(result.candidates.find(row=>row.url===raw).status,'disabled');assert.ok(!f.seen.includes(raw));await f.service.stop();
});

test('private, authenticated, reserved and malformed raw configurations never enter verification or subscriptions',async t=>{
  for(const body of [payload('http://127.0.0.1/private'),payload('https://user:password@catalog.example/api'),'{bad-json',
    '{"api_site":{"__proto__":{"name":"无效标识","api":"https://catalog.example/api"}}}'])await t.test(String(body).slice(0,40),async()=>{
    const f=fixture({forks:[repo('ResearchUser/PublicConfig')],files:new Map([[forkUrl,body]])});
    const result=await f.service.discover();assert.equal(f.store.config().subscriptions.length,0);assert.equal(f.verified.length,0);
    assert.equal(result.candidates.find(row=>row.url===forkUrl).status,'error');await f.service.stop();
  });
});

test('failed or mismatched API validation and unplayable TV segments prevent automatic import',async()=>{
  const json='https://config.example/unverified.json',tv='https://tv.example/unverified.m3u';
  const f=fixture({curated:{subscriptions:[{name:'未验证',url:json}],liveSources:[{name:'不可播放',url:tv}]},files:new Map([[json,payload()],[tv,playlist]]),verify:source=>({api:source.api+'/different',status:'ok'}),play:()=>({playable:false,error:'分片不可访问'})});
  await f.service.discover();assert.equal(f.store.config().subscriptions.length,0);assert.equal(f.store.config().liveSources.length,0);assert.equal(f.updates,0);await f.service.stop();
});

test('duplicates and household capacity limits prevent more than four new rows or twenty subscriptions per kind',async()=>{
  const initial={...empty,subscriptions:Array.from({length:18},(_,i)=>({id:'vod-'+i,name:'现有订阅',url:'https://existing.example/'+i+'.json',enabled:true})),liveSources:Array.from({length:18},(_,i)=>({id:'tv-'+i,name:'现有电视',url:'https://existing.example/'+i+'.m3u',enabled:true}))};
  const subscriptions=Array.from({length:5},(_,i)=>({name:'发现影视',url:'https://config.example/'+i+'.json'}));
  const liveSources=Array.from({length:5},(_,i)=>({name:'发现电视',url:'https://tv.example/'+i+'.m3u'}));
  const files=new Map([...subscriptions.map(row=>[row.url,payload()]),...liveSources.map(row=>[row.url,playlist])]);
  const f=fixture({store:memoryStore(initial),curated:{subscriptions:[...subscriptions,subscriptions[0]],liveSources},files});
  const result=await f.service.discover();assert.equal(f.store.config().subscriptions.length,20);assert.equal(f.store.config().liveSources.length,20);
  assert.equal(result.candidates.filter(row=>row.added).length,4);assert.equal(f.seen.filter(url=>url===subscriptions[0].url).length,1);assert.equal(f.verified.length,1);await f.service.stop();
});

test('deleted, disabled and URL-edited managed subscriptions remain tombstoned after discovery restart',async()=>{
  const json='https://config.example/managed.json',tv='https://tv.example/managed.m3u',store=memoryStore();
  const options={store,curated:{subscriptions:[{name:'管理影视',url:json}],liveSources:[{name:'管理电视',url:tv}]},files:new Map([[json,payload()],[tv,playlist]])};
  const first=fixture(options);await first.service.discover();await first.service.stop();
  store.setConfig({...store.config(),subscriptions:[{...store.config().subscriptions[0],url:'https://user.example/changed.json'}],liveSources:store.config().liveSources.map(row=>({...row,enabled:false}))});
  const next=fixture(options);await next.service.discover();assert.equal(store.config().subscriptions.length,1);assert.equal(store.config().subscriptions[0].url,'https://user.example/changed.json');assert.equal(store.config().liveSources[0].enabled,false);
  assert.ok(!next.seen.includes(json)&&!next.seen.includes(tv));await next.service.stop();
  store.setConfig({...store.config(),subscriptions:[],liveSources:[]});
  const deleted=fixture(options);await deleted.service.discover();assert.equal(store.config().subscriptions.length+store.config().liveSources.length,0);assert.ok(!deleted.seen.includes(json)&&!deleted.seen.includes(tv));await deleted.service.stop();
});

test('before-write configuration races preserve household edits and do not recreate newly disabled URLs',async t=>{
  for(const disabled of [false,true])await t.test(disabled?'user disabled':'unrelated edit',async()=>{
    const entered=deferred(),release=deferred(),url='https://config.example/race.json';
    const f=fixture({curated:{subscriptions:[{name:'竞态配置',url}],liveSources:[]},files:new Map([[url,payload()]]),verify:async source=>{entered.resolve();await release.promise;return{api:source.api,status:'ok',playable:true};}});
    const pending=f.service.discover();await entered.promise;
    f.store.setConfig({...f.store.config(),showAdult:true,platforms:[{id:'household',name:'家庭自定义',url:'https://platform.example/',category:'video',enabled:true}],...(disabled?{subscriptions:[{id:'manual',name:'手动停用',url,enabled:false}]}:{})});release.resolve();
    await pending;assert.equal(f.store.config().showAdult,true);assert.equal(f.store.config().platforms[0].id,'household');assert.equal(f.store.config().subscriptions.length,1);
    assert.equal(f.store.config().subscriptions[0].enabled,!disabled);await f.service.stop();
  });
});

test('the configured VOD and TV baseline is registered before provider fetches so deletion during discovery stays deleted',async()=>{
  const entered=deferred(),release=deferred(),tv='https://tv.example/baseline.m3u';
  const store=memoryStore({...empty,subscriptions:[{id:'existing-vod',name:'既有影视',url:forkUrl,enabled:true}],liveSources:[{id:'existing-tv',name:'既有电视',url:tv,enabled:true}]});
  const f=fixture({store,forks:[repo('ResearchUser/PublicConfig')],files:new Map([[forkUrl,payload()],[tv,playlist]]),override:async url=>{
    if(url===directory){entered.resolve();await release.promise;return response({subscriptions:[],liveSources:[{name:'发现电视',url:tv}]},200,url);}
  }});
  const pending=f.service.discover();await entered.promise;store.setConfig({...store.config(),subscriptions:[],liveSources:[]});release.resolve();await pending;
  assert.equal(store.config().subscriptions.length+store.config().liveSources.length,0);
  assert.ok(!f.seen.includes(forkUrl)&&!f.seen.includes(tv));await f.service.stop();
});

test('public provider rate limits and CAPTCHA failures preserve configured sources and expose bounded status',async()=>{
  const initial={...empty,sources:[{id:'kept',name:'保留源',api:'https://catalog.example/kept',enabled:true}],subscriptions:[{id:'kept',name:'保留订阅',url:'https://kept.example/config.json',enabled:true}]};
  const f=fixture({store:memoryStore(initial),override:async url=>url.includes('api.github.com')?response('rate limited',429,url):url.includes('bing.com')?response('<html>captcha</html>',200,url):undefined});
  const result=await f.service.discover();assert.deepEqual(f.store.config(),initial);assert.ok(result.candidates.filter(row=>row.kind==='provider'&&row.status==='error').length>=4);assert.ok(result.candidates.length<=20);await f.service.stop();
});

test('unsafe RSS declarations and malformed GitHub metadata cannot create or fetch discovered addresses',async()=>{
  const unsafe=repo('Unsafe/Repo',{default_branch:'branch/unsafe'}),archived=repo('Archived/Repo',{archived:true});
  const f=fixture({forks:[unsafe,archived,repo('../private'),repo('NotFork/Repo',{fork:false})],override:async url=>url.includes('bing.com')?response('<!DOCTYPE rss [<!ENTITY x SYSTEM "http://127.0.0.1/secret">]><rss><channel/></rss>',200,url):undefined});
  await f.service.discover();assert.ok(!f.seen.some(url=>/127\.0\.0\.1|\/Unsafe\/|\/Archived\/|\/NotFork\//.test(url)));assert.equal(f.store.config().subscriptions.length,0);await f.service.stop();
});

test('persisted discovery cursor reaches later usable candidates after a failed prefix and restart',async()=>{
  const store=memoryStore();
  const subscriptions=Array.from({length:20},(_,index)=>({name:'长期失效配置'+index,url:'https://config.example/dead-'+index+'.json'}));
  const options={store,curated:{subscriptions,liveSources:[]},forks:[repo('ResearchUser/PublicConfig')],files:new Map([[forkUrl,payload()]])};
  let f=fixture(options);
  const first=await f.service.discover();
  assert.equal(store.config().subscriptions.length,0);assert.ok(!f.seen.includes(forkUrl));
  assert.ok(JSON.parse(store.meta('source-discovery-v1')).discoveryCursor>0);
  assert.ok(first.candidates.length<=20);assert.ok(f.seen.length<=24);await f.service.stop();
  f=fixture(options);
  const second=await f.service.discover();
  assert.ok(f.seen.includes(forkUrl));assert.equal(store.config().subscriptions[0].url,forkUrl);
  assert.ok(second.candidates.some(row=>row.url===forkUrl&&row.added));
  assert.ok(second.candidates.length<=20);assert.ok(f.seen.length<=24);assert.ok(f.maxActive<=2);await f.service.stop();
});

test('discovery bounds every cycle to twenty-four fetches and two simultaneous HTTP requests',async()=>{
  const subscriptions=Array.from({length:20},(_,i)=>({name:'边界配置'+i,url:'https://config.example/budget-'+i+'.json'}));
  const f=fixture({curated:{subscriptions,liveSources:[]},files:new Map(subscriptions.map(row=>[row.url,payload()])),verify:source=>({api:source.api,status:'error'})});
  const result=await f.service.discover();assert.equal(f.seen.length,24);assert.ok(f.maxActive<=2);assert.ok(result.candidates.some(row=>/次数已达到上限/.test(row.error||'')));assert.equal(f.store.config().subscriptions.length,0);await f.service.stop();
});

test('eight-second deadlines cover response headers and the complete provider response body',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const hung=Object.assign(new Readable({read(){}}),{statusCode:200,headers:{}});
  const f=fixture({override:async url=>{
    if(url.includes('/repos/Stardm0/MoonTV/forks'))return new Promise(()=>{});
    if(url.includes('/repos/katelya77/KatelyaTV/forks'))return hung;
  }});
  const pending=f.service.discover();for(let i=0;i<4;i++)await new Promise(done=>setImmediate(done));
  t.mock.timers.tick(8000);for(let i=0;i<20;i++)await new Promise(done=>setImmediate(done));
  const result=await pending;assert.equal(hung.destroyed,true);assert.equal(result.candidates.filter(row=>row.kind==='provider'&&/超时/.test(row.error||'')).length,2);await f.service.stop();
});

test('JSON, RSS and one-hop HTML response limits reject oversized bodies before import',async()=>{
  const url='https://config.example/oversized.json',page='https://directory.example/oversized.html';
  const f=fixture({curated:{subscriptions:[{name:'过大配置',url}],liveSources:[]},rssTv:[[page]],files:new Map([[url,'x'.repeat(1024*1024+1)],[page,'x'.repeat(256*1024+1)]]),override:async value=>{
    if(value.includes('bing.com')&&!new URL(value).searchParams.get('q').includes('IPTV'))return response('x'.repeat(512*1024+1),200,value);
  }});
  const result=await f.service.discover();assert.equal(f.store.config().subscriptions.length,0);assert.equal(f.verified.length,0);
  assert.equal(result.candidates.filter(row=>/过大/.test(row.error||'')).length,3);await f.service.stop();
});

test('known healthy identical APIs can back a new subscription without redundant API requests',async()=>{
  const store=memoryStore({...empty,sources:[{id:'kept',name:'已验证影视',api:'https://catalog.example/api.php/provide/vod',enabled:true}]}),url='https://config.example/backup.json';
  const f=fixture({store,curated:{subscriptions:[{name:'备用公开配置',url}],liveSources:[]},files:new Map([[url,payload()]])});
  f.maintenance.status=()=>({sources:[{api:'https://catalog.example/api.php/provide/vod',status:'ok',playable:true,checkedAt:1000}]});
  await f.service.discover();assert.equal(f.verified.length,0);assert.equal(store.config().subscriptions.length,1);await f.service.stop();
});

test('stop waits for the two active provider requests and prevents queued or candidate requests',async()=>{
  const wait=deferred();const f=fixture({override:async url=>{await wait.promise;return response('stopped',503,url);}});
  const pending=f.service.discover();await new Promise(done=>setImmediate(done));
  let stopped=false;const stopping=f.service.stop().then(()=>{stopped=true;});await Promise.resolve();assert.equal(stopped,false);wait.resolve();
  await stopping;await pending;assert.equal(f.seen.length,2);assert.equal(f.updates,0);assert.equal(f.store.config().subscriptions.length,0);assert.equal(f.service.status().running,false);
});

test('startup and fifteen-minute scheduling are idempotent, persist status and leave no timer after stopping',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000});const store=memoryStore(),f=fixture({store,now:Date.now});
  const flush=async()=>{for(let i=0;i<25;i++)await new Promise(done=>setImmediate(done));};
  assert.equal(f.seen.length,0);f.service.start();f.service.start();t.mock.timers.tick(0);await flush();
  const first=f.seen.length;assert.ok(first>0);assert.equal(f.service.status().lastDiscovery,1000);
  t.mock.timers.tick(15*60_000);await flush();const second=f.seen.length;assert.ok(second>first&&second<first*2);await f.service.stop();
  t.mock.timers.tick(60*60_000);await flush();assert.equal(f.seen.length,second);
  const restarted=fixture({store,now:Date.now});assert.equal(restarted.service.status().lastDiscovery,901000);restarted.service.start();t.mock.timers.tick(0);await flush();assert.ok(restarted.seen.length>0);await restarted.service.stop();
});

test('actual SQLite discovery status and deleted-subscription tombstones persist across reopening',async()=>{
  const directoryPath=await mkdtemp(join(tmpdir(),'vipvideo-discovery-'));let store,service;
  try{
    store=createStore(directoryPath,empty);const options={curated:{subscriptions:[{name:'公开配置',url:forkUrl}],liveSources:[]},files:new Map([[forkUrl,payload()]])};
    let f=fixture({...options,store});service=f.service;await service.discover();await service.stop();store.setConfig({...store.config(),subscriptions:[]});store.close();
    store=createStore(directoryPath,empty);f=fixture({...options,store});service=f.service;assert.equal(service.status().lastDiscovery,1000);await service.discover();assert.equal(store.config().subscriptions.length,0);assert.ok(!f.seen.includes(forkUrl));
  }finally{await service?.stop();store?.close();const target=resolve(directoryPath),root=resolve(tmpdir());assert.ok(target.startsWith(root+sep)&&target.split(sep).at(-1).startsWith('vipvideo-discovery-'));await rm(target,{recursive:true,force:true});}
});

test('GitHub quota errors honor Retry-After across restart without blocking other public providers',async()=>{
  let clock=1000;const store=memoryStore(),raw='https://feeds.example/working.json';
  const options={store,now:()=>clock,curated:{subscriptions:[{name:'独立配置',url:raw}],liveSources:[]},files:new Map([[raw,payload()]]),override:url=>{
    if(new URL(url).hostname==='api.github.com')return Object.assign(response({message:'API rate limit exceeded'},403,url),{headers:{'x-ratelimit-remaining':'0','x-ratelimit-reset':'10','retry-after':'120'}});
  }};
  const first=fixture(options),result=await first.service.discover();
  assert.equal(store.config().subscriptions.length,1);assert.ok(first.seen.filter(url=>new URL(url).hostname==='api.github.com').length<=2);
  const errors=result.candidates.filter(row=>row.kind==='provider'&&row.reason==='rate_limit');assert.ok(errors.length>=1);assert.ok(errors.every(row=>row.httpStatus===403&&row.retryAt===121000));
  await first.service.stop();const restarted=fixture({...options,override:undefined});await restarted.service.discover();
  assert.equal(restarted.seen.filter(url=>new URL(url).hostname==='api.github.com').length,0);
  clock=121001;await restarted.service.discover();assert.ok(restarted.seen.some(url=>new URL(url).hostname==='api.github.com'));await restarted.service.stop();
});

test('ordinary 403 and raw 404 remain distinct and failed raw URLs are not fetched every fifteen minutes',async()=>{
  let clock=1000;const store=memoryStore(),raw='https://feeds.example/missing.json';
  const options={store,now:()=>clock,curated:{subscriptions:[{name:'公开路径',url:raw}],liveSources:[]},override:url=>new URL(url).hostname==='api.github.com'?response('Access denied',403,url):undefined};
  const f=fixture(options),result=await f.service.discover();
  assert.ok(result.candidates.some(row=>row.kind==='provider'&&row.reason==='forbidden'&&row.httpStatus===403));
  const failed=result.candidates.find(row=>row.url===raw);assert.equal(failed.reason,'not_found');assert.equal(failed.retryAt,1000+6*60*60_000);
  const calls=f.seen.filter(url=>url===raw).length;clock+=15*60_000;await f.service.discover();assert.equal(f.seen.filter(url=>url===raw).length,calls);await f.service.stop();
  const restarted=fixture(options);await restarted.service.discover();assert.equal(restarted.seen.filter(url=>url===raw).length,0);await restarted.service.stop();
});

test('a missing guessed GitHub path uses public default-branch metadata and an explicit config file then preserves deletion',async()=>{
  const store=memoryStore(),fixed='https://raw.githubusercontent.com/ResearchUser/PublicConfig/develop/configs/sources.json';
  const base='https://api.github.com/repos/ResearchUser/PublicConfig';
  const options={store,curated:{subscriptions:[{name:'公开配置',url:forkUrl}],liveSources:[]},files:new Map([[fixed,payload()]]),override:url=>{
    if(url===base)return response(repo('ResearchUser/PublicConfig',{default_branch:'develop',fork:false}),200,url);
    if(url===base+'/contents?ref=develop')return response([{type:'file',path:'config.example.json',name:'config.example.json'},{type:'dir',path:'configs'}],200,url);
    if(url===base+'/contents/configs?ref=develop')return response([{type:'file',path:'configs/sources.json',name:'sources.json',download_url:'https://untrusted.example/wrong.json'}],200,url);
  }};
  const f=fixture(options),result=await f.service.discover();
  assert.equal(store.config().subscriptions.length,1);assert.equal(store.config().subscriptions[0].url,fixed);
  assert.ok(result.candidates.some(row=>row.url===fixed&&row.added));assert.equal(f.seen.some(url=>url.includes('untrusted.example')),false);
  const calls=f.seen.length;await f.service.discover();assert.equal(f.seen.slice(calls).includes(forkUrl),false);assert.equal(f.seen.slice(calls).includes(fixed),false);await f.service.stop();
  store.setConfig({...store.config(),subscriptions:[]});const restarted=fixture(options);await restarted.service.discover();
  assert.equal(store.config().subscriptions.length,0);assert.equal(restarted.seen.includes(fixed),false);assert.equal(restarted.verified.length,0);await restarted.service.stop();
});

test('source discovery requires positive media evidence and bounds new validations to twenty without skipping pending APIs',async()=>{
  for(const playable of[undefined,false]){
    const raw='https://feeds.example/no-media.json',f=fixture({curated:{subscriptions:[{name:'仅接口',url:raw}],liveSources:[]},files:new Map([[raw,payload()]]),verify:source=>({api:source.api,status:'ok',playable})});
    await f.service.discover();assert.equal(f.store.config().subscriptions.length,0);await f.service.stop();
  }
  const subscriptions=Array.from({length:10},(_,i)=>({name:'公开配置'+i,url:'https://feeds.example/'+i+'.json'}));
  const files=new Map(subscriptions.map((row,i)=>[row.url,{api_site:Object.fromEntries(Array.from({length:3},(_,j)=>['s'+j,{name:'接口'+j,api:'https://api.example/'+i+'-'+j}]))}]));
  const f=fixture({curated:{subscriptions,liveSources:[]},files,verify:source=>({api:source.api,status:'error',playable:false})});await f.service.discover();
  assert.equal(f.verified.length,20);assert.ok(f.seen.length<=24);
  const saved=JSON.parse(f.store.metadata.get('source-discovery-v1'));assert.ok(Object.values(saved.sourceCursor).some(value=>value===0));await f.service.stop();
});

test('large background subscriptions retain a page until its actual checks finish and continue after restart',async()=>{
  const raw='https://feeds.example/large.json',store=memoryStore();
  const body={api_site:Object.fromEntries(Array.from({length:201},(_,i)=>['s'+i,{name:'接口'+i,api:'https://api.example/'+i}]))};
  store.setMeta('source-discovery-v1',JSON.stringify({sourceCursor:{[raw]:198}}));
  const options={store,curated:{subscriptions:[{name:'大型配置',url:raw}],liveSources:[]},files:new Map([[raw,body]]),verify:source=>({api:source.api,status:'error',playable:false})};
  const first=fixture(options);await first.service.discover();assert.deepEqual(first.verified.map(row=>row.id),['s198','s199']);assert.equal(JSON.parse(store.meta('source-discovery-v1')).sourceCursor[raw],200);await first.service.stop();
  const second=fixture({...options,verify:source=>({api:source.api,status:'ok',playable:true})});await second.service.discover();assert.deepEqual(second.verified.map(row=>row.id),['s200']);assert.equal(store.config().subscriptions.length,1);await second.service.stop();
});

test('background windows support bounded JSONC object and array formats without relaxing manual imports or URL validation',()=>{
  const rows=Array.from({length:201},(_,i)=>({id:'s'+i,key:'s'+i,name:'接口'+i,api:'https://api.example/'+i,type:1}));
  for(const[field,value]of[['api_site',Object.fromEntries(rows.map(row=>[row.id,row]))],['api_site',rows],['sites',rows],['sources',rows]]){
    const body={ [field]:value,platforms:[{url:'http://127.0.0.1/private'}],parsers:[{url:'file:///bad'}] };
    const first=subscriptionWindow('//公开订阅\n'+JSON.stringify(body),0);assert.equal(first.total,201);assert.equal(first.nextCursor,200);assert.equal(importConfig(empty,first.config).sources.length,200);
    const last=subscriptionWindow(body,first.nextCursor);assert.equal(importConfig(empty,last.config).sources.length,1);assert.equal(last.nextCursor,0);
    assert.equal(first.config.platforms?.length||0,0);assert.equal(first.config.parsers?.length||0,0);assert.throws(()=>repairImport({[field]:value}),/200/);
  }
  assert.throws(()=>subscriptionWindow({sources:Array.from({length:2001},(_,i)=>({...rows[0],id:'s'+i}))}),/2000/);
  assert.throws(()=>subscriptionWindow({sources:[...rows,{...rows[0]}]}),/重复/);
  const bad={api_site:{safe:{name:'普通',api:'http://127.0.0.1/private'}}};assert.throws(()=>subscriptionWindow(bad),/内网|公网|不允许|公共/);
});

const DAY=24*60*60_000;
const hardResult=(row,checkedAt,reason='not_found')=>({...row,status:'error',reason,checkedAt,...(reason==='not_found'?{httpStatus:404}:{})});

test('only an untouched automatic subscription retires after three real hard failures spanning seven days',async()=>{
  let clock=1000;const url='https://feeds.example/lifecycle.json',f=fixture({now:()=>clock,curated:{subscriptions:[{name:'可信自动订阅',url}],liveSources:[]},files:new Map([[url,payload()]])});
  await f.service.discover();const row=f.store.config().subscriptions[0];assert.ok(row);assert.equal(f.service.status().retiredCount,0);
  clock=1001;f.emitSubscription(hardResult(row,clock));f.emitSubscription(hardResult(row,clock));
  assert.equal(JSON.parse(f.store.meta('source-discovery-v1')).managed[url].hardFailures,1);
  clock+=3*DAY;f.emitSubscription(hardResult(row,clock,'invalid'));assert.equal(f.store.config().subscriptions.length,1);
  clock=1001+7*DAY;f.emitSubscription(hardResult(row,clock));assert.equal(f.store.config().subscriptions.length,0);
  const status=f.service.status();assert.equal(status.retiredCount,1);assert.equal(status.retired[0].id,row.id);assert.equal(status.retired[0].name,row.name);assert.equal(status.retired[0].retryAt,clock+DAY);assert.match(status.retired[0].reason,/404.*7/);
  assert.equal(JSON.parse(f.store.meta('source-discovery-v1')).managed[url].blocked,false);await f.service.stop();
});

test('short-lived 404s and success reset the hard chain instead of deleting an automatic subscription',async()=>{
  let clock=1000;const url='https://feeds.example/temporary.json',f=fixture({now:()=>clock,curated:{subscriptions:[{name:'短暂失效',url}],liveSources:[]},files:new Map([[url,payload()]])});await f.service.discover();const row=f.store.config().subscriptions[0];
  for(const day of[0,2,6]){clock=1001+day*DAY;f.emitSubscription(hardResult(row,clock));}assert.equal(f.service.status().retiredCount,0);assert.equal(f.store.config().subscriptions.length,1);
  clock++;f.emitSubscription({...row,status:'ok',checkedAt:clock});assert.equal(JSON.parse(f.store.meta('source-discovery-v1')).managed[url].hardFailures,0);
  clock=1001+10*DAY;f.emitSubscription(hardResult(row,clock));assert.equal(f.store.config().subscriptions.length,1);assert.equal(JSON.parse(f.store.meta('source-discovery-v1')).managed[url].firstHardFailureAt,clock);await f.service.stop();
});

test('network errors, forbidden responses and quota limits cannot count as subscription hard retirement',async()=>{
  let clock=1000;const url='https://feeds.example/network.json',f=fixture({now:()=>clock,curated:{subscriptions:[{name:'临时网络',url}],liveSources:[]},files:new Map([[url,payload()]])});await f.service.discover();const row=f.store.config().subscriptions[0];
  for(const [reason,httpStatus]of[['network',503],['forbidden',403],['rate_limit',429],['invalid',403]]){
    clock++;f.emitSubscription(hardResult(row,clock));clock+=DAY;f.emitSubscription(hardResult(row,clock));clock+=7*DAY;f.emitSubscription({...row,status:'error',reason,httpStatus,checkedAt:clock});
    assert.equal(f.store.config().subscriptions.length,1);assert.equal(f.service.status().retiredCount,0);assert.equal(JSON.parse(f.store.meta('source-discovery-v1')).managed[url].hardFailures,0);
  }
  await f.service.stop();
});

test('handwritten, renamed, disabled, edited and user-deleted subscriptions are never retired or automatically recreated',async t=>{
  for(const change of['handwritten','rename','disable','url','delete'])await t.test(change,async()=>{
    let clock=1000;const url='https://feeds.example/'+change+'.json',store=memoryStore(change==='handwritten'?{...empty,subscriptions:[{id:'manual',name:'我的订阅',url,enabled:true}]}:empty);
    const options={store,now:()=>clock,curated:{subscriptions:[{name:'自动候选',url}],liveSources:[]},files:new Map([[url,payload()]])};const f=fixture(options);await f.service.discover();const original=structuredClone(store.config().subscriptions[0]);
    const next=change==='rename'?{...original,name:'我改过名称'}:change==='disable'?{...original,enabled:false}:change==='url'?{...original,url:'https://other.example/manual.json'}:original;
    store.setConfig({...store.config(),subscriptions:change==='delete'?[]:[next]});
    for(const day of[0,3,7]){clock=1001+day*DAY;f.emitSubscription(hardResult(original,clock));}
    assert.deepEqual(store.config().subscriptions,change==='delete'?[]:[next]);assert.equal(f.service.status().retiredCount,0);await f.service.stop();
    const restarted=fixture(options);await restarted.service.discover();assert.deepEqual(store.config().subscriptions,change==='delete'?[]:[next]);assert.equal(restarted.verified.length,0);await restarted.service.stop();
  });
});

test('retired subscriptions persist across restart and require actual media proof before restoration',async()=>{
  let clock=1000;const url='https://feeds.example/recover.json',store=memoryStore(),options={store,now:()=>clock,curated:{subscriptions:[{name:'恢复候选',url}],liveSources:[]},files:new Map([[url,payload()]])};
  const f=fixture(options);await f.service.discover();const original=store.config().subscriptions[0];for(const day of[0,3,7]){clock=1001+day*DAY;f.emitSubscription(hardResult(original,clock));}await f.service.stop();
  let playable=false;const restarted=fixture({...options,curated:{subscriptions:[],liveSources:[]},verify:source=>({api:source.api,status:'ok',playable})});assert.equal(restarted.service.status().retiredCount,1);
  const calls=restarted.seen.length;await restarted.service.discover();assert.equal(restarted.seen.slice(calls).includes(url),false);assert.equal(store.config().subscriptions.length,0);
  clock+=DAY+1;await restarted.service.discover();assert.equal(store.config().subscriptions.length,0);assert.equal(restarted.service.status().retiredCount,1);assert.equal(restarted.verified.length,1);
  playable=true;clock+=DAY+1;await restarted.service.discover();assert.deepEqual(store.config().subscriptions,[original]);assert.equal(restarted.service.status().retiredCount,0);assert.equal(JSON.parse(store.meta('source-discovery-v1')).managed[url].hardFailures,0);await restarted.service.stop();
});

test('manual maintenance updates publish typed failures and drive automatic retirement without a new discovery run',async()=>{
  let clock=1000,failed=false,f;const url='https://feeds.example/controller.json',store=memoryStore();
  const maintenance=createSourceMaintenance({store,now:()=>clock,request:async(input,options)=>new URL(input).hostname==='catalog.example'?response({code:1,list:[{vod_id:1,vod_name:'普通样例'}]}):f.request(input,options),catalog:{detail:async()=>({lines:[{episodes:[{url:'https://media.example/sample.mp4',type:'mp4'}]}]})},playability:{check:async()=>({playable:true})},logger:{error:()=>{}}});
  f=fixture({store,maintenance,now:()=>clock,curated:{subscriptions:[{name:'真实维护连接',url}],liveSources:[]},files:new Map([[url,payload()]]),override:address=>failed&&address===url?response('missing',404,address):undefined});
  await f.service.discover();assert.equal(store.config().subscriptions.length,1);failed=true;
  for(const day of[0,3,7]){clock=1001+day*DAY;await maintenance.update();}assert.equal(store.config().subscriptions.length,0);assert.equal(f.service.status().retiredCount,1);
  await f.service.stop();await maintenance.stop();
});

test('automatic TV subscriptions also retire on a persistent missing playlist and restore only playable lists',async()=>{
  let clock=1000,missing=false;const url='https://feeds.example/live-list.m3u',f=fixture({now:()=>clock,curated:{subscriptions:[],liveSources:[{name:'自动电视',url}]},files:new Map([[url,playlist]]),override:address=>missing&&address===url?response('missing',404,address):undefined});
  await f.service.discover();const row=structuredClone(f.store.config().liveSources[0]);missing=true;
  for(const day of[0,3,7]){clock=1001+day*DAY;await f.service.discover();}assert.equal(f.store.config().liveSources.length,0);assert.equal(f.service.status().retiredCount,1);assert.equal(f.service.status().retired[0].kind,'live');
  missing=false;clock+=DAY+1;await f.service.discover();assert.deepEqual(f.store.config().liveSources,[row]);assert.equal(f.service.status().retiredCount,0);await f.service.stop();
});

test('low-load automatic discovery uses one worker and a smaller budget while manual discovery retains its full budget',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000});const subscriptions=Array.from({length:10},(_,i)=>({name:'低负载候选'+i,url:'https://feeds.example/low-'+i+'.json'}));
  const options={backgroundMode:'low',now:Date.now,curated:{subscriptions,liveSources:[]},files:new Map(subscriptions.map((row,i)=>[row.url,{api_site:Object.fromEntries(Array.from({length:3},(_,j)=>['s'+j,{name:'接口',api:'https://api.example/'+i+'-'+j}]))}])),verify:source=>({api:source.api,status:'error',playable:false})};
  const automatic=fixture(options);automatic.service.start();t.mock.timers.tick(0);for(let i=0;i<80;i++)await new Promise(done=>setImmediate(done));
  assert.equal(automatic.service.status().intervalMinutes,60);assert.equal(automatic.service.status().backgroundMode,'low');assert.equal(automatic.maxActive,1);assert.ok(automatic.seen.length<=12);assert.ok(automatic.verified.length<=6);
  const calls=automatic.seen.length;t.mock.timers.tick(59*60_000);for(let i=0;i<10;i++)await new Promise(done=>setImmediate(done));assert.equal(automatic.seen.length,calls);
  await automatic.service.stop();assert.equal(automatic.listeners,0);
  const manual=fixture(options);await manual.service.discover();assert.equal(manual.maxActive,2);assert.equal(manual.verified.length,20);assert.ok(manual.seen.length<=24);await manual.service.stop();
});
