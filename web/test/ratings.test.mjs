import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createRatings } from '../lib/ratings.mjs';
import { createStore } from '../lib/store.mjs';

const ORIGIN = 'https://movie.douban.com';
function memoryStore() {
  const values = new Map();
  return { values, meta:key=>values.get(key), setMeta:(key,value)=>values.set(key,value) };
}
function response(body, statusCode=200, finalUrl) {
  return Object.assign(Readable.from([Buffer.from(body)]), { statusCode, finalUrl, headers:{} });
}
function film(overrides={}) {
  return {title:'海风来信',year:'2024',type:'movie',category:'movie',douban:{id:'123456'},...overrides};
}
function page(overrides={}) {
  return `<html><script type="application/ld+json">${JSON.stringify({ '@context':'https://schema.org', '@type':'Movie',name:'海风来信',datePublished:'2024-06-01',url:'/subject/123456/',aggregateRating:{ratingValue:'8.2',ratingCount:'321',bestRating:10},...overrides })}</script></html>`;
}
function fallbackRequest(subjectBody, subjects=[]) {
  return async url=>new URL(url).pathname.startsWith('/subject/') ? response(subjectBody) : response(JSON.stringify({subjects}));
}

test('source supplied Douban scores need no credentials or outbound requests', async () => {
  const store=memoryStore();let calls=0;
  const ratings=createRatings({store,request:async()=>{calls++;throw new Error('unexpected request');}});
  assert.deepEqual(Object.keys(ratings),['get']);
  const result=await ratings.get(film({douban:{id:'123456',score:'8.6',votes:'42'}}));
  assert.deepEqual(result,{douban:{score:8.6,votes:42,url:ORIGIN+'/subject/123456/',attribution:'豆瓣评分（影视源提供，未独立验证）'},tmdb:null,errors:[],configured:true});
  assert.equal(calls,0);assert.equal(store.values.has('config'),false);
});

test('zero, invalid and generic source scores never become fabricated Douban ratings', async () => {
  let calls=0;const ratings=createRatings({store:memoryStore(),request:async()=>{calls++;throw new Error('unexpected request');}});
  for(const score of [0,'0.0',-1,11,Infinity,NaN,true,[],{},'']) {
    const result=await ratings.get(film({douban:{score},vod_score:9.9}));
    assert.equal(result.douban,null,String(score));
  }
  assert.equal((await ratings.get(film({douban:undefined,vod_score:9.9}))).douban,null);
  assert.equal(calls,0);
});

test('JSON-LD verifies full title, year, media type and official subject URL', async () => {
  let options;
  const ratings=createRatings({store:memoryStore(),request:async(url,value)=>{options=value;return response(page(),200,url);}});
  const result=await ratings.get(film());
  assert.equal(result.douban.score,8.2);assert.equal(result.douban.votes,321);
  assert.equal(result.douban.attribution,'豆瓣公开条目');assert.deepEqual(result.errors,[]);
  assert.deepEqual(options,{timeout:8000});
});

test('JSON-LD supports a graph, bilingual names and TVSeries without confusing film and series', async () => {
  const data={'@graph':[{'@type':'WebPage'}, {'@type':'TVSeries',name:'海风来信 Sea Breeze',datePublished:'2024-01-01',aggregateRating:{ratingValue:8.1,ratingCount:12}}]};
  const ratings=createRatings({store:memoryStore(),request:fallbackRequest(`<script type='application/ld+json'>${JSON.stringify(data)}</script>`)});
  assert.equal((await ratings.get(film({type:'series',category:'series'}))).douban.score,8.1);
  assert.equal((await ratings.get(film())).douban,null);
});

test('same name with wrong year or type, ambiguous scores and wrong subject IDs are rejected', async () => {
  const bodies=[page({datePublished:'2023-06-01'}),page({'@type':'TVSeries'}),page({url:'/subject/999999/'}),page({name:'海风来信 番外'}),page()+page({aggregateRating:{ratingValue:7.1,ratingCount:5}})];
  for(const body of bodies) {
    const ratings=createRatings({store:memoryStore(),request:fallbackRequest(body)});
    assert.equal((await ratings.get(film())).douban,null);
  }
});

test('captcha, 403/429 and cross-origin verification redirects return unavailable without parsing', async () => {
  for(const mode of ['captcha','403','429','redirect']) {
    let first;
    const ratings=createRatings({store:memoryStore(),request:async url=>{
      if(!new URL(url).pathname.startsWith('/subject/'))return response('{"subjects":[]}');
      first=response(mode==='captcha'?'<form id="captcha-form">安全验证</form>':page(),['403','429'].includes(mode)?Number(mode):200,mode==='redirect'?'https://sec.douban.com/c?r=anything':url);
      return first;
    }});
    const result=await ratings.get(film());
    assert.equal(result.douban,null);assert.ok(result.errors.length>0,mode);
    if(mode!=='captcha')assert.equal(first.destroyed,true);
  }
});

test('an official public feed is matched by source supplied ID, never just a title', async () => {
  const subjects=[{id:'999999',title:'海风来信',rate:'9.9'},{id:'123456',title:'海风来信',rate:'8.4'}];
  const ratings=createRatings({store:memoryStore(),request:fallbackRequest('<form>安全验证</form>',subjects)});
  const result=await ratings.get(film());
  assert.equal(result.douban.score,8.4);assert.match(result.douban.attribution,/公开热门列表/);
  assert.equal((await ratings.get(film({douban:{id:'888888'}}))).douban,null);
  assert.equal((await ratings.get(film({title:'别的影片'}))).douban,null);
});

