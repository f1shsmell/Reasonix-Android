#!/usr/bin/env node
/**
 * Capture a screen of the web build in a real browser, for UI pull requests.
 *
 * Runs the mock kernel, forces the dev preview flags (`?native=1&session=demo`)
 * so native-only controls and a chat screen are drawn, and drives a headless
 * Chrome or Edge over CDP at a phone viewport in light and dark. The capture is
 * evidence for a review, not a gate: it never runs in CI, and anything only a
 * native activity does still needs a device smoke.
 *
 *   npm run shots -- --out=shots/studio
 *   npm run shots -- --out=shots/studio-before --prefix=before --hide='[aria-label="打开 Studio"]'
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg?.startsWith("--")) continue;
    const body = arg.slice(2);
    const equals = body.indexOf("=");
    const name = equals === -1 ? body : body.slice(0, equals);
    const inline = equals === -1 ? undefined : body.slice(equals + 1);
    out[name] = inline ?? argv[index + 1];
    if (inline === undefined) index += 1;
  }
  return out;
}

const options = parseArgs(process.argv.slice(2));
const port = Number(options.port ?? 5274);
const cdpPort = Number(options["cdp-port"] ?? 9333);
const outDir = resolve(root, options.out ?? "shots");
const prefix = options.prefix ?? "after";
const viewport = (options.viewport ?? "390x900").split("x").map(Number);
const width = viewport[0] ?? 390;
const height = viewport[1] ?? 900;
const query = options.query ?? "native=1&session=demo";
const hide = options.hide ?? null;
const url = `http://127.0.0.1:${port}/?${query}`;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function browserCandidates() {
  if (process.env.SHOT_BROWSER) return [process.env.SHOT_BROWSER];
  if (process.platform === "win32") {
    return [
      join(process.env.ProgramFiles ?? "C:/Program Files", "Google/Chrome/Application/chrome.exe"),
      join(process.env["ProgramFiles(x86)"] ?? "C:/Program Files (x86)", "Microsoft/Edge/Application/msedge.exe"),
      join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe"),
    ];
  }
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
  ];
}

function findBrowser() {
  const found = browserCandidates().find((path) => path && existsSync(path));
  if (!found) {
    throw new Error("No Chrome or Edge found. Point SHOT_BROWSER at a Chromium binary.");
  }
  return found;
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // The process is already gone.
    }
  }
}

async function waitForHttp(target) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(target);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await sleep(200);
  }
  throw new Error(`No answer from ${target}`);
}

async function connectCdp(endpoint) {
  let page = null;
  for (let attempt = 0; attempt < 100 && page === null; attempt += 1) {
    try {
      const response = await fetch(`${endpoint}/json/list`);
      const targets = await response.json();
      page = targets.find((target) => target.type === "page") ?? null;
    } catch {
      page = null;
    }
    if (page === null) await sleep(200);
  }
  if (page === null) throw new Error("The browser never offered a page target.");

  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((done, fail) => {
    socket.onopen = done;
    socket.onerror = fail;
  });
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((done, fail) => {
      const id = ++sequence;
      pending.set(id, (message) =>
        message.error ? fail(new Error(`${method}: ${message.error.message}`)) : done(message.result),
      );
      socket.send(JSON.stringify({ id, method, params }));
    });
  return { socket, send };
}

async function waitForSelector(send, selector, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const answer = await send("Runtime.evaluate", {
      expression: `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
      returnByValue: true,
    });
    if (answer.result.value === true) return;
    await sleep(200);
  }
  throw new Error(`The page never drew ${selector}. (Is the mock session id still \`demo\`?)`);
}

async function capture(send, theme, file) {
  await send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: theme }],
  });
  await sleep(400);
  const shot = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
  writeFileSync(file, Buffer.from(shot.data, "base64"));
}

async function main() {
  const browser = findBrowser();
  const profile = join(tmpdir(), `reasonix-shots-${process.pid}`);
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const vite = spawn(
    process.execPath,
    [join(root, "node_modules/vite/bin/vite.js"), "--mode", "mock", "--port", String(port), "--strictPort"],
    { cwd: root, stdio: "ignore", detached: process.platform !== "win32" },
  );
  const chromium = spawn(
    browser,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: "ignore", detached: process.platform !== "win32" },
  );

  let socket = null;
  try {
    await waitForHttp(`http://127.0.0.1:${port}/`);
    const cdp = await connectCdp(`http://127.0.0.1:${cdpPort}`);
    socket = cdp.socket;
    const { send } = cdp;

    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await send("Page.navigate", { url });
    await waitForSelector(send, ".chat-head");
    await waitForSelector(send, '[aria-label="打开 Studio"]');
    await sleep(600);

    if (hide) {
      const matched = await send("Runtime.evaluate", {
        expression: `document.querySelectorAll(${JSON.stringify(hide)}).length`,
        returnByValue: true,
      });
      if (matched.exceptionDetails) throw new Error(`--hide is not a valid selector: ${hide}`);
      console.log(`Hiding ${matched.result.value} element(s) matching ${hide}`);
      await send("Runtime.evaluate", {
        expression: `[...document.querySelectorAll(${JSON.stringify(hide)})].forEach((el) => { el.style.display = "none"; })`,
      });
      await sleep(200);
    }

    const written = [];
    for (const theme of ["light", "dark"]) {
      const file = join(outDir, `${prefix}-${theme}.png`);
      await capture(send, theme, file);
      written.push(file);
    }

    console.log(`Wrote ${written.length} file(s) to ${outDir}`);
    for (const file of written) console.log(`  ${file}`);
    console.log(
      "Headless web render: label it in the PR, and keep the device smoke for anything only the native shell does.",
    );
  } finally {
    socket?.close();
    killTree(chromium);
    killTree(vite);
    await sleep(400);
    rmSync(profile, { recursive: true, force: true });
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
      console.warn(`Port ${port} still answers; a dev server may have been running before this script.`);
    } catch {
      // Expected: the mock server is gone.
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
