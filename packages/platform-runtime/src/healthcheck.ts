import {readFile} from "node:fs/promises";
import {request} from "node:https";
import {load as parseYaml} from "js-yaml";
import {parseServiceTransportMaterial, verifyTransportPeer} from "@coffee-platform/security";

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

function secretAt(document: unknown, path: string): unknown {
  let value = document;
  for (const segment of path.split(".")) {
    value = value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)[segment]
      : undefined;
  }
  return value;
}

function requestHealth(
  path: string,
  port: number,
  material: ReturnType<typeof parseServiceTransportMaterial>,
  environment: string,
  runtime: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const client = request({
      host: "127.0.0.1",
      port,
      path,
      method: "GET",
      ca: material.caPem,
      cert: material.certPem,
      key: material.keyPem,
      minVersion: "TLSv1.3",
      rejectUnauthorized: true,
      servername: "127.0.0.1",
      timeout: 900,
      checkServerIdentity: (_hostname, certificate) => {
        try {
          verifyTransportPeer(certificate, environment, runtime);
          return undefined;
        } catch (error) {
          return error instanceof Error ? error : new Error("transport peer identity is invalid");
        }
      },
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    client.once("timeout", () => client.destroy(new Error("healthcheck timed out")));
    client.once("error", reject);
    client.end();
  });
}

export async function runRuntimeHealthcheck(
  paths: readonly string[],
  environment: RuntimeEnvironment = process.env,
): Promise<readonly number[]> {
  const secretsPath = environment["COFFEE_RUNTIME_SECRETS_FILE"];
  const runtime = environment["RUNTIME_NAME"];
  const port = Number(environment["PORT"]);
  if (
    paths.length === 0 ||
    secretsPath === undefined ||
    runtime === undefined ||
    !/^[a-z0-9-]+$/u.test(runtime) ||
    !Number.isInteger(port) ||
    port <= 0
  ) {
    throw new Error("runtime healthcheck configuration is invalid");
  }
  const document = parseYaml(await readFile(secretsPath, "utf8"), {json: true});
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("runtime healthcheck secrets document is invalid");
  }
  const environmentName = (document as Record<string, unknown>)["environment"];
  if (typeof environmentName !== "string" || environmentName.length === 0) {
    throw new Error("runtime healthcheck environment is invalid");
  }
  const material = parseServiceTransportMaterial(
    secretAt(document, `secrets.security.serviceTransportKeys.${runtime}`),
    environmentName,
    runtime,
  );
  const statuses = await Promise.all(paths.map((path) => requestHealth(path, port, material, environmentName, runtime)));
  if (statuses.some((status) => status < 200 || status >= 300)) {
    throw new Error(`runtime healthcheck failed: ${statuses.join(",")}`);
  }
  return statuses;
}

export async function main(paths: readonly string[]): Promise<void> {
  try {
    for (const status of await runRuntimeHealthcheck(paths)) console.log(status);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "runtime healthcheck failed");
    process.exitCode = 1;
  }
}
