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

// ─── Stub declarations (implemented in follow-up tasks) ───

function buildFileTree(): void {}
function handleTreeClick(_e: Event): void {}
function handleContentClick(_e: Event): void {}
function handleSplitterDrag(_e: MouseEvent): void {}
