import "server-only";

/**
 * Verify that an uploaded buffer's leading bytes match its declared MIME
 * type. The Content-Type that arrives via `formData()` is attacker-
 * controlled, so we never trust it without a sniff — otherwise an HTML
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
