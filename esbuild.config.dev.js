const esbuild = require("esbuild")
const builtins = require("builtin-modules").default || require("builtin-modules")

const banner = `/*
MUGS — Multi-User Git Sync.
This bundle is the development build (unminified). Run "npm run dev" to watch.
*/`

const context = await esbuild.context({
  banner: { js: banner },
  entryPoints: ["src/main.ts"],
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
