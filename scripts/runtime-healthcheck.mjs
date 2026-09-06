#!/usr/bin/env node

import {readFile} from "node:fs/promises";
import {request} from "node:https";
import {load as parseYaml} from "js-yaml";
import {parseServiceTransportMaterial, verifyTransportPeer} from "@coffee-platform/security";

const paths = process.argv.slice(2);
const secretsPath = process.env.COFFEE_RUNTIME_SECRETS_FILE;
const runtime = process.env.RUNTIME_NAME;
const port = Number(process.env.PORT);

function secretAt(document, path) {
  let value = document;
  for (const segment of path.split(".")) value = value?.[segment];
  return value;
}

function requestHealth(path, material, environment) {
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

try {
  if (paths.length === 0) throw new Error("healthcheck path is required");
  if (!secretsPath || !runtime || !/^[a-z0-9-]+$/u.test(runtime) || !Number.isInteger(port) || port <= 0) {
    throw new Error("runtime healthcheck configuration is invalid");
  }
  const document = parseYaml(await readFile(secretsPath, "utf8"), {json: true});
  const material = parseServiceTransportMaterial(
    secretAt(document, `secrets.security.serviceTransportKeys.${runtime}`),
    document.environment,
    runtime,
  );
  const statuses = await Promise.all(paths.map((path) => requestHealth(path, material, document.environment)));
  for (const status of statuses) console.log(status);
  if (statuses.some((status) => status < 200 || status >= 300)) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : "runtime healthcheck failed");
  process.exitCode = 1;
}
