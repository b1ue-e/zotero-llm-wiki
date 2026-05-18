import { getWikiBaseDir, writeFile, readFile, listDir, ensureDirs, makeDir } from "../utils/xpcom";

// ─── Types ───

export interface RawPaper {
  title: string;
  authors: string;
  abstract: string;
  year: string;
  publication: string;
  doi: string;
  fulltext: string | null;
  wiki_slug: string;
  ingested_at: string;
  updated_at: string;
}

interface RawIndexEntry {
  slug: string;
  title: string;
  authors: string;
  year: string;
  wiki_slug: string;
}

interface SearchResult {
  slug: string;
  title: string;
  filePath: string;
  snippet: string;
}

// ─── Path helpers ───

function getRawDir(): string {
  let dataPath = Zotero.Prefs.get("dataDir") as string;
  if (!dataPath) {
    const storagePath = Zotero.getStorageDirectory().path;
    dataPath = storagePath.substring(0, storagePath.lastIndexOf("/"));
  }
  return `${dataPath}/llm-wiki/raw`;
}

function getRawPapersDir(): string {
  return `${getRawDir()}/papers`;
}

function getIndexPath(): string {
  return `${getRawDir()}/index.json`;
}

// ─── Init ───

function ensureRawDirs(): void {
  makeDir(getRawDir());
  makeDir(getRawPapersDir());
}

// ─── Read / Write ───

export function writeRaw(slug: string, data: RawPaper): void {
  ensureRawDirs();
  const path = `${getRawPapersDir()}/${slug}.json`;
  writeFile(path, JSON.stringify(data, null, 2));
  updateRawIndex({ slug, title: data.title, authors: data.authors, year: data.year, wiki_slug: data.wiki_slug });
}

export function readRaw(slug: string): RawPaper | null {
  const path = `${getRawPapersDir()}/${slug}.json`;
  const content = readFile(path);
  if (!content) return null;
  try {
    return JSON.parse(content) as RawPaper;
  } catch (_e) {
    return null;
  }
}

// ─── Index ───

function readIndex(): RawIndexEntry[] {
  const content = readFile(getIndexPath());
  if (!content) return [];
  try {
    return JSON.parse(content) as RawIndexEntry[];
  } catch (_e) {
    return [];
  }
}

function writeIndex(entries: RawIndexEntry[]): void {
  ensureRawDirs();
  writeFile(getIndexPath(), JSON.stringify(entries, null, 2));
}

function updateRawIndex(entry: RawIndexEntry): void {
  const entries = readIndex();
  const existing = entries.findIndex((e: RawIndexEntry) => e.slug === entry.slug);
  if (existing >= 0) {
    entries[existing] = entry;
  } else {
    entries.push(entry);
  }
  writeIndex(entries);
}

// ─── Search ───

export function searchRaw(query: string): SearchResult[] {
  const results: SearchResult[] = [];
  const q = query.toLowerCase();
  const index = readIndex();

  // Pre-filter by index (title match)
  const candidates = index.filter(
    (e: RawIndexEntry) => e.title.toLowerCase().includes(q)
  );

  // Also scan all raw files for fulltext/abstract matches
  const paperFiles = listDir(getRawPapersDir());
  for (const filePath of paperFiles) {
    if (!filePath.endsWith(".json")) continue;
    const slug = filePath.split("/").pop()?.replace(/\.json$/, "") || "";
    const raw = readRaw(slug);
    if (!raw) continue;

    const abstractLower = (raw.abstract || "").toLowerCase();
    const fulltextLower = (raw.fulltext || "").toLowerCase();
    const titleLower = raw.title.toLowerCase();

    if (titleLower.includes(q) || abstractLower.includes(q) || fulltextLower.includes(q)) {
      let source = raw.abstract || "";
      if (fulltextLower.includes(q)) source = raw.fulltext || source;
      const matchIdx = source.toLowerCase().indexOf(q);
      const start = Math.max(0, matchIdx - 60);
      const end = Math.min(source.length, matchIdx + q.length + 120);
      const snippet = (start > 0 ? "…" : "") +
        source.slice(start, end).replace(/\n/g, " ") +
        (end < source.length ? "…" : "");

      results.push({
        slug,
        title: raw.title,
        filePath: `raw/papers/${slug}.json`,
        snippet: snippet || raw.title,
      });
    }
  }

  return results;
}
