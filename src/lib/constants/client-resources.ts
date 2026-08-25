/**
 * Files & Links — the shared contract between the upload UI, the API
 * routes, and the storage service.
 *
 * Product rule this file encodes: TraceTxn is NOT a drive. Direct
 * uploads are capped at 25 MB and restricted to the everyday business
 * document formats an agency actually attaches to client work. Anything
 * bigger (video, ZIPs, design masters) belongs in the tenant's own
 * storage and is recorded here as a LINK instead — see
 * `LARGE_FILE_GUIDANCE`.
 */

/** Hard ceiling for a single direct upload. */
export const MAX_FILE_UPLOAD_BYTES = 25 * 1024 * 1024;
/** Human-facing rendering of the cap. Keep the two in lockstep. */
export const MAX_FILE_UPLOAD_LABEL = "25 MB";

/**
 * Total bytes we will push through the mail transport in one send.
 * Resend caps a message at 40 MB including MIME overhead; base64
 * inflates payloads ~1.37x, so 25 MB of source bytes is the largest
 * total that reliably fits.
 */
export const MAX_EMAIL_ATTACHMENT_TOTAL_BYTES = 25 * 1024 * 1024;

/** Copy shown wherever a too-large file is rejected. */
export const LARGE_FILE_GUIDANCE =
  "This file is larger than the direct upload limit. Add it as a link in the Links section instead.";

export const FILE_FORMAT_GROUPS = [
  "documents",
  "spreadsheets",
  "images",
  "presentations",
] as const;
export type FileFormatGroup = (typeof FILE_FORMAT_GROUPS)[number];

export const FILE_FORMAT_GROUP_LABELS: Record<FileFormatGroup, string> = {
  documents: "Documents",
  spreadsheets: "Spreadsheets",
  images: "Images",
  presentations: "Presentations",
};

export interface SupportedFileFormat {
  /** Lower-case, no dot. Also the canonical id for the format. */
  extension: string;
  group: FileFormatGroup;
  /** Every Content-Type a browser might attach to this extension. The
   *  FIRST entry is what we persist + serve the file back as. */
  mimeTypes: readonly string[];
}

/**
 * The allow-list. Deliberately short: "other common business file
 * formats can be supported later based on user demand". Adding a row
 * here is the only change needed to support a new type — the sniffer,
 * the validator, and the UI hint all read from this table.
 */
