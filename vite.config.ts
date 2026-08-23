import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  publicDir: "public",
  server: {
    port: 5174,
  },
  build: {
    rollupOptions: {
      // Vite's dev server serves any .html file at root automatically; production builds
      // need every page entry listed explicitly or swatch.html would be dropped. Plain
      // relative paths (resolved against `root` above) avoid pulling in Node's type
      // declarations, which tsconfig.json deliberately doesn't include (it's scoped to
      // browser code).
      input: {
        main: "index.html",
        swatch: "swatch.html",
        compare: "compare.html",
      },
    },
  },
});
