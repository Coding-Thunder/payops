import "server-only";

/**
 * Verify that an uploaded buffer's leading bytes match its declared MIME
 * type. The Content-Type that arrives via `formData()` is attacker-
 * controlled, so we never trust it without a sniff, otherwise an HTML
 * or SVG payload labelled as `image/png` lands on disk under a `.png`
 * extension and Next's static handler still serves it as PNG, which is
 * fine, but if someone changes the extension logic the file pivots into
 * stored XSS.
 *
 * We support the same four raster MIME types the upload helpers accept
 * (PNG / JPEG / WebP / GIF). SVG is intentionally not in the allow-list
 * upstream; if it ever returns, sniff for the `<svg` opener and reject
 * any embedded `<script>` / `on*=` / `javascript:` content before save.
 */
export function bytesMatchMime(buf: Buffer, mimeType: string): boolean {
  if (!buf || buf.length < 4) return false;
  switch (mimeType) {
    case "image/png":
      // 89 50 4E 47 0D 0A 1A 0A
      return (
        buf.length >= 8 &&
        buf[0] === 0x89 &&
        buf[1] === 0x50 &&
        buf[2] === 0x4e &&
        buf[3] === 0x47 &&
        buf[4] === 0x0d &&
        buf[5] === 0x0a &&
        buf[6] === 0x1a &&
        buf[7] === 0x0a
      );
    case "image/jpeg":
      // FF D8 FF
      return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    case "image/webp":
      // "RIFF" .... "WEBP"
      return (
        buf.length >= 12 &&
        buf[0] === 0x52 &&
        buf[1] === 0x49 &&
        buf[2] === 0x46 &&
        buf[3] === 0x46 &&
        buf[8] === 0x57 &&
        buf[9] === 0x45 &&
        buf[10] === 0x42 &&
        buf[11] === 0x50
      );
    case "image/gif":
      // "GIF87a" or "GIF89a"
      return (
        buf.length >= 6 &&
        buf[0] === 0x47 &&
        buf[1] === 0x49 &&
        buf[2] === 0x46 &&
        buf[3] === 0x38 &&
        (buf[4] === 0x37 || buf[4] === 0x39) &&
        buf[5] === 0x61
      );
    default:
      return false;
  }
}

/* ─── Business documents (Files & Links) ─────────────────────────────── */

const PDF = [0x25, 0x50, 0x44, 0x46]; // "%PDF"
const ZIP = [0x50, 0x4b]; // "PK" — every OOXML container
const OLE2 = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]; // legacy Office

function startsWith(buf: Buffer, sig: readonly number[]): boolean {
  if (buf.length < sig.length) return false;
  return sig.every((byte, i) => buf[i] === byte);
}

/**
 * Reject a plausible-looking text upload that is actually markup. A .txt
 * or .csv is served as an attachment with `nosniff`, so this is defence
 * in depth rather than the only guard — but a file that opens with
 * `<script` or `<!DOCTYPE html` is not the spreadsheet the operator
 * thinks they attached, and telling them so beats storing it.
 */
function looksLikeMarkup(buf: Buffer): boolean {
  const head = buf.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
  return (
    head.startsWith("<!doctype html") ||
    head.startsWith("<html") ||
    head.startsWith("<script") ||
    head.startsWith("<?xml") ||
    head.startsWith("<svg")
  );
}

/**
 * Verify an uploaded buffer's leading bytes against its DECLARED
 * extension, for the Files feature's allow-list.
 *
 * Same threat model as `bytesMatchMime`: both the filename and the
 * Content-Type come from the client, so neither is evidence on its own.
 * The container formats can't be told apart by magic bytes — .docx,
 * .xlsx and .pptx are all ZIPs, .doc/.xls/.ppt are all OLE2 — so this
 * verifies the FAMILY, which is what actually matters: it stops an
 * executable or an HTML payload from landing under a `.pdf` name.
 *
 * Plain-text formats have no signature by definition. For those we
 * reject NUL bytes (a binary masquerading as text) and markup, and
 * otherwise accept.
 */
export function bytesMatchExtension(buf: Buffer, extension: string): boolean {
  if (!buf || buf.length === 0) return false;
  switch (extension) {
    case "pdf":
      return startsWith(buf, PDF);
    case "docx":
    case "xlsx":
    case "pptx":
      return startsWith(buf, ZIP);
    case "doc":
    case "xls":
    case "ppt":
      // Legacy Office is OLE2, but Office also happily saves a modern
      // container under the old extension, so accept either family.
      return startsWith(buf, OLE2) || startsWith(buf, ZIP);
    case "jpg":
    case "jpeg":
      return bytesMatchMime(buf, "image/jpeg");
    case "png":
      return bytesMatchMime(buf, "image/png");
    case "webp":
      return bytesMatchMime(buf, "image/webp");
    case "txt":
    case "csv":
      return !buf.subarray(0, 4096).includes(0x00) && !looksLikeMarkup(buf);
    default:
      return false;
  }
}
