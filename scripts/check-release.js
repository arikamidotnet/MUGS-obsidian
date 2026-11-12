#!/usr/bin/env node
// scripts/check-release.js
// Version/consistency verifier for release readiness (R04).
// Usage:
//   node scripts/check-release.js
//     - Validates internal consistency of package.json, manifest.json, versions.json.
//   node scripts/check-release.js 0.3.26
//     - Also asserts the provided version exactly matches the declared version.
//
// Exit codes:
//   0 on success
//   1 on any mismatch
//
// This script is intentionally read-only and does not modify any files.
// It prepares for, but does not perform, version bumps (lead decision for 0.3.27+).

const fs = require("fs");
const path = require("path");

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function fail(msg) {
  console.error("check-release: " + msg);
  process.exit(1);
}

const root = path.join(__dirname, "..");
const pkgPath = path.join(root, "package.json");
const manPath = path.join(root, "manifest.json");
const verPath = path.join(root, "versions.json");

let pkg, manifest, versions;
try {
  pkg = readJson(pkgPath);
  manifest = readJson(manPath);
  versions = readJson(verPath);
} catch (e) {
  fail("Failed to read one of package.json / manifest.json / versions.json: " + e.message);
}

const pkgVersion = pkg.version;
const manVersion = manifest.version;
const manMinApp = manifest.minAppVersion;

if (!pkgVersion || typeof pkgVersion !== "string") {
  fail("package.json is missing a valid 'version' string");
}
if (!manVersion || typeof manVersion !== "string") {
  fail("manifest.json is missing a valid 'version' string");
}
if (pkgVersion !== manVersion) {
  fail(`Version mismatch: package.json=${pkgVersion} manifest.json=${manVersion}`);
}

if (!manMinApp || typeof manMinApp !== "string") {
  fail("manifest.json is missing a valid 'minAppVersion' string");
}

// versions.json must contain an entry for the current version
if (!Object.prototype.hasOwnProperty.call(versions, manVersion)) {
  fail(`versions.json is missing an entry for version ${manVersion}`);
}

const recordedMinApp = versions[manVersion];
if (recordedMinApp !== manMinApp) {
  fail(`minAppVersion drift: manifest.json=${manMinApp} versions.json[${manVersion}]=${recordedMinApp}`);
}

// If a target version was supplied on argv, it must match exactly.
const target = process.argv[2];
if (target) {
  if (typeof target !== "string" || target.trim() === "") {
    fail("Version argument provided but empty");
  }
  if (target !== pkgVersion) {
    fail(`Provided version ${target} does not match declared version ${pkgVersion}`);
  }
  // Also ensure the version exists in versions.json (already checked above, but be explicit for callers)
  if (!Object.prototype.hasOwnProperty.call(versions, target)) {
    fail(`Target version ${target} not recorded in versions.json`);
  }
}

// Optional: if release artifacts are present at root (as they will be after `npm run build`),
// we can note their presence. We do not attempt to parse main.js; existence + size is a smoke check.
const artifacts = ["main.js", "manifest.json", "styles.css"];
for (const a of artifacts) {
  const ap = path.join(root, a);
  if (!fs.existsSync(ap)) {
    // In normal dev this may be absent; only warn. In release context the caller already ran build.
    if (target) {
      // When a version was explicitly passed (release path), require the artifacts.
      fail(`Release artifact missing: ${a} (expected after build for v${target})`);
    } else {
      console.warn(`check-release: note: ${a} not present at root (run 'npm run build' to produce)`);
    }
  }
}

console.log(
  `check-release: OK — package.json=${pkgVersion} manifest.json=${manVersion} versions.json[${manVersion}]=${recordedMinApp} minAppVersion=${manMinApp}`
);
if (target) {
  console.log(`check-release: target version ${target} matches declared version.`);
}
process.exit(0);
