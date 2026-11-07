#!/usr/bin/env node
/**
 * Hold the hand-written Android wire declarations to the kernel's Go types.
 *
 * Run with a checkout of DeepSeek-Reasonix:
 *   REASONIX_KERNEL=../DeepSeek-Reasonix node scripts/check-wire.mjs
 *
 * This is a field-and-kind gate, not a JSON schema: it catches a field the
 * kernel renamed or removed after Android declared it. Kernel-only fields are
 * allowed, because the contract is append-only and older phones ignore them.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const kernel = resolve(process.env.REASONIX_KERNEL ?? "../DeepSeek-Reasonix");
const android = resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

if (!existsSync(kernel)) {
  console.error(`kernel checkout not found: ${kernel}\nset REASONIX_KERNEL to DeepSeek-Reasonix`);
  process.exit(2);
}

function read(path) {
  return readFileSync(resolve(kernel, path), "utf8");
}

function structTags(source, name) {
  const match = source.match(new RegExp(`type ${name} struct \\{([\\s\\S]*?)\\n\\}`));
  if (!match) throw new Error(`struct ${name} not found`);
  return new Set([...match[1].matchAll(/json:"([^",]+)/g)].map((m) => m[1]));
}

function tsFields(file, name) {
  const source = readFileSync(resolve(android, file), "utf8");
  const match = source.match(new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`));
  if (!match) throw new Error(`interface ${name} not found in ${file}`);
  return [...match[1].matchAll(/^\s+([A-Za-z_]\w*)\??:/gm)].map((m) => m[1]);
}

function checkFields(label, kernelFields, androidFields) {
  const missing = androidFields.filter((field) => !kernelFields.has(field));
  if (missing.length > 0) {
    console.error(`${label}: Android declares fields the kernel no longer emits: ${missing.join(", ")}`);
    return false;
  }
  console.log(`${label}: ${androidFields.length} fields aligned`);
  return true;
}

function kindNames(source) {
  const block = source.match(/var kindNames = map\[event\.Kind\]string\{([\s\S]*?)\n\}/);
  if (!block) throw new Error("kindNames not found");
  return new Set([...block[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]));
}

const serveHub = read("internal/frontend/serve/hub_contract.go");
const serveTodos = read("internal/frontend/serve/todos.go");
const serveHistory = read("internal/frontend/serve/history.go");
const kinds = read("internal/contract/eventwire/kinds.go");
const approval = read("internal/contract/eventwire/approval.go");
const eventWire = read("internal/contract/eventwire/wire.go");

const checks = [
  ["RuntimeView", structTags(serveHub, "RuntimeView"), tsFields("src/wire/runtime.ts", "RuntimeView")],
  ["WireTodo", structTags(serveTodos, "todoItem"), tsFields("src/wire/todos.ts", "WireTodo")],
  ["HistoryMessage", structTags(serveHistory, "historyMessage"), tsFields("src/wire/history.ts", "HistoryMessage")],
  ["HistoryToolCall", structTags(serveHistory, "historyToolCall"), tsFields("src/wire/history.ts", "HistoryToolCall")],
  ["Approval", structTags(approval, "Approval"), tsFields("src/wire/events.ts", "WireApproval")],
  ["Tool", structTags(eventWire, "Tool"), tsFields("src/wire/events.ts", "WireTool")],
];

let ok = true;
for (const [label, kernelFields, androidFields] of checks) {
  ok = checkFields(label, kernelFields, androidFields) && ok;
}

const androidKinds = readFileSync(resolve(android, "src/wire/events.ts"), "utf8");
const eventBlock = androidKinds.match(/export type EventKind =([\s\S]*?);/);
if (!eventBlock) throw new Error("EventKind union not found");
const declaredKinds = [...eventBlock[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
const kernelKinds = kindNames(kinds);
const invented = declaredKinds.filter((kind) => !kernelKinds.has(kind)
  && kind !== "stream_gap" && kind !== "stream_watermark");
if (invented.length > 0) {
  console.error(`EventKind: Android declares kinds the kernel does not emit: ${invented.join(", ")}`);
  ok = false;
} else {
  console.log(`EventKind: ${declaredKinds.length} kinds aligned`);
}

process.exit(ok ? 0 : 1);