# Wiki Browser Panel Implementation Plan (Phase 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Wiki Browser side panel to Zotero allowing browse, preview, edit, and wikilink navigation of the `llm-wiki/` knowledge base.

**Architecture:** Extract XPCOM file I/O helpers into a shared utility (`xpcom.ts`), build a wikiReader data layer on top, then create a wikiBrowser UI module registered via `Zotero.ItemPaneManager.registerSection()`. The panel uses a split-pane layout (file tree + content area) with `marked` for Markdown rendering.

**Tech Stack:** Zotero 9 / Firefox ESR 115 sandbox, XPCOM file I/O, `marked` (npm), esbuild (firefox115 target), Fluent localization

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `src/utils/xpcom.ts` | Create | Shared XPCOM file I/O helpers extracted from wikiStorage |
| `src/modules/wikiStorage.ts` | Modify | Import from xpcom.ts, remove duplicated helpers |
| `src/modules/wikiReader.ts` | Create | Data layer: read/search/parse wiki files |
| `src/modules/wikiBrowser.ts` | Create | UI logic: tree, preview, edit, navigation |
| `src/hooks.ts` | Modify | Register the wikiBrowser panel section |
| `addon/locale/en-US/addon.ftl` | Modify | Add wiki browser locale strings |
| `addon/locale/zh-CN/addon.ftl` | Modify | Add wiki browser locale strings |
| `package.json` | Modify | Add `marked` dependency |

---

### Task 1: Create `src/utils/xpcom.ts` — extract shared XPCOM helpers

**Files:**
- Create: `src/utils/xpcom.ts`

- [ ] **Step 1: Write the file**

Extract `getWikiBaseDir`, `getRawDir`, `makeDir`, `writeFile`, `readFile`, `ensureDirs` from `src/modules/wikiStorage.ts` into a shared utility. Add `listDir` for directory enumeration.

