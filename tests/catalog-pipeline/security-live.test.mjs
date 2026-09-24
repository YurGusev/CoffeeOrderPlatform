import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import test from "node:test";
import {Client} from "pg";
import {createRuntime} from "../../packages/platform-runtime/src/index.ts";
import {CatalogTelemetry} from "../../apps/catalog-supplier-sync/dist/observability.js";
import {snapshotActivatedMessage, mappingChangedMessage} from "../../apps/catalog-activation-worker/dist/events.js";
import {createCatalogOwner, registerCatalogRoutes} from "../../apps/catalog-service/dist/http/index.js";
import {runLiveProof} from "../../scripts/db-live-proof.mjs";

const root = resolve(import.meta.dirname, "../..");
const PROVIDER_CREDENTIAL_CANARY = "SYNTHETIC_PROVIDER_CREDENTIAL_CANARY_catalog_security_7e91";
const runtimeRoleNames = [
  "coffee_catalog_api_ro",
  "coffee_catalog_import_rw",
  "coffee_catalog_activate_rw",
  "coffee_aroma_gateway_rw",
];

async function json(relativePath) {
  return JSON.parse(await readFile(resolve(root, relativePath), "utf8"));
}

function serialize(value) {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);
}

function containsCanary(value) {
  return serialize(value).includes(PROVIDER_CREDENTIAL_CANARY);
}

void test("Catalog runtime config excludes provider credentials and external-provider access", async () => {
  const catalog = await json("config/service-catalog.json");
  const roles = await json("config/database-role-map.json");
  const manifests = await Promise.all([
    "config/permissions/catalog-service.json",
    "config/permissions/catalog-supplier-sync.json",
    "config/permissions/catalog-activation-worker.json",
  ].map(json));
  const catalogRuntimes = catalog.runtimes.filter(runtime => runtime.owner === "catalog");
  const gateway = catalog.runtimes.find(runtime => runtime.name === "aroma-gateway");
  assert.ok(gateway);
  assert.deepEqual(gateway.database,{name:"coffee_platform_integration",role:"coffee_aroma_gateway_rw",access:"readwrite-session-operation-journal"});
  for(const ref of ["aroma.email","aroma.password","aroma.sessionEncryptionKey","aroma.catalogIdentityKeyV1"]) {
    assert.ok(gateway.secretRefs.includes(ref),`only the Gateway receives ${ref}`);
  }
  assert.deepEqual(catalogRuntimes.map(runtime => runtime.name).sort(), [
    "catalog-activation-worker", "catalog-service", "catalog-supplier-sync",
  ]);
  for (const runtime of catalogRuntimes) {
    assert.equal(runtime.secretRefs.some(ref => /^aroma\.(?:email|password|sessionEncryptionKey|catalogIdentityKeyV1)$/u.test(ref)), false, runtime.name);
    assert.equal(runtime.secretRefs.some(ref => /provider|supplier.*credential/iu.test(ref)), false, runtime.name);
  }
  for (const manifest of manifests) {
    assert.equal(manifest.allowNet.some(target => /aroma|provider|https?:/iu.test(target)), false, manifest.runtime);
    assert.equal(manifest.allowFsWrite.length, 0, manifest.runtime);
  }
  const catalogDb = roles.databases.find(database => database.name === "coffee_platform_catalog");
  assert.ok(catalogDb);
  assert.deepEqual(runtimeRoleNames.slice(0,3).sort(), catalogDb.runtimeRoles.map(entry => entry.role).sort());
});

