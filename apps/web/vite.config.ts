import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Standalone from the desktop app's Vite config on purpose (see the plan's
// §1.1): nothing here may affect how `src/` builds. Port 5173 rather than
// desktop's 1420 so both dev servers can run side by side while porting.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // `apps/api` (M3) runs on :3000. Proxying keeps the SPA same-origin in
      // dev, so the session cookie behaves exactly as it will in production
      // behind Caddy — no CORS special-casing that only exists locally.
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