export const SUPPORTED_FILE_FORMATS: readonly SupportedFileFormat[] = [
  // Documents
  { extension: "pdf", group: "documents", mimeTypes: ["application/pdf"] },
  {
    extension: "doc",
    group: "documents",
    mimeTypes: ["application/msword"],
  },
  {
    extension: "docx",
    group: "documents",
    mimeTypes: [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
  },
  { extension: "txt", group: "documents", mimeTypes: ["text/plain"] },
  // Spreadsheets
  {
    extension: "xls",
    group: "spreadsheets",
    mimeTypes: ["application/vnd.ms-excel"],
  },
  {
    extension: "xlsx",
    group: "spreadsheets",
    mimeTypes: [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
  },
  {
    extension: "csv",
    group: "spreadsheets",
    // Windows/Excel hands back several of these for the same .csv.
    mimeTypes: ["text/csv", "application/csv", "text/plain"],
  },
  // Images
  { extension: "jpg", group: "images", mimeTypes: ["image/jpeg"] },
  { extension: "jpeg", group: "images", mimeTypes: ["image/jpeg"] },
  { extension: "png", group: "images", mimeTypes: ["image/png"] },
  { extension: "webp", group: "images", mimeTypes: ["image/webp"] },
  // Presentations
  {
    extension: "ppt",
    group: "presentations",
    mimeTypes: ["application/vnd.ms-powerpoint"],
  },
  {
    extension: "pptx",
    group: "presentations",
    mimeTypes: [
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ],
  },
];

/** `.pdf,.doc,…` — ready to drop into an `<input accept>`. */
export const FILE_ACCEPT_ATTRIBUTE = SUPPORTED_FILE_FORMATS.map(
  (f) => `.${f.extension}`,
).join(",");

/** "PDF, DOC, DOCX, TXT" etc, grouped for the upload hint. */
export function supportedFormatsByGroup(): Array<{
  group: FileFormatGroup;
  label: string;
  extensions: string[];
}> {
  return FILE_FORMAT_GROUPS.map((group) => ({
    group,
    label: FILE_FORMAT_GROUP_LABELS[group],
    extensions: SUPPORTED_FILE_FORMATS.filter((f) => f.group === group).map(
      (f) => f.extension.toUpperCase(),
    ),
  }));
}

/** Lower-case extension of a filename, without the dot. "" when none. */
export function extensionOf(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

export function findFileFormat(
  fileName: string,
): SupportedFileFormat | null {
  const ext = extensionOf(fileName);
  if (!ext) return null;
  return SUPPORTED_FILE_FORMATS.find((f) => f.extension === ext) ?? null;
}

export function isSupportedFileName(fileName: string): boolean {
  return findFileFormat(fileName) !== null;
}

/** Bytes → "1.4 MB". Shared by the table, the picker, and the toasts so
 *  one file never reads as two different sizes on two screens. */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/* ─── Visibility ──────────────────────────────────────────────────────── */

/**
 * Two states, on purpose. "Do not build complex enterprise-level
 * permission management in the first version."
 */
export const FileVisibility = {
  /** Team-only: drafts, working files, internal reports. */
  INTERNAL: "INTERNAL",
  /** Available to the client: proposals, contracts, deliverables. */
  SHARED: "SHARED",
} as const;
export type FileVisibility =
  (typeof FileVisibility)[keyof typeof FileVisibility];
export const FILE_VISIBILITIES = Object.values(
  FileVisibility,
) as FileVisibility[];

export const FILE_VISIBILITY_LABELS: Record<FileVisibility, string> = {
  INTERNAL: "Internal",
  SHARED: "Shared with client",
};

export const FILE_VISIBILITY_HINTS: Record<FileVisibility, string> = {
  INTERNAL: "Only your team can see this file.",
  SHARED: "Marked as shared with the client.",
};

/* ─── Provenance ──────────────────────────────────────────────────────── */

/** How the item entered TraceTxn. Drives the "Source" column. */
export const ResourceSource = {
  /** Someone on the team picked it from their device. */
  DIRECT_UPLOAD: "DIRECT_UPLOAD",
  /** Attached to (or inserted into) an outgoing email. */
  EMAIL: "EMAIL",
  /** Provided by the client (requirements, brand assets, references). */
  CLIENT_UPLOAD: "CLIENT_UPLOAD",
} as const;
export type ResourceSource =
  (typeof ResourceSource)[keyof typeof ResourceSource];
export const RESOURCE_SOURCES = Object.values(
  ResourceSource,
) as ResourceSource[];

export const RESOURCE_SOURCE_LABELS: Record<ResourceSource, string> = {
  DIRECT_UPLOAD: "Uploaded",
  EMAIL: "Email",
  CLIENT_UPLOAD: "Client upload",
};

/** Who put it there. Surfaced verbatim as "Uploaded by Client" /
 *  "Uploaded by Business" per the spec. */
export const ResourceActorType = {
  BUSINESS: "BUSINESS",
  CLIENT: "CLIENT",
} as const;
export type ResourceActorType =
  (typeof ResourceActorType)[keyof typeof ResourceActorType];

export const RESOURCE_ACTOR_LABELS: Record<ResourceActorType, string> = {
  BUSINESS: "Uploaded by Business",
  CLIENT: "Uploaded by Client",
};

/* ─── List filters ────────────────────────────────────────────────────── */

export const FILE_FILTERS = [
  "all",
  "shared",
  "internal",
  "order",
  "email",
] as const;
export type FileFilter = (typeof FILE_FILTERS)[number];

export const FILE_FILTER_LABELS: Record<FileFilter, string> = {
  all: "All files",
  shared: "Shared with client",
  internal: "Internal",
  order: "Related to order",
  email: "Sent via email",
};

export const LINK_FILTERS = ["all", "order", "email"] as const;
export type LinkFilter = (typeof LINK_FILTERS)[number];

export const LINK_FILTER_LABELS: Record<LinkFilter, string> = {
  all: "All links",
  order: "Related to order",
  email: "Shared via email",
};

/* ─── Links ───────────────────────────────────────────────────────────── */

/** Only these two schemes are ever stored or rendered as an href.
 *  Blocks `javascript:`/`data:` from reaching an anchor tag. */
export const ALLOWED_LINK_PROTOCOLS = ["http:", "https:"] as const;

/**
 * Friendly names for the storage providers agencies actually share
 * through. Anything unmatched falls back to the bare hostname, which is
 * exactly what the "Source or domain" column wants.
 */
const KNOWN_LINK_SOURCES: ReadonlyArray<[RegExp, string]> = [
  [/(^|\.)drive\.google\.com$/, "Google Drive"],
  [/(^|\.)docs\.google\.com$/, "Google Docs"],
  [/(^|\.)dropbox\.com$/, "Dropbox"],
  [/(^|\.)onedrive\.live\.com$/, "OneDrive"],
  [/(^|\.)1drv\.ms$/, "OneDrive"],
  [/(^|\.)sharepoint\.com$/, "SharePoint"],
  [/(^|\.)wetransfer\.com$/, "WeTransfer"],
  [/(^|\.)we\.tl$/, "WeTransfer"],
  [/(^|\.)box\.com$/, "Box"],
  [/(^|\.)figma\.com$/, "Figma"],
  [/(^|\.)notion\.so$/, "Notion"],
  [/(^|\.)loom\.com$/, "Loom"],
  [/(^|\.)youtube\.com$/, "YouTube"],
  [/(^|\.)youtu\.be$/, "YouTube"],
  [/(^|\.)vimeo\.com$/, "Vimeo"],
  [/(^|\.)canva\.com$/, "Canva"],
  [/(^|\.)zoom\.us$/, "Zoom"],
  [/(^|\.)meet\.google\.com$/, "Google Meet"],
];

/** Parse + normalise a pasted URL. Returns null when it isn't an
 *  http(s) URL we're willing to render as a link. */
export function parseResourceUrl(
  raw: string,
): { url: string; host: string; source: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // A bare "drive.google.com/…" paste is the common case; assume https
  // rather than rejecting it.
  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (!(ALLOWED_LINK_PROTOCOLS as readonly string[]).includes(parsed.protocol)) {
    return null;
  }
  if (!parsed.hostname || !parsed.hostname.includes(".")) return null;
  const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
  const match = KNOWN_LINK_SOURCES.find(([re]) => re.test(host));
  return { url: parsed.toString(), host, source: match?.[1] ?? host };
}
