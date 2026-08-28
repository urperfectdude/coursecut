import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Standalone from every other app's Vite config on purpose, same as
// apps/web's own (see that file's header). Port 5174 rather than apps/web's
// 5173 or desktop's 1420, so all three dev servers can run side by side —
// 5173/3000 are already taken locally.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      // apps/stepcut-api runs on :3001. Proxying keeps the SPA same-origin in
      // dev, so the session cookie behaves exactly as it will in production
      // behind Caddy — no CORS special-casing that only exists locally.
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
