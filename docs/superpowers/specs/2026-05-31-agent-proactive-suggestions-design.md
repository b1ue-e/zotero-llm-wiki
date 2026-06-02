# Agent Proactive Suggestions — Design Spec

> 2026-05-31 | P1

## Goal

Automatically detect cross-paper patterns, knowledge gaps, and missing papers within the local wiki knowledge base, and surface actionable suggestions in the Wiki Browser UI.

## Architecture

New module `src/modules/suggestionEngine.ts` — a pure rule engine that scans wiki pages for patterns and produces a cached suggestion list. Wiki Browser adds a collapsible Suggestions bar at the top. Ingest flow triggers incremental re-scan.

```
wikiBrowser.ts          suggestionEngine.ts         ingest.ts
────────────            ──────────────────          ─────────
[Scan All] ──────────→  scanAll() ──→ suggestions.json
                        scanDelta(slugs) ←──────── ingest完成后
[Suggestions bar] ←───  getSuggestions() ←── cache
[Dismiss] ───────────→  dismiss(id) ──→ suggestions.json
```

## Data Model

```typescript
interface Suggestion {
  id: string;              // "{timestamp}-{type}-{hash}"
  type: "cross_paper_pattern" | "knowledge_gap" | "missing_paper";
  severity: "info" | "warning";
  title: string;           // 一行摘要
  detail: string;          // 详细描述
  related_pages: string[]; // 涉及的 wiki 页面 slug (用于跳转)
  action_label: string;    // 按钮文字 ("Create concept page" / "Ingest this paper" / "Link papers")
  timestamp: string;
  dismissed?: boolean;
}
```

Cache file: `{dataDir}/llm-wiki/suggestions.json` — JSON array, max 100 items, oldest dismissed purged first.

## Detection Logic

### 1. cross_paper_pattern

Scan all paper pages. For each paper, extract:
- **Methods**: body text under `## Method` section, matching known method keywords (e.g., "Self-Attention", "CRISPR", "Bayesian", "Transformer", "Contrastive Learning")
- **Datasets**: body text matching `[A-Z]+[-0-9]{2,}` pattern (uppercase abbreviation datasets)
- **Concept references**: `[[concepts/...]]` and `[[entities/...]]` wikilinks

Trigger: ≥ 2 papers share the same method/dataset/concept value, but **none of them** link to each other via `[[wikilinks]]`. Generate suggestion to create a concept page linking them.

### 2. knowledge_gap

Scan all pages for `[[wikilinks]]` targeting non-existent pages:
- Parse `[[concepts/some-slug]]` and `[[entities/some-slug]]` from all paper bodies
- Check if `wiki/concepts/some-slug.md` or `wiki/entities/some-slug.md` exists on disk
- Track reference count per missing slug

Trigger: A slug is referenced by ≥ 2 papers but doesn't exist. Generate suggestion to create the concept/entity page.

### 3. missing_paper

Scan all paper pages' `## Related Work` and `## References` sections. Extract:
- Quoted paper titles: `"Paper Title Here"`
- Italicized titles: `*Paper Title Here*`
- Markdown links: `[Title](url)`

For each extracted title, check:
- Does it exist in `wiki/papers/` (by title match > 80% similarity)?
- Does it exist in `raw/papers/` (check `raw/index.json`)?

Trigger: Title mentioned in ≥ 1 paper, not found in wiki, may be in raw. Generate suggestion to ingest.

## Wiki Browser UI

Collapsible bar at top of file tree:

```
┌──────────────────────────────────────┐
│ 🔍 Suggestions  [Scan All]  [3]  [─] │  ← 可折叠顶栏
├──────────────────────────────────────┤
│ ⚠️ 3 papers share "Self-Attention"   │
│    but aren't linked                  │
│    [Create concept]  [✕]              │
│                                      │
│ ⚠️ "Contrastive Learning" referenced  │
│    by 2 papers, no concept page       │
│    [Create concept]  [✕]              │
│                                      │
│ ℹ️ "Attention Is All You Need"        │
│    cited but not ingested             │
│    [Ingest]  [✕]                      │
├──────────────────────────────────────┤
│  PAPERS / CONCEPTS / ENTITIES         │  ← 现有文件树
└──────────────────────────────────────┘
```

- `[Scan All]` triggers `suggestionEngine.scanAll()`
- `[3]` shows total pending (undismissed) count
- `[─]` toggles collapse
- Each item has an action button + dismiss button
- Dismiss writes to `suggestions.json` and hides the item immediately
- Clicking related page names navigates to that page

## Integration: Ingest Trigger

In `ingest.ts`, after `writeWikiPage()` and concept extraction complete, call:

```typescript
suggestionEngine.scanDelta([newPaperSlug, ...relatedConceptSlugs]);
```

This does a targeted re-scan: only checks the new paper's patterns against existing papers, and re-checks knowledge gaps that the new paper might fill.

## File Changes

| File | Action | Purpose |
|------|--------|---------|
| `src/modules/suggestionEngine.ts` | Create | Rule engine, scan logic, cache management |
| `src/modules/wikiBrowser.ts` | Modify | Suggestions bar UI, Scan/Dismiss handlers |
| `src/modules/ingest.ts` | Modify | Auto-trigger `scanDelta()` after ingest |

## Non-goals

- No LLM involvement (pure rules, MVP)
- No external API calls (no DOI lookup)
- No periodic/background scan (only on-click and post-ingest)
- No Suggestions panel outside Wiki Browser
