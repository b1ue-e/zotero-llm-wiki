import { titleToSlug } from "../utils/sanitize";

function getWikiBaseDir(): string {
  const dataDir = Zotero.DataDirectory || Zotero.getStorageDirectory();
  let path: string;
  if (typeof dataDir === "string") {
    path = dataDir;
  } else {
    path = dataDir.path;
  }
  return `${path}/llm-wiki/wiki/papers`;
}

async function ensureWikiDir(): Promise<string> {
  const dir = getWikiBaseDir();
  const nsIFile = Components.classes["@mozilla.org/file/local;1"]
    .createInstance(Components.interfaces.nsIFile);
  nsIFile.initWithPath(dir);

  if (!nsIFile.exists()) {
    nsIFile.create(Components.interfaces.nsIFile.DIRECTORY_TYPE, 0o755);
  }
  return dir;
}

export async function writeWikiPage(
  title: string,
  content: string,
): Promise<string> {
  const dir = await ensureWikiDir();
  const filename = `${titleToSlug(title)}.md`;

  const file = Components.classes["@mozilla.org/file/local;1"]
    .createInstance(Components.interfaces.nsIFile);
  file.initWithPath(`${dir}/${filename}`);

  const stream = Components.classes["@mozilla.org/network/file-output-stream;1"]
    .createInstance(Components.interfaces.nsIFileOutputStream);
  stream.init(file, 0x02 | 0x08 | 0x20, 0o644, 0);

  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  stream.write(data, data.length);
  stream.close();

  return file.path;
}

export function buildSystemPrompt(): string {
  return `You are a research assistant. Your task is to compile a structured wiki entry for an academic paper.

Generate a Markdown wiki page with the following sections:

## Research Question
What problem does this paper address?

## Method
How did the authors approach the problem? Key methodology details.

## Key Findings
What are the main results and contributions?

## Conclusions
What do the authors conclude? Implications of the work.

## Limitations
What limitations do the authors acknowledge (or are apparent)?

## Related Work
Mention key related papers or competing approaches discussed.

Use clear, academic language. Be precise and concise. Write in the same language as the paper's abstract.`;
}

export function buildUserPrompt(metadata: PaperMetadata): string {
  const parts: string[] = [];
  if (metadata.title) parts.push(`# Title\n${metadata.title}`);
  if (metadata.authors) parts.push(`# Authors\n${metadata.authors}`);
  if (metadata.abstract) parts.push(`# Abstract\n${metadata.abstract}`);
  if (metadata.year) parts.push(`# Year\n${metadata.year}`);
  if (metadata.publication) parts.push(`# Publication\n${metadata.publication}`);
  if (metadata.doi) parts.push(`# DOI\n${metadata.doi}`);
  return parts.join("\n\n");
}

export interface PaperMetadata {
  title: string;
  authors?: string;
  abstract?: string;
  year?: string;
  publication?: string;
  doi?: string;
}
