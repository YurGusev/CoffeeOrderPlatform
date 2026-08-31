#!/usr/bin/env python3
from pathlib import Path
import yaml, json, sys, re
from collections import defaultdict
try:
    import jsonschema
except ImportError:
    jsonschema=None
root=Path(__file__).resolve().parents[1]
errors=[]
notes=[]

def load_yaml(rel):
    return yaml.safe_load((root/rel).read_text(encoding='utf-8'))

reg=load_yaml('M06_KAFKA_EVENT_PLATFORM/kafka-topic-registry.yml')
msg=load_yaml('M06_KAFKA_EVENT_PLATFORM/message-schema-registry.yml')
runtime=load_yaml('M20_SERVICE_ORCHESTRATION/runtime-workload-registry.yml')
policy=load_yaml('M20_SERVICE_ORCHESTRATION/service-interaction-policy.yml')
compose=load_yaml('M02_DOCKER_COMPOSE/compose-target-skeleton.yml')
roles={r['name']:r for r in runtime['roles']}
group_to_roles=defaultdict(list)
for r in runtime['roles']:
    for g in r.get('consumerGroups',[]):
        if g!='ephemeral-per-replica': group_to_roles[g].append(r['name'])

# Topic uniqueness/completeness
names=[t['name'] for t in reg['topics']]
if len(names)!=len(set(names)): errors.append('duplicate Kafka topic name')
message_schemas={m['schema'] for m in msg['messages']}
message_topics={m['topic'] for m in msg['messages']}
for t in reg['topics']:
    if not isinstance(t.get('productionPartitions'),int) or t['productionPartitions']<=0:
        errors.append(f"topic {t['name']} partitions not explicit")
    if not t.get('payloadSchemas'):
        errors.append(f"topic {t['name']} no payloadSchemas")
    for ps in t.get('payloadSchemas',[]):
        sp=root/'M06_KAFKA_EVENT_PLATFORM'/ps
        if not sp.exists(): errors.append(f"missing schema {ps}")
        if ps not in message_schemas: errors.append(f"schema {ps} not in message registry")
    for g in t.get('consumerGroups',[]):
        if g=='ephemeral-per-replica': continue
        if len(group_to_roles.get(g,[]))!=1:
            errors.append(f"consumer group {g} mapped to {group_to_roles.get(g,[])}")
    if t['name']!='coffee.realtime.invalidate.v1':
        for g in t.get('consumerGroups',[]):
            if g.startswith('realtime-'):
                errors.append(f"forbidden duplicate realtime model {t['name']}->{g}")
if message_topics-set(names): errors.append(f"message registry refers unknown topics {sorted(message_topics-set(names))}")

# Schema + positive fixtures
schema_dir=root/'M06_KAFKA_EVENT_PLATFORM/payload-schemas'
fixture_dir=root/'M06_KAFKA_EVENT_PLATFORM/fixtures/valid'
for m in msg['messages']:
    sp=root/'M06_KAFKA_EVENT_PLATFORM'/m['schema']
    fn=sp.name.replace('.schema.json','.json')
    fp=fixture_dir/fn
    if not fp.exists():
        errors.append(f"missing valid fixture {fn}")
        continue
    try:
        schema=json.loads(sp.read_text(encoding='utf-8'))
        fixture=json.loads(fp.read_text(encoding='utf-8'))
        if jsonschema:
            jsonschema.Draft202012Validator.check_schema(schema)
            jsonschema.validate(fixture,schema)
        else:
            notes.append('jsonschema package unavailable: fixture semantic validation skipped')
    except Exception as e:
        errors.append(f"fixture {fn} invalid: {type(e).__name__}: {e}")

# BIGINT/UInt64 wire guard recursively
BIG_WORDS=('version','revision','sequence','epoch')
def walk_schema(node,path):
    if isinstance(node,dict):
        props=node.get('properties',{})
        if isinstance(props,dict):
            for k,v in props.items():
                lk=k.lower()
                typ=v.get('type') if isinstance(v,dict) else None
                if any(x in lk for x in BIG_WORDS) and k!='schemaVersion':
                    if typ=='integer' or (isinstance(typ,list) and 'integer' in typ):
                        errors.append(f"{path}:{k} uses JSON integer for version/revision/sequence/epoch")
                walk_schema(v,path+'.'+k)
        for k,v in node.items():
            if k!='properties': walk_schema(v,path)
    elif isinstance(node,list):
        for v in node: walk_schema(v,path)
for p in schema_dir.glob('*.schema.json'):
    walk_schema(json.loads(p.read_text(encoding='utf-8')),p.name)

