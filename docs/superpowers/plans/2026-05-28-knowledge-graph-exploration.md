# Knowledge Graph Exploration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable natural-language knowledge graph queries via Agent tools and add a card-style relationship graph view to the Wiki Browser for concept/entity pages.

**Architecture:** Three new Agent tools (`list_concepts`, `get_related_papers`, `find_connections`) traverse the wiki's link graph by scanning `[[wikilinks]]` across all pages to build an in-memory adjacency list. A new Graph view mode in `wikiBrowser.ts` renders concept/entity relationships as layered clickable cards using pure DOM/CSS (no canvas, XUL-compatible).

**Tech Stack:** TypeScript, Firefox XPCOM file I/O, DOM manipulation via `createElement`/`appendChild`

---

## File Structure

| File                           | Action | Purpose                                                             |
| ------------------------------ | ------ | ------------------------------------------------------------------- |
| `src/modules/agentPanel.ts`    | Modify | Add `list_concepts`, `get_related_papers`, `find_connections` tools |
| `src/modules/wikiBrowser.ts`   | Modify | Add Graph view mode for concept/entity pages                        |
| `addon/locale/en-US/addon.ftl` | Modify | English localization for graph UI                                   |
| `addon/locale/zh-CN/addon.ftl` | Modify | Chinese localization for graph UI                                   |

---

### Task 1: Add Agent graph query tools

**Files:**

- Modify: `src/modules/agentPanel.ts`

- [ ] **Step 1: Add graph tool definitions**

Edit `src/modules/agentPanel.ts` — in `TOOL_DEFINITIONS` array, append after the `read_session` tool definition:

```typescript
  {
    type: "function",
    function: {
      name: "list_concepts",
      description: "List all concepts and entities in the knowledge base, optionally filtered by type. Shows how many papers reference each one.",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", description: "Filter by type: 'concept', 'entity', or 'all' (default)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_related_papers",
      description: "Get all papers that reference a given concept or entity. Use this to find papers related to a specific method, framework, or named entity.",
      parameters: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Concept/entity slug (e.g., 'concepts/self-attention' or 'entities/imagenet')" },
        },
        required: ["slug"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_connections",
      description: "Find connections between papers, concepts, and entities in the knowledge graph. Without a target, returns all directly connected nodes. With a target, finds the shortest path between them.",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", description: "Source node slug (e.g., 'papers/slug', 'concepts/slug', 'entities/slug')" },
          target: { type: "string", description: "Optional target node slug to find a path to" },
        },
        required: ["source"],
      },
    },
  },
```

- [ ] **Step 2: Add tool execution cases**

Edit `src/modules/agentPanel.ts` — in `executeToolCall()`, add cases for the three new tools before the `default` case:

```typescript
      case "list_concepts": {
        const filterType = (args.type || "all") as string;
        const nodes = listGraphNodes(filterType);
        if (nodes.length === 0) {
          result = "No concepts or entities found in the knowledge base yet. Ingest some papers first to auto-extract them.";
        } else {
          result = nodes.map(n =>
            `- **${n.name}** (${n.slug}) [${n.type}] — ${n.paperCount} papers`
          ).join("\n");
        }
        break;
      }
      case "get_related_papers": {
        const cSlug = (args.slug || "").replace(/\.md$/, "");
        const papers = getRelatedPapers(cSlug);
        if (papers.length === 0) {
          result = `No papers reference "${cSlug}". Try ingesting more papers or checking for related concepts.`;
        } else {
          result = `Papers referencing *${cSlug}*:\n${papers.map((p: { title: string; slug: string; relevance: string }) => `- **${p.title}** (${p.slug})\n  ${p.relevance}`).join("\n")}`;
        }
        break;
      }
      case "find_connections": {
        const source = (args.source || "").replace(/\.md$/, "");
        const target = args.target ? String(args.target).replace(/\.md$/, "") : undefined;
        result = findConnections(source, target);
        break;
      }
```

- [ ] **Step 2.5: Add listDir to xpcom import**

Edit `src/modules/agentPanel.ts` — update the xpcom import line (line 12):

