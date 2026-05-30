import {
  searchPages,
  readPage,
  parseIndex,
  parseFrontmatter,
  type SearchResult,
  type IndexEntry,
  type ParsedPage,
} from "./wikiReader";
import { runIngest } from "./ingest";
import { getPref } from "../utils/prefs";
import { getWikiBaseDir, writeFile, makeDir, listDir } from "../utils/xpcom";
import { searchRaw } from "./rawStorage";
import { appendToSection } from "./wikiStorage";
import { saveSession, searchSessions, loadSession, listSessions, generateMetaAnalysis, type SessionSaveData, type ResearchTrace } from "./deepResearch";

// ─── Types ───

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface AgentState {
  messages: ChatMessage[];
  chatEl: HTMLElement | null;
  inputEl: HTMLTextAreaElement | null;
  sendBtn: HTMLButtonElement | null;
  doc: Document | null;
  busy: boolean;
}

const state: AgentState = {
  messages: [],
  chatEl: null,
  inputEl: null,
  sendBtn: null,
  doc: null,
  busy: false,
};

let _rawFlag = false;
let _deepResearchMode = false;
let _researchTrace: ResearchTrace = { initial_query: "", steps: [] };
let _toolStatusEl: HTMLElement | null = null;
let _toolStatusDetailEl: HTMLElement | null = null;
let _toolCount = 0;
const _strideState = { searchWiki: 0, searchSessions: 0, readPage: {} as Record<string, number> };

const MAX_TOOL_ROUNDS_NORMAL = 10;
const MAX_SEARCHES_NORMAL = 5;
const MAX_TOOL_ROUNDS_DEEP = 20;
const MAX_SEARCHES_DEEP = 15;

// ─── CSS ───

const AGENT_CSS = `
  #llmwiki-agent { display: flex; flex-direction: column; height: 100%; overflow: hidden; }
  #llmwiki-agent-messages { flex: 1; overflow-y: auto; padding: 12px; display: flex;
    flex-direction: column; gap: 12px; }
  #llmwiki-agent-input-area { display: flex; gap: 8px; padding: 8px 12px;
    border-top: 1px solid var(--fill-quaternary, #e0e0e0); }
  #llmwiki-agent-input { flex: 1; min-height: 36px; max-height: 120px; border: 1px solid
    var(--fill-quaternary, #ccc); border-radius: 6px; padding: 8px; font-size: 13px;
    resize: none; background: #f5f5f5; color: #222; font-family: inherit; }
  #llmwiki-agent-send { padding: 6px 16px; border-radius: 6px; border: none;
    background: var(--accent-selected, #0060df); color: #fff; cursor: pointer;
    font-size: 13px; white-space: nowrap; }
  #llmwiki-agent-send:disabled { opacity: 0.5; cursor: default; }
  #llmwiki-agent-send:hover:not(:disabled) { opacity: 0.9; }
  .llmwiki-msg { max-width: 85%; padding: 8px 12px; border-radius: 8px; font-size: 13px;
    line-height: 1.5; word-wrap: break-word; }
  .llmwiki-msg-plain { white-space: pre-wrap; }
  .llmwiki-msg-user { align-self: flex-end;
    background: var(--accent-selected, #0060df); color: #fff; }
  .llmwiki-msg-assistant { align-self: flex-start;
    background: #dcf8c6; color: #222; }
  .llmwiki-msg-system { align-self: center; font-size: 12px;
    color: var(--text-secondary, #999); padding: 4px 8px; max-width: 100%; }
  .llmwiki-tool-status { align-self: flex-start; font-size: 12px;
    color: var(--text-secondary, #666); padding: 4px 12px; display: flex;
    align-items: center; gap: 6px; }
  .llmwiki-tool-status-detail { color: var(--text-secondary, #999); font-size: 11px;
    max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .llmwiki-msg p { margin: 4px 0; }
  .llmwiki-msg ul, .llmwiki-msg ol { margin: 4px 0; padding-left: 20px; }
  .llmwiki-msg li { margin: 2px 0; }
  .llmwiki-msg strong { font-weight: 600; }
  .llmwiki-msg em { font-style: italic; }
  .llmwiki-msg code { background: rgba(0,0,0,0.08); padding: 1px 4px;
    border-radius: 3px; font-family: monospace; font-size: 12px; }
  .llmwiki-msg pre { background: rgba(0,0,0,0.06); padding: 8px; border-radius: 4px;
    overflow-x: auto; margin: 4px 0; }
  .llmwiki-msg pre code { background: none; padding: 0; }
  .llmwiki-msg h1, .llmwiki-msg h2, .llmwiki-msg h3, .llmwiki-msg h4
    { margin: 8px 0 4px; font-weight: 600; }
  .llmwiki-msg h1 { font-size: 1.2em; }
  .llmwiki-msg h2 { font-size: 1.1em; }
  .llmwiki-msg h3 { font-size: 1em; }
  .llmwiki-msg blockquote { border-left: 3px solid var(--fill-quaternary, #ccc);
    margin: 4px 0; padding: 2px 8px; color: var(--text-secondary, #666); }
  .llmwiki-msg hr { border: none; border-top: 2px solid rgba(0,0,0,0.15);
    margin: 12px 0; }
  .llmwiki-msg table { border-collapse: collapse; width: 100%; margin: 8px 0;
    font-size: 12px; }
  .llmwiki-msg th, .llmwiki-msg td { border: 1px solid rgba(0,0,0,0.15);
    padding: 4px 8px; text-align: left; }
  .llmwiki-msg th { background: rgba(0,0,0,0.06); font-weight: 600; }
  .llmwiki-msg tr:nth-child(even) td { background: rgba(0,0,0,0.03); }
  .llmwiki-thinking { align-self: flex-start; color: var(--text-secondary, #999);
    font-size: 13px; padding: 8px 12px; }
`;

// ─── Public Entry Point ───

