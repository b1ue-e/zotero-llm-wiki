import { marked } from "marked";
import {
  listTree,
  readPage,
  savePage,
  parseFrontmatter,
  type FileNode,
  type ParsedPage,
} from "./wikiReader";
import { getWikiBaseDir, readFile, listDir } from "../utils/xpcom";
import { getSuggestions, scanAll, dismissSuggestion } from "./suggestionEngine";

// ─── State ───

interface BrowserState {
  currentNode: FileNode | null;
  currentPage: ParsedPage | null;
  mode: "preview" | "edit" | "graph";
  tree: HTMLElement | null;
  content: HTMLElement | null;
  root: HTMLElement | null;
  doc: Document | null;
  editor: HTMLTextAreaElement | null;
}

const state: BrowserState = {
  currentNode: null,
  currentPage: null,
  mode: "preview",
  tree: null,
  content: null,
  root: null,
  doc: null,
  editor: null,
};

// ─── Markdown Rendering ───

function renderMarkdown(raw: string): string {
  const { frontmatter, body } = parseFrontmatter(raw);

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
      title
        ? `<div class="llmwiki-metadata-title">${escapeHTML(title)}</div>`
        : "",
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

// ─── CSS ───

const PANEL_CSS = `
  #llmwiki-browser { display: flex; height: 100%; overflow: hidden; min-width: 0; }
  #llmwiki-browser-tree-panel { width: 180px; min-width: 60px; max-width: 50%;
    display: flex; flex-direction: column; overflow: hidden;
    border-right: 1px solid var(--fill-quaternary, #e0e0e0); }
  .llmwiki-tree-toolbar { display: flex; justify-content: flex-end;
    padding: 4px; border-bottom: 1px solid var(--fill-quaternary, #e0e0e0); }
  #llmwiki-browser-tree { flex: 1; overflow-y: auto; overflow-x: hidden; padding: 8px; }
  #llmwiki-browser-splitter { width: 4px; cursor: col-resize; flex-shrink: 0; }
  #llmwiki-browser-splitter:hover { background: var(--fill-quaternary, #e0e0e0); }
  #llmwiki-browser-content { flex: 1; display: flex; flex-direction: column;
    overflow-y: auto; overflow-x: hidden;
    padding: 12px; min-width: 0; word-wrap: break-word; }
  .llmwiki-tree-item { padding: 3px 8px; cursor: pointer; border-radius: 4px;
    font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .llmwiki-tree-item:hover { background: var(--fill-tertiary, #f0f0f0); }
  .llmwiki-tree-item.active { background: var(--accent-selected, #0060df);
    color: var(--text-selected, #fff); }
  .llmwiki-tree-dir { font-weight: 700; padding: 8px 8px 4px; font-size: 11px;
    text-transform: uppercase; letter-spacing: 0.5px;
    color: var(--accent-selected, #0060df); border-bottom: 1px solid
    var(--fill-quaternary, #e0e0e0); margin: 4px 8px 2px; }
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
  .llmwiki-editor { flex: 1; width: 100%; min-height: 200px; border: none;
    resize: none; font-family: monospace; font-size: 13px; padding: 8px;
    background: transparent; color: inherit; }
  .llmwiki-toolbar { display: flex; justify-content: flex-end; gap: 8px;
    margin-bottom: 8px; }
  .llmwiki-btn { padding: 4px 12px; border-radius: 4px; border: 1px solid
    var(--fill-quaternary, #ccc); background: var(--fill-secondary, #f5f5f5);
    cursor: pointer; font-size: 12px; }
  .llmwiki-btn:hover { background: var(--fill-tertiary, #e0e0e0); }
  .llmwiki-empty { color: var(--text-secondary, #999); padding: 24px;
    text-align: center; }
  #llmwiki-browser { position: relative; }
  .llmwiki-toast { position: absolute; bottom: 16px; left: 50%; transform: translateX(-50%);
    background: var(--fill-secondary, #333); color: var(--text-primary, #fff);
    padding: 8px 20px; border-radius: 6px; font-size: 13px; white-space: nowrap;
    opacity: 0; transition: opacity 0.2s; pointer-events: none; z-index: 9999; }
  .llmwiki-toast.show { opacity: 1; }
  .llmwiki-graph-back { margin-bottom: 12px; }
  .llmwiki-graph-layer { margin-bottom: 16px; }
  .llmwiki-graph-layer-title { font-size: 12px; font-weight: 600;
    text-transform: uppercase; color: var(--text-secondary, #666);
    margin-bottom: 8px; padding-bottom: 4px;
    border-bottom: 1px solid var(--fill-quaternary, #e0e0e0); }
  .llmwiki-graph-layer-cards { display: flex; flex-wrap: wrap; gap: 8px; }
  .llmwiki-graph-card { background: var(--fill-secondary, #f5f5f5);
    border: 1px solid var(--fill-quaternary, #e0e0e0);
    border-radius: 8px; padding: 10px 14px; cursor: pointer;
    min-width: 120px; max-width: 220px; }
  .llmwiki-graph-card:hover { border-color: var(--accent-selected, #0060df);
    background: var(--fill-tertiary, #f0f0f0); }
  .llmwiki-graph-card.current { border-color: var(--accent-selected, #0060df);
    border-width: 2px; background: var(--accent-tertiary, #e0e0ff); }
  .llmwiki-graph-card-name { font-weight: 600; font-size: 13px; margin-bottom: 4px; }
  .llmwiki-graph-card-type { font-size: 11px;
    color: var(--text-secondary, #999); }
  .llmwiki-graph-card-meta { font-size: 11px;
    color: var(--text-secondary, #666); margin-top: 4px; }
  .llmwiki-graph-arrow { text-align: center; color: var(--text-secondary, #999);
    font-size: 18px; margin: 4px 0; }
  .llmwiki-suggestions-bar { border-bottom: 2px solid var(--accent-selected, #0060df); overflow: hidden; background: #e8f0fe; }
  .llmwiki-suggestions-header { padding: 8px 10px; cursor: pointer; }
  .llmwiki-suggestions-title { font-size: 12px; font-weight: 700; color: #1a56db; }
  .llmwiki-suggestions-count { font-size: 11px; color: #1a56db; background: #d0e0fc; padding: 1px 6px; border-radius: 8px; }
  .llmwiki-suggestions-list { padding: 4px 10px 8px; max-height: 300px; overflow-y: auto; background: #fff; }
  .llmwiki-suggestion-item { padding: 6px 8px; margin: 4px 0; border-radius: 6px; font-size: 12px; background: var(--fill-secondary, #fafafa); border: 1px solid var(--fill-quaternary, #e0e0e0); }
  .llmwiki-suggestion-item.warning { border-left: 3px solid #e6a817; }
  .llmwiki-suggestion-item.info { border-left: 3px solid var(--accent-selected, #0060df); }
  .llmwiki-suggestion-title { font-weight: 600; margin-bottom: 2px; }
  .llmwiki-suggestion-detail { color: var(--text-secondary, #666); font-size: 11px; margin-bottom: 4px; }
  .llmwiki-suggestion-actions { display: flex; gap: 6px; }
  .llmwiki-suggestion-btn { font-size: 11px; padding: 3px 10px; border-radius: 4px; border: 1px solid var(--fill-quaternary, #ccc); background: var(--fill-secondary, #f5f5f5); cursor: pointer; color: var(--text-primary, #333); }
  .llmwiki-suggestion-btn:hover { background: var(--fill-tertiary, #e0e0e0); }
  .llmwiki-suggestion-btn.dismiss { color: var(--text-secondary, #999); border: none; background: none; padding: 2px 4px; }
  .llmwiki-suggestion-btn.dismiss:hover { color: #d32f2f; }
  .llmwiki-scan-btn { background: #1a56db; color: #fff; border: none; font-weight: 600; white-space: nowrap; font-size: 12px; padding: 4px 14px; }
  .llmwiki-scan-btn:hover { opacity: 0.9; background: #1a56db; }
  .llmwiki-scan-btn:disabled { opacity: 0.6; animation: llmwiki-pulse 0.8s infinite; }
  @keyframes llmwiki-pulse { 0%,100% { opacity: 0.6; } 50% { opacity: 1; } }
  .llmwiki-suggestion-feedback { font-size: 11px; color: #1a56db; }
  .llmwiki-suggestions-collapsed .llmwiki-suggestions-list { display: none; }
`;

// ─── Public Entry Point ───

export function renderWikiBrowser({
  body,
  doc,
}: {
  body: HTMLElement;
  doc: Document;
}): void {
  if (!body) return;
  state.doc = doc;

  // Rebuild only if our shell was detached (tab hidden → DOM destroyed by Zotero)
  if (state.tree?.parentNode) return;

  try {
    // Clear body
    while (body.firstChild) body.removeChild(body.firstChild);

    // Build CSS
    const style = doc.createElement("style");
    style.textContent = PANEL_CSS;
    body.appendChild(style);

    // Build shell structure
    const container = doc.createElement("div");
    container.id = "llmwiki-browser";

    // Tree panel wrapper (toolbar + tree)
    const treePanel = doc.createElement("div");
    treePanel.id = "llmwiki-browser-tree-panel";

    // Suggestions bar (above tree toolbar)
    const suggestionsBar = doc.createElement("div");
    suggestionsBar.className = "llmwiki-suggestions-bar llmwiki-suggestions-collapsed";
    suggestionsBar.id = "llmwiki-suggestions-bar";

    // Header row: title + count + collapse toggle
    const suggestionsHeader = doc.createElement("div");
    suggestionsHeader.className = "llmwiki-suggestions-header";
    suggestionsHeader.addEventListener("click", () => {
      suggestionsBar.classList.toggle("llmwiki-suggestions-collapsed");
      renderSuggestions();
    });

    const titleRow = doc.createElement("div");
    titleRow.style.cssText = "display:flex;align-items:center;gap:8px;";
    const suggestionsTitle = doc.createElement("span");
    suggestionsTitle.className = "llmwiki-suggestions-title";
    suggestionsTitle.textContent = "🔍 Suggestions";
    titleRow.appendChild(suggestionsTitle);

    const suggestionsCount = doc.createElement("span");
    suggestionsCount.className = "llmwiki-suggestions-count";
    suggestionsCount.id = "llmwiki-suggestions-count";
    suggestionsCount.textContent = "0";
    titleRow.appendChild(suggestionsCount);

    const collapseIcon = doc.createElement("span");
    collapseIcon.style.cssText = "margin-left:auto;font-size:14px;color:var(--text-secondary,#999);";
    collapseIcon.textContent = "+";
    collapseIcon.id = "llmwiki-suggestions-collapse-icon";
    titleRow.appendChild(collapseIcon);
    suggestionsHeader.appendChild(titleRow);

    // Action row: scan button + feedback
    const actionRow = doc.createElement("div");
    actionRow.style.cssText = "display:flex;align-items:center;gap:8px;margin-top:6px;";
    const scanBtn = doc.createElement("button");
    scanBtn.className = "llmwiki-suggestion-btn llmwiki-scan-btn";
    scanBtn.textContent = "Scan All";
    scanBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      scanBtn.textContent = "Scanning...";
      scanBtn.disabled = true;
      // Brief delay so the "Scanning..." state is visible
      setTimeout(() => {
        scanAll();
        scanBtn.textContent = "Scan All";
        scanBtn.disabled = false;
        renderSuggestions();
        // Flash the feedback
        const fb = state.doc?.getElementById("llmwiki-suggestions-feedback") as HTMLElement | null;
        if (fb) {
          fb.style.transition = "none";
          fb.style.fontWeight = "700";
          setTimeout(() => {
            fb.style.transition = "font-weight 0.5s";
            fb.style.fontWeight = "400";
          }, 600);
        }
      }, 400);
    });
    actionRow.appendChild(scanBtn);

    const feedbackEl = doc.createElement("span");
    feedbackEl.className = "llmwiki-suggestion-feedback";
    feedbackEl.id = "llmwiki-suggestions-feedback";
    actionRow.appendChild(feedbackEl);
    suggestionsHeader.appendChild(actionRow);

    suggestionsBar.appendChild(suggestionsHeader);

    const suggestionsList = doc.createElement("div");
    suggestionsList.className = "llmwiki-suggestions-list";
    suggestionsList.id = "llmwiki-suggestions-list";
    suggestionsBar.appendChild(suggestionsList);

    treePanel.appendChild(suggestionsBar);

    const treeToolbar = doc.createElement("div");
    treeToolbar.className = "llmwiki-tree-toolbar";
    const refreshBtn = doc.createElement("button");
    refreshBtn.className = "llmwiki-btn llmwiki-refresh-btn";
    refreshBtn.textContent = "↻"; // ↻ refresh symbol
    refreshBtn.title = "Refresh file tree";
    refreshBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      buildFileTree();
      showToast("File tree refreshed");
    });
    treeToolbar.appendChild(refreshBtn);
    treePanel.appendChild(treeToolbar);

    const tree = doc.createElement("div");
    tree.id = "llmwiki-browser-tree";
    tree.textContent = "LOADING...";
    treePanel.appendChild(tree);

    const splitter = doc.createElement("div");
    splitter.id = "llmwiki-browser-splitter";

    const content = doc.createElement("div");
    content.id = "llmwiki-browser-content";
    const placeholder = doc.createElement("div");
    placeholder.className = "llmwiki-empty";
    placeholder.textContent = "Select a file from the tree to preview";
    content.appendChild(placeholder);

    container.appendChild(treePanel);
    container.appendChild(splitter);
    container.appendChild(content);
    body.appendChild(container);

    // Store refs
    state.tree = tree;
    state.content = content;
    state.root = container;

    tree.addEventListener("click", handleTreeClick);
    content.addEventListener("click", handleContentClick);
    splitter.addEventListener("mousedown", handleSplitterDrag);

    buildFileTree();
    renderSuggestions();
  } catch (e: any) {
    body.textContent = `Error: ${e.message || String(e)}`;
  }
}