void test("synthetic provider credential is absent from Catalog API errors, logs and importer telemetry", async t => {
  const logChunks = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = function (chunk, ...args) {
    logChunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    return originalWrite(chunk, ...args);
  };
  let app;
  t.after(async () => {
    try { if (app !== undefined) await app.runtimeController.closeRuntime("SIGTERM"); }
    finally { process.stdout.write = originalWrite; }
  });
  app = await createRuntime({name:"catalog-security-canary-test",host:"127.0.0.1",port:0,shutdownGraceMs:500,deadlineMs:5_000,deadlineProfiles:{defaultMs:5_000}});
  const owner = createCatalogOwner({
    search: async () => { const error = new Error(PROVIDER_CREDENTIAL_CANARY); error.code = "DB_QUERY_FAILED"; throw error; },
    pricingInput: async () => null,
  });
  registerCatalogRoutes(app, {
    verifyTransport: (_request, expected) => expected === "api-public" || expected === "api-internal",
    verifyPublicDelegation: (_token, operationId) => ({iss:"api-public",aud:"catalog-service",originalIssuer:"edge-gateway",sub:"usr_test",permissions:["catalog:read"],operationId,correlationId:"catalog-security-test",traceparent:"00-00000000000000000000000000000000-0000000000000000-00",iat:1_000,exp:2_000,jti:"jti-test",kid:"test"}),
    verifyInternalDelegation: () => { throw new Error("not used"); },
    owner,
  });
  await app.runtimeController.start();
  const response = await app.inject({method:"GET",url:"/api/client-v1/catalog/products?query=coffee",headers:{"x-actor-context":"signed-test"}});
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().code, "CATALOG_UNAVAILABLE");
  assert.equal(containsCanary(response.json()), false);

  const diagnostics = [];
  const telemetry = new CatalogTelemetry(value => diagnostics.push(value));
  await assert.rejects(() => telemetry.generation(async () => { throw new Error(PROVIDER_CREDENTIAL_CANARY); }, new AbortController().signal), error => error.message === PROVIDER_CREDENTIAL_CANARY);
  assert.equal(containsCanary(diagnostics), false);
  assert.deepEqual(diagnostics.map(({event,outcome}) => ({event,outcome})), [{event:"catalog_import",outcome:"failure"}]);
  await app.runtimeController.closeRuntime("SIGTERM");
  assert.equal(logChunks.join("").includes(PROVIDER_CREDENTIAL_CANARY), false, "Pino stdout must not contain the synthetic provider credential");
});

void test("Catalog outbox producers emit contract manifests and changed mapping facts, never product rows or canary credentials", async () => {
  const occurredAt = "2026-09-24T00:00:00.000Z";
  const snapshot = snapshotActivatedMessage({
    supplierRef:"sup_00000000000000000000000001",snapshotRef:"snp_00000000000000000000000001",snapshotRevision:"4",
    occurredAt,productCount:12,variantCount:19,offerCount:21,batchCount:3,contentHash:"a".repeat(64),
    providerCredential:PROVIDER_CREDENTIAL_CANARY,
    rows:[{productRef:"prd_00000000000000000000000001",displayName:"must-not-be-published"}],
  });
  const mapping = mappingChangedMessage({
    productRef:"prd_00000000000000000000000001",variantRef:"var_00000000000000000000000001",offerRef:"off_00000000000000000000000001",
    snapshotRevision:"4",mappingRevision:"9",mappingState:"Active",availability:"Available",occurredAt,
    providerCredential:PROVIDER_CREDENTIAL_CANARY,
    productRow:{displayName:"must-not-be-published",supplierUnitMinor:"1234"},
  });
  const snapshotSchema = await json("contracts/schemas/events/catalog-snapshot-activated.v1.schema.json");
  const mappingSchema = await json("contracts/schemas/events/catalog-mapping-changed.v2.schema.json");
  const snapshotContract = snapshotSchema.allOf[1].properties.payload;
  const mappingContract = mappingSchema.allOf[1].properties.payload;
  assert.equal(snapshotContract.additionalProperties, false);
  assert.equal(mappingContract.additionalProperties, false);
  assert.deepEqual(Object.keys(snapshot.payload).sort(), Object.keys(snapshotContract.properties).sort());
  assert.deepEqual(Object.keys(mapping.payload).sort(), Object.keys(mappingContract.properties).sort());
  assert.deepEqual(Object.keys(snapshot.payload).sort(), ["batchCount","contentHash","offerCount","productCount","snapshotRef","snapshotRevision","supplierRef","variantCount","activatedAt"].sort());
  assert.deepEqual(Object.keys(mapping.payload).sort(), ["availability","catalogSnapshotRevision","effectiveAt","mappingRevision","mappingState","offerRef","productRef","variantRef"].sort());
  assert.equal(snapshot.messageType, "CatalogSnapshotActivated.v1");
  assert.equal(mapping.messageType, "CatalogMappingChanged.v2");
  assert.equal(containsCanary(snapshot), false);
  assert.equal(containsCanary(mapping), false);
  assert.equal(serialize(snapshot).includes("must-not-be-published"), false);
  assert.equal(serialize(mapping).includes("must-not-be-published"), false);
});

