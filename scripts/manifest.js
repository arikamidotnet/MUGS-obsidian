// Bumps the plugin version in both package.json and manifest.json.
// Usage: npm run manifest -- 0.2.0   (defaults to a patch bump)
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

writeJson(pkgPath, { ...readJson(pkgPath), version });
writeJson(manPath, { ...readJson(manPath), version });
// versions.json drives updates for BRAT/manual installs — a missing entry means
// teammates on that channel never receive the release.
writeJson(verPath, {
  ...readJson(verPath),
  [version]: "https://raw.githubusercontent.com/arikamidotnet/MUGS-obsidian/main/main.js",
});
console.log(`Version bumped to ${version} (package.json, manifest.json, versions.json)`);
