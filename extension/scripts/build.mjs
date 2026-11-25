import esbuild from "esbuild";
import { cp, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { build as viteBuild } from "vite";

const extRoot = path.resolve(import.meta.dirname, "..");
const distDir = path.join(extRoot, "dist");
const watchMode = process.argv.includes("--watch");

async function copyStaticAssets() {
  await mkdir(path.join(distDir, "icons"), { recursive: true });
  await cp(path.join(extRoot, "manifest.json"), path.join(distDir, "manifest.json"));
  await cp(path.join(extRoot, "public", "icons"), path.join(distDir, "icons"), {
    recursive: true
  });
}

async function buildPopup() {
  await viteBuild({
    configFile: path.join(extRoot, "vite.config.ts"),
    build: watchMode ? { watch: {} } : undefined
  });

  // Ensure popup entry is at dist/popup.html matching manifest.json default_popup.
  const builtIndex = path.join(distDir, "index.html");
  const targetPopup = path.join(distDir, "popup.html");
  try {
    await rename(builtIndex, targetPopup);
  } catch {
    // Already moved or in watch mode.
  }
}

async function buildExtensionScripts() {
  const common = {
    bundle: true,
    sourcemap: watchMode ? "inline" : false,
    minify: !watchMode,
    target: "chrome120",
    tsconfig: path.join(extRoot, "tsconfig.json")
  };

  if (watchMode) {
    const bgCtx = await esbuild.context({
      ...common,
      entryPoints: [path.join(extRoot, "src/background/serviceWorker.ts")],
      outfile: path.join(distDir, "background.js"),
      format: "esm"
    });
    const contentCtx = await esbuild.context({
      ...common,
      entryPoints: [path.join(extRoot, "src/content/pageDetector.ts")],
      outfile: path.join(distDir, "content.js"),
      format: "iife"
    });
    await Promise.all([bgCtx.watch(), contentCtx.watch()]);
    console.log("Watching Chrome extension scripts and popup...");
  } else {
    await Promise.all([
      esbuild.build({
        ...common,
        entryPoints: [path.join(extRoot, "src/background/serviceWorker.ts")],
        outfile: path.join(distDir, "background.js"),
        format: "esm"
      }),
      esbuild.build({
        ...common,
        entryPoints: [path.join(extRoot, "src/content/pageDetector.ts")],
        outfile: path.join(distDir, "content.js"),
        format: "iife"
      })
    ]);
  }
}

if (!watchMode) {
  await rm(distDir, { recursive: true, force: true });
}
await mkdir(distDir, { recursive: true });
await copyStaticAssets();
await buildPopup();
await buildExtensionScripts();

if (!watchMode) {
  console.log(`Built Chrome extension to ${distDir}`);
}
