# Concept/Entity Auto-Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-extract concepts and entities from paper wiki pages during ingest via a second LLM call, creating bidirectional backlinks between papers and concept/entity pages.

**Architecture:** New module `conceptExtractor.ts` handles LLM-based extraction with JSON response parsing. Two new functions in `wikiStorage.ts` handle concept page creation/merge and paper backlink injection. `ingest.ts` wires the extraction into the existing pipeline after `writeWikiPage()`, gated behind a new `autoExtractConcepts` preference (default `true`).

**Tech Stack:** TypeScript, OpenAI-compatible API via XMLHttpRequest, Firefox XPCOM for file I/O

---

## File Structure

| File                              | Action | Purpose                                                      |
| --------------------------------- | ------ | ------------------------------------------------------------ |
| `src/modules/conceptExtractor.ts` | Create | LLM prompts + JSON parsing for concept/entity extraction     |
| `src/modules/wikiStorage.ts`      | Modify | Add `writeConceptPage()`, `appendSeeAlsoToPaper()`           |
| `src/modules/ingest.ts`           | Modify | Wire extraction into ingest pipeline after `writeWikiPage()` |
| `addon/prefs.js`                  | Modify | Add `autoExtractConcepts` pref                               |
| `src/modules/preferenceScript.ts` | Modify | Mirror `autoExtractConcepts` default                         |

---

### Task 1: Add autoExtractConcepts preference

**Files:**

- Modify: `addon/prefs.js:4`
- Modify: `src/modules/preferenceScript.ts:26-28`

- [ ] **Step 1: Add pref to addon/prefs.js**

Edit `addon/prefs.js` — add after the `requestTimeout` line:

```js
pref("apiEndpoint", "https://api.openai.com/v1");
pref("apiKey", "");
pref("modelName", "gpt-4o");
pref("requestTimeout", 120);
pref("autoExtractConcepts", true);
```

- [ ] **Step 2: Add default to preferenceScript.ts**

Edit `src/modules/preferenceScript.ts` — in `ensureDefaults()`, add after `requestTimeout` block:

```ts
if (!getPref("autoExtractConcepts")) {
  setPref("autoExtractConcepts", true);
}
```

- [ ] **Step 3: Commit**

```bash
git add addon/prefs.js src/modules/preferenceScript.ts
git commit -m "feat: add autoExtractConcepts preference default"
```

---

### Task 2: Create conceptExtractor.ts (LLM-based extraction)

**Files:**

- Create: `src/modules/conceptExtractor.ts`

- [ ] **Step 1: Write the module**

Create `src/modules/conceptExtractor.ts`:

````ts
import { callLLM } from "./llmProvider";

// ─── Types ───

export interface ConceptExtraction {
  name: string;
  englishSlug: string;
  type: "concept" | "entity";
  definition: string;
  relevance: string;
}

// ─── Prompts ───

function buildExtractionPrompt(): string {
  return `You are a knowledge extraction specialist. Given a paper's wiki summary, identify key concepts and named entities.

## Definitions
- A "concept" is an abstract method, theory, framework, or technique (e.g., "Self-Attention Mechanism", "Bayesian Inference", "Contrastive Learning").
- An "entity" is a concrete named thing (e.g., "ImageNet", "GPT-4", "AlphaFold", "TCGA").

## Output Format
Respond with ONLY a JSON array (no markdown fences, no extra text). Each entry:

{
  "name": "Original name of the concept/entity",
  "englishSlug": "filesystem-safe-english-slug",
  "type": "concept" | "entity",
  "definition": "2-3 sentence precise definition",
  "relevance": "How this paper uses or relates to this concept/entity (1 sentence)"
}

## Rules
- Maximum 3 concepts + 3 entities total (6 max)
- Only include items significant enough to warrant their own wiki page
- If no significant concepts/entities are found, output: []
- englishSlug: lowercase, hyphen-separated, no special characters, max 50 chars`;
}

function buildExtractionUserPrompt(
  title: string,
  wikiContent: string,
  abstract: string,
): string {
  return [
    `# Paper Title\n${title}`,
    `# Abstract\n${abstract || "(not available)"}`,
    `# Wiki Summary\n${wikiContent}`,
    "\nExtract key concepts and named entities from this paper as a JSON array.",
  ].join("\n\n");
}

// ─── JSON Parser ───