export function renderAgentPanel({
  body,
  doc,
}: {
  body: HTMLElement;
  doc: Document;
}): void {
  if (!body) return;
  state.doc = doc;

  // Rebuild only if our shell was detached (tab hidden → DOM destroyed by Zotero)
  if (state.chatEl?.parentNode) return;

  // Preserve conversation across rebuilds
  const oldMessages = state.messages;
  state.messages = [];

  while (body.firstChild) body.removeChild(body.firstChild);

  // CSS
  const style = doc.createElement("style");
  style.textContent = AGENT_CSS;
  body.appendChild(style);

  // Shell
  const container = doc.createElement("div");
  container.id = "llmwiki-agent";

  // Messages area
  const messagesEl = doc.createElement("div");
  messagesEl.id = "llmwiki-agent-messages";
  state.chatEl = messagesEl;

  // Welcome message
  const welcome = doc.createElement("div");
  welcome.className = "llmwiki-msg llmwiki-msg-assistant";
  const wikiPath = getWikiBaseDir();
  renderMarkdownTo(
    welcome,
    `Hello! I can search your wiki, read papers, list your library, and compile new papers. Ask me anything about your research.\n\nWiki files are stored at: \`${wikiPath}/\``,
  );
  messagesEl.appendChild(welcome);

  // Input area
  const inputArea = doc.createElement("div");
  inputArea.id = "llmwiki-agent-input-area";

  const input = doc.createElement("textarea");
  input.id = "llmwiki-agent-input";
  input.placeholder = "Ask about your research...";
  input.rows = 1;
  state.inputEl = input;

  const sendBtn = doc.createElement("button");
  sendBtn.id = "llmwiki-agent-send";
  sendBtn.textContent = "Send";
  sendBtn.addEventListener("click", handleSend);
  state.sendBtn = sendBtn as unknown as HTMLButtonElement;

  // Enter to send, Shift+Enter for newline
  input.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  inputArea.appendChild(input);
  inputArea.appendChild(sendBtn);

  container.appendChild(messagesEl);
  container.appendChild(inputArea);
  body.appendChild(container);

  // Restore conversation history after rebuild
  for (const msg of oldMessages) {
    if (msg.role === "user") {
      addUserMessage(msg.content);
    } else if (msg.role === "assistant") {
      addAssistantMessage(msg.content);
    }
  }
  state.messages = oldMessages;
}

// ─── Message Rendering ───

function addUserMessage(text: string): void {
  if (!state.chatEl || !state.doc) return;
  const el = state.doc.createElement("div");
  el.className = "llmwiki-msg llmwiki-msg-user";
  el.textContent = text;
  state.chatEl.appendChild(el);
  scrollToBottom();
}

function addAssistantMessage(text: string): void {
  if (!state.chatEl || !state.doc) return;
  const el = state.doc.createElement("div");
  el.className = "llmwiki-msg llmwiki-msg-assistant";
  // Build DOM directly from markdown — no HTML string parsing needed
  renderMarkdownTo(el, text);
  state.chatEl.appendChild(el);
  scrollToBottom();
}

// ─── Markdown-to-DOM Renderer ───
// Builds elements directly to avoid XUL HTML-parsing issues

function renderMarkdownTo(container: HTMLElement, md: string): void {
  const doc = state.doc!;
  const lines = md.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block (```...```)
    if (/^```/.test(line)) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      const pre = doc.createElement("pre");
      const code = doc.createElement("code");
      if (lang) code.className = `language-${lang}`;
      code.textContent = codeLines.join("\n");
      pre.appendChild(code);
      container.appendChild(pre);
      continue;
    }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) {
      container.appendChild(doc.createElement("hr"));
      i++;
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,4})\s+(.+)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const h = doc.createElement(`h${level}`);
      renderInlineTo(h, headingMatch[2]);
      container.appendChild(h);
      i++;
      continue;
    }

    // Unordered list
    if (/^[-*]\s+/.test(line)) {
      const ul = doc.createElement("ul");
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        const li = doc.createElement("li");
        renderInlineTo(li, lines[i].replace(/^[-*]\s+/, ""));
        ul.appendChild(li);
        i++;
      }
      container.appendChild(ul);
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(line)) {
      const ol = doc.createElement("ol");
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        const li = doc.createElement("li");
        renderInlineTo(li, lines[i].replace(/^\d+\.\s+/, ""));
        ol.appendChild(li);
        i++;
      }
      container.appendChild(ol);
      continue;
    }

    // Table (very simple: | col1 | col2 |)
    if (/^\|.+\|/.test(line)) {
      const table = doc.createElement("table");
      while (i < lines.length && /^\|.+\|/.test(lines[i])) {
        const cells = lines[i].split("|").filter((c) => c.trim());
        const isHeader =
          i + 1 < lines.length && /^\|[-:\s|]+\|$/.test(lines[i + 1]);
        const tr = doc.createElement("tr");
        cells.forEach((cell) => {
          const td = doc.createElement(isHeader ? "th" : "td");
          renderInlineTo(td, cell.trim());
          tr.appendChild(td);
        });
        // Use tbody; wrap header rows in thead
        if (isHeader) {
          const thead = doc.createElement("thead");
          thead.appendChild(tr);
          table.appendChild(thead);
          i += 2; // skip header separator row
        } else {
          let tbody = table.querySelector("tbody") as HTMLElement;
          if (!tbody) {
            tbody = doc.createElement("tbody");
            table.appendChild(tbody);
          }
          tbody.appendChild(tr);
          i++;
        }
      }
      container.appendChild(table);
      continue;
    }

    // Blockquote
    if (/^>\s?/.test(line)) {
      const bq = doc.createElement("blockquote");
      let bqContent = "";
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        bqContent += (bqContent ? "\n" : "") + lines[i].replace(/^>\s?/, "");
        i++;
      }
      renderMarkdownTo(bq, bqContent);
      container.appendChild(bq);
      continue;
    }

    // Empty line → paragraph break
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph: collect consecutive non-empty, non-special lines
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^```/.test(lines[i]) &&
      !/^---+$/.test(lines[i].trim()) &&
      !/^#{1,4}\s+/.test(lines[i]) &&
      !/^[-*]\s+/.test(lines[i]) &&
      !/^\d+\.\s+/.test(lines[i]) &&
      !/^\|.+\|/.test(lines[i]) &&
      !/^>\s?/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      const p = doc.createElement("p");
      renderInlineTo(p, paraLines.join("\n"));
      container.appendChild(p);
    }
  }
}

// ─── Inline Markdown ───

