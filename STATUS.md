# LLM-Wiki for Zotero — Development Status

> 100+ commits since MVP | Updated 2026-05-18

## Completed

### Phase 1: Wiki Browser Panel
- [x] Side panel registered via `Zotero.ItemPaneManager` (right pane tab)
- [x] File tree: `llm-wiki/wiki/papers/`, `concepts/`, `entities/` with click-to-preview
- [x] Markdown preview with metadata card (title, authors, year, DOI, tags)
- [x] Inline editor: textarea with Cancel/Save, direct DOM-based save flow
- [x] `[[wikilinks]]` navigation: click to jump between pages
- [x] Resizable splitter between tree and content panes
- [x] Refresh button + toast notifications for Save/Cancel/Refresh
- [x] Panel persists across item selection changes

### Phase 2: Agent Chat Panel
- [x] Chat UI with message bubbles (user blue, assistant green)
- [x] Custom markdown-to-DOM renderer (headings, bold, italic, code, tables, lists, blockquotes, links, hr)
- [x] Tool-calling loop: OpenAI function calling with `search_wiki`, `read_page`, `list_papers`, `ingest_selected`, `update_wiki_section`
- [x] Collapsible tool cards with running/complete/failed status
- [x] System prompt with research assistant guidelines
- [x] Reasoning content preserved across tool-calling rounds (DeepSeek compat)
- [x] `/clear` — reset conversation
- [x] `/compact` — drop older messages, keep system prompt + last 3 exchanges
- [x] `/save` — export conversation as Markdown to `llm-wiki/conversations/`
- [x] Hard search limit: max 5 search calls, then forced answer
- [x] Panel persists across item selection changes

### Phase 3: Raw Layer + Agent Backtrack
- [x] Raw JSON data layer: `raw/papers/<slug>.json` with metadata, abstract, fulltext
- [x] `raw/index.json` for fast title-based pre-filtering
- [x] Binary I/O for JSON files (avoids UTF-8 converter corruption)
- [x] PDF fulltext extraction via `Zotero.Fulltext.indexPDF()` + cache read
- [x] Gzip decompression of `.zotero-ft-cache` via XPCOM `nsIStreamConverterService`
- [x] Fulltext truncated to 200KB for JSON safety
- [x] `search_wiki` auto-fallbacks to raw layer when wiki results empty
- [x] Word-level matching in raw search (not exact phrase)
- [x] Position-strided raw snippet sampling (10KB stride, different section each call)
- [x] Raw snippets ~5KB with position advancement
- [x] `appendToSection()` for section-aware wiki updates
- [x] `update_wiki_section` tool in Agent toolset
- [x] Auto wiki enrichment after raw content used

