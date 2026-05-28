# Deep Research + Meta-Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable Agent to perform autonomous multi-step research with structured reporting and process-level meta-analysis, triggered via `/deep_research` command or auto-detection of research intent.

**Architecture:** New module `src/modules/deepResearch.ts` handles session persistence and meta-analysis LLM calls. Agent panel gains expanded tool limits during deep research mode, new tools (`start_deep_research`, `search_sessions`, `read_session`), and a dedicated system prompt for autonomous research. Sessions saved as Markdown files in `llm-wiki/research-sessions/` with JSON index for fast retrieval.

**Tech Stack:** TypeScript, Firefox XPCOM file I/O, OpenAI-compatible API via XMLHttpRequest

---

## File Structure

| File                           | Action | Purpose                                                          |
| ------------------------------ | ------ | ---------------------------------------------------------------- |
| `src/modules/deepResearch.ts`  | Create | Session CRUD, index management, meta-analysis LLM prompt         |
| `src/modules/agentPanel.ts`    | Modify | Deep research tools, slash command, research loop, system prompt |
| `addon/locale/en-US/addon.ftl` | Modify | English localization for new UI strings                          |
| `addon/locale/zh-CN/addon.ftl` | Modify | Chinese localization for new UI strings                          |

---

### Task 1: Create deepResearch.ts module

**Files:**

- Create: `src/modules/deepResearch.ts`

- [ ] **Step 1: Write the module**

Create `src/modules/deepResearch.ts`:

