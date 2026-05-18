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

### Streaming Output
- XHR `onprogress` + SSE parsing for real-time Agent responses
- Requires handling `stream: true` in API calls and `text/event-stream` parsing

### Multi-Model Support
- Anthropic Claude API support (different message format, tool calling)
- Model selector in preferences

### PDF Extraction Improvements
- Handle large PDFs more efficiently (current 50-page limit)
- Better text extraction from figure-heavy papers
- Fallback to `pdftotext` system binary if available

### Quality of Life
- Fix toast notifications in panel context
- `/compact` with LLM-summarized older messages
- Conversation persistence across Zotero restarts
- Agent memory: remember key facts across sessions
