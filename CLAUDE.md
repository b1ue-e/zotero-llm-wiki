# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A Zotero 9 plugin that compiles academic papers into a structured, interlinked Markdown knowledge base using LLMs — based on Karpathy's LLM-Wiki pattern. Select a paper in Zotero, right-click → "LLM Wiki: Ingest", and the plugin calls an OpenAI-compatible API to generate a wiki page with YAML frontmatter sections (Research Question, Method, Key Findings, etc.) saved to `{Zotero data dir}/llm-wiki/wiki/papers/`.

## Commands

```bash
npm start          # dev server: build + install to Zotero + hot reload
npm run build      # production build (esbuild + tsc type-check)
npm run lint:check # prettier --check + eslint
npm run lint:fix   # prettier --write + eslint --fix
npm run release    # build + package .xpi for distribution
npm test           # run Zotero integration tests
```

Requires `.env` with `ZOTERO_PLUGIN_ZOTERO_BIN_PATH` and `ZOTERO_PLUGIN_PROFILE_PATH` (see `.env.example`).

## Architecture

```
src/
├── index.ts              # Entry — instantiates Addon as global singleton
├── addon.ts              # Addon class: holds data, hooks, api; lifecycle owner
├── hooks.ts              # All lifecycle callbacks + menu/item-notifier handlers
├── modules/
│   ├── ingest.ts          # Ingest orchestration: extract metadata → call LLM → write wiki
│   ├── llmProvider.ts     # OpenAI-compatible API via XMLHttpRequest (not fetch)
│   ├── wikiStorage.ts     # Wiki page creation, index/log maintenance, LLM prompts
│   ├── wikiReader.ts      # Wiki page read/search/tree operations (canonical interface)
│   ├── wikiBrowser.ts     # Zotero tab panel: wiki file browser + preview + editor
│   ├── agentPanel.ts      # Zotero tab panel: AI chat with tool-calling + deep research mode
│   ├── deepResearch.ts    # Autonomous multi-step research, session persistence, meta-analysis
│   ├── sessionMonitor.ts  # Auto feedback capture: 6 signal detectors, ring buffer, snapshots
│   ├── rawStorage.ts      # Raw JSON layer: paper metadata + fulltext (pre-LLM fallback)
│   ├── pdfExtractor.ts    # PDF fulltext extraction via Zotero's index + gzip decompression
│   └── preferenceScript.ts# Preferences pane init + defaults
└── utils/
    ├── xpcom.ts           # All filesystem I/O via Firefox XPCOM (nsIFile, streams)
    ├── locale.ts          # Fluent localization wrapper (getString/getLocaleID)
    ├── prefs.ts           # Typed preferences wrapper (auto-prefixed keys)
    ├── sanitize.ts        # Title → filesystem-safe slug (djb2 hash for uniqueness)
    ├── ztoolkit.ts        # ZoteroToolkit singleton factory
    └── window.ts          # Window liveness check (isWindowAlive)

addon/
├── bootstrap.js           # Firefox bootstrapped extension lifecycle
├── manifest.json          # Extension manifest (template variables filled by scaffold)
├── prefs.js               # Preference defaults (Zotero prefs system)
├── content/
│   ├── preferences.xhtml  # Preferences pane UI
│   └── zoteroPane.css
└── locale/{en-US,zh-CN}/  # Fluent (.ftl) localization files
```

The `addon` global singleton is created in `src/index.ts` and mounted on `Zotero.LLMWiki`. Plugin code runs in Zotero's privileged sandbox — **no browser fetch/AbortController, no Node.js APIs**. All I/O goes through Firefox XPCOM (`Components.classes` / `Components.interfaces`).

### Three-layer data architecture

The project uses a Karpathy-style "raw + wiki" pattern plus research sessions:

- **Raw layer** (`rawStorage.ts`): Immutable JSON snapshots of paper metadata + fulltext, saved _before_ the LLM call. Lives in `llm-wiki/raw/papers/{slug}.json`. Serves as a searchable fallback when wiki pages lack information.
- **Wiki layer** (`wikiStorage.ts` + `wikiReader.ts`): LLM-generated structured Markdown pages in `llm-wiki/wiki/papers/{slug}.md`, plus `index.md` (catalog) and `log.md` (append-only operation log). Directories `concepts/` and `entities/` are pre-created for future use.
- **Research sessions** (`deepResearch.ts`): Autonomous multi-step research reports with meta-analysis in `llm-wiki/research-sessions/{slug}.md`, indexed by `index.json`. Sessions are reused and updated when the same topic is researched again.

