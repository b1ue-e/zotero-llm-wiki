# Suggestions — LLM Enhancement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the rule-based suggestion engine with LLM-powered semantic concept matching and method-level overlap detection, surfaced alongside existing results via a "Deep Scan" button.

**Architecture:** New module `src/modules/suggestionEngineLLM.ts` adds two LLM-based detectors that return the same `Suggestion[]` format. Wiki Browser gains a "Deep Scan" button that runs both engines and merges results. LLM failures are non-blocking.

**Tech Stack:** TypeScript, OpenAI-compatible API via XMLHttpRequest (`llmProvider.ts`), Firefox XPCOM DOM

---

## File Structure

| File | Action | Purpose |
|------|--------|---------|
| `src/modules/suggestionEngineLLM.ts` | Create | Two LLM-based detectors |
| `src/modules/suggestionEngine.ts` | Modify | Export `Suggestion` type |
| `src/modules/wikiBrowser.ts` | Modify | Deep Scan button, merge logic |

---

### Task 1: Export Suggestion type + Create suggestionEngineLLM.ts

**Files:**
- Modify: `src/modules/suggestionEngine.ts`
- Create: `src/modules/suggestionEngineLLM.ts`

- [ ] **Step 1: Export Suggestion type**

In `src/modules/suggestionEngine.ts`, change the `interface Suggestion` to `export interface Suggestion`:

Find: `interface Suggestion {`
Replace with: `export interface Suggestion {`

- [ ] **Step 2: Create suggestionEngineLLM.ts**

Create `src/modules/suggestionEngineLLM.ts`:

```typescript
import { callLLM } from "./llmProvider";
import { getWikiBaseDir, listDir } from "../utils/xpcom";
import { readPage } from "./wikiReader";
import type { Suggestion } from "./suggestionEngine";

// ─── Helpers ───

function makeId(type: string): string {
  return `${Date.now()}-${type}-${Math.random().toString(36).slice(2, 8)}`;
}

function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const getBigrams = (s: string): Set<string> => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const ba = getBigrams(a);
  const bb = getBigrams(b);
  let intersection = 0;
  ba.forEach(bg => { if (bb.has(bg)) intersection++; });
  const union = new Set([...ba, ...bb]).size;
  return union === 0 ? 0 : intersection / union;
}

// ─── Detector 1: Semantic Concept Matching ───

const SEMANTIC_GROUPING_PROMPT = `You are analyzing a knowledge base. Group the following concept/entity names into semantically related clusters. Only group names that clearly refer to the same or closely related concepts (synonyms, sub-types, variants of the same idea, or closely related techniques).

Rules:
- Do NOT force clusters — if a name stands alone, don't group it
- A cluster should contain 2-4 names
- Focus on conceptual overlap, not just string similarity

