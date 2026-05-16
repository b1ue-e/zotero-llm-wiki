# Zotero LLM-Wiki Plugin — Design Spec

## Overview

A Zotero 9 plugin that brings Karpathy's LLM-Wiki pattern into Zotero. When a user adds a paper to Zotero, an LLM compiles a structured wiki entry, enables cross-referenced knowledge querying, and performs periodic linting for consistency. Users configure their own LLM API.

**Core metaphor:** Zotero is the raw source (`raw/`), the plugin compiles wiki pages (`wiki/`), and a configurable schema defines the structure. Ingestion compiles once; queries read the compiled knowledge; linting keeps it healthy.

## Architecture

Hybrid engine: Zotero plugin as UI + control layer, wiki data stored as independent Markdown files + SQLite index under the Zotero data directory, with an optional in-process embedding service.

```
┌─────────────────────────────────────────────────────┐
│                   Zotero UI Layer                     │
│  ┌──────────┐  ┌───────────┐  ┌──────────────────┐  │
│  │ Context   │  │ Side      │  │ Preferences      │  │
│  │ Menu      │  │ Panel     │  │ Panel            │  │
│  │ Ingest    │  │ Wiki view │  │ API Key/Model    │  │
│  │ Query     │  │ Search    │  │ Lang/Template    │  │
│  │ Lint      │  │ History   │  │ Embedding opts   │  │
│  └──────────┘  └───────────┘  └──────────────────┘  │
├─────────────────────────────────────────────────────┤
│                   Zotero API Layer                    │
│  hooks.ts — notifier event listeners                 │
│  - onAddItem → optional auto-ingest trigger          │
│  - onSelectItem → panel update                       │
├─────────────────────────────────────────────────────┤
│                   Core Logic Layer                    │
│  ┌─────────┐  ┌──────────┐  ┌──────────────────┐   │
│  │ Ingest  │  │  Query   │  │  Lint             │   │
│  │ Module  │  │  Module  │  │  Module            │   │
│  └─────────┘  └──────────┘  └──────────────────┘   │
│  ┌──────────┐  ┌───────────┐  ┌───────────────┐   │
│  │ LLM      │  │ Wiki      │  │ Embedding     │   │
│  │ Provider │  │ Storage   │  │ Service       │   │
│  │ OpenAI   │  │ Markdown  │  │ OpenAI embed  │   │
│  │ Anthropic│  │ SQLite    │  │ or local      │   │
│  │ unified  │  │ file CRUD │  │ transformers  │   │
│  └──────────┘  └───────────┘  └───────────────┘   │
├─────────────────────────────────────────────────────┤
│                   Data Storage                       │
│  {Zotero data dir}/llm-wiki/                         │
│  ├── index.md          # Global index                │
│  ├── wiki.db            # SQLite (metadata+vectors)  │
│  ├── wiki/              # Markdown wiki pages        │
│  │   ├── papers/        # Paper wikis                │
│  │   ├── concepts/      # Concept pages              │
│  │   └── authors/       # Author pages               │
│  └── raw/               # Cached paper metadata      │
└─────────────────────────────────────────────────────┘
```

**Tech stack:** TypeScript, zotero-plugin-toolkit v5, zotero-plugin-scaffold, Markdown files + SQL.js (browser-compatible SQLite), unified LLM interface (OpenAI SDK format + Anthropic SDK format).

## Core Operations

### 1. Ingest

Trigger: right-click a Zotero item → "LLM Wiki: Ingest"

```
User selects item → Right-click Ingest
                           │
                           ▼
                ┌──────────────────┐
                │ 1. Extract        │
                │  - Title, authors │
                │  - Abstract       │
                │  - DOI/year/venue │
                │  - PDF full text  │
                │   (if available)  │
                └──────┬───────────┘
                       ▼
                ┌──────────────────┐
                │ 2. Deduplicate    │
                │  - DOI hash check │
                │  - title fuzzy    │
                │  - Existing →     │
                │    update mode    │
                │  - New → create   │
                └──────┬───────────┘
                       ▼
                ┌──────────────────┐
                │ 3. Build Prompt   │
                │  - System instr   │
                │  - Paper content  │
                │  - Related wikis  │
                │  - Schema spec    │
                └──────┬───────────┘
                       ▼
                ┌──────────────────┐
                │ 4. Call LLM       │
                │  - Large doc?     │
                │    chunk→summarize│
                │    →final wiki    │
                │  - Short doc?     │
                │    full text      │
                └──────┬───────────┘
                       ▼
                ┌──────────────────┐
                │ 5. Update Storage │
                │  - Write paper.md │
                │  - Update index   │
                │  - Update SQLite  │
                │  - Sync to Zotero │
                │    note           │
                └──────┬───────────┘
                       ▼
                ┌──────────────────┐
                │ 6. Cross-ref      │
                │  - Find related   │
                │    pages          │
                │  - Update their   │
                │    cross-refs     │
                └──────┬───────────┘
                       ▼
                ┌──────────────────┐
                │ 7. Embed (optional)│
                │  - Generate vector│
                │  - Store in SQLite│
                └──────────────────┘
```

