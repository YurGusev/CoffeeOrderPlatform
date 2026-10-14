import assert from 'node:assert/strict';
import https from 'node:https';
import {checkServerIdentity} from 'node:tls';
import {readFile} from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import {clientV1Schemas} from '../../../packages/generated/client-v1/dist/runtime-schemas.gen.js';
import {verifyTransportPeer} from '../../../packages/platform-security/dist/index.js';
import {nowMs,parseTime,SseDecoder,SSE_READY_TIMEOUT_MS} from './protocol.mjs';

export const fixture=JSON.parse(await readFile('/fixture/fixture.json','utf8'));
export function tlsOptions(host) {
  const peer=['edge-gateway','realtime-gateway','api-public'].includes(host);
  const material=fixture.materials['edge-nginx'];
  return {ca:material.caPem,rejectUnauthorized:true,minVersion:'TLSv1.3',servername:peer?`${host}.${fixture.config.environment}.svc.coffee-platform.internal`:host==='edge-nginx'?'localhost':'idp.fixture.invalid',...(peer?{cert:material.certPem,key:material.keyPem,checkServerIdentity:(name,cert)=>{const error=checkServerIdentity(name,cert);if(error)return error;try{assert.equal(verifyTransportPeer(cert,fixture.config.environment).runtime,host);}catch(e){return e;}}}:{})};
}
export async function request(host,port,path,{cookie,headers={},method='GET',body,timeout=5000,maxBytes=262144}={}){
  return await new Promise((resolve,reject)=>{
    const start=performance.now(),timings={};
    const mark=name=>{timings[name]=performance.now()-start;};
    const req=https.request({hostname:host,port,path,method,...tlsOptions(host),agent:false,headers:{...headers,...(cookie?{cookie}:{})}},res=>{
      mark('headersMs');
      const chunks=[];let size=0;
      res.on('data',c=>{size+=c.length;if(size>maxBytes){res.destroy(new Error('bounded response exceeded'));return;}chunks.push(c);});
      res.on('error',reject);res.on('end',()=>{mark('endMs');resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString(),timings});});
    });
    mark('createdMs');
    req.once('socket',socket=>{
      mark('socketMs');socket.once('lookup',()=>mark('lookupMs'));socket.once('connect',()=>mark('connectMs'));socket.once('secureConnect',()=>mark('secureMs'));
    });
    req.on('error',reject);req.setTimeout(timeout,()=>req.destroy(new Error(`request deadline ${host}${path}`)));req.end(body);
  });
}
export async function until(fn,{timeout=30000,interval=100,label='condition'}={}){
  const end=performance.now()+timeout;let last;
  while(performance.now()<end){try{const r=await fn();if(r)return r;}catch(e){last=e;}await new Promise(r=>setTimeout(r,Math.min(interval,Math.max(0,end-performance.now()))));}
  throw Object.assign(new Error(`bounded readiness failed: ${label}: ${last?.message??'condition false'}`),{code:'READINESS_TIMEOUT'});
}
export async function login(){
  const cookies=new Map();const absorb=r=>{for(const line of r.headers['set-cookie']??[]){const pair=line.split(';')[0],eq=pair.indexOf('=');cookies.set(pair.slice(0,eq),pair.slice(eq+1));}};
  const jar=()=>[...cookies].map(([k,v])=>`${k}=${v}`).join('; ');
  const begin=await request('edge-nginx',8443,'/auth/login?returnTo=%2Fapp%2Fcustomers');assert.equal(begin.status,303,'real Edge OIDC begin');absorb(begin);
  const authorize=new URL(begin.headers.location);assert.equal(authorize.origin,fixture.config.browserOidc.issuer);
  const grant=await request('idp.fixture.invalid',443,authorize.pathname+authorize.search);assert.equal(grant.status,302,'synthetic provider PKCE authorize');
  const callback=new URL(grant.headers.location);assert.equal(callback.origin,new URL(fixture.config.platform.publicBaseUrl).origin);
  const completed=await request('edge-nginx',8443,callback.pathname+callback.search,{cookie:jar()});assert.equal(completed.status,303,'actual Edge nonce/signature/PKCE completion');absorb(completed);
  const session=await request('edge-nginx',8443,'/auth/session',{cookie:jar()});assert.equal(session.status,200,'actual SessionStore-backed cookie authentication');
  assert.ok(cookies.has('__Host-coffee-session'));return jar();
}
export function wireValidator(){
  const required={'resource-invalidated.v1':'SseResourceInvalidated','stream-ready.v1':'SseStreamReady','stream-reset.v1':'SseStreamReset'};
  const ajv=new Ajv2020({strict:true,allErrors:true});ajv.addFormat('date-time',v=>typeof v==='string'&&Number.isFinite(parseTime(v)));ajv.addFormat('uuid',v=>/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu.test(v));
  const validators={};
  for(const [event,schemaName]of Object.entries(required)){
    assert.ok(Object.hasOwn(clientV1Schemas,schemaName),`GENERATED_SSE_VALIDATOR_UNAVAILABLE: generated client-v1 bundle missing ${schemaName}; do not fabricate a replacement`);
    validators[event]=ajv.compile(clientV1Schemas[schemaName]);
  }
  return (event,data)=>{
    const check=validators[event],valid=check&&check(data);
    if(!valid)assert.ok(valid,`generated wire validator rejected ${event}: ${ajv.errorsText(check?.errors)}`);
  };
}
export function openStream(cookie,{lastEventId,agent=false,validate=wireValidator(),onFrame=()=>{},onHeartbeat=()=>{},onClose=()=>{}}={}){
  const ready=Promise.withResolvers(),closed=Promise.withResolvers();const stream={ready:ready.promise,closed:closed.promise,frames:[],openedAt:nowMs(),normalClose:false,status:undefined};
  const decoder=new SseDecoder(validate,frame=>{stream.lastFrame=frame;onFrame(frame);if(frame.event==='stream-ready.v1'){stream.connectionId=frame.data.connectionId;ready.resolve(stream);}},onHeartbeat);
  const req=https.request({hostname:'edge-nginx',port:8443,path:'/events',method:'GET',...tlsOptions('edge-nginx'),agent,headers:{cookie,accept:'text/event-stream',...(lastEventId?{'last-event-id':lastEventId}:{})}},res=>{
    stream.response=res;stream.status=res.statusCode;stream.headers=res.headers;
    res.once('close',()=>{closed.resolve();onClose(stream);});
    if(res.statusCode!==200){const chunks=[];let n=0;res.on('data',c=>{n+=c.length;if(n<=8192)chunks.push(c);else res.destroy();});res.on('end',()=>{stream.rejectionBody=Buffer.concat(chunks).toString();ready.reject(Object.assign(new Error(`SSE preheader rejection: ${res.statusCode}`),{status:res.statusCode,body:stream.rejectionBody,headers:res.headers}));});return;}
    try{const [media,...parameters]=res.headers['content-type'].split(';').map(v=>v.trim().toLowerCase());assert.equal(media,'text/event-stream');assert.ok(parameters.every(p=>p==='charset=utf-8'),'SSE character encoding must be UTF-8');assert.equal(res.headers['cache-control'],'no-cache, no-transform');assert.equal(res.headers['content-encoding'],undefined,'SSE gzip prohibited');assert.equal(res.headers['x-accel-buffering'],'no');}catch(e){ready.reject(e);res.destroy(e);return;}
    res.on('data',c=>{try{decoder.push(c);}catch(e){ready.reject(e);stream.error=e;res.destroy(e);}});
    res.on('error',e=>{stream.error=e;});
  });
  const timer=setTimeout(()=>req.destroy(new Error('SSE establishment deadline')),SSE_READY_TIMEOUT_MS);
  req.on('error',e=>{ready.reject(e);stream.error=e;closed.resolve();onClose(stream);});
  ready.promise.then(()=>clearTimeout(timer),()=>clearTimeout(timer));
  stream.close=()=>{stream.normalClose=true;req.destroy();};stream.request=req;req.end();return stream;
}
export async function nativeProducer(){
  const {createNativeProducer}=await import('../../../packages/platform-kafka-runtime/dist/native.js');
  const producer=await createNativeProducer({brokers:fixture.config.kafka.brokers,protocol:'SASL_SSL',username:fixture.credentials.publisher.username,password:fixture.credentials.publisher.password,sslCaPem:fixture.credentials.publisher.caPem,clientId:`issue12-publisher-${process.pid}`,maxPending:10000,maxMessageBytes:1048576,sendTimeoutMs:5000,receiveTimeoutMs:5000,commitTimeoutMs:5000,shutdownTimeoutMs:10000,producerRetries:3});
  await producer.connect();return producer;
}
export async function envelopeValidator(){
  const ajv=new Ajv2020({strict:true,allErrors:true});ajv.addFormat('date-time',v=>typeof v==='string'&&Number.isFinite(parseTime(v)));ajv.addFormat('uuid',v=>/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu.test(v));
  const paths=['common/identifiers.v1.schema.json','common/money-version-time.v1.schema.json','common/message-envelope.v1.schema.json','events/realtime-invalidated.v1.schema.json'];
  let event;
  for(const path of paths){const schema=JSON.parse(await readFile(new URL(`../../../contracts/schemas/${path}`,import.meta.url),'utf8'));ajv.addSchema(schema);if(path.startsWith('events/'))event=schema;}
  const check=ajv.getSchema(event.$id);return envelope=>assert.ok(check(envelope),`publisher envelope contract invalid: ${ajv.errorsText(check.errors)}`);
}