function parseConceptResponse(response: string): ConceptExtraction[] {
  // Try direct parse first
  let cleaned = response.trim();
  try {
    const result = JSON.parse(cleaned);
    if (Array.isArray(result)) return validateExtractions(result);
  } catch {
    // continue to extraction methods
  }

  // Try extracting from ```json fences
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      const result = JSON.parse(fenceMatch[1].trim());
      if (Array.isArray(result)) return validateExtractions(result);
    } catch {
      // continue
    }
  }

  // Try finding JSON array in the text
  const arrayMatch = cleaned.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (arrayMatch) {
    try {
      const result = JSON.parse(arrayMatch[0]);
      if (Array.isArray(result)) return validateExtractions(result);
    } catch {
      // give up
    }
  }

  Zotero.debug(
    `[llmwiki] conceptExtractor: failed to parse JSON from: ${cleaned.slice(0, 200)}`,
  );
  return [];
}

function validateExtractions(items: any[]): ConceptExtraction[] {
  const result: ConceptExtraction[] = [];
  let conceptCount = 0;
  let entityCount = 0;

  for (const item of items) {
    if (!item.name || !item.englishSlug || !item.type || !item.definition)
      continue;
    if (item.type !== "concept" && item.type !== "entity") continue;
    if (item.type === "concept" && conceptCount >= 3) continue;
    if (item.type === "entity" && entityCount >= 3) continue;

    // Sanitize englishSlug: lowercase, replace spaces/specials with hyphens, trim to 50
    const slug = item.englishSlug
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 50);

    if (item.type === "concept") conceptCount++;
    if (item.type === "entity") entityCount++;

    result.push({
      name: String(item.name).trim(),
      englishSlug: slug,
      type: item.type,
      definition: String(item.definition).trim(),
      relevance: String(item.relevance || "").trim(),
    });
  }

  return result;
}

// ─── Main Export ───

export async function extractConcepts(
  title: string,
  wikiContent: string,
  abstract: string,
): Promise<ConceptExtraction[]> {
  const systemPrompt = buildExtractionPrompt();
  const userPrompt = buildExtractionUserPrompt(title, wikiContent, abstract);

  Zotero.debug("[llmwiki] extracting concepts/entities via LLM...");
  const response = await callLLM([
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ]);
  Zotero.debug(
    `[llmwiki] concept extraction response: ${response.slice(0, 300)}`,
  );

  const concepts = parseConceptResponse(response);
  Zotero.debug(`[llmwiki] extracted ${concepts.length} concepts/entities`);
  return concepts;
}
````

- [ ] **Step 2: Build to verify compilation**

```bash
npm run build
```

Expected: Build succeeds with no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add src/modules/conceptExtractor.ts
git commit -m "feat: add conceptExtractor module for LLM-based concept/entity extraction"
```

---

### Task 3: Add writeConceptPage to wikiStorage.ts

**Files:**

- Modify: `src/modules/wikiStorage.ts` (add imports, writeConceptPage, appendSeeAlsoToPaper, helpers)

- [ ] **Step 1: Update imports at top of wikiStorage.ts**

Edit `src/modules/wikiStorage.ts` line 1 — replace the imports block. The existing imports are at lines 1-8:

```ts
import { titleToSlug } from "../utils/sanitize";
import {
  getWikiBaseDir,
  getRawDir,
  makeDir,
  writeFile,
  readFile,
  ensureDirs,
} from "../utils/xpcom";
```

No import changes needed for Task 3 — `readFile`, `writeFile`, `getWikiBaseDir` are already imported. For the LLM merge call, we'll import `callLLM` from `llmProvider`. Let me add the import after the xpcom import:

```ts
import { callLLM } from "./llmProvider";
```

Wait, actually we'll be using `callLLM` for the merge. And we'll use `parseFrontmatter` from wikiReader for splitting pages. Let me look at what needs importing.

For `writeConceptPage`: needs `getWikiBaseDir`, `readFile`, `writeFile` (already imported), `callLLM` (new import), `parseFrontmatter` (new import from wikiReader).
For `appendSeeAlsoToPaper`: needs `getWikiBaseDir`, `readFile`, `writeFile` (already imported).

But there's a potential circular dependency issue: wikiReader.ts imports from xpcom, wikiStorage.ts imports from xpcom + wikiReader.ts. That should be fine since wikiReader.ts doesn't import from wikiStorage.ts.

Let me re-check if there's a circular dependency. wikiReader.ts imports: xpcom. wikiStorage.ts would import: xpcom, llmProvider, wikiReader. None of these import from wikiStorage, so no cycle.

Actually wait, let me reconsider. Instead of importing parseFrontmatter from wikiReader, I can just inline a simple frontmatter extraction or use string manipulation. The parseFrontmatter function is simple. But importing it is cleaner and avoids duplication.

Let me keep the import from wikiReader.

- [ ] **Step 1: Update imports in wikiStorage.ts**

Replace the existing imports (lines 1-8) with:

```ts
import { titleToSlug } from "../utils/sanitize";
import {
  getWikiBaseDir,
  getRawDir,
  makeDir,
  writeFile,
  readFile,
  ensureDirs,
} from "../utils/xpcom";
import { callLLM } from "./llmProvider";
import { parseFrontmatter } from "./wikiReader";
import type { ConceptExtraction } from "./conceptExtractor";
```

- [ ] **Step 2: Add writeConceptPage function**

Add after the `appendToSection` function (before the closing of the file). Insert at the end of `src/modules/wikiStorage.ts`:

```ts
// ─── Concept/Entity Page Writer ───

