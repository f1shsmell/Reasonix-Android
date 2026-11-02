#!/usr/bin/env node
/**
 * Writes the update manifest the app checks before a release.
 *
 * The manifest lives in the repository rather than only on the release: a
 * network that cannot reach GitHub directly still reads it through a mirror,
 * and release.yml refuses a tag whose manifest disagrees with it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = "f1hsmell/Reasonix-Android";
const mirrors = ["https://gh-proxy.com/", "https://ghfast.top/"];

const { version } = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const props = readFileSync(resolve(root, "android/gradle.properties"), "utf8");
const versionName = /^reasonix\.versionName=(.+)$/m.exec(props)?.[1]?.trim();
const versionCode = Number(/^reasonix\.versionCode=(\d+)$/m.exec(props)?.[1] ?? 0);

if (versionName !== version) {
  console.error(`android/gradle.properties says ${versionName ?? "nothing"}, package.json says ${version}`);
  process.exit(1);
}
if (!Number.isInteger(versionCode) || versionCode <= 0) {
  console.error("android/gradle.properties has no reasonix.versionCode");
  process.exit(1);
}

const notes = readFileSync(resolve(root, `release-notes/android/${version}.md`), "utf8")
  .replace(/\r\n/g, "\n")
  .trim();
const tag = `v${version}`;
const apk = `reasonix-for-android-${version}.apk`;
const apkUrl = `https://github.com/${repo}/releases/download/${tag}/${apk}`;

const manifest = {
  tag,
  version,
  versionCode,
  apk,
  notes,
  mirrors: mirrors.map((base) => base + apkUrl),
};

writeFileSync(resolve(root, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`latest.json: ${tag} (versionCode ${versionCode})`);
