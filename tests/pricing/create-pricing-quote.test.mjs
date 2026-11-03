import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { canonicalRequestHash } from "../../packages/platform-idempotency/dist/index.js";
import {
  createPricingQuote,
  previewCatalogPrices,
} from "../../apps/pricing-service/dist/application/create-pricing-quote.js";

const ref = (prefix, n = 1) => `${prefix}_${String(n).padStart(26, "0")}`;
const request = (n = 1) => ({
  customerRef: ref("cus"),
  lines: Array.from({ length: n }, (_, i) => ({
    productRef: ref("prd", i + 1),
    variantRef: ref("var", i + 1),
    quantity: "2.500",
  })),
});
const command = (n = 1) => ({
  request: request(n),
  identity: { actorRef: "actor", scope: "a".repeat(64), key: randomUUID() },
  correlationId: randomUUID(),
  signDelegation: () => "signed-delegation",
});
const fact = (line, revision = "1") => ({
  productRef: line.productRef,
  variantRef: line.variantRef,
  offerRef: ref("off"),
  snapshotRevision: revision,
  supplierUnitMinor: "100",
  currency: "RUB",
  unit: "piece",
  availability: "Available",
  mappingRevision: "2",
  displayName: "Coffee",
});
const policy = {
  policyVersionRef: ref("pvr"),
  version: "1",
  currency: "RUB",
  markupBasisPoints: 3000,
  minimumMarginMinor: "0",
  quoteTtlSeconds: 900,
  quantityScale: 3,
  roundingMode: "CEILING",
};
const result = {
  status: 201,
  body: { quoteRef: ref("prq"), lines: [] },
  replayed: false,
};
const fixture = (precheck = { kind: "not_retained" }) => {
  const calls = { precheck: [], catalog: [], create: [], policy: 0 };
  const store = {
    async precheck(...args) {
      calls.precheck.push(args);
      return precheck;
    },
    async readActivePolicy() {
      calls.policy++;
      return policy;
    },
    async create(input) {
      calls.create.push(input);
      return result;
    },
  };
  const catalog = {
    async getPricingInput(input) {
      calls.catalog.push(input);
      return fact(input);
    },
  };
  return { calls, store, catalog };
};

void test("normalizes ordered quantities for precheck hash and persists only after Catalog", async () => {
  const { calls, store, catalog } = fixture();
  const input = command(2);
  assert.equal(await createPricingQuote(store, catalog, input), result);
  assert.deepEqual(calls.precheck[0].slice(0, 2), [
    input.identity,
    canonicalRequestHash({
      customerRef: input.request.customerRef,
      lines: input.request.lines.map((line) => ({ ...line, quantity: "2.5" })),
    }),
  ]);
  assert.equal(calls.catalog.length, 2);
  assert.equal(calls.catalog[0].delegation, "signed-delegation");
  assert.deepEqual(
    calls.create[0].lines.map((line) => line.quantity),
    ["2.5", "2.5"],
  );
  assert.equal(calls.create[0].lines[0].offerRef, ref("off"));
  assert.equal(calls.create[0].lines[0].supplierUnitMinor, "100");
  assert.equal(calls.create[0].catalogSnapshotRevision, "1");
  assert.equal(calls.create[0].signal instanceof AbortSignal, true);
});

void test("completed replay, conflict and expired Acquired stop before policy or Catalog", async () => {
  for (const [precheck, expected] of [
    [{ kind: "completed", ...result, replayed: true }, "replay"],
    [{ kind: "conflict" }, "IDEMPOTENCY_CONFLICT"],
    [{ kind: "in_progress" }, "IDEMPOTENCY_REQUEST_IN_PROGRESS"],
  ]) {
    const { calls, store, catalog } = fixture(precheck);
    if (expected === "replay")
      assert.deepEqual(await createPricingQuote(store, catalog, command()), {
        status: 201,
        body: result.body,
        replayed: true,
      });
    else
      await assert.rejects(createPricingQuote(store, catalog, command()), {
        code: expected,
      });
    assert.equal(calls.catalog.length, 0);
    assert.equal(calls.policy, 0);
    assert.equal(calls.create.length, 0);
  }
});