```typescript
import { callLLM } from "./llmProvider";
import {
  getWikiBaseDir,
  makeDir,
  writeFile,
  readFile,
  writeBinaryFile,
  readBinaryFile,
} from "../utils/xpcom";

// ─── Types ───

interface ResearchStep {
  type: "search" | "read";
  details: string;
}

export interface ResearchTrace {
  initial_query: string;
  steps: ResearchStep[];
}

interface ResearchIndexEntry {
  slug: string;
  title: string;
  created: string;
  status: string;
  tags: string[];
}

export interface SessionSaveData {
  title: string;
  query: string;
  report: string;
  meta_analysis: string;
  trace: ResearchTrace;
  papers_referenced: string[];
  concepts_referenced: string[];
  tags: string[];
}

// ─── Path Helpers ───

function getResearchDir(): string {
  let dataPath = Zotero.Prefs.get("dataDir") as string;
  if (!dataPath) {
    const storagePath = Zotero.getStorageDirectory().path;
    dataPath = storagePath.substring(0, storagePath.lastIndexOf("/"));
  }
  return `${dataPath}/llm-wiki/research-sessions`;
}

function ensureResearchDirs(): void {
  makeDir(getResearchDir());
}

// ─── Index Management ───

function readIndex(): ResearchIndexEntry[] {
  const path = `${getResearchDir()}/index.json`;
  const content = readBinaryFile(path);
  if (!content) return [];
  try {
    return JSON.parse(content) as ResearchIndexEntry[];
  } catch {
    return [];
  }
}

function writeIndex(entries: ResearchIndexEntry[]): void {
  ensureResearchDirs();
  writeBinaryFile(
    `${getResearchDir()}/index.json`,
    JSON.stringify(entries, null, 2),
  );
}

// ─── Session CRUD ───

export function saveSession(data: SessionSaveData): string {
  ensureResearchDirs();

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const slug =
    dateStr +
    "-" +
    data.title
      .replace(/[/\\:*?"<>|]/g, "")
      .replace(/[^\x00-\x7F]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase()
      .slice(0, 60);

  const papersJson = JSON.stringify(data.papers_referenced);
  const conceptsJson = JSON.stringify(data.concepts_referenced);
  const tagsJson = JSON.stringify(data.tags);

  const content = [
    "---",
    `title: "${escapeYaml(data.title)}"`,
    `created: ${dateStr}`,
    `updated: ${dateStr}`,
    `status: complete`,
    `papers_referenced: ${papersJson}`,
    `concepts_referenced: ${conceptsJson}`,
    `tags: ${tagsJson}`,
    "---",
    "",
    data.report,
    "",
    "# Meta-Analysis",
    "",
    data.meta_analysis,
  ].join("\n");

  const filePath = `${getResearchDir()}/${slug}.md`;
  writeFile(filePath, content);

  const entries = readIndex();
  entries.unshift({
    slug,
    title: data.title,
    created: dateStr,
    status: "complete",
    tags: data.tags,
  });
  writeIndex(entries);

  return slug;
}

export function loadSession(
  slug: string,
): {
  frontmatter: Record<string, string>;
  report: string;
  meta_analysis: string;
} | null {
  const path = `${getResearchDir()}/${slug}.md`;
  const raw = readFile(path);
  if (!raw) return null;

  const fmEnd = raw.indexOf("---", 3);
  if (fmEnd === -1) return null;

  const fmBlock = raw.slice(3, fmEnd);
  const body = raw.slice(fmEnd + 3).trimStart();

  const frontmatter: Record<string, string> = {};
  for (const line of fmBlock.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) frontmatter[key] = value;
  }

  const metaIdx = body.indexOf("\n# Meta-Analysis\n");
  const report = metaIdx >= 0 ? body.slice(0, metaIdx).trim() : body.trim();
  const meta_analysis =
    metaIdx >= 0
      ? body
          .slice(metaIdx + 1)
          .replace(/^# Meta-Analysis\n?/, "")
          .trim()
      : "";

  return { frontmatter, report, meta_analysis };
}

export function searchSessions(
  query: string,
): { slug: string; title: string; snippet: string; created: string }[] {
  const q = query.toLowerCase();
  const queryWords = q.split(/\s+/).filter((w) => w.length > 1);
  const entries = readIndex();
  const results: {
    slug: string;
    title: string;
    snippet: string;
    created: string;
  }[] = [];

  for (const entry of entries) {
    const titleLower = entry.title.toLowerCase();
    const tagsLower = entry.tags.join(" ").toLowerCase();
    if (
      !queryWords.some((w) => titleLower.includes(w) || tagsLower.includes(w))
    )
      continue;

    const session = loadSession(entry.slug);
    const snippet = session
      ? session.report.replace(/\n/g, " ").slice(0, 200) + "..."
      : entry.title;

    results.push({
      slug: entry.slug,
      title: entry.title,
      snippet,
      created: entry.created,
    });
  }

  return results;
}

export function listSessions(): {
  slug: string;
  title: string;
  created: string;
  status: string;
}[] {
  return readIndex().map((e) => ({
    slug: e.slug,
    title: e.title,
    created: e.created,
    status: e.status,
  }));
}

// ─── Meta-Analysis Generation ───

const META_SYSTEM_PROMPT = `You are analyzing a research process to extract reusable methodological insights.

Given a research report and the trace of steps taken (searches, pages read, decisions made), produce a meta-analysis in the following format:

## Search Strategy
What search approach worked? What queries were most effective? What was the overall search strategy? (2-3 paragraphs)

## Cross-Paper Insights
What hidden connections or patterns were discovered across papers? For example: similar methods used independently, contradictory findings, shared datasets or benchmarks, converging conclusions from different approaches. (2-3 paragraphs)

## Knowledge Gaps
What was NOT found? What areas of the wiki are under-covered? What topics or papers need more ingestion? What research questions remain open? (1-2 paragraphs)

Be specific — reference actual paper names and concepts. Focus on REUSABLE insights for future research sessions.`;

export async function generateMetaAnalysis(
  report: string,
  trace: ResearchTrace,
): Promise<string> {
  const stepsText = trace.steps
    .map((s) => `- [${s.type}] ${s.details}`)
    .join("\n");
  const userPrompt = [
    "# Research Report",
    report,
    "",
    "# Research Trace",
    `Initial Query: ${trace.initial_query}`,
    stepsText || "(no steps recorded)",
    "",
    "Generate the meta-analysis.",
  ].join("\n");

  const response = await callLLM([
    { role: "system", content: META_SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ]);
  return response;
}

function escapeYaml(s: string): string {
  return s.replace(/"/g, '\\"').replace(/\n/g, " ");
}
```