```typescript
// ─── Path helpers ───

function getWikiBaseDir(): string {
  let dataPath = Zotero.Prefs.get("dataDir") as string;
  if (!dataPath) {
    const storagePath = Zotero.getStorageDirectory().path;
    dataPath = storagePath.substring(0, storagePath.lastIndexOf("/"));
  }
  return `${dataPath}/llm-wiki/wiki`;
}

function getRawDir(): string {
  let dataPath = Zotero.Prefs.get("dataDir") as string;
  if (!dataPath) {
    const storagePath = Zotero.getStorageDirectory().path;
    dataPath = storagePath.substring(0, storagePath.lastIndexOf("/"));
  }
  return `${dataPath}/llm-wiki/raw`;
}

// ─── XPCOM file I/O ───

function makeDir(path: string): void {
  // @ts-expect-error - Mozilla XPCOM
  const nsIFile = Components.classes["@mozilla.org/file/local;1"]
    .createInstance(Components.interfaces.nsIFile) as any;
  nsIFile.initWithPath(path);
  if (!nsIFile.exists()) {
    nsIFile.create(Components.interfaces.nsIFile.DIRECTORY_TYPE, 0o755);
  }
}

function writeFile(path: string, content: string): void {
  // @ts-expect-error - Mozilla XPCOM
  const file = Components.classes["@mozilla.org/file/local;1"]
    .createInstance(Components.interfaces.nsIFile) as any;
  file.initWithPath(path);
  // @ts-expect-error - Mozilla XPCOM
  const stream = Components.classes["@mozilla.org/network/file-output-stream;1"]
    .createInstance(Components.interfaces.nsIFileOutputStream) as any;
  stream.init(file, 0x02 | 0x08 | 0x20, 0o644, 0);
  // @ts-expect-error - Mozilla XPCOM
  const converter = Components.classes["@mozilla.org/intl/converter-output-stream;1"]
    .createInstance(Components.interfaces.nsIConverterOutputStream) as any;
  converter.init(stream, "UTF-8", 0, 0x0000);
  converter.writeString(content);
  converter.close();
  stream.close();
}

function readFile(path: string): string | null {
  // @ts-expect-error - Mozilla XPCOM
  const file = Components.classes["@mozilla.org/file/local;1"]
    .createInstance(Components.interfaces.nsIFile) as any;
  file.initWithPath(path);
  if (!file.exists()) return null;
  // @ts-expect-error - Mozilla XPCOM
  const stream = Components.classes["@mozilla.org/network/file-input-stream;1"]
    .createInstance(Components.interfaces.nsIFileInputStream) as any;
  stream.init(file, 0x01, 0o644, 0);
  const available = stream.available();
  // @ts-expect-error - Mozilla XPCOM
  const data = Components.classes["@mozilla.org/binaryinputstream;1"]
    .createInstance(Components.interfaces.nsIBinaryInputStream) as any;
  data.setInputStream(stream);
  const text = data.readBytes(available);
  stream.close();
  return text;
}

function listDir(path: string): string[] {
  // @ts-expect-error - Mozilla XPCOM
  const dir = Components.classes["@mozilla.org/file/local;1"]
    .createInstance(Components.interfaces.nsIFile) as any;
  dir.initWithPath(path);
  if (!dir.exists() || !dir.isDirectory()) return [];
  const enumerator = dir.directoryEntries;
  const result: string[] = [];
  while (enumerator.hasMoreElements()) {
    const file = enumerator.getNext().QueryInterface(Components.interfaces.nsIFile);
    result.push(file.path);
  }
  return result;
}

function fileExists(path: string): boolean {
  // @ts-expect-error - Mozilla XPCOM
  const file = Components.classes["@mozilla.org/file/local;1"]
    .createInstance(Components.interfaces.nsIFile) as any;
  file.initWithPath(path);
  return file.exists();
}

function ensureDirs(): void {
  const base = getWikiBaseDir();
  makeDir(base);
  makeDir(`${base}/papers`);
  makeDir(`${base}/concepts`);
  makeDir(`${base}/entities`);
  makeDir(getRawDir());
}

export {
  getWikiBaseDir,
  getRawDir,
  makeDir,
  writeFile,
  readFile,
  listDir,
  fileExists,
  ensureDirs,
};
```

- [ ] **Step 2: Build to verify no import errors**

```bash
npm run build
```

Expected: TypeScript compiles, new file has no syntax errors.

- [ ] **Step 3: Commit**

```bash
git add src/utils/xpcom.ts
git commit -m "feat: extract XPCOM file I/O helpers to shared xpcom.ts"
```

---

### Task 2: Refactor `src/modules/wikiStorage.ts` to use xpcom.ts

**Files:**
- Modify: `src/modules/wikiStorage.ts`

- [ ] **Step 1: Replace local XPCOM functions with imports**

Replace lines 14-81 (the path helpers and XPCOM functions) with an import from xpcom.ts. Keep only the wiki-specific logic: `writeWikiPage`, `updateIndex`, `appendLog`, `extractSummary`, `buildTags`, `escapeYaml`, `buildSystemPrompt`, `buildUserPrompt`, `PaperMetadata`.

```typescript
import { titleToSlug } from "../utils/sanitize";
import {
  getWikiBaseDir,
  getRawDir,
  makeDir,
  writeFile,
  readFile,
  ensureDirs,
} from "../utils/xpcom";

// Remove: getWikiBaseDir, getRawDir, makeDir, writeFile, readFile, ensureDirs function definitions
// Keep: writeWikiPage, updateIndex, appendLog, extractSummary, buildTags, escapeYaml,
//       buildSystemPrompt, buildUserPrompt, PaperMetadata
```

- [ ] **Step 2: Verify the refactor compiles**

```bash
npm run build
```

Expected: Build succeeds, no TypeScript errors. No behavioral change.

- [ ] **Step 3: Commit**

