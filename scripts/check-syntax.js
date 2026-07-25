import { readdir } from "node:fs/promises";
import { join, extname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if ([".js", ".mjs"].includes(extname(entry.name))) files.push(full);
  }
  return files;
}

const srcDir = fileURLToPath(new URL("../src", import.meta.url));
const skip = new Set(["server.js"]);
const files = (await walk(srcDir)).filter((file) => !skip.has(basename(file)));
let failed = 0;

for (const file of files) {
  try {
    await import(pathToFileURL(file).href);
  } catch (err) {
    failed += 1;
    console.error("FAIL", file, err.message);
  }
}

if (failed) {
  console.error(`Syntax check failed: ${failed} file(s)`);
  process.exit(1);
}

console.log(`Syntax check ok: ${files.length} file(s)`);
