const esbuild = require("esbuild")
const path = require("path")
const fs = require("fs")
const builtins = require("builtin-modules").default || require("builtin-modules")

// Embed the plugin stylesheet into main.js so the UI is self-contained (no
// separate styles.css to copy when installing). Missing file -> empty string.
const cssPath = path.join(__dirname, "styles.css")
let __MUGS_CSS__ = ""
try { __MUGS_CSS__ = fs.readFileSync(cssPath, "utf8") } catch (e) { /* optional */ }

const banner = `/*
MUGS — Multi-User Git Sync.
This bundle is the development build (unminified). Run "npm run dev" to watch.
*/`

const context = await esbuild.context({
  banner: { js: banner },
  entryPoints: ["src/main.ts"],
  define: { __MUGS_CSS__: JSON.stringify(__MUGS_CSS__) },
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    // node:-prefixed built-ins (e.g. node:child_process) resolve from the
    // Electron/Node runtime at load time; leave them external.
    "node:*",
    ...builtins,
  ],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: "inline",
  treeShaking: true,
  outfile: "main.js",
  watch: true,
})

await context.watch()
