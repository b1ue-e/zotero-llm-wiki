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

  const ownerDoc = state.content?.ownerDocument;
  if (ownerDoc) {
    const editor = ownerDoc.getElementById("llmwiki-editor") as HTMLTextAreaElement;
    if (editor) editor.focus();
  }
}

function saveCurrentPage(): void {
  if (!state.currentPage) return;
  const ownerDoc = state.content?.ownerDocument;
  if (!ownerDoc) return;
  const editor = ownerDoc.getElementById("llmwiki-editor") as HTMLTextAreaElement;
  if (!editor) return;

  savePage(state.currentPage.filePath, editor.value);

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
