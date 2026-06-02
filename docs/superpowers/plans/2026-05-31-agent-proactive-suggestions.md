# Agent Proactive Suggestions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically detect cross-paper patterns, knowledge gaps, and missing papers within the wiki, surfacing actionable suggestions in the Wiki Browser UI.

**Architecture:** New module `src/modules/suggestionEngine.ts` implements a pure rule engine that scans wiki pages and caches results to `suggestions.json`. Wiki Browser adds a collapsible Suggestions bar at the top of the tree panel. Ingest flow triggers incremental `scanDelta()` after each new paper is compiled.

**Tech Stack:** TypeScript, Firefox XPCOM file I/O, DOM via createElement/appendChild

---

## File Structure

| File | Action | Purpose |
|------|--------|---------|
| `src/modules/suggestionEngine.ts` | Create | Rule engine, 3 detectors, cache read/write, scanAll/scanDelta/dismiss |
| `src/modules/wikiBrowser.ts` | Modify | Suggestions bar UI above file tree, Scan/Dismiss handlers |
| `src/modules/ingest.ts` | Modify | Auto-trigger scanDelta() after ingest |

---

### Task 1: Create suggestionEngine.ts module

**Files:**
- Create: `src/modules/suggestionEngine.ts`

- [ ] **Step 1: Write the module**

Create `src/modules/suggestionEngine.ts`:

```typescript
import { getWikiBaseDir, makeDir, writeFile, readFile, listDir } from "../utils/xpcom";
import { readPage, parseFrontmatter } from "./wikiReader";

// ─── Types ───

interface Suggestion {
  id: string;
  type: "cross_paper_pattern" | "knowledge_gap" | "missing_paper";
  severity: "info" | "warning";
  title: string;
  detail: string;
  related_pages: string[];
  action_label: string;
  timestamp: string;
  dismissed?: boolean;
}

// ─── Path Helpers ───

function getSuggestionsPath(): string {
  let dataPath = Zotero.Prefs.get("dataDir") as string;
  if (!dataPath) {
    const storagePath = Zotero.getStorageDirectory().path;
    dataPath = storagePath.substring(0, storagePath.lastIndexOf("/"));
  }
  return `${dataPath}/llm-wiki/suggestions.json`;
}

// ─── Cache ───

function readCache(): Suggestion[] {
  const raw = readFile(getSuggestionsPath());
  if (!raw) return [];
  try { return JSON.parse(raw) as Suggestion[]; } catch { return []; }
}

function writeCache(suggestions: Suggestion[]): void {
  try {
    const dir = getSuggestionsPath().replace(/\/[^/]+$/, "");
    makeDir(dir);
    // Purge oldest dismissed if > 100
    while (suggestions.length > 100) {
      const oldestDismissed = suggestions.findIndex(s => s.dismissed);
      if (oldestDismissed >= 0) {
        suggestions.splice(oldestDismissed, 1);
      } else {
        suggestions.pop(); // remove last if no dismissed
      }
    }
    writeFile(getSuggestionsPath(), JSON.stringify(suggestions, null, 2));
  } catch (_) { /* non-blocking */ }
}

function makeId(type: string): string {
  return `${Date.now()}-${type}-${Math.random().toString(36).slice(2, 8)}`;
}

// ─── Detector 1: Cross-Paper Patterns ───

function detectCrossPaperPatterns(): Suggestion[] {
  const results: Suggestion[] = [];
  const baseDir = getWikiBaseDir();
  const papersDir = `${baseDir}/papers`;
  const paperFiles = listDir(papersDir).filter(f => f.endsWith(".md"));
  if (paperFiles.length < 2) return results;

  // Collect concept references per paper
  const paperConcepts: Map<string, Set<string>> = new Map();
  const paperLinks: Map<string, Set<string>> = new Map();
  const paperTitles: Map<string, string> = new Map();

  for (const pf of paperFiles) {
    const slug = `papers/${pf.split("/").pop()!.replace(/\.md$/, "")}`;
    const page = readPage(slug);
    if (!page) continue;
    paperTitles.set(slug, page.frontmatter["title"] || slug);

    // Extract concept/entity references
    const conceptRefs = new Set<string>();
    const conceptMatches = page.body.matchAll(/\[\[(concepts|entities)\/([^\]|]+)/g);
    for (const m of conceptMatches) {
      conceptRefs.add(`${m[1]}/${m[2]}`);
    }
    paperConcepts.set(slug, conceptRefs);

    // Extract paper-to-paper wikilinks
    const paperRefs = new Set<string>();
    const paperMatches = page.body.matchAll(/\[\[(papers)\/([^\]|]+)/g);
    for (const m of paperMatches) {
      paperRefs.add(`papers/${m[2]}`);
    }
    paperLinks.set(slug, paperRefs);
  }

  // Find papers sharing concepts that don't interlink
  const slugs = [...paperConcepts.keys()];
  for (let i = 0; i < slugs.length; i++) {
    for (let j = i + 1; j < slugs.length; j++) {
      const ci = paperConcepts.get(slugs[i])!;
      const cj = paperConcepts.get(slugs[j])!;
      const shared = [...ci].filter(c => cj.has(c));
      if (shared.length === 0) continue;

      const linksI = paperLinks.get(slugs[i])!;
      const linksJ = paperLinks.get(slugs[j])!;
      if (linksI.has(slugs[j]) || linksJ.has(slugs[i])) continue;

      const titleI = paperTitles.get(slugs[i]) || slugs[i];
      const titleJ = paperTitles.get(slugs[j]) || slugs[j];
      const conceptNames = shared.map(c => c.split("/").pop() || c).slice(0, 3).join(", ");

      results.push({
        id: makeId("cross_paper_pattern"),
        type: "cross_paper_pattern",
        severity: "warning",
        title: `Papers share "${conceptNames}" but aren't linked`,
        detail: `"${titleI}" and "${titleJ}" both reference ${conceptNames} but don't link to each other.`,
        related_pages: [slugs[i], slugs[j], ...shared.slice(0, 2)],
        action_label: "Create concept link",
        timestamp: new Date().toISOString(),
      });
    }
  }

  return results.slice(0, 20);
}