### Agent panel tool-calling loop

The agent panel (`agentPanel.ts`) implements a multi-round OpenAI function-calling loop (max 10 rounds, max 5 searches in normal mode; 20 rounds, 15 searches in deep research mode). Tools: `search_wiki`, `read_page`, `list_papers`, `ingest_selected`, `update_wiki_section`, `search_sessions`, `read_session`. A module-level `_rawFlag` detects when raw-layer data was accessed; after the main loop, the agent gets one extra round to call `update_wiki_section` to enrich the wiki with raw-layer content.

**Deep research** (`/deep_research` or `/deepresearch` command) activates an autonomous multi-step research mode with a three-phase prompt (Explore → Deep Read → Synthesize), code-enforced tool limits, stride-based content reading with TOC extraction, session reuse across runs, and automated meta-analysis generation.

### DOM preservation across tab rebuilds

Both `agentPanel.ts` and `wikiBrowser.ts` use module-level state objects to survive Zotero destroying and recreating tab DOM when switching tabs. They check whether their root element still has a parent before rebuilding. Conversation history and browser state persist across tab switches.

### Preferences defaults

Preference defaults are set in **two** places: `addon/prefs.js` (Zotero's native prefs system, used at startup) and `src/modules/preferenceScript.ts` (first-run defaults in the preferences UI). Both must be kept in sync.

## Key constraints

- **Runtime**: Zotero 9 / Firefox ESR 115 privileged sandbox. Use `XMLHttpRequest`, not `fetch`. Use `Components.classes["@mozilla.org/timer;1"]` for delays, not `setTimeout`-based Promise wrappers that depend on browser event loop behavior.
- **Build**: `zotero-plugin-scaffold` with esbuild targeting `firefox115`. The bundle output lands at `.scaffold/build/addon/content/scripts/llmwiki.js`.
- **Menu**: `ztoolkit.Menu` was removed in the toolkit beta — menus are built via DOM `popupshowing` capture-phase listener + `createXULElement("menuitem")`.
- **File encoding**: Always use `nsIConverterOutputStream` with `"UTF-8"` when writing files — `nsIFileOutputStream.write(string)` corrupts non-ASCII characters.
- **Wiki directory**: Reads `Zotero.Prefs.get("dataDir")` for the data root; falls back to `Zotero.getStorageDirectory().path` (parent of `storage/`).
- **Localization**: Fluent `.ftl` files in `addon/locale/`. The `getString()` helper in `src/utils/locale.ts` auto-prefixes keys with the addon ref (`llmwiki-`). The scaffold generates `typings/i10n.d.ts` with all valid Fluent message IDs.
- **Preferences**: Key prefix is `extensions.zotero.llmwiki`. Wrappers in `src/utils/prefs.ts` auto-prefix. Defaults set in both `addon/prefs.js` and `src/modules/preferenceScript.ts`.
- **Third-party libraries**: `marked` (Markdown → HTML, used by wikiBrowser for preview rendering). `zotero-plugin-toolkit` (scaffold, build pipeline, ProgressWindow UI, ZoteroToolkit).
- **Globals**: `rootURI` is set by `bootstrap.js` via `Services.io.newURI()` and resolves to the addon's install directory. Used for chrome:// URI construction. `addon`, `Zotero`, `ZoteroPane`, `ztoolkit` are defined as globals in `index.ts`.
- **PDF extraction**: `pdfExtractor.ts` tries Zotero's built-in fulltext cache first, then indexes on-demand. Falls back to gzip decompression via `nsIStreamConverterService`. All failures return `null` — they never block the ingest pipeline.
- **Raw storage truncation**: Fulltext in raw JSON is truncated at 200KB for JSON safety. Stride-based offsets (`_searchCallCount * 10000`) ensure repeated searches return different fulltext sections.
