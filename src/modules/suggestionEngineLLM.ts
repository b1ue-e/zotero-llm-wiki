import { callLLM } from "./llmProvider";
import { getWikiBaseDir, readFile, listDir } from "../utils/xpcom";
import { parseFrontmatter, type ParsedPage } from "./wikiReader";
import type { Suggestion } from "./suggestionEngine";

function readPaperPage(relPath: string): ParsedPage | null {
  const path = relPath.endsWith(".md") ? relPath : `${relPath}.md`;
  const fullPath = `${getWikiBaseDir()}/${path}`;
  const raw = readFile(fullPath);
  if (!raw) return null;
  const { frontmatter, body } = parseFrontmatter(raw);
  return { frontmatter, body, filePath: relPath };
}

// ─── Helpers ───

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

// ─── Detector 1: Semantic Concept Matching ───

const SEMANTIC_GROUPING_PROMPT = `You are analyzing a knowledge base. Group the following concept/entity names into semantically related clusters. Only group names that clearly refer to the same or closely related concepts (synonyms, sub-types, variants of the same idea, or closely related techniques).

Rules:
- Do NOT force clusters — if a name stands alone, don't group it
- A cluster should contain 2-4 names
- Focus on conceptual overlap, not just string similarity

Return ONLY a JSON array of arrays. Example: [["single-cell-genomics","single-cell-transcriptomics"],["perturb-seq","single-cell-functional-genomics"]]`;

