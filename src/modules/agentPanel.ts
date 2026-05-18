import { marked } from "marked";
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
import { getWikiBaseDir } from "../utils/xpcom";

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
  .llmwiki-msg-user { align-self: flex-end;
    background: var(--accent-selected, #0060df); color: #fff; }
  .llmwiki-msg-assistant { align-self: flex-start;
    background: #dcf8c6; color: #222; }
  .llmwiki-msg-system { align-self: center; font-size: 12px;
    color: var(--text-secondary, #999); padding: 4px 8px; max-width: 100%; }
  .llmwiki-tool-card { background: var(--fill-tertiary, #f5f5f5); border-radius: 6px;
    margin: 4px 0; font-size: 12px; overflow: hidden; }
  .llmwiki-tool-card-header { display: flex; align-items: center; gap: 8px;
    padding: 6px 10px; cursor: pointer; }
  .llmwiki-tool-card-status { font-size: 14px; }
  .llmwiki-tool-card-body { padding: 6px 10px; border-top: 1px solid
    var(--fill-quaternary, #e0e0e0); display: none; font-family: monospace;
    font-size: 11px; max-height: 200px; overflow-y: auto; white-space: pre-wrap; }
  .llmwiki-tool-card.open .llmwiki-tool-card-body { display: block; }
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
  .llmwiki-msg hr { border: none; border-top: 1px solid var(--fill-quaternary, #ddd);
    margin: 8px 0; }
  .llmwiki-thinking { align-self: flex-start; color: var(--text-secondary, #999);
    font-size: 13px; padding: 8px 12px; }
`;

// ─── Public Entry Point ───

export function renderAgentPanel({ body, doc }: { body: HTMLElement; doc: Document }): void {
  if (!body) return;
  state.doc = doc;
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
  const xns = "http://www.w3.org/1999/xhtml";
  const welcome = doc.createElementNS(xns, "div");
  welcome.setAttribute("class", "llmwiki-msg llmwiki-msg-assistant");
  const wikiPath = getWikiBaseDir();
  welcome.innerHTML = marked.parse(`Hello! I can search your wiki, read papers, list your library, and compile new papers. Ask me anything about your research.\n\nWiki files are stored at: \`${wikiPath}/\``) as string;
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
  // Use XHTML namespace — innerHTML on XUL elements strips HTML tags
  const ns = "http://www.w3.org/1999/xhtml";
  const el = state.doc.createElementNS(ns, "div");
  el.setAttribute("class", "llmwiki-msg llmwiki-msg-assistant");
  try {
    el.innerHTML = marked.parse(text) as string;
  } catch (_e) {
    el.textContent = text;
  }
  state.chatEl.appendChild(el);
  scrollToBottom();
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
    return Promise.reject(new Error("API not configured. Check Preferences → LLM Wiki."));
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
        reject(new Error(`API error (${xhr.status}): ${xhr.responseText?.slice(0, 300) || ""}`));
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
      description: "Full-text search across all wiki pages. Returns matching papers with content snippets.",
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
      description: "Read the full content of a wiki page by its slug (e.g., 'papers/title-slug-hash').",
      parameters: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Page slug path like papers/slug" },
        },
        required: ["slug"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_papers",
      description: "List all papers in the knowledge base with titles, years, and summaries.",
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
      description: "Compile the currently selected Zotero items into wiki pages using the LLM.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
];

// ─── System Prompt ───

function buildSystemPrompt(): string {
  return `You are a research assistant with access to a personal wiki knowledge base containing structured summaries of academic papers.

## Available Tools
- search_wiki(query): Search all wiki pages for specific topics. Returns paper titles with content snippets.
- read_page(slug): Read the full content of a specific wiki page by its slug path.
- list_papers(): List all papers in the knowledge base with years and summaries.
- ingest_selected(): Compile the currently selected Zotero items into new wiki pages.

## Guidelines
- When asked about a topic, search the wiki first before answering.
- When comparing papers, read the relevant pages first, then provide your analysis.
- Cite papers using their exact titles when referencing them.
- If you cannot find relevant information, suggest that the user ingest related papers.
- Be concise, precise, and academic in your responses.
- Write in the same language the user uses.`;
}

// ─── Send Handler ───

async function handleSend(): Promise<void> {
  if (state.busy || !state.inputEl) return;
  const text = state.inputEl.value.trim();
  if (!text) return;

  state.inputEl.value = "";
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

    // Tool calling loop — iterate until we get a text response (max 5 rounds)
    const MAX_TOOL_ROUNDS = 5;
    let response = await callLLM(state.messages);
    let round = 0;

    while (response.tool_calls && response.tool_calls.length > 0 && round < MAX_TOOL_ROUNDS) {
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
        const result = await executeToolCall(tc);
        state.messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: result,
        });
      }

      response = await callLLM(state.messages);
    }

    if (thinkingEl) thinkingEl.remove();

    if (response.content) {
      state.messages.push({
        role: "assistant",
        content: response.content,
        ...response.rawMessage,
      } as ChatMessage);
      addAssistantMessage(response.content);
    } else if (round >= MAX_TOOL_ROUNDS) {
      addAssistantMessage("I ran too many tool calls without reaching a conclusion. Please try a more specific question.");
    }
  } catch (e: any) {
    if (thinkingEl) thinkingEl.remove();
    addAssistantMessage(`Error: ${e.message || String(e)}`);
  }

  state.busy = false;
  updateSendButton();
}

function updateSendButton(): void {
  if (state.sendBtn) state.sendBtn.disabled = state.busy;
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
        result = hits.length === 0
          ? `No results found for "${args.query}".`
          : hits.map((h: SearchResult) =>
              `- **${h.title}** (${h.filePath})\n  ${h.snippet}`
            ).join("\n\n");
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
        result = papers.length === 0
          ? "No papers in the knowledge base yet."
          : papers.map((p: IndexEntry) =>
              `- (${p.year}) **${p.title}** — ${p.summary}`
            ).join("\n");
        break;
      }
      case "ingest_selected": {
        const items = ZoteroPane.getSelectedItems();
        if (!items || items.length === 0) {
          result = "No items selected in Zotero. Please select one or more papers first.";
        } else {
          const titles: string[] = [];
          for (const item of items) {
            if (item.isRegularItem?.() && !(item as any).isFeedItem) {
              await runIngest(item);
              titles.push(item.getField("title") || "Unknown");
            }
          }
          result = titles.length === 0
            ? "No regular items selected."
            : `Compiled ${titles.length} paper(s):\n${titles.map((t: string) => `- ${t}`).join("\n")}`;
        }
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

// ─── Tool Card UI ───

interface ToolCard {
  el: HTMLElement;
  update(resultState: "complete" | "failed", detail: string): void;
}

function addToolCard(name: string, args: Record<string, unknown>): ToolCard {
  if (!state.chatEl || !state.doc) {
    return { el: state.doc ? state.doc.createElement("div") : ({} as HTMLElement), update: () => {} };
  }
  const doc = state.doc;

  const card = doc.createElement("div");
  card.className = "llmwiki-tool-card";

  const header = doc.createElement("div");
  header.className = "llmwiki-tool-card-header";

  const statusEl = doc.createElement("span");
  statusEl.className = "llmwiki-tool-card-status";
  statusEl.textContent = "⏳";

  const label = doc.createElement("span");
  const argStr = Object.entries(args).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ");
  label.textContent = `${name}(${argStr})`;

  header.appendChild(statusEl);
  header.appendChild(label);

  header.addEventListener("click", () => {
    card.classList.toggle("open");
  });

  const bodyEl = doc.createElement("div");
  bodyEl.className = "llmwiki-tool-card-body";
  bodyEl.textContent = "Running...";

  card.appendChild(header);
  card.appendChild(bodyEl);
  state.chatEl.appendChild(card);
  scrollToBottom();

  return {
    el: card,
    update(resultState: "complete" | "failed", detail: string) {
      statusEl.textContent = resultState === "complete" ? "✅" : "❌";
      bodyEl.textContent = detail;
      if (resultState === "failed") card.classList.add("open");
    },
  };
}
