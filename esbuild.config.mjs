import { build } from "esbuild";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

const BUILD_DIR = "dist";

rmSync(BUILD_DIR, { recursive: true, force: true });
mkdirSync(BUILD_DIR, { recursive: true });

const handlers = [
  { name: "api", entry: "src/handlers/api.ts" },
];

const errors = [];

for (const { name, entry } of handlers) {
  const outdir = resolve(BUILD_DIR, name);
  mkdirSync(outdir, { recursive: true });
  const outfile = resolve(outdir, "index.mjs");

  try {
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      target: "node20",
      format: "esm",
      outfile,
      minify: true,
      sourcemap: false,
      legalComments: "none",
      // ESM Lambda needs `require` available for any CJS deps that slip in.
      banner: {
        js: "import{createRequire as _cr}from'node:module';const require=_cr(import.meta.url);",
      },
      logLevel: "warning",
    });

    if (result.errors.length > 0) {
      errors.push(`${name}: esbuild reported ${result.errors.length} error(s)`);
      continue;
    }
  } catch (err) {
    errors.push(`${name}: bundle failed — ${err.message}`);
    continue;
  }

  if (!existsSync(outfile)) {
    errors.push(`${name}: bundle not found at ${outfile}`);
    continue;
  }

  const zipPath = resolve(BUILD_DIR, `${name}.zip`);
  try {
    execSync(`cd "${outdir}" && zip -qr "${zipPath}" .`);
  } catch (err) {
    errors.push(`${name}: zip failed — ${err.message}`);
    continue;
  }

  if (!existsSync(zipPath)) {
    errors.push(`${name}: zip not found at ${zipPath}`);
    continue;
  }

  const sizeMB = (statSync(zipPath).size / 1024 / 1024).toFixed(2);
  console.log(`  ${name}.zip (${sizeMB} MB)`);
}

if (errors.length > 0) {
  console.error(`\nBuild failed with ${errors.length} error(s):`);
  errors.forEach((e) => console.error(`  ✗ ${e}`));
  process.exit(1);
}

console.log(`\nBuild complete — ${handlers.length} handler(s) packaged.`);
