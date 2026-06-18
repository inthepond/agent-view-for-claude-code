// Bundles the extension host (src/extension.ts) into dist/extension.js.
// The webview UI is built separately by Vite (see webview-ui/).
const esbuild = require("esbuild");

const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: true,
  logLevel: "info",
};

async function main() {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log("[esbuild] watching…");
  } else {
    await esbuild.build(options);
    console.log("[esbuild] build complete");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
