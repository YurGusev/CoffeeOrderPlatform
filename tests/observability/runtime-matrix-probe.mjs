export const NODE_RUNTIME_ROLES = Object.freeze([
  'edge-gateway', 'api-public', 'api-internal', 'customer-service', 'catalog-service',
  'catalog-supplier-sync', 'catalog-activation-worker', 'pricing-service', 'orders-service',
  'orders-aroma-preparation', 'aroma-observer', 'aroma-convergence', 'aroma-gateway', 'realtime-gateway',
]);

// /metrics is the legacy text surface; OTLP process and HTTP instruments are checked separately.
export const COMMON_TEXT_FAMILIES = Object.freeze([
  'runtime_admission_rejected_total', 'telemetry_log_records_dropped_total', 'telemetry_records_dropped_total',
  'telemetry_export_failures_total', 'telemetry_serialization_rejections_total',
  'telemetry_queue_overflows_total', 'telemetry_shutdown_losses_total',
]);

export const OWNER_TEXT_FAMILIES = Object.freeze({
  'edge-gateway': [],
  'api-public': [],
  'api-internal': [],
  'customer-service': [],
  'catalog-service': [],
  'catalog-supplier-sync': [
    'coffee_catalog_import_batches_total', 'coffee_catalog_import_batch_bytes_total',
    'coffee_catalog_import_batch_duration_seconds_sum', 'coffee_catalog_import_batch_duration_seconds_count',
    'coffee_catalog_import_backpressure_seconds_sum', 'coffee_catalog_import_backpressure_seconds_count',
    'coffee_catalog_import_duration_seconds_sum', 'coffee_catalog_import_duration_seconds_count',
    'coffee_catalog_import_age_seconds', 'coffee_catalog_import_has_success', 'coffee_catalog_import_results_total',
    'coffee_catalog_import_scheduler_running', 'coffee_catalog_import_scheduler_skipped_total',
    'coffee_catalog_import_scheduler_failure',
  ],
  'catalog-activation-worker': ['coffee_catalog_activation_supervisor_up', 'coffee_catalog_activation_cycle_failed'],
  'pricing-service': [
    'coffee_pricing_quote_create_results_total', 'coffee_pricing_catalog_read_results_total',
    'coffee_pricing_quote_verify_results_total', 'coffee_pricing_catalog_retry_results_total',
    'coffee_pricing_database_results_total', 'coffee_pricing_operation_duration_ms_total',
    'coffee_pricing_operation_duration_ms_count', 'coffee_pricing_quote_line_count_total',
  ],
  'orders-service': ['coffee_orders_outbox_relay_ready'],
  'orders-aroma-preparation': [
    'coffee_aroma_preparation_inbox_results_total', 'coffee_aroma_preparation_recompute_results_total',
    'coffee_aroma_preparation_projection_results_total', 'coffee_aroma_preparation_recovery_results_total',
    'coffee_aroma_preparation_desired_revision', 'coffee_aroma_preparation_desired_age_ms',
    'coffee_aroma_preparation_ready',
  ],
  'aroma-observer': [
    'coffee_aroma_observation_results_total', 'coffee_aroma_observation_recovery_results_total',
    'coffee_aroma_observation_fence_failures_total', 'coffee_aroma_observed_age_ms',
    'coffee_aroma_observation_ready',
  ],
  'aroma-convergence': [
    'coffee_aroma_attempt_results_total', 'coffee_aroma_recovery_results_total', 'coffee_aroma_mutation_calls_total',
    'coffee_aroma_lease_failures_total', 'coffee_aroma_fence_failures_total', 'coffee_aroma_unknown_outcomes_total',
    'coffee_aroma_blockers_total', 'coffee_aroma_provider_failures_total', 'coffee_aroma_observed_age_ms',
    'coffee_aroma_convergence_ready',
  ],
  'aroma-gateway': [
    'aroma_gateway_session_attempts_total', 'aroma_gateway_session_cache_hits_total', 'aroma_gateway_session_logins_total',
    'aroma_gateway_session_failures_total', 'aroma_gateway_safe_read_attempts_total',
    'aroma_gateway_safe_read_reauthenticated_total', 'aroma_gateway_safe_read_failures_total',
    'aroma_gateway_safe_read_bytes_total', 'aroma_gateway_catalog_batches_total',
    'aroma_gateway_catalog_batch_bytes_total', 'aroma_gateway_catalog_failures_total',
    'aroma_gateway_journal_acquire_total', 'aroma_gateway_journal_dispatch_total',
    'aroma_gateway_journal_terminal_persistence_total', 'aroma_gateway_mutation_acknowledged_total',
    'aroma_gateway_mutation_rejected_total', 'aroma_gateway_mutation_unknown_total',
    'aroma_gateway_provider_latency_ms_total', 'aroma_gateway_session_results_total',
    'aroma_gateway_safe_read_results_total', 'aroma_gateway_catalog_results_total',
    'aroma_gateway_journal_states_total', 'aroma_gateway_mutation_outcomes_total',
  ],
  'realtime-gateway': [
    'coffee_realtime_connections', 'coffee_realtime_scheduled_connections', 'coffee_realtime_writing_connections',
    'coffee_realtime_writing_records', 'coffee_realtime_queue_records', 'coffee_realtime_queue_bytes',
    'coffee_realtime_ring_records', 'coffee_realtime_ring_bytes', 'coffee_realtime_slow_close_total',
    'coffee_realtime_ring_evictions_total', 'coffee_realtime_auth_close_total',
    'coffee_realtime_invalidation_attempts_total', 'coffee_realtime_invalidation_dropped_total',
    'coffee_realtime_event_loop_delay_p95_ms', 'coffee_realtime_event_loop_delay_samples',
  ],
});

