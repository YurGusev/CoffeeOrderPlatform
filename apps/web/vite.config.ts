import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

const appRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: appRoot,
  plugins: [tailwindcss()],
  build: {
    emptyOutDir: true,
    outDir: resolve(appRoot, "dist/browser"),
    rollupOptions: {
      input: resolve(appRoot, "index.html"),
    },
  },
});