void test("disposable PostgreSQL enforces owner-schema and foreign-database boundaries for all four pipeline runtimes", {
  timeout:300_000,
  skip:process.env.COFFEE_DB_LIVE_PROOF !== "1" ? "set COFFEE_DB_LIVE_PROOF=1 to run disposable PostgreSQL proof" : false,
}, async t => {
  const checked = [];
  const result = await runLiveProof({bindingProof: async ({port,roleMap,rolePasswords}) => {
    const pipelineRuntimes = roleMap.databases.flatMap(database => database.runtimeRoles
      .filter(({runtime}) => ["aroma-gateway","catalog-service","catalog-supplier-sync","catalog-activation-worker"].includes(runtime))
      .map(({runtime,role}) => ({runtime,role,database:database.name,schema:database.schema})));
    assert.deepEqual(pipelineRuntimes.map(entry => entry.role).sort(), [...runtimeRoleNames].sort());
    for (const entry of pipelineRuntimes) {
      const owner = new Client({host:"127.0.0.1",port,database:entry.database,user:entry.role,password:rolePasswords[entry.role],connectionTimeoutMillis:2_000,ssl:false});
      try {
        await owner.connect();
        const scope = await owner.query("SELECT current_database() AS database, current_user AS role, has_schema_privilege(current_user, $1, 'USAGE') AS schema_usage",[entry.schema]);
        assert.equal(scope.rows[0].database,entry.database,`${entry.runtime} must connect to its owner DB`);
        assert.equal(scope.rows[0].role,entry.role);
        assert.equal(scope.rows[0].schema_usage,true,`${entry.runtime} must have owner-schema USAGE`);
      } finally { await owner.end().catch(() => undefined); }
      const denials = [];
      const foreignDatabases = roleMap.databases.filter(database => database.name !== entry.database).map(database => database.name);
      for (const foreignDatabase of foreignDatabases) {
        const foreign = new Client({host:"127.0.0.1",port,database:foreignDatabase,user:entry.role,password:rolePasswords[entry.role],connectionTimeoutMillis:2_000,ssl:false});
        foreign.on("error",() => {});
        try {
          await assert.rejects(() => foreign.connect(),error => {
            assert.equal(error.code,"42501",`${entry.runtime} CONNECT ${foreignDatabase}`);
            denials.push({database:foreignDatabase,sqlstate:error.code});
            return true;
          });
        } finally { await foreign.end().catch(() => undefined); }
      }
      assert.equal(denials.length,foreignDatabases.length,`${entry.runtime} must be denied every foreign DB`);
      checked.push({runtime:entry.runtime,role:entry.role,ownerSchema:"USAGE",foreignDenials:denials});
    }
    return {pipelineRuntimeChecks:checked};
  }});
  t.diagnostic(JSON.stringify({pipelineRuntimeChecks:result.binding.pipelineRuntimeChecks,cleanup:result.cleanup}));
  assert.equal(result.cleanup.containerRemoved,true);
  assert.equal(result.binding.pipelineRuntimeChecks.length,4);
  for (const role of result.binding.pipelineRuntimeChecks) assert.equal(role.foreignDenials.length,4,role.runtime);
});
