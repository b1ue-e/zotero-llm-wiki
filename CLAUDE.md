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
└── modules/
    ├── ingest.ts          # Ingest orchestration: extract metadata → call LLM → write wiki
    ├── llmProvider.ts     # OpenAI-compatible API via XMLHttpRequest (not fetch)
    ├── wikiStorage.ts     # Wiki file I/O via Firefox XPCOM (nsIFile, nsIConverterOutputStream)
    └── preferenceScript.ts# Preferences pane init + defaults

addon/
├── bootstrap.js           # Firefox bootstrapped extension lifecycle
├── manifest.json          # Extension manifest (template variables filled by scaffold)
├── prefs.js               # Preference defaults
├── content/
│   ├── preferences.xhtml  # Preferences pane UI
│   └── zoteroPane.css
└── locale/{en-US,zh-CN}/  # Fluent (.ftl) localization files
```

The `addon` global singleton is created in `src/index.ts` and mounted on `Zotero.LLMWiki`. Plugin code runs in Zotero's privileged sandbox — **no browser fetch/AbortController, no Node.js APIs**. All I/O goes through Firefox XPCOM (`Components.classes` / `Components.interfaces`).

## Key constraints

- **Runtime**: Zotero 9 / Firefox ESR 115 privileged sandbox. Use `XMLHttpRequest`, not `fetch`. Use `Components.classes["@mozilla.org/timer;1"]` for delays, not `setTimeout`-based Promise wrappers that depend on browser event loop behavior.
- **Build**: `zotero-plugin-scaffold` with esbuild targeting `firefox115`. The bundle output lands at `.scaffold/build/addon/content/scripts/llmwiki.js`.
- **Menu**: `ztoolkit.Menu` was removed in the toolkit beta — menus are built via DOM `popupshowing` capture-phase listener + `createXULElement("menuitem")`.
- **File encoding**: Always use `nsIConverterOutputStream` with `"UTF-8"` when writing files — `nsIFileOutputStream.write(string)` corrupts non-ASCII characters.
- **Wiki directory**: Reads `Zotero.Prefs.get("dataDir")` for the data root; falls back to `Zotero.getStorageDirectory().path` (parent of `storage/`).
- **Localization**: Fluent `.ftl` files in `addon/locale/`. The `getString()` helper in `src/utils/locale.ts` auto-prefixes keys with the addon ref (`llmwiki-`). The scaffold generates `typings/i10n.d.ts` with all valid Fluent message IDs.
- **Preferences**: Key prefix is `extensions.zotero.llmwiki`. Wrappers in `src/utils/prefs.ts` auto-prefix. Defaults set in both `addon/prefs.js` and `src/modules/preferenceScript.ts`.
