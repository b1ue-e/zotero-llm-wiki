import { readFile } from "../utils/xpcom";

/**
 * Extract fulltext from a Zotero item's PDF attachments.
 * Tries Zotero.Fulltext cache first, falls back to raw PDF file read.
 * Returns null if no PDF found or extraction fails — does NOT block ingest.
 */
export async function extractFulltext(item: Zotero.Item): Promise<string | null> {
  try {
    // Get PDF attachments via the item's own method
    const attachmentIDs: number[] = item.getAttachments?.() || [];
    if (attachmentIDs.length === 0) return null;

    const pdfAttachmentIDs: number[] = [];
    for (const attID of attachmentIDs) {
      const att = Zotero.Items.get(attID);
      if (!att) continue;
      // Check content type — may be stored as field or property
      const contentType = (att as any).attachmentContentType
        || att.getField?.("contentType")
        || "";
      if (contentType === "application/pdf" || (att as any).attachmentMIMEType === "application/pdf") {
        pdfAttachmentIDs.push(attID);
      }
    }
    if (pdfAttachmentIDs.length === 0) return null;

    // Try Zotero.Fulltext cache
    for (const attID of pdfAttachmentIDs) {
      try {
        const att = Zotero.Items.get(attID);
        if (!att) continue;
        // Zotero stores indexed text in a cache file — try to read it
        const cacheFile = Zotero.Fulltext.getItemCacheFile(item);
        if (cacheFile?.exists()) {
          const raw = readFile(cacheFile.path);
          if (raw) {
            // Cache file format: .zotero-ft-cache contains gzipped words
            // Try to decompress or extract readable text
            const text = extractTextFromCache(raw);
            if (text && text.trim().length > 100) return text;
          }
        }
      } catch (_e) {
        // Cache approach failed — try alternative
      }
    }

    // Fallback: read PDF attachment file path and extract raw text
    for (const attID of pdfAttachmentIDs) {
      try {
        const att = Zotero.Items.get(attID);
        if (!att) continue;
        const filePath = att.getFilePath?.() || (att as any)._path;
        if (filePath) {
          const pdfBytes = readFile(filePath);
          if (pdfBytes) {
            const text = extractTextFromRawPDF(pdfBytes);
            if (text && text.trim().length > 100) return text;
          }
        }
      } catch (_e) {
        // Try next attachment
      }
    }

    return null;
  } catch (_e) {
    return null;
  }
}

/**
 * Try to extract readable text from Zotero's fulltext cache format.
 * The cache is typically gzip-compressed word fragments.
 * Returns readable text or empty string.
 */
function extractTextFromCache(raw: string): string {
  // The cache file (.zotero-ft-cache) is gzip-compressed binary data
  // stored as a file. Reading it as a string will produce garbage.
  // This is a best-effort fallback — only works for plaintext caches.
  // Filter out non-printable characters, keep words and punctuation
  const cleaned = raw.replace(/[^\x20-\x7E -￿\s]/g, " ");
  const words = cleaned.split(/\s+/).filter((w) => w.length > 2).join(" ");
  return words.length > 100 ? words : "";
}

/**
 * Extract readable text from raw PDF bytes.
 * Simple extraction: filter binary content, keep printable text blocks.
 */
function extractTextFromRawPDF(raw: string): string {
  // PDFs contain text between BT/ET markers or as plain strings in parentheses
  const textBlocks: string[] = [];
  // Find text between BT and ET markers (PDF text blocks)
  const btRegex = /BT\s*([\s\S]*?)\s*ET/g;
  let match: RegExpExecArray | null;
  while ((match = btRegex.exec(raw)) !== null) {
    // Extract strings in parentheses: (text)
    const strings = match[1].match(/\(([^)]*)\)/g);
    if (strings) {
      for (const s of strings) {
        textBlocks.push(s.slice(1, -1));
      }
    }
  }
  if (textBlocks.length > 0) {
    return textBlocks.join(" ").replace(/\s+/g, " ").trim();
  }
  // Fallback: filter to printable ASCII only
  const cleaned = raw.replace(/[^\x20-\x7E\s\n]/g, "");
  const words = cleaned.split(/\s+/).filter((w) => w.length > 2).join(" ");
  return words.length > 100 ? words : "";
}
