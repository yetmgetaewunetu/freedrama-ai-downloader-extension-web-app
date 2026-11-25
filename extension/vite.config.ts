import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";

function renameIndexToPopup(): Plugin {
  return {
    name: "rename-index-to-popup",
    enforce: "post",
    generateBundle(_options, bundle) {
      const indexAsset = bundle["index.html"];
      if (indexAsset) {
        indexAsset.fileName = "popup.html";
        bundle["popup.html"] = indexAsset;
        delete bundle["index.html"];
      }
    }
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), renameIndexToPopup()],
  root: path.resolve(import.meta.dirname, "src/popup"),
  base: "./",
  build: {
    outDir: path.resolve(import.meta.dirname, "dist"),
    emptyOutDir: false,
    rollupOptions: {
      input: path.resolve(import.meta.dirname, "src/popup/index.html"),
      output: {
        entryFileNames: "assets/popup-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash].[ext]"
      }
    }
  }
});
