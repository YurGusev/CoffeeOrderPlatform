import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  chmod,
  access,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { generateKeyPairSync, createSign } from "node:crypto";
import { chromium } from "playwright";
import { load } from "js-yaml";
import { createRuntime } from "../../../packages/platform-runtime/dist/index.js";
import {
  parseServiceTransportMaterial,
  verifyActorContextWithKeySet,
} from "../../../packages/platform-security/dist/index.js";
import {
  createConfiguredEdgeAuthAdapters,
  createEdgeAuthComposition,
} from "../../../apps/edge-gateway/dist/index.js";
import { createOidcAuthority } from "../../../apps/edge-gateway/dist/oidc-auth.js";
import { clientV1BrowserOperations } from "../../../apps/edge-gateway/dist/client-operations.gen.js";
import {
  createConfiguredPublicAdapters,
  registerPublicRoutes,
} from "../../../apps/api-public/dist/index.js";
import {
  customerSummary,
  orderCard,
  runServedBrowser,
} from "../../../apps/web/test/operator-flow.spec.ts";

export async function runServedProof() {
  const root = resolve(import.meta.dirname, "../../..");
  const evidence =
    process.env.WEB_SERVED_EVIDENCE ??
    resolve(process.env.TMPDIR ?? "/dev/shm", `web-served-${process.pid}`);
  await mkdir(evidence, { recursive: true });
  const tmpfs = await mkdtemp("/dev/shm/coffee-served-");
  await chmod(tmpfs, 0o755);
  const network = `coffee-served-${process.pid}`;
  const image = `coffee-edge-nginx:served-${process.pid}`;
  const port = 30000 + (process.pid % 10000);
  const origin = `https://localhost:${port}`;
  const receipts = [];
  const apps = [];
  let container,
    browser,
    networkCreated = false,
    imageBuilt = false;
  const run = (command, args, options = {}) => {
    const result = spawnSync(command, args, {
      cwd: root,
      encoding: "utf8",
      timeout: 300_000,
      ...options,
    });
    if (result.status !== 0)
      throw new Error(
        `${command} failed (${result.status}): ${result.stderr ?? ""}`,
      );
    return result.stdout;
  };
  const docker = (...args) => run("docker", args);
  const ssl = (...args) =>
    run("openssl", args, { cwd: tmpfs, stdio: "ignore" });
  const safe = [];
  try {
    // The native Docker build is the production SPA authority, not a stale local dist.
    const buildOutput = run("pnpm", [
      "image:build",
      "--target",
      "edge-nginx",
      "--tag",
      image,
      "--load",
      ".",
    ]);
    imageBuilt = true;
    await writeFile(join(evidence, "native-build.log"), buildOutput);
    await writeFile(
      join(evidence, "native-image.json"),
      JSON.stringify(
        {
          image,
          digest: docker(
            "image",
            "inspect",
            "--format",
            "{{.Id}}",
            image,
          ).trim(),
        },
        null,
        2,
      ),
    );
    docker("network", "create", network);
    networkCreated = true;
    const gateway = JSON.parse(docker("network", "inspect", network))[0].IPAM
      .Config[0].Gateway;
    ssl(
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      "ca.key",
      "-out",
      "ca.crt",
      "-subj",
      "/CN=isolated-served-ca",
      "-days",
      "1",
    );
    for (const [name, san, usage] of [
      ["public", "DNS:localhost", "serverAuth"],
      [
        "client",
        "URI:spiffe://coffee-platform/development/edge-nginx",
        "clientAuth",
      ],
      [
        "edge",
        "DNS:edge-gateway.development.svc.coffee-platform.internal,URI:spiffe://coffee-platform/development/edge-gateway",
        "serverAuth",
      ],
      [
        "api",
        "DNS:api-public.development.svc.coffee-platform.internal,URI:spiffe://coffee-platform/development/api-public",
        "serverAuth",
      ],
    ]) {
      await writeFile(
        join(tmpfs, `${name}.ext`),
        `subjectAltName=${san}\nextendedKeyUsage=${usage}\n`,
      );
      ssl(
        "req",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        `${name}.key`,
        "-out",
        `${name}.csr`,
        "-subj",
        `/CN=${name}`,
      );
      ssl(
        "x509",
        "-req",
        "-in",
        `${name}.csr`,
        "-CA",
        "ca.crt",
        "-CAkey",
        "ca.key",
        "-CAcreateserial",
        "-out",
        `${name}.crt`,
        "-days",
        "1",
        "-extfile",
        `${name}.ext`,
      );
      await chmod(join(tmpfs, `${name}.key`), 0o600);
    }
    const caPem = await readFile(join(tmpfs, "ca.crt"), "utf8");
    const nginxSecrets = join(tmpfs, "nginx-only");
    await mkdir(nginxSecrets, { mode: 0o755 });
    for (const file of [
      "public.key",
      "public.crt",
      "client.key",
      "client.crt",
    ]) {
      await writeFile(
        join(nginxSecrets, file),
        await readFile(join(tmpfs, file)),
        { mode: 0o644 },
      );
    }
    await writeFile(join(nginxSecrets, "upstream-ca.crt"), caPem);
    await writeFile(
      join(evidence, "tls-mount-scope.json"),
      JSON.stringify(
        {
          files: [
            "public.key",
            "public.crt",
            "client.key",
            "client.crt",
            "upstream-ca.crt",
          ],
          excluded: ["ca.key", "edge.key", "api.key"],
          privateSourceMode: "0600",
          scopedNginxReadable: true,
        },
        null,
        2,
      ),
    );
    const config = load(
      await readFile(join(root, "config/platform.yaml"), "utf8"),
    );
    const configContainer = docker("create", image).trim();
    try {
      docker(
        "cp",
        `${configContainer}:/etc/nginx/nginx.conf`,
        join(tmpfs, "nginx.conf"),
      );
    } finally {
      docker("rm", configContainer);
      receipts.push({
        kind: "config-container",
        handle: configContainer,
        absent:
          spawnSync("docker", ["inspect", configContainer], { stdio: "ignore" })
            .status !== 0,
      });
    }
    const edgeKeys = generateKeyPairSync("ed25519");
    const apiKeys = generateKeyPairSync("ed25519");
    const idpKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const publicPem = edgeKeys.publicKey.export({
      type: "spki",
      format: "pem",
    });
    const context = {
      config,
      secrets: {
        security: {
          actorContextEdgeSigningPrivateKey: edgeKeys.privateKey.export({
            type: "pkcs8",
            format: "pem",
          }),
          apiPublicDelegationSigningPrivateKey: apiKeys.privateKey.export({
            type: "pkcs8",
            format: "pem",
          }),
          actorContextEdgeVerificationPublicKeys: {
            active: publicPem,
            previous: publicPem,
          },
        },
      },
    };
    const permissions = [
      ...new Set(
        clientV1BrowserOperations.flatMap((operation) =>
          "permission" in operation ? [operation.permission] : [],
        ),
      ),
    ];
    const attempts = new Map();
    const profile = {
      issuer: "https://oidc.fixture.invalid",
      clientId: "served-fixture",
      authorizationUrl: "https://oidc.fixture.invalid/authorize",
      tokenUrl: "https://oidc.fixture.invalid/token",
      jwksUrl: "https://oidc.fixture.invalid/keys",
      redirectUri: `${origin}/auth/callback`,
      allowedAlgorithms: ["RS256"],
    };
    let resolvedActor = { actorRef: "served-operator", permissions };
    let expiryNow = Date.now();
    const oidcOptions = {
      profile,
      resolveActor: () => resolvedActor,
      fetch: async (input, init) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (url === profile.jwksUrl)
          return Response.json({
            keys: [
              {
                ...idpKeys.publicKey.export({ format: "jwk" }),
                kid: "served-idp",
                alg: "RS256",
                use: "sig",
              },
            ],
          });
        assert.equal(url, profile.tokenUrl);
        const params = new URLSearchParams(init.body);
        const nonce = attempts.get(params.get("code"));
        assert.ok(nonce);
        assert.equal(params.get("redirect_uri"), profile.redirectUri);
        assert.ok(params.get("code_verifier"));
        const now = Math.floor(Date.now() / 1000);
        const data = [
          { alg: "RS256", kid: "served-idp", typ: "JWT" },
          {
            iss: profile.issuer,
            aud: profile.clientId,
            sub: "isolated-idp-subject",
            nonce,
            iat: now,
            exp: now + 3600,
          },
        ]
          .map((v) => Buffer.from(JSON.stringify(v)).toString("base64url"))
          .join(".");
        const signer = createSign("RSA-SHA256");
        signer.update(data);
        signer.end();
        return Response.json({
          id_token: `${data}.${signer.sign(idpKeys.privateKey).toString("base64url")}`,
        });
      },
    };
    let authority = createOidcAuthority(oidcOptions),
      clockLane = "default",
      recordedDefaultClock = false;
    const trackedAuthority = {
      session: (...args) => authority.session(...args),
      verifyCsrf: (...args) => authority.verifyCsrf(...args),
      logout: (...args) => authority.logout(...args),
      begin: async (returnTo) => {
        const attempt = await authority.begin(returnTo);
        attempts.set(
          attempt.state,
          new URL(attempt.authorizationUrl).searchParams.get("nonce"),
        );
        return attempt;
      },
      complete: async (...args) => {
        const result = await authority.complete(...args);
        let temporalError;
        try {
          Temporal.Instant.fromEpochMilliseconds(result.expiresAt);
        } catch (error) {
          temporalError = { name: error.name, message: error.message };
        }
        if (clockLane === "expiry-fixture" || !recordedDefaultClock) {
          await writeFile(
            join(
              evidence,
              clockLane === "default"
                ? "session-clock-causal.json"
                : "session-clock-expiry-fixture.json",
            ),
            JSON.stringify(
              {
                expiresAt: result.expiresAt,
                integer: Number.isInteger(result.expiresAt),
                temporalError,
                productionAuthorityClock:
                  clockLane === "default"
                    ? "default (no now override)"
                    : "distinct authority injectable now fixture",
              },
              null,
              2,
            ),
          );
          recordedDefaultClock = true;
        }
        return result;
      },
    };
    let card = orderCard(),
      failures = {},
      conflict = false,
      held,
      releaseHeld;
    const controls = {
      actor: (actorRef, selectedPermissions = permissions) => {
        resolvedActor = { actorRef, permissions: selectedPermissions };
      },
      failures: (next) => {
        failures = next;
      },
      reset: () => {
        card = orderCard("2", "Draft", true);
        failures = {};
        conflict = false;
      },
      conflict: () => {
        conflict = true;
      },
      divergentProjection: () => {
        card = orderCard("2", "Confirmed", true);
        failures = {};
      },
      olderProjection: () => {
        card = orderCard("1", "Draft", true);
        failures = {};
      },
      hold: () => {
        held = new Promise((resolve) => {
          releaseHeld = resolve;
        });
      },
      release: () => {
        releaseHeld?.();
        held = undefined;
      },
      records: () => safe,
      expiry: async () => {
        await apps[0].runtimeController.closeRuntime("SIGTERM");
        clockLane = "expiry-fixture";
        expiryNow = Date.now();
        authority = createOidcAuthority({
          ...oidcOptions,
          now: () => expiryNow,
        });
        await startRuntime("edge-gateway", 4000, "edge", true);
      },
      expire: () => {
        expiryNow += 900001;
      },
    };
    const ownerClient = (owner) => ({
      fetch: async (path, options) => {
        try {
          const headers = new Headers(options.headers);
          const token =
            headers.get("x-service-delegation") ??
            headers.get("x-actor-context");
          assert.ok(token);
          const actor = verifyActorContextWithKeySet(token, {
            publicKeys: [apiKeys.publicKey],
            issuer: "api-public",
            audience: owner,
            nowEpochSeconds: Math.floor(Date.now() / 1000),
            clockSkewSeconds: 0,
          });
          assert.equal(actor.correlationId, headers.get("x-correlation-id"));
          assert.equal(actor.originalIssuer, "edge-gateway");
          const expectedOperations = {
            "customer-service": ["searchCustomers", "createCustomer"],
            "catalog-service": ["searchCatalogProducts"],
            "pricing-service": ["createPricingQuote", "previewCatalogPrices"],
            "orders-service": [
              "getOrderCard",
              "createOrderDraft",
              "upsertOrderItem",
              "confirmOrder",
              "requestAromaReconciliation",
            ],
          };
          assert.ok(expectedOperations[owner].includes(actor.operationId));
          if (
            (options.method ?? "GET") !== "GET" &&
            actor.operationId !== "previewCatalogPrices"
          )
            assert.match(
              headers.get("idempotency-key") ?? "",
              /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
            );
          safe.push({
            owner,
            operation: actor.operationId,
            method: options.method ?? "GET",
            correlationId: actor.correlationId,
            replayOnly: headers.get("idempotency-replay-only") === "true",
            keyPresent: headers.has("idempotency-key"),
          });
          const problem = (status, code) =>
            Response.json(
              {
                type: "about:blank",
                title: code,
                status,
                code,
                detail: "isolated authority fixture",
                instance: new URL(path, "https://fixture.invalid").pathname,
                correlationId: actor.correlationId,
                errors: [],
              },
              {
                status,
                headers: {
                  "content-type": "application/problem+json",
                  "x-correlation-id": actor.correlationId,
                  "cache-control": "no-store",
                },
              },
            );
          const failure = failures[actor.operationId];
          if (failure) {
            if (failure === 503) throw new Error("isolated owner unavailable");
            return problem(
              failure,
              failure === 404 ? "ORDER_NOT_FOUND" : "ACTOR_CONTEXT_INVALID",
            );
          }
          if (conflict && actor.operationId === "upsertOrderItem") {
            conflict = false;
            card = orderCard("4", "Draft", true);
            return problem(409, "ORDER_VERSION_CONFLICT");
          }
          let body,
            status = 200;
          const request = options.body ? JSON.parse(options.body) : undefined;
          if (owner === "customer-service") {
            assert.ok(
              ["searchCustomers", "createCustomer"].includes(actor.operationId),
            );
            body =
              actor.operationId === "searchCustomers"
                ? { items: [customerSummary()], nextCursor: null }
                : {
                    ...customerSummary(),
                    createdAt: "2026-09-28T12:00:00.000Z",
                    updatedAt: "2026-09-28T12:00:00.000Z",
                  };
            if (actor.operationId === "createCustomer") status = 201;
          } else if (owner === "catalog-service") {
            assert.equal(actor.operationId, "searchCatalogProducts");
            body = {
              snapshotRevision: "7",
              items: [
                {
                  productRef: "prd_01ARZ3NDEKTSV4RRFFQ69G5FAV",
                  variantRef: "var_01ARZ3NDEKTSV4RRFFQ69G5FAV",
                  displayName: "Капучино",
                  unit: "piece",
                  availability: "Available",
                  mappingAvailable: true,
                  grindOptions: [],
                },
              ],
              nextCursor: null,
            };
          } else if (
            owner === "pricing-service" &&
            actor.operationId === "previewCatalogPrices"
          ) {
            body = {
              snapshotRevision: request.snapshotRevision,
              policyVersionRef: "pvr_01ARZ3NDEKTSV4RRFFQ69G5FAV",
              items: request.items.map((item) => ({
                ...item,
                unit: "piece",
                supplierUnitMinor: "100",
                saleUnitMinor: "130",
                currency: "RUB",
              })),
            };
          } else if (owner === "pricing-service") {
            assert.equal(actor.operationId, "createPricingQuote");
            status = 201;
            body = {
              quoteRef: "prq_01ARZ3NDEKTSV4RRFFQ69G5FAV",
              policyVersionRef: "pvr_01ARZ3NDEKTSV4RRFFQ69G5FAV",
              catalogSnapshotRevision: "7",
              customerRef: customerSummary().customerRef,
              createdAt: "2026-09-28T12:00:00.000Z",
              expiresAt: "2030-01-01T00:10:00.000Z",
              currency: "RUB",
              lines: [
                {
                  lineNumber: 1,
                  productRef: "prd_01ARZ3NDEKTSV4RRFFQ69G5FAV",
                  variantRef: "var_01ARZ3NDEKTSV4RRFFQ69G5FAV",
                  productDisplayName: "Капучино",
                  quantity: request.lines[0].quantity,
                  unit: "piece",
                  unitMinor: "25000",
                  lineTotalMinor: "50000",
                },
              ],
              totalMinor: "50000",
              hash: "a".repeat(64),
            };
          } else {
            assert.ok(
              [
                "getOrderCard",
                "createOrderDraft",
                "upsertOrderItem",
                "confirmOrder",
                "requestAromaReconciliation",
              ].includes(actor.operationId),
            );
            if (actor.operationId === "createOrderDraft") {
              card = orderCard();
              status = 201;
            }
            if (actor.operationId === "upsertOrderItem")
              card = orderCard("2", "Draft", true);
            if (actor.operationId === "confirmOrder")
              card = orderCard("3", "Confirmed", true, "OutOfSync");
            body = card;
            if (actor.operationId === "requestAromaReconciliation") {
              status = 202;
              body = {
                orderRef: card.orderRef,
                orderVersion: card.version,
                requestedAt: new Date().toISOString(),
                aromaState: "PendingObservation",
              };
            }
          }
          if (
            held &&
            actor.operationId === "upsertOrderItem" &&
            headers.get("idempotency-replay-only") !== "true"
          )
            await held;
          return Response.json(body, {
            status,
            headers: {
              "x-correlation-id": actor.correlationId,
              "cache-control": "no-store",
            },
          });
        } catch (error) {
          safe.push({ owner, error: error.name, message: error.message });
          throw error;
        }
      },
    });
    const startRuntime = async (
      name,
      portNumber,
      certName,
      replacing = false,
    ) => {
      const material = parseServiceTransportMaterial(
        JSON.stringify({
          keyPem: await readFile(join(tmpfs, `${certName}.key`), "utf8"),
          certPem: await readFile(join(tmpfs, `${certName}.crt`), "utf8"),
          caPem,
        }),
        "development",
        name,
      );
      const app = await createRuntime({
        name,
        host: gateway,
        port: portNumber,
        shutdownGraceMs: 1000,
        deadlineMs: 5000,
        deadlineProfiles: { defaultMs: 5000 },
        transport: {
          environment: "development",
          runtime: name,
          mode: "mtls",
          material,
        },
      });
      if (replacing) apps[0] = app;
      else apps.push(app);
      if (name === "edge-gateway")
        await createEdgeAuthComposition(
          createConfiguredEdgeAuthAdapters(context, trackedAuthority, origin),
        ).configure(
          app,
          new AbortController().signal,
          undefined,
          undefined,
          context,
        );
      else
        registerPublicRoutes(
          app,
          createConfiguredPublicAdapters(
            context,
            ownerClient("customer-service"),
            ownerClient("catalog-service"),
            ownerClient("pricing-service"),
            ownerClient("orders-service"),
          ),
        );
      await app.runtimeController.start();
    };
    await startRuntime("edge-gateway", 4000, "edge");
    await startRuntime("api-public", 4050, "api");
    container = docker(
      "run",
      "--detach",
      "--read-only",
      "--user",
      "101:101",
      "--network",
      network,
      "--add-host",
      `edge-gateway:${gateway}`,
      "--add-host",
      `api-public:${gateway}`,
      "--add-host",
      `realtime-gateway:${gateway}`,
      "--publish",
      `127.0.0.1:${port}:8443`,
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,mode=1777",
      "--mount",
      `type=bind,src=${tmpfs}/nginx.conf,dst=/etc/nginx/nginx.conf,readonly`,
      "--mount",
      `type=bind,src=${nginxSecrets},dst=/run/secrets/edge-nginx,readonly`,
      image,
    ).trim();
    browser = await chromium.launch({ headless: true });
    const browserContext = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 900 },
    });
    try {
      await runServedBrowser(browserContext, origin, evidence, controls);
    } finally {
      await browserContext.close();
    }
    console.log(
      "PASS served-surface scenarios through native nginx, actual mTLS Edge and API-public; distinct labeled authority-clock expiry fixture",
    );
  } finally {
    await writeFile(
      join(evidence, "owner-network.json"),
      JSON.stringify(safe, null, 2),
    );
    await browser?.close();
    receipts.push({ kind: "browser", closed: true });
    for (const app of apps) {
      const address = app.server.address();
      const result = await app.runtimeController.closeRuntime("SIGTERM");
      receipts.push({
        kind: "runtime",
        address,
        result,
        listening: app.server.listening,
      });
    }
    if (container) {
      await writeFile(
        join(evidence, "nginx-safe.log"),
        docker("logs", container),
      );
      docker("rm", "-f", container);
      receipts.push({
        kind: "container",
        handle: container,
        absent:
          spawnSync("docker", ["inspect", container], { stdio: "ignore" })
            .status !== 0,
      });
    }
    if (networkCreated) {
      docker("network", "rm", network);
      receipts.push({
        kind: "network",
        handle: network,
        absent:
          spawnSync("docker", ["network", "inspect", network], {
            stdio: "ignore",
          }).status !== 0,
      });
    }
    if (imageBuilt) {
      docker("image", "rm", image);
      receipts.push({
        kind: "image",
        handle: image,
        absent:
          spawnSync("docker", ["image", "inspect", image], { stdio: "ignore" })
            .status !== 0,
      });
    }
    await rm(tmpfs, { recursive: true, force: true });
    const tmpfsAbsent = await access(tmpfs).then(
      () => false,
      () => true,
    );
    receipts.push({ kind: "tmpfs", handle: tmpfs, removed: tmpfsAbsent });
    assert.equal(tmpfsAbsent, true);
    await writeFile(
      join(evidence, "cleanup.json"),
      JSON.stringify(receipts, null, 2),
    );
  }
}