// ─── Suggestions ───

function renderSuggestions(): void {
  if (!state.doc) return;
  const listEl = state.doc.getElementById("llmwiki-suggestions-list") as HTMLElement | null;
  const countEl = state.doc.getElementById("llmwiki-suggestions-count") as HTMLElement | null;
  const bar = state.doc.getElementById("llmwiki-suggestions-bar") as HTMLElement | null;
  const iconEl = state.doc.getElementById("llmwiki-suggestions-collapse-icon") as HTMLElement | null;
  if (!listEl || !countEl || !bar) return;

  const suggestions = getSuggestions();
  countEl.textContent = String(suggestions.length);

  // Update feedback
  const fbEl = state.doc.getElementById("llmwiki-suggestions-feedback") as HTMLElement | null;
  if (fbEl) {
    fbEl.textContent = suggestions.length > 0
      ? `${suggestions.length} issue(s) found`
      : "No issues found";
  }

  const collapsed = bar.classList.contains("llmwiki-suggestions-collapsed");
  if (iconEl) iconEl.textContent = collapsed ? "+" : "−";

  if (collapsed) return;

  while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
  const doc = listEl.ownerDocument!;

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

    if (s.related_pages && s.related_pages.length > 0) {
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
    actionBtn.addEventListener("click", (ev: Event) => {
      ev.stopPropagation();
      if (s.related_pages.length > 0) {
        const target = s.related_pages[0];
        const path = target.endsWith(".md") ? target : `${target}.md`;
        state.currentNode = { name: path.split("/").pop() || "", path, type: "file" };
        state.mode = "preview";
        loadPage(path);
        buildFileTree();
      }
    });
    actionsEl.appendChild(actionBtn);

    const dismissBtn = doc.createElement("button");
    dismissBtn.className = "llmwiki-suggestion-btn dismiss";
    dismissBtn.textContent = "✕";
    dismissBtn.addEventListener("click", (ev: Event) => {
      ev.stopPropagation();
      dismissSuggestion(s.id);
      renderSuggestions();
    });
    actionsEl.appendChild(dismissBtn);

    item.appendChild(actionsEl);
    listEl.appendChild(item);
  }
}