Return ONLY a JSON array of arrays. Example: [["single-cell-genomics","single-cell-transcriptomics"],["perturb-seq","single-cell-functional-genomics"]]`;

export async function detectSemanticPatterns(): Promise<Suggestion[]> {
  try {
    const baseDir = getWikiBaseDir();
    const results: Suggestion[] = [];

    // Collect all concept/entity names and their referencing papers
    const conceptMap: Map<string, Set<string>> = new Map();
    const conceptNames: string[] = [];

    for (const dir of ["concepts", "entities"]) {
      const catDir = `${baseDir}/${dir}`;
      const files = listDir(catDir).filter(f => f.endsWith(".md"));
      for (const pf of files) {
        const name = pf.split("/").pop()!.replace(/\.md$/, "");
        conceptNames.push(name);
        conceptMap.set(`${dir}/${name}`, new Set());
      }
    }

    if (conceptNames.length < 2) return [];

    // Find which papers reference each concept
    const papersDir = `${baseDir}/papers`;
    const paperFiles = listDir(papersDir).filter(f => f.endsWith(".md"));
    const paperConcepts: Map<string, Set<string>> = new Map();
    const paperLinks: Map<string, Set<string>> = new Map();
    const paperTitles: Map<string, string> = new Map();

    for (const pf of paperFiles) {
      const slug = `papers/${pf.split("/").pop()!.replace(/\.md$/, "")}`;
      const page = readPage(slug);
      if (!page) continue;
      paperTitles.set(slug, page.frontmatter["title"] || slug);

      const refs = new Set<string>();
      for (const m of page.body.matchAll(/\[\[(concepts|entities)\/([^\]|]+)/g)) {
        const fullSlug = `${m[1]}/${m[2]}`;
        refs.add(fullSlug);
        const entry = conceptMap.get(fullSlug);
        if (entry) entry.add(slug);
      }
      paperConcepts.set(slug, refs);

      const links = new Set<string>();
      for (const m of page.body.matchAll(/\[\[(papers)\/([^\]|]+)/g)) {
        links.add(`papers/${m[2]}`);
      }
      paperLinks.set(slug, links);
    }

    // Call LLM to group semantically related concepts
    const userPrompt = `Names:\n${conceptNames.map(n => `- ${n}`).join("\n")}\n\nGroup them:`;
    const response = await callLLM([
      { role: "system", content: SEMANTIC_GROUPING_PROMPT },
      { role: "user", content: userPrompt },
    ]);

    // Parse LLM response — extract JSON array
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    const clusters: string[][] = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(clusters)) return [];

    // For each cluster, check if papers are interlinked
    for (const cluster of clusters) {
      if (!Array.isArray(cluster) || cluster.length < 2) continue;
      const clusterSlugs = cluster.map(n => {
        // Match concept name to full slug (try concepts/ first, then entities/)
        return conceptMap.has(`concepts/${n}`) ? `concepts/${n}`
          : conceptMap.has(`entities/${n}`) ? `entities/${n}` : null;
      }).filter(Boolean) as string[];

      if (clusterSlugs.length < 2) continue;

      // Find papers referencing each concept in the cluster
      const clusterPapers = new Set<string>();
      for (const cs of clusterSlugs) {
        const papers = conceptMap.get(cs);
        if (papers) papers.forEach(p => clusterPapers.add(p));
      }

      const paperList = [...clusterPapers];
      if (paperList.length < 2) continue;

      // Check interlinking
      for (let i = 0; i < paperList.length; i++) {
        for (let j = i + 1; j < paperList.length; j++) {
          const pi = paperList[i];
          const pj = paperList[j];
          const linksI = paperLinks.get(pi);
          const linksJ = paperLinks.get(pj);
          if (linksI?.has(pj) || linksJ?.has(pi)) continue;

          results.push({
            id: makeId("llm_semantic"),
            type: "cross_paper_pattern",
            severity: "info",
            title: `Semantic overlap: "${cluster.join('", "')}"`,
            detail: `LLM detected that "${paperTitles.get(pi) || pi}" and "${paperTitles.get(pj) || pj}" use related concepts (${cluster.join(", ")}) but aren't linked.`,
            related_pages: [pi, pj, ...clusterSlugs.slice(0, 2)],
            action_label: "Create concept link",
            timestamp: new Date().toISOString(),
          });
        }
      }
    }

    return results.slice(0, 20);
  } catch (e: any) {
    Zotero.debug(`[llmwiki] suggestionEngineLLM: semantic patterns failed: ${e.message}`);
    return [];
  }
}

// ─── Detector 2: Method Overlap Detection ───

const METHOD_OVERLAP_PROMPT = `You are analyzing research papers. Given the following papers with their methods and existing concept references, find shared techniques, algorithms, experimental designs, or analytical approaches that are NOT covered by the listed concept references.

Ignore generic or universal methods (basic statistics, standard data processing, common lab techniques).

Return ONLY a JSON array. Each entry: {"papers":["slug-A","slug-B"],"shared_method":"name of shared method/approach","detail":"one sentence explaining why they overlap"}`;