export const OPTIONAL_OWNER_TEXT_FAMILIES = Object.freeze({
  'aroma-convergence': ['coffee_aroma_unknown_outcomes_current'],
});

function buildOwnerMap() {
  const owners = {};
  for (const [owner, names] of Object.entries(OWNER_TEXT_FAMILIES)) {
    for (const name of [...names, ...(OPTIONAL_OWNER_TEXT_FAMILIES[owner] ?? [])]) {
      owners[name] ??= [];
      owners[name].push(owner);
    }
  }
  return owners;
}

const OWNER_TEXT_FAMILIES_BY_NAME = buildOwnerMap();
export const OWNER_BY_TEXT_FAMILY = Object.freeze(OWNER_TEXT_FAMILIES_BY_NAME);

if (NODE_RUNTIME_ROLES.length !== 14 || Object.keys(OWNER_TEXT_FAMILIES).length !== 14 ||
    OWNER_TEXT_FAMILIES_BY_NAME.coffee_aroma_observed_age_ms?.join(',') !== 'aroma-observer,aroma-convergence') {
  throw new Error('runtime text metric ownership matrix invalid');
}

export function summarizeRuntimeProbeOutput(output, {role, nodeVersion}) {
  let value;
  try {
    const lines = String(output).trim().split('\n');
    if (lines.length !== 1) throw new Error();
    value = JSON.parse(lines[0]);
  } catch {
    throw new Error(`runtime metrics probe output invalid: ${role}`);
  }
  const keys = ['node', 'uid', 'runtime', 'liveStatus', 'readyStatus', 'metricsStatus', 'unknownStatus', 'familyCount', 'families', 'pass'];
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key)) ||
      value.runtime !== role || value.node !== `v${nodeVersion}` || value.uid !== 1000 || value.liveStatus !== 200 || value.readyStatus !== 200 ||
      value.metricsStatus !== 200 || !Number.isInteger(value.unknownStatus) || value.unknownStatus < 400 || value.unknownStatus >= 500 ||
      !Number.isInteger(value.familyCount) || value.familyCount < 1 || value.familyCount !== Object.keys(value.families ?? {}).length ||
      value.pass !== true || value.families === null || typeof value.families !== 'object' || Array.isArray(value.families)) {
    throw new Error(`runtime metrics probe assertion failed: ${role}`);
  }
  for (const [name, series] of Object.entries(value.families)) {
    if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/u.test(name) || series === null || typeof series !== 'object' ||
        !Number.isSafeInteger(series.count) || series.count < 1 ||
        (series.min !== null && !Number.isFinite(series.min)) || (series.max !== null && !Number.isFinite(series.max)) ||
        (series.min !== null && series.max !== null && series.min > series.max)) {
      throw new Error(`runtime metrics probe series invalid: ${role}`);
    }
  }
  return {
    role, status: 'PASS', nodeVersion: value.node, uid: value.uid,
    http: {live: value.liveStatus, ready: value.readyStatus, metrics: value.metricsStatus, unknown: value.unknownStatus},
    familyCount: value.familyCount,
    families: Object.fromEntries(Object.entries(value.families).sort(([left], [right]) => left.localeCompare(right))),
  };
}

