import assert from "node:assert/strict";
import {mock} from "node:test";
import {createHourlyScheduler as realScheduler} from "../../apps/catalog-supplier-sync/dist/hourly-scheduler.js";
import {CatalogOutcomeUnknown} from "../../apps/catalog-supplier-sync/dist/reconcile-imports.js";

const mode = process.argv[2];
let composition;
let run;
let endSupervisor;
let failSupervisor;
let unavailable = false;
let incomplete = false;
let exports = 0;
/** @type {Promise<void> | undefined} */
let schedulerCompletion;
let clock = 0;
let ticks = 0;
const events = [];
const diagnostics = [];
mock.module("../../packages/platform-runtime/dist/index.js", {namedExports:{startConfiguredRuntime:async (_name, value) => {composition=value;}}});
mock.module("../../packages/platform-security/dist/index.js", {namedExports:{parseServiceTransportMaterial:() => ({})}});
mock.module("../../packages/platform-http/dist/index.js", {namedExports:{createHttpClient:() => ({close:async () => {}})}});
mock.module("../../apps/catalog-supplier-sync/dist/catalog-import-store.js", {namedExports:{createCatalogImportStore:() => ({
  listIncomplete:async () => {events.push("recover"); if (unavailable) throw new Error("DB_CONNECTION_LOST"); return incomplete ? [{snapshot_ref:"old"}] : [];},
  reject:async () => {events.push("reject-old"); incomplete=false;},
})}});
mock.module("../../apps/catalog-supplier-sync/dist/run-catalog-import.js", {namedExports:{runCatalogImport:async () => {
  events.push("export"); exports++;
  if (exports === 1) {incomplete=true; throw new CatalogOutcomeUnknown("batch");}
  if (exports === 2 && mode.startsWith("readiness")) throw new Error("SNAPSHOT_FAILED_PROVIDER_TIMEOUT");
}}});
mock.module("../../apps/catalog-supplier-sync/dist/hourly-scheduler.js", {namedExports:{createHourlyScheduler:options => ({start: (callback, signal) => {
  run=callback;
  if (mode === "scheduler-recovery") {
    schedulerCompletion = realScheduler({...options, now:() => clock, wait:async milliseconds => {
      clock += milliseconds; ticks++;
      if (ticks === 1) unavailable=true;
      if (ticks === 2) unavailable=false;
      if (ticks === 3) controller.abort();
    }}).start(callback, signal);
    return schedulerCompletion;
  }
  return new Promise((resolve, reject) => {endSupervisor=resolve; failSupervisor=reject;});
}})}});
await import("../../apps/catalog-supplier-sync/dist/main.js");
const controller = new AbortController();
await composition.configure({log:{info: value => diagnostics.push(value), error:value => diagnostics.push(value), warn:value => diagnostics.push(value)}}, controller.signal, {}, undefined, {
  config:{environment:"test", services:{"catalog-supplier-sync":{outbound:["api-internal:4051"], scheduler:{intervalMs:3600000}, deadlineMs:30000}}},
  secrets:{security:{serviceTransportKeys:{"catalog-supplier-sync":{}}}},
});
const resource = composition.resources[0];
await resource.start(controller.signal);
if (mode === "scheduler-recovery") {
  await schedulerCompletion;
  assert.equal(exports,2);
  assert.equal(ticks,3);
  assert.deepEqual(events,["recover","export","recover","recover","reject-old","export"]);
} else if (mode === "recovery") {
  await assert.rejects(run, /OutcomeUnknown/u);
  unavailable=true;
  await assert.rejects(run, /DB_CONNECTION_LOST/u, "DB loss must block the second export");
  assert.equal(exports, 1);
  unavailable=false;
  await run();
  assert.deepEqual(events, ["recover", "export", "recover", "recover", "reject-old", "export"]);
} else {
  assert.ok(composition.readinessChecks?.length, "startup recovery and supervisor need a readiness check");
  const ready = () => composition.readinessChecks.every(check => check.check(controller.signal) === true);
  assert.equal(ready(), false, "not ready before startup recovery");
  await assert.rejects(run, /OutcomeUnknown/u);
  // Recovery completed; an ordinary traversal failure is not a dead supervisor.
  assert.equal(ready(), true);
  await assert.rejects(run, /SNAPSHOT_FAILED_PROVIDER_TIMEOUT/u);
  assert.equal(ready(), true, "ordinary provider failure must not kill readiness");
  await run();
  assert.equal(ready(), true);
  if (mode === "readiness-reject") failSupervisor(new Error("fixture supervisor failed"));
  else endSupervisor();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ready(), false, "terminated supervisor must not advertise ready");
}
endSupervisor?.();
await resource.stop(controller.signal);
console.log(`composition ${mode}: PASS`);
