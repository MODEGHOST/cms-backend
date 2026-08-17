/**
 * Import plan signers (name/position/signature) from รายชื่อ.xlsx into assets.
 * Usage: node scripts/import-plan-signers.js [path-to-xlsx]
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import xlsx from "xlsx";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const OUT_DIR = resolve(ROOT, "assets/plan-signers");
const DEFAULT_XLSX = resolve(__dirname, "names-source.xlsx");

function extractZip(xlsxPath, destDir) {
  if (existsSync(destDir)) {
    execFileSync("powershell", [
      "-NoProfile",
      "-Command",
      `Remove-Item -LiteralPath '${destDir}' -Recurse -Force`,
    ]);
  }
  mkdirSync(destDir, { recursive: true });
  execFileSync("powershell", [
    "-NoProfile",
    "-Command",
    `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory('${xlsxPath.replace(/'/g, "''")}', '${destDir.replace(/'/g, "''")}')`,
  ]);
}

function parseDrawingMap(extractDir) {
  const drawingPath = resolve(extractDir, "xl/drawings/drawing1.xml");
  const relsPath = resolve(extractDir, "xl/drawings/_rels/drawing1.xml.rels");
  if (!existsSync(drawingPath) || !existsSync(relsPath)) return new Map();

  const relsXml = readFileSync(relsPath, "utf8");
  const ridToFile = new Map();
  for (const match of relsXml.matchAll(
    /Id="(rId\d+)"[^>]*Target="([^"]+)"/g,
  )) {
    const file = match[2].replace(/^\.\.\/media\//, "");
    ridToFile.set(match[1], file);
  }

  const drawingXml = readFileSync(drawingPath, "utf8");
  const anchors = [...drawingXml.matchAll(/<xdr:twoCellAnchor[\s\S]*?<\/xdr:twoCellAnchor>/g)];
  const items = [];
  for (const anchor of anchors) {
    const block = anchor[0];
    const rowMatch = block.match(/<xdr:from>[\s\S]*?<xdr:row>(\d+)<\/xdr:row>[\s\S]*?<xdr:rowOff>(\d+)<\/xdr:rowOff>/);
    const ridMatch = block.match(/r:embed="(rId\d+)"/);
    if (!rowMatch || !ridMatch) continue;
    const file = ridToFile.get(ridMatch[1]);
    if (!file) continue;
    items.push({
      row: Number(rowMatch[1]),
      rowOff: Number(rowMatch[2]),
      file,
    });
  }
  items.sort((a, b) => a.row - b.row || a.rowOff - b.rowOff);
  // Map in visual order to Excel data rows 1..n
  const rowToImage = new Map();
  items.forEach((item, index) => {
    rowToImage.set(index + 1, item.file);
  });
  return rowToImage;
}

function slugify(name) {
  return String(name || "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\w\u0E00-\u0E7F-]+/g, "")
    .slice(0, 40) || "signer";
}

function main() {
  const xlsxPath = resolve(process.argv[2] || DEFAULT_XLSX);
  if (!existsSync(xlsxPath)) {
    console.error("Excel not found:", xlsxPath);
    process.exit(1);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const extractDir = resolve(__dirname, "_names_extract");
  extractZip(xlsxPath, extractDir);

  const wb = xlsx.readFile(xlsxPath);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(sheet, { defval: "" });
  const rowToImage = parseDrawingMap(extractDir);

  const signers = [];
  rows.forEach((row, index) => {
    const excelRow = index + 1; // header is row 0
    const position = String(row["ตำแหน่ง"] || row.position || "").trim();
    const name = String(row["ชื่อสกุล"] || row.name || "").trim();
    if (!name) return;
    const mediaName = rowToImage.get(excelRow);
    let signatureFile = null;
    if (mediaName) {
      const src = resolve(extractDir, "xl/media", mediaName);
      const ext = mediaName.includes(".") ? mediaName.split(".").pop() : "png";
      signatureFile = `signer-${String(index + 1).padStart(2, "0")}-${slugify(name)}.${ext}`;
      writeFileSync(resolve(OUT_DIR, signatureFile), readFileSync(src));
    }
    signers.push({
      id: index + 1,
      name,
      position,
      signature_file: signatureFile,
    });
  });

  writeFileSync(
    resolve(OUT_DIR, "signers.json"),
    JSON.stringify({ updated_at: new Date().toISOString(), signers }, null, 2),
    "utf8",
  );
  console.log(`Imported ${signers.length} signers -> ${OUT_DIR}`);
  for (const s of signers) {
    console.log(`- ${s.id}: ${s.name} | ${s.position} | ${s.signature_file || "(no image)"}`);
  }
}

main();