// ─── File Tree ───

function buildFileTree(): void {
  if (!state.tree || !state.doc) return;
  const treeData = listTree();

  // Clear existing children
  while (state.tree.firstChild) state.tree.removeChild(state.tree.firstChild);

  const doc = state.doc;

  for (const dir of treeData) {
    const dirEl = doc.createElement("div");
    dirEl.className = "llmwiki-tree-dir";
    dirEl.textContent = dir.name;
    state.tree.appendChild(dirEl);

    if (dir.children && dir.children.length > 0) {
      for (const file of dir.children) {
        const item = doc.createElement("div");
        item.className = "llmwiki-tree-item";
        if (state.currentNode?.path === file.path) {
          item.classList.add("active");
        }
        item.dataset.path = file.path;
        item.textContent = file.name.replace(/\.md$/, "");
        state.tree.appendChild(item);
      }
    } else {
      const empty = doc.createElement("div");
      empty.className = "llmwiki-tree-item";
      empty.style.color = "var(--text-secondary, #666)";
      empty.style.fontStyle = "italic";
      empty.style.cursor = "default";
      empty.textContent = "(empty)";
      state.tree.appendChild(empty);
    }
  }
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
  const tree = state.tree;
  if (!tree) return;
  const startX = e.clientX;
  const startWidth = tree.offsetWidth;
  const doc = tree.ownerDocument!;

  function onMove(ev: MouseEvent): void {
    const newWidth = Math.max(
      80,
      Math.min(400, startWidth + (ev.clientX - startX)),
    );
    tree!.style.width = `${newWidth}px`;
  }

  function onUp(): void {
    doc.removeEventListener("mousemove", onMove);
    doc.removeEventListener("mouseup", onUp);
  }

  doc.addEventListener("mousemove", onMove);
  doc.addEventListener("mouseup", onUp);
}

