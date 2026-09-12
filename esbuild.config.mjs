import esbuild from "esbuild";
import { copyFileSync, mkdirSync, watch } from "node:fs";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

/**
 * `web-push` stays external, and this is not a preference — bundling it kills
 * the worker at startup (`Worker process exited (code=1)`): its CJS dependency
 * graph does not survive esbuild, so the forked process throws while loading.
 * The cost is that `node_modules` must sit beside `dist/` wherever the plugin
 * is installed from.
 */
const presets = createPluginBundlerPresets({ uiEntry: "src/ui/index.tsx" });

const worker = { ...presets.esbuild.worker, external: [...(presets.esbuild.worker.external ?? []), "web-push"] };

// The service worker is served as a plain static file from the plugin's UI
// directory (`/_plugins/<pluginId>/ui/sw.js`), so it is copied rather than
// bundled — a service worker must be a real same-origin script URL, not a
// module graph entry.
function copyServiceWorker() {
  mkdirSync("dist/ui", { recursive: true });
  copyFileSync("src/ui/sw.js", "dist/ui/sw.js");
}

const watchMode = process.argv.includes("--watch");

if (watchMode) {
  const workerCtx = await esbuild.context(worker);
  const manifestCtx = await esbuild.context(presets.esbuild.manifest);
  const uiCtx = await esbuild.context(presets.esbuild.ui);
  copyServiceWorker();
  await Promise.all([workerCtx.watch(), manifestCtx.watch(), uiCtx.watch()]);
  watch("src/ui/sw.js", () => copyServiceWorker());
  console.log("esbuild watch mode enabled for worker, manifest, ui, and sw.js");
} else {
  await Promise.all([
    esbuild.build(worker),
    esbuild.build(presets.esbuild.manifest),
    esbuild.build(presets.esbuild.ui),
  ]);
  copyServiceWorker();
  console.log("built dist/worker.js, dist/manifest.js, dist/ui/, dist/ui/sw.js");
}
