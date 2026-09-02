#!/usr/bin/env node
import {channel} from "node:diagnostics_channel";

const channels = [
  "node:permission-model:fs",
  "node:permission-model:net",
  "node:permission-model:child",
  "node:permission-model:worker",
  "node:permission-model:addon",
  "node:permission-model:ffi",
];

for (const name of channels) {
  channel(name).subscribe((message) => {
    if (!message || typeof message !== "object") return;
    const permission = "permission" in message && typeof message.permission === "string" ? message.permission : name;
    const resource = "resource" in message && typeof message.resource === "string" ? message.resource : "redacted";
    process.stderr.write(`${JSON.stringify({event: "permission-audit", permission, resource})}\n`);
  });
}
