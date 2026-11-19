import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

const appVersion = (process.env.PKG_VERSION
  || readFileSync(new URL("./VERSION", import.meta.url), "utf8")).trim();

export default defineConfig({
  root: "src",
  base: "./",
  plugins: [solid()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    cssTarget: "chrome120",
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./src/index.html", import.meta.url)),
        pin: fileURLToPath(new URL("./src/pin.html", import.meta.url)),
        pulse: fileURLToPath(new URL("./src/pulse.html", import.meta.url)),
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
  },
});