```bash
git add src/modules/wikiStorage.ts
git commit -m "refactor: wikiStorage imports XPCOM helpers from xpcom.ts"
```

---

### Task 3: Create `src/modules/wikiReader.ts` — types + frontmatter parser

**Files:**
- Create: `src/modules/wikiReader.ts`

- [ ] **Step 1: Write types, path helpers, and parseFrontmatter**

```typescript
import { getWikiBaseDir, readFile, writeFile, listDir } from "../utils/xpcom";
import { titleToSlug } from "../utils/sanitize";

// ─── Types ───

export interface FileNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileNode[];
}

export interface ParsedPage {
  frontmatter: Record<string, string>;
  body: string;
  filePath: string;
}

export interface SearchResult {
  slug: string;
  title: string;
  filePath: string;
  snippet: string;
}

export interface IndexEntry {
  slug: string;
  title: string;
  year: string;
  summary: string;
}

// ─── Frontmatter Parser ───

export function parseFrontmatter(raw: string): { frontmatter: Record<string, string>; body: string } {
  if (!raw.startsWith("---")) {
    return { frontmatter: {}, body: raw };
  }
  const end = raw.indexOf("---", 3);
  if (end === -1) {
    return { frontmatter: {}, body: raw };
  }
  const fmBlock = raw.slice(3, end);
  const body = raw.slice(end + 3).trimStart();
  const frontmatter: Record<string, string> = {};

  for (const line of fmBlock.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) frontmatter[key] = value;
  }

  return { frontmatter, body };
}
```

- [ ] **Step 2: Build**

```bash
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add src/modules/wikiReader.ts
git commit -m "feat: add wikiReader types and frontmatter parser"
```

---

### Task 4: `wikiReader.ts` — `listTree()` and `parseIndex()`

**Files:**
- Modify: `src/modules/wikiReader.ts`

- [ ] **Step 1: Add listTree and parseIndex**

Append after the parseFrontmatter function:

```typescript
// ─── Directory Tree ───

export function listTree(): FileNode[] {
  const baseDir = getWikiBaseDir();
  const categories = ["papers", "concepts", "entities"];
  const tree: FileNode[] = [];

  for (const cat of categories) {
    const catDir = `${baseDir}/${cat}`;
    const node: FileNode = {
      name: cat,
      path: cat,
      type: "directory",
      children: [],
    };

    const files = listDir(catDir);
    for (const filePath of files) {
      if (!filePath.endsWith(".md")) continue;
      const name = filePath.split("/").pop() || filePath;
      node.children!.push({
        name,
        path: `${cat}/${name}`,
        type: "file",
      });
    }

    // Sort alphabetically
    node.children!.sort((a, b) => a.name.localeCompare(b.name));
    tree.push(node);
  }

  return tree;
}

// ─── Index Parser ───

export function parseIndex(): IndexEntry[] {
  const indexPath = `${getWikiBaseDir()}/index.md`;
  const content = readFile(indexPath);
  if (!content) return [];

  const entries: IndexEntry[] = [];
  const lines = content.split("\n");
  let inPapers = false;

  for (const line of lines) {
    if (line.startsWith("## Papers")) {
      inPapers = true;
      continue;
    }
    if (inPapers && line.startsWith("## ")) break;
    if (!inPapers || !line.startsWith("- ")) continue;

    // Parse: - (2024) [[papers/slug|Title]] | summary
    const match = line.match(
      /^- \(([^)]*)\) \[\[papers\/([^|]+)\|([^\]]+)\]\] \| (.+)$/,
    );
    if (match) {
      entries.push({
        year: match[1] || "?",
        slug: match[2],
        title: match[3],
        summary: match[4],
      });
    }
  }

  return entries;
}
```

- [ ] **Step 2: Build**

```bash
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add src/modules/wikiReader.ts
git commit -m "feat: add wikiReader listTree and parseIndex"
```

---

