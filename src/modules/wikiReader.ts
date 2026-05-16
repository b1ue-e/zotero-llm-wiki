import { getWikiBaseDir, readFile, writeFile, listDir } from "../utils/xpcom";

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
