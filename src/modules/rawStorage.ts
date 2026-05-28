import {
  getWikiBaseDir,
  writeBinaryFile,
  readBinaryFile,
  listDir,
  makeDir,
} from "../utils/xpcom";

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

const MAX_FULLTEXT_LENGTH = 200000; // ~200KB max for JSON safety

export function writeRaw(slug: string, data: RawPaper): void {
  ensureRawDirs();
  const path = `${getRawPapersDir()}/${slug}.json`;
  // Truncate fulltext to avoid huge files and JSON encoding issues
  if (data.fulltext && data.fulltext.length > MAX_FULLTEXT_LENGTH) {
    data.fulltext =
      data.fulltext.slice(0, MAX_FULLTEXT_LENGTH) +
      `\n\n[...truncated from ${data.fulltext.length} chars]`;
  }
  // Use binary write to avoid UTF-8 converter corruption on special chars
  writeBinaryFile(path, JSON.stringify(data, null, 2));
  updateRawIndex({
    slug,
    title: data.title,
    authors: data.authors,
    year: data.year,
    wiki_slug: data.wiki_slug,
  });
}

export function readRaw(slug: string): RawPaper | null {
  const path = `${getRawPapersDir()}/${slug}.json`;
  const content = readBinaryFile(path);
  if (!content) return null;
  try {
    return JSON.parse(content) as RawPaper;
  } catch (_e: any) {
    Zotero.debug(
      `[llmwiki] rawStorage.readRaw: JSON parse failed: ${_e.message}`,
    );
    return null;
  }
}

// ─── Index ───

function readIndex(): RawIndexEntry[] {
  const content = readBinaryFile(getIndexPath());
  if (!content) return [];
  try {
    return JSON.parse(content) as RawIndexEntry[];
  } catch (_e) {
    return [];
  }
}

function writeIndex(entries: RawIndexEntry[]): void {
  ensureRawDirs();
  writeBinaryFile(getIndexPath(), JSON.stringify(entries, null, 2));
}

function updateRawIndex(entry: RawIndexEntry): void {
  const entries = readIndex();
  const existing = entries.findIndex(
    (e: RawIndexEntry) => e.slug === entry.slug,
  );
  if (existing >= 0) {
    entries[existing] = entry;
  } else {
    entries.push(entry);
  }
  writeIndex(entries);
}

// ─── Search ───

// Track search calls to offset into different fulltext sections
let _searchCallCount = 0;

export function searchRaw(query: string): SearchResult[] {
  _searchCallCount++;
  const results: SearchResult[] = [];
  const q = query.toLowerCase();
  const queryWords = q.split(/\s+/).filter((w: string) => w.length > 1);
  const index = readIndex();

  // Pre-filter by index (title word match)
  const candidates = index.filter((e: RawIndexEntry) =>
    queryWords.some((w: string) => e.title.toLowerCase().includes(w)),
  );

  // Also scan all raw files for fulltext/abstract matches
  const paperFiles = listDir(getRawPapersDir());
  for (const filePath of paperFiles) {
    if (!filePath.endsWith(".json")) continue;
    const slug =
      filePath
        .split("/")
        .pop()
        ?.replace(/\.json$/, "") || "";
    const raw = readRaw(slug);
    if (!raw) continue;

    const abstractLower = (raw.abstract || "").toLowerCase();
    const fulltextLower = (raw.fulltext || "").toLowerCase();
    const titleLower = raw.title.toLowerCase();

    // Match if ANY query word appears in title, abstract, or fulltext
    const matchTitle = queryWords.some((w: string) => titleLower.includes(w));
    const matchAbstract = queryWords.some((w: string) =>
      abstractLower.includes(w),
    );
    const matchFulltext = queryWords.some((w: string) =>
      fulltextLower.includes(w),
    );

    if (matchTitle || matchAbstract || matchFulltext) {
      // Find the best matching word position for a snippet
      let source = raw.abstract || "";
      let matchWord =
        queryWords.find((w: string) => source.toLowerCase().includes(w)) || "";
      if (!matchWord && matchFulltext) {
        source = raw.fulltext || source;
        matchWord =
          queryWords.find((w: string) => source.toLowerCase().includes(w)) ||
          queryWords[0];
      }
      // Jump to different fulltext section each call (10KB stride)
      const stride = 10000;
      const offset = (_searchCallCount * stride) % source.length;
      // Find first matching word at or after the offset
      let matchIdx = source.toLowerCase().indexOf(matchWord, offset);
      if (matchIdx === -1) matchIdx = offset; // fallback to position offset
      const start = Math.max(0, matchIdx - 1500);
      const end = Math.min(source.length, matchIdx + matchWord.length + 3500);
      const snippet =
        (start > 0 ? "…" : "") +
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
