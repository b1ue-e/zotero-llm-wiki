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