**Large document strategy (mixed):**
- Short text (< threshold tokens) → full text to LLM in one call
- Long text (≥ threshold) → chunk → summarize each chunk → aggregate summaries → final wiki
- Threshold: user-configurable, default 8000 tokens
- Token estimation: approximate via character count / 4 before exact tokenizer

**Fallback when PDF full text unavailable:**
- Try Open Access retrieval via DOI (Unpaywall API, arXiv API)
- If OA full text obtained → proceed with full ingest
- If OA retrieval fails → ingest based on title + abstract only, mark wiki with "⚠️ Based on metadata only (full text unavailable)"

### 2. Query

Trigger: side panel input or right-click → "LLM Wiki: Query"

```
User enters question
         │
         ▼
┌──────────────────┐
│ 1. Retrieve       │
│  - Read index.md  │
│  - Vector search  │
│   (if enabled)    │
│  - Return         │
│    candidate pages│
└──────┬───────────┘
       ▼
┌──────────────────┐
│ 2. Synthesize     │
│  - Load candidate │
│    page contents  │
│  - Build prompt   │
│    with citations │
│  - LLM synthesize │
│  - Include source │
│    references     │
└──────────────────┘
```

### 3. Lint

Trigger: right-click or scheduled

```
Lint triggered
         │
         ▼
┌──────────────────┐
│ 1. Traverse wiki  │
│  - Check broken   │
│    cross-refs     │
│  - Flag            │
│    contradictions │
│  - Find orphan    │
│    pages          │
│  - Detect stale   │
│    content        │
└──────┬───────────┘
       ▼
┌──────────────────┐
│ 2. Generate report│
│  - Issue list     │
│  - Severity       │
│  - Suggested fixes│
└──────────────────┘
```

## Wiki Schema

Three page types, auto-created by LLM based on triggers:

| Page Type | Trigger | Template Sections |
|-----------|---------|-------------------|
| **Paper** | Every ingested item | Research question, Method, Key findings, Conclusions, Limitations, Related papers, Cross-references |
| **Concept** | ≥2 papers discuss same concept | Definition, Related papers, Evolution, Controversies, Cross-references |
| **Author** | ≥3 papers by same author ingested | Research directions, Representative works, Collaboration network, Cross-references |

Schema and templates are user-customizable via Preferences (Markdown + placeholders).

## Index & Retrieval

**Dual approach:**
1. `index.md` — lightweight entry point, LLM reads it to locate relevant pages (Karpathy original pattern)
2. Vector retrieval — optional, embedding-based semantic search for large libraries

Both can coexist. For libraries < 100 papers, index.md alone is sufficient.

## Trigger Methods

1. **Right-click context menu** — "LLM Wiki: Ingest" / "Query" / "Lint"
2. **Keyboard shortcuts** — configurable (MVP: none)
3. **Side panel** — wiki browser, search bar, operation buttons (MVP: none)

## LLM Provider Configuration

### Supported formats
- OpenAI API format (OpenAI, Ollama, vLLM, most proxies)
- Anthropic native API format

### Configuration fields (Preferences panel)
- API Provider (dropdown: OpenAI-compatible / Anthropic)
- API Key (password field)
- API Endpoint URL (default: `https://api.openai.com/v1`)
- Model name (default: `gpt-4o`)
- Max tokens per request (default: 4096)
- Request timeout (seconds, default: 120)
- Language preference (keep original / Chinese / English, default: keep original)
- Large doc chunk threshold (tokens, default: 8000)

### API Key security
- MVP: stored in Zotero Preferences (`Zotero.Prefs`), plaintext
- Post-MVP: migrate to OS keychain (macOS Keychain / Windows Credential Manager)