- [ ] **Step 2: Verify compilation**

```bash
npm run build
```

Expected: TypeScript compilation passes, deepResearch.ts is bundled into `.scaffold/build/addon/content/scripts/llmwiki.js`.

- [ ] **Step 3: Commit**

```bash
git add src/modules/deepResearch.ts
git commit -m "feat: add deepResearch module with session CRUD and meta-analysis"
```

---

### Task 2: Add localization strings

**Files:**

- Modify: `addon/locale/en-US/addon.ftl`
- Modify: `addon/locale/zh-CN/addon.ftl`

- [ ] **Step 1: Add English strings**

Edit `addon/locale/en-US/addon.ftl` — append after existing content:

```ftl
# Deep Research
deep-research-detected = This seems like a research question. Would you like me to start a deep research? Type /deep_research to begin.
deep-research-start = Starting deep research on: "{ $query }"
deep-research-complete = Research complete. Report saved to { $path }
deep-research-synthesizing = Synthesizing research findings...
deep-research-meta = Generating meta-analysis...
deep-research-too-many-rounds = Research reached round limit. Synthesizing findings so far.
```

- [ ] **Step 2: Add Chinese strings**

Edit `addon/locale/zh-CN/addon.ftl` — append after existing content:

```ftl
# 深度研究
deep-research-detected = 这似乎是个研究问题。需要我启动深度研究吗？输入 /deep_research 开始。
deep-research-start = 开始深度研究: "{ $query }"
deep-research-complete = 研究完成。报告已保存至 { $path }
deep-research-synthesizing = 正在综合研究发现...
deep-research-meta = 正在生成元分析...
deep-research-too-many-rounds = 研究达到轮次上限，正在综合当前发现。
```

- [ ] **Step 3: Commit**

```bash
git add addon/locale/en-US/addon.ftl addon/locale/zh-CN/addon.ftl
git commit -m "feat: add deep research localization strings"
```

---

### Task 3: Extend agentPanel.ts — tools and deep research mode

**Files:**

- Modify: `src/modules/agentPanel.ts`

This task adds the three new tools (`start_deep_research`, `search_sessions`, `read_session`) and the deep research mode with expanded limits. The changes touch imports, constants, tool definitions, system prompt, slash command handling, tool execution switch, and the main send handler loop.

- [ ] **Step 1: Add import for deepResearch module**

Edit `src/modules/agentPanel.ts` — add import after existing `import { searchRaw } from "./rawStorage";` (line 13):

```typescript
import {
  saveSession,
  searchSessions,
  loadSession,
  listSessions,
  generateMetaAnalysis,
  type SessionSaveData,
  type ResearchTrace,
} from "./deepResearch";
```

- [ ] **Step 2: Add deep research mode flag and limit constants**

Edit `src/modules/agentPanel.ts` — add after `let _rawFlag = false;` (line 61):

```typescript
let _deepResearchMode = false;
let _researchTrace: ResearchTrace = { initial_query: "", steps: [] };

const MAX_TOOL_ROUNDS_NORMAL = 10;
const MAX_SEARCHES_NORMAL = 5;
const MAX_TOOL_ROUNDS_DEEP = 20;
const MAX_SEARCHES_DEEP = 15;
```

- [ ] **Step 3: Replace hardcoded limits with variables**

Edit `src/modules/agentPanel.ts` — in `handleSend()`, replace the hardcoded limits (around lines 633-638):

Replace:

```typescript
const MAX_TOOL_ROUNDS = 10;
let response = await callLLM(state.messages);
let round = 0;
let searchCount = 0;
_rawFlag = false;
const MAX_SEARCHES = 5;
```

With:

```typescript
const maxRounds = _deepResearchMode
  ? MAX_TOOL_ROUNDS_DEEP
  : MAX_TOOL_ROUNDS_NORMAL;
const maxSearches = _deepResearchMode ? MAX_SEARCHES_DEEP : MAX_SEARCHES_NORMAL;
let response = await callLLM(state.messages);
let round = 0;
let searchCount = 0;
_rawFlag = false;
```