function renderInlineTo(el: HTMLElement, text: string): void {
  const doc = state.doc!;
  // Split by inline tokens: **bold**, *italic*, `code`, [link](url)
  const parts = text.split(
    /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g,
  );
  for (const part of parts) {
    if (!part) continue;
    if (/^\*\*[^*]+\*\*$/.test(part)) {
      const strong = doc.createElement("strong");
      strong.textContent = part.slice(2, -2);
      el.appendChild(strong);
    } else if (/^\*[^*]+\*$/.test(part)) {
      const em = doc.createElement("em");
      em.textContent = part.slice(1, -1);
      el.appendChild(em);
    } else if (/^`[^`]+`$/.test(part)) {
      const code = doc.createElement("code");
      code.textContent = part.slice(1, -1);
      el.appendChild(code);
    } else if (/^\[([^\]]+)\]\(([^)]+)\)$/.test(part)) {
      const m = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (m) {
        const a = doc.createElement("a");
        a.textContent = m[1];
        a.setAttribute("href", m[2]);
        a.setAttribute("target", "_blank");
        el.appendChild(a);
      }
    } else {
      el.appendChild(doc.createTextNode(part));
    }
  }
}

function addThinking(): HTMLElement | null {
  if (!state.chatEl || !state.doc) return null;
  const el = state.doc.createElement("div");
  el.className = "llmwiki-thinking";
  el.textContent = "Thinking...";
  state.chatEl.appendChild(el);
  scrollToBottom();
  return el;
}

function scrollToBottom(): void {
  if (state.chatEl) {
    state.chatEl.scrollTop = state.chatEl.scrollHeight;
  }
}

// ─── LLM Calling ───

interface LLMResponse {
  content: string | null;
  tool_calls: ToolCall[] | null;
  rawMessage: Record<string, unknown> | null;
}

function callLLM(messages: ChatMessage[]): Promise<LLMResponse> {
  const endpoint = getPref("apiEndpoint") as string;
  const apiKey = getPref("apiKey") as string;
  const model = getPref("modelName") as string;

  if (!endpoint || !apiKey) {
    return Promise.reject(
      new Error("API not configured. Check Preferences → LLM Wiki."),
    );
  }

  const url = endpoint.endsWith("/chat/completions")
    ? endpoint
    : endpoint.replace(/\/$/, "") + "/chat/completions";

  const body = JSON.stringify({
    model,
    messages,
    tools: TOOL_DEFINITIONS,
    temperature: 0.3,
    max_tokens: 4096,
  });

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.setRequestHeader("Authorization", `Bearer ${apiKey}`);
    xhr.timeout = ((getPref("requestTimeout") as number) || 120) * 1000;

    xhr.onload = () => {
      if (xhr.status === 401 || xhr.status === 403) {
        reject(new Error("API key rejected (401). Check Preferences."));
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(
          new Error(
            `API error (${xhr.status}): ${xhr.responseText?.slice(0, 300) || ""}`,
          ),
        );
        return;
      }
      try {
        const data = JSON.parse(xhr.responseText || "{}");
        const choice = data.choices?.[0]?.message;
        resolve({
          content: choice?.content || null,
          tool_calls: choice?.tool_calls || null,
          rawMessage: choice || null,
        });
      } catch (e: any) {
        reject(new Error(`Failed to parse response: ${e.message}`));
      }
    };

    xhr.onerror = () => reject(new Error("Network error"));
    xhr.ontimeout = () => reject(new Error("Request timed out"));
    xhr.send(body);
  });
}

// ─── Tool Definitions ───

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "search_wiki",
      description:
        "Full-text search across all wiki pages. Returns matching papers with content snippets.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_page",
      description:
        "Read the full content of a wiki page by its slug (e.g., 'papers/title-slug-hash').",
      parameters: {
        type: "object",
        properties: {
          slug: {
            type: "string",
            description: "Page slug path like papers/slug",
          },
        },
        required: ["slug"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_papers",
      description:
        "List all papers in the knowledge base with titles, years, and summaries.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ingest_selected",
      description:
        "Compile the currently selected Zotero items into wiki pages using the LLM.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_wiki_section",
      description:
        "Append new information to a specific section of a wiki page. Use this when raw data contains important knowledge not yet captured in the structured wiki page.",
      parameters: {
        type: "object",
        properties: {
          slug: {
            type: "string",
            description: "Wiki page slug (e.g., 'papers/title-hash')",
          },
          section: {
            type: "string",
            description:
              "Section name: Research Question, Method, Key Findings, Conclusions, Limitations, Related Work",
          },
          content: {
            type: "string",
            description: "Markdown content to append to the section",
          },
        },
        required: ["slug", "section", "content"],
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
  {
    type: "function",
    function: {
      name: "list_concepts",
      description: "List all concepts and entities in the knowledge base, optionally filtered by type. Shows how many papers reference each one.",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", description: "Filter by type: 'concept', 'entity', or 'all' (default)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_related_papers",
      description: "Get all papers that reference a given concept or entity. Use this to find papers related to a specific method, framework, or named entity.",
      parameters: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Concept/entity slug (e.g., 'concepts/self-attention' or 'entities/imagenet')" },
        },
        required: ["slug"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_connections",
      description: "Find connections between papers, concepts, and entities in the knowledge graph. Without a target, returns all directly connected nodes. With a target, finds the shortest path between them.",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", description: "Source node slug (e.g., 'papers/slug', 'concepts/slug', 'entities/slug')" },
          target: { type: "string", description: "Optional target node slug to find a path to" },
        },
        required: ["source"],
      },
    },
  },
];

// ─── System Prompt ───

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

## Deep Research Detection (CRITICAL — read before answering)
The user may not know about deep research mode. You MUST proactively suggest it when the question falls into any of these categories:
- Open-ended exploration: "tell me about X", "what do we know about X"
- Comparative questions: "compare X and Y", "differences between X and Y"
- Synthesis requests: "summarize the literature on X", "what methods are used for X"
- Multi-paper topics: any answer needing information from more than one paper

**Response template (use before calling ANY tools):**
"This seems like a research question. I can do a deep research — it searches broadly, reads multiple papers, and produces a structured report with meta-analysis. Type /deep_research 疾病细胞评分 to start. Want to try?"

If the user agrees but doesn't use the slash command, remind them once: "Type /deep_research <question> to begin."

## Critical Rules (MUST follow)
- **Never output internal reasoning**: Do NOT say things like "let me read this paper" or "I found some relevant results" — just call the tool silently and present findings in your answer.
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
- Write in the same language the user uses.

## Wiki Enrichment
- Whenever you discover information missing from the wiki, call update_wiki_section IMMEDIATELY after your answer — do NOT ask permission, just do it
- If raw layer data has details the wiki lacks, enrich the relevant section proactively
- Section names: "Research Question", "Method", "Key Findings", "Conclusions", "Limitations", "Related Work"`;

  if (_deepResearchMode) {
    return base + `

## DEEP RESEARCH MODE — ACTIVE
You are in autonomous multi-step research mode.

### Phase Plan (follow strictly — advance phase after completing its goal)

**Phase 1 — Explore (Rounds 1-2):**
- Goal: Understand what the wiki has on this topic
- Call search_wiki 2-3 times with different query angles
- Do NOT call read_page or update_wiki_section yet
- After 2 search rounds → advance to Phase 2

**Phase 2 — Deep Read (Rounds 3-4):**
- Goal: Read the most relevant papers in detail
- read_page for the top 3-5 most relevant papers from Phase 1 results
- Do NOT search again unless Phase 1 missed something critical
- Max 5 read_page calls in this phase
- After reading key papers → advance to Phase 3

**Phase 3 — Synthesize (Rounds 5-6):**
- Goal: Produce the final report
- Do NOT call any more tools — you have enough information
- Generate the complete # Research: report (see format below)
- If you must call a tool, call update_wiki_section at most 2 times total, then stop

### Hard Limits (code-enforced, will block you)
| Limit | Value | Consequence |
|-------|-------|-------------|
| Total tool rounds | 20 | Loop ends, report required |
| Total search_wiki calls | 15 | Further searches return error |
| Total read_page calls | 8 | Further reads return error |
| update_wiki_section calls | 3 | Further updates return error |
| Phase 3 rounds | 2 | You MUST synthesize after 2 Phase-3 rounds |

### Report Format (output as your final message, no tool calls)
# Research: [Descriptive Title]
## Summary
[2-3 sentence overview]
## Key Findings
- [Finding with paper citations]
## Analysis by Topic
[Subtopic-organized, citing papers with [[wikilinks]]]
## References
- [[papers/slug|Paper Title]]

### Self-Check Before Each Tool Call
Before calling any tool, ask yourself:
1. "Which phase am I in?" → If Phase 3, do NOT call tools
2. "Have I read enough papers?" → If you've read 5+, stop and synthesize
3. "Is this search query substantially different from my previous ones?" → If not, skip it
4. "Will this update_wiki_section help the current report?" → If not, skip it`;
  }

  return base;
}

// ─── Knowledge Graph Traversal ───

interface GraphNode {
  name: string;
  slug: string;
  type: "concept" | "entity";
  paperCount: number;
}

function listGraphNodes(filterType: string): GraphNode[] {
  const baseDir = getWikiBaseDir();
  const results: GraphNode[] = [];
  const dirs = filterType === "all"
    ? ["concepts", "entities"]
    : [filterType === "entity" ? "entities" : "concepts"];

  for (const dir of dirs) {
    const catDir = `${baseDir}/${dir}`;
    const files = listDir(catDir);
    for (const filePath of files) {
      if (!filePath.endsWith(".md")) continue;
      const page = readPage(`${dir}/${filePath.split("/").pop()!}`);
      if (!page) continue;
      const name = page.frontmatter["title"] || filePath;
      const slug = `${dir}/${filePath.split("/").pop()!.replace(/\.md$/, "")}`;
      let paperCount = 0;
      const papersDir = `${baseDir}/papers`;
      const paperFiles = listDir(papersDir);
      for (const pf of paperFiles) {
        if (!pf.endsWith(".md")) continue;
        const paperPage = readPage(`papers/${pf.split("/").pop()!}`);
        if (!paperPage) continue;
        if (paperPage.body.includes(`[[${slug}`)) paperCount++;
      }
      results.push({ name, slug, type: dir === "concepts" ? "concept" : "entity", paperCount });
    }
  }
  results.sort((a, b) => b.paperCount - a.paperCount);
  return results;
}

function getRelatedPapers(slug: string): { title: string; slug: string; relevance: string }[] {
  const baseDir = getWikiBaseDir();
  const results: { title: string; slug: string; relevance: string }[] = [];
  const papersDir = `${baseDir}/papers`;
  const paperFiles = listDir(papersDir);

  for (const pf of paperFiles) {
    if (!pf.endsWith(".md")) continue;
    const relPath = `papers/${pf.split("/").pop()!}`;
    const page = readPage(relPath);
    if (!page) continue;
    if (page.body.includes(`[[${slug}`)) {
      const linkRegex = new RegExp(`\\[\\[${slug}\\|?[^\\]]*\\]\\][ \\t]*(?:—|–|-)?[ \\t]*(.*)`, "i");
      const match = page.body.match(linkRegex);
      const relevance = match?.[1]?.trim() || "Related work";
      results.push({
        title: page.frontmatter["title"] || pf,
        slug: relPath.replace(/\.md$/, ""),
        relevance: relevance.slice(0, 120),
      });
    }
  }
  return results;
}

function findConnections(source: string, target?: string): string {
  const baseDir = getWikiBaseDir();
  const adj: Map<string, Set<string>> = new Map();
  const labels: Map<string, string> = new Map();

  const scanDir = (dir: string) => {
    const files = listDir(`${baseDir}/${dir}`);
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      const relPath = `${dir}/${f.split("/").pop()!.replace(/\.md$/, "")}`;
      const page = readPage(relPath);
      if (!page) continue;
      labels.set(relPath, page.frontmatter["title"] || relPath);
      if (!adj.has(relPath)) adj.set(relPath, new Set());
      const links = page.body.match(/\[\[([^\]]+)\]\]/g) || [];
      for (const link of links) {
        const inner = link.slice(2, -2);
        const neighbor = inner.split("|")[0].trim();
        adj.get(relPath)!.add(neighbor);
        if (!adj.has(neighbor)) adj.set(neighbor, new Set());
        adj.get(neighbor)!.add(relPath);
        if (!labels.has(neighbor)) {
          labels.set(neighbor, inner.split("|")[1]?.trim() || neighbor);
        }
      }
    }
  };

  scanDir("papers");
  scanDir("concepts");
  scanDir("entities");

  let normalizedSource = source;
  if (!source.includes("/")) {
    for (const prefix of ["concepts", "entities", "papers"]) {
      if (adj.has(`${prefix}/${source}`)) {
        normalizedSource = `${prefix}/${source}`;
        break;
      }
    }
  }

  if (!target) {
    const neighbors = adj.get(normalizedSource);
    if (!neighbors || neighbors.size === 0) {
      return `No direct connections found for "${source}". Ingest more papers to build the knowledge graph.`;
    }
    const neighborList = [...neighbors].map(n => {
      const label = labels.get(n) || n;
      return `- ${label} (${n})`;
    });
    return `Direct connections for "${labels.get(normalizedSource) || normalizedSource}":\n${neighborList.join("\n")}`;
  }

  let normalizedTarget = target;
  if (!target.includes("/")) {
    for (const prefix of ["concepts", "entities", "papers"]) {
      if (adj.has(`${prefix}/${target}`)) {
        normalizedTarget = `${prefix}/${target}`;
        break;
      }
    }
  }

  const visited = new Set<string>();
  const queue: { node: string; path: string[] }[] = [{ node: normalizedSource, path: [normalizedSource] }];
  visited.add(normalizedSource);
  const maxHops = 5;

  while (queue.length > 0) {
    const { node, path } = queue.shift()!;
    if (node === normalizedTarget || node === target) {
      const pathLabels = path.map((n, i) => `${i}. ${labels.get(n) || n} (${n})`);
      return `Connection found (${path.length - 1} hops):\n${pathLabels.join("\n")}`;
    }
    if (path.length > maxHops) continue;
    for (const neighbor of adj.get(node) || []) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push({ node: neighbor, path: [...path, neighbor] });
      }
    }
  }

  return `No connection found between "${source}" and "${target || "?"}" within ${maxHops} hops.`;
}

