import { callLLM } from "./llmProvider";
import {
  makeDir,
  writeFile,
  readFile,
  writeBinaryFile,
  readBinaryFile,
} from "../utils/xpcom";

// ─── Types ───

interface ResearchStep {
  type: "search" | "read";
  details: string;
}

export interface ResearchTrace {
  initial_query: string;
  steps: ResearchStep[];
}

interface ResearchIndexEntry {
  slug: string;
  title: string;
  created: string;
  status: string;
  tags: string[];
}

export interface SessionSaveData {
  title: string;
  query: string;
  report: string;
  meta_analysis: string;
  trace: ResearchTrace;
  papers_referenced: string[];
  concepts_referenced: string[];
  tags: string[];
}

// ─── Path Helpers ───

function getResearchDir(): string {
  let dataPath = Zotero.Prefs.get("dataDir") as string;
  if (!dataPath) {
    const storagePath = Zotero.getStorageDirectory().path;
    dataPath = storagePath.substring(0, storagePath.lastIndexOf("/"));
  }
  return `${dataPath}/llm-wiki/research-sessions`;
}

function ensureResearchDirs(): void {
  makeDir(getResearchDir());
}

// ─── Index Management ───

function readIndex(): ResearchIndexEntry[] {
  const path = `${getResearchDir()}/index.json`;
  const content = readBinaryFile(path);
  if (!content) return [];
  try {
    return JSON.parse(content) as ResearchIndexEntry[];
  } catch {
    return [];
  }
}

function writeIndex(entries: ResearchIndexEntry[]): void {
  ensureResearchDirs();
  writeBinaryFile(
    `${getResearchDir()}/index.json`,
    JSON.stringify(entries, null, 2),
  );
}

// ─── Session CRUD ───

export function saveSession(data: SessionSaveData): string {
  ensureResearchDirs();

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const slug =
    dateStr +
    "-" +
    data.title
      .replace(/[/\\:*?"<>|]/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/[^\x00-\x7F]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase()
      .slice(0, 60);

  const papersJson = JSON.stringify(data.papers_referenced);
  const conceptsJson = JSON.stringify(data.concepts_referenced);
  const tagsJson = JSON.stringify(data.tags);

  const content = [
    "---",
    `title: "${escapeYaml(data.title)}"`,
    `created: ${dateStr}`,
    `updated: ${dateStr}`,
    `status: complete`,
    `papers_referenced: ${papersJson}`,
    `concepts_referenced: ${conceptsJson}`,
    `tags: ${tagsJson}`,
    "---",
    "",
    data.report,
    "",
    "# Meta-Analysis",
    "",
    data.meta_analysis,
  ].join("\n");

  const filePath = `${getResearchDir()}/${slug}.md`;
  writeFile(filePath, content);

  const entries = readIndex();
  entries.unshift({
    slug,
    title: data.title,
    created: dateStr,
    status: "complete",
    tags: data.tags,
  });
  writeIndex(entries);

  return slug;
}

export function loadSession(slug: string): {
  frontmatter: Record<string, string>;
  report: string;
  meta_analysis: string;
} | null {
  const path = `${getResearchDir()}/${slug}.md`;
  const raw = readFile(path);
  if (!raw) return null;

  const fmEnd = raw.indexOf("---", 3);
  if (fmEnd === -1) return null;

  const fmBlock = raw.slice(3, fmEnd);
  const body = raw.slice(fmEnd + 3).trimStart();

  const frontmatter: Record<string, string> = {};
  for (const line of fmBlock.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) frontmatter[key] = value;
  }

  const metaIdx = body.indexOf("\n# Meta-Analysis\n");
  const report = metaIdx >= 0 ? body.slice(0, metaIdx).trim() : body.trim();
  const meta_analysis =
    metaIdx >= 0
      ? body
          .slice(metaIdx + 1)
          .replace(/^# Meta-Analysis\n?/, "")
          .trim()
      : "";

  return { frontmatter, report, meta_analysis };
}

export function searchSessions(
  query: string,
): { slug: string; title: string; snippet: string; created: string }[] {
  const q = query.toLowerCase();
  const queryWords = q.split(/\s+/).filter((w) => w.length > 1);
  const entries = readIndex();
  const results: {
    slug: string;
    title: string;
    snippet: string;
    created: string;
  }[] = [];

  for (const entry of entries) {
    const titleLower = entry.title.toLowerCase();
    const tagsLower = entry.tags.join(" ").toLowerCase();
    if (
      !queryWords.some((w) => titleLower.includes(w) || tagsLower.includes(w))
    )
      continue;

    const session = loadSession(entry.slug);
    const snippet = session
      ? session.report.replace(/\n/g, " ").slice(0, 200) + "..."
      : entry.title;

    results.push({
      slug: entry.slug,
      title: entry.title,
      snippet,
      created: entry.created,
    });
  }

  return results;
}

export function listSessions(): {
  slug: string;
  title: string;
  created: string;
  status: string;
}[] {
  return readIndex().map((e) => ({
    slug: e.slug,
    title: e.title,
    created: e.created,
    status: e.status,
  }));
}

// ─── Meta-Analysis Generation ───

const META_SYSTEM_PROMPT = `You are analyzing a research process to extract reusable methodological insights.

Given a research report and the trace of steps taken (searches, pages read, decisions made), produce a meta-analysis in the following format:

## Search Strategy
What search approach worked? What queries were most effective? What was the overall search strategy? (2-3 paragraphs)

## Cross-Paper Insights
What hidden connections or patterns were discovered across papers? For example: similar methods used independently, contradictory findings, shared datasets or benchmarks, converging conclusions from different approaches. (2-3 paragraphs)

## Knowledge Gaps
What was NOT found? What areas of the wiki are under-covered? What topics or papers need more ingestion? What research questions remain open? (1-2 paragraphs)

Be specific — reference actual paper names and concepts. Focus on REUSABLE insights for future research sessions.`;

export async function generateMetaAnalysis(
  report: string,
  trace: ResearchTrace,
): Promise<string> {
  const stepsText = trace.steps
    .map((s) => `- [${s.type}] ${s.details}`)
    .join("\n");
  const userPrompt = [
    "# Research Report",
    report,
    "",
    "# Research Trace",
    `Initial Query: ${trace.initial_query}`,
    stepsText || "(no steps recorded)",
    "",
    "Generate the meta-analysis.",
  ].join("\n");

  const response = await callLLM([
    { role: "system", content: META_SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ]);
  return response;
}

function escapeYaml(s: string): string {
  return s.replace(/"/g, '\\"').replace(/\n/g, " ");
}