Replace:

```typescript
import { getWikiBaseDir, writeFile, makeDir } from "../utils/xpcom";
```

With:

```typescript
import { getWikiBaseDir, writeFile, makeDir, listDir } from "../utils/xpcom";
```

- [ ] **Step 3: Add graph traversal helper functions**

Edit `src/modules/agentPanel.ts` — add these functions after the `buildSystemPrompt` function (before `handleSend`):

```typescript
// ─── Knowledge Graph Traversal ───

interface GraphNode {
  name: string;
  slug: string;
  type: "concept" | "entity";
  paperCount: number;
}

function listGraphNodes(filterType: string): GraphNode[] {
  const baseDir = getWikiBaseDir();
  const results: GraphNode[] = [];
  const dirs =
    filterType === "all"
      ? ["concepts", "entities"]
      : [filterType === "entity" ? "entities" : "concepts"];

  for (const dir of dirs) {
    const catDir = `${baseDir}/${dir}`;
    const files = listDir(catDir);
    for (const filePath of files) {
      if (!filePath.endsWith(".md")) continue;
      const page = readPage(`${dir}/${filePath.split("/").pop()!}`);
      if (!page) continue;
      const name = page.frontmatter["title"] || filePath;
      const slug = `${dir}/${filePath.split("/").pop()!.replace(/\.md$/, "")}`;
      // Count papers referencing this concept by scanning all paper pages
      let paperCount = 0;
      const papersDir = `${baseDir}/papers`;
      const paperFiles = listDir(papersDir);
      for (const pf of paperFiles) {
        if (!pf.endsWith(".md")) continue;
        const paperPage = readPage(`papers/${pf.split("/").pop()!}`);
        if (!paperPage) continue;
        if (paperPage.body.includes(`[[${slug}`)) paperCount++;
      }
      results.push({
        name,
        slug,
        type: dir === "concepts" ? "concept" : "entity",
        paperCount,
      });
    }
  }
  results.sort((a, b) => b.paperCount - a.paperCount);
  return results;
}

function getRelatedPapers(
  slug: string,
): { title: string; slug: string; relevance: string }[] {
  const baseDir = getWikiBaseDir();
  const results: { title: string; slug: string; relevance: string }[] = [];
  const papersDir = `${baseDir}/papers`;
  const paperFiles = listDir(papersDir);

  for (const pf of paperFiles) {
    if (!pf.endsWith(".md")) continue;
    const relPath = `papers/${pf.split("/").pop()!}`;
    const page = readPage(relPath);
    if (!page) continue;
    if (page.body.includes(`[[${slug}`)) {
      // Extract the relevance description from the link line
      const linkRegex = new RegExp(
        `\\[\\[${slug}\\|?[^\\]]*\\]\\][ \t]*(?:—|–|-)?[ \t]*(.*)`,
        "i",
      );
      const match = page.body.match(linkRegex);
      const relevance = match?.[1]?.trim() || "Related work";
      results.push({
        title: page.frontmatter["title"] || pf,
        slug: relPath.replace(/\.md$/, ""),
        relevance: relevance.slice(0, 120),
      });
    }
  }
  return results;
}

function findConnections(source: string, target?: string): string {
  const baseDir = getWikiBaseDir();
  const adj: Map<string, Set<string>> = new Map();
  const labels: Map<string, string> = new Map();

  const scanDir = (dir: string, prefix: string) => {
    const files = listDir(`${baseDir}/${dir}`);
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      const relPath = `${dir}/${f.split("/").pop()!.replace(/\.md$/, "")}`;
      const page = readPage(relPath);
      if (!page) continue;
      const nodeKey = prefix + "/" + f.split("/").pop()!.replace(/\.md$/, "");
      // Normalize: ensure both "concepts/slug" and "concepts/slug" match
      const normalizedKey = relPath;
      labels.set(normalizedKey, page.frontmatter["title"] || relPath);
      if (!adj.has(normalizedKey)) adj.set(normalizedKey, new Set());
      const links = page.body.match(/\[\[([^\]]+)\]\]/g) || [];
      for (const link of links) {
        const inner = link.slice(2, -2);
        const neighbor = inner.split("|")[0].trim();
        adj.get(normalizedKey)!.add(neighbor);
        if (!adj.has(neighbor)) adj.set(neighbor, new Set());
        adj.get(neighbor)!.add(normalizedKey);
        if (!labels.has(neighbor)) {
          labels.set(neighbor, inner.split("|")[1]?.trim() || neighbor);
        }
      }
    }
  };

  scanDir("papers", "papers");
  scanDir("concepts", "concepts");
  scanDir("entities", "entities");

  // Normalize source: handle both "concepts/self-attention" and just "self-attention"
  let normalizedSource = source;
  if (!source.includes("/")) {
    for (const prefix of ["concepts", "entities", "papers"]) {
      if (adj.has(`${prefix}/${source}`)) {
        normalizedSource = `${prefix}/${source}`;
        break;
      }
    }
  }

  if (!target) {
    const neighbors = adj.get(normalizedSource);
    if (!neighbors || neighbors.size === 0) {
      return `No direct connections found for "${source}".`;
    }
    const neighborList = [...neighbors].map((n) => {
      const label = labels.get(n) || n;
      return `- ${label} (${n})`;
    });
    return `Direct connections for "${labels.get(normalizedSource) || normalizedSource}":\n${neighborList.join("\n")}`;
  }

  // Normalize target
  let normalizedTarget = target;
  if (!target.includes("/")) {
    for (const prefix of ["concepts", "entities", "papers"]) {
      if (adj.has(`${prefix}/${target}`)) {
        normalizedTarget = `${prefix}/${target}`;
        break;
      }
    }
  }

  // BFS
  const visited = new Set<string>();
  const queue: { node: string; path: string[] }[] = [
    { node: normalizedSource, path: [normalizedSource] },
  ];
  visited.add(normalizedSource);
  const maxHops = 5;

  while (queue.length > 0) {
    const { node, path } = queue.shift()!;
    if (node === normalizedTarget || node === target) {
      const pathLabels = path.map(
        (n, i) => `${i}. ${labels.get(n) || n} (${n})`,
      );
      return `Connection found (${path.length - 1} hops):\n${pathLabels.join("\n")}`;
    }
    if (path.length > maxHops) continue;
    for (const neighbor of adj.get(node) || []) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push({ node: neighbor, path: [...path, neighbor] });
      }
    }
  }

  return `No connection found between "${source}" and "${target || "?"}" within ${maxHops} hops.`;
}
```

Note: The graph helpers import from `wikiReader` (`readPage`) and `xpcom` (`getWikiBaseDir`, `listDir`) — these are already imported in `agentPanel.ts`.

- [ ] **Step 4: Verify build**

```bash
npm run build
```

Expected: TypeScript compilation passes, agentPanel changes bundled correctly.

- [ ] **Step 5: Commit**

```bash
git add src/modules/agentPanel.ts
git commit -m "feat: add knowledge graph query tools to Agent"
```

---

### Task 2: Add Graph view to Wiki Browser

**Files:**

- Modify: `src/modules/wikiBrowser.ts`

This task adds a "Graph" button to the toolbar when viewing concept/entity pages, and implements a card-style layered relationship view.

- [ ] **Step 0.5: Add listDir to xpcom import**

Edit `src/modules/wikiBrowser.ts` — update the xpcom import line (line 10):

Replace:

```typescript
import { getWikiBaseDir, readFile } from "../utils/xpcom";
```

With:

```typescript
import { getWikiBaseDir, readFile, listDir } from "../utils/xpcom";
```

- [ ] **Step 1: Add graph view state to BrowserState**

Edit `src/modules/wikiBrowser.ts` — in the `BrowserState` interface (around line 14), add:

```typescript
mode: "preview" | "edit" | "graph";
```

- [ ] **Step 2: Add graph view CSS**

Edit `src/modules/wikiBrowser.ts` — append to `PANEL_CSS` (before the closing backtick after line 147):

```css
.llmwiki-graph-back {
  margin-bottom: 12px;
}
.llmwiki-graph-layer {
  margin-bottom: 16px;
}
.llmwiki-graph-layer-title {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--text-secondary, #666);
  margin-bottom: 8px;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--fill-quaternary, #e0e0e0);
}
.llmwiki-graph-layer-cards {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.llmwiki-graph-card {
  background: var(--fill-secondary, #f5f5f5);
  border: 1px solid var(--fill-quaternary, #e0e0e0);
  border-radius: 8px;
  padding: 10px 14px;
  cursor: pointer;
  min-width: 120px;
  max-width: 220px;
}
.llmwiki-graph-card:hover {
  border-color: var(--accent-selected, #0060df);
  background: var(--fill-tertiary, #f0f0f0);
}
.llmwiki-graph-card.current {
  border-color: var(--accent-selected, #0060df);
  border-width: 2px;
  background: var(--accent-tertiary, #e0e0ff);
}
.llmwiki-graph-card-name {
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 4px;
}
.llmwiki-graph-card-type {
  font-size: 11px;
  color: var(--text-secondary, #999);
}
.llmwiki-graph-card-meta {
  font-size: 11px;
  color: var(--text-secondary, #666);
  margin-top: 4px;
}
.llmwiki-graph-arrow {
  text-align: center;
  color: var(--text-secondary, #999);
  font-size: 18px;
  margin: 4px 0;
}
```

- [ ] **Step 3: Add "Graph" button to preview toolbar**

Edit `src/modules/wikiBrowser.ts` — in `showPreview()`, after creating the `editBtn`, add a "Graph" button (after line 339):

```typescript
// Only show Graph button for concept/entity pages
const pageType = page.frontmatter["type"] || "";
if (pageType === "concept" || pageType === "entity") {
  const graphBtn = doc.createElement("button");
  graphBtn.className = "llmwiki-btn";
  graphBtn.id = "llmwiki-graph-btn";
  graphBtn.textContent = "Graph";
  toolbar.appendChild(graphBtn);
}
```

- [ ] **Step 4: Add graph view handler in content click**

Edit `src/modules/wikiBrowser.ts` — in `handleContentClick()`, add graph button handling after the save button handler (after line 438):

```typescript
if (target.id === "llmwiki-graph-btn") {
  state.mode = "graph";
  if (state.currentPage) showGraphView(state.currentPage);
  return;
}
if (target.id === "llmwiki-graph-back-btn") {
  state.mode = "preview";
  if (state.currentPage) showPreview(state.currentPage);
  return;
}

// Graph card click — navigate to linked page
if (
  target.classList.contains("llmwiki-graph-card") ||
  target.closest(".llmwiki-graph-card")
) {
  const card = target.classList.contains("llmwiki-graph-card")
    ? target
    : (target.closest(".llmwiki-graph-card") as HTMLElement);
  const targetPath = card?.dataset.target;
  if (targetPath) {
    const path = targetPath.endsWith(".md") ? targetPath : `${targetPath}.md`;
    state.currentNode = {
      name: path.split("/").pop() || "",
      path,
      type: "file",
    };
    state.mode = "preview";
    loadPage(path);
    buildFileTree();
  }
  return;
}
```

- [ ] **Step 5: Implement showGraphView function**

Edit `src/modules/wikiBrowser.ts` — add the `showGraphView` function before `handleContentClick`:

```typescript
function showGraphView(page: ParsedPage): void {
  if (!state.content || !state.doc) return;
  const doc = state.doc;

  while (state.content.firstChild)
    state.content.removeChild(state.content.firstChild);

  // Back button
  const backBtn = doc.createElement("button");
  backBtn.className = "llmwiki-btn llmwiki-graph-back";
  backBtn.id = "llmwiki-graph-back-btn";
  backBtn.textContent = "← Back to preview";
  state.content.appendChild(backBtn);

  const name = page.frontmatter["title"] || page.filePath;
  const pageType = page.frontmatter["type"] || "concept";
  const pageSlug = page.filePath.replace(/\.md$/, "");

  // ── Layer 1: Current Node ──
  const layer1 = doc.createElement("div");
  layer1.className = "llmwiki-graph-layer";
  const layer1Title = doc.createElement("div");
  layer1Title.className = "llmwiki-graph-layer-title";
  layer1Title.textContent = pageType === "concept" ? "Concept" : "Entity";
  layer1.appendChild(layer1Title);

  const cards1 = doc.createElement("div");
  cards1.className = "llmwiki-graph-layer-cards";
  const selfCard = buildGraphCard(doc, name, pageSlug, pageType, "", true);
  cards1.appendChild(selfCard);
  layer1.appendChild(cards1);
  state.content.appendChild(layer1);

  // ── Arrow ──
  const arrow1 = doc.createElement("div");
  arrow1.className = "llmwiki-graph-arrow";
  arrow1.textContent = "↓";
  state.content.appendChild(arrow1);

  // ── Layer 2: Related Papers ──
  const baseDir = getWikiBaseDir();
  const papersDir = `${baseDir}/papers`;
  const paperFiles = listDir(papersDir);
  const relatedPapers: { title: string; slug: string; snippet: string }[] = [];

  for (const pf of paperFiles) {
    if (!pf.endsWith(".md")) continue;
    const relPath = `papers/${pf.split("/").pop()!}`;
    const paperPage = readPage(relPath);
    if (!paperPage) continue;
    // Check if this paper references the current concept
    const linkPattern = `[[${pageSlug}`;
    if (
      paperPage.body.includes(linkPattern) ||
      paperPage.body.includes(`[[${pageSlug}|`)
    ) {
      relatedPapers.push({
        title: paperPage.frontmatter["title"] || pf,
        slug: relPath.replace(/\.md$/, ""),
        snippet:
          (paperPage.frontmatter["year"] || "") +
          (paperPage.frontmatter["authors"]
            ? ` — ${paperPage.frontmatter["authors"].slice(0, 60)}`
            : ""),
      });
    }
  }

  const layer2 = doc.createElement("div");
  layer2.className = "llmwiki-graph-layer";
  const layer2Title = doc.createElement("div");
  layer2Title.className = "llmwiki-graph-layer-title";
  layer2Title.textContent = `Related Papers (${relatedPapers.length})`;
  layer2.appendChild(layer2Title);

  const cards2 = doc.createElement("div");
  cards2.className = "llmwiki-graph-layer-cards";
  if (relatedPapers.length === 0) {
    const empty = doc.createElement("div");
    empty.className = "llmwiki-empty";
    empty.textContent =
      "No papers reference this yet. Ingest more papers to build connections.";
    cards2.appendChild(empty);
  } else {
    for (const rp of relatedPapers) {
      cards2.appendChild(
        buildGraphCard(doc, rp.title, rp.slug, "paper", rp.snippet, false),
      );
    }
  }
  layer2.appendChild(cards2);
  state.content.appendChild(layer2);

  // ── Arrow ──
  if (relatedPapers.length > 0) {
    const arrow2 = doc.createElement("div");
    arrow2.className = "llmwiki-graph-arrow";
    arrow2.textContent = "↓";
    state.content.appendChild(arrow2);
  }

  // ── Layer 3: See Also (linked concepts/entities from current page) ──
  const seeAlsoLinks =
    page.body.match(/\[\[(concepts|entities)\/([^\]|]+)/g) || [];
  const uniqueSeeAlso = [
    ...new Set(
      seeAlsoLinks.map((l) => {
        const m = l.match(/\[\[((?:concepts|entities)\/[^\]|]+)/);
        return m ? m[1] : l.slice(2);
      }),
    ),
  ];

  if (uniqueSeeAlso.length > 0) {
    const layer3 = doc.createElement("div");
    layer3.className = "llmwiki-graph-layer";
    const layer3Title = doc.createElement("div");
    layer3Title.className = "llmwiki-graph-layer-title";
    layer3Title.textContent = "See Also";
    layer3.appendChild(layer3Title);

    const cards3 = doc.createElement("div");
    cards3.className = "llmwiki-graph-layer-cards";
    for (const saSlug of uniqueSeeAlso) {
      // Try to read the concept page to get its title
      const saPage = readPage(`${saSlug}.md`);
      const saName =
        saPage?.frontmatter?.["title"] || saSlug.split("/").pop() || saSlug;
      const saType =
        saPage?.frontmatter?.["type"] ||
        (saSlug.startsWith("concepts/") ? "concept" : "entity");
      cards3.appendChild(
        buildGraphCard(doc, saName, saSlug, saType, "", false),
      );
    }
    layer3.appendChild(cards3);
    state.content.appendChild(layer3);
  }
}

function buildGraphCard(
  doc: Document,
  name: string,
  slug: string,
  type: string,
  meta: string,
  isCurrent: boolean,
): HTMLElement {
  const card = doc.createElement("div");
  card.className = "llmwiki-graph-card" + (isCurrent ? " current" : "");
  card.dataset.target = slug;

  const nameEl = doc.createElement("div");
  nameEl.className = "llmwiki-graph-card-name";
  nameEl.textContent = name;
  card.appendChild(nameEl);

  const typeEl = doc.createElement("div");
  typeEl.className = "llmwiki-graph-card-type";
  typeEl.textContent = type;
  card.appendChild(typeEl);

  if (meta) {
    const metaEl = doc.createElement("div");
    metaEl.className = "llmwiki-graph-card-meta";
    metaEl.textContent = meta;
    card.appendChild(metaEl);
  }

  return card;
}
```

Note: `readPage` and `listDir` from `wikiReader`/`xpcom` are already imported in `wikiBrowser.ts`. `getWikiBaseDir` is also already imported.

- [ ] **Step 2: Verify build**

```bash
npm run build
```

Expected: TypeScript compilation passes, wikiBrowser changes bundled correctly.

- [ ] **Step 3: Commit**

```bash
git add src/modules/wikiBrowser.ts
git commit -m "feat: add card-style graph view to Wiki Browser for concept/entity pages"
```

---

### Task 3: Add graph view localization strings

**Files:**

- Modify: `addon/locale/en-US/addon.ftl`
- Modify: `addon/locale/zh-CN/addon.ftl`

- [ ] **Step 1: Add English strings**

Edit `addon/locale/en-US/addon.ftl` — append:

```ftl
# Knowledge Graph
graph-view-related-papers = Related Papers
graph-view-see-also = See Also
graph-view-no-papers = No papers reference this yet. Ingest more papers to build connections.
```

- [ ] **Step 2: Add Chinese strings**

Edit `addon/locale/zh-CN/addon.ftl` — append:

```ftl
# 知识图谱
graph-view-related-papers = 相关论文
graph-view-see-also = 参见
graph-view-no-papers = 暂无论文引用此内容。编译更多论文以建立关联。
```

- [ ] **Step 3: Commit**

```bash
git add addon/locale/en-US/addon.ftl addon/locale/zh-CN/addon.ftl
git commit -m "feat: add knowledge graph localization strings"
```

---

### Task 4: Integration test and polish

- [ ] **Step 1: Start dev server and test in Zotero**

```bash
npm start
```

Manual test checklist:

1. Open Agent panel, type "list all concepts in my knowledge base" — verify `list_concepts` tool shows concepts with paper counts
2. Type "what papers are related to concept X?" — verify `get_related_papers` tool returns relevant papers
3. Type "find connections between paper A and concept B" — verify `find_connections` finds paths
4. Open Wiki Browser, navigate to a concept page — verify "Graph" button appears in toolbar
5. Click "Graph" — verify card-style layered view appears with current concept → related papers → see also
6. Click a paper card in the graph — verify navigation to that paper's preview
7. Click "← Back to preview" — verify return to concept preview
8. Navigate to a regular paper page (not concept/entity) — verify no "Graph" button appears
9. Navigate to a concept page with no linked papers — verify empty state message

- [ ] **Step 2: Commit any fixes**

```bash
git add -A
git commit -m "fix: knowledge graph integration polish"
```