## Error Handling

- **Async all LLM calls** — never block the Zotero UI thread
- **Loading indicator** — progress bar or status text during ingest
- **Timeout** — user-configurable, default 120s
- **Error categories:**
  - Network error → "Unable to reach API. Check your endpoint and connection."
  - Auth error (401/403) → "API key rejected. Check your key in Preferences."
  - Rate limit (429) → auto-retry with exponential backoff (max 3 retries)
  - Server error (5xx) → "LLM service returned an error. Try again later."
  - Timeout → "Request timed out. Increase timeout in Preferences or try a smaller document."
- **Graceful degradation** — if one step fails, don't lose already-extracted metadata

## Filename Safety

Paper titles sanitized for filesystem safety:
- Remove or replace: `/ \ : * ? " < > |`
- Replace spaces with hyphens
- Truncate to max 100 chars
- Append short hash to avoid collisions (first 8 chars of MD5 of original title)
- Example: `attention-is-all-you-need-a3f2b1c9.md`

## Zotero 9 Compatibility

### Known risks
- Zotero 9 rapid release, API may have breaking changes from Zotero 7
- Web-based login introduced in Zotero 9 (should not affect plugin API)
- `strict_max_version` in manifest.json must be `9.*`

### Validation strategy (MVP step zero)
1. Clone zotero-plugin-template, update manifest for Zotero 9
2. Add a dummy menu item and preferences panel
3. Load in Zotero 9, verify both appear and function
4. Proceed with actual feature development only after validation passes

### Template compatibility
- Based on windingwind/zotero-plugin-template v3.1.0
- Key dependencies: zotero-plugin-toolkit v5, zotero-plugin-scaffold
- These libraries need Zotero 9 compatibility verification

## MVP Scope

### Included
- Right-click → "LLM Wiki: Ingest" on a selected item
- Extract title + abstract (no PDF full text in MVP)
- OpenAI API format LLM call (single provider)
- Output: `wiki/papers/{title-slug}.md` under Zotero data directory
- Preferences panel: API Key + API Endpoint + Model name
- Basic error handling (async, timeout, error categories)
- Filename sanitization
- Language: keep original language (hardcoded for MVP)

### Excluded (post-MVP)
- Query, Lint operations
- Side panel
- PDF full text extraction and chunking
- Anthropic API format
- Deduplication (DOI/title hash)
- Cross-reference updates on ingest
- Concept and Author page types
- index.md generation
- SQLite storage
- Embedding / vector retrieval
- OA retrieval for missing full text
- Keyboard shortcuts
- Language preference configuration
- Large document chunking strategy

## File Structure (Plugin)

```
zotero-llm-wiki/
├── addon/
│   ├── bootstrap.js          # Plugin entry point
│   ├── manifest.json          # Zotero 9 target
│   └── content/
│       └── preferences.xhtml  # Settings panel
├── src/
│   ├── index.ts               # Main plugin class
│   ├── hooks.ts               # Zotero event listeners
│   ├── modules/
│   │   ├── ingest.ts          # Ingest logic
│   │   ├── llmProvider.ts     # LLM API abstraction
│   │   ├── wikiStorage.ts     # Markdown file read/write
│   │   └── preferenceScript.ts # Preferences bindings
│   └── utils/
│       ├── locale.ts          # i18n
│       ├── prefs.ts           # Preference helpers
│       ├── sanitize.ts        # Filename sanitization
│       └── ztoolkit.ts        # Toolkit helpers
├── typings/
│   ├── global.d.ts
│   ├── i10n.d.ts
│   └── prefs.d.ts
├── package.json
├── tsconfig.json
└── zotero-plugin.config.ts
```

## Data Flow (MVP Ingest)

```
1. User right-clicks item → selects "LLM Wiki: Ingest"
2. Plugin reads item via Zotero.Items.get(itemID)
3. Extract: title, abstract, authors, DOI, year, publication
4. Build OpenAI-format messages:
   - system: "You are a research assistant. Generate a structured wiki entry..."
   - user: "{title}\n{abstract}\n{authors}\n..."
5. POST to configured endpoint with API key
6. Parse LLM response → markdown wiki content
7. Sanitize title → filename
8. Write to {Zotero data dir}/llm-wiki/wiki/papers/{filename}.md
9. Show success notification in Zotero
```