function buildConceptPage(
  concept: ConceptExtraction,
  paperSlug: string,
  paperTitle: string,
): string {
  const now = new Date().toISOString().slice(0, 10);
  const dir = concept.type === "concept" ? "concepts" : "entities";

  const frontmatter = [
    "---",
    `title: "${escapeYaml(concept.name)}"`,
    `type: ${concept.type}`,
    `slug: ${concept.englishSlug}`,
    `created: ${now}`,
    `updated: ${now}`,
    "tags: []",
    "---",
    "",
  ].join("\n");

  const body = [
    "## Definition",
    concept.definition,
    "",
    "## Related Papers",
    `- [[papers/${paperSlug}|${escapeYaml(paperTitle)}]] — ${concept.relevance || "Related work"}`,
    "",
    "## See Also",
    "",
  ].join("\n");

  return frontmatter + body;
}

function buildMergePrompt(): string {
  return `You are merging new paper information into an existing wiki page.
Given the EXISTING page body (without YAML frontmatter) and a NEW paper reference, produce the merged page body.

## Rules
- Add the new paper to ## Related Papers with the provided relevance description
- If the new paper provides richer understanding, improve the ## Definition
- Keep existing ## See Also links intact
- Preserve ALL existing entries in ## Related Papers
- Do NOT remove any existing content unless it is factually incorrect
- Output ONLY the merged page body — no YAML frontmatter, no code fences`;
}

