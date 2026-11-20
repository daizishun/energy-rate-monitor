// Client bundle for the standalone build.
//
// Bundles `client/index.html` to `client/dist/` with Bun.build:
// production React (NODE_ENV=production), minified, Tailwind via
// bun-plugin-tailwind. Run with `bun run build:client` or as part of
// `bun run build`.

import { rm } from "node:fs/promises";
import tailwindPlugin from "bun-plugin-tailwind";

const OUTDIR = "./client/dist";

await rm(OUTDIR, { force: true, recursive: true });

const result = await Bun.build({
  entrypoints: ["./client/index.html"],
  outdir: OUTDIR,
  minify: true,
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  naming: {
    asset: "assets/[name]-[hash].[ext]",
    chunk: "assets/[name]-[hash].[ext]",
    entry: "[name].[ext]",
  },
  plugins: [tailwindPlugin],
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  throw new Error("buildClient() failed; see logged diagnostics");
}
