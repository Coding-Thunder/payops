
/**
 * Migrate legacy disk-stored brand logos into Mongo-backed storage.
 *
 * Background: pre-2026-05-31 logo uploads wrote to public/branding/
 * and stored a `/branding/workspace-<suffix>.<ext>` path in the
 * Branding row's `logo` field. That worked in dev but is fragile on
 * DigitalOcean App Platform (the filesystem is ephemeral; written
 * files vanish on the next deploy and aren't shared between
 * instances). Commit 4caf21e moved new uploads onto the Branding doc
 * itself (`logoBytes` + `logoMimeType`) served via
 * `/api/branding/logo/{orgId}/{hash}.{ext}`.
 *
 * Legacy rows keep working as long as the file still exists on disk,
 * but they'll 404 on the next deploy. This script reads each one and
 * back-fills the bytes into Mongo so the next deploy doesn't break
 * anyone's logo.
 *
 * Run:
 *   npx tsx --require ./scripts/shim-server-only.cjs \
 *     scripts/migrate-disk-logos.ts            # dry run
 *   npx tsx --require ./scripts/shim-server-only.cjs \
 *     scripts/migrate-disk-logos.ts --apply    # write the bytes
 *
 * Idempotent: rows whose `logo` already points at /api/branding/logo/
 * are skipped. Rows whose disk file is missing are reported and left
 * alone (the operator re-uploads via the Branding admin page).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import mongoose, { Types } from "mongoose";

import { Branding, BRANDING_KEY } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";

const PUBLIC_DIR = path.join(process.cwd(), "public");
const BRANDING_DIR = path.join(PUBLIC_DIR, "branding");
const LEGACY_PREFIX = "/branding/";
const NEW_PREFIX = "/api/branding/logo/";

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

interface LegacyRow {
  _id: unknown;
  orgId?: unknown;
  key?: string;
  logo: string;
}

interface Outcome {
  id: string;
  scope: string;
  outcome: "migrated" | "missing-file" | "unsupported-ext" | "no-orgId" | "skip";
  logo: string;
  bytes?: number;
}

async function discoverLegacy(): Promise<LegacyRow[]> {
  // `select: false` is set on logoBytes at the model layer so we never
  // pull existing buffers across the wire on this scan.
  return Branding.find({ logo: { $regex: "^/branding/" } })
    .select({ _id: 1, orgId: 1, key: 1, logo: 1 })
    .lean<LegacyRow[]>();
}

function buildNewUrl(
  orgId: string | null,
  hash: string,
  ext: string,
): string {
  const key = orgId ?? BRANDING_KEY;
  return `${NEW_PREFIX}${key}/${hash}.${ext}`;
}

async function migrateRow(row: LegacyRow, apply: boolean): Promise<Outcome> {
  const id = String(row._id);
  const orgId = row.orgId ? String(row.orgId) : null;
  const scope = orgId ? `org=${orgId}` : `legacy(key=${row.key ?? BRANDING_KEY})`;

  // Skip already-migrated rows (idempotency).
  if (row.logo.startsWith(NEW_PREFIX)) {
    return { id, scope, outcome: "skip", logo: row.logo };
  }
  if (!row.logo.startsWith(LEGACY_PREFIX)) {
    return { id, scope, outcome: "skip", logo: row.logo };
  }

  // Derive the filename + extension off the URL. Defensive against
  // path traversal: only the leaf component is read, and only when
  // the resolved path stays inside BRANDING_DIR.
  const filename = path.basename(row.logo);
  const ext = path.extname(filename).slice(1).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) {
    return { id, scope, outcome: "unsupported-ext", logo: row.logo };
  }

  const fullPath = path.resolve(path.join(BRANDING_DIR, filename));
  if (!fullPath.startsWith(path.resolve(BRANDING_DIR) + path.sep)) {
    return { id, scope, outcome: "skip", logo: row.logo };
  }

  let buffer: Buffer;
  try {
    buffer = await fs.readFile(fullPath);
  } catch {
    return { id, scope, outcome: "missing-file", logo: row.logo };
  }

  const hash = createHash("sha256").update(buffer).digest("hex").slice(0, 16);
  const nextLogo = buildNewUrl(orgId, hash, ext);

  if (apply) {
    await Branding.updateOne(
      { _id: row._id },
      {
        $set: {
          logo: nextLogo,
          logoBytes: buffer,
          logoMimeType: mime,
        },
      },
    );
  }

  return {
    id,
    scope,
    outcome: "migrated",
    logo: nextLogo,
    bytes: buffer.byteLength,
  };
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  await connectMongo();
  const rows = await discoverLegacy();
  console.log(
    `Found ${rows.length} legacy disk-logo row(s) ${apply ? "(APPLY MODE)" : "(dry run, use --apply to write)"}`,
  );

  const tally = {
    migrated: 0,
    missing: 0,
    unsupported: 0,
    skipped: 0,
  };

  for (const row of rows) {
    const result = await migrateRow(row, apply);
    switch (result.outcome) {
      case "migrated":
        tally.migrated++;
        console.log(
          `  [migrated] ${result.scope}: ${result.logo} (${result.bytes} bytes)`,
        );
        break;
      case "missing-file":
        tally.missing++;
        console.log(
          `  [missing ] ${result.scope}: disk file gone — operator must re-upload (${result.logo})`,
        );
        break;
      case "unsupported-ext":
        tally.unsupported++;
        console.log(
          `  [skip-ext] ${result.scope}: unsupported extension (${result.logo})`,
        );
        break;
      case "skip":
        tally.skipped++;
        break;
      case "no-orgId":
        tally.skipped++;
        break;
    }
  }

  console.log("");
  console.log(
    `Summary: migrated=${tally.migrated}, missing=${tally.missing}, unsupported=${tally.unsupported}, skipped=${tally.skipped}`,
  );
  if (!apply && tally.migrated > 0) {
    console.log(
      `Re-run with --apply to persist (${tally.migrated} row${tally.migrated === 1 ? "" : "s"} ready).`,
    );
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