And replace `MAX_TOOL_ROUNDS` with `maxRounds` and `MAX_SEARCHES` with `maxSearches` in the rest of `handleSend()`.

- [ ] **Step 4: Add new tool definitions**

Edit `src/modules/agentPanel.ts` — in `TOOL_DEFINITIONS` array, append after the `update_wiki_section` entry (after line 552):

```typescript
  {
    type: "function",
    function: {
      name: "start_deep_research",
      description: "Begin autonomous multi-step research on a question. Searches, reads, and synthesizes findings into a structured report with citations.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The research question to investigate" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_sessions",
      description: "Search past research sessions by title, tags, or content for reusable methodology and findings.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query for past sessions" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_session",
      description: "Read a past research session including its report and meta-analysis by slug.",
      parameters: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Session slug (e.g., '2026-05-28-topic-slug')" },
        },
        required: ["slug"],
      },
    },
  },
```

- [ ] **Step 5: Update system prompt for auto-detection and deep research**

Edit `src/modules/agentPanel.ts` — replace the `buildSystemPrompt()` function (lines 556-582):

```typescript
function buildSystemPrompt(): string {
  const base = `You are a research assistant with access to a personal wiki knowledge base containing structured summaries of academic papers.

## Available Tools
- search_wiki(query): Search all wiki pages for specific topics. Returns paper titles with content snippets.
- read_page(slug): Read the full content of a specific wiki page by its slug path.
- list_papers(): List all papers in the knowledge base with years and summaries.
- ingest_selected(): Compile the currently selected Zotero items into new wiki pages.
- update_wiki_section(slug, section, content): Append new information to a wiki page section.
- search_sessions(query): Search past deep research sessions for reusable methodology.
- read_session(slug): Read a full past research session.

## Deep Research Detection
When the user's question clearly requires multi-paper comparison, literature review, synthesis, or survey (keywords: compare, contrast, review, synthesize, survey, "what methods", "how does X relate to Y", "across papers") — respond with: "This seems like a research question. Would you like me to start a deep research? Type /deep_research to begin." Do NOT start deep research automatically — always ask first.

## Critical Rules (MUST follow)
- **Stop and answer**: After calling read_page, you have the paper's complete structured summary. Answer the user's question IMMEDIATELY — do NOT call more tools.
- **One page is enough**: read_page returns all wiki sections. If the answer is in there, just answer.
- **Maximum 3 tool calls total per question**, then you MUST answer with what you have.
- search_wiki also searches the raw paper data automatically — no extra calls needed.

## Guidelines
- search_wiki first, then read_page for the most relevant paper.
- When comparing papers, read the relevant pages, then provide your analysis.
- Cite papers using their exact titles when referencing them.
- If you cannot find relevant information, suggest that the user ingest related papers.
- Be concise, precise, and academic in your responses.
- Write in the same language the user uses.`;

  if (_deepResearchMode) {
    return (
      base +
      `

## DEEP RESEARCH MODE — ACTIVE
You are in autonomous multi-step research mode. Your goal is comprehensive investigation.

### Process
1. Search the wiki broadly with multiple query angles
2. Read the most promising papers in full
3. Based on findings, refine your search with more specific queries
4. Read additional papers discovered through refined search
5. When you have sufficient coverage (typically 5-8 papers), synthesize findings
6. End your response with a structured report

### Report Format (at end of your final response)
# Research: [Descriptive Title]
## Summary
[2-3 sentence overview of findings]
## Key Findings
- [Finding 1 with paper citations]
- [Finding 2 with paper citations]
...
## Analysis by Topic
[Organized by subtopic, citing specific papers with [[wikilinks]]]
## References
- [[papers/slug|Paper Title]] — relevance

### Limits
- Maximum 20 tool rounds, 15 searches in this mode
- After reading 5-8 papers, move to synthesis
- If information is insufficient, note gaps rather than searching endlessly`
    );
  }

  return base;
}
```

