# Wiki Browser + Agent Panel Design

**Date**: 2026-05-16
**Status**: approved
**Version**: 0.2.0 (post-MVP)

## Overview

MVP 实现了右键菜单 → Ingest 的单向编译流程。此设计为插件添加两个独立的侧边栏面板：

1. **Wiki 浏览器**：在 Zotero 内浏览、编辑知识库 Markdown 文件
2. **Agent 对话**：多步骤 AI 助手，可搜索 Wiki、编译论文、交叉分析

采用基础先行策略：Phase 1 实现 Wiki 浏览器 + 共享数据层，Phase 2 实现 Agent 面板。

---

## Architecture

```
src/
├── modules/
│   ├── wikiReader.ts        # 共享数据层（Phase 1，新增）
│   ├── wikiBrowser.ts       # Wiki 浏览器逻辑（Phase 1，新增）
│   └── agentPanel.ts        # Agent 面板逻辑（Phase 2，新增）
addon/content/
├── wikiBrowser.xhtml        # Wiki 浏览器 UI（Phase 1，新增）
└── agentPanel.xhtml         # Agent 面板 UI（Phase 2，新增）
```

XHTML 文件放在 `addon/content/` 因为构建系统将 `addon/**/*.*` 作为静态资源复制到输出。TypeScript 模块放在 `src/modules/` 通过 esbuild 打包。

两个面板通过 `Zotero.ItemPaneManager.registerSection()` 注册到右侧面板，各自独立。

共享数据层 `wikiReader.ts` 提供文件读取、搜索、保存能力，Wiki 浏览器和 Agent 面板均依赖它。

### Panel Rendering Model

`Zotero.ItemPaneManager.registerSection()` 的 `onRender` 回调收到 `{ doc, body }`：`body` 是 `bodyXHTML` 解析后的根元素。面板逻辑（TypeScript）通过 DOM API 向 `body` 填充内容：

```
XHTML (addon/content/wikiBrowser.xhtml)
  └─→ onRender({ body: HTMLElement })  ← wikiBrowser.ts
      └─→ body.innerHTML = ...          ← 构建文件树 + 内容区
```

所有 UI 交互（点击、切换、保存）在 TypeScript 模块中通过事件委托处理。

### Panel Registration

```
Zotero 主窗口
+----------+----------------+------------------------------+
| 左侧     | 中间            | 右侧面板 (ItemPane)           |
| 集合列表 | 条目列表         |  Info | Notes | Wiki | Agent |
+----------+----------------+------------------------------+
```

Panel lifecycle：在 `hooks.ts` → `onMainWindowLoad()` 中调用 `Zotero.ItemPaneManager.registerSection()`，设置 `pluginID` 确保插件禁用时自动清理。

---

## Phase 1: Wiki Browser Panel

### Layout

```
+-- Wiki Browser -----------------------------------+
| [文件树区域]              | [内容区域]               |
|                           |                         |
| papers/                  | # Paper Title           |
|   +-- paper-a-slug.md   |                         |
|   +-- paper-b-slug.md ● | ## Research Question    |
|   +-- paper-c-slug.md   | ...                     |
| concepts/                | ## Method               |
|   (empty)                | ...                     |
| entities/                |                         |
|   (empty)                | [Edit] [Save]           |
+--------------------------+---------------------------+
```

### Interactions

- **File tree**: XPCOM reads `llm-wiki/wiki/` directory, groups by papers/concepts/entities, highlights current file
- **Preview mode** (default): Renders Markdown as HTML using `marked` library
  - YAML frontmatter displayed as a styled metadata card (title, authors, year, DOI, tags)
  - `[[wikilinks]]` converted to clickable internal links
  - Clicking a wikilink navigates to that page in the viewer
- **Edit mode**: Same area switches to a textarea with raw Markdown content
  - Save triggers `wikiReader.savePage()` then refreshes preview
- **Toggle button** at top-right of content area switches between preview/edit

### Markdown Rendering

