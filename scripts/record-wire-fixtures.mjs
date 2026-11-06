#!/usr/bin/env node
/**
 * Refresh the kernel-side wire fixtures from a running Studio.
 *
 * Usage:
 *   REASONIX_SERVE=http://192.168.5.3:8791 REASONIX_TOKEN=... \
 *     node scripts/record-wire-fixtures.mjs
 *
 * `REASONIX_SERVE` is the kernel origin (`/runtimes` must answer).
 * `REASONIX_TOKEN` is the token from a `#token=` link; it is exchanged for the
 * cookie the kernel expects. Without a token, the script still records the
 * public `/runtimes` answer.
 *
 * Only kernel answers are recorded. `fleet.json` describes the phone proxy's
 * own endpoint and stays hand-maintained.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = resolve(root, process.env.REASONIX_FIXTURES_DIR ?? "fixtures/wire");
const serve = (process.env.REASONIX_SERVE ?? "").replace(/\/+$/, "");
const token = process.env.REASONIX_TOKEN ?? "";
let cookie = process.env.REASONIX_COOKIE ?? "";

if (!serve) {
  console.error("REASONIX_SERVE=http://<kernel>:<port> is required");
  process.exit(2);
}

async function read(url) {
  const response = await fetch(url, { headers: cookie ? { cookie } : {} });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
}

async function save(name, value) {
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
  console.log(`wrote ${resolve(directory, name)}`);
}

if (!cookie && token) {
  const response = await fetch(`${serve}/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (response.ok) cookie = (response.headers.get("set-cookie") ?? "").split(";")[0];
}

const runtimes = await read(`${serve}/runtimes`);
if (!Array.isArray(runtimes)) throw new Error("/runtimes did not answer an array");
await save("runtimes.json", runtimes);

const first = runtimes.find((row) => row && typeof row.base === "string" && row.base);
if (first) {
  const base = new URL(first.base, `${serve}/`).toString().replace(/\/+$/, "");
  const status = await read(`${base}/status`);
  await save("status.json", status);
} else {
  console.log("no open pane; left status.json unchanged");
}