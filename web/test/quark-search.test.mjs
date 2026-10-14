import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable, PassThrough } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { createQuarkSearchRequest } from '../lib/quark-search.mjs';
import { createRequest, readText } from '../lib/network.mjs';

const fixed='http://pansou:8888/api/search';
const response=(body='{}',statusCode=200,headers={})=>Object.assign(Readable.from([Buffer.isBuffer(body)?body:Buffer.from(body)]),{statusCode,headers});
function nativeTransport(makeResponse,calls=[]){
  return(url,options,callback)=>{
    const request=new EventEmitter();request.destroyed=false;
    request.destroy=()=>{request.destroyed=true;};
    request.end=body=>{calls.push({url:url.href,options,body,request,callback});if(makeResponse)queueMicrotask(()=>callback(makeResponse()));};
    return request;
  };
}

test('the exact Docker search service receives encoded keywords without any caller credentials',async()=>{
  const calls=[],upstream=response('{"results":[]}',200,{'set-cookie':['mock-session=private']}),search=createQuarkSearchRequest({httpTransport:nativeTransport(()=>upstream,calls),request:()=>assert.fail('private service must not use public DNS transport')});
  const incoming=await search(fixed+'?'+new URLSearchParams({kw:'普通影片 2024',cloud_types:'quark',res:'results'}),{headers:{Cookie:'mock-cookie',Authorization:'mock-bearer','X-API-Key':'mock-key',Host:'other.internal','User-Agent':'mock-secret'}});
  assert.equal(await readText(incoming),'{"results":[]}');assert.equal(calls.length,1);
  const url=new URL(calls[0].url);assert.equal(url.origin,'http://pansou:8888');assert.equal(url.pathname,'/api/search');assert.equal(url.searchParams.get('kw'),'普通影片 2024');assert.equal(url.searchParams.get('conc'),'2');
  assert.equal(calls[0].options.agent,false);assert.equal(JSON.stringify(calls[0].options).includes('mock-'),false);assert.equal(incoming.headers['set-cookie'],undefined);assert.equal(calls[0].request.destroyed,true);
});

test('public Bing and PanSou requests retain the public transport and never receive secret headers',async()=>{
  const calls=[],search=createQuarkSearchRequest({httpTransport:()=>assert.fail('public URL must not use internal transport'),request:async(url,options)=>{calls.push({url:url.href,options});return response('{}');}});
  for(const url of['https://www.bing.com/search?format=rss&q=普通影片','https://search.example/api/search?kw=film&cloud_types=quark'])assert.equal(await readText(await search(url,{headers:{cookie:'mock-cookie',authorization:'mock-auth','Proxy-Authorization':'mock-proxy','X-Secret':'mock-secret'}})),'{}');
  assert.equal(calls.length,2);assert.ok(calls.every(row=>row.options.timeout===8000&&row.options.method==='GET'&&!JSON.stringify(row.options).includes('mock-')));
});

test('search cancellation reaches public requests and the fixed internal service before their timeout',async()=>{
  for(const internal of[false,true]){
    const controller=new AbortController(),reason=new Error('film changed');let calls=0,seenSignal;
    const request=async(_url,options)=>{
      calls++;seenSignal=options.signal;
      return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
    };
    const httpTransport=(_url,options)=>{
      calls++;seenSignal=options.signal;const pending=new EventEmitter();
      pending.destroy=()=>{};pending.end=()=>options.signal.addEventListener('abort',()=>pending.emit('error',options.signal.reason),{once:true});
      return pending;
    };
    const search=createQuarkSearchRequest({request,httpTransport});
    const address=internal?fixed+'?kw=film':'https://search.example/api/search?kw=film';
    const rejected=assert.rejects(search(address,{signal:controller.signal}),error=>error===reason||error.cause===reason);
    assert.equal(seenSignal,controller.signal);controller.abort(reason);await rejected;
    await assert.rejects(search(address,{signal:controller.signal}),error=>error===reason);
    assert.equal(calls,1);
  }
});

test('hostname, port and path disguises cannot access private search or arbitrary local services',async()=>{
  let privateCalls=0,publicCalls=0;
  const guarded=createRequest({lookup:async()=>[{address:'172.20.0.5',family:4}],httpRequest:()=>{publicCalls++;assert.fail('private DNS address must be rejected');}});
  const search=createQuarkSearchRequest({request:guarded,httpTransport:()=>{privateCalls++;assert.fail('not the exact service URL');}});
  for(const url of['http://PANSOU:8888/api/search','http://pansou.:8888/api/search','http://%70ansou:8888/api/search','http://pansou:8889/api/search','https://pansou:8888/api/search','http://pansou:8888/api/health','http://pansou:8888/other/../api/search','http://pansou:8888/api/%73earch','http://pansou:8888/api/search/','http://pansou:8888/api/search?kw=film#part','http://pansou.evil:8888/api/search','http://127.0.0.1:8888/api/search','http://169.254.169.254/latest/meta-data'])await assert.rejects(search(url),{status:403},url);
  await assert.rejects(search('http://user:secret@pansou:8888/api/search'),{status:400});assert.equal(privateCalls,0);assert.equal(publicCalls,0);
});