- npm package `marked` bundled via esbuild
- Custom renderer extensions:
  - `[[papers/slug|Title]]` → `<a>` element with click handler dispatching navigation
  - `[[concepts/name]]` and `[[entities/name]]` same treatment
  - Frontmatter block (`---...---`) filtered from rendered HTML, displayed separately
- Target: `firefox115` (ESR), all bundled code must be compatible

### Data Layer API (wikiReader.ts)

```
listTree(): FileNode[]
  // Returns directory tree structure from llm-wiki/wiki/

readPage(path: string): ParsedPage
  // Returns { frontmatter: Record<string,string>, body: string, filePath: string }

savePage(path: string, content: string): void
  // Writes raw content via XPCOM, then updates index.md updated date

searchPages(query: string): SearchResult[]
  // Full-text search across all .md files, returns matches with context snippets

parseIndex(): IndexEntry[]
  // Parses index.md → list of all papers with slugs, titles, years, summaries
```

---

## Phase 2: Agent Panel

### Layout

```
+-- Agent ----------------------------------------+
|                                                   |
| [User message]                                    |
| What do these three papers conclude about X?      |
|                                                   |
| +-- Search Wiki ---- [expand] ------------------+ |
| | Status: complete                              | |
| | Found 3 matching papers                       | |
| +------------------------------------------------+ |
| +-- Read Pages ----- [expand] ------------------+ |
| | Status: running, 2/3                          | |
| +------------------------------------------------+ |
|                                                   |
| [Agent response]                                  |
| The three papers differ on...                     |
|                                                   |
| +----------------------------------------------+  |
| | Type a message...                     [Send]  |  |
| +----------------------------------------------+  |
+---------------------------------------------------+
```

### Tool System

Agent initialized with system prompt (research assistant role + knowledge base usage guidance) + tool definitions. Each user message may trigger a tool-calling loop:

```
User message → LLM (with tool defs) → tool_call?
  Yes → Execute tool → Show card → Result back to LLM → loop
  No  → Display text response
```

### Tool Set (Phase 2)

| Tool                 | Function                                | Implementation             |
| -------------------- | --------------------------------------- | -------------------------- |
| `search_wiki(query)` | Full-text search all wiki pages         | `wikiReader.searchPages()` |
| `read_page(slug)`    | Read a single wiki page                 | `wikiReader.readPage()`    |
| `list_papers()`      | List all papers from index.md           | `wikiReader.parseIndex()`  |
| `ingest_selected()`  | Compile currently selected Zotero items | Reuse `modules/ingest.ts`  |

### Multi-Step Visualization

Each tool call displayed as a collapsible card in the chat:

- **Running**: spinner icon + cancel button, expand to see detail
- **Complete**: collapsed by default, expandable to view result
- **Failed**: auto-expanded with error detail, retry button

User can cancel running tool calls, then refine and re-ask.

### LLM Configuration

Agent reuses the same preferences (apiEndpoint, apiKey, modelName, requestTimeout) as ingest, but uses its own system prompt defining the research assistant role and tool usage norms. Agent prompt and ingest wiki-generation prompt are independent.

---

## Implementation Constraints (carried from STATUS.md)

- **Runtime**: Zotero 9 / Firefox ESR 115 privileged sandbox — no `fetch`, no `AbortController`, no Node.js APIs
- **HTTP**: `XMLHttpRequest` only; cancel via `xhr.abort()`
- **Delays**: XPCOM `nsITimer`, not `setTimeout`-based Promise wrappers
- **File I/O**: XPCOM `nsIFile`, `nsIConverterOutputStream("UTF-8")` for writes
- **Build**: esbuild target `firefox115`, bundle output to `llmwiki.js`
- **Localization**: Fluent `.ftl` files, `getString()` helper with `llmwiki-` prefix
- **Menu**: DOM `popupshowing` + `createXULElement` (ztoolkit.Menu unavailable)

---

## Phases

| Phase | Deliverable                                  | Dependencies            |
| ----- | -------------------------------------------- | ----------------------- |
| 1     | Wiki Browser Panel + wikiReader shared layer | None (current MVP)      |
| 2     | Agent Panel with tool system                 | wikiReader from Phase 1 |
