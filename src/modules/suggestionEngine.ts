import { getWikiBaseDir, makeDir, writeFile, readFile, listDir } from "../utils/xpcom";
import { readPage } from "./wikiReader";

// ─── Types ───

interface Suggestion {
  id: string;
  type: "cross_paper_pattern" | "knowledge_gap" | "missing_paper";
  severity: "info" | "warning";
  title: string;
  detail: string;
  related_pages: string[];
  action_label: string;
  timestamp: string;
  dismissed?: boolean;
}

// ─── Path Helpers ───

function getSuggestionsPath(): string {
  let dataPath = Zotero.Prefs.get("dataDir") as string;
  if (!dataPath) {
    const storagePath = Zotero.getStorageDirectory().path;
    dataPath = storagePath.substring(0, storagePath.lastIndexOf("/"));
  }
  return `${dataPath}/llm-wiki/suggestions.json`;
}

// ─── Cache ───

function readCache(): Suggestion[] {
  const raw = readFile(getSuggestionsPath());
  if (!raw) return [];
  try { return JSON.parse(raw) as Suggestion[]; } catch { return []; }
}

function writeCache(suggestions: Suggestion[]): void {
  try {
    const dir = getSuggestionsPath().replace(/\/[^/]+$/, "");
    makeDir(dir);
    while (suggestions.length > 100) {
      const oldestDismissed = suggestions.findIndex(s => s.dismissed);
      if (oldestDismissed >= 0) {
        suggestions.splice(oldestDismissed, 1);
      } else {
        suggestions.pop();
      }
    }
    writeFile(getSuggestionsPath(), JSON.stringify(suggestions, null, 2));
  } catch (_) { /* non-blocking */ }
}

function makeId(type: string): string {
  return `${Date.now()}-${type}-${Math.random().toString(36).slice(2, 8)}`;
}

function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const getBigrams = (s: string): Set<string> => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const ba = getBigrams(a);
  const bb = getBigrams(b);
  let intersection = 0;
  ba.forEach(bg => { if (bb.has(bg)) intersection++; });
  const union = new Set([...ba, ...bb]).size;
  return union === 0 ? 0 : intersection / union;
}

function fileExists(path: string): boolean {
  try {
    // @ts-expect-error - Mozilla XPCOM
    const file = Components.classes["@mozilla.org/file/local;1"]
      .createInstance(Components.interfaces.nsIFile) as any;
    file.initWithPath(path);
    return file.exists();
  } catch { return false; }
}

// ─── Detector 1: Cross-Paper Patterns ───

