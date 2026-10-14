import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {cp,mkdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {parse,runTransportFixture,bounded} from '../realtime/soak.test.mjs';
import {canonicalJson} from '../../packages/platform-idempotency/dist/index.js';
import {docker as fixtureDocker,json,hash,productArgs,redact,run as fixtureRun,ROOT} from '../realtime/fixtures/setup.mjs';
import {fixture,mapping,product} from './orders-fixture.mjs';

const shortHash=value=>hash(String(value));
const browserRouteTemplate=value=>{
  let pathname;
  try{pathname=new URL(value,'https://localhost').pathname;}catch{return 'other';}
  if(pathname==='/events'||pathname==='/auth/session'||pathname==='/auth/login'||pathname==='/auth/callback')return pathname;
  if(/^\/app\/orders\/[^/]+$/u.test(pathname))return '/app/orders/:orderRef';
  if(/^\/api\/client-v1\/orders\/[^/]+\/commands\/request-aroma-reconciliation$/u.test(pathname))return '/api/client-v1/orders/:orderRef/commands/request-aroma-reconciliation';
  if(/^\/api\/client-v1\/orders\/[^/]+$/u.test(pathname))return '/api/client-v1/orders/:orderRef';
  if(pathname.startsWith('/assets/'))return '/assets/:asset';
  return 'other';
};
const browserFailureCategory=value=>{
  const match=/\bnet::(ERR_[A-Z0-9_]+)\b/u.exec(String(value??''));
  const allowed=new Set(['ERR_ABORTED','ERR_CONNECTION_CLOSED','ERR_CONNECTION_REFUSED','ERR_CONNECTION_RESET','ERR_CERT_AUTHORITY_INVALID','ERR_NAME_NOT_RESOLVED','ERR_TIMED_OUT','ERR_TUNNEL_CONNECTION_FAILED']);
  return match&&allowed.has(match[1])?match[1]:'other';
};
const traceId=()=>randomBytes(16).toString('hex');
const traceparentFor=id=>`00-${id}-${randomBytes(8).toString('hex')}-01`;
const fieldsContain=(value,key,expected)=>{
  if(value===null||typeof value!=='object')return false;
  if(value[key]===expected)return true;
  return Object.values(value).some(child=>fieldsContain(child,key,expected));
};
const parseConsumerGroupSnapshot=(describeText,stateText,membersText,group)=>{
  const numeric=value=>/^\d+$/u.test(value??'')?value:null;
  const partitions=describeText.split(/\r?\n/u).map(line=>line.trim().split(/\s+/u)).filter(parts=>parts[0]===group&&/^\d+$/u.test(parts[2]??''));
  const states=stateText.split(/\r?\n/u).map(line=>line.trim().split(/\s+/u)).find(parts=>parts[0]===group);
  const memberRows=membersText.split(/\r?\n/u).map(line=>line.trim().split(/\s+/u)).filter(parts=>parts[0]===group&&parts[1]&&parts[1]!=='CONSUMER-ID');
  return {
    available:true,group,
    state:states&&/^[A-Za-z]+$/u.test(states[1]??'')?states[1]:null,
    memberCount:numeric(states?.[2]??'')===null?memberRows.length:Number(states[2]),
    partitions:partitions.map(parts=>({topic:parts[1],partition:Number(parts[2]),currentOffset:numeric(parts[3]),endOffset:numeric(parts[4]),lag:numeric(parts[5])})),
    members:memberRows.map(parts=>({consumerIdSha256:shortHash(parts[1]),assignedPartitionCount:numeric(parts[4])===null?null:Number(parts[4])})),
  };
};
const launchRoles=['driver','edge-nginx','realtime-gateway','api-public','api-internal','edge-gateway','orders-service','orders-aroma-preparation','kafka'];
function commandContext(args,options,error){
  const operation=String(args[0]??'unknown');
  const candidates=operation==='exec'?args.slice(1):args.slice(1,2);
  const containerRole=launchRoles.find(role=>candidates.some(value=>typeof value==='string'&&(value===role||value.endsWith(`-${role}`))));
  const exit=/\bexit=(-?\d+), signal=([A-Za-z0-9_-]+|null)\b/u.exec(String(error?.message??''));
  const exitCode=exit&&Number(exit[1]);
  const signal=exit?.[2]==='null'?null:exit?.[2]??null;
  return {
    program:'docker',operation,...(containerRole?{containerRole}:{}),
    ...(Number.isInteger(exitCode)?{exitCode}:{}),signal,
    timeoutMs:Number.isFinite(options?.timeout)?options.timeout:120000,
  };
}
async function captureCommandFailure(execute,args,options){
  const started=performance.now();
  try{return await execute();}
  catch(error){
    error.launchPathCommand={...commandContext(args,options,error),elapsedMs:Math.round(performance.now()-started)};
    throw error;
  }
}
const docker=(...args)=>captureCommandFailure(()=>fixtureDocker(...args),args);
const run=(command,args,options)=>captureCommandFailure(()=>fixtureRun(command,args,options),command==='docker'?args:[command,...args],options);

/** Run the real Orders owners inside the served transport fixture and prove a synthetic W3C request context. */
export async function runLaunchPath({telemetry,onNetwork,onRolesReady,observeBaseline,observeProof,resultDir}){
  assert.ok(telemetry&&typeof telemetry==='object');
  assert.ok(telemetry.config&&typeof telemetry.config==='object');
  assert.match(telemetry.endpoint,/^https?:\/\//u);
  assert.equal(typeof telemetry.exporterToken,'string');assert.ok(telemetry.exporterToken.length>0);
  assert.equal(typeof onNetwork,'function');assert.equal(typeof onRolesReady,'function');assert.equal(typeof observeBaseline,'function');assert.equal(typeof observeProof,'function');
  let phase='fixture-preparation';
  const options=parse(['--smoke','--profile','reference-512','--smoke-clients','1','--smoke-duration-ms','45000','--result-dir',resultDir??`${process.env.TMPDIR??'/tmp'}/coffee-g14-launch-${randomUUID()}`]);
  options.launchPath={telemetryConfig:telemetry.config,telemetryEndpoint:telemetry.endpoint,exporterToken:telemetry.exporterToken};
  let proofReceipt;
  const result=await fixture(async f=>{
  const hook={
    onNetwork:async args=>{phase='launch-network-ready';return onNetwork(args);},
    onRolesReady:async args=>{phase='collector-config';await onRolesReady(args);phase='product-roles-ready';},
    observeProof:async proof=>{proofReceipt=proof;await observeProof(proof);},
    startOwner:async({setup,network,dir,registerOwner})=>{
      phase='launch-owner-setup';
      const fixture=JSON.parse(await readFile(`${setup.privateDir}/fixture.json`,'utf8'));
      const key=fixture.launchPath.ordersServiceSigningPrivateKey;
      assert.ok(key);
      const nginxImage=`coffee-issue64-launch-path:${options.runId}`;
      let imageBuildAttempted=false,databaseAttached=false;
      const stop=async()=>{
        const failures=[];
        for(const cleanup of [
          async()=>{if(databaseAttached){await docker('network','disconnect',network,f.container);databaseAttached=false;}},
          async()=>{if(imageBuildAttempted){const present=(await docker('image','ls','--filter',`reference=${nginxImage}`,'--format','{{.ID}}')).trim();if(present){await docker('image','rm',nginxImage);assert.equal((await docker('image','ls','--filter',`reference=${nginxImage}`,'--format','{{.ID}}')).trim(),'');}}},
        ]){try{await cleanup();}catch(error){failures.push(error);}}
        if(failures.length)throw new AggregateError(failures,'launch-path owner fixture cleanup failed');
      };
      const owner={nginxImage,stop};
      registerOwner(owner);
      assert.equal((await docker('image','ls','--filter',`reference=${nginxImage}`,'--format','{{.ID}}')).trim(),'','run-scoped nginx image tag must be unused before canonical build');
      imageBuildAttempted=true;
      const build=redact(await run('pnpm',['image:build','--target','edge-nginx','--tag',nginxImage,'--load','.'],{timeout:600000,outputLimit:64*1024*1024}));
      const imageId=(await docker('image','inspect','--format','{{.Id}}',nginxImage)).trim();assert.match(imageId,/^sha256:[a-f0-9]{64}$/u);
      await json(join(dir,'launch-path-nginx-image.json'),{image:nginxImage,imageId,source:'canonical production edge-nginx target, current frozen working tree',buildLogSha256:hash(build)});
      await json(`${setup.privateDir}/aroma-convergence-proof.yaml`,{schemaVersion:1,environment:setup.config.environment,runtime:'aroma-convergence',secrets:{postgres:{aromaConvergence:f.runtimeCredential('coffee_orders_convergence_rw')},kafka:{orders:fixture.credentials.orders},telemetry:{exporterToken:telemetry.exporterToken}}},0o400);
      const publisherDir=join(setup.snapshot,'tests/realtime/fixtures');await mkdir(publisherDir,{recursive:true});
      for(const filename of ['owner-publisher.mjs','transport.mjs','protocol.mjs'])await cp(join(ROOT,'tests/realtime/fixtures',filename),join(publisherDir,filename));
      try{
        await docker('network','connect','--alias','coffee_postgres',network,f.container);databaseAttached=true;
      const scoped=(role,databaseRef,credentialRef)=>({schemaVersion:1,environment:setup.config.environment,runtime:role,secrets:{postgres:{[databaseRef]:f.runtimeCredential(credentialRef)},kafka:{orders:fixture.credentials.orders},security:{serviceTransportKeys:{[role]:JSON.stringify(fixture.materials[role])},...(role==='orders-service'?{ordersServiceDelegationSigningPrivateKey:key,delegationVerificationKeys:{'api-public':fixture.apiKeys}}:{})},telemetry:{exporterToken:telemetry.exporterToken}}});
        await json(`${setup.privateDir}/orders-service.yaml`,scoped('orders-service','ordersService','coffee_orders_service_rw'),0o400);
        await json(`${setup.privateDir}/orders-aroma-preparation.yaml`,scoped('orders-aroma-preparation','ordersPreparation','coffee_orders_prepare_rw'),0o400);
      }catch(error){if(databaseAttached){await docker('network','disconnect',network,f.container).catch(()=>{});databaseAttached=false;}throw error;}
      return {
        ...owner,
        startServices:async({setup,launch})=>{
          phase='product-owner-start';
          await launch('api-internal',setup.images.node,productArgs('api-internal'),{aliases:['api-internal']});
          await launch('orders-aroma-preparation',setup.images.node,productArgs('orders-aroma-preparation'),{aliases:['orders-aroma-preparation']});
          await launch('orders-service',setup.images.node,productArgs('orders-service'),{aliases:['orders-service']});
        },
      };
    },
    exercise:async({setup,dir,driver,broker})=>{
      phase='browser-and-orders-flow';
      const sent=[];
      const groups={'CatalogMappingChanged.v2':'orders-catalog-mapping-v2','OrderConfirmed.v1':'orders-aroma-preparation-v1','OrderReconciliationRequested.v1':'orders-aroma-preparation-v1','AromaObservationChanged.v1':'orders-aroma-projection-v1'};
      let sourceDurationMs=0,projectionDurationMs=0;
      const deliverSources=async events=>{
        const output=await run('docker',['exec','-i',driver,'node','/app/tests/realtime/fixtures/owner-publisher.mjs','publish-orders'],{input:canonicalJson(events),timeout:30000,outputLimit:65536});
        const receipts=JSON.parse(output);assert.equal(receipts.length,events.length,'one actual broker acknowledgement per source event');
        const checkpoint={schemaVersion:1,phase:'broker-acknowledgements-received',sourceCount:events.length,acknowledgementCount:receipts.length,records:events.map((envelope,index)=>{
          const receipt=receipts[index],consumerGroup=groups[envelope.messageType];assert.ok(consumerGroup,`known preparation consumer for ${envelope.messageType}`);
          assert.match(receipt.messageIdSha256,/^[a-f0-9]{64}$/u);assert.ok(Number.isInteger(receipt.partition));assert.match(String(receipt.offset),/^\d+$/u);
          return {messageType:envelope.messageType,topic:receipt.topic,partition:receipt.partition,offset:receipt.offset,messageIdSha256:receipt.messageIdSha256,consumerGroup,inboxCommit:'pending'};
        })};
        const checkpointPath=join(dir,'launch-path-source-checkpoint.json');await json(checkpointPath,checkpoint);
        for(let index=0;index<events.length;index++){
          const envelope=events[index],receipt=receipts[index],group=groups[envelope.messageType];
          checkpoint.phase='waiting-for-inbox-commit';checkpoint.waitingFor={messageType:envelope.messageType,topic:receipt.topic,partition:receipt.partition,offset:receipt.offset,consumerGroup:group,messageIdSha256:receipt.messageIdSha256};await json(checkpointPath,checkpoint);
          let inbox;
          try{
            inbox=await bounded(async()=>{const rows=await f.read('SELECT state,outcome FROM orders.inbox_messages WHERE consumer_name=$1 AND message_id=$2',[group,envelope.messageId]);if(!rows.length)return false;assert.equal(rows[0].state,'Processed',`real preparation Inbox outcome: ${rows[0].outcome}`);return rows[0];},{timeout:30000,interval:100,label:'actual Kafka-backed preparation Inbox commit'});
          }catch(error){
            checkpoint.phase='inbox-commit-not-observed';checkpoint.waitingFor=null;
            const ids=events.map(event=>event.messageId);
            try{
              const inboxRows=await f.read('SELECT consumer_name,message_id,state FROM orders.inbox_messages WHERE message_id = ANY($1::text[])',[ids]);
              checkpoint.inboxInspection={available:true,rows:inboxRows.map(row=>({consumerGroup:row.consumer_name,messageIdSha256:shortHash(row.message_id),state:['Processing','Processed','Quarantined'].includes(row.state)?row.state:'other'}))};
            }catch{checkpoint.inboxInspection={available:false};}
            try{
              const quarantineRows=await f.read('SELECT consumer_name,message_id,topic,"partition" AS topic_partition,"offset" AS topic_offset,reason FROM orders.inbox_quarantine WHERE message_id = ANY($1::text[])',[ids]);
              const reasonClasses=new Set(['KAFKA_ENVELOPE_INVALID','INBOX_HASH_CONFLICT','OWNER_REVISION_CONFLICT','OWNER_VERSION_CONFLICT']);
              checkpoint.quarantineInspection={available:true,count:quarantineRows.length,rows:quarantineRows.map(row=>({consumerGroup:row.consumer_name,messageIdSha256:row.message_id?shortHash(row.message_id):null,topic:row.topic,partition:row.topic_partition,offset:row.topic_offset,reasonClass:reasonClasses.has(row.reason)?row.reason:'other'}))};
            }catch{checkpoint.quarantineInspection={available:false};}
            try{
              const describe=await run('docker',['exec',broker,'/opt/kafka/bin/kafka-consumer-groups.sh','--bootstrap-server','kafka:9092','--command-config','/etc/kafka/secrets/client.properties','--describe','--group',group],{timeout:10000,outputLimit:32768});
              const state=await run('docker',['exec',broker,'/opt/kafka/bin/kafka-consumer-groups.sh','--bootstrap-server','kafka:9092','--command-config','/etc/kafka/secrets/client.properties','--state','--group',group],{timeout:10000,outputLimit:32768});
              const members=await run('docker',['exec',broker,'/opt/kafka/bin/kafka-consumer-groups.sh','--bootstrap-server','kafka:9092','--command-config','/etc/kafka/secrets/client.properties','--members','--group',group],{timeout:10000,outputLimit:32768});
              checkpoint.consumerGroupInspection=parseConsumerGroupSnapshot(describe,state,members,group);
            }catch(error){checkpoint.consumerGroupInspection={available:false,category:error?.code==='FIXTURE_COMMAND_FAILED'?'command-failed':'inspection-failed'};}
            await json(checkpointPath,checkpoint);throw error;
          }
          checkpoint.records[index].inboxCommit='Processed';checkpoint.phase='inbox-commit-confirmed';checkpoint.waitingFor=null;await json(checkpointPath,checkpoint);
          sent.push({...receipt,messageType:envelope.messageType,consumer:group,state:inbox.state});
        }
      };
      let browser,context;
      try{
        const p=product(),mappingEvent=mapping(p),order=await f.seed([p]);const sourceStartedAt=performance.now();await deliverSources([mappingEvent,order.confirmed]);sourceDurationMs=Math.round(performance.now()-sourceStartedAt);
        const state={orderRef:order.order};
        assert.equal(typeof state.orderRef,'string');
        const projectionStartedAt=performance.now();
        const card=await bounded(async()=>{const value=await f.card(state.orderRef);return value?.card_version?value:false;},{timeout:30000,interval:100,label:'actual Orders projection exists before browser command'});
        const invalidation=await bounded(async()=>{const rows=await f.read("SELECT state FROM orders.outbox_messages WHERE message_type='RealtimeInvalidated.v1' AND aggregate_ref=$1 AND owner_version=$2",[state.orderRef,card.card_version]);return rows.length===1?rows[0]:false;},{timeout:30000,interval:100,label:'real projection invalidation persisted in owner Outbox'});
        assert.ok(['Pending','Published'].includes(invalidation.state));
        projectionDurationMs=Math.round(performance.now()-projectionStartedAt);
        const observation=await f.observe({lines:[]});
        const observationStartedAt=performance.now();
        await deliverSources([observation.changed]);
        const observedProjection=await bounded(async()=>{const value=await f.card(state.orderRef);return value?.state==='OutOfSync'?value:false;},{timeout:30000,interval:100,label:'actual Kafka-backed empty Aroma observation projects the confirmed order as OutOfSync'});
        const observationSource=sent.at(-1);
        assert.equal(observationSource?.messageType,'AromaObservationChanged.v1');
        const observationReceipt={verified:true,source:{messageType:observationSource.messageType,topic:observationSource.topic,partition:observationSource.partition,offset:observationSource.offset,messageIdSha256:observationSource.messageIdSha256,consumerGroup:observationSource.consumer,state:observationSource.state},projection:{state:observedProjection.state,versionSha256:shortHash(observedProjection.card_version)},observedRevisionSha256:shortHash(observation.revision),fingerprintSha256:shortHash(observation.fingerprint),durationMs:Math.round(performance.now()-observationStartedAt)};
        await json(join(dir,'launch-path-observation-checkpoint.json'),observationReceipt);
        const commandCorrelation=randomUUID(),traceIdValue=traceId(),traceparent=traceparentFor(traceIdValue);
        const login=(await docker('exec',`${options.runId}-driver`,'node','tests/realtime/fixtures/owner-publisher.mjs','login',{timeout:60000})).trim();
        browser=await (await import('playwright')).chromium.launch({headless:true});
        context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1280,height:900}});
        await context.addCookies(login.split('; ').map(pair=>{const i=pair.indexOf('=');assert.ok(i>0);const name=pair.slice(0,i);assert.ok(['__Host-coffee-session','__Host-coffee-csrf','__Host-coffee-login'].includes(name),'unexpected synthetic login cookie');return {name,value:pair.slice(i+1),url:'https://localhost:8443/',secure:true,httpOnly:name!=='__Host-coffee-csrf',sameSite:'Lax'};}));
        const page=await context.newPage();
        await page.addInitScript(({correlationId,parent})=>{
          window.__g14Frames=[];window.__g14OwnerFetches=[];window.__g14EventSourceWitness=[];
          const readyStateName=source=>source.readyState===EventSource.OPEN?'OPEN':source.readyState===EventSource.CLOSED?'CLOSED':'CONNECTING';
          const NativeEventSource=window.EventSource;window.EventSource=class extends NativeEventSource{constructor(url,...args){super(url,...args);let route='other';try{route=new URL(url,location.href).pathname==='/events'?'/events':'other';}catch{}const witness={route,readyState:readyStateName(this),openEvents:0,errorEvents:0,streamReadyFrames:0};window.__g14EventSourceWitness.push(witness);this.addEventListener('open',()=>{witness.openEvents+=1;witness.readyState=readyStateName(this);});this.addEventListener('error',()=>{witness.errorEvents+=1;witness.readyState=readyStateName(this);});for(const name of ['resource-invalidated.v1','stream-ready.v1'])this.addEventListener(name,event=>{if(name==='stream-ready.v1')witness.streamReadyFrames+=1;window.__g14Frames.push({event:name,id:event.lastEventId,data:JSON.parse(event.data)});});}};
          const nativeFetch=window.fetch.bind(window);window.fetch=(input,init={})=>{
            const url=new URL(typeof input==='string'?input:input.url,location.href),method=(init.method??(input instanceof Request?input.method:'GET')).toUpperCase(),headers=new Headers(init.headers??(input instanceof Request?input.headers:undefined));
            if(method==='GET'&&url.pathname.startsWith('/api/client-v1/orders/')){
              headers.set('x-correlation-id',correlationId);headers.set('traceparent',parent);
              const witness={correlationId:headers.get('x-correlation-id'),traceparent:headers.get('traceparent'),frameId:[...window.__g14Frames].reverse().find(frame=>frame.event==='resource-invalidated.v1')?.id??null};
              window.__g14OwnerFetches.push(witness);
              return nativeFetch(input,{...init,headers}).then(response=>{
                witness.responseStatus=response.status;witness.responseCorrelationId=response.headers.get('x-correlation-id');witness.responseTraceparent=response.headers.get('traceparent');
                return response;
              });
            }
            return nativeFetch(input,{...init,headers});
          };
        },{correlationId:commandCorrelation,parent:traceparent});
        const ownerResponses=[];page.on('response',response=>{if(new URL(response.url()).pathname===`/api/client-v1/orders/${state.orderRef}`){const requestHeaders=response.request().headers(),entry={status:response.status(),requestCorrelationId:requestHeaders['x-correlation-id']??null,requestTraceparent:requestHeaders.traceparent??null,responseCorrelationId:null,responseTraceparent:null};ownerResponses.push(entry);entry.headersPending=response.allHeaders().then(headers=>{entry.responseCorrelationId=headers['x-correlation-id']??null;entry.responseTraceparent=headers.traceparent??null;});}});
        const browserResponses=[],browserFailures=[];
        page.on('response',response=>{if(browserResponses.length<100)browserResponses.push({route:browserRouteTemplate(response.url()),status:response.status(),resourceType:['document','stylesheet','image','media','font','script','texttrack','xhr','fetch','eventsource','websocket','other'].includes(response.request().resourceType())?response.request().resourceType():'other'});});
        page.on('requestfailed',request=>{if(browserFailures.length<100)browserFailures.push({route:browserRouteTemplate(request.url()),failureCategory:browserFailureCategory(request.failure()?.errorText)});});
        const saveStreamStartup=async outcome=>{
          let browserState;
          try{browserState=await page.evaluate(()=>({documentReadyState:document.readyState,eventSources:window.__g14EventSourceWitness.map(source=>({route:source.route,readyState:['CONNECTING','OPEN','CLOSED'].includes(source.readyState)?source.readyState:'unknown',openEvents:source.openEvents,errorEvents:source.errorEvents,streamReadyFrames:source.streamReadyFrames})),readyFrameCount:window.__g14Frames.filter(frame=>frame.event==='stream-ready.v1').length}));}catch{browserState={available:false};}
          await json(join(dir,'launch-path-browser-stream.json'),{schemaVersion:1,outcome,timeoutMs:20000,browserState,responses:browserResponses,requestFailures:browserFailures});
        };
        const browserStartedAt=performance.now();
        await page.goto(`https://localhost:8443/app/orders/${state.orderRef}`,{waitUntil:'domcontentloaded'});
        try{await page.waitForFunction(()=>window.__g14Frames.some(frame=>frame.event==='stream-ready.v1'),null,{timeout:20000});await saveStreamStartup('ready');}
        catch(error){await saveStreamStartup('not-ready');throw error;}
        const baselineOwner=await bounded(async()=>{
          for(const response of ownerResponses)await response.headersPending;
          return ownerResponses.find(entry=>entry.status===200&&entry.requestCorrelationId===commandCorrelation&&entry.responseCorrelationId===commandCorrelation&&entry.requestTraceparent===traceparent&&entry.responseTraceparent===traceparent)??false;
        },{timeout:15000,interval:100,label:'baseline browser owner GET accepted through Edge and api-public during collector outage'});
        const nodeRoles=['edge-gateway','api-public','api-internal','orders-service','orders-aroma-preparation','realtime-gateway'];
        const nodeReadiness=Object.fromEntries(await Promise.all(nodeRoles.map(async role=>{
          const service=setup.config.services[role];assert.ok(service?.health?.readyPath);assert.ok(Number.isInteger(service.listen?.port));
          const environment={COFFEE_CONFIG_FILE:'/fixture/platform.yaml',COFFEE_RUNTIME_SECRETS_FILE:`/fixture/${role}.yaml`,RUNTIME_NAME:role,PORT:String(service.listen.port)};
          const program=`try{const {readRuntimeHealthStatuses}=await import('./packages/platform-runtime/dist/healthcheck.js');const statuses=await readRuntimeHealthStatuses([${JSON.stringify(service.health.readyPath)}],${JSON.stringify(environment)});console.log(JSON.stringify({statuses}));}catch(error){const allowed=new Set(['ERR_MODULE_NOT_FOUND','ERR_PACKAGE_PATH_NOT_EXPORTED','ECONNREFUSED','ECONNRESET','ECONNABORTED','ETIMEDOUT','CERT_HAS_EXPIRED','ERR_TLS_CERT_ALTNAME_INVALID','ERR_SSL_CERTIFICATE_VERIFY_FAILED']);console.log(JSON.stringify({errorCode:allowed.has(error?.code)?error.code:'other'}));}`;
          let lastProbe={outcome:'invalid-response'};
          let statuses;
          try{statuses=await bounded(async()=>{
            try{
              const output=await docker('exec','--user','1000:1000',`${options.runId}-${role}`,'node','--input-type=module','-e',program);
              const parsed=JSON.parse(output);
              if(Array.isArray(parsed.statuses)&&parsed.statuses.length===1&&Number.isInteger(parsed.statuses[0])){lastProbe={httpStatus:parsed.statuses[0]};return parsed.statuses[0]===200?parsed.statuses:false;}
              if(typeof parsed.errorCode==='string'){lastProbe={errorCode:parsed.errorCode};return false;}
              lastProbe={outcome:'invalid-response'};return false;
            }catch(error){lastProbe={outcome:error?.code==='FIXTURE_COMMAND_FAILED'?'exec-failed':'probe-failed'};return false;}
          },{timeout:15000,interval:250,label:`${role} internal mTLS readiness`});}
          catch(error){await json(join(dir,'launch-path-node-readiness-failure.json'),{schemaVersion:1,role,lastProbe,timeoutMs:15000});throw error;}
          assert.deepEqual(statuses,[200],`${role} internal healthcheck readiness`);
          return [role,statuses[0]];
        })));
        const roleNames=['kafka','orders-service','orders-aroma-preparation','api-internal','api-public','realtime-gateway','edge-gateway','edge-nginx'];
        const roles=[];
        for(const role of roleNames){const name=`${options.runId}-${role}`;const s=JSON.parse(await docker('inspect',name))[0];assert.equal(s.State.Running,true,`${role} runtime remains alive at baseline checkpoint`);assert.equal(s.Config.Labels['coffee.issue12.realtime-soak'],options.runId);roles.push({role,containerId:s.Id,imageId:s.Image,logPath:s.LogPath});}
        const baselineReceipt={verified:true,correlationId:commandCorrelation,traceId:traceIdValue,sourceEvents:sent.length,sourceBrokerAckCount:sent.length,sourceInboxCommitted:sent.every(receipt=>receipt.state==='Processed'),sourceMessageSha256:sent.map(receipt=>receipt.messageIdSha256),projectionPresent:true,realtimeOutboxPersisted:true,sseReady:true,nodeReadiness,ownerRefetch:{status:baselineOwner.status,requestAndResponseCorrelationMatched:true,requestAndResponseTraceparentMatched:true,traceparentSha256:shortHash(traceparent)},durationsMs:{sourceKafkaAndInbox:sourceDurationMs,ownerProjectionRead:projectionDurationMs,browserSseAndOwnerRefetch:Math.round(performance.now()-browserStartedAt)},roles:roles.map(({role,containerId,imageId})=>({role,containerId,imageId,running:true}))};
        phase='baseline-observed-during-collector-outage';
        await observeBaseline(baselineReceipt);
        const command=await page.evaluate(async({orderRef,expectedVersion,correlationId,parent})=>{
          const csrf=document.cookie.split('; ').map(v=>v.trim()).find(v=>v.startsWith('__Host-coffee-csrf='))?.slice('__Host-coffee-csrf='.length);
          const response=await fetch(`/api/client-v1/orders/${orderRef}/commands/request-aroma-reconciliation`,{method:'POST',headers:{'content-type':'application/json','idempotency-key':crypto.randomUUID(),'x-correlation-id':correlationId,traceparent:parent,...(csrf?{'x-csrf-token':csrf}:{})},body:JSON.stringify({expectedVersion,reason:'G14 synthetic correlation proof'})});
          let problemCode=null;
          if(response.status>=400){
            const allowedCodes=['ORDER_VERSION_CONFLICT','AROMA_RECONCILIATION_NOT_ALLOWED','IDEMPOTENCY_CONFLICT','IDEMPOTENCY_REQUEST_IN_PROGRESS'];
            try{const problem=await response.json();problemCode=allowedCodes.includes(problem?.code)?problem.code:'other';}catch{problemCode='other';}
          }else await response.arrayBuffer();
          return {status:response.status,correlationId:response.headers.get('x-correlation-id'),problemCode};
        },{orderRef:state.orderRef,expectedVersion:card.business_version,correlationId:commandCorrelation,parent:traceparent});
        await json(join(dir,'launch-path-command-checkpoint.json'),{status:command.status,problemCode:command.problemCode,correlationMatched:command.correlationId===commandCorrelation,expectedBusinessVersionSha256:shortHash(card.business_version),projectionStateBeforeCommand:observedProjection.state,projectionVersionSha256:shortHash(observedProjection.card_version)});
        assert.equal(command.status,202,`real api-public -> Orders command failed: ${command.status}`);assert.equal(command.correlationId,commandCorrelation);
        const ownerRow=await bounded(async()=>{const rows=await f.read("SELECT message_id,message_type,topic,state,correlation_id,causation_id,traceparent FROM orders.outbox_messages WHERE message_type='OrderReconciliationRequested.v1' AND aggregate_ref=$1 AND correlation_id=$2",[state.orderRef,commandCorrelation]);return rows.length===1?rows[0]:false;},{timeout:15000,interval:100,label:'real Orders HTTP command persisted Outbox'});
        assert.equal(ownerRow.traceparent,traceparent);assert.equal(ownerRow.causation_id,null,'accepted public command is the root event in this synthetic causal chain');
        await bounded(async()=>{const rows=await f.read('SELECT state FROM orders.outbox_messages WHERE message_id=$1',[ownerRow.message_id]);return rows[0]?.state==='Published';},{timeout:20000,interval:100,label:'Orders Outbox relayed through real Kafka'});
        const prepInbox=await bounded(async()=>{const rows=await f.read("SELECT state FROM orders.inbox_messages WHERE consumer_name='orders-aroma-preparation-v1' AND message_id=$1",[ownerRow.message_id]);return rows[0]?.state==='Processed'?rows[0]:false;},{timeout:30000,interval:100,label:'real prep consumer commits command through Inbox'});
        const wakeRow=await bounded(async()=>{const rows=await f.read("SELECT message_id,message_type,topic,state,correlation_id,causation_id,traceparent FROM orders.outbox_messages WHERE message_type='AromaConvergenceRequested.v1' AND causation_id=$1 AND correlation_id=$2",[ownerRow.message_id,commandCorrelation]);return rows.length===1&&rows[0].state==='Published'?rows[0]:false;},{timeout:30000,interval:100,label:'preparation owner emits a published convergence wake caused by the accepted command'});
        assert.equal(wakeRow.state,'Published');assert.equal(wakeRow.topic,setup.config.kafka.topics.aromaCommands.name);
        assert.equal(wakeRow.correlation_id,commandCorrelation);assert.equal(wakeRow.traceparent,traceparent);
        phase='actual-convergence-kafka-inbox-and-metrics';
        const convergenceSelector={schemaVersion:1,wakeMessageId:wakeRow.message_id,rootMessageId:ownerRow.message_id,correlationId:commandCorrelation,traceparent};
        const convergenceOutput=await run('docker',['exec','-i',driver,'node','tests/observability/convergence-metrics-proof.mjs'],{input:canonicalJson(convergenceSelector),timeout:60000,outputLimit:65536});
        const convergenceReceipt=JSON.parse(convergenceOutput);assert.equal(convergenceReceipt.verified,true,'real convergence consumer, SQL store, controlled Gateway and metrics proof');
        assert.equal(convergenceReceipt.wakeReceipt.messageIdSha256,hash(wakeRow.message_id));
        assert.equal(convergenceReceipt.wakeReceipt.rootCausationSha256,hash(ownerRow.message_id));
        assert.equal(convergenceReceipt.resultRelayReceipt.wakeMessageIdSha256,hash(wakeRow.message_id));
        const helperPublishedHashes=new Set(convergenceReceipt.resultRelayReceipt.resultMessages.map(message=>message.messageIdSha256));
        await json(join(dir,'launch-path-convergence-metrics-checkpoint.json'),convergenceReceipt);
        const resultRows=await bounded(async()=>{
          const rows=await f.read("SELECT message_id,message_type,topic,state,correlation_id,causation_id,traceparent FROM orders.outbox_messages WHERE message_type IN ('AromaConvergenceChanged.v1','AromaObservationChanged.v1') AND causation_id=$1 AND correlation_id=$2 ORDER BY occurred_at,message_id",[wakeRow.message_id,commandCorrelation]);
          return rows.length&&rows.every(row=>row.state==='Published'&&row.topic===setup.config.kafka.topics.aromaEvents.name&&row.traceparent===traceparent&&helperPublishedHashes.has(hash(row.message_id)))?rows:false;
        },{timeout:15000,interval:100,label:'convergence result Outbox was acknowledged by real Kafka with wake causation'});
        assert.ok(resultRows.length>0);
        const realtimeCandidates=await bounded(async()=>{
          const rows=await f.read("SELECT invalidation.message_id,invalidation.message_type,invalidation.topic,invalidation.state,invalidation.correlation_id,invalidation.causation_id,invalidation.traceparent,result.message_id AS result_message_id,result.message_type AS result_message_type,result.causation_id AS result_causation_id,projectionInbox.state AS result_inbox_state FROM orders.outbox_messages invalidation JOIN orders.outbox_messages result ON result.message_id=invalidation.causation_id JOIN orders.inbox_messages projectionInbox ON projectionInbox.consumer_name='orders-aroma-projection-v1' AND projectionInbox.message_id=result.message_id WHERE invalidation.message_type='RealtimeInvalidated.v1' AND invalidation.aggregate_ref=$1 AND invalidation.correlation_id=$2 AND invalidation.traceparent=$3 AND result.message_type IN ('AromaConvergenceChanged.v1','AromaObservationChanged.v1') AND result.causation_id=$4 AND projectionInbox.state='Processed' ORDER BY invalidation.occurred_at DESC,invalidation.message_id DESC",[state.orderRef,commandCorrelation,traceparent,wakeRow.message_id]);
          const candidates=rows.filter(row=>row.state==='Published'&&row.result_inbox_state==='Processed'&&helperPublishedHashes.has(hash(row.result_message_id)));return candidates.length?candidates:false;
        },{timeout:30000,interval:100,label:'real Realtime invalidation caused by a Kafka-processed convergence result/observation'});
        assert.ok(realtimeCandidates.length>0,'at least one actual result event changed the projected card and was relayed');
        const candidateIds=realtimeCandidates.map(row=>row.message_id);
        await page.waitForFunction(({ids,corr})=>window.__g14Frames.some(frame=>frame.event==='resource-invalidated.v1'&&ids.includes(frame.id)&&frame.data.correlationId===corr),{ids:candidateIds,corr:commandCorrelation},{timeout:30000});
        await page.waitForFunction(({ids,corr,parent})=>window.__g14OwnerFetches.some(entry=>ids.includes(entry.frameId)&&entry.correlationId===corr&&entry.traceparent===parent&&entry.responseStatus===200&&entry.responseCorrelationId===corr&&entry.responseTraceparent===parent),{ids:candidateIds,corr:commandCorrelation,parent:traceparent},{timeout:15000});
        const browserWitnesses=await page.evaluate(()=>({frames:window.__g14Frames,fetches:window.__g14OwnerFetches}));
        const refetchWitness=[...browserWitnesses.fetches].reverse().find(entry=>candidateIds.includes(entry.frameId)&&entry.correlationId===commandCorrelation&&entry.traceparent===traceparent&&entry.responseStatus===200&&entry.responseCorrelationId===commandCorrelation&&entry.responseTraceparent===traceparent);
        assert.ok(refetchWitness,'actual HTTP 200 refetch follows one of the causally verified result frames');
        const realtimeRow=realtimeCandidates.find(row=>row.message_id===refetchWitness.frameId);
        assert.ok(realtimeRow);assert.equal(realtimeRow.traceparent,traceparent);assert.equal(realtimeRow.correlation_id,commandCorrelation);
        assert.equal(realtimeRow.result_causation_id,wakeRow.message_id,'convergence result retains the actual wake as its cause');
        assert.equal(realtimeRow.causation_id,realtimeRow.result_message_id,'Realtime invalidation is caused by the actual processed convergence result');
        const resultForRealtime=resultRows.find(row=>row.message_id===realtimeRow.result_message_id);
        assert.ok(resultForRealtime,'SSE invalidation is joined to an acknowledged convergence result Outbox record');
        const projectionRow={...resultForRealtime,inbox_state:realtimeRow.result_inbox_state};
        assert.equal(projectionRow.topic,setup.config.kafka.topics.aromaEvents.name);assert.equal(projectionRow.state,'Published');assert.equal(projectionRow.inbox_state,'Processed');
        assert.equal(projectionRow.traceparent,traceparent);assert.equal(projectionRow.correlation_id,commandCorrelation);assert.equal(projectionRow.causation_id,wakeRow.message_id);
        const serviceLogs=await docker('logs',`${options.runId}-orders-service`);const matchingLogLines=serviceLogs.split('\n').filter(line=>{try{return fieldsContain(JSON.parse(line),'correlationId',commandCorrelation);}catch{return false;}});
        assert.ok(matchingLogLines.length>0,'Orders runtime Pino logs include the actual HTTP command correlation');
        const frames=await page.evaluate(()=>window.__g14Frames),fetches=await page.evaluate(()=>window.__g14OwnerFetches);
        assert.ok(frames.some(frame=>frame.data?.correlationId===commandCorrelation));assert.ok(fetches.some(entry=>entry.correlationId===commandCorrelation&&entry.traceparent===traceparent&&entry.frameId===realtimeRow.message_id&&entry.responseStatus===200&&entry.responseCorrelationId===commandCorrelation&&entry.responseTraceparent===traceparent));
        const proof={verified:true,launchProof:false,syntheticContext:true,correlationId:commandCorrelation,traceId:traceIdValue,traceparentSha256:shortHash(traceparent),command:{status:command.status,responseCorrelationMatched:true,ownerOutboxMatched:true,traceparentMatched:true,rootCausation:true},sourceEvents:sent,sourceBrokerReceipt:sent,ownerMessageSha256:shortHash(ownerRow.message_id),ownerBrokerReceipt:{messageIdSha256:shortHash(ownerRow.message_id),state:'Published',topic:ownerRow.topic},preparationInboxCommitted:prepInbox.state==='Processed',wakeReceipt:{messageType:wakeRow.message_type,topic:wakeRow.topic,messageIdSha256:shortHash(wakeRow.message_id),state:wakeRow.state,causationMatched:wakeRow.causation_id===ownerRow.message_id,causationMessageSha256:shortHash(wakeRow.causation_id)},convergenceMetricReceipt:convergenceReceipt,projectionReceipt:{inboxState:projectionRow.inbox_state,resultMessageSha256:shortHash(projectionRow.message_id),resultCausationMatched:projectionRow.causation_id===wakeRow.message_id,resultCausationMessageSha256:shortHash(projectionRow.causation_id),realtimeMessageSha256:shortHash(realtimeRow.message_id),outboxState:realtimeRow.state,traceparentMatched:true,causationMatched:true,causationMessageSha256:shortHash(realtimeRow.causation_id)},realtimeMessageSha256:shortHash(realtimeRow.message_id),sseReceipt:{frameMatched:browserWitnesses.frames.some(frame=>frame.event==='resource-invalidated.v1'&&frame.id===realtimeRow.message_id&&frame.data.correlationId===commandCorrelation),correlationId:commandCorrelation},refetchReceipt:{matched:true,requestAndResponseCorrelationMatched:true,correlationId:commandCorrelation,traceparentSha256:shortHash(traceparent),status:refetchWitness.responseStatus,frameMessageSha256:shortHash(refetchWitness.frameId)},sseFrameMatched:true,browserRefetchMatched:true,ownerLogRecords:matchingLogLines.length,roles,expectedTelemetry:{traceIdServices:['edge-gateway','api-public','orders-service','orders-aroma-preparation','aroma-convergence','realtime-gateway'],traceSpanNames:{'edge-gateway':['HTTP GET'],'api-public':['HTTP GET','HTTP POST'],'orders-service':['HTTP GET','HTTP POST','orders.http.reconcile','orders.use_case.reconcile','orders.transaction.reconcile','orders.outbox.insert','db.transaction','Outbox.relay','Kafka.produce'],'orders-aroma-preparation':['Kafka.consume','Inbox.consumeOnce','orders.aroma_preparation.inbox','orders.aroma_preparation.recompute','orders.aroma_preparation.projection','Outbox.relay','Kafka.produce'],'aroma-convergence':['Kafka.consume','Inbox.consumeOnce','aroma.convergence.inbox','Outbox.relay','Kafka.produce'],'realtime-gateway':['Kafka.consume']},separateRealtimeSpanNames:['realtime.sse.handshake','realtime.sse.fanout'],ownerMetrics:convergenceReceipt.expectedTelemetry.ownerMetrics,nativeLogRoles:['edge-nginx'],receiptRoles:['orders-service','orders-aroma-preparation','realtime-gateway','aroma-convergence']},transport:{realKafka:true,realOrdersService:true,realOrdersAromaPreparation:true,realAromaConvergenceConsumer:true,edge:'nginx -> Edge -> api-public',browser:'served SPA native EventSource and owner fetch'},boundary:'Synthetic W3C/correlation context is explicitly injected by this fixture into the API command and browser owner refetch. The EventSource itself keeps its native request behavior; no automatic browser context propagation is claimed. Causation is proven through the accepted Orders command, preparation-published convergence wake, durable convergence Inbox, actual convergence result Outbox/Kafka, processed preparation projection Inbox and causally linked Realtime invalidation. The convergence attempt uses the existing controlled in-memory Gateway and real SQL owner state; no external provider is used. Not capacity or production proof.'};
        await json(`${dir}/launch-path-proof.json`,proof);
        await hook.observeProof(proof);
        return proof;
      }finally{await context?.close();await browser?.close();}
    },
  };
  return await runTransportFixture(options,{launchPath:hook});
});
  if(result?.error){
    const failure=new Error(`launch path failed during ${phase}: ${JSON.stringify(result.error)}`);
    if(Array.isArray(result.containerDiagnostics))failure.containerDiagnostics=result.containerDiagnostics;
    if(result.launchFailure)failure.launchFailure=result.launchFailure;
    throw failure;
  }
  assert.equal(result.cleanupVerified,true);assert.equal(result.launchPath?.verified,true);assert.equal(result.launchProof,false);
  assert.ok(proofReceipt,'verifier observes proof before fixture teardown');
  return result;
}
