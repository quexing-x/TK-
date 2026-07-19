import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    // ExcelJS is loaded with import() only after a spreadsheet action. Its browser
    // distribution is a single 930 KB async chunk, so keep the warning threshold
    // above that known, non-initial-load artifact while retaining warnings for larger chunks.
    chunkSizeWarningLimit: 1000,
  },
  server: {
    host: "127.0.0.1",
    port: Number(process.env.TK_AUTO_WEB_PORT ?? 5173),
    proxy: {
      "/api": process.env.TK_AUTO_API_ORIGIN ?? "http://127.0.0.1:3100",
    },
  },
});
