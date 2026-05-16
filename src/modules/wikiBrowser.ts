import { marked } from "marked";
import {
  listTree,
  readPage,
  savePage,
  parseFrontmatter,
  type FileNode,
  type ParsedPage,
} from "./wikiReader";

// ─── State ───

interface BrowserState {
  currentNode: FileNode | null;
  currentPage: ParsedPage | null;
  mode: "preview" | "edit";
  tree: HTMLElement | null;
  content: HTMLElement | null;
  doc: Document | null;
}

const state: BrowserState = {
  currentNode: null,
  currentPage: null,
  mode: "preview",
  tree: null,
  content: null,
  doc: null,
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
  #llmwiki-browser-tree { width: 180px; min-width: 60px; max-width: 50%;
    overflow-y: auto; overflow-x: hidden;
    border-right: 1px solid var(--fill-quaternary, #e0e0e0); padding: 8px; }
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
`;

// ─── Public Entry Point ───

export function renderWikiBrowser({ body, doc }: { body: HTMLElement; doc: Document }): void {
  if (!body) return;
  state.doc = doc;

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

    const tree = doc.createElement("div");
    tree.id = "llmwiki-browser-tree";
    tree.textContent = "LOADING...";

    const splitter = doc.createElement("div");
    splitter.id = "llmwiki-browser-splitter";

    const content = doc.createElement("div");
    content.id = "llmwiki-browser-content";
    const placeholder = doc.createElement("div");
    placeholder.className = "llmwiki-empty";
    placeholder.textContent = "Select a file from the tree to preview";
    content.appendChild(placeholder);

    container.appendChild(tree);
    container.appendChild(splitter);
    container.appendChild(content);
    body.appendChild(container);

    // Store refs
    state.tree = tree;
    state.content = content;

    tree.addEventListener("click", handleTreeClick);
    content.addEventListener("click", handleContentClick);
    splitter.addEventListener("mousedown", handleSplitterDrag);

    buildFileTree();
  } catch (e: any) {
    body.textContent = `Error: ${e.message || String(e)}`;
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
    const newWidth = Math.max(80, Math.min(400, startWidth + (ev.clientX - startX)));
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
  while (state.content.firstChild) state.content.removeChild(state.content.firstChild);

  // Toolbar
  const toolbar = doc.createElement("div");
  toolbar.className = "llmwiki-toolbar";
  const editBtn = doc.createElement("button");
  editBtn.className = "llmwiki-btn";
  editBtn.id = "llmwiki-edit-btn";
  editBtn.textContent = "Edit";
  toolbar.appendChild(editBtn);
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

  const frontmatterYaml = Object.entries(page.frontmatter)
    .map(([k, v]) => `${k}: "${v.replace(/"/g, '\\"')}"`)
    .join("\n");
  const raw = `---\n${frontmatterYaml}\n---\n\n${page.body}`;

  // Clear content
  while (state.content.firstChild) state.content.removeChild(state.content.firstChild);

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

  state.mode = "edit";
}

function saveCurrentPage(): void {
  if (!state.currentPage || !state.content) return;
  // Find textarea among content children
  let editor: HTMLTextAreaElement | null = null;
  for (let i = 0; i < state.content.children.length; i++) {
    const child = state.content.children[i];
    if (child.tagName === "TEXTAREA") {
      editor = child as HTMLTextAreaElement;
      break;
    }
  }
  if (!editor) return;

  const newRaw = editor.value;

  // Persist to disk
  savePage(state.currentPage.filePath, newRaw);

  // Parse edited content and show preview directly (avoid file re-read round-trip)
  const { frontmatter, body } = parseFrontmatter(newRaw);
  state.currentPage = {
    frontmatter,
    body,
    filePath: state.currentPage.filePath,
  };
  state.mode = "preview";
  showPreview(state.currentPage);
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
      const path = targetPath.endsWith(".md") ? targetPath : `${targetPath}.md`;
      state.currentNode = { name: path.split("/").pop() || "", path, type: "file" };
      state.mode = "preview";
      loadPage(path);
      buildFileTree();
    }
  }
}

// ─── Helpers ───

function showEmpty(message: string): void {
  if (!state.content || !state.doc) return;
  while (state.content.firstChild) state.content.removeChild(state.content.firstChild);
  const el = state.doc.createElement("div");
  el.className = "llmwiki-empty";
  el.textContent = message;
  state.content.appendChild(el);
}
