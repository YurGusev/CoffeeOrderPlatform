import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import yaml from "js-yaml";

const root = resolve(import.meta.dirname, "../..");
const baseline = {
  openapi: "3.2.0",
  info: { title: "fixture", version: "1" },
  paths: {
    "/items": {
      get: {
        operationId: "getItems",
        "x-audience": "browser",
        responses: { 200: { description: "ok" } },
      },
    },
  },
  components: {
    schemas: {
      Item: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
          state: { type: "string", enum: ["A", "B"] },
        },
      },
    },
  },
};

async function red(
  mutator,
  withOptionalEvidence = false,
  withNarrowingEvidence = false,
  narrowingFixtureValue = "0",
) {
  const directory = await mkdtemp(join(tmpdir(), "contracts-breaking-"));
  const base = join(directory, "base");
  const current = join(directory, "current");
  for (const path of [base, current])
    await mkdir(join(path, "contracts/openapi"), { recursive: true });
  const changed = structuredClone(baseline);
  mutator(changed);
  await writeFile(
    join(base, "contracts/openapi/client-v1.yaml"),
    yaml.dump(baseline),
  );
  await writeFile(
    join(current, "contracts/openapi/client-v1.yaml"),
    yaml.dump(changed),
  );
  if (withOptionalEvidence) {
    await mkdir(join(current, "contracts/fixtures/positive/http"), {
      recursive: true,
    });
    await writeFile(
      join(current, "contracts/fixtures/positive/http/optional-note.json"),
      JSON.stringify({ id: "1", note: "evidence" }),
    );
    await writeFile(
      join(current, "contracts/compatibility-evidence.yaml"),
      yaml.dump({
        optionalExpansions: [
          {
            schemaPath: "contracts/openapi/client-v1.yaml",
            location: "contracts/openapi/client-v1.yaml#Item",
            property: "note",
            fixture: "contracts/fixtures/positive/http/optional-note.json",
          },
        ],
      }),
    );
  }
  if (withNarrowingEvidence) {
    await mkdir(join(current, "contracts/fixtures/negative/http"), {
      recursive: true,
    });
    await mkdir(join(current, "docs/launch"), { recursive: true });
    await writeFile(
      join(current, "contracts/fixtures/negative/http/narrow-id.json"),
      JSON.stringify({
        case: "narrow-id",
        id: narrowingFixtureValue,
        expectedKeyword: "pattern",
      }),
    );
    await writeFile(
      join(current, "docs/launch/narrow-id.md"),
      "# Narrow ID migration\n",
    );
    await writeFile(
      join(current, "contracts/compatibility-evidence.yaml"),
      yaml.dump({
        narrowingCorrections: [
          {
            schemaPath: "contracts/openapi/client-v1.yaml",
            location: "contracts/openapi/client-v1.yaml#Item.id",
            keyword: "pattern",
            before: null,
            after: "^[1-9]$",
            issue: 10,
            reason:
              "Correct a pre-runtime request constraint before provider integration.",
            migration: "docs/launch/narrow-id.md",
            fixture: "contracts/fixtures/negative/http/narrow-id.json",
            fixtureCase: "narrow-id",
            fixtureValuePointer: "/id",
            expectedKeyword: "pattern",
          },
        ],
      }),
    );
  }
  const result = spawnSync(
    process.execPath,
    ["scripts/contracts-breaking.mjs", "--base", base, "--current", current],
    { cwd: root, encoding: "utf8" },
  );
  await rm(directory, { recursive: true, force: true });
  return result;
}

async function realSourceRed(sourcePath, mutator) {
  const text = await readFile(join(root, sourcePath), "utf8");
  const source = sourcePath.endsWith(".json")
    ? JSON.parse(text)
    : yaml.load(text);
  const directory = await mkdtemp(join(tmpdir(), "contracts-breaking-real-"));
  const base = join(directory, "base");
  const current = join(directory, "current");
  for (const path of [base, current])
    await mkdir(join(path, dirname(sourcePath)), { recursive: true });
  const changed = structuredClone(source);
  mutator(changed);
  const encode = sourcePath.endsWith(".json")
    ? (value) => JSON.stringify(value)
    : (value) => yaml.dump(value);
  await writeFile(join(base, sourcePath), encode(source));
  await writeFile(join(current, sourcePath), encode(changed));
  const result = spawnSync(
    process.execPath,
    ["scripts/contracts-breaking.mjs", "--base", base, "--current", current],
    { cwd: root, encoding: "utf8" },
  );
  await rm(directory, { recursive: true, force: true });
  return result;
}