export function buildRuntimeMatrixProbe({role, nodeVersion, port}) {
  if (!NODE_RUNTIME_ROLES.includes(role) || !/^\d+\.\d+\.\d+$/u.test(nodeVersion ?? '') ||
      !Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('runtime probe input invalid');
  const constants = JSON.stringify({
    role, nodeVersion, port, common: COMMON_TEXT_FAMILIES,
    owned: OWNER_TEXT_FAMILIES, optional: OPTIONAL_OWNER_TEXT_FAMILIES, ownerByFamily: OWNER_TEXT_FAMILIES_BY_NAME,
  });
  return `import {createRequire} from 'node:module';
import {readFile, stat} from 'node:fs/promises';
import {request} from 'node:https';
const matrix=${constants};
const appRequire=createRequire('/app/package.json');
const foundationRequire=createRequire(appRequire.resolve('@coffee-platform/runtime'));
const {load:parseYaml}=foundationRequire('js-yaml');
const {parseServiceTransportMaterial,verifyTransportPeer}=foundationRequire('@coffee-platform/security');
const maxBodyBytes=256*1024, timeoutMs=2000;
const secretPath=process.env.COFFEE_RUNTIME_SECRETS_FILE;
if(process.version!=='v'+matrix.nodeVersion||process.getuid?.()!==1000||process.env.RUNTIME_NAME!==matrix.role||
  Number(process.env.PORT)!==matrix.port||secretPath!=='/run/secrets/coffee-platform.yaml')throw new Error('probe configuration invalid');
const secretStat=await stat(secretPath);if((secretStat.mode&0o777)!==0o400)throw new Error('probe configuration invalid');
const document=parseYaml(await readFile(secretPath,'utf8'),{json:true});
const environment=document?.environment;
if(typeof environment!=='string'||environment.length===0)throw new Error('probe configuration invalid');
const at=(value,path)=>path.split('.').reduce((item,key)=>item!==null&&typeof item==='object'&&!Array.isArray(item)?item[key]:undefined,value);
const material=parseServiceTransportMaterial(at(document,'secrets.security.serviceTransportKeys.'+matrix.role),environment,matrix.role);
function get(path,readBody=false){return new Promise((resolve,reject)=>{
  const req=request({host:'127.0.0.1',port:matrix.port,path,method:'GET',ca:material.caPem,cert:material.certPem,key:material.keyPem,
    minVersion:'TLSv1.3',rejectUnauthorized:true,timeout:readBody?timeoutMs:900,
    checkServerIdentity:(_host,certificate)=>{try{verifyTransportPeer(certificate,environment,matrix.role);return undefined;}catch{return new Error('peer identity invalid');}}},response=>{
      let bytes=0,body='';response.on('data',chunk=>{bytes+=chunk.length;if(bytes>maxBodyBytes){req.destroy(new Error('body limit exceeded'));return;}if(readBody)body+=chunk.toString('utf8');});
      response.once('end',()=>resolve({status:response.statusCode??0,body}));
    });
  req.once('timeout',()=>req.destroy(new Error('request timed out')));req.once('error',()=>reject(new Error('request failed')));req.end();
});}
function parse(body){const families=new Map();for(const line of body.split('\\n')){if(line===''||line.startsWith('#'))continue;
  const match=/^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\\{[^{}]*\\})?\\s+([+-]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:[eE][+-]?[0-9]+)?|[+-]Inf)$/u.exec(line);
  if(!match)throw new Error('metric exposition invalid');const name=match[1],sample=match[2]==='+Inf'?Infinity:match[2]==='-Inf'?-Infinity:Number(match[2]);if(Number.isNaN(sample))throw new Error('metric value invalid');
  const item=families.get(name)??{count:0,min:null,max:null};item.count++;if(Number.isFinite(sample)){item.min=item.min===null?sample:Math.min(item.min,sample);item.max=item.max===null?sample:Math.max(item.max,sample);}families.set(name,item);
}return families;}
let output;
try{
  const [live,ready,metrics,unknown]=await Promise.all([get('/health/live'),get('/health/ready'),get('/metrics',true),get('/__issue64_runtime_matrix_unknown__')]);
  const families=parse(metrics.body),expected=[...matrix.common,...(matrix.owned[matrix.role]??[])];
  for(const name of expected)if(!families.has(name))throw new Error('expected metric family missing');
  for(const name of families.keys()){const owners=matrix.ownerByFamily[name];if(owners&&!owners.includes(matrix.role))throw new Error('foreign owner family');}
  if(live.status!==200||ready.status!==200||metrics.status!==200||unknown.status<400||unknown.status>=500)throw new Error('HTTP assertion failed');
output={node:process.version,uid:process.getuid?.()??null,runtime:matrix.role,liveStatus:live.status,readyStatus:ready.status,metricsStatus:metrics.status,
    unknownStatus:unknown.status,familyCount:families.size,families:Object.fromEntries([...families].sort(([a],[b])=>a.localeCompare(b))),pass:true};
}catch{output={node:process.version,uid:process.getuid?.()??null,runtime:matrix.role,liveStatus:0,readyStatus:0,metricsStatus:0,unknownStatus:0,familyCount:0,families:{},pass:false};}
process.stdout.write(JSON.stringify(output)+'\\n');if(!output.pass)process.exitCode=1;
`;
}
