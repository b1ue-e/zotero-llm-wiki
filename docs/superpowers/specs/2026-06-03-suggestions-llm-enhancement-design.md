# Suggestions — LLM Enhancement Design Spec

> 2026-06-03 | P2

## Goal

Upgrade the existing rule-based suggestion engine with LLM-powered semantic analysis: semantic concept matching and method-level overlap detection, surfaced alongside rule engine results via a "Deep Scan" button.

## Architecture

New module `src/modules/suggestionEngineLLM.ts` — two LLM-based detectors that return the same `Suggestion[]` format as the rule engine. Results are merged and deduplicated (bigram similarity > 0.7 on title).

```
suggestionEngine.ts (unchanged)    suggestionEngineLLM.ts (new)
────────────                       ──────────────────────────
detectCrossPaperPatterns()         detectSemanticPatterns()
detectKnowledgeGaps()              detectMethodOverlaps()
detectMissingPapers()              → both return Suggestion[]

wikiBrowser.ts
─────────────
[Scan All] → rule engine only → display
[Deep Scan] → rule engine + LLM → dedup merge → display
```

## Components

### 1. detectSemanticPatterns

- Collects all concept + entity names from the wiki
- Sends to LLM with a grouping prompt
- LLM returns clusters of semantically related slugs
- For each cluster, checks which papers reference each concept
- If papers referencing different slugs in the same cluster don't interlink → generates `cross_paper_pattern` suggestion with `severity: "info"` and LLM-generated `detail`

**LLM Prompt:**

```
You are analyzing a knowledge base. Group the following concept/entity names into
semantically related clusters. Only group names that clearly refer to the same
or related concepts (synonyms, sub-types, variants of the same idea).

Names:
[name list]

Return ONLY a JSON array of arrays. Example:
[["single-cell-genomics","single-cell-transcriptomics"],["perturb-seq","single-cell-functional-genomics"]]
```

### 2. detectMethodOverlaps

- Reads `## Method` sections (truncated to 1500 chars each) from all papers
- Sends to LLM with paper titles, method text, and existing concept references
- LLM returns shared methods not captured by wikilinks
- Generates `cross_paper_pattern` suggestions with `action_label: "Create concept page"`

**LLM Prompt:**

```
Given papers and their methods, find shared techniques/algorithms/approaches
that are NOT covered by the concept references listed. Ignore generic methods
(statistical tests, basic data processing).

Papers:
[title]: Method: [method text]. Concepts: [concept refs]

Return ONLY a JSON array: [{"papers":["slug-A","slug-B"],"shared_method":"name","detail":"why they overlap"}]
```

### 3. Merging & Dedup

- Rule engine results are preserved as-is
- LLM results use `severity: "info"` (distinguished from rule engine's `"warning"`)
- Dedup: any LLM suggestion whose title has bigram similarity > 0.7 to an existing suggestion is skipped

## UI

### Deep Scan Button

Added to the Suggestions header action row, next to Scan All:

```
[Scan All]  [Deep Scan]  No issues found
```

- `Deep Scan` uses secondary button style (outline/border, not filled)
- Click triggers both rule engine + LLM detectors
- Button text changes to "Scanning..." during execution (same feedback as Scan All)
- LLM errors are non-blocking — rule engine results still display

## API

```typescript
// suggestionEngineLLM.ts
export function detectSemanticPatterns(): Promise<Suggestion[]>;
export function detectMethodOverlaps(): Promise<Suggestion[]>;
```

Both call `callLLM()` from `llmProvider.ts`, catch errors silently (return `[]`).

## File Changes

| File | Action | Purpose |
|------|--------|---------|
| `src/modules/suggestionEngineLLM.ts` | Create | Two LLM-based detectors |
| `src/modules/suggestionEngine.ts` | Modify | Export `Suggestion` type for reuse |
| `src/modules/wikiBrowser.ts` | Modify | Deep Scan button, merge logic |

## Non-goals

- No real-time/streaming LLM calls
- No caching of LLM results (re-run each Deep Scan)
- No contradiction detection, quality scoring (Phase 2)
