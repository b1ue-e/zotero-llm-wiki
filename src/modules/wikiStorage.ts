import { titleToSlug } from "../utils/sanitize";
import {
  getWikiBaseDir,
  getRawDir,
  makeDir,
  writeFile,
  readFile,
  ensureDirs,
} from "../utils/xpcom";

// ─── Directory structure (Karpathy LLM-Wiki pattern) ───
//
//   llm-wiki/
//   ├── wiki/
//   │   ├── index.md       ← catalog of all pages
//   │   ├── log.md          ← append-only operation log
//   │   ├── papers/         ← individual paper wiki pages
//   │   ├── concepts/       ← concept pages (future)
//   │   └── entities/       ← entity pages (future)
//   └── raw/                ← immutable source documents (future)
// ─── Wiki page writer (Karpathy schema) ───

export async function writeWikiPage(
  title: string,
  content: string,
  metadata: PaperMetadata,
): Promise<string> {
  ensureDirs();

  const slug = titleToSlug(title);
  const now = new Date().toISOString().slice(0, 10);
  const tags = buildTags(metadata);
  const tagStr = tags.map((t) => `"${t}"`).join(", ");

  const frontmatter = [
    "---",
    `title: "${escapeYaml(title)}"`,
    `type: paper`,
    `slug: ${slug}`,
    `created: ${now}`,
    `updated: ${now}`,
    ...(metadata.authors ? [`authors: "${escapeYaml(metadata.authors)}"`] : []),
    ...(metadata.year ? [`year: ${metadata.year}`] : []),
    ...(metadata.doi ? [`doi: "${metadata.doi}"`] : []),
    ...(metadata.publication ? [`publication: "${escapeYaml(metadata.publication)}"`] : []),
    `tags: [${tagStr}]`,
    "---",
    "",
  ].join("\n");

  const pageContent = frontmatter + content;

  const papersDir = `${getWikiBaseDir()}/papers`;
  const filePath = `${papersDir}/${slug}.md`;
  writeFile(filePath, pageContent);

  // Update index.md and log.md
  updateIndex(slug, title, metadata);
  appendLog("ingest", `paper: [[papers/${slug}|${title}]]`);

  Zotero.debug(`[llmwiki] wiki page written: ${filePath}`);
  return filePath;
}

// ─── index.md ───