### Phase 4: Concept/Entity Auto-Generation
- [x] `conceptExtractor.ts` — second LLM call extracts concepts/entities from paper wiki
- [x] Robust JSON parsing with 3-tier fallback (direct, ```json fence, inline array)
- [x] Validation: max 3 concepts + 3 entities, slug sanitization
- [x] `writeConceptPage()` — creates concept/entity pages with unified template
- [x] LLM-based dedup merge when concept page already exists (Definition improvement)
- [x] Fallback to simple text append if merge LLM call fails
- [x] `appendSeeAlsoToPaper()` — bidirectional backlinks (paper → concept)
- [x] `index.md` extended with `## Concepts` and `## Entities` sections
- [x] `autoExtractConcepts` preference with UI checkbox (default true)
- [x] Bilingual l10n (en-US / zh-CN) for all new UI strings
- [x] Concept extraction failures are non-blocking (ingest still succeeds)

### Shared Infrastructure
- [x] `xpcom.ts` — binary & UTF-8 file I/O, directory enumeration
- [x] `wikiReader.ts` — shared data layer (search, read, save, parse)
- [x] `rawStorage.ts` — raw JSON layer with binary I/O and search
- [x] `pdfExtractor.ts` — PDF text extraction via Zotero Fulltext API
- [x] All DOM built with `createElement` + `appendChild` (100% XUL-compatible)
- [x] Bilingual localization: English + Chinese (zh-CN)

---

## Known Issues (Non-Blocking)

| Issue | Priority | Notes |
|-------|----------|-------|
| Toast notifications don't display | Low | `doc.body` is null in XUL panel context |
| `parseFrontmatter` naive colon split | Low | Values containing `:` are truncated |
| Root `addon.ftl` missing newer l10n keys | Low | Locale files are synced but root template isn't |
| Path traversal in `readPage`/`savePage` | Low | Only exploitable via crafted wikilinks |
| `titleToSlug` strips non-ASCII chars | Low | Pre-existing; Chinese titles reduce to hash-only |
| `wikiStorage.ts` readFile uses binary input | Medium | Non-ASCII characters may garble on read; xpcom.ts has correct UTF-8 version |

---

## Remaining (Future Iterations)

> Priority: P5 (Deep Research) > P6 (Knowledge Graph) > Streaming > Multi-Model > PDF > QoL

### Phase 5: Deep Research + Meta-Analysis ✅ Complete

Agent performs autonomous multi-step research with structured reporting and process-level reflection.

**Module:** `src/modules/deepResearch.ts` — session CRUD, research loop orchestration, meta-analysis, report generation

**Data model:**
```
llm-wiki/research-sessions/
├── index.json              ← session index for fast retrieval
└── {slug}.md               ← YAML frontmatter + report + meta-analysis
```

Session file: YAML frontmatter (title, status, papers_referenced, concepts_referenced, tags) → `# Research:` report with Summary/Findings/References → `# Meta-Analysis` with Search Strategy/Cross-Paper Insights/Knowledge Gaps.

- [x] `/deep_research <query>` + `/deepresearch` slash commands for manual trigger
- [x] Auto-detection: Agent recognizes research intent in normal chat and suggests deep research mode
- [x] Autonomous research loop: three-phase prompt (Explore → Deep Read → Synthesize), capped at 20 rounds / 15 searches / 8 reads / 3 wiki updates
- [x] Structured report generation: forced full report when output is too short
- [x] Meta-analysis: post-research LLM call generates Search Strategy, Cross-Paper Insights, Knowledge Gaps
- [x] `search_sessions(query)` / `read_session(slug)` tools for Agent to reference past methodology
- [x] Research trace: capture intermediate search queries and decisions for meta-analysis input
- [x] Session reuse: pre-research check finds existing sessions on same topic, injects truncated old context, updates in-place
- [x] Stride-based content reading: consecutive read_page/search_wiki calls advance through content with per-slug offsets
- [x] TOC extraction: truncated tool results include section headings so LLM can navigate
- [x] Tool status indicator: single in-place status line instead of stacked cards
- [x] Debug logging to terminal via `npm run log`

### Phase 6: Knowledge Graph Exploration 🟠 P1 — High

Natural-language graph queries via Agent tools + card-style relationship view in Wiki Browser.

**Agent tools (new in `agentPanel.ts` TOOL_DEFINITIONS):**

| Tool | Purpose |
|------|---------|
| `list_concepts(type)` | List all concepts/entities with linked paper counts |
| `get_related_papers(slug)` | Given a concept/entity, return all referencing papers |
| `find_connections(source, target?)` | Find connection paths between nodes; without target, return direct neighbors |

**Implementation:** `find_connections` scans all wiki pages' `[[wikilinks]]` and frontmatter to build an in-memory adjacency list for path finding.

- [x] Agent graph query tools: `list_concepts`, `get_related_papers`, `find_connections`
- [x] Wiki Browser graph view: "Graph" button in concept/entity page toolbar
- [x] Card-style relationship view: current node → linked papers layer → see-also concepts layer, all clickable to navigate
- [x] Pure DOM/CSS implementation (no canvas/WebGL — XUL-compatible, flexbox layout with pseudo-element arrows)

### Session Monitor — Auto Feedback Capture ✅ Complete

Automatic detection of anomalous conversation signals with session snapshot saving.

**Module:** `src/modules/sessionMonitor.ts` — 20-event ring buffer, 6 signal detectors, JSON snapshot writer, auto-purge (50 files max).

| # | Signal | Trigger |
|---|--------|---------|
| 1 | `repeat_question` | Consecutive user messages with bigram similarity > 80% |
| 2 | `user_frustration` | User message matches frustration pattern (不对/wrong/no/重来) |
| 3 | `short_report` | Deep research report < 300 chars |
| 4 | `reasoning_leak` | Assistant response is internal reasoning (Let me/让我...) |
| 5 | `tool_failure_chain` | ≥ 2 failures in last 3 tool calls |
| 6 | `api_fault` | Any 4xx/5xx HTTP status, timeout, or network error |

- [x] 6 signal detectors with quantified thresholds
- [x] Ring buffer + similarity helper
- [x] Snapshot writer: `{dataDir}/llm-wiki/feedback/{ts}-{signal}.json`
- [x] Auto-purge oldest when > 50 files
- [x] 8 `track()` integration points in agentPanel.ts
- [x] Fire-and-forget — never blocks or throws

### Streaming Output 🟡 P2 — Medium
- XHR `onprogress` + SSE parsing for real-time Agent responses
- Requires handling `stream: true` in API calls and `text/event-stream` parsing

### Multi-Model Support 🟡 P2 — Medium
- Anthropic Claude API support (different message format, tool calling)
- Model selector in preferences

### Agent Proactive Suggestions ✅ Rule Engine Complete

Rule-based detection of patterns in the knowledge base, with Suggestions bar in Wiki Browser.

**Module:** `src/modules/suggestionEngine.ts` — 3 detectors, JSON cache, `scanAll()`/`scanDelta()`/`dismiss()`

- [x] Cross-paper pattern detection: papers sharing [[wikilinks]] concepts but not interlinked
- [x] Knowledge gap alerts: referenced concepts/entities that don't exist on disk (≥2 papers)
- [x] Missing paper detection: quoted titles in Related Work/References not in wiki
- [x] Wiki Browser Suggestions bar: collapsible, Scan All button, dismiss per item
- [x] Auto-trigger: `scanDelta()` after each ingest

### Agent Proactive Suggestions — LLM Enhancement 🟡 P2 — Medium

Upgrade the rule engine with LLM-powered semantic analysis for deeper insights.

- [ ] Semantic concept matching: "single-cell-genomics" and "single-cell-transcriptomics" detected as related even with different slugs
- [ ] Method coherence analysis: LLM reads `## Method` sections across papers to find shared approaches not captured by wikilinks
- [ ] Contradiction detection: LLM identifies papers with opposing conclusions
- [ ] Suggestion quality scoring: LLM ranks suggestions by relevance/actionability
- [ ] "Deep Analyze" button: on any suggestion, run LLM to produce a detailed analysis with specific recommendations

### Citation & Literature Management 🟡 P2 — Medium

Agent helps manage citations and discover relevant literature.

- [ ] Citation formatting: generate BibTeX/AMA/APA from wiki frontmatter
- [ ] Literature gap analysis: "Based on your wiki, you're missing coverage on topic X"
- [ ] Next-paper recommendation: "Since you read Paper A, Paper B is highly relevant"
- [ ] Automatic DOI → metadata enrichment via API

### PDF Extraction Improvements 🟢 P3 — Low
- Handle large PDFs more efficiently (current 50-page limit)
- Better text extraction from figure-heavy papers
- Fallback to `pdftotext` system binary if available

### Quality of Life 🟢 P3 — Low
- Fix toast notifications in panel context
- `/compact` with LLM-summarized older messages
- Conversation persistence across Zotero restarts
- Agent memory: remember key facts across sessions