async function executeDeepResearch(query: string): Promise<void> {
  Zotero.debug(`[llmwiki] deep_research: starting for query "${query.slice(0, 80)}"`);
  // Pre-research: check for existing sessions on this topic
  Zotero.debug(`[llmwiki] deep_research: searching past sessions for "${query.slice(0, 60)}"`);
  const existingSessions = searchSessions(query);
  Zotero.debug(`[llmwiki] deep_research: found ${existingSessions.length} existing sessions`);
  if (existingSessions.length > 0) {
    const bestMatch = existingSessions[0];
    Zotero.debug(`[llmwiki] deep_research: found existing session "${bestMatch.title}"`);
    const oldSession = loadSession(bestMatch.slug);
    if (oldSession) {
      state.messages.push({
        role: "user",
        content: [
          `A previous research session exists for this topic (slug: ${bestMatch.slug}).`,
          "",
          "## Previous Report Summary",
          oldSession.report.slice(0, 1500) + (oldSession.report.length > 1500 ? "\n...(truncated)" : ""),
          "",
          "## Previous Meta-Analysis (Key Points)",
          oldSession.meta_analysis.slice(0, 1000) + (oldSession.meta_analysis.length > 1000 ? "\n...(truncated)" : ""),
          "",
          "## Your Task",
          "1. Search the wiki for NEW papers on this topic that may have been added since",
          "2. Read any newly found papers",
          "3. Produce a COMPLETE updated report that merges old findings with new discoveries",
          "4. End with a full # Research: report (same format as before)",
          "5. The report MUST be comprehensive — include all findings, both old and new",
        ].join("\n"),
      });
      _researchTrace = { initial_query: query, steps: [], existingSessionSlug: bestMatch.slug };
    }
  }
  const thinkingEl = addThinking();
  const maxRounds = MAX_TOOL_ROUNDS_DEEP;
  const maxSearches = MAX_SEARCHES_DEEP;
  Zotero.debug(`[llmwiki] deep_research: calling LLM (${state.messages.length} messages)`);
  let response = await callLLM(state.messages);
  Zotero.debug(`[llmwiki] deep_research: initial response — content=${!!response.content}, tool_calls=${response.tool_calls?.length || 0}`);
  let round = 0;
  let searchCount = 0;
  let readCount = 0;
  let wikiUpdateCount = 0;
  const MAX_READS = 8;
  const MAX_WIKI_UPDATES = 3;
  _rawFlag = false;

  try {
    // Tool calling loop with expanded limits
    while (response.tool_calls && response.tool_calls.length > 0 && round < maxRounds) {
      round++;
      Zotero.debug(`[llmwiki] deep_research: round ${round}, ${response.tool_calls.length} tool calls, ${searchCount} searches`);
      state.messages.push({
        role: "assistant",
        content: response.content || "",
        tool_calls: response.tool_calls,
        ...response.rawMessage,
      } as ChatMessage);

      for (const tc of response.tool_calls) {
        if ((tc.function.name === "search_wiki") && searchCount >= maxSearches) {
          state.messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: "Search limit reached. Synthesize your findings now and produce the final report.",
          });
          continue;
        }
        if (tc.function.name === "search_wiki") searchCount++;
        if (tc.function.name === "read_page") {
          if (readCount >= MAX_READS) {
            state.messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: "Read limit reached (8 papers). You have enough information — synthesize your report now.",
            });
            continue;
          }
          readCount++;
        }
        if (tc.function.name === "update_wiki_section") {
          if (wikiUpdateCount >= MAX_WIKI_UPDATES) {
            state.messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: "Wiki update limit reached (3 updates). Focus on research — stop updating wiki pages.",
            });
            continue;
          }
          wikiUpdateCount++;
        }
        if (tc.function.name === "search_wiki" || tc.function.name === "read_page") {
          _researchTrace.steps.push({
            type: tc.function.name === "search_wiki" ? "search" : "read",
            details: tc.function.arguments || "",
          });
        }
        let result = await executeToolCall(tc);
        // Truncate large tool results with stride — consecutive calls advance through content
        const maxResultLen = _deepResearchMode ? 3000 : 8000;
        if (result.length > maxResultLen) {
          const toolName = tc.function.name;
          // Extract TOC so LLM can see structure even when content is truncated
          const toc = buildTOC(toolName, result);
          // Per-page stride for read_page, global stride for search_wiki
          let offset = 0;
          if (toolName === "read_page") {
            const args = JSON.parse(tc.function.arguments || "{}");
            const slug = args.slug || "";
            _strideState.readPage[slug] = (_strideState.readPage[slug] || 0) + 1;
            offset = ((_strideState.readPage[slug] - 1) * maxResultLen) % result.length;
          } else if (toolName === "search_wiki") {
            _strideState.searchWiki++;
            offset = (_strideState.searchWiki * maxResultLen) % result.length;
          } else if (toolName === "search_sessions") {
            _strideState.searchSessions++;
            offset = (_strideState.searchSessions * maxResultLen) % result.length;
          }
          const end = Math.min(offset + maxResultLen, result.length);
          const prefix = offset > 0 ? `[...skipping ${offset} chars]\n` : "";
          const suffix = end < result.length ? `\n[...${result.length - end} more chars not shown]` : "";
          result = toc + prefix + result.slice(offset, end) + suffix;
        }
        state.messages.push({ role: "tool", tool_call_id: tc.id, content: result });
      }

      response = await callLLM(state.messages);
    }

    // Raw flag enrichment (same as normal mode)
    if (_rawFlag && response.content) {
      state.messages.push({ role: "user", content: "If raw layer info is missing from wiki, call update_wiki_section. Then continue your report." });
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

    let report = response.content || "";
    Zotero.debug(`[llmwiki] deep_research: loop ended, round=${round}, reportLen=${report.length}`);

    // Force full report if LLM returned too little (common when old session context was injected)
    if (report.length < 500) {
      state.messages.push({
        role: "user",
        content: "Your response is too short. Produce a COMPLETE # Research: report now, following the format in the system prompt. Include Summary, Key Findings, Analysis by Topic, and References sections. Cite all relevant papers with [[wikilinks]]. Do NOT summarize — write the full report.",
      });
      const forcedResp = await callLLM(state.messages);
      if (forcedResp.content) {
        report = forcedResp.content;
        response = forcedResp;
      }
    }

    if (!report && round >= maxRounds) {
      addAssistantMessage("Deep research reached the round limit without producing a report. Try a more specific question.");
      _deepResearchMode = false;
      _researchTrace = { initial_query: "", steps: [] };
      state.busy = false;
      updateSendButton();
      return;
    }

    // Display report
    addAssistantMessage(report);
    state.messages.push({ role: "assistant", content: report, ...response.rawMessage } as ChatMessage);

    // Step 2: Generate meta-analysis
    const thinkingEl2 = addThinking();
    try {
      const metaAnalysis = await generateMetaAnalysis(report, _researchTrace);
      Zotero.debug(`[llmwiki] deep_research: meta-analysis generated, ${metaAnalysis.length} chars`);
      if (thinkingEl2) thinkingEl2.remove();

      // Parse report for title, papers, tags
      const titleMatch = report.match(/^# Research:\s*(.+)$/m);
      const sessionTitle = titleMatch ? titleMatch[1].trim() : query.slice(0, 60);
      const paperRefs = [...report.matchAll(/\[\[papers\/([^\]|]+)/g)].map(m => `papers/${m[1]}`);
      const conceptRefs = [...report.matchAll(/\[\[concepts\/([^\]|]+)/g)].map(m => `concepts/${m[1]}`);
      const tagWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 3);

      // Save session
      Zotero.debug(`[llmwiki] deep_research: saving session (existingSlug=${_researchTrace.existingSessionSlug || "new"})`);
      const slug = saveSession({
        title: sessionTitle,
        query,
        report,
        meta_analysis: metaAnalysis,
        trace: _researchTrace,
        papers_referenced: [...new Set(paperRefs)].slice(0, 20),
        concepts_referenced: [...new Set(conceptRefs)].slice(0, 20),
        tags: tagWords.slice(0, 5),
        existingSlug: _researchTrace.existingSessionSlug,
      });
      Zotero.debug(`[llmwiki] deep_research: session saved as ${slug}`);

      const dataDir = getWikiBaseDir().replace(/\/wiki$/, "");
      addAssistantMessage(`Research session saved. Run \`cat ${dataDir}/research-sessions/${slug}.md\` to view the full report and meta-analysis.`);

    } catch (e: any) {
      if (thinkingEl2) thinkingEl2.remove();
      Zotero.debug(`[llmwiki] meta-analysis failed (non-blocking): ${e.message}`);
    }

  } catch (e: any) {
    if (thinkingEl) thinkingEl.remove();
    Zotero.debug(`[llmwiki] deep_research error: ${e.message || String(e)}`);
    addAssistantMessage(`Deep research error: ${e.message || String(e)}`);
  }

  _deepResearchMode = false;
  _researchTrace = { initial_query: "", steps: [] };
  state.busy = false;
  updateSendButton();
}

// ─── Send Handler ───

async function handleSend(): Promise<void> {
  if (state.busy || !state.inputEl) return;
  const text = state.inputEl.value.trim();
  if (!text) return;

  state.inputEl.value = "";

  // ─── Slash Commands ───

  if (text === "/clear") {
    state.messages = [];
    resetStrideState();
    clearToolStatus();
    clearChatDOM();
    state.busy = false;
    updateSendButton();
    return;
  }

  if (text === "/compact") {
    compactConversation();
    state.busy = false;
    updateSendButton();
    return;
  }

  if (text === "/save") {
    saveConversation();
    state.busy = false;
    updateSendButton();
    return;
  }

  if (text.startsWith("/deep_research") || text.startsWith("/deepresearch") || text === "/dr") {
    let query: string;
    if (text === "/dr") {
      addAssistantMessage("Usage: /deep_research <research question>");
      state.busy = false;
      updateSendButton();
      return;
    }
    if (text.startsWith("/deep_research")) {
      query = text.slice("/deep_research".length).trim();
    } else {
      query = text.slice("/deepresearch".length).trim();
    }
    if (!query) {
      addAssistantMessage("Usage: /deep_research <research question>");
      state.busy = false;
      updateSendButton();
      return;
    }
    _deepResearchMode = true;
    _researchTrace = { initial_query: query, steps: [] };
    state.messages = [];
    resetStrideState();
    clearToolStatus();
    clearChatDOM();
    const sysPrompt = buildSystemPrompt();
    state.messages.push({ role: "system", content: sysPrompt });
    state.messages.push({ role: "user", content: query });
    addUserMessage(query);

    // Deep research activation banner
    if (state.chatEl && state.doc) {
      const banner = state.doc.createElement("div");
      banner.className = "llmwiki-msg llmwiki-msg-system";
      banner.style.cssText = "background:#e8f0fe; color:#1a56db; font-weight:600; padding:10px 16px; border-radius:8px; border-left:4px solid #1a56db;";
      banner.textContent = `Deep Research: ${query}`;
      state.chatEl.appendChild(banner);
      scrollToBottom();
    }

    state.busy = true;
    updateSendButton();
    executeDeepResearch(query).catch((e: any) => {
      Zotero.debug(`[llmwiki] deep_research unhandled error: ${e?.message || e}`);
      addAssistantMessage(`Deep research error: ${e?.message || String(e)}`);
      _deepResearchMode = false;
      state.busy = false;
      updateSendButton();
    });
    return;
  }

  state.busy = true;
  updateSendButton();

  state.messages.push({ role: "user", content: text });
  addUserMessage(text);

  const thinkingEl = addThinking();

  try {
    // Initialize conversation if first message
    if (state.messages.length === 1) {
      state.messages.unshift({ role: "system", content: buildSystemPrompt() });
    }

    // Tool calling loop — iterate until we get a text response
    const maxRounds = _deepResearchMode ? MAX_TOOL_ROUNDS_DEEP : MAX_TOOL_ROUNDS_NORMAL;
    const maxSearches = _deepResearchMode ? MAX_SEARCHES_DEEP : MAX_SEARCHES_NORMAL;
    let response = await callLLM(state.messages);
    let round = 0;
    let searchCount = 0;
    _rawFlag = false;

    while (
      response.tool_calls &&
      response.tool_calls.length > 0 &&
      round < maxRounds
    ) {
      round++;
      // Add assistant message preserving all API fields
      state.messages.push({
        role: "assistant",
        content: response.content || "",
        tool_calls: response.tool_calls,
        ...response.rawMessage,
      } as ChatMessage);

      // Execute tools
      for (const tc of response.tool_calls) {
        if (
          (tc.function.name === "search_wiki" ||
            tc.function.name === "search_raw") &&
          searchCount >= maxSearches
        ) {
          state.messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content:
              "Search limit reached. You have enough information — please answer the user's question NOW based on what you already know.",
          });
          continue;
        }
        if (
          tc.function.name === "search_wiki" ||
          tc.function.name === "search_raw"
        )
          searchCount++;
        const result = await executeToolCall(tc);
        state.messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: result,
        });
      }

      response = await callLLM(state.messages);
    }

    // After tool loop, if raw was used, give one chance to enrich wiki + answer
    if (_rawFlag && response.content) {
      state.messages.push({
        role: "user",
        content:
          "If you found raw layer info missing from the wiki, call update_wiki_section now. Then give your final answer.",
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

    if (response.content) {
      // Detect internal reasoning masquerading as answer (DeepSeek quirk)
      const looksLikeReasoning = /^(Let me|I'll|I will|I found|I see|让我|我来|发现|让我来)/i.test(response.content.trim())
        && response.content.length < 300
        && !response.content.includes("##");
      if (looksLikeReasoning) {
        state.messages.push({
          role: "user",
          content: "Stop narrating your plans. Based on the search results you already have, answer my question directly. If you need to read a paper, call read_page. If you have enough info, just answer.",
        });
        const retryResp = await callLLM(state.messages);
        if (retryResp.content) {
          state.messages.push({ role: "assistant", content: retryResp.content, ...retryResp.rawMessage } as ChatMessage);
          addAssistantMessage(retryResp.content);
        }
      } else {
        state.messages.push({
          role: "assistant",
          content: response.content,
          ...response.rawMessage,
        } as ChatMessage);
        addAssistantMessage(response.content);
      }
    } else if (round >= maxRounds) {
      addAssistantMessage(
        "I ran too many tool calls without reaching a conclusion. Please try a more specific question.",
      );
    }
  } catch (e: any) {
    if (thinkingEl) thinkingEl.remove();
    addAssistantMessage(`Error: ${e.message || String(e)}`);
  }

  state.busy = false;
  updateSendButton();
}

// ─── Slash Commands ───

function clearChatDOM(): void {
  if (!state.chatEl || !state.doc) return;
  while (state.chatEl.firstChild)
    state.chatEl.removeChild(state.chatEl.firstChild);
  const welcome = state.doc.createElement("div");
  welcome.className = "llmwiki-msg llmwiki-msg-assistant";
  const wikiPath = getWikiBaseDir();
  renderMarkdownTo(
    welcome,
    `Conversation cleared.\n\nHello! I can search your wiki, read papers, list your library, and compile new papers. Ask me anything about your research.\n\nWiki files are stored at: \`${wikiPath}/\``,
  );
  state.chatEl.appendChild(welcome);
}

function compactConversation(): void {
  if (!state.chatEl || !state.doc) return;
  // Keep system prompt + last 3 exchanges (6 messages)
  const systemMsg =
    state.messages[0]?.role === "system" ? [state.messages[0]] : [];
  const recentMsgs = state.messages.slice(-6);
  const dropped = state.messages.length - systemMsg.length - recentMsgs.length;
  state.messages = [...systemMsg, ...recentMsgs];

  // Rebuild chat DOM
  while (state.chatEl.firstChild)
    state.chatEl.removeChild(state.chatEl.firstChild);

  const summary = state.doc.createElement("div");
  summary.className = "llmwiki-msg llmwiki-msg-system";
  summary.textContent =
    dropped > 0
      ? `Compacted: dropped ${dropped} older messages, kept last ${recentMsgs.length}`
      : "Nothing to compact";
  state.chatEl.appendChild(summary);

  // Re-render kept messages
  const first = true;
  for (const msg of state.messages) {
    if (msg.role === "system") continue;
    if (msg.role === "user") addUserMessage(msg.content);
    else if (msg.role === "assistant") addAssistantMessage(msg.content);
  }
}

function saveConversation(): void {
  if (!state.chatEl || !state.doc) return;
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const convDir = `${getWikiBaseDir()}/../conversations`;
  makeDir(convDir);
  const filePath = `${convDir}/${ts}.md`;

  let md = `# Conversation ${ts}\n\n`;
  for (const msg of state.messages) {
    if (msg.role === "system") {
      md += `> *System prompt not shown*\n\n`;
    } else if (msg.role === "user") {
      md += `**User:** ${msg.content}\n\n`;
    } else if (msg.role === "assistant") {
      const preview =
        msg.content.length > 2000
          ? msg.content.slice(0, 5000) + "..."
          : msg.content;
      md += `**Agent:** ${preview}\n\n`;
    } else if (msg.role === "tool") {
      md += `> Tool result (${msg.tool_call_id || "?"}): ${msg.content}\n\n`;
    }
  }

  writeFile(filePath, md);

  const note = state.doc.createElement("div");
  note.className = "llmwiki-msg llmwiki-msg-system";
  note.textContent = `Conversation saved to ${filePath}`;
  state.chatEl.appendChild(note);
}

function updateSendButton(): void {
  if (state.sendBtn) state.sendBtn.disabled = state.busy;
}

// ─── Content TOC Extractor ───

function buildTOC(toolName: string, content: string): string {
  if (toolName === "read_page") {
    // Extract ## section headings as TOC
    const headings = content.match(/^##\s+.+$/gm);
    if (!headings || headings.length === 0) return "";
    return `[Sections: ${headings.map(h => h.replace(/^##\s+/, "")).join(" | ")}]\n\n`;
  }
  if (toolName === "read_session") {
    const headings = content.match(/^#+\s+.+$/gm);
    if (!headings || headings.length === 0) return "";
    return `[Sections: ${headings.map(h => h.replace(/^#+\s+/, "").trim()).join(" > ")}]\n\n`;
  }
  if (toolName === "search_wiki") {
    // Extract paper titles from search results
    const titles = content.match(/^\*\*([^*]+)\*\*/gm);
    if (!titles || titles.length === 0) return "";
    const count = titles.length;
    return `[${count} papers found: ${titles.slice(0, 5).map(t => t.replace(/\*\*/g, "")).join(" | ")}${count > 5 ? ` | ...+${count - 5} more` : ""}]\n\n`;
  }
  return "";
}

// ─── Tool Execution ───

async function executeToolCall(tc: ToolCall): Promise<string> {
  const name = tc.function.name;
  const args = JSON.parse(tc.function.arguments || "{}");
  const card = addToolCard(name, args);

  try {
    let result: string;
    switch (name) {
      case "search_wiki": {
        const hits = searchPages(args.query || "");
        if (hits.length === 0) {
          // Auto-fallback to raw layer
          const rawHits = searchRaw(args.query || "");
          if (rawHits.length > 0) {
            _rawFlag = true;
            result = `No wiki results, but raw layer found:\n${rawHits.map((h: SearchResult) => `- **${h.title}** (${h.slug})\n  ${h.snippet}`).join("\n\n")}`;
          } else {
            result = `No results found for "${args.query}" in wiki or raw layer.`;
          }
        } else {
          result = hits
            .map(
              (h: SearchResult) =>
                `- **${h.title}** (${h.filePath})\n  ${h.snippet}`,
            )
            .join("\n\n");
          // Also append raw results if available
          const rawHits = searchRaw(args.query || "");
          if (rawHits.length > 0) {
            _rawFlag = true;
            result += `\n\nRaw layer also found:\n${rawHits.map((h: SearchResult) => `- **${h.title}** (${h.slug})\n  ${h.snippet}`).join("\n\n")}`;
          }
        }
        break;
      }
      case "read_page": {
        const slug = (args.slug || "").replace(/\.md$/, "");
        const path = slug.includes("/") ? `${slug}.md` : `papers/${slug}.md`;
        const page = readPage(path);
        result = page
          ? `# ${page.frontmatter["title"] || path}\n\n${page.body}`
          : `Page not found: "${args.slug}". Right-click a paper in Zotero and select "LLM Wiki: Ingest" to compile it first.`;
        break;
      }
      case "list_papers": {
        const papers = parseIndex();
        result =
          papers.length === 0
            ? "No papers in the knowledge base yet."
            : papers
                .map(
                  (p: IndexEntry) =>
                    `- (${p.year}) **${p.title}** — ${p.summary}`,
                )
                .join("\n");
        break;
      }
      case "ingest_selected": {
        const items = ZoteroPane.getSelectedItems();
        if (!items || items.length === 0) {
          result =
            "No items selected in Zotero. Please select one or more papers first.";
        } else {
          const titles: string[] = [];
          for (const item of items) {
            if (item.isRegularItem?.() && !(item as any).isFeedItem) {
              await runIngest(item);
              titles.push(item.getField("title") || "Unknown");
            }
          }
          result =
            titles.length === 0
              ? "No regular items selected."
              : `Compiled ${titles.length} paper(s):\n${titles.map((t: string) => `- ${t}`).join("\n")}`;
        }
        break;
      }
      case "update_wiki_section": {
        appendToSection(
          args.slug || "",
          args.section || "Additional Notes",
          args.content || "",
        );
        result = `Wiki updated. Now answer the user's original question.`;
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
      case "list_concepts": {
        const filterType = (args.type || "all") as string;
        const nodes = listGraphNodes(filterType);
        if (nodes.length === 0) {
          result = "No concepts or entities found in the knowledge base yet. Ingest some papers first to auto-extract them.";
        } else {
          result = nodes.map(n =>
            `- **${n.name}** (${n.slug}) [${n.type}] — ${n.paperCount} papers`
          ).join("\n");
        }
        break;
      }
      case "get_related_papers": {
        const cSlug = (args.slug || "").replace(/\.md$/, "");
        const papers = getRelatedPapers(cSlug);
        if (papers.length === 0) {
          result = `No papers reference "${cSlug}". Try ingesting more papers or checking for related concepts.`;
        } else {
          result = `Papers referencing *${cSlug}*:\n${papers.map((p: { title: string; slug: string; relevance: string }) => `- **${p.title}** (${p.slug})\n  ${p.relevance}`).join("\n")}`;
        }
        break;
      }
      case "find_connections": {
        const source = (args.source || "").replace(/\.md$/, "");
        const target = args.target ? String(args.target).replace(/\.md$/, "") : undefined;
        result = findConnections(source, target);
        break;
      }
      default:
        result = `Unknown tool: ${name}`;
    }
    card.update("complete", result);
    return result;
  } catch (e: any) {
    card.update("failed", `Error: ${e.message || String(e)}`);
    return `Tool error: ${e.message || String(e)}`;
  }
}

// ─── Tool Status Indicator (single line, updates in-place) ───

interface ToolCard {
  el: HTMLElement;
  update(resultState: "complete" | "failed", detail: string): void;
}

const TOOL_ICONS: Record<string, string> = {
  search_wiki: "🔍", read_page: "📖", list_papers: "📋",
  ingest_selected: "⚡", update_wiki_section: "✏️",
  search_sessions: "📂", read_session: "📄", find_connections: "🔗",
  get_related_papers: "📎", list_concepts: "🏷️",
};
const TOOL_LABELS: Record<string, string> = {
  search_wiki: "search", read_page: "read", list_papers: "list",
  ingest_selected: "ingest", update_wiki_section: "update wiki",
  search_sessions: "search sessions", read_session: "read session",
  find_connections: "connections", get_related_papers: "related papers",
  list_concepts: "concepts",
};

function addToolCard(name: string, args: Record<string, unknown>): ToolCard {
  _toolCount++;
  let brief = "";
  try {
    if (args.query) brief = `"${String(args.query).slice(0, 40)}"`;
    else if (args.slug) brief = String(args.slug).slice(0, 40);
    else if (args.section) brief = `${args.section}`;
  } catch { /* ignore */ }

  if (!state.chatEl || !state.doc) {
    return { el: {} as HTMLElement, update: () => {} };
  }
  const doc = state.doc;

  // Singleton status line — create once, update in-place
  if (!_toolStatusEl || !_toolStatusEl.parentNode) {
    _toolStatusEl = doc.createElement("div");
    _toolStatusEl.className = "llmwiki-tool-status";
    state.chatEl.appendChild(_toolStatusEl);
  }
  // Clear previous content
  while (_toolStatusEl.firstChild) _toolStatusEl.removeChild(_toolStatusEl.firstChild);

  const iconEl = doc.createElement("span");
  iconEl.textContent = TOOL_ICONS[name] || "🔧";

  const labelEl = doc.createElement("span");
  labelEl.textContent = `${TOOL_LABELS[name] || name} ${brief}`;

  const countEl = doc.createElement("span");
  countEl.style.cssText = "font-size:10px; color:var(--text-secondary,#999);";
  countEl.textContent = `· ${_toolCount}`;

  _toolStatusEl.appendChild(iconEl);
  _toolStatusEl.appendChild(labelEl);
  _toolStatusEl.appendChild(countEl);
  scrollToBottom();

  return {
    el: _toolStatusEl,
    update(_resultState: string, _detail: string) {
      // Update icon on completion
      if (iconEl.parentNode) {
        iconEl.textContent = _resultState === "failed" ? "❌" : TOOL_ICONS[name] || "🔧";
      }
    },
  };
}

function resetStrideState(): void {
  _strideState.searchWiki = 0;
  _strideState.searchSessions = 0;
  _strideState.readPage = {};
}

function clearToolStatus(): void {
  if (_toolStatusEl) {
    _toolStatusEl.remove();
    _toolStatusEl = null;
    _toolStatusDetailEl = null;
  }
  _toolCount = 0;
}