export async function detectMethodOverlaps(): Promise<Suggestion[]> {
  try {
    const baseDir = getWikiBaseDir();
    const results: Suggestion[] = [];
    const papersDir = `${baseDir}/papers`;
    const paperFiles = listDir(papersDir).filter(f => f.endsWith(".md"));
    if (paperFiles.length < 2) return [];

    interface PaperMethod {
      slug: string;
      title: string;
      method: string;
      concepts: string[];
    }
    const paperMethods: PaperMethod[] = [];

    for (const pf of paperFiles) {
      const slug = `papers/${pf.split("/").pop()!.replace(/\.md$/, "")}`;
      const page = readPage(slug);
      if (!page) continue;

      // Extract ## Method section
      const sections = page.body.split(/^##\s+/m);
      let methodText = "";
      for (const sec of sections) {
        if (/^Method|^方法/i.test(sec)) {
          methodText = sec.replace(/^Method\n?/i, "").replace(/^方法\n?/, "").slice(0, 1500).trim();
          break;
        }
      }
      if (!methodText) continue;

      const concepts: string[] = [];
      for (const m of page.body.matchAll(/\[\[(concepts|entities)\/([^\]|]+)/g)) {
        concepts.push(m[2]);
      }

      paperMethods.push({
        slug,
        title: page.frontmatter["title"] || slug,
        method: methodText,
        concepts: [...new Set(concepts)].slice(0, 10),
      });
    }

    if (paperMethods.length < 2) return [];

    // Build prompt
    const papersText = paperMethods.map(p =>
      `**${p.title}** (${p.slug}): Method: ${p.method}\nConcepts: ${p.concepts.join(", ") || "none"}`
    ).join("\n\n");

    const response = await callLLM([
      { role: "system", content: METHOD_OVERLAP_PROMPT },
      { role: "user", content: `Papers:\n\n${papersText}\n\nFind method overlaps:` },
    ]);

    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    const overlaps: { papers: string[]; shared_method: string; detail: string }[] = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(overlaps)) return [];

    for (const ov of overlaps) {
      if (!ov.papers || ov.papers.length < 2) continue;
      const slugMap = new Map<string, string>();
      for (const pm of paperMethods) {
        if (ov.papers.some((sp: string) => pm.slug.includes(sp) || sp.includes(pm.slug))) {
          slugMap.set(sp, pm.slug);
        }
      }
      const matchedSlugs = ov.papers.map((sp: string) => slugMap.get(sp) || sp).slice(0, 4);

      results.push({
        id: makeId("llm_method"),
        type: "cross_paper_pattern",
        severity: "info",
        title: `Shared method: "${ov.shared_method}"`,
        detail: ov.detail || `${ov.papers.length} papers share the method "${ov.shared_method}" but aren't linked.`,
        related_pages: matchedSlugs,
        action_label: "Create concept page",
        timestamp: new Date().toISOString(),
      });
    }

    return results.slice(0, 20);
  } catch (e: any) {
    Zotero.debug(`[llmwiki] suggestionEngineLLM: method overlaps failed: ${e.message}`);
    return [];
  }
}
```

- [ ] **Step 3: Verify build**

```bash
cd /Users/shouyaoqi/zotero-llm-wiki && npm run build
```

Expected: TypeScript compilation passes.

- [ ] **Step 4: Commit**

```bash
git add src/modules/suggestionEngine.ts src/modules/suggestionEngineLLM.ts
git commit -m "feat: add LLM-based semantic pattern and method overlap detectors"
```

---

### Task 2: Add Deep Scan button and merge logic to Wiki Browser

**Files:**
- Modify: `src/modules/wikiBrowser.ts`

- [ ] **Step 1: Add import**

Add after the existing suggestionEngine import:

```typescript
import { detectSemanticPatterns, detectMethodOverlaps } from "./suggestionEngineLLM";
```

- [ ] **Step 2: Add Deep Scan button**

In the action row (where Scan All button is), add a Deep Scan button AFTER the Scan All button:

```typescript
    const deepScanBtn = doc.createElement("button");
    deepScanBtn.className = "llmwiki-suggestion-btn llmwiki-deep-scan-btn";
    deepScanBtn.textContent = "Deep Scan";
    deepScanBtn.title = "LLM-powered deep analysis (uses API tokens)";
    deepScanBtn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      scanBtn.disabled = true;
      deepScanBtn.disabled = true;
      deepScanBtn.textContent = "Scanning...";
      // Run rule engine + LLM detectors in parallel
      scanAll();
      const [semantic, methods] = await Promise.all([
        detectSemanticPatterns(),
        detectMethodOverlaps(),
      ]);
      // Merge: LLM results are cached by adding them to the rule engine cache
      const existing = getSuggestions();
      const added: string[] = [];
      for (const s of [...semantic, ...methods]) {
        const dup = existing.some(e => similarity(e.title, s.title) > 0.7);
        if (!dup) {
          // Read cache, add suggestion, write cache
          import("./suggestionEngine").then(() => {}); // no-op, just trigger
          added.push(s.id);
        }
      }
      // Store LLM suggestions in a module-level cache for display
      _llmSuggestions = [...semantic, ...methods];
      deepScanBtn.textContent = "Deep Scan";
      deepScanBtn.disabled = false;
      scanBtn.disabled = false;
      renderSuggestions();
    });
    actionRow.appendChild(deepScanBtn);