// ─── Page Loading ───

function loadPage(relPath: string): void {
  const page = readPage(relPath);
  if (!page) {
    showEmpty("Failed to read file");
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
  if (!state.content || !state.doc) return;
  const doc = state.doc;

  // Reconstruct raw markdown
  const raw = [
    "---",
    ...Object.entries(page.frontmatter).map(([k, v]) => `${k}: "${v}"`),
    "---",
    "",
    page.body,
  ].join("\n");

  const renderedHTML = renderMarkdown(raw);

  // Clear content
  while (state.content.firstChild)
    state.content.removeChild(state.content.firstChild);

  // Toolbar
  const toolbar = doc.createElement("div");
  toolbar.className = "llmwiki-toolbar";
  const editBtn = doc.createElement("button");
  editBtn.className = "llmwiki-btn";
  editBtn.id = "llmwiki-edit-btn";
  editBtn.textContent = "Edit";
  toolbar.appendChild(editBtn);

  // Only show Graph button for concept/entity pages
  const pageType = page.frontmatter["type"] || "";
  if (pageType === "concept" || pageType === "entity") {
    const graphBtn = doc.createElement("button");
    graphBtn.className = "llmwiki-btn";
    graphBtn.id = "llmwiki-graph-btn";
    graphBtn.textContent = "Graph";
    toolbar.appendChild(graphBtn);
  }

  state.content.appendChild(toolbar);

  // Rendered content (use innerHTML for markdown — visual only, no lookup needed)
  const bodyDiv = doc.createElement("div");
  bodyDiv.innerHTML = renderedHTML;
  state.content.appendChild(bodyDiv);

  state.mode = "preview";
}

function showEditor(page: ParsedPage): void {
  if (!state.content || !state.doc) return;
  const doc = state.doc;

  // Read raw file from disk to avoid round-trip escaping issues
  // with parseFrontmatter → reconstruct frontmatter
  const fullPath = `${getWikiBaseDir()}/${page.filePath}`;
  const raw = readFile(fullPath) || "";

  // Clear content
  while (state.content.firstChild)
    state.content.removeChild(state.content.firstChild);

  // Toolbar
  const toolbar = doc.createElement("div");
  toolbar.className = "llmwiki-toolbar";

  const cancelBtn = doc.createElement("button");
  cancelBtn.className = "llmwiki-btn";
  cancelBtn.id = "llmwiki-cancel-btn";
  cancelBtn.textContent = "Cancel";
  toolbar.appendChild(cancelBtn);

  const saveBtn = doc.createElement("button");
  saveBtn.className = "llmwiki-btn";
  saveBtn.id = "llmwiki-save-btn";
  saveBtn.style.background = "var(--accent-selected, #0060df)";
  saveBtn.style.color = "#fff";
  saveBtn.textContent = "Save";
  toolbar.appendChild(saveBtn);

  state.content.appendChild(toolbar);

  // Textarea
  const textarea = doc.createElement("textarea");
  textarea.className = "llmwiki-editor";
  textarea.id = "llmwiki-editor";
  textarea.value = raw;
  state.content.appendChild(textarea);
  textarea.focus();
  state.editor = textarea as unknown as HTMLTextAreaElement;

  state.mode = "edit";
}

function saveCurrentPage(): void {
  if (!state.currentPage || !state.editor) return;

  const newRaw = state.editor.value;

  // Persist to disk
  savePage(state.currentPage.filePath, newRaw);

  // Parse edited content and show preview directly
  const { frontmatter, body } = parseFrontmatter(newRaw);
  state.currentPage = {
    frontmatter,
    body,
    filePath: state.currentPage.filePath,
  };
  state.mode = "preview";
  state.editor = null;
  showPreview(state.currentPage);
  showToast("Saved");
}

// ─── Graph View ───

function showGraphView(page: ParsedPage): void {
  if (!state.content || !state.doc) return;
  const doc = state.doc;

  while (state.content.firstChild) state.content.removeChild(state.content.firstChild);

  // Back button
  const backBtn = doc.createElement("button");
  backBtn.className = "llmwiki-btn llmwiki-graph-back";
  backBtn.id = "llmwiki-graph-back-btn";
  backBtn.textContent = "← Back to preview";
  state.content.appendChild(backBtn);

  const name = page.frontmatter["title"] || page.filePath;
  const pageType = page.frontmatter["type"] || "concept";
  const pageSlug = page.filePath.replace(/\.md$/, "");

  // Layer 1: Current Node
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

  // Arrow
  const arrow1 = doc.createElement("div");
  arrow1.className = "llmwiki-graph-arrow";
  arrow1.textContent = "↓";
  state.content.appendChild(arrow1);

  // Layer 2: Related Papers
  const baseDir = getWikiBaseDir();
  const papersDir = `${baseDir}/papers`;
  const paperFiles = listDir(papersDir);
  const relatedPapers: { title: string; slug: string; snippet: string }[] = [];

  for (const pf of paperFiles) {
    if (!pf.endsWith(".md")) continue;
    const relPath = `papers/${pf.split("/").pop()!}`;
    const paperPage = readPage(relPath);
    if (!paperPage) continue;
    const linkPattern = `[[${pageSlug}`;
    if (paperPage.body.includes(linkPattern) || paperPage.body.includes(`[[${pageSlug}|`)) {
      relatedPapers.push({
        title: paperPage.frontmatter["title"] || pf,
        slug: relPath.replace(/\.md$/, ""),
        snippet: (paperPage.frontmatter["year"] || "") + (paperPage.frontmatter["authors"] ? ` — ${paperPage.frontmatter["authors"].slice(0, 60)}` : ""),
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
    empty.textContent = "No papers reference this yet. Ingest more papers to build connections.";
    cards2.appendChild(empty);
  } else {
    for (const rp of relatedPapers) {
      cards2.appendChild(buildGraphCard(doc, rp.title, rp.slug, "paper", rp.snippet, false));
    }
  }
  layer2.appendChild(cards2);
  state.content.appendChild(layer2);

  // Arrow
  if (relatedPapers.length > 0) {
    const arrow2 = doc.createElement("div");
    arrow2.className = "llmwiki-graph-arrow";
    arrow2.textContent = "↓";
    state.content.appendChild(arrow2);
  }

  // Layer 3: See Also
  const seeAlsoLinks = page.body.match(/\[\[(concepts|entities)\/([^\]|]+)/g) || [];
  const uniqueSeeAlso = [...new Set(seeAlsoLinks.map(l => {
    const m = l.match(/\[\[((?:concepts|entities)\/[^\]|]+)/);
    return m ? m[1] : l.slice(2);
  }))];

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
      const saPage = readPage(`${saSlug}.md`);
      const saName = saPage?.frontmatter?.["title"] || saSlug.split("/").pop() || saSlug;
      const saType = saPage?.frontmatter?.["type"] || (saSlug.startsWith("concepts/") ? "concept" : "entity");
      cards3.appendChild(buildGraphCard(doc, saName, saSlug, saType, "", false));
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
    state.editor = null;
    if (state.currentPage) showPreview(state.currentPage);
    showToast("Edit cancelled");
    return;
  }
  if (target.id === "llmwiki-save-btn") {
    saveCurrentPage();
    return;
  }
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
  if (target.classList.contains("llmwiki-graph-card") || target.closest(".llmwiki-graph-card")) {
    const card = target.classList.contains("llmwiki-graph-card")
      ? target
      : target.closest(".llmwiki-graph-card") as HTMLElement;
    const targetPath = card?.dataset.target;
    if (targetPath) {
      const path = targetPath.endsWith(".md") ? targetPath : `${targetPath}.md`;
      state.currentNode = { name: path.split("/").pop() || "", path, type: "file" };
      state.mode = "preview";
      loadPage(path);
      buildFileTree();
    }
    return;
  }

  // Wikilink navigation
  if (target.classList.contains("wikilink")) {
    const targetPath = target.dataset.target;
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
  }
}

// ─── Helpers ───

function showEmpty(message: string): void {
  if (!state.content || !state.doc) return;
  while (state.content.firstChild)
    state.content.removeChild(state.content.firstChild);
  const el = state.doc.createElement("div");
  el.className = "llmwiki-empty";
  el.textContent = message;
  state.content.appendChild(el);
}

function showToast(message: string): void {
  if (!state.root || !state.doc) return;
  const toast = state.doc.createElement("div");
  toast.className = "llmwiki-toast";
  toast.textContent = message;
  state.root.appendChild(toast);
  // Force reflow then fade in
  toast.getClientRects();
  toast.classList.add("show");
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 300);
  }, 1500);
}
