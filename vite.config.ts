import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The UI is built to a pair of fixed-name files, which scripts/embed.mjs then
// bakes into the binary as string constants. Hashed names and code splitting
// would both defeat that, so they're switched off.
//
// In dev, `npm run dev:ui` serves the UI with HMR on 5173 and proxies /api to
// a gitc binary running on 7893 - so the frontend reloads instantly while the
// real engine answers the data calls.
export default defineConfig({
  root: "src/ui",
  base: "/",
  plugins: [react()],
  build: {
    outDir: "../../build/ui",
    emptyOutDir: true,
    cssCodeSplit: false,
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        entryFileNames: "app.js",
        assetFileNames: "app.[ext]",
        manualChunks: undefined,
      },
    },
  },
  server: {
    // Pinned to IPv4: Vite otherwise binds ::1 only, and every other part of
    // gitc (the engine, the app window, the screenshot harness) speaks
    // 127.0.0.1.
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      // Anchored with a trailing slash on purpose. A bare "/api" prefix also
      // matches "/api.ts" - our own source module - and proxies it to the
      // engine, which 404s it and leaves the app blank with no clue why.
      "^/api/": {
        target: "http://127.0.0.1:7893",
        changeOrigin: false,
      },
    },
  },
});