function detectCrossPaperPatterns(): Suggestion[] {
  const results: Suggestion[] = [];
  const baseDir = getWikiBaseDir();
  const papersDir = `${baseDir}/papers`;
  const paperFiles = listDir(papersDir).filter(f => f.endsWith(".md"));
  if (paperFiles.length < 2) return results;

  const paperConcepts: Map<string, Set<string>> = new Map();
  const paperLinks: Map<string, Set<string>> = new Map();
  const paperTitles: Map<string, string> = new Map();

  for (const pf of paperFiles) {
    const slug = `papers/${pf.split("/").pop()!.replace(/\.md$/, "")}`;
    const page = readPage(slug);
    if (!page) continue;
    paperTitles.set(slug, page.frontmatter["title"] || slug);

    const conceptRefs = new Set<string>();
    const conceptMatches = page.body.matchAll(/\[\[(concepts|entities)\/([^\]|]+)/g);
    for (const m of conceptMatches) {
      conceptRefs.add(`${m[1]}/${m[2]}`);
    }
    paperConcepts.set(slug, conceptRefs);

    const paperRefs = new Set<string>();
    const paperMatches = page.body.matchAll(/\[\[(papers)\/([^\]|]+)/g);
    for (const m of paperMatches) {
      paperRefs.add(`papers/${m[2]}`);
    }
    paperLinks.set(slug, paperRefs);
  }

  const slugs = [...paperConcepts.keys()];
  for (let i = 0; i < slugs.length; i++) {
    for (let j = i + 1; j < slugs.length; j++) {
      const ci = paperConcepts.get(slugs[i])!;
      const cj = paperConcepts.get(slugs[j])!;
      const shared = [...ci].filter(c => cj.has(c));
      if (shared.length === 0) continue;

      const linksI = paperLinks.get(slugs[i])!;
      const linksJ = paperLinks.get(slugs[j])!;
      if (linksI.has(slugs[j]) || linksJ.has(slugs[i])) continue;

      const titleI = paperTitles.get(slugs[i]) || slugs[i];
      const titleJ = paperTitles.get(slugs[j]) || slugs[j];
      const conceptNames = shared.map(c => c.split("/").pop() || c).slice(0, 3).join(", ");

      results.push({
        id: makeId("cross_paper_pattern"),
        type: "cross_paper_pattern",
        severity: "warning",
        title: `Papers share "${conceptNames}" but aren't linked`,
        detail: `"${titleI}" and "${titleJ}" both reference ${conceptNames} but don't link to each other.`,
        related_pages: [slugs[i], slugs[j], ...shared.slice(0, 2)],
        action_label: "Create concept link",
        timestamp: new Date().toISOString(),
      });
    }
  }

  return results.slice(0, 20);
}

// ─── Detector 2: Knowledge Gaps ───

function detectKnowledgeGaps(): Suggestion[] {
  const results: Suggestion[] = [];
  const baseDir = getWikiBaseDir();
  const papersDir = `${baseDir}/papers`;
  const paperFiles = listDir(papersDir).filter(f => f.endsWith(".md"));

  const missingRefs: Map<string, { count: number; papers: string[] }> = new Map();

  for (const pf of paperFiles) {
    const slug = `papers/${pf.split("/").pop()!.replace(/\.md$/, "")}`;
    const page = readPage(slug);
    if (!page) continue;

    const refs = page.body.matchAll(/\[\[(concepts|entities)\/([^\]|]+)/g);
    for (const m of refs) {
      const dir = m[1];
      const conceptSlug = m[2];
      const fullPath = `${baseDir}/${dir}/${conceptSlug}.md`;
      const exists = fileExists(fullPath);
      if (!exists) {
        const key = `${dir}/${conceptSlug}`;
        const entry = missingRefs.get(key) || { count: 0, papers: [] };
        entry.count++;
        if (!entry.papers.includes(slug)) entry.papers.push(slug);
        missingRefs.set(key, entry);
      }
    }
  }

  for (const [key, entry] of missingRefs) {
    if (entry.papers.length < 2) continue;
    const conceptName = key.split("/").pop() || key;
    results.push({
      id: makeId("knowledge_gap"),
      type: "knowledge_gap",
      severity: "warning",
      title: `"${conceptName}" referenced by ${entry.count} papers but no page exists`,
      detail: `${entry.papers.map(p => p.split("/").pop()).join(", ")} reference this concept.`,
      related_pages: [key, ...entry.papers.slice(0, 3)],
      action_label: "Create concept page",
      timestamp: new Date().toISOString(),
    });
  }

  return results.slice(0, 20);
}

// ─── Detector 3: Missing Papers ───

function detectMissingPapers(): Suggestion[] {
  const results: Suggestion[] = [];
  const baseDir = getWikiBaseDir();
  const papersDir = `${baseDir}/papers`;
  const paperFiles = listDir(papersDir).filter(f => f.endsWith(".md"));

  const existingTitles = new Set<string>();
  for (const pf of paperFiles) {
    const slug = `papers/${pf.split("/").pop()!.replace(/\.md$/, "")}`;
    const page = readPage(slug);
    if (page) {
      existingTitles.add((page.frontmatter["title"] || "").toLowerCase().trim());
    }
  }

  for (const pf of paperFiles) {
    const slug = `papers/${pf.split("/").pop()!.replace(/\.md$/, "")}`;
    const page = readPage(slug);
    if (!page) continue;

    const body = page.body;
    const sections = body.split(/^##\s+/m);
    let refSection = "";
    for (const sec of sections) {
      if (/^(Related Work|References|See Also|参考文献|相关工作)/i.test(sec)) {
        refSection = sec.replace(/^Related Work\n?/i, "").replace(/^References\n?/i, "");
        break;
      }
    }
    if (!refSection) continue;

    const quoted = refSection.match(/["""]([^"""]{10,200})[""」]/g) || [];
    for (const q of quoted) {
      const title = q.replace(/["""「」]/g, "").trim();
      if (title.length < 10) continue;
      const titleLower = title.toLowerCase();
      if ([...existingTitles].some(t => similarity(t, titleLower) > 0.75)) continue;

      results.push({
        id: makeId("missing_paper"),
        type: "missing_paper",
        severity: "info",
        title: `"${title.slice(0, 80)}" cited but not ingested`,
        detail: `Referenced in ${page.frontmatter["title"] || slug}. Consider ingesting this paper.`,
        related_pages: [slug],
        action_label: "Ingest this paper",
        timestamp: new Date().toISOString(),
      });
    }
  }

  return results.slice(0, 20);
}

// ─── Public API ───

export function scanAll(): Suggestion[] {
  try {
    const existing = readCache();
    const kept = existing.filter(s => !s.dismissed);
    const ids = new Set(kept.map(s => s.id));

    const newSuggestions: Suggestion[] = [];
    const addUnique = (s: Suggestion) => {
      const similar = newSuggestions.some(e => similarity(e.title, s.title) > 0.7)
        || kept.some(e => similarity(e.title, s.title) > 0.7);
      if (!similar) newSuggestions.push(s);
    };

    detectCrossPaperPatterns().forEach(addUnique);
    detectKnowledgeGaps().forEach(addUnique);
    detectMissingPapers().forEach(addUnique);

    const merged = [...kept, ...newSuggestions.filter(s => !ids.has(s.id))];
    writeCache(merged);
    return merged.filter(s => !s.dismissed);
  } catch (_e) {
    return readCache().filter(s => !s.dismissed);
  }
}

export function scanDelta(_slugs: string[]): void {
  scanAll();
}

export function getSuggestions(): Suggestion[] {
  return readCache().filter(s => !s.dismissed);
}

export function dismissSuggestion(id: string): void {
  const suggestions = readCache();
  const idx = suggestions.findIndex(s => s.id === id);
  if (idx >= 0) {
    suggestions[idx].dismissed = true;
    writeCache(suggestions);
  }
}