test('private redirects are refused without reading their destination or following another request',async()=>{
  const calls=[],upstream=response('redirect',302,{location:'http://127.0.0.1/private'}),search=createQuarkSearchRequest({httpTransport:nativeTransport(()=>upstream,calls)});
  await assert.rejects(search(fixed+'?kw=film'),{status:403});assert.equal(calls.length,1);assert.equal(upstream.destroyed,true);
});

test('POST search JSON is bounded and credential fields or nested untrusted values are rejected before networking',async()=>{
  const calls=[],search=createQuarkSearchRequest({httpTransport:nativeTransport(()=>response('{}'),calls)});
  const result=await search(fixed,{method:'POST',body:JSON.stringify({kw:'影片',cloud_types:['quark'],res:'results',conc:1000}),headers:{Authorization:'mock-auth',Cookie:'mock-cookie'}});await readText(result);
  assert.deepEqual(JSON.parse(calls[0].body),{kw:'影片',cloud_types:['quark'],res:'results',conc:2});assert.equal(calls[0].options.headers['Content-Length'],Buffer.byteLength(calls[0].body));
  for(const body of['x'.repeat(65537),'{bad-json',JSON.stringify({kw:'film',cookie:'mock-cookie'}),JSON.stringify({kw:'film',channels:{cookie:'mock-cookie'}}),JSON.stringify({kw:'film',plugins:['https://private.invalid/script']})])await assert.rejects(search(fixed,{method:'POST',body}),{status:400});
  await assert.rejects(search(fixed,{method:'GET',body:'{}'}),{status:400});await assert.rejects(search(fixed,{method:'DELETE'}),{status:400});
  for(const url of[fixed+'?kw=film&cookie=mock',fixed+'?kw=film&api_key=mock','https://search.example/api/search?token=mock'])await assert.rejects(search(url),{status:400});assert.equal(calls.length,1);
});

test('one eight-second deadline covers stalled private headers and destroys a late response',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000});const calls=[],search=createQuarkSearchRequest({httpTransport:nativeTransport(undefined,calls)});
  const pending=assert.rejects(search(fixed+'?kw=film'),error=>error.status===502&&/超时/.test(error.message));
  await new Promise(resolve=>setImmediate(resolve));t.mock.timers.tick(8000);await pending;assert.equal(calls[0].request.destroyed,true);
  const late=response('{}');calls[0].callback(late);await new Promise(resolve=>setImmediate(resolve));assert.equal(late.destroyed,true);
});

test('the same deadline covers stalled response bodies for public and private searches',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000});
  for(const internal of[true,false]){
    const upstream=Object.assign(new PassThrough(),{statusCode:200,headers:{}});upstream.write('{');
    const search=createQuarkSearchRequest({httpTransport:nativeTransport(()=>upstream),request:async()=>upstream});
    const pending=assert.rejects(search(internal?fixed+'?kw=film':'https://search.example/api/search?kw=film'),error=>error.status===502&&/超时/.test(error.message));
    await new Promise(resolve=>setImmediate(resolve));t.mock.timers.tick(8000);await pending;assert.equal(upstream.destroyed,true);
  }
});

test('search metadata is limited to two MiB including decompressed bodies and errors release the upstream',async()=>{
  for(const compressed of[false,true]){
    const body=Buffer.from('x'.repeat(2*1024*1024+1)),upstream=response(compressed?gzipSync(body):body,200,compressed?{'content-encoding':'gzip'}:{});
    const search=createQuarkSearchRequest({httpTransport:nativeTransport(()=>upstream)});
    await assert.rejects(search(fixed+'?kw=film'),error=>error.status===502&&/过大|2 MiB/.test(error.message));assert.equal(upstream.destroyed,true);
  }
  const broken=Object.assign(new PassThrough(),{statusCode:200,headers:{}}),search=createQuarkSearchRequest({request:async()=>broken});
  const rejected=assert.rejects(search('https://search.example/api/search?kw=film'),{status:502});queueMicrotask(()=>broken.destroy(new Error('upstream failure')));await rejected;
});

test('Docker connection errors retain their diagnostic cause and allow a later successful request',async()=>{
  const cause=Object.assign(new Error('connection refused'),{code:'ECONNREFUSED'});let attempts=0;
  const search=createQuarkSearchRequest({httpTransport:(url,options,callback)=>{
    const request=new EventEmitter();request.destroy=()=>{};
    request.end=()=>queueMicrotask(()=>{if(++attempts===1)request.emit('error',cause);else callback(response('{}'));});return request;
  }});
  await assert.rejects(search(fixed+'?kw=film'),error=>error.status===502&&error.cause===cause&&/连接失败/.test(error.message));
  assert.equal(await readText(await search(fixed+'?kw=film')),'{}');assert.equal(attempts,2);
});
