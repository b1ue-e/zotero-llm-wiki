import { callLLM } from "./llmProvider";

// ─── Types ───

export interface ConceptExtraction {
  name: string;
  englishSlug: string;
  type: "concept" | "entity";
  definition: string;
  relevance: string;
}

// ─── Prompts ───

function buildExtractionPrompt(): string {
  return `You are a knowledge extraction specialist. Given a paper's wiki summary, identify key concepts and named entities.

## Definitions
- A "concept" is an abstract method, theory, framework, or technique (e.g., "Self-Attention Mechanism", "Bayesian Inference", "Contrastive Learning").
- An "entity" is a concrete named thing (e.g., "ImageNet", "GPT-4", "AlphaFold", "TCGA").

## Output Format
Respond with ONLY a JSON array (no markdown fences, no extra text). Each entry:

{
  "name": "Original name of the concept/entity",
  "englishSlug": "filesystem-safe-english-slug",
  "type": "concept" | "entity",
  "definition": "2-3 sentence precise definition",
  "relevance": "How this paper uses or relates to this concept/entity (1 sentence)"
}

## Rules
- Maximum 3 concepts + 3 entities total (6 max)
- Only include items significant enough to warrant their own wiki page
- If no significant concepts/entities are found, output: []
- englishSlug: lowercase, hyphen-separated, no special characters, max 50 chars`;
}

function buildExtractionUserPrompt(title: string, wikiContent: string, abstract: string): string {
  return [
    `# Paper Title\n${title}`,
    `# Abstract\n${abstract || "(not available)"}`,
    `# Wiki Summary\n${wikiContent}`,
    "\nExtract key concepts and named entities from this paper as a JSON array.",
  ].join("\n\n");
}

// ─── JSON Parser ───

function parseConceptResponse(response: string): ConceptExtraction[] {
  // Try direct parse first
  let cleaned = response.trim();
  try {
    const result = JSON.parse(cleaned);
    if (Array.isArray(result)) return validateExtractions(result);
  } catch {
    // continue to extraction methods
  }

  // Try extracting from ```json fences
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      const result = JSON.parse(fenceMatch[1].trim());
      if (Array.isArray(result)) return validateExtractions(result);
    } catch {
      // continue
    }
  }

  // Try finding JSON array in the text
  const arrayMatch = cleaned.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (arrayMatch) {
    try {
      const result = JSON.parse(arrayMatch[0]);
      if (Array.isArray(result)) return validateExtractions(result);
    } catch {
      // give up
    }
  }

  Zotero.debug(`[llmwiki] conceptExtractor: failed to parse JSON from: ${cleaned.slice(0, 200)}`);
  return [];
}

function validateExtractions(items: any[]): ConceptExtraction[] {
  const result: ConceptExtraction[] = [];
  let conceptCount = 0;
  let entityCount = 0;

  for (const item of items) {
    if (!item.name || !item.englishSlug || !item.type || !item.definition) continue;
    if (item.type !== "concept" && item.type !== "entity") continue;
    if (item.type === "concept" && conceptCount >= 3) continue;
    if (item.type === "entity" && entityCount >= 3) continue;

    // Sanitize englishSlug: lowercase, replace spaces/specials with hyphens, trim to 50
    const slug = item.englishSlug
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 50);

    if (item.type === "concept") conceptCount++;
    if (item.type === "entity") entityCount++;

    result.push({
      name: String(item.name).trim(),
      englishSlug: slug,
      type: item.type,
      definition: String(item.definition).trim(),
      relevance: String(item.relevance || "").trim(),
    });
  }

  return result;
}

// ─── Main Export ───

export async function extractConcepts(
  title: string,
  wikiContent: string,
  abstract: string,
): Promise<ConceptExtraction[]> {
  const systemPrompt = buildExtractionPrompt();
  const userPrompt = buildExtractionUserPrompt(title, wikiContent, abstract);

  Zotero.debug("[llmwiki] extracting concepts/entities via LLM...");
  const response = await callLLM([
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ]);
  Zotero.debug(`[llmwiki] concept extraction response: ${response.slice(0, 300)}`);

  const concepts = parseConceptResponse(response);
  Zotero.debug(`[llmwiki] extracted ${concepts.length} concepts/entities`);
  return concepts;
}
