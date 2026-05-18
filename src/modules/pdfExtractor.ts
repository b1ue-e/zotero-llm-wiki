import { readFile } from "../utils/xpcom";

/**
 * Extract fulltext from a Zotero item's PDF attachments.
 * Returns null if no PDF found or extraction fails — does NOT block ingest.
 */
export async function extractFulltext(item: Zotero.Item): Promise<string | null> {
  try {
    // Get attachment IDs
    const attachmentIDs: number[] = item.getAttachments?.() || [];
    Zotero.debug(`[llmwiki] pdfExtractor: item has ${attachmentIDs.length} attachments`);

    if (attachmentIDs.length === 0) return null;

    // Find PDF attachments
    for (const attID of attachmentIDs) {
      const att = Zotero.Items.get(attID);
      if (!att) continue;

      // Check if this is a PDF
      const ct = (att as any).attachmentContentType
        || att.getField?.("contentType")
        || (att as any).attachmentMIMEType
        || "";
      Zotero.debug(`[llmwiki] pdfExtractor: attID=${attID} contentType="${ct}"`);

      if (ct !== "application/pdf") continue;

      // Strategy 1: Zotero.Fulltext cache
      try {
        const cacheFile = Zotero.Fulltext.getItemCacheFile(item);
        Zotero.debug(`[llmwiki] pdfExtractor: cacheFile exists=${cacheFile?.exists()}`);
        if (cacheFile?.exists()) {
          const raw = readFile(cacheFile.path);
          Zotero.debug(`[llmwiki] pdfExtractor: cacheFile path=${cacheFile.path} size=${raw?.length || 0}`);
          if (raw) {
            // Try zlib decompression (Zotero stores gzipped data)
            const text = decompressCacheData(raw);
            if (text && text.trim().length > 100) return text;
          }
        }
      } catch (e: any) {
        Zotero.debug(`[llmwiki] pdfExtractor: cache strategy failed: ${e.message || e}`);
      }

      // Strategy 2: Read PDF file directly
      try {
        // @ts-expect-error - Zotero attachment path
        const filePath = att.getFilePath?.() || att._path;
        Zotero.debug(`[llmwiki] pdfExtractor: PDF filePath=${filePath}`);
        if (filePath) {
          const pdfBytes = readFile(filePath);
          Zotero.debug(`[llmwiki] pdfExtractor: PDF file size=${pdfBytes?.length || 0}`);
          if (pdfBytes && pdfBytes.length > 100) {
            const text = extractTextFromRawPDF(pdfBytes);
            if (text && text.trim().length > 100) return text;
          }
        }
      } catch (e: any) {
        Zotero.debug(`[llmwiki] pdfExtractor: file read strategy failed: ${e.message || e}`);
      }
    }

    Zotero.debug("[llmwiki] pdfExtractor: no text extracted");
    return null;
  } catch (_e) {
    return null;
  }
}

/**
 * Try to decompress Zotero's fulltext cache data (gzip format).
 */
function decompressCacheData(raw: string): string {
  // The cache is gzip-compressed. Try to decompress.
  // In Firefox sandbox, we can use nsIStringInputStream + nsIGZIPReader
  try {
    // @ts-expect-error - XPCOM
    const stream = Components.classes["@mozilla.org/io/string-input-stream;1"]
      .createInstance(Components.interfaces.nsIStringInputStream);
    stream.setData(raw, raw.length);
    // @ts-expect-error - XPCOM
    const gzip = Components.classes["@mozilla.org/streamconv;1?from=gzip&to=uncompressed"]
      .getService(Components.interfaces.nsIStreamConverter);
    // @ts-expect-error - XPCOM
    const unzipped = Components.classes["@mozilla.org/scriptableinputstream;1"]
      .createInstance(Components.interfaces.nsIScriptableInputStream);
    unzipped.init(gzip.convert(stream));
    return unzipped.read(unzipped.available());
  } catch (_e) {
    // gzip failed, try plain text extraction
    const cleaned = raw.replace(/[^\x20-\x7E -￿\s]/g, " ");
    const words = cleaned.split(/\s+/).filter((w: string) => w.length > 2).join(" ");
    return words.length > 100 ? words : "";
  }
}

/**
 * Extract readable text from raw PDF bytes.
 */
function extractTextFromRawPDF(raw: string): string {
  // Try BT/ET text blocks
  const textBlocks: string[] = [];
  const btRegex = /BT\s*([\s\S]*?)\s*ET/g;
  let match: RegExpExecArray | null;
  while ((match = btRegex.exec(raw)) !== null) {
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
  // Fallback: filter to printable ASCII
  const cleaned = raw.replace(/[^\x20-\x7E\s\n]/g, "");
  const words = cleaned.split(/\s+/).filter((w: string) => w.length > 2).join(" ");
  return words.length > 100 ? words : "";
}
