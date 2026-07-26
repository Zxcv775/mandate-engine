import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 开发环境将 /api 代理到后端，避免引入 CORS 配置
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:3000",
    },
  },
});
