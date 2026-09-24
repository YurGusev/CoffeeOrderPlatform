import assert from "node:assert/strict";
import test from "node:test";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {resolve} from "node:path";

const run = promisify(execFile);
void test("100 000 distinct offers cross bounded NDJSON batches with backpressure and a fixed RSS regression budget", {timeout:300_000}, async t => {
  const started = performance.now();
  const {stdout} = await run(process.execPath,
    ["--expose-gc","--max-old-space-size=96",resolve("tests/catalog-pipeline/capacity-child.mjs")],
    {cwd:resolve("."),timeout:290_000,maxBuffer:1024 * 1024});
  const receipt = JSON.parse(stdout);
  assert.equal(receipt.offers,100_000);
  assert.equal(receipt.uniqueIdentities,100_000);
  assert.equal(receipt.batches,200);
  assert.equal(receipt.batchSize,500);
  assert.ok(receipt.maxObservedBatchBytes <= receipt.maxAllowedBatchBytes);
  assert.equal(receipt.upstreamPaused,true);
  assert.ok(receipt.rssGrowthBytes < receipt.rssGrowthBudgetBytes);
  assert.match(receipt.wireSha256,/^[a-f0-9]{64}$/u);
  // This capacity proof measures streaming/import memory, not activation's SQL materialization.
  t.diagnostic(JSON.stringify({...receipt,durationMs:Math.round(performance.now()-started)}));
});