export async function detectSemanticPatterns(): Promise<Suggestion[]> {
  try {
    const baseDir = getWikiBaseDir();
    const results: Suggestion[] = [];

    const conceptMap: Map<string, Set<string>> = new Map();
    const conceptNames: string[] = [];

    for (const dir of ["concepts", "entities"]) {
      const catDir = `${baseDir}/${dir}`;
      const files = listDir(catDir).filter(f => f.endsWith(".md"));
      for (const pf of files) {
        const name = pf.split("/").pop()!.replace(/\.md$/, "");
        conceptNames.push(name);
        conceptMap.set(`${dir}/${name}`, new Set());
      }
    }

    if (conceptNames.length < 2) return [];

    const papersDir = `${baseDir}/papers`;
    const paperFiles = listDir(papersDir).filter(f => f.endsWith(".md"));
    const paperLinks: Map<string, Set<string>> = new Map();
    const paperTitles: Map<string, string> = new Map();

    for (const pf of paperFiles) {
      const slug = `papers/${pf.split("/").pop()!.replace(/\.md$/, "")}`;
      const page = readPaperPage(slug);
      if (!page) continue;
      paperTitles.set(slug, page.frontmatter["title"] || slug);

      for (const m of page.body.matchAll(/\[\[(concepts|entities)\/([^\]|]+)/g)) {
        const fullSlug = `${m[1]}/${m[2]}`;
        const entry = conceptMap.get(fullSlug);
        if (entry) entry.add(slug);
      }

      const links = new Set<string>();
      for (const m of page.body.matchAll(/\[\[(papers)\/([^\]|]+)/g)) {
        links.add(`papers/${m[2]}`);
      }
      paperLinks.set(slug, links);
    }

    Zotero.debug(`[llmwiki] suggestionEngineLLM: calling LLM for semantic grouping (${conceptNames.length} concepts)`);
    const userPrompt = `Names:\n${conceptNames.map(n => `- ${n}`).join("\n")}\n\nGroup them:`;
    const response = await callLLM([
      { role: "system", content: SEMANTIC_GROUPING_PROMPT },
      { role: "user", content: userPrompt },
    ]);

    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    const clusters: string[][] = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(clusters)) return [];

    for (const cluster of clusters) {
      if (!Array.isArray(cluster) || cluster.length < 2) continue;
      const clusterSlugs = cluster.map(n => {
        return conceptMap.has(`concepts/${n}`) ? `concepts/${n}`
          : conceptMap.has(`entities/${n}`) ? `entities/${n}` : null;
      }).filter(Boolean) as string[];

      if (clusterSlugs.length < 2) continue;

      const clusterPapers = new Set<string>();
      for (const cs of clusterSlugs) {
        const papers = conceptMap.get(cs);
        if (papers) papers.forEach(p => clusterPapers.add(p));
      }

      const paperList = [...clusterPapers];
      if (paperList.length < 2) continue;

      for (let i = 0; i < paperList.length; i++) {
        for (let j = i + 1; j < paperList.length; j++) {
          const pi = paperList[i];
          const pj = paperList[j];
          const linksI = paperLinks.get(pi);
          const linksJ = paperLinks.get(pj);
          if (linksI?.has(pj) || linksJ?.has(pi)) continue;

          results.push({
            id: makeId("llm_semantic"),
            type: "cross_paper_pattern",
            severity: "info",
            title: `Semantic overlap: "${cluster.join('", "')}"`,
            detail: `LLM detected that "${paperTitles.get(pi) || pi}" and "${paperTitles.get(pj) || pj}" use related concepts (${cluster.join(", ")}) but aren't linked.`,
            related_pages: [pi, pj, ...clusterSlugs.slice(0, 2)],
            action_label: "Create concept link",
            timestamp: new Date().toISOString(),
          });
        }
      }
    }

    Zotero.debug(`[llmwiki] suggestionEngineLLM: semantic patterns found ${results.length} suggestions`);
    return results.slice(0, 20);
  } catch (e: any) {
    Zotero.debug(`[llmwiki] suggestionEngineLLM: semantic patterns failed: ${e.message}`);
    return [];
  }
}

// ─── Detector 2: Method Overlap Detection ───

const METHOD_OVERLAP_PROMPT = `You are analyzing research papers. Given the following papers with their methods and existing concept references, find shared techniques, algorithms, experimental designs, or analytical approaches that are NOT covered by the listed concept references.

Ignore generic or universal methods (basic statistics, standard data processing, common lab techniques).

Return ONLY a JSON array. Each entry: {"papers":["slug-A","slug-B"],"shared_method":"name of shared method/approach","detail":"one sentence explaining why they overlap"}`;

export async function detectMethodOverlaps(): Promise<Suggestion[]> {
  try {
    const baseDir = getWikiBaseDir();
    const results: Suggestion[] = [];
    const papersDir = `${baseDir}/papers`;
    const paperFiles = listDir(papersDir).filter(f => f.endsWith(".md"));
    Zotero.debug(`[llmwiki] suggestionEngineLLM: method overlap scanning ${paperFiles.length} paper files`);
    if (paperFiles.length < 2) return [];

    interface PaperMethod {
      slug: string;
      title: string;
      method: string;
      concepts: string[];
    }
    const paperMethods: PaperMethod[] = [];

    for (const pf of paperFiles) {
      const slug = `papers/${pf.split("/").pop()!.replace(/\.md$/, "")}`;
      const page = readPaperPage(slug);
      if (!page) { Zotero.debug(`[llmwiki] suggestionEngineLLM: readPage failed for ${slug}`); continue; }

      const sections = page.body.split(/^##\s+/m);
      let methodText = "";
      for (const sec of sections) {
        if (/^Method|^方法/i.test(sec)) {
          methodText = sec.replace(/^Method\n?/i, "").replace(/^方法\n?/, "").slice(0, 1500).trim();
          break;
        }
      }
      if (!methodText) { Zotero.debug(`[llmwiki] suggestionEngineLLM: no method text for ${slug} (bodyLen=${page.body.length}, sections=${sections.length})`); continue; }

      const concepts: string[] = [];
      for (const m of page.body.matchAll(/\[\[(concepts|entities)\/([^\]|]+)/g)) {
        concepts.push(m[2]);
      }

      paperMethods.push({
        slug,
        title: page.frontmatter["title"] || slug,
        method: methodText,
        concepts: [...new Set(concepts)].slice(0, 10),
      });
    }

    Zotero.debug(`[llmwiki] suggestionEngineLLM: method overlap found ${paperMethods.length} papers with method sections`);
    if (paperMethods.length < 2) return [];

    const papersText = paperMethods.map(p =>
      `**${p.title}** (${p.slug}): Method: ${p.method}\nConcepts: ${p.concepts.join(", ") || "none"}`
    ).join("\n\n");

    Zotero.debug(`[llmwiki] suggestionEngineLLM: calling LLM for method overlap (${paperMethods.length} papers)`);
    const response = await callLLM([
      { role: "system", content: METHOD_OVERLAP_PROMPT },
      { role: "user", content: `Papers:\n\n${papersText}\n\nFind method overlaps:` },
    ]);

    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    const overlaps: { papers: string[]; shared_method: string; detail: string }[] = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(overlaps)) return [];

    for (const ov of overlaps) {
      if (!ov.papers || ov.papers.length < 2) continue;
      const slugMap = new Map<string, string>();
      for (const pm of paperMethods) {
        for (const sp of ov.papers) {
          if (pm.slug.includes(sp) || sp.includes(pm.slug)) {
            slugMap.set(sp, pm.slug);
          }
        }
      }
      const matchedSlugs = ov.papers.map((sp: string) => slugMap.get(sp) || sp).slice(0, 4);

      results.push({
        id: makeId("llm_method"),
        type: "cross_paper_pattern",
        severity: "info",
        title: `Shared method: "${ov.shared_method}"`,
        detail: ov.detail || `${ov.papers.length} papers share the method "${ov.shared_method}" but aren't linked.`,
        related_pages: matchedSlugs,
        action_label: "Create concept page",
        timestamp: new Date().toISOString(),
      });
    }

    Zotero.debug(`[llmwiki] suggestionEngineLLM: method overlaps found ${results.length} suggestions`);
    return results.slice(0, 20);
  } catch (e: any) {
    Zotero.debug(`[llmwiki] suggestionEngineLLM: method overlaps failed: ${e.message}`);
    return [];
  }
}