// ─── Detector 2: Knowledge Gaps ───

function detectKnowledgeGaps(): Suggestion[] {
  const results: Suggestion[] = [];
  const baseDir = getWikiBaseDir();
  const papersDir = `${baseDir}/papers`;
  const paperFiles = listDir(papersDir).filter(f => f.endsWith(".md"));

  // Count references to non-existent concept/entity pages
  const missingRefs: Map<string, { count: number; papers: string[] }> = new Map();

  for (const pf of paperFiles) {
    const slug = `papers/${pf.split("/").pop()!.replace(/\.md$/, "")}`;
    const page = readPage(slug);
    if (!page) continue;

    const refs = page.body.matchAll(/\[\[(concepts|entities)\/([^\]|]+)/g);
    for (const m of refs) {
      const dir = m[1];
      const conceptSlug = m[2];
      const fullPath = `${baseDir}/${dir}/${conceptSlug}.md`;
      const exists = fileExists(fullPath);
      if (!exists) {
        const key = `${dir}/${conceptSlug}`;
        const entry = missingRefs.get(key) || { count: 0, papers: [] };
        entry.count++;
        if (!entry.papers.includes(slug)) entry.papers.push(slug);
        missingRefs.set(key, entry);
      }
    }
  }

  for (const [key, entry] of missingRefs) {
    if (entry.count < 2) continue;
    const conceptName = key.split("/").pop() || key;
    results.push({
      id: makeId("knowledge_gap"),
      type: "knowledge_gap",
      severity: "warning",
      title: `"${conceptName}" referenced by ${entry.count} papers but no page exists`,
      detail: `${entry.papers.map(p => p.split("/").pop()).join(", ")} reference this concept.`,
      related_pages: [key, ...entry.papers.slice(0, 3)],
      action_label: "Create concept page",
      timestamp: new Date().toISOString(),
    });
  }

  return results.slice(0, 20);
}

function fileExists(path: string): boolean {
  try {
    // @ts-expect-error - Mozilla XPCOM
    const file = Components.classes["@mozilla.org/file/local;1"]
      .createInstance(Components.interfaces.nsIFile) as any;
    file.initWithPath(path);
    return file.exists();
  } catch { return false; }
}

// ─── Detector 3: Missing Papers ───

function detectMissingPapers(): Suggestion[] {
  const results: Suggestion[] = [];
  const baseDir = getWikiBaseDir();
  const papersDir = `${baseDir}/papers`;
  const paperFiles = listDir(papersDir).filter(f => f.endsWith(".md"));

  // Collect all existing paper titles for matching
  const existingTitles = new Set<string>();
  for (const pf of paperFiles) {
    const slug = `papers/${pf.split("/").pop()!.replace(/\.md$/, "")}`;
    const page = readPage(slug);
    if (page) {
      existingTitles.add((page.frontmatter["title"] || "").toLowerCase().trim());
    }
  }

  for (const pf of paperFiles) {
    const slug = `papers/${pf.split("/").pop()!.replace(/\.md$/, "")}`;
    const page = readPage(slug);
    if (!page) continue;

    const body = page.body;

    // Find Related Work / References sections
    const sections = body.split(/^##\s+/m);
    let refSection = "";
    for (const sec of sections) {
      if (/^(Related Work|References|See Also|参考文献|相关工作)/i.test(sec)) {
        refSection = sec.replace(/^Related Work\n?/i, "").replace(/^References\n?/i, "");
        break;
      }
    }
    if (!refSection) continue;

    // Extract quoted titles: "Paper Title" or 「Paper Title」
    const quoted = refSection.match(/["""]([^"""]{10,200})[""」]/g) || [];
    for (const q of quoted) {
      const title = q.replace(/["""「」]/g, "").trim();
      if (title.length < 10) continue;
      const titleLower = title.toLowerCase();
      if ([...existingTitles].some(t => similarity(t, titleLower) > 0.75)) continue;

      results.push({
        id: makeId("missing_paper"),
        type: "missing_paper",
        severity: "info",
        title: `"${title.slice(0, 80)}" cited but not ingested`,
        detail: `Referenced in ${page.frontmatter["title"] || slug}. Consider ingesting this paper.`,
        related_pages: [slug],
        action_label: "Ingest this paper",
        timestamp: new Date().toISOString(),
      });
    }
  }

  return results.slice(0, 20);
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

// ─── Public API ───

export function scanAll(): Suggestion[] {
  try {
    const existing = readCache();
    // Keep undismissed non-expired existing suggestions
    const kept = existing.filter(s => !s.dismissed);
    const ids = new Set(kept.map(s => s.id));

    const newSuggestions: Suggestion[] = [];
    const addUnique = (s: Suggestion) => {
      // Dedup by similar title
      const similar = newSuggestions.some(e => similarity(e.title, s.title) > 0.7)
        || kept.some(e => similarity(e.title, s.title) > 0.7);
      if (!similar) newSuggestions.push(s);
    };

    detectCrossPaperPatterns().forEach(addUnique);
    detectKnowledgeGaps().forEach(addUnique);
    detectMissingPapers().forEach(addUnique);

    const merged = [...kept, ...newSuggestions.filter(s => !ids.has(s.id))];
    writeCache(merged);
    return merged.filter(s => !s.dismissed);
  } catch (_e) {
    return readCache().filter(s => !s.dismissed);
  }
}

export function scanDelta(slugs: string[]): void {
  // Incremental scan: just run full scan for now (lightweight enough)
  scanAll();
}

export function getSuggestions(): Suggestion[] {
  return readCache().filter(s => !s.dismissed);
}

export function dismissSuggestion(id: string): void {
  const suggestions = readCache();
  const idx = suggestions.findIndex(s => s.id === id);
  if (idx >= 0) {
    suggestions[idx].dismissed = true;
    writeCache(suggestions);
  }
}
```

- [ ] **Step 2: Verify build**

```bash
cd /Users/shouyaoqi/zotero-llm-wiki && npm run build
```

Expected: TypeScript compilation passes.

- [ ] **Step 3: Commit**

```bash
git add src/modules/suggestionEngine.ts
git commit -m "feat: add suggestionEngine with 3 detectors and JSON cache"
```

---

### Task 2: Add Suggestions bar to Wiki Browser

**Files:**
- Modify: `src/modules/wikiBrowser.ts`

- [ ] **Step 1: Add import**

Add at top after existing imports:

```typescript
import { getSuggestions, scanAll, dismissSuggestion, type Suggestion } from "./suggestionEngine";
```

Note: A type-only import may need adjustment. If `type Suggestion` causes issues, import `Suggestion` without `type`.

- [ ] **Step 2: Add Suggestions CSS**

Append to `PANEL_CSS`:

```css
  .llmwiki-suggestions-bar { border-bottom: 1px solid var(--fill-quaternary, #e0e0e0); overflow: hidden; }
  .llmwiki-suggestions-header { display: flex; align-items: center; gap: 8px; padding: 6px 8px; cursor: pointer; background: var(--fill-secondary, #f5f5f5); }
  .llmwiki-suggestions-header:hover { background: var(--fill-tertiary, #e0e0e0); }
  .llmwiki-suggestions-title { font-size: 12px; font-weight: 600; color: var(--accent-selected, #0060df); }
  .llmwiki-suggestions-count { font-size: 11px; color: var(--text-secondary, #999); }
  .llmwiki-suggestions-list { padding: 4px 8px; max-height: 300px; overflow-y: auto; }
  .llmwiki-suggestion-item { padding: 6px 8px; margin: 4px 0; border-radius: 6px; font-size: 12px; background: var(--fill-secondary, #fafafa); border: 1px solid var(--fill-quaternary, #e0e0e0); }
  .llmwiki-suggestion-item.warning { border-left: 3px solid #e6a817; }
  .llmwiki-suggestion-item.info { border-left: 3px solid var(--accent-selected, #0060df); }
  .llmwiki-suggestion-title { font-weight: 600; margin-bottom: 2px; }
  .llmwiki-suggestion-detail { color: var(--text-secondary, #666); font-size: 11px; margin-bottom: 4px; }
  .llmwiki-suggestion-actions { display: flex; gap: 6px; }
  .llmwiki-suggestion-btn { font-size: 11px; padding: 2px 8px; border-radius: 3px; border: 1px solid var(--fill-quaternary, #ccc); background: var(--fill-secondary, #f5f5f5); cursor: pointer; }
  .llmwiki-suggestion-btn:hover { background: var(--fill-tertiary, #e0e0e0); }
  .llmwiki-suggestion-btn.dismiss { color: var(--text-secondary, #999); border: none; background: none; }
  .llmwiki-suggestion-btn.dismiss:hover { color: #d32f2f; }
  .llmwiki-suggestions-collapsed .llmwiki-suggestions-list { display: none; }
```

- [ ] **Step 3: Build Suggestions bar DOM (in renderWikiBrowser)**

In `renderWikiBrowser()`, inside the tree panel container, BEFORE the tree toolbar, insert the Suggestions bar:

```typescript
    // Suggestions bar (above tree toolbar)
    const suggestionsBar = doc.createElement("div");
    suggestionsBar.className = "llmwiki-suggestions-bar llmwiki-suggestions-collapsed";
    suggestionsBar.id = "llmwiki-suggestions-bar";

    const suggestionsHeader = doc.createElement("div");
    suggestionsHeader.className = "llmwiki-suggestions-header";
    suggestionsHeader.addEventListener("click", () => {
      suggestionsBar.classList.toggle("llmwiki-suggestions-collapsed");
    });

    const suggestionsTitle = doc.createElement("span");
    suggestionsTitle.className = "llmwiki-suggestions-title";
    suggestionsTitle.textContent = "Suggestions";
    suggestionsHeader.appendChild(suggestionsTitle);

    const suggestionsCount = doc.createElement("span");
    suggestionsCount.className = "llmwiki-suggestions-count";
    suggestionsCount.id = "llmwiki-suggestions-count";
    suggestionsCount.textContent = "0";
    suggestionsHeader.appendChild(suggestionsCount);

    const scanBtn = doc.createElement("button");
    scanBtn.className = "llmwiki-suggestion-btn";
    scanBtn.textContent = "Scan All";
    scanBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      scanAll();
      renderSuggestions();
    });
    suggestionsHeader.appendChild(scanBtn);

    const collapseIcon = doc.createElement("span");
    collapseIcon.style.cssText = "margin-left:auto;font-size:14px;";
    collapseIcon.textContent = "−";
    collapseIcon.id = "llmwiki-suggestions-collapse-icon";
    suggestionsHeader.appendChild(collapseIcon);

    suggestionsBar.appendChild(suggestionsHeader);

    const suggestionsList = doc.createElement("div");
    suggestionsList.className = "llmwiki-suggestions-list";
    suggestionsList.id = "llmwiki-suggestions-list";
    suggestionsBar.appendChild(suggestionsList);

    treePanel.appendChild(suggestionsBar);
```

Note: Insert `suggestionsBar` into `treePanel` BEFORE the `treeToolbar` element. Find where `treeToolbar` is created and insert before it.

- [ ] **Step 4: Add renderSuggestions function**

Add before `buildFileTree`:

```typescript
function renderSuggestions(): void {
  const listEl = document.getElementById("llmwiki-suggestions-list");
  const countEl = document.getElementById("llmwiki-suggestions-count");
  const bar = document.getElementById("llmwiki-suggestions-bar");
  const iconEl = document.getElementById("llmwiki-suggestions-collapse-icon");
  if (!listEl || !countEl || !bar) return;

  const suggestions = getSuggestions();
  countEl.textContent = String(suggestions.length);

  // Update collapse icon
  const collapsed = bar.classList.contains("llmwiki-suggestions-collapsed");
  if (iconEl) iconEl.textContent = collapsed ? "+" : "−";

  if (collapsed) return;

  while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
  const doc = listEl.ownerDocument;

  if (suggestions.length === 0) {
    const empty = doc.createElement("div");
    empty.className = "llmwiki-suggestion-detail";
    empty.textContent = "No suggestions found. Click 'Scan All' to check for patterns in your wiki.";
    empty.style.padding = "8px";
    listEl.appendChild(empty);
    return;
  }

  for (const s of suggestions) {
    const item = doc.createElement("div");
    item.className = `llmwiki-suggestion-item ${s.severity}`;

    const titleEl = doc.createElement("div");
    titleEl.className = "llmwiki-suggestion-title";
    titleEl.textContent = (s.severity === "warning" ? "⚠️ " : "ℹ️ ") + s.title;
    item.appendChild(titleEl);

    const detailEl = doc.createElement("div");
    detailEl.className = "llmwiki-suggestion-detail";
    detailEl.textContent = s.detail;
    item.appendChild(detailEl);

    // Clickable related pages
    if (s.related_pages.length > 0) {
      const pagesEl = doc.createElement("div");
      pagesEl.className = "llmwiki-suggestion-detail";
      pagesEl.style.cssText = "margin-bottom:4px;";
      for (const p of s.related_pages) {
        const link = doc.createElement("span");
        link.className = "wikilink";
        link.textContent = p.split("/").pop() || p;
        link.dataset.target = p.endsWith(".md") ? p : `${p}.md`;
        link.style.cssText = "margin-right:6px;cursor:pointer;";
        pagesEl.appendChild(link);
      }
      item.appendChild(pagesEl);
    }

    const actionsEl = doc.createElement("div");
    actionsEl.className = "llmwiki-suggestion-actions";

    const actionBtn = doc.createElement("button");
    actionBtn.className = "llmwiki-suggestion-btn";
    actionBtn.textContent = s.action_label;
    actionBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      // Action depends on type
      if (s.type === "knowledge_gap" || s.type === "cross_paper_pattern") {
        // Navigate to first related concept page or papers
        const target = s.related_pages[0];
        if (target) {
          const path = target.endsWith(".md") ? target : `${target}.md`;
          state.currentNode = { name: path.split("/").pop() || "", path, type: "file" };
          state.mode = "preview";
          loadPage(path);
          buildFileTree();
        }
      }
    });
    actionsEl.appendChild(actionBtn);

    const dismissBtn = doc.createElement("button");
    dismissBtn.className = "llmwiki-suggestion-btn dismiss";
    dismissBtn.textContent = "✕";
    dismissBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      dismissSuggestion(s.id);
      renderSuggestions();
    });
    actionsEl.appendChild(dismissBtn);

    item.appendChild(actionsEl);
    listEl.appendChild(item);
  }
}
```

- [ ] **Step 5: Call renderSuggestions on panel init**

At the end of `renderWikiBrowser()`, after `buildFileTree()`, add:

```typescript
  renderSuggestions();
```

- [ ] **Step 6: Verify build**

```bash
cd /Users/shouyaoqi/zotero-llm-wiki && npm run build
```

Expected: TypeScript compilation passes. Fix any issues. The `Suggestion` type import should work — if not, import without `type` keyword.

- [ ] **Step 7: Commit**

```bash
git add src/modules/wikiBrowser.ts
git commit -m "feat: add Suggestions bar to Wiki Browser with Scan/Dismiss"
```

---

### Task 3: Add auto-scan trigger to ingest

**Files:**
- Modify: `src/modules/ingest.ts`

- [ ] **Step 1: Add import**

Add at top:

```typescript
import { scanDelta } from "./suggestionEngine";
```

- [ ] **Step 2: Trigger scanDelta after successful ingest**

In `runIngest()`, after `writeWikiPage()` succeeds (after line ~76 where `Zotero.debug("[llmwiki] wiki saved to ${filePath}")`), and after concept extraction completes, add:

```typescript
    // Trigger suggestion scan for new paper
    try {
      scanDelta([`papers/${slug}`]);
      Zotero.debug(`[llmwiki] suggestion scan triggered for ${slug}`);
    } catch (e: any) {
      Zotero.debug(`[llmwiki] suggestion scan failed (non-blocking): ${e.message}`);
    }
```

- [ ] **Step 3: Verify build**

```bash
cd /Users/shouyaoqi/zotero-llm-wiki && npm run build
```

Must pass.

- [ ] **Step 4: Commit**

```bash
git add src/modules/ingest.ts
git commit -m "feat: auto-trigger suggestion scanDelta after ingest"
```

---

### Task 4: Integration test

- [ ] **Step 1: Start dev server**

```bash
npm start
```

- [ ] **Step 2: Manual test checklist**

1. Open Wiki Browser → verify Suggestions bar at top (collapsed by default, shows "Suggestions 0")
2. Click "Scan All" → verify suggestions appear (or "No suggestions found")
3. Test dismiss: click ✕ on a suggestion → verify it disappears
4. Test collapse: click Suggestions header → verify list hides/shows
5. Ingest a new paper → verify suggestions count updates (post-ingest scan)
6. Test cross-paper navigation: click a related page link in suggestion → verify navigates to preview

- [ ] **Step 3: Commit any fixes**

```bash
git add -A
git commit -m "fix: suggestion engine integration polish"
```
