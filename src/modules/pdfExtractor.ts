/**
 * Extract fulltext from a Zotero item's PDF attachments.
 * Tries Zotero.Fulltext cache first, falls back to null if unavailable.
 * Returns null if no PDF found or extraction fails — does NOT block ingest.
 */
export async function extractFulltext(item: Zotero.Item): Promise<string | null> {
  try {
    // Get PDF attachments
    const attachments = Zotero.Items.getAttachments(item.id);
    if (!attachments || attachments.length === 0) return null;

    const pdfAttachmentIDs: number[] = [];
    for (const attID of attachments) {
      const att = Zotero.Items.get(attID);
      if (att?.attachmentContentType === "application/pdf") {
        pdfAttachmentIDs.push(attID);
      }
    }
    if (pdfAttachmentIDs.length === 0) return null;

    // Try Zotero.Fulltext cache first
    for (const attID of pdfAttachmentIDs) {
      try {
        // @ts-expect-error - Zotero internal API
        const text = await Zotero.Fulltext.getTextFromCache(item, attID);
        if (text && text.trim().length > 100) return text;
      } catch (_e) {
        // Cache miss — try next attachment
      }
    }

    // Fallback: return null for now (PDF.js integration adds significant bundle size)
    // Users with Zotero-indexed PDFs will get fulltext via cache
    return null;
  } catch (_e) {
    return null;
  }
}
