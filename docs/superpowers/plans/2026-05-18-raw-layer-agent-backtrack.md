# Raw Layer + Agent Backtrack Implementation Plan (Phase 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a raw layer (`llm-wiki/raw/`) storing paper metadata + fulltext as JSON, give the Agent tools to search/read raw content with auto-backtracking, and enable section-aware wiki enrichment from raw data.

**Architecture:** Two new modules (`rawStorage.ts`, `pdfExtractor.ts`) feed into modified ingest flow and Agent tool system. `rawStorage` handles JSON I/O + search index. `pdfExtractor` reads PDFs via Zotero APIs. `wikiStorage.appendToSection` enables targeted wiki updates. Agent gains 3 tools with backtracking logic in system prompt.

**Tech Stack:** Zotero 9 / Firefox ESR 115 sandbox, XPCOM file I/O (already in xpcom.ts), Zotero.Fulltext API for PDF cache, pdfjs-dist for fallback parsing.

---

## File Map

| File                          | Action | Purpose                                |
| ----------------------------- | ------ | -------------------------------------- |
| `src/modules/rawStorage.ts`   | Create | Raw JSON I/O, search, index management |
| `src/modules/pdfExtractor.ts` | Create | PDF fulltext extraction                |
| `src/modules/wikiStorage.ts`  | Modify | Add `appendToSection()`                |
| `src/modules/ingest.ts`       | Modify | Add raw write + PDF extraction steps   |
| `src/modules/agentPanel.ts`   | Modify | 3 new tools + system prompt update     |

---

### Task 1: Create `src/modules/rawStorage.ts`

**Files:**

- Create: `src/modules/rawStorage.ts`

- [ ] **Step 1: Write the module**

```typescript
import {
  getWikiBaseDir,
  writeFile,
  readFile,
  listDir,
  ensureDirs,
  makeDir,
} from "../utils/xpcom";

// ─── Types ───

export interface RawPaper {
  title: string;
  authors: string;
  abstract: string;
  year: string;
  publication: string;
  doi: string;
  fulltext: string | null;
  wiki_slug: string;
  ingested_at: string;
  updated_at: string;
}

interface RawIndexEntry {
  slug: string;
  title: string;
  authors: string;
  year: string;
  wiki_slug: string;
}

interface SearchResult {
  slug: string;
  title: string;
  filePath: string;
  snippet: string;
}

// ─── Path helpers ───

function getRawDir(): string {
  let dataPath = Zotero.Prefs.get("dataDir") as string;
  if (!dataPath) {
    const storagePath = Zotero.getStorageDirectory().path;
    dataPath = storagePath.substring(0, storagePath.lastIndexOf("/"));
  }
  return `${dataPath}/llm-wiki/raw`;
}

function getRawPapersDir(): string {
  return `${getRawDir()}/papers`;
}

function getIndexPath(): string {
  return `${getRawDir()}/index.json`;
}

// ─── Init ───

function ensureRawDirs(): void {
  makeDir(getRawDir());
  makeDir(getRawPapersDir());
}

// ─── Read / Write ───

export function writeRaw(slug: string, data: RawPaper): void {
  ensureRawDirs();
  const path = `${getRawPapersDir()}/${slug}.json`;
  writeFile(path, JSON.stringify(data, null, 2));
  updateRawIndex({
    slug,
    title: data.title,
    authors: data.authors,
    year: data.year,
    wiki_slug: data.wiki_slug,
  });
}

export function readRaw(slug: string): RawPaper | null {
  const path = `${getRawPapersDir()}/${slug}.json`;
  const content = readFile(path);
  if (!content) return null;
  try {
    return JSON.parse(content) as RawPaper;
  } catch (_e) {
    return null;
  }
}

// ─── Index ───

function readIndex(): RawIndexEntry[] {
  const content = readFile(getIndexPath());
  if (!content) return [];
  try {
    return JSON.parse(content) as RawIndexEntry[];
  } catch (_e) {
    return [];
  }
}

function writeIndex(entries: RawIndexEntry[]): void {
  ensureRawDirs();
  writeFile(getIndexPath(), JSON.stringify(entries, null, 2));
}

function updateRawIndex(entry: RawIndexEntry): void {
  const entries = readIndex();
  const existing = entries.findIndex((e) => e.slug === entry.slug);
  if (existing >= 0) {
    entries[existing] = entry;
  } else {
    entries.push(entry);
  }
  writeIndex(entries);
}

// ─── Search ───

export function searchRaw(query: string): SearchResult[] {
  const results: SearchResult[] = [];
  const q = query.toLowerCase();
  const index = readIndex();

  // Pre-filter by index (title match)
  const candidates = index.filter((e) => e.title.toLowerCase().includes(q));

  // Also scan all raw files for fulltext/abstract matches
  const paperFiles = listDir(getRawPapersDir());
  for (const filePath of paperFiles) {
    if (!filePath.endsWith(".json")) continue;
    const slug =
      filePath
        .split("/")
        .pop()
        ?.replace(/\.json$/, "") || "";
    const raw = readRaw(slug);
    if (!raw) continue;

    const abstractLower = (raw.abstract || "").toLowerCase();
    const fulltextLower = (raw.fulltext || "").toLowerCase();
    const titleLower = raw.title.toLowerCase();

    if (
      titleLower.includes(q) ||
      abstractLower.includes(q) ||
      fulltextLower.includes(q)
    ) {
      // Extract snippet from fulltext or abstract
      let source = raw.abstract || "";
      if (fulltextLower.includes(q)) source = raw.fulltext || source;
      const matchIdx = source.toLowerCase().indexOf(q);
      const start = Math.max(0, matchIdx - 60);
      const end = Math.min(source.length, matchIdx + q.length + 120);
      const snippet =
        (start > 0 ? "…" : "") +
        source.slice(start, end).replace(/\n/g, " ") +
        (end < source.length ? "…" : "");

      results.push({
        slug,
        title: raw.title,
        filePath: `raw/papers/${slug}.json`,
        snippet: snippet || raw.title,
      });
    }
  }

  return results;
}
```

