/**
 * Master list of Action Plan signers (name / position / signature image).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { publicApiPath } from "../core/config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SIGNERS_DIR = resolve(__dirname, "../../assets/plan-signers");
const SIGNERS_JSON = resolve(SIGNERS_DIR, "signers.json");

function loadManifest() {
  if (!existsSync(SIGNERS_JSON)) return { signers: [] };
  try {
    return JSON.parse(readFileSync(SIGNERS_JSON, "utf8"));
  } catch {
    return { signers: [] };
  }
}

export function listPlanSigners() {
  const manifest = loadManifest();
  return (manifest.signers || [])
    .filter((row) => row?.name)
    .map((row) => ({
      id: Number(row.id),
      name: String(row.name || "").trim(),
      position: String(row.position || "").trim(),
      has_signature: Boolean(row.signature_file),
      signature_url: row.signature_file
        ? publicApiPath(`/api/plan-signers/${Number(row.id)}/signature`)
        : null,
    }));
}

export function getPlanSignerSignaturePath(id) {
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId <= 0) return null;
  const manifest = loadManifest();
  const row = (manifest.signers || []).find((item) => Number(item.id) === numericId);
  if (!row?.signature_file) return null;
  const filePath = resolve(SIGNERS_DIR, row.signature_file);
  if (!existsSync(filePath)) return null;
  return { filePath, fileName: row.signature_file, mimeType: "image/png" };
}
