import { callLLM } from "./llmProvider";
import { buildSystemPrompt, buildUserPrompt, writeWikiPage, PaperMetadata } from "./wikiStorage";
import { getString } from "../utils/locale";

export async function runIngest(item: Zotero.Item): Promise<void> {
  const metadata = extractMetadata(item);

  if (!metadata.title || (!metadata.abstract && !metadata.title)) {
    showNotification(getString("ingest-error-no-metadata"), "warning");
    return;
  }

  const progress = new ztoolkit.ProgressWindow(addon.data.config.addonName)
    .createLine({
      text: getString("ingest-start", { args: { title: metadata.title.slice(0, 80) } }),
      type: "default",
      progress: 30,
    })
    .show();

  try {
    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserPrompt(metadata);

    const wikiContent = await callLLM([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ]);

    progress.changeLine({
      text: `Writing wiki for "${metadata.title.slice(0, 80)}"...`,
      progress: 80,
    });

    const filePath = await writeWikiPage(metadata.title, wikiContent);

    progress.changeLine({
      text: getString("ingest-success", { args: { title: metadata.title.slice(0, 80) } }),
      type: "success",
      progress: 100,
    });
    progress.startCloseTimer(5000);
  } catch (e: any) {
    progress.startCloseTimer(0);
    let errorKey = "ingest-error-unknown";
    if (e.message === "auth") errorKey = "ingest-error-auth";
    else if (e.message === "timeout") errorKey = "ingest-error-timeout";
    else if (e.message?.includes("fetch") || e.message?.includes("Network"))
      errorKey = "ingest-error-network";

    new ztoolkit.ProgressWindow(addon.data.config.addonName)
      .createLine({
        text: getString(errorKey, { args: { message: e.message?.slice(0, 100) || "" } }),
        type: "error",
        progress: 100,
      })
      .show();
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

function showNotification(message: string, type: "success" | "warning" | "error" | "default" = "default") {
  new ztoolkit.ProgressWindow(addon.data.config.addonName)
    .createLine({
      text: message,
      type,
      progress: 100,
    })
    .show();
}