- [ ] **Step 6: Update slash command handling**

Edit `src/modules/agentPanel.ts` — in `handleSend()`, add deep research command handling after the `/save` block (after line 615):

```typescript
if (text.startsWith("/deep_research")) {
  const query = text.slice("/deep_research".length).trim();
  if (!query) {
    addAssistantMessage("Usage: /deep_research <research question>");
    state.busy = false;
    updateSendButton();
    return;
  }
  _deepResearchMode = true;
  _researchTrace = { initial_query: query, steps: [] };
  state.messages = [];
  clearChatDOM();
  const sysPrompt = buildSystemPrompt();
  state.messages.push({ role: "system", content: sysPrompt });
  state.messages.push({ role: "user", content: query });
  addUserMessage(query);
  state.busy = true;
  updateSendButton();
  executeDeepResearch(query);
  return;
}
```

- [ ] **Step 7: Extract deep research execution into its own function**

Edit `src/modules/agentPanel.ts` — add `executeDeepResearch` function before `handleSend`:

```typescript
async function executeDeepResearch(query: string): Promise<void> {
  const thinkingEl = addThinking();
  const maxRounds = MAX_TOOL_ROUNDS_DEEP;
  const maxSearches = MAX_SEARCHES_DEEP;
  let response = await callLLM(state.messages);
  let round = 0;
  let searchCount = 0;
  _rawFlag = false;

  try {
    // Tool calling loop with expanded limits
    while (
      response.tool_calls &&
      response.tool_calls.length > 0 &&
      round < maxRounds
    ) {
      round++;
      state.messages.push({
        role: "assistant",
        content: response.content || "",
        tool_calls: response.tool_calls,
        ...response.rawMessage,
      } as ChatMessage);

      for (const tc of response.tool_calls) {
        if (tc.function.name === "search_wiki" && searchCount >= maxSearches) {
          state.messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content:
              "Search limit reached. Synthesize your findings now and produce the final report.",
          });
          continue;
        }
        if (tc.function.name === "search_wiki") searchCount++;
        if (
          tc.function.name === "search_wiki" ||
          tc.function.name === "read_page"
        ) {
          _researchTrace.steps.push({
            type: tc.function.name === "search_wiki" ? "search" : "read",
            details: tc.function.arguments || "",
          });
        }
        const result = await executeToolCall(tc);
        state.messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: result,
        });
      }

      response = await callLLM(state.messages);
    }

    // Raw flag enrichment (same as normal mode)
    if (_rawFlag && response.content) {
      state.messages.push({
        role: "user",
        content:
          "If raw layer info is missing from wiki, call update_wiki_section. Then continue your report.",
      });
      const enrichResp = await callLLM(state.messages);
      if (enrichResp.tool_calls && enrichResp.tool_calls.length > 0) {
        for (const tc of enrichResp.tool_calls) {
          if (tc.function.name === "update_wiki_section") {
            await executeToolCall(tc);
          }
        }
        if (enrichResp.content) response = enrichResp;
        else {
          const finalResp = await callLLM(state.messages);
          if (finalResp.content) response = finalResp;
        }
      } else if (enrichResp.content) {
        response = enrichResp;
      }
    }

    if (thinkingEl) thinkingEl.remove();

    const report = response.content || "";
    if (!report && round >= maxRounds) {
      addAssistantMessage(
        "Deep research reached the round limit without producing a report. Try a more specific question.",
      );
      state.busy = false;
      updateSendButton();
      return;
    }

    // Step 2: Generate meta-analysis
    addAssistantMessage(report);
    state.messages.push({
      role: "assistant",
      content: report,
      ...response.rawMessage,
    } as ChatMessage);

    const thinkingEl2 = addThinking();
    try {
      const metaAnalysis = await generateMetaAnalysis(report, _researchTrace);
      if (thinkingEl2) thinkingEl2.remove();

      // Step 3: Parse report for title, papers, tags
      const titleMatch = report.match(/^# Research:\s*(.+)$/m);
      const sessionTitle = titleMatch
        ? titleMatch[1].trim()
        : query.slice(0, 60);
      const paperRefs = [...report.matchAll(/\[\[papers\/([^\]|]+)/g)].map(
        (m) => `papers/${m[1]}`,
      );
      const conceptRefs = [...report.matchAll(/\[\[concepts\/([^\]|]+)/g)].map(
        (m) => `concepts/${m[1]}`,
      );
      const tagWords = query
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 3);

      // Step 4: Save session
      const slug = saveSession({
        title: sessionTitle,
        query,
        report,
        meta_analysis: metaAnalysis,
        trace: _researchTrace,
        papers_referenced: [...new Set(paperRefs)].slice(0, 10),
        concepts_referenced: [...new Set(conceptRefs)].slice(0, 10),
        tags: tagWords.slice(0, 5),
      });

      const wikiPath = getWikiBaseDir().replace(/\/wiki$/, "");
      addAssistantMessage(
        `Research session saved to \`${wikiPath}/research-sessions/${slug}.md\``,
      );
    } catch (e: any) {
      if (thinkingEl2) thinkingEl2.remove();
      Zotero.debug(
        `[llmwiki] meta-analysis failed (non-blocking): ${e.message}`,
      );
    }
  } catch (e: any) {
    if (thinkingEl) thinkingEl.remove();
    addAssistantMessage(`Deep research error: ${e.message || String(e)}`);
  }

  _deepResearchMode = false;
  _researchTrace = { initial_query: "", steps: [] };
  state.busy = false;
  updateSendButton();
}
```

- [ ] **Step 8: Add tool execution cases**

Edit `src/modules/agentPanel.ts` — in `executeToolCall()`, add cases for the new tools before the `default` case (before line 863):

```typescript
      case "start_deep_research": {
        // Already handled by the deep research mode — just acknowledge
        result = `Deep research mode activated for: "${args.query || ""}"`;
        break;
      }
      case "search_sessions": {
        const sessions = searchSessions(args.query || "");
        if (sessions.length === 0) {
          result = "No past research sessions found matching your query.";
        } else {
          result = sessions.map(s =>
            `- **${s.title}** (${s.slug})\n  Created: ${s.created}\n  ${s.snippet}`
          ).join("\n\n");
        }
        break;
      }
      case "read_session": {
        const session = loadSession((args.slug || "").replace(/\.md$/, ""));
        if (!session) {
          result = `Session not found: "${args.slug}"`;
        } else {
          result = `# ${session.frontmatter["title"] || args.slug}\n\n${session.report}\n\n# Meta-Analysis\n\n${session.meta_analysis}`;
        }
        break;
      }
