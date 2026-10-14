import {readFileSync} from "node:fs";
import {mkdtemp, writeFile, rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {execFileSync} from "node:child_process";
import {generateKeyPairSync} from "node:crypto";
import {request as httpsRequest} from "node:https";
import {loadPlatformConfig} from "../../packages/platform-config/dist/index.js";
import {load as parseYaml} from "js-yaml";
import {createRuntime} from "../../packages/platform-runtime/dist/index.js";
import {parseServiceTransportMaterial, signActorContext} from "../../packages/platform-security/dist/index.js";
import {createRealtimeComposition} from "../../apps/realtime-gateway/dist/index.js";
import {EventEmitter} from "node:events";

// Synthetic test-only key material remains in memory. OpenSSL receives it on
// stdin; only public certificates/CSRs/extensions are scoped to scratch.
export async function realtimeFixture(t, overrides={}) {
 const directory=await mkdtemp(join(tmpdir(),"issue12-synthetic-tls-"));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const key=()=>generateKeyPairSync("rsa",{modulusLength:2048}).privateKey.export({type:"pkcs8",format:"pem"});
 const ssl=(args,input)=>{
  const at=args.findIndex(value=>value==="-key"||value==="-CAkey");const flag=args[at];const rest=args.filter((_,i)=>i!==at&&i!==at+1);
  const quote=value=>`'${value.replaceAll("'", "'\\''")}'`;
  // Node synchronous stdin is a socket, which OpenSSL's filename loader cannot
  // reopen. pkey uses stdin directly and process substitution supplies a pipe.
  return execFileSync("bash",["-c",`openssl ${rest.map(quote).join(" ")} ${flag} <(openssl pkey)`],{input,encoding:"utf8",stdio:["pipe","pipe","pipe"]});
 };
 const caKey=key();const caPem=ssl(["req","-x509","-new","-key","-","-subj","/CN=issue12-synthetic-ca","-days","1","-addext","basicConstraints=critical,CA:TRUE","-addext","keyUsage=critical,keyCertSign,cRLSign"],caKey);
 const caPath=join(directory,"ca.crt");await writeFile(caPath,caPem);
 async function material(runtime,environment="development"){
  const keyPem=key();const csr=ssl(["req","-new","-key","-","-subj",`/CN=${runtime}`],keyPem);const csrPath=join(directory,`${environment}-${runtime}.csr`),extPath=join(directory,`${environment}-${runtime}.ext`);
  await writeFile(csrPath,csr);await writeFile(extPath,`basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth,clientAuth\nsubjectAltName=DNS:realtime.fixture.invalid,URI:spiffe://coffee-platform/${environment}/${runtime}\n`);
  const certPem=ssl(["x509","-req","-in",csrPath,"-CA",caPath,"-CAkey","-","-set_serial",String(runtime==="realtime-gateway"?1:runtime==="edge-nginx"?2:3),"-days","1","-sha256","-extfile",extPath],caKey);
  return parseServiceTransportMaterial(JSON.stringify({keyPem,certPem,caPem}),environment,runtime);
 }
 const server=await material("realtime-gateway"),edge=await material("edge-nginx"),wrong=await material("edge-gateway");
 const actor=generateKeyPairSync("ed25519"),previous=generateKeyPairSync("ed25519");
 const loaded=await loadPlatformConfig(new URL("../../config/platform.yaml",import.meta.url).pathname,parseYaml);const fixtureConfig=structuredClone(loaded);
 if(overrides.authCheckMs!==undefined)fixtureConfig.services["realtime-gateway"].realtime.authCheckMs=overrides.authCheckMs;
 const context={config:fixtureConfig,secrets:{security:{actorContextEdgeVerificationPublicKeys:{active:actor.publicKey.export({type:"spki",format:"pem"}),previous:previous.publicKey.export({type:"spki",format:"pem"})}}}};
 const composition=createRealtimeComposition();const bindings=[];
 const kafka={bind:(group,binding)=>bindings.push({group,binding}),metrics:()=>({assigned:overrides.assignmentCount?.()??loaded.kafka.topics.realtimeInvalidate.partitions}),readiness:{check:async()=>overrides.subscriptionReady?.()??true}};
 const app=await createRuntime({name:"realtime-gateway",host:"127.0.0.1",port:0,shutdownGraceMs:1000,deadlineMs:null,deadlineProfiles:{defaultMs:null},concurrency:overrides.concurrency??loaded.services["realtime-gateway"].concurrency,
  transport:{environment:loaded.environment,runtime:"realtime-gateway",mode:"mtls",material:server},...composition,
  configure:(app,signal)=>composition.configure(app,signal,undefined,kafka,context)});
 t.after(async()=>{await app.runtimeController.closeRuntime();});const starting=app.runtimeController.start();await overrides.onStarting?.(app,context);await starting;
 const port=app.server.address().port;
 const corr="77777777-7777-4777-8777-777777777777",trace="00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
 const claims=()=>{const now=Math.floor(Date.now()/1000);return {iss:"edge-gateway",originalIssuer:"edge-gateway",aud:"realtime-gateway",sub:"operator",permissions:["orders:read:any"],operationId:"streamOrderInvalidations",correlationId:corr,traceparent:trace,iat:now,exp:now+60,jti:"synthetic",kid:"synthetic"};};
 const headers=(change={},privateKey=actor.privateKey)=>({"x-actor-context":signActorContext({...claims(),...change},privateKey),"x-correlation-id":corr,traceparent:trace});
 const sockets=[];
 async function request({headers:input=headers(),client=edge,path="/events",agent=false}={}) {
  return new Promise((resolve,reject)=>{
   const req=httpsRequest({host:"127.0.0.1",port,path,method:"GET",servername:"realtime.fixture.invalid",ca:caPem,key:client?.keyPem,cert:client?.certPem,agent,headers:input},res=>{
    let text="";res.setEncoding("utf8");res.on("data",chunk=>{text+=chunk;});res.on("error",()=>{});resolve({req,res,text:()=>text});
   });sockets.push(req);req.on("error",reject);req.end();
  });
 }
 t.after(()=>{for(const socket of sockets)socket.destroy();});
 return {app,composition,bindings,context,actor,previous,headers,claims,request,edge,wrong};
}
export async function until(predicate,timeout=2000){const end=performance.now()+timeout;while(!predicate()){if(performance.now()>end)throw Error("synthetic realtime condition timeout");await sleep(5);}}
export const config = {shutdownGraceMs:20000,maxConnections:512,queueMaxRecords:64,queueMaxBytes:262144,totalQueueMaxRecords:262144,totalQueueMaxBytes:67108864,ringMaxRecords:10000,ringMaxBytes:16777216,ringMaxAgeMs:300000,coalesceMs:250,writeTimeoutMs:5000,heartbeatMs:15000,authCheckMs:30000,maxEventDataBytes:2048,rssBudgetBytes:536870912,fdBudget:12288};
export const fixture = JSON.parse(readFileSync(new URL("../../contracts/fixtures/positive/events/realtime-invalidated.v1.json",import.meta.url),"utf8"));
export function envelope(n=1, version=String(n), subject=fixture.payload.subjectRef) {
 const e=structuredClone(fixture);e.messageId=`msg_${String(n).padStart(26,"0")}`;e.aggregate.ref=e.payload.subjectRef=subject;e.aggregate.version=e.payload.ownerVersion=version;return e;
}
export function record(e=fixture, key=e.payload.subjectRef) {return {topic:"coffee.realtime.invalidate.v1",partition:0,offset:"1",key,value:JSON.stringify(e),headers:{}};}
export const turn = () => new Promise(resolve => setImmediate(resolve));
export const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
export class Sink extends EventEmitter {
 frames=[];destroyed=false;writableFinished=false;blocked=false;callbackBlocked=false;
 write(frame,callback) {this.frames.push(Buffer.isBuffer(frame)?frame.toString("utf8"):frame);if(!this.callbackBlocked)queueMicrotask(()=>callback?.());return !this.blocked;}
 end(){this.writableFinished=true;this.destroyed=true;this.emit("finish");this.emit("close");}
 destroy(){this.destroyed=true;this.emit("close");}
}