async function runCatalogCallerExpansion(
  mutateOpenApi = () => {},
  mutateAudience = () => {},
) {
  const directory = await mkdtemp(
    join(tmpdir(), "contracts-breaking-catalog-caller-"),
  );
  const base = join(directory, "base");
  const current = join(directory, "current");
  const route =
    "/api/internal-v1/catalog/products/{productRef}/variants/{variantRef}/pricing-input";
  const before = {
    "x-audience": "pricing-service",
    "x-caller": "pricing-service",
    "x-callers": ["pricing-service"],
    "x-auth": "mTLS-and-signed-delegation",
  };
  const after = {
    "x-audience": ["pricing-service", "aroma-convergence"],
    "x-caller": null,
    "x-callers": ["pricing-service", "aroma-convergence"],
    "x-auth":
      "mTLS; signed-delegation for pricing-service; scoped-mTLS identity for aroma-convergence",
  };
  const document = (trust) => ({
    openapi: "3.2.0",
    info: { title: "internal", version: "1" },
    paths: {
      [route]: {
        get: {
          operationId: "getCatalogPricingInput",
          ...trust,
          security: [{ serviceMTLS: [] }],
          responses: { 200: { description: "ok" } },
        },
      },
    },
    components: {
      schemas: {},
      parameters: {},
      responses: {},
      headers: {},
      securitySchemes: {},
    },
  });
  const manifestEntry = (audience) => ({
    id: "getCatalogPricingInput",
    kind: "http",
    owner: "catalog",
    operation: `GET ${route}`,
    statuses: [200],
    audience,
    producers: ["api-internal"],
    consumers: ["catalog-service"],
    pii: "none",
    secrets: "forbidden",
    compatibility: "additive",
  });
  const evidence = {
    approvedInternalCallerExpansions: [
      {
        schemaPath: "contracts/openapi/internal-v1.yaml",
        route,
        operationId: "getCatalogPricingInput",
        operationBefore: before,
        operationAfter: after,
        manifestBefore: "pricing-service",
        manifestAfter: ["pricing-service", "aroma-convergence"],
        issue: 11,
        migration: "docs/launch/19_AROMA_CONVERGENCE_IMPLEMENTATION_SPEC.md",
        proof: "tests/catalog/catalog-root.test.mjs",
      },
    ],
  };
  try {
    for (const root of [base, current])
      await mkdir(join(root, "contracts/openapi"), { recursive: true });
    await mkdir(join(current, "contracts"), { recursive: true });
    await mkdir(join(current, "docs/launch"), { recursive: true });
    await mkdir(join(current, "tests/catalog"), { recursive: true });
    const oldDocument = document(before);
    const newDocument = document(after);
    const nextManifest = {
      contracts: [manifestEntry(["pricing-service", "aroma-convergence"])],
    };
    mutateOpenApi(newDocument.paths[route].get);
    mutateAudience(nextManifest.contracts[0]);
    await writeFile(
      join(base, "contracts/openapi/internal-v1.yaml"),
      yaml.dump(oldDocument),
    );
    await writeFile(
      join(base, "contracts/manifest.yaml"),
      yaml.dump({ contracts: [manifestEntry("pricing-service")] }),
    );
    await writeFile(
      join(current, "contracts/openapi/internal-v1.yaml"),
      yaml.dump(newDocument),
    );
    await writeFile(
      join(current, "contracts/manifest.yaml"),
      yaml.dump(nextManifest),
    );
    await writeFile(
      join(current, "contracts/compatibility-evidence.yaml"),
      yaml.dump(evidence),
    );
    await writeFile(
      join(current, "docs/launch/19_AROMA_CONVERGENCE_IMPLEMENTATION_SPEC.md"),
      "# Approved Catalog owner proof\n",
    );
    await writeFile(
      join(current, "tests/catalog/catalog-root.test.mjs"),
      "test proof\n",
    );
    return spawnSync(
      process.execPath,
      ["scripts/contracts-breaking.mjs", "--base", base, "--current", current],
      { cwd: root, encoding: "utf8" },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const realClientRed = (mutator) =>
  realSourceRed("contracts/openapi/client-v1.yaml", mutator);

void test("breaking guard rejects endpoint/schema/status/operation rename and schema narrowing", async () => {
  for (const mutation of [
    (document) => {
      delete document.paths["/items"];
    },
    (document) => {
      delete document.paths["/items"].get.responses[200];
    },
    (document) => {
      document.paths["/items"].get.operationId = "listItems";
    },
    (document) => {
      delete document.components.schemas.Item;
    },
    (document) => {
      document.components.schemas.Item.required.push("state");
    },
    (document) => {
      delete document.components.schemas.Item.properties.state;
    },
    (document) => {
      document.components.schemas.Item.properties.state.type = "number";
    },
    (document) => {
      document.components.schemas.Item.properties.state.enum.pop();
    },
    (document) => {
      document.components.schemas.Item.properties.note = { type: "string" };
    },
  ]) {
    const result = await red(mutation);
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /breaking contract/);
  }
});

void test("Confirm response expansion guard rejects an unapproved ref replacement", async () => {
  const result = await realClientRed((document) => {
    document.paths[
      "/api/client-v1/orders/{orderRef}/commands/confirm"
    ].post.responses["422"] = {
      $ref: "#/components/responses/SomeOtherResponse",
    };
  });
  assert.notEqual(result.status, 0, `${result.stdout}\\n${result.stderr}`);
  assert.match(result.stderr, /breaking contract.*response \$ref changed/);
});

void test("approved #11 pricing grind terminal schema expands command recovery only with its 422 fixture", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "contracts-breaking-pricing-recovery-"),
  );
  const base = join(directory, "base");
  const current = join(directory, "current");
  const sourcePath = "contracts/openapi/client-v1.yaml";
  const operationId = "createPricingQuote";
  const previous = {
    openapi: "3.2.0",
    info: { title: "client", version: "1" },
    "x-command-recovery": {
      terminalSchemas: { [operationId]: ["PricingQuoteResponse"] },
    },
  };
  const next = structuredClone(previous);
  next["x-command-recovery"].terminalSchemas[operationId].push(
    "ErrorPricingGrindNotAvailable",
  );
  const evidence = {
    approvedCommandRecoveryExpansions: [
      {
        schemaPath: sourcePath,
        operationId,
        addedTerminalSchema: "ErrorPricingGrindNotAvailable",
        issue: 11,
        fixture: "contracts/fixtures/positive/http/problems.json",
        fixtureCase: "ErrorPricingGrindNotAvailable",
      },
    ],
  };
  try {
    for (const path of [base, current])
      await mkdir(join(path, "contracts/openapi"), { recursive: true });
    await mkdir(join(current, "contracts/fixtures/positive/http"), {
      recursive: true,
    });
    await writeFile(join(base, sourcePath), yaml.dump(previous));
    await writeFile(join(current, sourcePath), yaml.dump(next));
    await writeFile(
      join(current, "contracts/compatibility-evidence.yaml"),
      yaml.dump(evidence),
    );
    const fixture = [
      {
        document: "client-v1",
        operationId,
        status: 422,
        schema: "ErrorPricingGrindNotAvailable",
      },
    ];
    const fixturePath = join(
      current,
      evidence.approvedCommandRecoveryExpansions[0].fixture,
    );
    await writeFile(fixturePath, JSON.stringify(fixture));
    const run = () =>
      spawnSync(
        process.execPath,
        [
          "scripts/contracts-breaking.mjs",
          "--base",
          base,
          "--current",
          current,
        ],
        { cwd: root, encoding: "utf8" },
      );
    const accepted = run();
    assert.equal(accepted.status, 0, `${accepted.stdout}\n${accepted.stderr}`);
    next["x-command-recovery"].terminalSchemas[operationId].push(
      "ErrorFuturePricingFailure",
    );
    await writeFile(join(current, sourcePath), yaml.dump(next));
    const rejected = run();
    assert.notEqual(
      rejected.status,
      0,
      `${rejected.stdout}\n${rejected.stderr}`,
    );
    assert.match(
      rejected.stderr,
      /command recovery (protocol changed|expansion lacks matching evidence)/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("breaking guard admits optional expansion only with fixture and policy evidence", async () => {
  const result = await red((document) => {
    document.components.schemas.Item.properties.note = { type: "string" };
  }, true);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

void test("Catalog search 400 admits only the source INVALID_CURSOR branch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "contracts-catalog-cursor-"));
  const base = join(directory, "base");
  const current = join(directory, "current");
  const sourcePath = "contracts/openapi/client-v1.yaml";
  try {
    for (const path of [base, current])
      await mkdir(join(path, "contracts/openapi"), { recursive: true });
    const previous = structuredClone(baseline);
    const route = previous.paths["/items"];
    delete previous.paths["/items"];
    previous.paths["/api/client-v1/catalog/products"] = route;
    route.get.operationId = "searchCatalogProducts";
    route.get.responses[400] = {
      $ref: "#/components/responses/ValidationFailed",
    };
    previous.components.responses = {
      ValidationFailed: { description: "Invalid request" },
    };
    await writeFile(join(base, sourcePath), yaml.dump(previous));
    const next = structuredClone(previous);
    const variant = { $ref: "#/components/schemas/ErrorInvalidCursor" };
    next.paths["/api/client-v1/catalog/products"].get.responses[400] = {
      description: "Invalid query or cursor.",
      content: {
        "application/problem+json": {
          schema: {
            oneOf: [
              { $ref: "#/components/schemas/ErrorValidationFailed" },
              variant,
            ],
          },
        },
      },
    };
    const runVariant = async () => {
      await writeFile(join(current, sourcePath), yaml.dump(next));
      return spawnSync(
        process.execPath,
        [
          "scripts/contracts-breaking.mjs",
          "--base",
          base,
          "--current",
          current,
        ],
        { cwd: root, encoding: "utf8" },
      );
    };
    const accepted = await runVariant();
    assert.equal(accepted.status, 0, `${accepted.stdout}\n${accepted.stderr}`);
    variant.$ref = "#/components/schemas/ErrorInternalError";
    const rejected = await runVariant();
    assert.notEqual(
      rejected.status,
      0,
      `${rejected.stdout}\n${rejected.stderr}`,
    );
    assert.match(rejected.stderr, /response \$ref changed/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("breaking guard admits only an exact narrowing correction with migration evidence", async () => {
  const accepted = await red(
    (document) => {
      document.components.schemas.Item.properties.id.pattern = "^[1-9]$";
    },
    false,
    true,
  );
  assert.equal(accepted.status, 0, `${accepted.stdout}\n${accepted.stderr}`);
  const different = await red(
    (document) => {
      document.components.schemas.Item.properties.id.pattern = "^[1-8]$";
    },
    false,
    true,
  );
  assert.notEqual(
    different.status,
    0,
    `${different.stdout}\n${different.stderr}`,
  );
  assert.match(different.stderr, /breaking contract/);
  const ineffective = await red(
    (document) => {
      document.components.schemas.Item.properties.id.pattern = "^[1-9]$";
    },
    false,
    true,
    "7",
  );
  assert.notEqual(
    ineffective.status,
    0,
    `${ineffective.stdout}\n${ineffective.stderr}`,
  );
  assert.match(ineffective.stderr, /breaking contract/);
});

void test("approved #8 private Pricing verify replacement permits only the pinned contract", async () => {
  const sourcePath = "contracts/openapi/internal-v1.yaml";
  const baseText = spawnSync("git", ["show", `origin/develop:${sourcePath}`], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(baseText.status, 0, baseText.stderr);
  const currentText = await readFile(join(root, sourcePath), "utf8");
  const evidence = yaml.load(
    await readFile(join(root, "contracts/compatibility-evidence.yaml"), "utf8"),
  );
  const directory = await mkdtemp(join(tmpdir(), "contracts-orders-verify-"));
  const base = join(directory, "base"),
    current = join(directory, "current");
  const run = () =>
    spawnSync(
      process.execPath,
      ["scripts/contracts-breaking.mjs", "--base", base, "--current", current],
      { cwd: root, encoding: "utf8" },
    );
  try {
    for (const path of [base, current])
      await mkdir(join(path, "contracts/openapi"), { recursive: true });
    await mkdir(join(current, "docs/launch"), { recursive: true });
    await mkdir(join(current, "tests/pricing"), { recursive: true });
    await mkdir(join(current, "tests/catalog"), { recursive: true });
    await writeFile(join(base, sourcePath), baseText.stdout);
    await writeFile(join(current, sourcePath), currentText);
    await writeFile(
      join(current, "contracts/compatibility-evidence.yaml"),
      yaml.dump(evidence),
    );
    for (const fixture of new Set(
      (evidence.optionalExpansions ?? []).map((entry) => entry.fixture),
    )) {
      await mkdir(join(current, dirname(fixture)), { recursive: true });
      await writeFile(
        join(current, fixture),
        await readFile(join(root, fixture), "utf8"),
      );
    }
    await writeFile(
      join(current, "docs/launch/16_PRICING_IMPLEMENTATION_SPEC.md"),
      await readFile(
        join(root, "docs/launch/16_PRICING_IMPLEMENTATION_SPEC.md"),
        "utf8",
      ),
    );
    await writeFile(
      join(current, "docs/launch/19_AROMA_CONVERGENCE_IMPLEMENTATION_SPEC.md"),
      await readFile(
        join(root, "docs/launch/19_AROMA_CONVERGENCE_IMPLEMENTATION_SPEC.md"),
        "utf8",
      ),
    );
    await writeFile(
      join(current, "tests/pricing/pricing-store.test.mjs"),
      await readFile(
        join(root, "tests/pricing/pricing-store.test.mjs"),
        "utf8",
      ),
    );
    await writeFile(
      join(current, "tests/catalog/catalog-root.test.mjs"),
      await readFile(join(root, "tests/catalog/catalog-root.test.mjs"), "utf8"),
    );
    const accepted = run();
    assert.equal(accepted.status, 0, `${accepted.stdout}\n${accepted.stderr}`);
    for (const mutation of [
      (schema) => {
        schema.properties.quoteLineNumber.maximum = 99;
      },
      (schema) => {
        schema.properties.sourceGrindKeyHash = { type: "number" };
      },
      (schema) => {
        schema.properties.sourceGrindKeyHash = {
          $ref: "#/components/schemas/Quantity",
        };
      },
      (schema) => {
        schema.required.push("sourceGrindKeyHash");
      },
    ]) {
      const tampered = yaml.load(currentText);
      mutation(tampered.components.schemas.PricingQuoteVerifyRequest);
      await writeFile(join(current, sourcePath), yaml.dump(tampered));
      const rejected = run();
      assert.notEqual(
        rejected.status,
        0,
        `${rejected.stdout}\n${rejected.stderr}`,
      );
      assert.match(rejected.stderr, /breaking contract/u);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("approved #11 Catalog pricing caller expansion admits only convergence and rejects trust drift", async () => {
  const accepted = await runCatalogCallerExpansion();
  assert.equal(accepted.status, 0, `${accepted.stdout}\n${accepted.stderr}`);
  for (const [mutateOpenApi, mutateAudience] of [
    [
      (operation) => {
        operation["x-callers"].push("aroma-observer");
      },
      () => {},
    ],
    [
      (operation) => {
        operation["x-callers"].push("future-service");
      },
      () => {},
    ],
    [
      (operation) => {
        operation["x-auth"] =
          "mTLS; signed-delegation for pricing-service; mTLS identity for any caller";
      },
      () => {},
    ],
    [
      () => {},
      (entry) => {
        entry.audience.push("future-service");
      },
    ],
  ]) {
    const rejected = await runCatalogCallerExpansion(
      mutateOpenApi,
      mutateAudience,
    );
    assert.notEqual(
      rejected.status,
      0,
      `trust metadata mutation was accepted: ${rejected.stdout}\n${rejected.stderr}`,
    );
    assert.match(rejected.stderr, /breaking contract/u);
  }
});

void test("breaking guard admits a same-wire parameter ref replacement with a wider schema", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "contracts-breaking-parameter-ref-"),
  );
  const base = join(directory, "base");
  const current = join(directory, "current");
  const document = {
    openapi: "3.2.0",
    info: { title: "fixture", version: "1" },
    paths: {
      "/items": {
        get: {
          operationId: "getItems",
          parameters: [{ $ref: "#/components/parameters/Cursor" }],
          responses: { 200: { description: "ok" } },
        },
      },
    },
    components: {
      parameters: {
        Cursor: {
          name: "cursor",
          in: "query",
          required: false,
          schema: { type: "string", maxLength: 512 },
        },
      },
    },
  };
  const changed = structuredClone(document);
  changed.paths["/items"].get.parameters[0].$ref =
    "#/components/parameters/CustomerCursor";
  changed.components.parameters.CustomerCursor = {
    name: "cursor",
    in: "query",
    required: false,
    schema: { type: "string", maxLength: 2048 },
  };
  for (const [root, value] of [
    [base, document],
    [current, changed],
  ]) {
    await mkdir(join(root, "contracts/openapi"), { recursive: true });
    await writeFile(
      join(root, "contracts/openapi/client-v1.yaml"),
      yaml.dump(value),
    );
  }
  const result = spawnSync(
    process.execPath,
    ["scripts/contracts-breaking.mjs", "--base", base, "--current", current],
    { cwd: root, encoding: "utf8" },
  );
  await rm(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

void test("breaking guard admits making a query parameter optional", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "contracts-breaking-query-optionality-"),
  );
  const base = join(directory, "base");
  const current = join(directory, "current");
  const document = {
    openapi: "3.2.0",
    info: { title: "fixture", version: "1" },
    paths: {
      "/items": {
        get: {
          operationId: "getItems",
          parameters: [
            {
              name: "query",
              in: "query",
              required: true,
              schema: { type: "string", minLength: 2 },
            },
          ],
          responses: { 200: { description: "ok" } },
        },
      },
    },
  };
  const changed = structuredClone(document);
  changed.paths["/items"].get.parameters[0].required = false;
  for (const [root, value] of [
    [base, document],
    [current, changed],
  ]) {
    await mkdir(join(root, "contracts/openapi"), { recursive: true });
    await writeFile(
      join(root, "contracts/openapi/client-v1.yaml"),
      yaml.dump(value),
    );
  }
  const result = spawnSync(
    process.execPath,
    ["scripts/contracts-breaking.mjs", "--base", base, "--current", current],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const tightened = spawnSync(
    process.execPath,
    ["scripts/contracts-breaking.mjs", "--base", current, "--current", base],
    { cwd: root, encoding: "utf8" },
  );
  assert.notEqual(
    tightened.status,
    0,
    `${tightened.stdout}\n${tightened.stderr}`,
  );
  assert.match(tightened.stderr, /parameter required changed/u);
  await rm(directory, { recursive: true, force: true });
});

void test("breaking guard rejects event schema, key and envelope changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "contracts-breaking-event-"));
  const base = join(directory, "base");
  const current = join(directory, "current");
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    required: ["messageId", "payload"],
    properties: {
      messageId: { type: "string", const: "message.v1" },
      payload: {
        type: "object",
        required: ["orderRef"],
        properties: { orderRef: { type: "string" } },
      },
    },
  };
  const manifest = {
    contracts: [
      {
        id: "OrderConfirmed.v1",
        kind: "event",
        owner: "orders",
        operation: "coffee.orders.lifecycle.v1",
        key: "orderRef",
      },
    ],
  };
  for (const path of [base, current]) {
    await mkdir(join(path, "contracts/schemas/events"), { recursive: true });
    await mkdir(join(path, "contracts"), { recursive: true });
    await writeFile(
      join(path, "contracts/schemas/events/order.schema.json"),
      JSON.stringify(schema),
    );
    await writeFile(join(path, "contracts/manifest.yaml"), yaml.dump(manifest));
  }
  const changedSchema = structuredClone(schema);
  changedSchema.properties.messageId.const = "message.v2";
  await writeFile(
    join(current, "contracts/schemas/events/order.schema.json"),
    JSON.stringify(changedSchema),
  );
  let result = spawnSync(
    process.execPath,
    ["scripts/contracts-breaking.mjs", "--base", base, "--current", current],
    { cwd: root, encoding: "utf8" },
  );
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);

  await writeFile(
    join(current, "contracts/schemas/events/order.schema.json"),
    JSON.stringify(schema),
  );
  const changedManifest = structuredClone(manifest);
  changedManifest.contracts[0].key = "messageId";
  await writeFile(
    join(current, "contracts/manifest.yaml"),
    yaml.dump(changedManifest),
  );
  result = spawnSync(
    process.execPath,
    ["scripts/contracts-breaking.mjs", "--base", base, "--current", current],
    { cwd: root, encoding: "utf8" },
  );
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /breaking contract/);

  changedManifest.contracts = [];
  await writeFile(
    join(current, "contracts/manifest.yaml"),
    yaml.dump(changedManifest),
  );
  result = spawnSync(
    process.execPath,
    ["scripts/contracts-breaking.mjs", "--base", base, "--current", current],
    { cwd: root, encoding: "utf8" },
  );
  await rm(directory, { recursive: true, force: true });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

for (const [name, mutation, expected] of [
  [
    "response ref change",
    (document) => {
      document.paths["/api/client-v1/customers"].post.responses["201"].content[
        "application/json"
      ].schema.$ref = "#/components/schemas/OrderCardResponse";
    },
  ],
  [
    "required idempotency parameter weakening",
    (document) => {
      document.components.parameters.IdempotencyKey.required = false;
    },
  ],
  [
    "component ref change",
    (document) => {
      document.components.schemas.CustomerRef.$ref =
        "../schemas/common/money-version-time.v1.schema.json#/$defs/MoneyMinor";
    },
  ],
  [
    "security removal",
    (document) => {
      document.paths["/api/client-v1/customers"].post.security = [];
    },
  ],
  [
    "array bound narrowing",
    (document) => {
      document.components.schemas.PricingQuoteCreateRequest.properties.lines.maxItems = 1;
    },
  ],
  [
    "shared response schema ref change",
    (document) => {
      document.components.responses.ValidationFailed.content[
        "application/problem+json"
      ].schema.$ref = "#/components/schemas/OrderCardResponse";
    },
  ],
  [
    "shared header const change",
    (document) => {
      document.components.headers.IdempotencyReplayed.schema.const = false;
    },
  ],
  [
    "operation parameter removal",
    (document) => {
      document.paths["/api/client-v1/customers"].post.parameters.shift();
    },
  ],
  [
    "enum addition narrowing",
    (document) => {
      document.components.schemas.CustomerResponse.properties.displayName.enum =
        ["Only"];
    },
  ],
  [
    "security scheme change",
    (document) => {
      document.components.securitySchemes.bearerAuth.scheme = "basic";
    },
  ],
  [
    "request body required change",
    (document) => {
      document.paths["/api/client-v1/customers"].post.requestBody.required =
        true;
    },
    /createCustomer request body required changed/,
  ],
  [
    "boolean response schema",
    (document) => {
      document.paths["/api/client-v1/customers"].post.responses["201"].content[
        "application/json"
      ].schema = false;
    },
    /createCustomer:201\.content\.application\/json: boolean schema changed/,
  ],
]) {
  void test(`breaking guard rejects real client ${String(name)}`, async () => {
    const result = await realClientRed(mutation);
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /breaking contract/);
    if (expected) assert.match(result.stderr, expected);
  });
}

void test("breaking guard rejects removing the real envelope version const", async () => {
  const result = await realSourceRed(
    "contracts/schemas/common/message-envelope.v1.schema.json",
    (document) => {
      delete document.$defs.MessageEnvelope.properties.envelopeVersion.const;
    },
  );
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(
    result.stderr,
    /MessageEnvelope\.envelopeVersion: const changed/,
  );
});
