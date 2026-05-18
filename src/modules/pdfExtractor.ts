import { readBinaryFile } from "../utils/xpcom";

/**
 * Extract fulltext from a Zotero item's PDF attachments.
 * Uses Zotero's built-in PDF indexing engine + cache decompression.
 * Returns null if no PDF found or extraction fails — does NOT block ingest.
 */
export async function extractFulltext(item: Zotero.Item): Promise<string | null> {
  try {
    const attachmentIDs: number[] = item.getAttachments?.() || [];
    if (attachmentIDs.length === 0) return null;

    for (const attID of attachmentIDs) {
      const att = Zotero.Items.get(attID);
      if (!att) continue;

      const ct = (att as any).attachmentContentType
        || att.getField?.("contentType")
        || (att as any).attachmentMIMEType
        || "";
      if (ct !== "application/pdf") continue;

      try {
        const text = await extractFromAttachment(item, att);
        if (text && text.trim().length > 100) return text;
      } catch (e: any) {
        Zotero.debug(`[llmwiki] pdfExtractor: failed: ${e.message || e}`);
      }
    }

    return null;
  } catch (_e) {
    return null;
  }
}

async function extractFromAttachment(item: Zotero.Item, att: Zotero.Item): Promise<string | null> {
  // Fulltext operations work on the PDF ATTACHMENT, not the parent item
  // Strategy 1: Try already-indexed cache
  try {
    const isIndexed = await Zotero.Fulltext.isFullyIndexed(att);
    Zotero.debug(`[llmwiki] pdfExtractor: isFullyIndexed=${isIndexed}`);

    if (isIndexed) {
      const text = tryReadCache(att);
      if (text) return text;
    }
  } catch (e: any) {
    Zotero.debug(`[llmwiki] pdfExtractor: cache check failed: ${e.message || e}`);
  }

  // Strategy 2: Trigger indexing on the attachment, wait, read cache
  try {
    // @ts-expect-error - Zotero attachment path
    const filePath = att.getFilePath?.() || att._path;
    if (!filePath) return null;

    Zotero.debug(`[llmwiki] pdfExtractor: indexing PDF at ${filePath} attID=${att.id}`);
    const ok = await Zotero.Fulltext.indexPDF(filePath, att.id);
    Zotero.debug(`[llmwiki] pdfExtractor: indexPDF result=${ok}`);

    if (ok) {
      const text = tryReadCache(att);
      if (text) return text;
    }
  } catch (e: any) {
    Zotero.debug(`[llmwiki] pdfExtractor: indexPDF failed: ${e.message || e}`);
  }

  return null;
}

/**
 * Read and decompress Zotero's fulltext cache file.
 */
function tryReadCache(item: Zotero.Item): string | null {
  try {
    const cacheFile = Zotero.Fulltext.getItemCacheFile(item);
    if (!cacheFile?.exists()) {
      Zotero.debug("[llmwiki] pdfExtractor: cache file does not exist");
      return null;
    }

    Zotero.debug(`[llmwiki] pdfExtractor: reading cache at ${cacheFile.path}`);
    const raw = readBinaryFile(cacheFile.path);
    if (!raw || raw.length < 100) return null;

    // Decompress gzip cache
    const decompressed = decompressGzip(raw);
    if (!decompressed || decompressed.length < 100) return null;

    // The decompressed cache contains text interleaved with binary word-position data.
    // Extract readable text by filtering printable runs.
    return extractReadableText(decompressed);
  } catch (e: any) {
    Zotero.debug(`[llmwiki] pdfExtractor: cache read failed: ${e.message || e}`);
    return null;
  }
}

/**
 * Decompress gzip-compressed data using XPCOM stream converter.
 */
function decompressGzip(raw: string): string | null {
  try {
    // @ts-expect-error - XPCOM
    const inputStream = Components.classes["@mozilla.org/io/string-input-stream;1"]
      .createInstance(Components.interfaces.nsIStringInputStream);
    inputStream.setData(raw, raw.length);

    // @ts-expect-error - XPCOM
    const gzipConverter = Components.classes["@mozilla.org/streamconv;1?from=gzip&to=uncompressed"]
      .getService(Components.interfaces.nsIStreamConverter);

    const convertedStream = gzipConverter.convert(inputStream);

    // @ts-expect-error - XPCOM
    const scriptableStream = Components.classes["@mozilla.org/scriptableinputstream;1"]
      .createInstance(Components.interfaces.nsIScriptableInputStream);
    scriptableStream.init(convertedStream);

    const available = scriptableStream.available();
    if (available <= 0) return null;
    return scriptableStream.read(available);
  } catch (e: any) {
    Zotero.debug(`[llmwiki] pdfExtractor: gzip decompress failed: ${e.message || e}`);
    return null;
  }
}

/**
 * Extract readable text from decompressed fulltext cache data.
 * The cache contains text interleaved with binary word-position metadata.
 */
function extractReadableText(data: string): string {
  // Filter out binary content, keep runs of printable chars
  const cleaned = data.replace(/[^\x20-\x7E\xA0-\xFFĀ-￿\s\n\t]/g, " ");
  // Collapse whitespace
  const words = cleaned.replace(/\s+/g, " ").trim();
  // Only return if we have enough readable content
  if (words.length < 100) return "";

  // Try to extract complete sentences (runs of words ending with punctuation)
  const sentences = words.match(/[^.!?]+[.!?]/g);
  if (sentences && sentences.length > 3) {
    return sentences.join(" ");
  }

  return words;
}