test('movie and TV feeds remain separate and never guess an absent source ID', async () => {
  const requests=[];
  const ratings=createRatings({store:memoryStore(),request:async url=>{
    requests.push(url);return new URL(url).pathname.startsWith('/subject/')?response('',403):response(JSON.stringify({subjects:[{id:'123456',title:'海风来信',rate:'7.3'}]}));
  }});
  assert.equal((await ratings.get(film({douban:undefined}))).douban,null);assert.equal(requests.length,0);
  assert.equal((await ratings.get(film({type:'series'}))).douban.score,7.3);
  assert.equal(new URL(requests[1]).searchParams.get('type'),'tv');
  assert.equal(new URL(requests[1]).searchParams.get('page_limit'),'50');
});

test('adult records only use explicitly supplied ratings and never fetch sensitive pages', async () => {
  let requests=0;
  const ratings=createRatings({store:memoryStore(),request:async()=>{requests++;throw new Error('no remote adult requests');}});
  assert.equal((await ratings.get(film({category:'adult'}))).douban,null);
  assert.equal((await ratings.get(film({category:'adult',douban:{id:'123456',score:6.5}}))).douban.score,6.5);
  assert.equal(requests,0);
});

test('positive results persist for 24 hours, negative results retry after five minutes', async () => {
  const store=memoryStore();let time=1_800_000_000_000,calls=0;
  const request=async()=>{calls++;return response(page());};
  await createRatings({store,request,now:()=>time}).get(film());
  const second=createRatings({store,request,now:()=>time});
  assert.equal((await second.get(film())).douban.score,8.2);assert.equal(calls,1);
  time+=24*60*60*1000;await second.get(film());assert.equal(calls,2);
  const missing=memoryStore();let failedCalls=0;
  const unavailable=createRatings({store:missing,now:()=>time,request:async()=>{failedCalls++;return response('',403);}});
  await unavailable.get(film());assert.equal(failedCalls,2);
  await unavailable.get(film());assert.equal(failedCalls,2);
  time+=5*60*1000;await unavailable.get(film());assert.equal(failedCalls,4);
});

test('concurrent reads deduplicate a film and share cached official feeds', async () => {
  let calls=0;
  const ratings=createRatings({store:memoryStore(),request:async()=>{calls++;await new Promise(ok=>setTimeout(ok,3));return response(page());}});
  const values=await Promise.all(Array.from({length:6},()=>ratings.get(film())));
  assert.equal(calls,1);assert.ok(values.every(v=>v.douban.score===8.2));
  values[0].douban.score=1;assert.equal((await ratings.get(film())).douban.score,8.2);
});

test('outbound request concurrency never exceeds two and every request specifies eight seconds', async () => {
  let active=0,maximum=0;
  const ratings=createRatings({store:memoryStore(),request:async(url,options)=>{
    assert.equal(options.timeout,8000);active++;maximum=Math.max(maximum,active);
    await new Promise(ok=>setTimeout(ok,8));active--;
    const id=new URL(url).pathname.match(/subject\/(\d+)/)[1];return response(page({url:'/subject/'+id+'/'}));
  }});
  const results=await Promise.all(Array.from({length:8},(_,i)=>ratings.get(film({douban:{id:String(100000+i)}}))));
  assert.ok(results.every(v=>v.douban));assert.equal(maximum,2);
});

test('oversized pages, invalid feed JSON and network errors fail gracefully', async () => {
  for(const kind of ['large','json','network']) {
    const ratings=createRatings({store:memoryStore(),request:async url=>{
      if(kind==='network')throw Object.assign(new Error('upstream timeout'),{status:502});
      return response(new URL(url).pathname.startsWith('/subject/')?(kind==='large'?'x'.repeat(1024*1024+1):'<html>no metadata</html>'):'not-json');
    }});
    const result=await ratings.get(film());assert.equal(result.douban,null);assert.ok(result.errors.length);
  }
});

test('cache has a strict 500-entry limit and stays outside exported configuration', async () => {
  const store=memoryStore();store.values.set('config','{"sources":[]}');
  const entries=Array.from({length:500},(_,i)=>['old:'+i,{expires:Date.now()+10000,value:{douban:null,errors:[],configured:true}}]);
  store.setMeta('douban-ratings-cache-v1',JSON.stringify(entries));
  const ratings=createRatings({store,request:async()=>response(page())});await ratings.get(film());
  const cached=JSON.parse(store.meta('douban-ratings-cache-v1'));
  assert.equal(cached.length,500);assert.equal(cached.some(([key])=>key==='old:0'),false);
  assert.equal(store.meta('config'),'{"sources":[]}');
});

test('SQLite cache survives closing and reopening the shared store', async t => {
  const directory=await mkdtemp(join(tmpdir(),'vipvideo-ratings-'));
  t.after(async()=>{const absolute=resolve(directory);assert.ok(absolute.startsWith(resolve(tmpdir())+sep)&&absolute.includes('vipvideo-ratings-'));await rm(absolute,{recursive:true,force:true});});
  let store=createStore(directory,{sources:[]});let calls=0;
  const request=async()=>{calls++;return response(page());};
  await createRatings({store,request}).get(film());store.close();
  store=createStore(directory,{sources:[]});
  try{assert.equal((await createRatings({store,request}).get(film())).douban.score,8.2);assert.equal(calls,1);assert.deepEqual(store.config(),{sources:[]});}finally{store.close();}
});