void test("invalid quantity and duplicate pair reject before precheck", async () => {
  const { calls, store, catalog } = fixture();
  await assert.rejects(
    createPricingQuote(store, catalog, {
      ...command(),
      request: {
        ...request(),
        lines: [{ ...request().lines[0], quantity: "0" }],
      },
    }),
    { code: "VALIDATION_FAILED" },
  );
  await assert.rejects(
    createPricingQuote(store, catalog, {
      ...command(),
      request: {
        ...request(),
        lines: [request().lines[0], request().lines[0]],
      },
    }),
    { code: "VALIDATION_FAILED" },
  );
  assert.equal(calls.precheck.length, 0);
});

void test("grind membership is checked against Catalog and distinguishes idempotency and quote lines", async () => {
  const option = { sourceGrindKeyHash: "a".repeat(64), displayName: "Средний" };
  const selected = {
    productRef: ref("prd"),
    variantRef: ref("var"),
    quantity: "2.500",
    sourceGrindKeyHash: option.sourceGrindKeyHash,
  };
  const input = {
    ...command(),
    request: {
      customerRef: ref("cus"),
      lines: [
        selected,
        { ...selected, sourceGrindKeyHash: undefined, quantity: "1" },
      ],
    },
  };
  delete input.request.lines[1].sourceGrindKeyHash;
  const { store, catalog, calls } = fixture();
  catalog.getPricingInput = async (request) => ({
    ...fact(request),
    grindOptions: [option],
  });
  await createPricingQuote(store, catalog, input);
  assert.equal(calls.create[0].lines[0].grindDisplayName, "Средний");
  assert.equal("sourceGrindKeyHash" in calls.create[0].lines[1], false);
  assert.notEqual(
    calls.precheck[0][1],
    canonicalRequestHash({
      ...input.request,
      lines: input.request.lines.map((line) => ({
        productRef: line.productRef,
        variantRef: line.variantRef,
        quantity: line.quantity,
      })),
    }),
  );
  const unknown = fixture();
  unknown.catalog.getPricingInput = async (request) => ({
    ...fact(request),
    grindOptions: [],
  });
  await assert.rejects(
    createPricingQuote(unknown.store, unknown.catalog, {
      ...command(),
      request: { customerRef: ref("cus"), lines: [selected] },
    }),
    { code: "PRICING_GRIND_NOT_AVAILABLE" },
  );
  assert.equal(unknown.calls.create.length, 0);
});

void test("duplicate Catalog grind metadata is rejected before quote persistence", async () => {
  const { calls, store, catalog } = fixture();
  const option = {
    sourceGrindKeyHash: "a".repeat(64),
    displayName: "Средний",
  };
  catalog.getPricingInput = async (input) => {
    calls.catalog.push(input);
    return {
      ...fact(input),
      grindOptions: [option, { ...option }],
    };
  };

  await assert.rejects(createPricingQuote(store, catalog, command()), {
    code: "CATALOG_UNAVAILABLE",
  });
  assert.equal(calls.catalog.length, 1);
  assert.equal(calls.create.length, 0);
});

void test("Catalog rejects signed supplier cost and stopped offers before persistence", async () => {
  for (const [override, expectedCode] of [
    [{ supplierUnitMinor: "-1" }, "CATALOG_UNAVAILABLE"],
    [{ availability: "Stopped" }, "CATALOG_PRODUCT_UNAVAILABLE"],
  ]) {
    const { calls, store, catalog } = fixture();
    catalog.getPricingInput = async (input) => {
      calls.catalog.push(input);
      return { ...fact(input), ...override };
    };

    await assert.rejects(createPricingQuote(store, catalog, command()), {
      code: expectedCode,
    });
    assert.equal(calls.catalog.length, 1);
    assert.equal(calls.create.length, 0);
  }
});

