# Concept/Entity Auto-Generation — Design Spec

> 2026-05-18 | Approved | Implements STATUS.md "Concept/Entity Auto-Generation"

## Summary

During ingest, after a paper wiki page is generated, run a second LLM call to extract key concepts and named entities. Auto-create `concepts/{slug}.md` and `entities/{slug}.md` pages with bidirectional backlinks to the source paper. Supports dedup merging when concepts are referenced by multiple papers.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Trigger | Auto after ingest, with pref toggle | Default-on for seamless experience; toggle for cost control |
| Extraction method | Separate second LLM call | Separation of concerns; each prompt stays focused |
| Concept vs entity template | Unified structure | Simpler code, fewer edge cases |
| Dedup merging | LLM reads existing + new info, merges | LLM handles semantic merging better than code |
| Slug generation | LLM provides English slug | Avoids Chinese→hash problem; readable filenames |
| Backlinks | Bidirectional auto-update | True knowledge graph; concept pages link papers, papers link concepts |
| Extraction limit | 3 concepts + 3 entities max | Keeps LLM output focused and manageable |
| Definition improvement on merge | Allowed | Accumulating papers should enrich shared concepts |
| Failure handling | try-catch log warning, don't block ingest | Concept extraction is additive, not critical path |

## Architecture

### New File

**`src/modules/conceptExtractor.ts`** — LLM-based concept/entity extraction from wiki page content.

Exports:
- `extractConcepts(title: string, wikiContent: string, abstract: string): Promise<ConceptExtraction[]>`

Types:
```ts
interface ConceptExtraction {
  name: string;        // concept or entity name (original language)
  englishSlug: string; // filesystem-safe English slug for URL/filename
  type: "concept" | "entity";
  definition: string;  // 2-3 sentence definition
  relevance: string;   // how this paper relates to the concept (1 sentence)
}
```

System prompt instructs LLM to output a JSON array. Returns empty array if no notable concepts found.

### Modified Files

**`src/modules/wikiStorage.ts`** — Two new exports:

- `writeConceptPage(concept: ConceptExtraction, paperSlug: string, paperTitle: string): Promise<void>`
  - Slug = `concept.englishSlug` → write to `{type}s/{slug}.md`
  - New page: use unified template (Definition → Related Papers → See Also)
  - Existing page: read current content, call LLM to merge (add paper to Related Papers, optionally improve Definition), write back
  - Update `index.md` with `## Concepts` / `## Entities` sections

- `appendSeeAlsoToPaper(paperSlug: string, conceptSlug: string, conceptName: string, conceptType: "concept" | "entity"): void`
  - Read paper, find `## See Also`, append `[[concepts/slug|Name]]` if not present
  - Update `updated` date

**`src/modules/ingest.ts`** — After `writeWikiPage()` succeeds:

```ts
if (getPref("autoExtractConcepts") !== false) {
  try {
    const concepts = await extractConcepts(title, wikiContent, metadata.abstract);
    for (const c of concepts) {
      await writeConceptPage(c, slug, title);
      await appendSeeAlsoToPaper(slug, c.englishSlug, c.name, c.type);
    }
  } catch (e) {
    Zotero.debug(`[llmwiki] concept extraction failed: ${e.message}`);
  }
}
```

**`addon/prefs.js`** + **`src/modules/preferenceScript.ts`** — New pref:
- Key: `extensions.zotero.llmwiki.autoExtractConcepts`
- Default: `true`

## Concept/Entity Page Template

```markdown
---
title: "Attention Mechanism"
type: concept
slug: attention-mechanism
created: 2026-05-18
updated: 2026-05-18
tags: [machine-learning]
---

## Definition
A mechanism in neural networks that allows the model to dynamically
weight different parts of the input when producing output...

## Related Papers
- [[papers/vision-transformer|Vision Transformer]] — Applies self-attention to image patches for classification
- [[papers/bert|BERT]] — Uses bidirectional self-attention for language understanding

## See Also
- [[concepts/transformer-architecture|Transformer Architecture]]
- [[entities/gpt-4|GPT-4]]
```

## LLM Merge Prompt (Dedup)

When `concepts/{slug}.md` already exists, a second LLM call merges:

System prompt:
```
You are merging new paper information into an existing concept page.
Given the EXISTING page content and NEW paper info, produce the merged page.

Rules:
- Add the new paper to ## Related Papers (with relevance description)
- If the new paper provides richer understanding, improve ## Definition
- Preserve existing ## See Also links
- Keep the same YAML frontmatter, only update `updated` date
```

## index.md Extensions

Current `index.md` only has `## Papers`. Add `## Concepts` and `## Entities` sections:

```markdown
## Concepts
- [[concepts/attention-mechanism|Attention Mechanism]] | 2 papers
- [[concepts/bayesian-inference|Bayesian Inference]] | 1 paper

## Entities
- [[entities/imagenet|ImageNet]] | 3 papers
- [[entities/alphafold|AlphaFold]] | 1 paper
```

## Error Handling

- Concept extraction LLM call fails → catch, log warning, ingest continues normally
- Single concept write fails → catch per-concept, log, continue to next concept
- Merge LLM call fails → fall back to simple append (add paper line to Related Papers without LLM)
- No concepts found (empty array) → skip silently