### Task 5: `wikiReader.ts` — `readPage()`, `savePage()`, `searchPages()`

**Files:**
- Modify: `src/modules/wikiReader.ts`

- [ ] **Step 1: Add remaining API functions**

Append after parseIndex:

```typescript
// ─── Page Read/Write ───

export function readPage(relPath: string): ParsedPage | null {
  const fullPath = `${getWikiBaseDir()}/${relPath}`;
  const raw = readFile(fullPath);
  if (!raw) return null;
  const { frontmatter, body } = parseFrontmatter(raw);
  return { frontmatter, body, filePath: relPath };
}

export function savePage(relPath: string, content: string): void {
  const fullPath = `${getWikiBaseDir()}/${relPath}`;
  writeFile(fullPath, content);

  // Update index.md `updated` date
  const now = new Date().toISOString().slice(0, 10);
  const indexPath = `${getWikiBaseDir()}/index.md`;
  const indexContent = readFile(indexPath);
  if (indexContent) {
    const updated = indexContent
      .replace(/^updated: .*$/m, `updated: ${now}`)
      .replace(/^Last updated: .*$/m, `Last updated: ${now}`);
    writeFile(indexPath, updated);
  }
}

// ─── Full-Text Search ───

export function searchPages(query: string): SearchResult[] {
  const results: SearchResult[] = [];
  const q = query.toLowerCase();
  const tree = listTree();

  for (const dir of tree) {
    if (!dir.children) continue;
    for (const file of dir.children) {
      const page = readPage(file.path);
      if (!page) continue;

      const title = page.frontmatter["title"] || file.name;
      const bodyLower = page.body.toLowerCase();
      const titleLower = title.toLowerCase();

      if (titleLower.includes(q) || bodyLower.includes(q)) {
        // Extract a snippet around the first match
        const matchIdx = bodyLower.indexOf(q);
        const start = Math.max(0, matchIdx - 50);
        const end = Math.min(page.body.length, matchIdx + q.length + 100);
        const snippet = (start > 0 ? "…" : "") +
          page.body.slice(start, end).replace(/\n/g, " ") +
          (end < page.body.length ? "…" : "");

        results.push({
          slug: file.path.replace(/\.md$/, ""),
          title,
          filePath: file.path,
          snippet: snippet || title,
        });
      }
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
git add src/modules/wikiReader.ts
git commit -m "feat: add wikiReader readPage, savePage, searchPages"
```

---

### Task 6: Install `marked` and create markdown renderer

**Files:**
- Modify: `package.json`
- Create: `src/modules/wikiBrowser.ts` (partial)

- [ ] **Step 1: Install marked**

```bash
npm install marked
```

- [ ] **Step 2: Create wikiBrowser.ts with markdown rendering**