void test("bounds simultaneous Catalog requests to eight and retains order", async () => {
  const { calls, store, catalog } = fixture();
  let active = 0,
    max = 0;
  catalog.getPricingInput = async (input) => {
    active++;
    max = Math.max(max, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active--;
    calls.catalog.push(input);
    return fact(input);
  };
  await createPricingQuote(store, catalog, command(24));
  assert.equal(max, 8);
  assert.deepEqual(
    calls.create[0].lines.map((line) => line.productRef),
    request(24).lines.map((line) => line.productRef),
  );
});

void test("mixed snapshot repeats whole group once then persists homogeneous second group", async () => {
  const { calls, store, catalog } = fixture();
  const retries = [];
  catalog.getPricingInput = async (input) => {
    calls.catalog.push(input);
    return fact(input, calls.catalog.length === 1 ? "1" : "2");
  };
  await createPricingQuote(store, catalog, {
    ...command(2),
    onCatalogRetry: (outcome) => retries.push(outcome),
  });
  assert.equal(calls.catalog.length, 4);
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].catalogSnapshotRevision, "2");
  assert.deepEqual(retries, ["recovered"]);
});

void test("second mixed group fails tagged without persistence", async () => {
  const { calls, store, catalog } = fixture();
  const retries = [];
  catalog.getPricingInput = async (input) => {
    calls.catalog.push(input);
    return fact(input, input.productRef === ref("prd", 1) ? "1" : "2");
  };
  await assert.rejects(
    createPricingQuote(store, catalog, {
      ...command(2),
      onCatalogRetry: (outcome) => retries.push(outcome),
    }),
    { code: "CATALOG_REVISION_CHANGED" },
  );
  assert.equal(calls.catalog.length, 4);
  assert.equal(calls.create.length, 0);
  assert.deepEqual(retries, ["mixed"]);
});

void test("caller cancellation reaches Catalog children and never creates", async () => {
  const { calls, store, catalog } = fixture();
  const controller = new AbortController();
  catalog.getPricingInput = async (input) => {
    calls.catalog.push(input);
    await new Promise((_, reject) =>
      input.signal.addEventListener(
        "abort",
        () => reject(input.signal.reason),
        { once: true },
      ),
    );
  };
  const running = createPricingQuote(store, catalog, {
    ...command(12),
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(new Error("cancelled")), 5);
  await assert.rejects(running, /cancelled/);
  assert.equal(calls.catalog.length <= 8, true);
  assert.equal(
    calls.catalog.every((input) => input.signal.aborted),
    true,
  );
  assert.equal(calls.create.length, 0);
});

void test("rejects invalid private facts without leaking them into errors or public result", async () => {
  const { calls, store, catalog } = fixture();
  catalog.getPricingInput = async (input) => ({
    ...fact(input),
    supplierUnitMinor: "SECRET-SUPPLIER-CANARY",
  });
  await assert.rejects(
    createPricingQuote(store, catalog, command()),
    (error) => {
      assert.equal(error.code, "CATALOG_UNAVAILABLE");
      assert.equal(
        JSON.stringify(error).includes("SECRET-SUPPLIER-CANARY"),
        false,
      );
      return true;
    },
  );
  assert.equal(calls.create.length, 0);
  const ok = fixture();
  const response = await createPricingQuote(ok.store, ok.catalog, command());
  assert.equal(JSON.stringify(response).includes("supplierUnitMinor"), false);
  assert.equal(JSON.stringify(response).includes("offerRef"), false);
  assert.equal(JSON.stringify(response).includes("mappingRevision"), false);
});

const previewCommand = (n = 1) => ({
  ...command(n),
  request: {
    snapshotRevision: "1",
    items: request(n).lines.map(({ productRef, variantRef }) => ({
      productRef,
      variantRef,
    })),
  },
  signal: new AbortController().signal,
});

void test("catalog price preview reads one policy, computes exact amounts and bounds 50 reads without writes", async () => {
  const { calls, store, catalog } = fixture();
  let active = 0,
    peak = 0;
  catalog.getPricingInput = async (input) => {
    calls.catalog.push(input);
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setImmediate(resolve));
    active--;
    return { ...fact(input), supplierUnitMinor: "101" };
  };
  const preview = await previewCatalogPrices(
    store,
    catalog,
    previewCommand(50),
  );
  assert.equal(calls.policy, 1);
  assert.equal(calls.catalog.length, 50);
  assert.equal(peak, 8);
  assert.equal(preview.policyVersionRef, policy.policyVersionRef);
  assert.equal(preview.items[0].supplierUnitMinor, "101");
  assert.equal(preview.items[0].saleUnitMinor, "132");
  assert.equal(preview.items[0].currency, "RUB");
  assert.deepEqual(calls.precheck, []);
  assert.deepEqual(calls.create, []);
  const empty = fixture();
  assert.deepEqual(
    (await previewCatalogPrices(empty.store, empty.catalog, previewCommand(0)))
      .items,
    [],
  );
  assert.equal(empty.calls.policy, 1);
  assert.equal(empty.calls.catalog.length, 0);
  store.readActivePolicy = async () => ({
    ...policy,
    minimumMarginMinor: "100",
  });
  assert.equal(
    (await previewCatalogPrices(store, catalog, previewCommand())).items[0]
      .saleUnitMinor,
    "201",
  );
});