- [ ] **Step 2: Build**

```bash
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add src/modules/rawStorage.ts
git commit -m "feat: add rawStorage module for raw JSON layer"
```

---

### Task 2: Create `src/modules/pdfExtractor.ts`

**Files:**

- Create: `src/modules/pdfExtractor.ts`

- [ ] **Step 1: Write the module**

```typescript
// ─── PDF Fulltext Extraction ───

/**
 * Extract fulltext from a Zotero item's PDF attachments.
 * Tries Zotero.Fulltext cache first, falls back to raw PDF parsing.
 * Returns null if no PDF found or extraction fails — does NOT block ingest.
 */
export async function extractFulltext(
  item: Zotero.Item,
): Promise<string | null> {
  try {
    // Get PDF attachments
    // @ts-expect-error - Zotero internal API
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

    // Fallback: read first PDF file and extract with pdfjs
    // For Phase 3 MVP, return null if cache miss — full PDF.js
    // integration adds significant bundle size. This enables the
    // Zotero.Fulltext path for users with indexed PDFs.
    return null;
  } catch (_e) {
    return null;
  }
}
```

- [ ] **Step 2: Build**

```bash
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add src/modules/pdfExtractor.ts
git commit -m "feat: add pdfExtractor for PDF fulltext via Zotero.Fulltext"
```

---

### Task 3: Add `appendToSection` to `wikiStorage.ts`

**Files:**

- Modify: `src/modules/wikiStorage.ts`

- [ ] **Step 1: Read the file and append the function**

Read `src/modules/wikiStorage.ts` and append:

```typescript
/**
 * Append content to a specific section of a wiki page.
 * Finds the ## Section heading and inserts content before the next ## heading.
 * Creates the section at page end if it doesn't exist.
 */
export function appendToSection(
  slug: string,
  section: string,
  content: string,
): void {
  const indexPath = `${getWikiBaseDir()}/papers/${slug}.md`;
  const pageContent = readFile(indexPath);
  if (!pageContent) return;

  const sectionHeading = `## ${section}`;
  const lines = pageContent.split("\n");
  const headingIdx = lines.findIndex((l) => l.trim() === sectionHeading);

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
```

Note: `getWikiBaseDir`, `readFile`, `writeFile` are already imported from `../utils/xpcom`.

- [ ] **Step 2: Build**

```bash
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add src/modules/wikiStorage.ts
git commit -m "feat: add appendToSection for section-aware wiki updates"
```

---

### Task 4: Integrate raw write + PDF extraction into `ingest.ts`

**Files:**

- Modify: `src/modules/ingest.ts`

- [ ] **Step 1: Add imports and raw write step**

Read `src/modules/ingest.ts`. Add import at top:

```typescript
import { writeRaw } from "./rawStorage";
import { extractFulltext } from "./pdfExtractor";
import { titleToSlug } from "../utils/sanitize";
```

In `runIngest()`, after `extractMetadata(item)` and before `callLLM(...)`, add:

```typescript
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
```

- [ ] **Step 2: Build**

```bash
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add src/modules/ingest.ts
git commit -m "feat: write raw JSON layer during ingest with PDF fulltext"
```

---

### Task 5: Add 3 tools + backtracking to `agentPanel.ts`

**Files:**

- Modify: `src/modules/agentPanel.ts`

- [ ] **Step 1: Add imports**

Read `src/modules/agentPanel.ts`. Add:

```typescript
import { searchRaw, readRaw } from "./rawStorage";
import { appendToSection } from "./wikiStorage";
```

- [ ] **Step 2: Add tool definitions to TOOL_DEFINITIONS array**

Find `const TOOL_DEFINITIONS: ToolDefinition[] = [` and append after the existing 4 tools:

```typescript
  {
    type: "function",
    function: {
      name: "search_raw",
      description: "Full-text search across raw paper data (original abstracts and full text). Use when search_wiki returns insufficient results.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_raw",
      description: "Read the complete raw data of a paper by its slug, including original abstract and full text.",
      parameters: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Paper slug path like papers/slug" },
        },
        required: ["slug"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_wiki_section",
      description: "Append new information to a specific section of a wiki page. Use when raw data contains knowledge not yet in the structured wiki.",
      parameters: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Wiki page slug" },
          section: { type: "string", description: "Section name: Research Question, Method, Key Findings, Conclusions, Limitations, Related Work" },
          content: { type: "string", description: "Markdown content to append to the section" },
        },
        required: ["slug", "section", "content"],
      },
    },
  },
