import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  build: {
    // The tldraw canvas chunk (~1.7 MB) is lazy-loaded only when a page has a
    // canvas block; the initial bundle stays small. Warn above that size.
    chunkSizeWarningLimit: 1800,
  },
});