void test("catalog price preview rejects request money, duplicates, limits, wrong refs, revisions and overflow", async () => {
  const pair = previewCommand().request.items[0];
  for (const request of [
    { snapshotRevision: "1", items: [pair, pair] },
    previewCommand(51).request,
    { snapshotRevision: "1", items: [{ ...pair, supplierUnitMinor: "1" }] },
    {
      snapshotRevision: "1",
      items: [pair],
      policyVersionRef: policy.policyVersionRef,
    },
  ]) {
    const { calls, store, catalog } = fixture();
    await assert.rejects(
      previewCatalogPrices(store, catalog, { ...previewCommand(), request }),
      { code: "VALIDATION_FAILED" },
    );
    assert.equal(calls.policy, 0);
    assert.equal(calls.catalog.length, 0);
  }
  for (const [change, code] of [
    [{ productRef: ref("prd", 99) }, "CATALOG_UNAVAILABLE"],
    [{ variantRef: ref("var", 99) }, "CATALOG_UNAVAILABLE"],
    [{ snapshotRevision: "2" }, "CATALOG_REVISION_CHANGED"],
    [{ availability: "Unavailable" }, "CATALOG_PRODUCT_UNAVAILABLE"],
    [{ supplierUnitMinor: "9223372036854775807" }, "CATALOG_UNAVAILABLE"],
    [{ supplierUnitMinor: "9223372036854775808" }, "CATALOG_UNAVAILABLE"],
  ]) {
    const { calls, store, catalog } = fixture();
    catalog.getPricingInput = async (input) => ({ ...fact(input), ...change });
    await assert.rejects(
      previewCatalogPrices(store, catalog, previewCommand()),
      { code },
    );
    assert.deepEqual(calls.create, []);
    assert.deepEqual(calls.precheck, []);
  }
  const mixed = fixture();
  mixed.catalog.getPricingInput = async (input) =>
    fact(input, input.productRef === ref("prd", 1) ? "1" : "2");
  await assert.rejects(
    previewCatalogPrices(mixed.store, mixed.catalog, previewCommand(2)),
    { code: "CATALOG_REVISION_CHANGED" },
  );
});

void test("catalog price preview preserves cancellation and unavailable policy without writes", async () => {
  const { calls, store, catalog } = fixture();
  const controller = new AbortController();
  controller.abort(new Error("caller deadline"));
  await assert.rejects(
    previewCatalogPrices(store, catalog, {
      ...previewCommand(),
      signal: controller.signal,
    }),
    /caller deadline/u,
  );
  assert.equal(calls.policy, 0);
  store.readActivePolicy = async () => {
    throw Object.assign(new Error("policy unavailable"), {
      code: "PRICING_POLICY_UNAVAILABLE",
    });
  };
  await assert.rejects(previewCatalogPrices(store, catalog, previewCommand()), {
    code: "PRICING_POLICY_UNAVAILABLE",
  });
  assert.equal(calls.catalog.length, 0);
  assert.deepEqual(calls.create, []);
  assert.deepEqual(calls.precheck, []);
});