```

- [ ] **Step 3: Add tool executors in executeToolCall switch**

Find `async function executeToolCall(tc: ToolCall)` and add cases before `default:`:

```typescript
      case "search_raw": {
        const hits = searchRaw(args.query || "");
        result = hits.length === 0
          ? `No results found in raw layer for "${args.query}".`
          : hits.map((h: SearchResult) =>
              `- **${h.title}** (${h.slug})\n  ${h.snippet}`
            ).join("\n\n");
        break;
      }
      case "read_raw": {
        const slug = (args.slug || "").replace(/\.md$/, "");
        const rawSlug = slug.includes("/") ? slug.split("/").pop()! : slug;
        const raw = readRaw(rawSlug);
        result = raw
          ? [
              `# ${raw.title}`,
              `Authors: ${raw.authors}`,
              `Year: ${raw.year}`,
              raw.doi ? `DOI: ${raw.doi}` : "",
              "",
              `## Abstract`,
              raw.abstract || "(no abstract)",
              "",
              raw.fulltext ? `## Full Text\n${raw.fulltext.slice(0, 5000)}` : "(no full text available)",
            ].join("\n")
          : `Raw data not found for: ${args.slug}`;
        break;
      }
      case "update_wiki_section": {
        appendToSection(args.slug || "", args.section || "Additional Notes", args.content || "");
        result = `Updated wiki page "${args.slug}" → section "${args.section}".`;
        break;
      }
```

- [ ] **Step 4: Update system prompt**

In `buildSystemPrompt()`, add the raw layer guidance after the tool list:

```
## Raw Layer Access
Each wiki page has a corresponding raw data file containing the original metadata, abstract, and full text (if the PDF was available during ingest).

Guidelines for using raw tools:
- If search_wiki returns few or no results, automatically try search_raw — it searches the original abstract and full text
- If a wiki page lacks depth (e.g., sparse Method or Findings), use read_raw to get the full original text, then answer from there
- When raw data reveals important information not in the wiki, use update_wiki_section to enrich the wiki for future sessions
- update_wiki_section section names: "Research Question", "Method", "Key Findings", "Conclusions", "Limitations", "Related Work"
```

- [ ] **Step 5: Build**

```bash
npm run build
```

- [ ] **Step 6: Commit**

```bash
git add src/modules/agentPanel.ts
git commit -m "feat: add search_raw, read_raw, update_wiki_section tools + backtracking rules"
```

---

### Task 6: End-to-end build and smoke test

- [ ] **Step 1: Full production build**

```bash
npm run build
```

Expected: Zero errors.

- [ ] **Step 2: Start dev server and verify**

```bash
npm start
```

Manual verification:

1. **Raw layer creation**: Right-click a paper → "LLM Wiki: Ingest". Verify `raw/papers/<slug>.json` exists on disk with correct metadata
2. **search_raw**: In Agent, ask "what does the raw data say about X" → should trigger search_raw tool
3. **read_raw**: Ask "show me the full raw data for paper Y" → should trigger read_raw
4. **Backtracking**: Ask about a paper that's ingested (wiki exists) but ask for details likely not in wiki → Agent should search_raw or read_raw
5. **Wiki update**: After Agent finds new info in raw, it should offer to update_wiki_section
6. **Verify wiki enrichment**: Check wiki page on disk → section should have appended content
