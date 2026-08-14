import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/controle-financeiro/",
  plugins: [react()],
  build: { outDir: "dist-pages", emptyOutDir: true },
});
