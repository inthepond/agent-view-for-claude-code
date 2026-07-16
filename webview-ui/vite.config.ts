import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// base "./" so built asset URLs are relative and can be rewritten to
// webview URIs by the extension host. Two HTML entry points: the sidebar
// Detail view (index.html) and the editor-area Session Board (board.html).
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2020",
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL("./index.html", import.meta.url)),
        board: fileURLToPath(new URL("./board.html", import.meta.url)),
      },
    },
  },
});