function updateIndex(slug: string, title: string, metadata: PaperMetadata): void {
  const indexPath = `${getWikiBaseDir()}/index.md`;
  const now = new Date().toISOString().slice(0, 10);
  const line = `- (${metadata.year || "?"}) [[papers/${slug}|${title}]] | ${extractSummary(metadata)}`;

  let content = readFile(indexPath);
  if (!content) {
    content = [
      "---",
      `title: Wiki Index`,
      `created: ${now}`,
      `updated: ${now}`,
      "---",
      "",
      "# Wiki Index",
      "",
      `Last updated: ${now}`,
      "",
      "## Papers",
      "",
      line,
      "",
    ].join("\n");
  } else {
    // Replace updated date
    content = content.replace(
      /^updated: .*$/m,
      `updated: ${now}`,
    );
    content = content.replace(
      /^Last updated: .*$/m,
      `Last updated: ${now}`,
    );
    // Append new entry under ## Papers
    if (!content.includes(line)) {
      content = content.replace(
        /(## Papers\n)/,
        `$1${line}\n`,
      );
    }
  }
  writeFile(indexPath, content);
}

// ─── log.md ───

function appendLog(operation: string, description: string): void {
  const logPath = `${getWikiBaseDir()}/log.md`;
  const now = new Date().toISOString().slice(0, 10);

  let content = readFile(logPath);
  if (!content) {
    content = [
      "---",
      `title: Operation Log`,
      `created: ${now}`,
      "---",
      "",
      "# Operation Log",
      "",
    ].join("\n");
  }
  content += `\n## ${now} | ${operation}\n${description}\n`;
  writeFile(logPath, content);
}

function extractSummary(metadata: PaperMetadata): string {
  const abs = metadata.abstract || "";
  // Take first sentence
  const firstSentence = abs.split(/[.。]/)[0]?.trim();
  return firstSentence ? firstSentence.slice(0, 120) : "No abstract";
}

function buildTags(metadata: PaperMetadata): string[] {
  const tags: string[] = [];
  const text = `${metadata.title} ${metadata.abstract || ""} ${metadata.publication || ""}`.toLowerCase();
  // Simple keyword detection
  const keywords: [string, RegExp][] = [
    ["machine-learning", /machine.learning|deep.learning|neural.network|transformer|llm/i],
    ["genomics", /genom|gene|dna|rna|protein|mutation|hereditary/i],
    ["neuroscience", /neuron|brain|neural|cognit|cortex/i],
    ["immunology", /immun|t.cell|b.cell|antibod/i],
    ["cancer", /cancer|tumor|oncol/i],
    ["epidemiology", /epidem|public.health|cohort|prevalence/i],
    ["bioinformatics", /bioinformatic|computational|algorithm|pipeline/i],
    ["clinical", /clinical|trial|patient|therapy|treatment/i],
    ["imaging", /imaging|mri|ct.scan|microscop/i],
    ["single-cell", /single.cell|scrna|scatac|scmulti/i],
  ];
  for (const [tag, re] of keywords) {
    if (re.test(text)) tags.push(tag);
  }
  if (tags.length === 0) tags.push("research");
  return tags;
}

function escapeYaml(s: string): string {
  return s.replace(/"/g, '\\"').replace(/\n/g, " ");
}

// ─── Prompts ───

export function buildSystemPrompt(): string {
  return `You are a research assistant building a structured, interlinked Markdown knowledge base following Karpathy's LLM-Wiki schema.

You MUST respond with a complete wiki page in the format shown below. Do NOT include YAML frontmatter — it will be added automatically.

## Format Requirements

### 1. Cross-references
Use [[wiki-link]] syntax (Obsidian-compatible) when referencing:
- Other papers: [[papers/title-slug|Paper Title]]
- Concepts: [[concepts/concept-name|Concept Name]]
- Entities: [[entities/entity-name|Entity Name]]

### 2. Sections (all required)
## Research Question
What problem does this paper address? 2-3 sentences.

## Method
Key methodology details. Use bullet points.

## Key Findings
Main results and contributions. Use bullet points.

## Conclusions
What the authors conclude. Implications.

## Limitations
Limitations the authors acknowledge (or are apparent).

## Related Work
Key related papers or competing approaches discussed. Use [[wikilinks]] where appropriate.

## See Also
2-3 [[wikilinks]] to related concepts or entities that should be explored.

### 3. Style
- Academic, precise, concise
- Write in the same language as the paper's abstract
- Each section should be 2-5 sentences`;
}

export function buildUserPrompt(metadata: PaperMetadata): string {
  const parts: string[] = [];
  if (metadata.title) parts.push(`# Title\n${metadata.title}`);
  if (metadata.authors) parts.push(`# Authors\n${metadata.authors}`);
  if (metadata.abstract) parts.push(`# Abstract\n${metadata.abstract}`);
  if (metadata.year) parts.push(`# Year\n${metadata.year}`);
  if (metadata.publication) parts.push(`# Publication\n${metadata.publication}`);
  if (metadata.doi) parts.push(`# DOI\n${metadata.doi}`);
  parts.push("\nGenerate the wiki page following the required format exactly.");
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

/**
 * Append content to a specific section of a wiki page.
 * Finds the ## Section heading and inserts content before the next ## heading.
 * Creates the section at page end if it doesn't exist.
 */
export function appendToSection(slug: string, section: string, content: string): void {
  const cleanSlug = slug.replace(/^papers\//, "").replace(/\.md$/, "");
  const indexPath = `${getWikiBaseDir()}/papers/${cleanSlug}.md`;
  const pageContent = readFile(indexPath);
  if (!pageContent) return;

  const sectionHeading = `## ${section}`;
  const lines = pageContent.split("\n");
  const headingIdx = lines.findIndex((l: string) => l.trim() === sectionHeading);

  let newContent: string;
  if (headingIdx >= 0) {
    // Find next ## heading or end of file
    let nextHeading = lines.length;
    for (let i = headingIdx + 1; i < lines.length; i++) {
      if (/^##\s/.test(lines[i])) {
        nextHeading = i;
        break;
      }
    }
    // Insert content before the next heading
    const before = lines.slice(0, nextHeading);
    const after = lines.slice(nextHeading);
    newContent = before.join("\n") + "\n" + content + "\n" + after.join("\n");
  } else {
    // Section not found — append at end
    newContent = pageContent.trimEnd() + `\n\n${sectionHeading}\n${content}\n`;
  }

  // Update `updated` date
  const now = new Date().toISOString().slice(0, 10);
  newContent = newContent.replace(/^updated: .*$/m, `updated: ${now}`);

  writeFile(indexPath, newContent);

  // Also update index.md updated date
  const idxPath = `${getWikiBaseDir()}/index.md`;
  const idxContent = readFile(idxPath);
  if (idxContent) {
    const updated = idxContent
      .replace(/^updated: .*$/m, `updated: ${now}`)
      .replace(/^Last updated: .*$/m, `Last updated: ${now}`);
    writeFile(idxPath, updated);
  }
}