export async function writeConceptPage(
  concept: ConceptExtraction,
  paperSlug: string,
  paperTitle: string,
): Promise<void> {
  const dir = concept.type === "concept" ? "concepts" : "entities";
  const filePath = `${getWikiBaseDir()}/${dir}/${concept.englishSlug}.md`;
  const existingContent = readFile(filePath);

  if (!existingContent) {
    // New page — create from template
    const pageContent = buildConceptPage(concept, paperSlug, paperTitle);
    writeFile(filePath, pageContent);
    updateConceptIndex(concept);
    appendLog(
      "concept",
      `created [[${dir}/${concept.englishSlug}|${concept.name}]] from [[papers/${paperSlug}]]`,
    );
  } else {
    // Existing page — merge via LLM
    try {
      const { frontmatter, body } = parseFrontmatter(existingContent);

      const userPrompt = [
        "# Existing Page Body",
        body,
        "",
        `# New Paper to Merge`,
        `Title: ${paperTitle}`,
        `Relevance: ${concept.relevance || "Related work"}`,
        `Link: [[papers/${paperSlug}|${paperTitle}]]`,
        "",
        "Merge the new paper into the existing page body as specified.",
      ].join("\n");

      Zotero.debug(
        `[llmwiki] merging concept: ${concept.name} into existing page`,
      );
      const mergedBody = await callLLM([
        { role: "system", content: buildMergePrompt() },
        { role: "user", content: userPrompt },
      ]);

      // If Definition was improved, update it in frontmatter as well via updated date
      const now = new Date().toISOString().slice(0, 10);
      const newFrontmatter = Object.entries(frontmatter)
        .map(([k, v]) => {
          if (k === "updated") return `updated: ${now}`;
          return `${k}: ${v.includes(" ") || v.includes('"') ? `"${escapeYaml(v)}"` : v}`;
        })
        .join("\n");

      const mergedContent = `---\n${newFrontmatter}\n---\n\n${mergedBody}`;
      writeFile(filePath, mergedContent);
      updateConceptIndex(concept);
      appendLog(
        "merge",
        `updated [[${dir}/${concept.englishSlug}|${concept.name}]] with paper [[papers/${paperSlug}]]`,
      );
    } catch (e: any) {
      // Fallback: simple append to Related Papers without LLM
      Zotero.debug(
        `[llmwiki] concept merge failed, using simple append: ${e.message}`,
      );
      const now = new Date().toISOString().slice(0, 10);
      const updated = existingContent
        .replace(/^updated: .*$/m, `updated: ${now}`)
        .replace(
          /(## Related Papers\n)/,
          `$1- [[papers/${paperSlug}|${escapeYaml(paperTitle)}]] — ${concept.relevance || "Related work"}\n`,
        );
      writeFile(filePath, updated);
      updateConceptIndex(concept);
    }
  }
}

function updateConceptIndex(concept: ConceptExtraction): void {
  const indexPath = `${getWikiBaseDir()}/index.md`;
  const now = new Date().toISOString().slice(0, 10);
  const dir = concept.type === "concept" ? "concepts" : "entities";
  const sectionHeading =
    concept.type === "concept" ? "## Concepts" : "## Entities";
  const linkLine = `- [[${dir}/${concept.englishSlug}|${escapeYaml(concept.name)}]]`;

  let content = readFile(indexPath);
  if (!content) return;

  // Ensure the section exists
  if (!content.includes(sectionHeading)) {
    // Insert after ## Papers section or before end
    if (content.includes("## Papers")) {
      content = content.replace(
        /(## Papers[\s\S]*?)(\n## |\n*$)/,
        (_match: string, papers: string, after: string) =>
          `${papers}\n\n${sectionHeading}\n${linkLine}\n${after}`,
      );
    } else {
      content += `\n\n${sectionHeading}\n${linkLine}\n`;
    }
  } else {
    // Section exists — check if this concept/entity is already listed
    if (!content.includes(linkLine)) {
      content = content.replace(
        new RegExp(`(${sectionHeading}\n)`),
        `$1${linkLine}\n`,
      );
    }
  }

  // Update updated date
  content = content.replace(/^updated: .*$/m, `updated: ${now}`);
  content = content.replace(/^Last updated: .*$/m, `Last updated: ${now}`);

  writeFile(indexPath, content);
}

// ─── Backlink Writer ───

export function appendSeeAlsoToPaper(
  paperSlug: string,
  conceptSlug: string,
  conceptName: string,
  conceptType: "concept" | "entity",
): void {
  const cleanSlug = paperSlug.replace(/^papers\//, "").replace(/\.md$/, "");
  const filePath = `${getWikiBaseDir()}/papers/${cleanSlug}.md`;
  const content = readFile(filePath);
  if (!content) return;

  const dir = conceptType === "concept" ? "concepts" : "entities";
  const linkLine = `- [[${dir}/${conceptSlug}|${conceptName}]]`;

  // Check if this link already exists
  if (content.includes(linkLine)) return;

  const lines = content.split("\n");
  const seeAlsoIdx = lines.findIndex((l: string) => /^## See Also\s*$/.test(l));

  let newContent: string;
  const now = new Date().toISOString().slice(0, 10);

  if (seeAlsoIdx >= 0) {
    // Insert after ## See Also heading
    const before = lines.slice(0, seeAlsoIdx + 1);
    const after = lines.slice(seeAlsoIdx + 1);
    newContent = before.join("\n") + "\n" + linkLine + "\n" + after.join("\n");
  } else {
    // No See Also section — append at end
    newContent = content.trimEnd() + `\n\n## See Also\n${linkLine}\n`;
  }

  newContent = newContent.replace(/^updated: .*$/m, `updated: ${now}`);
  writeFile(filePath, newContent);
}
```

- [ ] **Step 2: Build to verify compilation**

```bash
npm run build
```

Expected: Build succeeds. TypeScript may warn about the regex in `updateConceptIndex` — verify no errors.

- [ ] **Step 3: Commit**

```bash
git add src/modules/wikiStorage.ts
git commit -m "feat: add writeConceptPage and appendSeeAlsoToPaper for concept/entity support"
```

---

### Task 4: Wire concept extraction into ingest.ts

**Files:**

- Modify: `src/modules/ingest.ts:67-74` (after writeWikiPage, before progress/success)

- [ ] **Step 1: Add imports at top of ingest.ts**

Edit `src/modules/ingest.ts` — add after existing imports (after line 7):

```ts
import { extractConcepts } from "./conceptExtractor";
import { writeConceptPage, appendSeeAlsoToPaper } from "./wikiStorage";
import { getPref } from "../utils/prefs";
```

Wait, `getPref` might already be imported. Let me check. Actually, looking at the existing imports of ingest.ts (lines 1-7):

```ts
import { callLLM } from "./llmProvider";
import {
  buildSystemPrompt,
  buildUserPrompt,
  writeWikiPage,
  PaperMetadata,
} from "./wikiStorage";
import { getString } from "../utils/locale";
import type { FluentMessageId } from "../../typings/i10n";
import { writeRaw } from "./rawStorage";
import { extractFulltext } from "./pdfExtractor";
import { titleToSlug } from "../utils/sanitize";
```

No `getPref` import. Need to add it.

- [ ] **Step 1: Add imports**

Add after existing imports in `src/modules/ingest.ts`:

```ts
import { getPref } from "../utils/prefs";
import { extractConcepts } from "./conceptExtractor";
import { writeConceptPage, appendSeeAlsoToPaper } from "./wikiStorage";
```

- [ ] **Step 2: Add concept extraction after writeWikiPage**

In `src/modules/ingest.ts`, find the lines after `writeWikiPage()` call (approximately lines 67-74):

```ts
const filePath = await writeWikiPage(metadata.title, wikiContent, metadata);
Zotero.debug(`[llmwiki] wiki saved to ${filePath}`);

progress.startCloseTimer(0);
showNotification(
  getString("ingest-success", { args: { title: metadata.title.slice(0, 80) } }),
  "success",
);
```

Replace with:

```ts
const filePath = await writeWikiPage(metadata.title, wikiContent, metadata);
Zotero.debug(`[llmwiki] wiki saved to ${filePath}`);

// Phase 4: Extract concepts and entities
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
    Zotero.debug(`[llmwiki] extracted ${concepts.length} concepts/entities`);

    for (const c of concepts) {
      progress.changeLine({
        text: `Writing ${c.type}: ${c.name.slice(0, 60)}...`,
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
  getString("ingest-success", { args: { title: metadata.title.slice(0, 80) } }),
  "success",
);
```

Note: `slug` is defined earlier in ingest.ts as `const slug = titleToSlug(metadata.title);` at approximately line 27.

- [ ] **Step 3: Add localization string to en-US**

Edit `addon/locale/en-US/addon.ftl` — add after line 13 (`ingest-error-no-metadata`):

```ftl
ingest-extracting-concepts = Extracting concepts from "{ $title }"...
```

- [ ] **Step 4: Add localization string to zh-CN**

Edit `addon/locale/zh-CN/addon.ftl` — add after the `ingest-error-no-metadata` line:

```ftl
ingest-extracting-concepts = 正在从 "{ $title }" 提取概念...
```

- [ ] **Step 5: Build to verify compilation**

```bash
npm run build
```

Expected: Build succeeds.

- [ ] **Step 6: Run lint check**

```bash
npm run lint:check
```

Expected: No lint errors.

- [ ] **Step 7: Commit**

```bash
git add src/modules/ingest.ts addon/locale/
git commit -m "feat: wire concept/entity extraction into ingest pipeline"
```

---

### Task 5: End-to-end verification

- [ ] **Step 1: Start dev server and test manually**

```bash
npm start
```

Verification steps:

1. Open Zotero with the development profile
2. Select a paper with clear concepts (e.g., a transformer/attention paper)
3. Right-click → "LLM Wiki: Ingest"
4. After ingest completes, check `llm-wiki/wiki/concepts/` and `llm-wiki/wiki/entities/` for generated pages
5. Open the wiki browser panel — verify concept/entity pages appear in the tree
6. Open the generated concept page — verify Definition, Related Papers, See Also sections
7. Open the paper page — verify `## See Also` has backlinks to concepts
8. Ingest a second paper on the same topic — verify concept pages merge correctly
9. Disable `autoExtractConcepts` in preferences — verify ingest still works without extraction

- [ ] **Step 2: Final commit for any fixes**

If verification found issues, fix and commit:

```bash
git add <fixed-files>
git commit -m "fix: concept extraction verification fixes"
```