```

- [ ] **Step 9: Verify build**

```bash
npm run build
```

Expected: TypeScript compilation passes, no type errors.

- [ ] **Step 10: Commit**

```bash
git add src/modules/agentPanel.ts
git commit -m "feat: add deep research mode with expanded tool limits and meta-analysis"
```

---

### Task 4: Integration test and polish

- [ ] **Step 1: Start dev server and test in Zotero**

```bash
npm start
```

Manual test checklist:

1. Open Agent panel, type a research question (e.g., "Compare the methods used in papers about X") — verify auto-detection message appears
2. Type `/deep_research What methods are used for single-cell RNA-seq analysis?` — verify deep research mode starts
3. Watch the tool cards as Agent searches and reads — verify multi-step research loop
4. Verify final report is displayed with structured format
5. Verify meta-analysis is appended below the report
6. Check `{Zotero data}/llm-wiki/research-sessions/` — verify .md and index.json files exist
7. Type `/clear`, then ask Agent "search past research sessions about single-cell" — verify `search_sessions` tool works
8. Ask Agent to "read the session" — verify `read_session` tool works
9. Type a simple question (not research) — verify normal mode still works with standard limits

- [ ] **Step 2: Commit any fixes**

```bash
git add -A
git commit -m "fix: deep research integration polish"
```
