// Bumps the plugin version in package.json, manifest.json, and versions.json.
// Usage: npm run manifest -- 0.2.0   (defaults to a patch bump)
//
// versions.json maps each plugin version to the minimum Obsidian app version
// it requires, per https://docs.obsidian.md/Reference/Versions. It is NOT a
// list of download URLs — Obsidian resolves release assets from the GitHub
// release tagged with the matching version. A missing entry means Obsidian
// will refuse to auto-update teammates on older versions, so every bump
// writes one.
const fs = require("fs");
const path = require("path");

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
}

const target = process.argv[2];
const pkgPath = path.join(__dirname, "..", "package.json");
const manPath = path.join(__dirname, "..", "manifest.json");
const verPath = path.join(__dirname, "..", "versions.json");

let version;
if (target) {
  version = target;
} else {
  const cur = readJson(pkgPath).version.split(".").map(Number);
  cur[2] += 1;
  version = cur.join(".");
}

const manifest = { ...readJson(manPath), version };
writeJson(pkgPath, { ...readJson(pkgPath), version });
writeJson(manPath, manifest);

// Prefer the minAppVersion recorded in manifest.json; if it is missing there,
// fall back to the newest value already known to versions.json.
const versions = readJson(verPath);
const knownKeys = Object.keys(versions).sort((a, b) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
);
const minAppVersion = manifest.minAppVersion || versions[knownKeys[knownKeys.length - 1]];
if (!minAppVersion) {
  console.error(
    `Cannot record versions.json[${version}]: manifest.json has no minAppVersion and versions.json has no prior entries.`,
  );
  process.exit(1);
}

writeJson(verPath, { ...versions, [version]: minAppVersion });
console.log(
  `Version bumped to ${version} (package.json, manifest.json; versions.json[${version}] = ${minAppVersion})`,
);