```typescript
import { marked } from "marked";
import {
  listTree,
  readPage,
  savePage,
  searchPages,
  parseIndex,
  parseFrontmatter,
  type FileNode,
  type ParsedPage,
} from "./wikiReader";
import { getWikiBaseDir } from "../utils/xpcom";

// ─── State ───

interface BrowserState {
  currentNode: FileNode | null;
  currentPage: ParsedPage | null;
  mode: "preview" | "edit";
  tree: HTMLElement | null;
  content: HTMLElement | null;
}

const state: BrowserState = {
  currentNode: null,
  currentPage: null,
  mode: "preview",
  tree: null,
  content: null,
};

// ─── Markdown Rendering ───

function renderMarkdown(raw: string): string {
  const { frontmatter, body } = parseFrontmatter(raw);

  // Build metadata card HTML
  let metaHtml = "";
  const title = frontmatter["title"] || "";
  const authors = frontmatter["authors"] || "";
  const year = frontmatter["year"] || "";
  const doi = frontmatter["doi"] || "";
  const publication = frontmatter["publication"] || "";
  const tagsRaw = frontmatter["tags"] || "";

  if (title || authors || year) {
    const tags = tagsRaw
      .replace(/[\[\]]/g, "")
      .split(",")
      .map((t) => t.trim().replace(/"/g, ""))
      .filter(Boolean);

    metaHtml = [
      '<div class="llmwiki-metadata">',
      title ? `<div class="llmwiki-metadata-title">${escapeHTML(title)}</div>` : "",
      '<div class="llmwiki-metadata-row">',
      authors ? `<span>${escapeHTML(authors)}</span>` : "",
      year ? `<span>${escapeHTML(year)}</span>` : "",
      publication ? `<span>${escapeHTML(publication)}</span>` : "",
      doi ? `<span>DOI: ${escapeHTML(doi)}</span>` : "",
      "</div>",
      tags.length
        ? `<div class="llmwiki-metadata-tags">${tags
            .map((t) => `<span class="llmwiki-tag">${escapeHTML(t)}</span>`)
            .join("")}</div>`
        : "",
      "</div>",
    ].join("");
  }

  // Replace [[wikilinks]] with clickable spans before Markdown parsing
  const withLinks = body.replace(
    /\[\[([^\]]+)\]\]/g,
    (_match: string, ref: string) => {
      const parts = ref.split("|");
      const target = parts[0].trim();
      const label = (parts[1] || target).trim();
      return `<a class="wikilink" data-target="${escapeHTML(target)}">${escapeHTML(label)}</a>`;
    },
  );

  const bodyHtml = marked.parse(withLinks) as string;
  return metaHtml + bodyHtml;
}

function escapeHTML(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── Public Entry Point ───

export function renderWikiBrowser({ body }: { body: HTMLElement; doc: Document }): void {
  body.innerHTML = getShellHTML();
  state.tree = body.querySelector("#llmwiki-browser-tree") as HTMLElement;
  state.content = body.querySelector("#llmwiki-browser-content") as HTMLElement;

  if (state.tree) {
    state.tree.addEventListener("click", handleTreeClick);
  }
  if (state.content) {
    state.content.addEventListener("click", handleContentClick);
  }

  buildFileTree();

  // Render splitter drag
  const splitter = body.querySelector("#llmwiki-browser-splitter") as HTMLElement;
  if (splitter) {
    splitter.addEventListener("mousedown", handleSplitterDrag);
  }
}

function getShellHTML(): string {
  return `
    <style>
      #llmwiki-browser { display: flex; height: 100%; overflow: hidden; }
      #llmwiki-browser-tree { width: 200px; min-width: 80px; overflow-y: auto;
        border-right: 1px solid var(--fill-quaternary, #e0e0e0); padding: 8px; }
      #llmwiki-browser-splitter { width: 4px; cursor: col-resize; flex-shrink: 0; }
      #llmwiki-browser-splitter:hover { background: var(--fill-quaternary, #e0e0e0); }
      #llmwiki-browser-content { flex: 1; overflow-y: auto; padding: 12px; }
      .llmwiki-tree-item { padding: 3px 8px; cursor: pointer; border-radius: 4px;
        font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .llmwiki-tree-item:hover { background: var(--fill-tertiary, #f0f0f0); }
      .llmwiki-tree-item.active { background: var(--accent-selected, #0060df);
        color: var(--text-selected, #fff); }
      .llmwiki-tree-dir { font-weight: 600; padding: 6px 8px 3px; font-size: 12px;
        text-transform: uppercase; color: var(--text-secondary, #666); }
      .llmwiki-metadata { background: var(--fill-secondary, #f5f5f5);
        border-radius: 6px; padding: 12px; margin-bottom: 16px; }
      .llmwiki-metadata-title { font-size: 1.2em; font-weight: 600; margin-bottom: 8px; }
      .llmwiki-metadata-row { display: flex; flex-wrap: wrap; gap: 12px;
        font-size: 0.85em; color: var(--text-secondary, #666); margin-bottom: 6px; }
      .llmwiki-metadata-tags { margin-top: 6px; }
      .llmwiki-tag { display: inline-block; background: var(--accent-tertiary, #e0e0ff);
        color: var(--text-on-accent, #000); border-radius: 3px; padding: 1px 6px;
        font-size: 0.8em; margin-right: 4px; }
      a.wikilink { color: var(--accent-selected, #0060df); cursor: pointer;
        text-decoration: underline; text-decoration-style: dotted; }
      a.wikilink:hover { text-decoration-style: solid; }
      .llmwiki-editor { width: 100%; height: 100%; min-height: 300px; border: none;
        resize: none; font-family: monospace; font-size: 13px; padding: 0;
        background: transparent; color: inherit; }
      .llmwiki-toolbar { display: flex; justify-content: flex-end; gap: 8px;
        margin-bottom: 8px; }
      .llmwiki-btn { padding: 4px 12px; border-radius: 4px; border: 1px solid
        var(--fill-quaternary, #ccc); background: var(--fill-secondary, #f5f5f5);
        cursor: pointer; font-size: 12px; }
      .llmwiki-btn:hover { background: var(--fill-tertiary, #e0e0e0); }
      .llmwiki-empty { color: var(--text-secondary, #999); padding: 24px;
        text-align: center; }
    </style>
    <div id="llmwiki-browser">
      <div id="llmwiki-browser-tree"></div>
      <div id="llmwiki-browser-splitter"></div>
      <div id="llmwiki-browser-content">
        <div class="llmwiki-empty">Select a file from the tree to preview</div>
      </div>
    </div>`;
}
```

- [ ] **Step 3: Build**

```bash
npm run build
```

Expected: marked imports and compiles successfully with esbuild.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/modules/wikiBrowser.ts
git commit -m "feat: add wikiBrowser shell with marked markdown rendering"
```

---

### Task 7: `wikiBrowser.ts` — File tree + splitter

**Files:**
- Modify: `src/modules/wikiBrowser.ts`

- [ ] **Step 1: Add buildFileTree, handleTreeClick, handleSplitterDrag**

Append before the `export function renderWikiBrowser` line:

```typescript
// ─── File Tree ───

function buildFileTree(): void {
  if (!state.tree) return;
  const treeData = listTree();
  let html = "";

  for (const dir of treeData) {
    html += `<div class="llmwiki-tree-dir">${escapeHTML(dir.name)}</div>`;
    if (dir.children && dir.children.length > 0) {
      for (const file of dir.children) {
        const active = state.currentNode?.path === file.path ? " active" : "";
        html += `<div class="llmwiki-tree-item${active}" data-path="${escapeHTML(file.path)}">${escapeHTML(file.name.replace(/\.md$/, ""))}</div>`;
      }
    } else {
      html += `<div class="llmwiki-tree-item" style="color:var(--text-secondary);font-style:italic;cursor:default">(empty)</div>`;
    }
  }

  state.tree.innerHTML = html;
}

function handleTreeClick(e: Event): void {
  const target = e.target as HTMLElement;
  if (!target.classList.contains("llmwiki-tree-item")) return;
  const path = target.dataset.path;
  if (!path) return;

  state.currentNode = { name: path.split("/").pop() || "", path, type: "file" };
  state.mode = "preview";
  loadPage(path);
  buildFileTree();
}

// ─── Splitter Drag ───

function handleSplitterDrag(e: MouseEvent): void {
  e.preventDefault();
  const tree = document.getElementById("llmwiki-browser-tree") as HTMLElement;
  if (!tree) return;
  const startX = e.clientX;
  const startWidth = tree.offsetWidth;

  function onMove(ev: MouseEvent): void {
    const newWidth = Math.max(80, Math.min(400, startWidth + (ev.clientX - startX)));
    tree.style.width = `${newWidth}px`;
  }

  function onUp(): void {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  }

  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}
```

- [ ] **Step 2: Build**

```bash
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add src/modules/wikiBrowser.ts
git commit -m "feat: add wikiBrowser file tree and splitter drag"
```

---

### Task 8: `wikiBrowser.ts` — Content area (preview, edit, save, navigation)

**Files:**
- Modify: `src/modules/wikiBrowser.ts`

- [ ] **Step 1: Add loadPage, preview mode, edit mode, save, wikilink navigation**

Append after `handleSplitterDrag`:

```typescript
// ─── Page Loading ───

function loadPage(relPath: string): void {
  const page = readPage(relPath);
  if (!page) {
    showContent("<div class='llmwiki-empty'>Failed to read file</div>");
    return;
  }
  state.currentPage = page;
  if (state.mode === "preview") {
    showPreview(page);
  } else {
    showEditor(page);
  }
}

function showPreview(page: ParsedPage): void {
  const raw = [
    "---",
    ...Object.entries(page.frontmatter).map(([k, v]) => `${k}: "${v}"`),
    "---",
    "",
    page.body,
  ].join("\n");

  const html = renderMarkdown(raw);
  const toolbar = `
    <div class="llmwiki-toolbar">
      <button class="llmwiki-btn" id="llmwiki-edit-btn">Edit</button>
    </div>`;
  setContent(toolbar + html);
  state.mode = "preview";
}

function showEditor(page: ParsedPage): void {
  // Reconstruct raw markdown from frontmatter + body
  const frontmatterYaml = Object.entries(page.frontmatter)
    .map(([k, v]) => `${k}: "${v.replace(/"/g, '\\"')}"`)
    .join("\n");
  const raw = `---\n${frontmatterYaml}\n---\n\n${page.body}`;

  const html = `
    <div class="llmwiki-toolbar">
      <button class="llmwiki-btn" id="llmwiki-cancel-btn">Cancel</button>
      <button class="llmwiki-btn" id="llmwiki-save-btn" style="background:var(--accent-selected,#0060df);color:#fff">Save</button>
    </div>
    <textarea class="llmwiki-editor" id="llmwiki-editor">${escapeHTML(raw)}</textarea>`;
  setContent(html);
  state.mode = "edit";

  const editor = document.getElementById("llmwiki-editor") as HTMLTextAreaElement;
  if (editor) editor.focus();
}

function saveCurrentPage(): void {
  if (!state.currentPage) return;
  const editor = document.getElementById("llmwiki-editor") as HTMLTextAreaElement;
  if (!editor) return;

  savePage(state.currentPage.filePath, editor.value);

  // Reload
  state.mode = "preview";
  loadPage(state.currentPage.filePath);
}

// ─── Content Click Handler ───

function handleContentClick(e: Event): void {
  const target = e.target as HTMLElement;

  if (target.id === "llmwiki-edit-btn") {
    state.mode = "edit";
    if (state.currentPage) showEditor(state.currentPage);
    return;
  }
  if (target.id === "llmwiki-cancel-btn") {
    state.mode = "preview";
    if (state.currentPage) showPreview(state.currentPage);
    return;
  }
  if (target.id === "llmwiki-save-btn") {
    saveCurrentPage();
    return;
  }

  // Wikilink navigation
  if (target.classList.contains("wikilink")) {
    const targetPath = target.dataset.target;
    if (targetPath) {
      // Convert "papers/slug" or "papers/slug.md" to file path
      const path = targetPath.endsWith(".md") ? targetPath : `${targetPath}.md`;
      state.currentNode = { name: path.split("/").pop() || "", path, type: "file" };
      state.mode = "preview";
      loadPage(path);
      buildFileTree();
    }
  }
}

// ─── Helpers ───

function setContent(html: string): void {
  if (state.content) state.content.innerHTML = html;
}

function showContent(html: string): void {
  setContent(html);
}
```

- [ ] **Step 2: Build**

```bash
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add src/modules/wikiBrowser.ts
git commit -m "feat: add wikiBrowser preview, edit, save, wikilink navigation"
```

---

### Task 9: Register panel in `hooks.ts` + add locale strings

**Files:**
- Modify: `src/hooks.ts`
- Modify: `addon/locale/en-US/addon.ftl`
- Modify: `addon/locale/zh-CN/addon.ftl`

- [ ] **Step 1: Add locale strings**

In `addon/locale/en-US/addon.ftl`, append:

```
# Wiki Browser
section-wikibrowser-head-text = Wiki Browser
section-wikibrowser-sidenav-tooltip = Browse and edit your LLM Wiki knowledge base
```

In `addon/locale/zh-CN/addon.ftl`, append:

```
# Wiki 浏览器
section-wikibrowser-head-text = Wiki 浏览器
section-wikibrowser-sidenav-tooltip = 浏览和编辑 LLM Wiki 知识库
```

- [ ] **Step 2: Update imports and add registerSection call in hooks.ts**

In `src/hooks.ts`, update the locale import line (line 1) to include `getLocaleID`:

From:
```typescript
import { getString, initLocale } from "./utils/locale";
```
To:
```typescript
import { getString, initLocale, getLocaleID } from "./utils/locale";
```

Add the wikiBrowser import:
```typescript
import { renderWikiBrowser } from "./modules/wikiBrowser";
```

In the `onStartup()` function, after the `registerPrefsScripts` setup and before the notifier registration, add:

```typescript
  // Register Wiki Browser panel
  Zotero.ItemPaneManager.registerSection({
    paneID: `${addon.data.config.addonRef}-wikiBrowser`,
    pluginID: addon.data.config.addonID,
    sidenav: {
      icon: `chrome://${addon.data.config.addonRef}/content/icons/favicon.png`,
      l10nID: getLocaleID("section-wikibrowser-sidenav-tooltip"),
    },
    header: {
      icon: `chrome://${addon.data.config.addonRef}/content/icons/favicon.png`,
      l10nID: getLocaleID("section-wikibrowser-head-text"),
    },
    onRender: ({ body, doc }) => {
      renderWikiBrowser({ body, doc });
    },
  });
```

- [ ] **Step 3: Update locale type generation**

Run build to regenerate typings:

```bash
npm run build
```

- [ ] **Step 4: Verify typings/i10n.d.ts includes the new keys**

```bash
grep "section-wikibrowser" typings/i10n.d.ts
```

Expected: The two new Fluent message IDs appear in the type union.

- [ ] **Step 5: Commit**

```bash
git add src/hooks.ts addon/locale/en-US/addon.ftl addon/locale/zh-CN/addon.ftl
git commit -m "feat: register Wiki Browser panel in ItemPaneManager"
```

---

### Task 10: End-to-end build, install, and smoke test

- [ ] **Step 1: Full production build**

```bash
npm run build
```

Expected: Zero TypeScript errors, esbuild succeeds, output at `.scaffold/build/addon/content/scripts/llmwiki.js`.

- [ ] **Step 2: Start dev server and verify in Zotero**

```bash
npm start
```

Manual verification checklist in Zotero:
1. Open Zotero, look at the right-side pane tabs — "Wiki Browser" tab should appear with icon
2. Click the tab — file tree should show papers/concepts/entities directories
3. If papers exist, click one — preview should render with metadata card and formatted sections
4. Click the "Edit" button — content area should switch to textarea with raw markdown
5. Modify text, click "Save" — preview should refresh with changes
6. Click a `[[wikilink]]` — should navigate to that page (if it exists)
7. Drag the splitter between tree and content — should resize
8. Verify debug output: Zotero → Help → Debug Output Logging → search `[llmwiki]`

- [ ] **Step 3: Commit any final fixes**

```bash
git add -A
git commit -m "chore: final polish for Wiki Browser panel"
```