```

Wait — this approach of manipulating the cache is complex. Instead, let me add a simpler merge approach: a module-level array `_llmSuggestions` that `renderSuggestions` reads alongside `getSuggestions()`.

Add this at the top of wikiBrowser.ts, after the state initialization:

```typescript
let _llmSuggestions: Suggestion[] = [];
```

Then `renderSuggestions` merges them before displaying.

Actually, let me keep it simpler. The scanAll already writes to cache. For LLM results, I'll add them directly to the suggestions.json cache via the suggestionEngine's writeCache function. But writeCache is private.

Simplest approach: Add a `_llmSuggestions` module variable, and have `renderSuggestions` concatenate both sources.

- [ ] **Step 2: Add _llmSuggestions module variable**

After the existing state initialization (around line 36), add:

```typescript
let _llmSuggestions: { id: string; type: string; severity: string; title: string; detail: string; related_pages: string[]; action_label: string; timestamp: string }[] = [];
```

- [ ] **Step 3: Add Deep Scan button CSS**

In `PANEL_CSS`, add after the `.llmwiki-scan-btn` styles:

```css
  .llmwiki-deep-scan-btn { background: transparent; color: #1a56db; border: 1.5px solid #1a56db; font-weight: 600; white-space: nowrap; font-size: 12px; padding: 4px 14px; }
  .llmwiki-deep-scan-btn:hover { background: #e8f0fe; }
  .llmwiki-deep-scan-btn:disabled { opacity: 0.5; }
```

- [ ] **Step 4: Add Deep Scan button DOM**

In the action row, after the scanBtn is appended and before the feedbackEl, add the Deep Scan button:

```typescript
    const deepScanBtn = doc.createElement("button");
    deepScanBtn.className = "llmwiki-suggestion-btn llmwiki-deep-scan-btn";
    deepScanBtn.textContent = "Deep Scan";
    deepScanBtn.title = "LLM-powered semantic analysis";
    deepScanBtn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      scanBtn.disabled = true;
      deepScanBtn.disabled = true;
      deepScanBtn.textContent = "Scanning...";
      scanAll();
      try {
        const [semantic, methods] = await Promise.all([
          detectSemanticPatterns(),
          detectMethodOverlaps(),
        ]);
        _llmSuggestions = [...semantic, ...methods];
      } catch (e: any) {
        Zotero.debug(`[llmwiki] Deep Scan LLM error: ${e.message}`);
      }
      deepScanBtn.textContent = "Deep Scan";
      deepScanBtn.disabled = false;
      scanBtn.disabled = false;
      renderSuggestions();
    });
    actionRow.appendChild(deepScanBtn);
```

Note: `Zotero` is a global available in the Zotero runtime.

- [ ] **Step 5: Update renderSuggestions to merge LLM results**

In `renderSuggestions()`, change:

```typescript
  const suggestions = getSuggestions();
```

To:

```typescript
  const suggestions = [...getSuggestions(), ..._llmSuggestions];
```

And add a visual indicator for LLM suggestions by adding `(LLM)` to their title display:

Find the titleEl textContent line:
```typescript
    titleEl.textContent = (s.severity === "warning" ? "⚠️ " : "ℹ️ ") + s.title;
```

Change to:
```typescript
    const isLLM = s.id.includes("llm_");
    titleEl.textContent = (isLLM ? "🤖 " : s.severity === "warning" ? "⚠️ " : "ℹ️ ") + s.title;
```

- [ ] **Step 6: Verify build**

```bash
cd /Users/shouyaoqi/zotero-llm-wiki && npm run build
```

Must pass. Fix any TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add src/modules/wikiBrowser.ts
git commit -m "feat: add Deep Scan button with LLM-enhanced suggestion merging"
```

---

### Task 3: Integration test

- [ ] **Step 1: Start dev server**

```bash
npm start
```

- [ ] **Step 2: Manual test checklist**

1. Open Wiki Browser → verify "Deep Scan" button visible next to "Scan All"
2. Click "Deep Scan" → verify button shows "Scanning..." during execution
3. After scan completes — verify rule engine suggestions appear (if any)
4. Check debug log for any LLM errors: `grep "suggestionEngineLLM" "$HOME/Zotero/llm-wiki/debug.log"`
5. LLM suggestions should have 🤖 icon and `severity: "info"` border color
6. Rule engine suggestions should still have ⚠️/ℹ️ icons
7. Verify Deep Scan button re-enabled after completion

- [ ] **Step 3: Commit any fixes**

```bash
git add -A
git commit -m "fix: LLM suggestions integration polish"
```
