/**
 * Extract fulltext from a Zotero item's PDF attachments.
 * Currently returns null — pdfjs-dist is incompatible with Zotero's
 * privileged sandbox (requires canvas/Worker globals).
 *
 * TODO: Use Zotero.Fulltext.indexPDF() + cache decompression for
 * sandbox-compatible PDF text extraction.
 */
export async function extractFulltext(_item: Zotero.Item): Promise<string | null> {
  return null;
}