# Runtime completeness and required governance fields
required_runtime={'name','owner','executable','productionCritical','composeService','kubernetesWorkload','dbPrincipal','consumerGroups','producesTopics','allowedHttpTargets','allowedProviders','stateful','workloadKind','concurrencyPolicy','drainPolicy','networkZone','sloRef','httpSurfaces','requiredSecretClasses'}
for r in runtime['roles']:
    miss=required_runtime-set(r)
    if miss: errors.append(f"runtime {r.get('name')} missing fields {sorted(miss)}")
    if r.get('productionCritical') and r.get('composeService') not in compose.get('services',{}):
        errors.append(f"critical role {r['name']} missing compose service {r.get('composeService')}")

# Exact OpenAPI prefixes + uniqueness of operationIds
for name,prefix in [('client-v1.yaml','/api/client-v1'),('agent-v1.yaml','/api/agent-v1'),('internal-v1.yaml','/api/internal-v1')]:
    o=load_yaml('M19_API_ARCHITECTURE/openapi/'+name)
    ops=[]
    for path,verbs in o.get('paths',{}).items():
        if not path.startswith(prefix): errors.append(f"{name}: bad path {path}")
        if isinstance(verbs,dict):
            for verb,op in verbs.items():
                if verb.lower() in {'get','post','put','patch','delete','options','head'} and isinstance(op,dict) and op.get('operationId'):
                    ops.append(op['operationId'])
    if len(ops)!=len(set(ops)): errors.append(f"{name}: duplicate operationId")

# Important contract closures
client=load_yaml('M19_API_ARCHITECTURE/openapi/client-v1.yaml')
if '/api/client-v1/orders/{orderRef}/commands/add-item' not in client.get('paths',{}): errors.append('AddConfirmedOrderItem path missing')
internal=load_yaml('M19_API_ARCHITECTURE/openapi/internal-v1.yaml')
if '/api/internal-v1/channel-identities/attest' not in internal.get('paths',{}): errors.append('Channel Identity attest path missing')

# Removed indexing topics must stay removed
for forbidden in ('coffee.catalog.indexing.commands.v1','coffee.catalog.indexing.events.v1','coffee.catalog.indexing.v1'):
    if forbidden in names: errors.append(f"forbidden/deferred indexing topic present {forbidden}")

# Synchronous service graph cycle detection (exclude Kafka/outbox/DB/object/provider callback movement)
sync_modes={'http','http-internal','http-safe-read','http-idempotent-adapter','http-get-mutate-get','provider-http','provider-http-safe-read'}
g=defaultdict(set)
for e in policy.get('allowedEdges',[]):
    if e.get('mode') in sync_modes:
        g[e['from']].add(e['to'])
state={}
stack=[]
def dfs(n):
    state[n]=1; stack.append(n)
    for m in g.get(n,()):
        if state.get(m)==1:
            errors.append('sync cycle: '+' -> '.join(stack+[m])); return
        if state.get(m,0)==0: dfs(m)
    stack.pop(); state[n]=2
for n in list(g):
    if state.get(n,0)==0: dfs(n)

# Required payment inbound/outbound distinction
edges={(e['from'],e['to'],e['mode']) for e in policy.get('allowedEdges',[])}
if ('payment-provider','payments-webhook','provider-webhook') not in edges: errors.append('PSP -> payments-webhook edge missing')
if ('payments-order-consumer','payment-provider','provider-http') not in edges: errors.append('Payments -> PSP create edge missing')

# Artifact and invoice self-contained schema markers
for rel,keys in {
 'M06_KAFKA_EVENT_PLATFORM/payload-schemas/invoice-materialization-requested.v1.schema.json':['allocationManifest','wholesaleOrderSnapshot'],
 'M06_KAFKA_EVENT_PLATFORM/payload-schemas/invoice-prices-applied.v1.schema.json':['priceProofManifest','orderProofs']}.items():
    o=json.loads((root/rel).read_text(encoding='utf-8'))
    props=o.get('properties',{})
    for k in keys:
        if k not in props: errors.append(f"{rel} missing {k}")

if errors:
    print('SEMANTIC VALIDATION: FAIL')
    for e in errors: print('-',e)
    sys.exit(1)
print('SEMANTIC VALIDATION: PASS')
print('topics',len(reg['topics']),'messageSchemas',len(msg['messages']),'runtimeRoles',len(runtime['roles']),'fixtures',len(list(fixture_dir.glob('*.json'))))
for n in sorted(set(notes)): print('NOTE:',n)
