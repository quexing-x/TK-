import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.TK_AUTO_WEB_PORT ?? 5173),
    proxy: {
      "/api": process.env.TK_AUTO_API_ORIGIN ?? "http://127.0.0.1:3100",
    },
  },
});
