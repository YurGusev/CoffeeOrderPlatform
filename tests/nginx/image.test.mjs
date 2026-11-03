import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  chmod,
  writeFile,
  readFile,
  rm,
} from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import https from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const activeProfileConfig = resolve(
  root,
  "apps/edge-nginx/generated/nginx.conf",
);
const profileConfig = resolve(
  root,
  `apps/edge-nginx/generated/.image-fixture-${process.pid}.conf`,
);
const image = "coffee-edge-nginx:image-test";
const backendImage = "coffee-edge-fixture:image-test";
const registry = JSON.parse(
  await readFile(join(root, "config/toolchain-versions.json"), "utf8"),
);
const network = `edge-image-${process.pid}`;
const extraIds = [];
const extraNetworks = [];
const hostPort = 18443 + (process.pid % 7000);
const scratch = await mkdtemp(join(tmpdir(), "edge-image-"));
const certDir = join(scratch, "certs");
const requestsFile = join(certDir, "requests.jsonl");
await mkdir(certDir, { mode: 0o755 });
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe",
    ...options,
  });
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`,
    );
  return result.stdout;
};
const docker = (...args) => run("docker", args);
const openssl = (...args) =>
  execFileSync("openssl", args, { cwd: certDir, stdio: "ignore" });
let backendId;
let nginxId;
let imageId;
try {
  openssl(
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
    "/CN=edge-fixture-ca",
    "-days",
    "1",
  );
  await writeFile(
    join(certDir, "server.ext"),
    "subjectAltName=DNS:edge-fixture.invalid,DNS:edge.fixture.internal,DNS:api.fixture.internal,DNS:realtime.fixture.internal\nextendedKeyUsage=serverAuth\n",
  );
  openssl(
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "server.key",
    "-out",
    "server.csr",
    "-subj",
    "/CN=edge-fixture.invalid",
  );
  openssl(
    "x509",
    "-req",
    "-in",
    "server.csr",
    "-CA",
    "ca.crt",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-out",
    "server.crt",
    "-days",
    "1",
    "-extfile",
    "server.ext",
  );
  await writeFile(join(certDir, "client.ext"), "extendedKeyUsage=clientAuth\n");
  openssl(
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "client.key",
    "-out",
    "client.csr",
    "-subj",
    "/CN=nginx-fixture-client",
  );
  openssl(
    "x509",
    "-req",
    "-in",
    "client.csr",
    "-CA",
    "ca.crt",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-out",
    "client.crt",
    "-days",
    "1",
    "-extfile",
    "client.ext",
  );
  await writeFile(requestsFile, "");
  for (const file of [
    "ca.crt",
    "server.crt",
    "server.key",
    "client.crt",
    "client.key",
  ])
    await chmod(join(certDir, file), 0o644);
  for (const [dst, src] of [
    ["upstream-ca.crt", "ca.crt"],
    ["public.crt", "server.crt"],
    ["public.key", "server.key"],
  ])
    await writeFile(join(certDir, dst), await readFile(join(certDir, src)));
  await chmod(requestsFile, 0o666);
  run(process.execPath, [
    "tools/nginx/generate-config.mjs",
    "--fixture",
    "tests/nginx/fixtures/profile.json",
    "--output",
    "apps/edge-nginx/generated/.image-fixture-" + process.pid + ".conf",
  ]);
  run("pnpm", [
    "image:build",
    "--target",
    "edge-nginx",
    "--tag",
    image,
    "--load",
    ".",
  ]);
  const activeProfile = await readFile(activeProfileConfig, "utf8");
  const bakedHash = docker(
    "run",
    "--rm",
    "--entrypoint",
    "sha256sum",
    image,
    "/etc/nginx/nginx.conf",
  )
    .trim()
    .split(/\s+/u)[0];
  assert.equal(
    bakedHash,
    createHash("sha256").update(activeProfile).digest("hex"),
    "image must bake the active generated nginx config",
  );
  for (const token of [
    "server edge-gateway:4000;",
    "server api-public:4050;",
    "server realtime-gateway:4401;",
    "edge-gateway.development.svc.coffee-platform.internal",
  ])
    assert.ok(
      activeProfile.includes(token),
      `image build must derive active config/platform.yaml profile, missing ${token}`,
    );
  docker(
    "build",
    "--build-arg",
    `NODE_IMAGE=${registry.browserHelperNodeImage}`,
    "--file",
    "tests/nginx/fixtures/Dockerfile",
    "--tag",
    backendImage,
    "tests/nginx/fixtures",
  );
  const finalToolsCheck =
    "for t in node npm pnpm corepack gcc g++ clang cc make apt-get dpkg; do command -v \"$t\" >/dev/null 2>&1 && exit 44; done; ! grep -R -E 'BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|BEGIN CERTIFICATE' /etc/nginx /usr/share/nginx/html";
  docker("run", "--rm", "--entrypoint", "sh", image, "-c", finalToolsCheck);
  imageId = docker("image", "inspect", "--format", "{{.Id}}", image).trim();
  docker("network", "create", network);
  backendId = docker(
    "run",
    "--detach",
    "--network",
    network,
    "--network-alias",
    "edge.fixture.internal",
    "--network-alias",
    "api.fixture.internal",
    "--network-alias",
    "realtime.fixture.internal",
    "--mount",
    `type=bind,src=${certDir},dst=/run/fixture-certs,readonly`,
    "--mount",
    `type=bind,src=${requestsFile},dst=/run/requests.jsonl`,
    "--env",
    "REQUEST_LOG=/run/requests.jsonl",
    backendImage,
  ).trim();
  docker(
    "run",
    "--rm",
    "--network",
    network,
    "--user",
    "101:101",
    "--mount",
    `type=bind,src=${profileConfig},dst=/etc/nginx/nginx.conf,readonly`,
    "--mount",
    `type=bind,src=${certDir},dst=/run/secrets/edge-nginx,readonly`,
    "--entrypoint",
    "nginx",
    image,
    "-t",
    "-c",
    "/etc/nginx/nginx.conf",
  );
  const missingConfig = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--entrypoint",
      "nginx",
      image,
      "-t",
      "-c",
      "/etc/nginx/nginx.conf",
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.notEqual(
    missingConfig.status,
    0,
    "image must fail closed without the mounted runtime secrets required by its active config",
  );
  if (process.argv.includes("--check-only")) {
    console.log(
      `PASS image check-only: nginx -t; final image ${imageId}; no Node/compiler/package manager/private key/certificate.`,
    );
  } else {
    nginxId = docker(
      "run",
      "--detach",
      "--read-only",
      "--user",
      "101:101",
      "--network",
      network,
      "--network-alias",
      "edge-nginx",
      "--publish",
      `127.0.0.1:${hostPort}:8443`,
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,mode=1777",
      "--mount",
      `type=bind,src=${profileConfig},dst=/etc/nginx/nginx.conf,readonly`,
      "--mount",
      `type=bind,src=${certDir},dst=/run/secrets/edge-nginx,readonly`,
      image,
    ).trim();
    await delay(900);
    const request = (
      path,
      {
        method = "GET",
        headers = {},
        body,
        timeout = 10_000,
        port = hostPort,
      } = {},
    ) =>
      new Promise((resolveRequest, reject) => {
        const req = https.request(
          {
            hostname: "127.0.0.1",
            port,
            path,
            method,
            headers,
            ca: readFileSync(join(certDir, "ca.crt")),
            servername: "edge-fixture.invalid",
            rejectUnauthorized: true,
            timeout,
          },
          (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolveRequest({
                status: res.statusCode,
                headers: res.headers,
                body: Buffer.concat(chunks).toString(),
              }),
            );
          },
        );
        req.on("timeout", () => req.destroy(new Error("request timeout")));
        req.on("error", reject);
        if (body) req.write(body);
        req.end();
      });
    const assertTypedProblem = (response, code) => {
      assert.match(
        response.headers["content-type"],
        /^application\/problem\+json/,
      );
      const problem = JSON.parse(response.body);
      assert.equal(problem.code, code);
      assert.equal(problem.status, response.status);
      assert.ok(problem.type && problem.title && problem.detail);
      assert.match(problem.instance, /^urn:coffee:edge:[a-f0-9]+$/);
      assert.equal(problem.correlationId, response.headers["x-correlation-id"]);
      assert.ok(Array.isArray(problem.errors));
    };
    const publicStatusPaths = ["/nginx_status", "/health/ready", "/metrics"];
    for (const path of publicStatusPaths)
      assert.equal(
        (await request(path)).status,
        404,
        `${path} must remain private on public TLS`,
      );
    const privateStatus = docker(
      "run",
      "--rm",
      "--network",
      network,
      "--entrypoint",
      "node",
      registry.browserHelperNodeImage,
      "-e",
      'fetch("http://edge-nginx:8081/nginx_status").then(async response=>{const body=await response.text();if(response.status!==200||!/^Active connections: \\d+\\s+server accepts handled requests\\s+\\d+\\s+\\d+\\s+\\d+\\s+Reading: \\d+\\s+Writing: \\d+\\s+Waiting: \\d+\\s*$/u.test(body)){console.error(JSON.stringify({status:response.status,body}));process.exit(1)}process.stdout.write(body)}).catch(error=>{console.error(error);process.exit(2)})',
    );
    assert.match(
      privateStatus,
      /^Active connections: \d+/u,
      "the private stub_status endpoint must be readable and expose only bounded native counters",
    );
    if (process.env.NGINX_TLS_NEGATIVE === "1") {
      const variant = (
        port,
        { secrets = certDir, config, snippet, net = network } = {},
      ) => {
        const args = [
          "run",
          "--detach",
          "--read-only",
          "--user",
          "101:101",
          "--network",
          net,
          "--publish",
          `127.0.0.1:${port}:8443`,
          "--tmpfs",
          "/tmp:rw,noexec,nosuid,mode=1777",
          "--mount",
          `type=bind,src=${config ?? profileConfig},dst=/etc/nginx/nginx.conf,readonly`,
          "--mount",
          `type=bind,src=${secrets},dst=/run/secrets/edge-nginx,readonly`,
        ];
        if (snippet)
          args.push(
            "--mount",
            `type=bind,src=${snippet},dst=/etc/nginx/snippets/upstream-tls.conf,readonly`,
          );
        const id = docker(...args, image).trim();
        extraIds.push(id);
        variants.set(port, id);
        return id;
      };
      const variants = new Map();
      const waitForVariant = async (port, label) => {
        const id = variants.get(port);
        const deadline = Date.now() + 8000;
        let lastError;
        while (Date.now() < deadline) {
          const state = JSON.parse(
            docker("inspect", "--format", "{{json .State}}", id),
          );
          if (!state.Running)
            throw new Error(
              `TLS fixture ${label} exited before ready: port=${port} exit=${state.ExitCode} stderr=${docker("logs", id)}`,
            );
          try {
            const response = await request("/health/live", {
              port,
              timeout: 1000,
            });
            if (response.status === 200) return;
            lastError = new Error(`health returned ${response.status}`);
          } catch (error) {
            lastError = error;
          }
          await delay(150);
        }
        throw new Error(
          `TLS fixture ${label} did not become ready within 8s: port=${port}; ${lastError?.message ?? "no response"}; logs=${docker("logs", id)}`,
        );
      };
      const probeFailure = async (port, backendLog) => {
        const before = await readFile(backendLog, "utf8");
        let response;
        try {
          response = await request("/auth/session", { port });
        } catch (error) {
          const id = variants.get(port);
          console.error(
            "TLS variant failed before HTTPS response",
            port,
            docker(
              "inspect",
              "--format",
              "{{json .State}} {{json .Config.Cmd}} {{json .Config.Entrypoint}} {{.HostConfig.ReadonlyRootfs}}",
              id,
            ),
            docker("logs", id),
          );
          throw error;
        }
        assert.equal(
          response.status,
          502,
          "untrusted/mismatched/missing upstream TLS identity must fail",
        );
        assertTypedProblem(response, "UPSTREAM_UNAVAILABLE");
        await delay(100);
        assert.equal(
          await readFile(backendLog, "utf8"),
          before,
          "failed upstream TLS must send no HTTP request",
        );
      };
      const badCaDir = join(scratch, "bad-ca-secrets");
      await mkdir(badCaDir, { mode: 0o755 });
      for (const file of [
        "public.crt",
        "public.key",
        "client.crt",
        "client.key",
      ])
        await writeFile(
          join(badCaDir, file),
          await readFile(join(certDir, file)),
        );
      const badCaKey = join(badCaDir, "bad-ca.key"),
        badCaCrt = join(badCaDir, "bad-ca.crt");
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          badCaKey,
          "-out",
          badCaCrt,
          "-subj",
          "/CN=untrusted-fixture-ca",
          "-days",
          "1",
        ],
        { stdio: "ignore" },
      );
      await writeFile(
        join(badCaDir, "upstream-ca.crt"),
        await readFile(badCaCrt),
      );
      docker(
        "run",
        "--rm",
        "--network",
        network,
        "--user",
        "101:101",
        "--mount",
        `type=bind,src=${profileConfig},dst=/etc/nginx/nginx.conf,readonly`,
        "--mount",
        `type=bind,src=${badCaDir},dst=/run/secrets/edge-nginx,readonly`,
        "--entrypoint",
        "nginx",
        image,
        "-t",
        "-c",
        "/etc/nginx/nginx.conf",
      );
      variant(hostPort + 1, { secrets: badCaDir });
      const generated = await readFile(profileConfig, "utf8");
      const wrongSniConfig = join(scratch, "wrong-sni.conf");
      assert.match(generated, /proxy_ssl_name edge\.fixture\.internal;/);
      await writeFile(
        wrongSniConfig,
        generated.replaceAll(
          "proxy_ssl_name edge.fixture.internal;",
          "proxy_ssl_name wrong.fixture.internal;",
        ),
      );
      variant(hostPort + 2, { config: wrongSniConfig });
      const clientlessSnippet = join(scratch, "upstream-no-client.conf");
      await writeFile(
        clientlessSnippet,
        (
          await readFile(
            join(root, "apps/edge-nginx/snippets/upstream-tls.conf"),
            "utf8",
          )
        )
          .split("\n")
          .filter((line) => !/^proxy_ssl_certificate(?:_key)? /.test(line))
          .join("\n"),
      );
      variant(hostPort + 3, { snippet: clientlessSnippet });
      await Promise.all(
        [
          [hostPort + 1, "untrusted CA"],
          [hostPort + 2, "wrong SNI"],
          [hostPort + 3, "missing client certificate"],
        ].map(([port, label]) => waitForVariant(port, label)),
      );
      await probeFailure(hostPort + 1, requestsFile);
      await probeFailure(hostPort + 2, requestsFile);
      await probeFailure(hostPort + 3, requestsFile);
      const expiredNetwork = `edge-image-expired-${process.pid}`;
      extraNetworks.push(expiredNetwork);
      docker("network", "create", expiredNetwork);
      const expiredDir = join(scratch, "expired-backend");
      await mkdir(expiredDir, { mode: 0o755 });
      await writeFile(
        join(expiredDir, "server.key"),
        await readFile(join(certDir, "server.key")),
      );
      await writeFile(
        join(expiredDir, "ca.crt"),
        await readFile(join(certDir, "ca.crt")),
      );
      execFileSync(
        "openssl",
        [
          "x509",
          "-req",
          "-in",
          join(certDir, "server.csr"),
          "-CA",
          join(certDir, "ca.crt"),
          "-CAkey",
          join(certDir, "ca.key"),
          "-out",
          join(expiredDir, "server.crt"),
          "-days",
          "0",
          "-extfile",
          join(certDir, "server.ext"),
        ],
        { stdio: "ignore" },
      );
      const expiredLog = join(scratch, "expired-requests.jsonl");
      await writeFile(expiredLog, "");
      await chmod(expiredLog, 0o666);
      const expiredBackend = docker(
        "run",
        "--detach",
        "--network",
        expiredNetwork,
        "--network-alias",
        "edge.fixture.internal",
        "--network-alias",
        "api.fixture.internal",
        "--network-alias",
        "realtime.fixture.internal",
        "--mount",
        `type=bind,src=${expiredDir},dst=/run/fixture-certs,readonly`,
        "--mount",
        `type=bind,src=${expiredLog},dst=/run/requests.jsonl`,
        "--env",
        "REQUEST_LOG=/run/requests.jsonl",
        backendImage,
      ).trim();
      extraIds.push(expiredBackend);
      variant(hostPort + 4, { net: expiredNetwork });
      await waitForVariant(hostPort + 4, "expired upstream certificate");
      await probeFailure(hostPort + 4, expiredLog);
      const wrongNetwork = `edge-image-wrong-runtime-${process.pid}`;
      extraNetworks.push(wrongNetwork);
      docker("network", "create", wrongNetwork);
      const wrongDir = join(scratch, "wrong-runtime-backend");
      await mkdir(wrongDir, { mode: 0o755 });
      await writeFile(
        join(wrongDir, "server.ext"),
        "subjectAltName=DNS:other.fixture.internal\nextendedKeyUsage=serverAuth\n",
      );
      execFileSync(
        "openssl",
        [
          "req",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          join(wrongDir, "server.key"),
          "-out",
          join(wrongDir, "server.csr"),
          "-subj",
          "/CN=other.fixture.internal",
        ],
        { stdio: "ignore" },
      );
      execFileSync(
        "openssl",
        [
          "x509",
          "-req",
          "-in",
          join(wrongDir, "server.csr"),
          "-CA",
          join(certDir, "ca.crt"),
          "-CAkey",
          join(certDir, "ca.key"),
          "-out",
          join(wrongDir, "server.crt"),
          "-days",
          "1",
          "-extfile",
          join(wrongDir, "server.ext"),
        ],
        { stdio: "ignore" },
      );
      await writeFile(
        join(wrongDir, "ca.crt"),
        await readFile(join(certDir, "ca.crt")),
      );
      await chmod(join(wrongDir, "server.key"), 0o644);
      const wrongLog = join(scratch, "wrong-runtime-requests.jsonl");
      await writeFile(wrongLog, "");
      await chmod(wrongLog, 0o666);
      const wrongBackend = docker(
        "run",
        "--detach",
        "--network",
        wrongNetwork,
        "--network-alias",
        "edge.fixture.internal",
        "--network-alias",
        "api.fixture.internal",
        "--network-alias",
        "realtime.fixture.internal",
        "--mount",
        `type=bind,src=${wrongDir},dst=/run/fixture-certs,readonly`,
        "--mount",
        `type=bind,src=${wrongLog},dst=/run/requests.jsonl`,
        "--env",
        "REQUEST_LOG=/run/requests.jsonl",
        backendImage,
      ).trim();
      extraIds.push(wrongBackend);
      variant(hostPort + 5, { net: wrongNetwork });
      await waitForVariant(hostPort + 5, "wrong runtime DNS target");
      await probeFailure(hostPort + 5, wrongLog);
    }
    const live = await request("/health/live");
    assert.equal(live.status, 200);
    const session = await request("/auth/session", {
      headers: { cookie: "__Host-coffee-session=allow" },
    });
    assert.equal(session.status, 200);
    assert.equal(session.headers["cache-control"], "no-store");
    assert.equal(JSON.parse(session.body).actorRef, "fixture-actor-17");
    assert.ok(JSON.parse(session.body).expiresAt);
    const missingSession = await request("/auth/session");
    assert.equal(missingSession.status, 401);
    assert.equal(missingSession.headers["cache-control"], "no-store");
    assert.equal(
      JSON.parse(missingSession.body).code,
      "AUTHENTICATION_REQUIRED",
    );
    const logoutHeaders = {
      cookie: "__Host-coffee-session=allow; __Host-coffee-csrf=csrf-test",
      origin: "https://edge-fixture.invalid",
      "x-csrf-token": "csrf-test",
    };
    const logout = await request("/auth/logout", {
      method: "POST",
      headers: logoutHeaders,
    });
    assert.equal(
      logout.status,
      204,
      "nginx must forward the browser Origin needed for Edge logout CSRF validation",
    );
    const crossOriginLogout = await request("/auth/logout", {
      method: "POST",
      headers: { ...logoutHeaders, origin: "https://evil.invalid" },
    });
    assert.equal(
      crossOriginLogout.status,
      403,
      "Edge must reject a cross-origin logout",
    );
    assert.equal(
      (await readFile(requestsFile, "utf8"))
        .split("\n")
        .filter((line) => line.includes("edge-auth-response")).length,
      0,
      "session lookup does not invoke auth_request",
    );
    const callback = await request(
      "/auth/callback?state=fixture&code=fixture",
      {
        headers: {
          cookie:
            "__Host-coffee-login=browser-bound; __Host-coffee-session=allow; tracking=not-for-edge",
        },
      },
    );
    assert.equal(callback.status, 200);
    assert.equal(
      JSON.parse(callback.body).headers.cookie,
      "__Host-coffee-login=browser-bound",
      "only the login-binding cookie reaches callback",
    );
    const forged = await request("/api/client-v1/orders/drafts", {
      method: "POST",
      headers: {
        cookie: "__Host-coffee-session=forged200",
        "x-actor-context": "forged-client",
        "idempotency-key": "fixture-forged-200",
        "content-type": "application/json",
      },
      body: '{"x":1}',
    });
    if (forged.status !== 503)
      console.error(
        "NGINX_LOGS\\n" +
          docker("logs", nginxId) +
          "BACKEND_LOGS\\n" +
          docker("logs", backendId),
      );
    assert.equal(forged.status, 503, "200 + forged assertion must fail closed");
    assert.equal(JSON.parse(forged.body).code, "AUTHORIZER_UNAVAILABLE");
    assertTypedProblem(forged, "AUTHORIZER_UNAVAILABLE");
    assert.equal(
      (
        await request("/api/client-v1/orders/drafts", {
          method: "POST",
          headers: { cookie: "__Host-coffee-session=empty204" },
        })
      ).status,
      503,
      "204 without assertion must fail closed",
    );
    assert.equal(
      (
        await request("/api/client-v1/orders/drafts", {
          method: "POST",
          headers: { cookie: "__Host-coffee-session=no-correlation" },
        })
      ).status,
      503,
      "204 without signed correlation must fail closed",
    );
    const unauth = await request("/api/client-v1/orders/drafts", {
      method: "POST",
    });
    assert.equal(unauth.status, 401);
    assert.equal(JSON.parse(unauth.body).code, "AUTHENTICATION_REQUIRED");
    assertTypedProblem(unauth, "AUTHENTICATION_REQUIRED");
    const leakCanary = "cutover-raw-query-and-cookie-canary";
    const guardedCanary = await request(
      `/api/client-v1/orders/drafts?raw=${leakCanary}`,
      {
        method: "POST",
        headers: { cookie: `__Host-coffee-session=${leakCanary}` },
      },
    );
    assert.equal(guardedCanary.status, 401);
    assert.equal(
      guardedCanary.body.includes(leakCanary),
      false,
      "problem response must not include raw request or cookie",
    );
    assert.equal(
      docker("logs", nginxId).includes(leakCanary),
      false,
      "native nginx traffic logs must not expose raw request or cookie",
    );
    const infra = await request("/api/client-v1/orders/drafts", {
      method: "POST",
      headers: { cookie: "__Host-coffee-session=infra" },
    });
    assert.equal(infra.status, 503);
    assert.equal(JSON.parse(infra.body).code, "AUTHORIZER_UNAVAILABLE");
    const slow = await request("/api/client-v1/orders/drafts", {
      method: "POST",
      headers: {
        cookie: "__Host-coffee-session=slow",
        "idempotency-key": "fixture-slow",
      },
    });
    assert.equal(
      slow.status,
      503,
      "a stalled authorizer must time out before reaching the API",
    );
    assert.equal(JSON.parse(slow.body).code, "AUTHORIZER_UNAVAILABLE");
    const validTraceparent =
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const authLogStart = (await readFile(requestsFile, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean).length;
    const allowed = await request("/api/client-v1/orders/drafts", {
      method: "POST",
      headers: {
        cookie:
          "__Host-coffee-session=allow; __Host-coffee-csrf=csrf-safe; tracking=raw-cookie-marker",
        "x-actor-context": "forged-client",
        "x-correlation-id": "00000000-0000-4000-8000-000000000000",
        authorization: "Bearer forged",
        origin: "https://evil.invalid",
        "x-csrf-token": "browser-csrf",
        "content-type": "application/json",
        "idempotency-key": "fixture-1",
        "if-match": '"7"',
        traceparent: validTraceparent,
      },
      body: '{"x":1}',
    });
    assert.equal(
      allowed.status,
      200,
      "204 + nonempty assertion must reach API",
    );
    const api = JSON.parse(allowed.body);
    assert.equal(api.role, "api");
    assert.equal(api.method, "POST");
    assert.equal(api.body, '{"x":1}');
    assert.equal(api.headers["x-actor-context"], "fixture-actor-17");
    assert.notEqual(api.headers["x-actor-context"], "forged-client");
    assert.equal(api.headers.cookie, undefined);
    assert.equal(api.headers.authorization, undefined);
    assert.equal(api.headers.origin, undefined);
    assert.equal(api.headers["x-csrf-token"], undefined);
    assert.equal(api.headers["idempotency-key"], "fixture-1");
    assert.equal(api.headers["if-match"], '"7"');
    assert.equal(api.clientAuthorized, true);
    assert.equal(
      api.headers["x-correlation-id"],
      "123e4567-e89b-42d3-a456-426614174000",
      "API receives only the correlation bound to Edge assertion",
    );
    assert.equal(
      api.headers.traceparent,
      validTraceparent,
      "API receives the validated W3C trace context",
    );
    const accessRecord = docker("logs", nginxId)
      .split("\n")
      .filter((line) => line.startsWith('{"method"'))
      .map(JSON.parse)
      .find(
        (record) =>
          record.correlation_id === "123e4567-e89b-42d3-a456-426614174000" &&
          record.traceparent === validTraceparent,
      );
    assert.deepEqual(
      Object.keys(accessRecord ?? {}).sort(),
      [
        "correlation_id",
        "duration_seconds",
        "method",
        "request_bytes",
        "request_completion",
        "request_id",
        "response_bytes",
        "route",
        "status",
        "traceparent",
      ].sort(),
      "nginx access log contains only bounded request metadata",
    );
    assert.equal(accessRecord.route, "client.orders");
    assert.equal(accessRecord.request_completion, "OK");
    assert.equal(typeof accessRecord.duration_seconds, "number");
    const authorized = (await readFile(requestsFile, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(authLogStart)
      .map(JSON.parse)
      .find(
        (event) => event.role === "edge" && event.url === "/_edge/authorize",
      );
    assert.equal(
      authorized?.headers.traceparent,
      validTraceparent,
      "Edge authorization receives the same validated W3C trace context",
    );
    assert.equal(
      authorized?.headers["x-correlation-id"],
      "00000000-0000-4000-8000-000000000000",
      "Edge may bind the validated client correlation to its signed assertion",
    );
    const futureTraceparent =
      "01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const futureTrace = await request("/api/client-v1/orders/drafts", {
      method: "POST",
      headers: {
        cookie: "__Host-coffee-session=allow; __Host-coffee-csrf=csrf-safe",
        "x-csrf-token": "browser-csrf",
        "content-type": "application/json",
        "idempotency-key": "fixture-future-trace",
        "if-match": '"7"',
        traceparent: futureTraceparent,
      },
      body: '{"x":1}',
    });
    assert.equal(futureTrace.status, 200);
    assert.equal(
      JSON.parse(futureTrace.body).headers.traceparent,
      futureTraceparent,
      "future W3C traceparent versions are forwarded unchanged",
    );
    const invalidTraceparent =
      "ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const invalidTrace = await request("/api/client-v1/orders/drafts", {
      method: "POST",
      headers: {
        cookie: "__Host-coffee-session=allow; __Host-coffee-csrf=csrf-safe",
        "x-csrf-token": "browser-csrf",
        "content-type": "application/json",
        "idempotency-key": "fixture-invalid-trace",
        "if-match": '"7"',
        traceparent: invalidTraceparent,
      },
      body: '{"x":1}',
    });
    assert.equal(invalidTrace.status, 200);
    assert.equal(
      JSON.parse(invalidTrace.body).headers.traceparent,
      undefined,
      "reserved traceparent version ff is stripped",
    );
    assert.equal(
      docker("logs", nginxId).includes(invalidTraceparent),
      false,
      "invalid trace context is absent from native nginx logs",
    );
    const zeroTraceId =
      "00-00000000000000000000000000000000-00f067aa0ba902b7-01";
    const zeroTraceLogStart = (await readFile(requestsFile, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean).length;
    const zeroTrace = await request("/api/client-v1/orders/drafts", {
      method: "POST",
      headers: {
        cookie: "__Host-coffee-session=allow",
        traceparent: zeroTraceId,
        "x-correlation-id": "invalid-client-correlation",
      },
    });
    assert.equal(zeroTrace.status, 200);
    assert.equal(
      JSON.parse(zeroTrace.body).headers.traceparent,
      undefined,
      "all-zero W3C trace IDs are stripped before the business request",
    );
    const zeroTraceAuth = (await readFile(requestsFile, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(zeroTraceLogStart)
      .map(JSON.parse)
      .find(
        (event) => event.role === "edge" && event.url === "/_edge/authorize",
      );
    assert.equal(
      zeroTraceAuth?.headers.traceparent,
      undefined,
      "all-zero W3C trace IDs are stripped before Edge authorization",
    );
    assert.equal(
      zeroTraceAuth?.headers["x-correlation-id"],
      undefined,
      "malformed client correlation is stripped before Edge authorization",
    );
    assert.equal(
      docker("logs", nginxId).includes(zeroTraceId),
      false,
      "untrusted all-zero trace context is absent from native nginx logs",
    );
    const denied = await request("/api/client-v1/orders/drafts", {
      method: "POST",
      headers: { cookie: "__Host-coffee-session=forbidden" },
    });
    assert.equal(denied.status, 403);
    assert.equal(JSON.parse(denied.body).code, "AUTHORIZATION_FORBIDDEN");
    assertTypedProblem(denied, "AUTHORIZATION_FORBIDDEN");
    assert.equal((await request("/_edge/authorize")).status, 404);
    assert.equal((await request("/api/agent-v1/orders")).status, 404);
    assert.equal(
      (await request("/api/client-v1/catalog/products", { method: "POST" }))
        .status,
      403,
    );
    assert.equal(
      (await request("/api/client-v1/catalog/products", { method: "HEAD" }))
        .status,
      405,
      "HEAD is not an implicit alias for GET API",
    );
    assert.equal(
      (await request("/auth/session", { method: "HEAD" })).status,
      405,
      "HEAD is not an auth route",
    );
    assert.equal(
      (await request("/events", { method: "HEAD" })).status,
      405,
      "HEAD is not an SSE route",
    );
    assert.equal((await request("/assets/missing.js")).status, 404);
    assert.equal((await request("/api/client-v1/missing")).status, 404);
    assert.equal((await request("/events/missing")).status, 404);
    const rootRedirect = await request("/");
    assert.equal(rootRedirect.status, 303);
    assert.equal(rootRedirect.headers.location, "/app/customers");
    const app = await request("/app/");
    assert.equal(app.status, 200);
    assert.match(app.body, /CoffeeOrderPlatform/);
    const assetPath = /src="([^"]+\.js)"/.exec(app.body)?.[1];
    assert.ok(assetPath, "built app has an immutable JS asset");
    const asset = await request(assetPath);
    assert.equal(asset.status, 200);
    assert.match(asset.headers["cache-control"], /immutable/);
    assert.match(
      asset.headers["content-type"] ?? "",
      /^application\/javascript(?:;|$)/,
      "browser module asset must have a JavaScript MIME type",
    );
    const deepLink = await request("/app/customers");
    assert.equal(deepLink.status, 200);
    assert.match(deepLink.body, /CoffeeOrderPlatform/);
    const duplicate = await request("/api/client-v1/orders/drafts", {
      method: "POST",
      headers: {
        cookie: "__Host-coffee-session=allow",
        "idempotency-key": ["duplicate-a", "duplicate-b"],
      },
    });
    assert.equal(duplicate.status, 400);
    const disconnected = await request("/api/client-v1/orders/drafts", {
      method: "POST",
      headers: {
        cookie: "__Host-coffee-session=allow",
        "idempotency-key": "fixture-disconnect",
      },
      body: '{"fail":true}',
    });
    assert.equal(disconnected.status, 502);
    const sseStarted = Date.now();
    let connectedResolve;
    const connected = new Promise((resolveConnected) => {
      connectedResolve = resolveConnected;
    });
    const ssePromise = new Promise((resolveSse, rejectSse) => {
      let data = "";
      let status;
      const req = https.request(
        {
          hostname: "127.0.0.1",
          port: hostPort,
          path: "/events",
          headers: {
            cookie: "__Host-coffee-session=allow",
            "last-event-id": "evt-24",
          },
          ca: readFileSync(join(certDir, "ca.crt")),
          servername: "edge-fixture.invalid",
          rejectUnauthorized: true,
        },
        (res) => {
          status = res.statusCode;
          connectedResolve();
          res.on("data", (chunk) => {
            data += chunk;
          });
          setTimeout(() => {
            req.destroy();
            resolveSse({ status, data, elapsed: Date.now() - sseStarted });
          }, 5600).unref();
        },
      );
      req.on("error", (e) => {
        if (e.code !== "ECONNRESET") rejectSse(e);
      });
      req.end();
    });
    await connected;
    const concurrentApi = await request("/api/client-v1/catalog/products", {
      headers: { cookie: "__Host-coffee-session=allow" },
    });
    assert.equal(
      concurrentApi.status,
      200,
      "API must remain available while SSE is open",
    );
    const sse = await ssePromise;
    await delay(100);
    assert.equal(sse.status, 200);
    assert.ok(sse.elapsed > 5000, `SSE remained open ${sse.elapsed}ms`);
    assert.match(sse.data, /event: connected/);
    assert.match(sse.data, /event: tick/);
    const events = (await readFile(requestsFile, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((x) => JSON.parse(x));
    assert.equal(
      events.filter(
        (x) =>
          x.role === "edge-auth-response" &&
          x.status === 200 &&
          x.actorContext === "forged-context",
      ).length,
      1,
      "auth fixture returned 200 with nonempty forged assertion",
    );
    assert.ok(
      events.filter(
        (x) =>
          x.role === "edge-auth-response" &&
          x.status === 204 &&
          x.actorContext === "fixture-actor-17",
      ).length >= 1,
      "auth fixture returned 204 with nonempty actor assertion",
    );
    assert.equal(
      events.filter(
        (x) =>
          x.role === "api" &&
          x.headers["idempotency-key"] === "fixture-forged-200",
      ).length,
      0,
      "200 + nonempty forged assertion never reaches business upstream",
    );
    assert.equal(
      events.filter(
        (x) =>
          x.role === "api" &&
          x.url === "/api/client-v1/orders/drafts" &&
          x.headers["idempotency-key"] === "fixture-1",
      ).length,
      1,
      "204 + nonempty assertion reaches business upstream once",
    );
    assert.equal(
      events.filter(
        (x) =>
          x.role === "api" &&
          x.url === "/api/client-v1/orders/drafts" &&
          x.headers["idempotency-key"] === "fixture-disconnect",
      ).length,
      1,
      "connection loss must not retry mutation",
    );
    assert.equal(
      events.filter(
        (x) => x.role === "api" && x.url === "/api/client-v1/catalog/products",
      ).length,
      1,
    );
    assert.equal(
      events.filter(
        (x) => x.role === "realtime" && x.url === "/events" && !x.type,
      ).length,
      1,
    );
    assert.equal(
      events.find((x) => x.role === "realtime" && x.url === "/events").headers[
        "last-event-id"
      ],
      "evt-24",
    );
    assert.ok(
      events.some((x) => x.role === "realtime" && x.type === "disconnect"),
      "SSE client disconnect must close upstream",
    );
    const previewPath = "/api/client-v1/pricing/catalog-preview";
    const previewBody = '{"snapshotRevision":"1","items":[]}';
    const preview = await request(previewPath, {
      method: "POST",
      headers: {
        cookie: "__Host-coffee-session=allow",
        "content-type": "application/json",
      },
      body: previewBody,
    });
    assert.equal(preview.status, 200, preview.body);
    const previewApi = JSON.parse(preview.body);
    assert.equal(previewApi.url, previewPath);
    assert.equal(previewApi.method, "POST");
    assert.equal(previewApi.body, previewBody);
    assert.equal(previewApi.headers["x-actor-context"], "fixture-actor-17");
    assert.equal(previewApi.headers["idempotency-key"], undefined);
    assert.equal(previewApi.clientAuthorized, true);
    assert.equal(
      (await request(previewPath, { method: "POST", body: previewBody }))
        .status,
      401,
    );
    assert.equal(
      (
        await request(previewPath, {
          headers: { cookie: "__Host-coffee-session=allow" },
        })
      ).status,
      403,
    );
    console.log(
      `PASS image-level: image=${imageId}; nginx -t; HTTPS/upstream mTLS/SNI; 200 + forged assertion rejected before API; 204 + assertion reaches API; typed 401/403/503; direct session no-store; internal/private paths blocked; static app; >5s SSE/concurrent API/disconnect; no auth retry; safe headers and exact body.`,
    );
  }
} finally {
  if (nginxId) spawnSync("docker", ["rm", "-f", nginxId], { stdio: "ignore" });
  if (backendId)
    spawnSync("docker", ["rm", "-f", backendId], { stdio: "ignore" });
  for (const id of extraIds)
    spawnSync("docker", ["rm", "-f", id], { stdio: "ignore" });
  for (const extraNetwork of extraNetworks)
    spawnSync("docker", ["network", "rm", extraNetwork], { stdio: "ignore" });
  spawnSync("docker", ["network", "rm", network], { stdio: "ignore" });
  spawnSync("docker", ["image", "rm", "-f", image, backendImage], {
    stdio: "ignore",
  });
  await rm(profileConfig, { force: true });
  await rm(scratch, { recursive: true, force: true });
}
