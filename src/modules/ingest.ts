import { callLLM } from "./llmProvider";
import {
  buildSystemPrompt,
  buildUserPrompt,
  writeWikiPage,
  writeConceptPage,
  appendSeeAlsoToPaper,
  PaperMetadata,
} from "./wikiStorage";
import { getString } from "../utils/locale";
import type { FluentMessageId } from "../../typings/i10n";
import { writeRaw } from "./rawStorage";
import { extractFulltext } from "./pdfExtractor";
import { getPref } from "../utils/prefs";
import { extractConcepts } from "./conceptExtractor";
import { titleToSlug } from "../utils/sanitize";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    // @ts-expect-error - Mozilla XPCOM Components is only available in Zotero/Firefox runtime
    const timer = Components.classes["@mozilla.org/timer;1"].createInstance(
      Components.interfaces.nsITimer,
    ) as any;
    timer.initWithCallback(
      resolve,
      ms,
      Components.interfaces.nsITimer.TYPE_ONE_SHOT,
    );
  });
}

export async function runIngest(item: Zotero.Item): Promise<void> {
  const metadata = extractMetadata(item);

  if (!metadata.title || (!metadata.abstract && !metadata.title)) {
    showNotification(getString("ingest-error-no-metadata"), "warning");
    return;
  }

  // Write raw layer before LLM call (preserves original data)
  const slug = titleToSlug(metadata.title);
  const fulltext = await extractFulltext(item);
  writeRaw(slug, {
    title: metadata.title,
    authors: metadata.authors || "",
    abstract: metadata.abstract || "",
    year: metadata.year || "",
    publication: metadata.publication || "",
    doi: metadata.doi || "",
    fulltext,
    wiki_slug: `papers/${slug}`,
    ingested_at: new Date().toISOString().slice(0, 10),
    updated_at: new Date().toISOString().slice(0, 10),
  });
  Zotero.debug(`[llmwiki] raw JSON saved for ${slug}`);

  const progress = new ztoolkit.ProgressWindow(addon.data.config.addonName)
    .createLine({
      text: getString("ingest-start", {
        args: { title: metadata.title.slice(0, 80) },
      }),
      type: "default",
      progress: 30,
    })
    .show();

  try {
    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserPrompt(metadata);

    Zotero.debug("[llmwiki] calling LLM...");
    const wikiContent = await callLLM([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ]);
    Zotero.debug(`[llmwiki] LLM returned ${wikiContent.length} chars`);

    progress.changeLine({
      text: `Writing wiki for "${metadata.title.slice(0, 80)}"...`,
      progress: 80,
    });

    const filePath = await writeWikiPage(metadata.title, wikiContent, metadata);
    Zotero.debug(`[llmwiki] wiki saved to ${filePath}`);

    // Extract concepts and entities
    if (getPref("autoExtractConcepts") !== false) {
      try {
        progress.changeLine({
          text: getString("ingest-extracting-concepts", {
            args: { title: metadata.title.slice(0, 60) },
          }),
          progress: 85,
        });
        const concepts = await extractConcepts(
          metadata.title,
          wikiContent,
          metadata.abstract || "",
        );
        Zotero.debug(
          `[llmwiki] extracted ${concepts.length} concepts/entities`,
        );

        for (const c of concepts) {
          progress.changeLine({
            text: getString("ingest-writing-concept", {
              args: { type: c.type, name: c.name.slice(0, 60) },
            }),
            progress: 90,
          });
          await writeConceptPage(c, slug, metadata.title);
          await appendSeeAlsoToPaper(slug, c.englishSlug, c.name, c.type);
        }
      } catch (e: any) {
        Zotero.debug(
          `[llmwiki] concept extraction failed (non-blocking): ${e.message}`,
        );
      }
    }

    progress.startCloseTimer(0);
    showNotification(
      getString("ingest-success", {
        args: { title: metadata.title.slice(0, 80) },
      }),
      "success",
    );
  } catch (e: any) {
    Zotero.debug(`[llmwiki] ingest error: ${e.message}\n${e.stack || ""}`);
    let errorKey: FluentMessageId = "ingest-error-unknown";
    if (e.message === "auth") errorKey = "ingest-error-auth";
    else if (e.message === "timeout") errorKey = "ingest-error-timeout";
    else if (e.message?.includes("fetch") || e.message?.includes("Network"))
      errorKey = "ingest-error-network";

    progress.startCloseTimer(0);
    showNotification(
      getString(errorKey, {
        args: { message: e.message?.slice(0, 100) || "" },
      }),
      "error",
    );
  }
}

function extractMetadata(item: Zotero.Item): PaperMetadata {
  return {
    title: item.getField("title") || "",
    authors: formatCreators(item),
    abstract: item.getField("abstractNote") || "",
    year: item.getField("date")?.toString() || "",
    publication: item.getField("publicationTitle") || "",
    doi: item.getField("DOI") || "",
  };
}

function formatCreators(item: Zotero.Item): string {
  const creators = item.getCreators?.() || [];
  return creators
    .filter((c: any) => c.creatorType === "author")
    .map((c: any) => `${c.firstName || ""} ${c.lastName || ""}`.trim())
    .join(", ");
}

function showNotification(
  message: string,
  type: "success" | "warning" | "error" | "default" = "default",
) {
  new ztoolkit.ProgressWindow(addon.data.config.addonName)
    .createLine({
      text: message,
      type,
      progress: 100,
    })
    .show();
}
