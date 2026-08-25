import { describe, expect, it } from "vitest";

import {
  MAX_FILE_UPLOAD_BYTES,
  extensionOf,
  findFileFormat,
  formatFileSize,
  isSupportedFileName,
  parseResourceUrl,
  supportedFormatsByGroup,
} from "@/lib/constants/client-resources";
import { bytesMatchExtension } from "@/server/services/file-sniff";

describe("supported file formats", () => {
  it("accepts every format the brief lists, by extension", () => {
    for (const ext of [
      "pdf",
      "doc",
      "docx",
      "txt",
      "xls",
      "xlsx",
      "csv",
      "jpg",
      "jpeg",
      "png",
      "webp",
      "ppt",
      "pptx",
    ]) {
      expect(isSupportedFileName(`report.${ext}`)).toBe(true);
    }
  });

  it("rejects the formats that belong in Links instead", () => {
    for (const name of ["render.mp4", "sources.zip", "master.psd", "app.exe"]) {
      expect(isSupportedFileName(name)).toBe(false);
    }
  });

  it("is case-insensitive about the extension", () => {
    expect(findFileFormat("Contract.PDF")?.extension).toBe("pdf");
  });

  it("ignores a path prefix when reading the extension", () => {
    expect(extensionOf("C:\\Users\\ada\\Proposal.docx")).toBe("docx");
    expect(extensionOf("/tmp/proposal.docx")).toBe("docx");
  });

  it("treats a dotfile as having no extension", () => {
    expect(extensionOf(".gitignore")).toBe("");
    expect(isSupportedFileName(".gitignore")).toBe(false);
  });

  it("groups every format for the upload hint, with no empty groups", () => {
    const groups = supportedFormatsByGroup();
    expect(groups).toHaveLength(4);
    for (const g of groups) expect(g.extensions.length).toBeGreaterThan(0);
    expect(groups.find((g) => g.group === "presentations")?.extensions).toEqual([
      "PPT",
      "PPTX",
    ]);
  });

  it("caps direct uploads at 25 MB", () => {
    expect(MAX_FILE_UPLOAD_BYTES).toBe(25 * 1024 * 1024);
  });
});

describe("formatFileSize", () => {
  it("renders one file at one size everywhere", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(2048)).toBe("2.0 KB");
    expect(formatFileSize(1024 * 1024 * 1.4)).toBe("1.4 MB");
    expect(formatFileSize(1024 * 1024 * 24)).toBe("24 MB");
  });

  it("degrades to an em-dash rather than NaN", () => {
    expect(formatFileSize(Number.NaN)).toBe("—");
    expect(formatFileSize(-1)).toBe("—");
  });
});

describe("bytesMatchExtension", () => {
  const pdf = Buffer.from("%PDF-1.7\nstuff");
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
  const ole2 = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  it("accepts real files of each family", () => {
    expect(bytesMatchExtension(pdf, "pdf")).toBe(true);
    expect(bytesMatchExtension(zip, "docx")).toBe(true);
    expect(bytesMatchExtension(ole2, "xls")).toBe(true);
    expect(bytesMatchExtension(png, "png")).toBe(true);
    expect(bytesMatchExtension(Buffer.from("a,b,c\n1,2,3\n"), "csv")).toBe(true);
  });

  it("rejects a renamed file whose bytes disagree with its extension", () => {
    // The exact attack the sniff exists for: an executable named .pdf.
    expect(bytesMatchExtension(Buffer.from("MZ\x90\x00"), "pdf")).toBe(false);
    expect(bytesMatchExtension(png, "pdf")).toBe(false);
  });

  it("rejects markup smuggled in as text", () => {
    expect(
      bytesMatchExtension(Buffer.from("<script>alert(1)</script>"), "txt"),
    ).toBe(false);
    expect(
      bytesMatchExtension(Buffer.from("  <!DOCTYPE html><html>"), "csv"),
    ).toBe(false);
  });

  it("rejects binary masquerading as text", () => {
    expect(bytesMatchExtension(Buffer.from([0x41, 0x00, 0x42]), "txt")).toBe(
      false,
    );
  });

  it("rejects an empty buffer and unknown extensions", () => {
    expect(bytesMatchExtension(Buffer.alloc(0), "pdf")).toBe(false);
    expect(bytesMatchExtension(pdf, "mp4")).toBe(false);
  });
});

describe("parseResourceUrl", () => {
  it("names the providers agencies actually share through", () => {
    expect(parseResourceUrl("https://drive.google.com/drive/folders/x")?.source)
      .toBe("Google Drive");
    expect(parseResourceUrl("https://www.dropbox.com/s/abc")?.source).toBe(
      "Dropbox",
    );
    expect(parseResourceUrl("https://we.tl/t-abc")?.source).toBe("WeTransfer");
    expect(parseResourceUrl("https://figma.com/file/x")?.source).toBe("Figma");
  });

  it("falls back to the bare host for anything unknown", () => {
    const parsed = parseResourceUrl("https://www.acme-studio.co.uk/deliverables");
    expect(parsed?.host).toBe("acme-studio.co.uk");
    expect(parsed?.source).toBe("acme-studio.co.uk");
  });

  it("assumes https for a bare paste", () => {
    expect(parseResourceUrl("drive.google.com/folders/x")?.url).toBe(
      "https://drive.google.com/folders/x",
    );
  });

  it("refuses schemes that would become a live href", () => {
    // These are the reason the URL is parsed rather than trusted: both
    // would execute if they reached an anchor tag.
    expect(parseResourceUrl("javascript:alert(1)")).toBeNull();
    expect(parseResourceUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(parseResourceUrl("file:///etc/passwd")).toBeNull();
  });

  it("refuses input with no real hostname", () => {
    expect(parseResourceUrl("")).toBeNull();
    expect(parseResourceUrl("   ")).toBeNull();
    expect(parseResourceUrl("https://localhost")).toBeNull();
  });
});
