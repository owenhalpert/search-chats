import { build } from "esbuild";
import { chmod } from "node:fs/promises";

await build({
  entryPoints: ["src/cli.ts"],
  outfile: "bin/search-chats.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  legalComments: "eof",
  banner: { js: "#!/usr/bin/env node" },
});
await chmod("bin/search-chats.js", 0o755);
