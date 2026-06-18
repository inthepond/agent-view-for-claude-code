import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base "./" so built asset URLs are relative and can be rewritten to
// webview URIs by the extension host.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2020",
    chunkSizeWarningLimit: 2000,
  },
});
