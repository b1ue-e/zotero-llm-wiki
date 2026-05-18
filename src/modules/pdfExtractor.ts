import { readBinaryFile } from "../utils/xpcom";

// Lazy-loaded pdf.js — loaded on first use to avoid init errors crashing the plugin
let _pdfjsLib: any = null;
async function getPdfjsLib(): Promise<any> {
  if (_pdfjsLib) return _pdfjsLib;
  try {
    _pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
    return _pdfjsLib;
  } catch (e: any) {
    Zotero.debug(`[llmwiki] pdfExtractor: failed to load pdf.js: ${e.message || e}`);
    return null;
  }
}

/**
 * Extract fulltext from a Zotero item's PDF attachments using pdf.js.
 * Returns null if no PDF found or extraction fails — does NOT block ingest.
 */
export async function extractFulltext(item: Zotero.Item): Promise<string | null> {
  try {
    const attachmentIDs: number[] = item.getAttachments?.() || [];
    if (attachmentIDs.length === 0) return null;

    const pdfjsLib = await getPdfjsLib();
    if (!pdfjsLib) return null;

    for (const attID of attachmentIDs) {
      const att = Zotero.Items.get(attID);
      if (!att) continue;

      const ct = (att as any).attachmentContentType
        || att.getField?.("contentType")
        || (att as any).attachmentMIMEType
        || "";
      if (ct !== "application/pdf") continue;

      try {
        // @ts-expect-error - Zotero attachment path
        const filePath = att.getFilePath?.() || att._path;
        if (!filePath) continue;

        const text = await extractPdfText(pdfjsLib, filePath);
        if (text && text.trim().length > 100) return text;
      } catch (e: any) {
        Zotero.debug(`[llmwiki] pdfExtractor: pdf.js failed: ${e.message || e}`);
      }
    }

    return null;
  } catch (_e) {
    return null;
  }
}

async function extractPdfText(pdfjsLib: any, filePath: string): Promise<string> {
  const raw = readBinaryFile(filePath);
  if (!raw || raw.length < 100) return "";

  const len = raw.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = raw.charCodeAt(i) & 0xff;
  }

  const doc = await pdfjsLib.getDocument({ data: bytes }).promise;
  const pages: string[] = [];

  for (let pageNum = 1; pageNum <= Math.min(doc.numPages, 50); pageNum++) {
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item: any) => item.str || "")
      .filter((s: string) => s.trim().length > 0)
      .join(" ");
    if (pageText.trim()) pages.push(pageText);
  }

  return pages.join("\n\n");
}
