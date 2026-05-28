# Raw Layer + Agent Backtrack Design (Phase 3)

**Date**: 2026-05-18
**Status**: approved
**Dependencies**: Phase 1 (Wiki Browser), Phase 2 (Agent Panel)

## Overview

Add a "raw layer" (`llm-wiki/raw/`) storing original paper metadata and full text alongside the structured wiki. Give the Agent tools to search and read raw content, with automatic backtracking when wiki answers are insufficient, and the ability to enrich wiki pages with newly discovered knowledge.

---

## Architecture

```
llm-wiki/
├── wiki/                  # Structured knowledge (existing)
│   ├── index.md
│   ├── log.md
│   ├── papers/
│   ├── concepts/
│   └── entities/
└── raw/                   # Raw layer (new)
    ├── index.json          # Metadata index for fast search
    └── papers/
        └── <slug>.json    # {metadata, abstract, fulltext}

ingest flow (modified)
  Extract metadata → Extract PDF fulltext → Write raw JSON
                   → Call LLM → Write wiki page → Update index/log

Agent new tools
  search_raw(query)         — Fulltext search across raw layer
  read_raw(slug)            — Read complete raw paper data
  update_wiki_section(slug, section, content)
                            — Append to a specific wiki section

Agent backtracking logic
  search_wiki empty → auto search_raw
  Wiki insufficient  → proactively read_raw
  Raw has new info   → update_wiki_section
```

### New files

| File                          | Purpose                                       |
| ----------------------------- | --------------------------------------------- |
| `src/modules/rawStorage.ts`   | Raw JSON read/write/search + index management |
| `src/modules/pdfExtractor.ts` | PDF fulltext extraction via Zotero APIs       |

### Modified files

| File                         | Change                                                |
| ---------------------------- | ----------------------------------------------------- |
| `src/modules/ingest.ts`      | Add raw JSON write + PDF extraction step              |
| `src/modules/wikiStorage.ts` | Add `appendToSection()` for section-aware merge       |
| `src/modules/agentPanel.ts`  | Add 3 new tools + backtracking rules in system prompt |

---

## Raw Data Model

### `raw/papers/<slug>.json`

```json
{
  "title": "Paper Title",
  "authors": "Author One, Author Two",
  "abstract": "Full abstract text...",
  "year": "2024",
  "publication": "Journal Name",
  "doi": "10.xxx/xxx",
  "fulltext": "PDF extracted text (long string, null if no PDF available)",
  "wiki_slug": "papers/title-slug-hash",
  "ingested_at": "2026-05-18",
  "updated_at": "2026-05-18"
}
```

### `raw/index.json`

```json
[
  {
    "slug": "title-slug-hash",
    "title": "Paper Title",
    "authors": "...",
    "year": "2024",
    "wiki_slug": "papers/title-slug-hash"
  }
]
```

The index enables fast metadata filtering before reading individual JSON files during search.

---

## Ingest Changes

### Modified `runIngest` flow

1. Extract metadata (unchanged)
2. **NEW**: Extract PDF fulltext via `pdfExtractor.ts`
3. **NEW**: Write raw JSON to `raw/papers/<slug>.json`
4. **NEW**: Update `raw/index.json`
5. Call LLM to generate wiki page (unchanged)
6. Write wiki page, update index/log (unchanged)

### PDF Extraction (`pdfExtractor.ts`)

```
extractFulltext(item: Zotero.Item): string | null
  1. Get PDF attachments via Zotero.Items.getAttachments(itemID)
  2. Try Zotero.Fulltext.getTextFromCache(item) for pre-indexed text
  3. Cache miss: read PDF file via XPCOM, parse with pdfjs-dist
  4. Return extracted text or null (failure does NOT block ingest)
```

### `rawStorage.ts` API

```typescript
writeRaw(slug: string, data: RawPaper): void
readRaw(slug: string): RawPaper | null
searchRaw(query: string): SearchResult[]
updateRawIndex(slug: string, entry: RawIndexEntry): void
```

`searchRaw` searches across `fulltext` + `abstract` fields. Uses the index to pre-filter and avoid reading every JSON file for each query.

---

## Agent Changes

### New Tools

| Tool                  | Parameters               | Implementation                  |
| --------------------- | ------------------------ | ------------------------------- |
| `search_raw`          | `query: string`          | `rawStorage.searchRaw()`        |
| `read_raw`            | `slug: string`           | `rawStorage.readRaw()`          |
| `update_wiki_section` | `slug, section, content` | `wikiStorage.appendToSection()` |

### System Prompt Additions

```
## Raw Layer
Each wiki page has a corresponding raw file in raw/papers/ containing the original metadata, abstract, and full text (if available).

When answering:
- If search_wiki returns no results, automatically try search_raw
- If wiki page content seems incomplete or lacks detail, use read_raw to get the full original text
- When raw contains information not yet in the wiki, call update_wiki_section to enrich the wiki for future use

update_wiki_section takes: slug (e.g., "papers/title-hash"), section (one of: "Research Question", "Method", "Key Findings", "Conclusions", "Limitations", "Related Work"), and content (markdown string to append).
```

### Wiki Section Update

`wikiStorage.appendToSection(slug, section, content)`:

1. Read the wiki page file
2. Find the `## Section Name` heading
3. Find the next `## ` heading (or end of file)
4. Insert `content` before the next heading
5. If section not found, append `## Section Name\ncontent` at page end
6. Update frontmatter `updated` date

### Tool Calling Example

```
User: "What statistical method did this paper use?"
Agent:
  → search_wiki("paper title") → found, but Method section is sparse
  → read_raw("papers/slug")     → original abstract + fulltext has details
  → Answer user with method details from raw
  → update_wiki_section("papers/slug", "Method",
       "- Additional detail: used mixed-effects model with ...")
  → "I've also updated the wiki with the method details I found."
```

---

## Implementation Constraints

- Same Zotero 9 / Firefox ESR 115 sandbox constraints as Phase 1 and 2
- All file I/O via XPCOM (already in xpcom.ts)
- `Components` global for PDF parsing via XPCOM
- DOM APIs only for any UI additions (no UI changes expected)
- `raw/index.json` must handle concurrent access (single-writer by design: only ingest writes)
