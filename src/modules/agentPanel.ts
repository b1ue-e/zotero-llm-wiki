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
import { getWikiBaseDir, writeFile, makeDir } from "../utils/xpcom";
import { searchRaw } from "./rawStorage";
import { appendToSection } from "./wikiStorage";

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

export function renderAgentPanel({ body, doc }: { body: HTMLElement; doc: Document }): void {
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
  renderMarkdownTo(welcome, `Hello! I can search your wiki, read papers, list your library, and compile new papers. Ask me anything about your research.\n\nWiki files are stored at: \`${wikiPath}/\``);
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
        const isHeader = i + 1 < lines.length && /^\|[-:\s|]+\|$/.test(lines[i + 1]);
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
    while (i < lines.length && lines[i].trim() !== "" &&
           !/^```/.test(lines[i]) && !/^---+$/.test(lines[i].trim()) &&
           !/^#{1,4}\s+/.test(lines[i]) && !/^[-*]\s+/.test(lines[i]) &&
           !/^\d+\.\s+/.test(lines[i]) && !/^\|.+\|/.test(lines[i]) &&
           !/^>\s?/.test(lines[i])) {
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
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g);
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
  {
    type: "function",
    function: {
      name: "update_wiki_section",
      description: "Append new information to a specific section of a wiki page. Use this when raw data contains important knowledge not yet captured in the structured wiki page.",
      parameters: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Wiki page slug (e.g., 'papers/title-hash')" },
          section: { type: "string", description: "Section name: Research Question, Method, Key Findings, Conclusions, Limitations, Related Work" },
          content: { type: "string", description: "Markdown content to append to the section" },
        },
        required: ["slug", "section", "content"],
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
- Write in the same language the user uses.

## Wiki Enrichment
- Whenever you discover information missing from the wiki, call update_wiki_section IMMEDIATELY after your answer — do NOT ask permission, just do it
- If raw layer data has details the wiki lacks, enrich the relevant section proactively
- Section names: "Research Question", "Method", "Key Findings", "Conclusions", "Limitations", "Related Work"`;
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
    const MAX_TOOL_ROUNDS = 10;
    let response = await callLLM(state.messages);
    let round = 0;
    let searchCount = 0;
    _rawFlag = false;
    const MAX_SEARCHES = 5;

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
        if ((tc.function.name === "search_wiki" || tc.function.name === "search_raw") && searchCount >= MAX_SEARCHES) {
          state.messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: "Search limit reached. You have enough information — please answer the user's question NOW based on what you already know.",
          });
          continue;
        }
        if (tc.function.name === "search_wiki" || tc.function.name === "search_raw") searchCount++;
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
      state.messages.push({ role: "user", content: "If you found raw layer info missing from the wiki, call update_wiki_section now. Then give your final answer." });
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

// ─── Slash Commands ───

function clearChatDOM(): void {
  if (!state.chatEl || !state.doc) return;
  while (state.chatEl.firstChild) state.chatEl.removeChild(state.chatEl.firstChild);
  const welcome = state.doc.createElement("div");
  welcome.className = "llmwiki-msg llmwiki-msg-assistant";
  const wikiPath = getWikiBaseDir();
  renderMarkdownTo(welcome, `Conversation cleared.\n\nHello! I can search your wiki, read papers, list your library, and compile new papers. Ask me anything about your research.\n\nWiki files are stored at: \`${wikiPath}/\``);
  state.chatEl.appendChild(welcome);
}

function compactConversation(): void {
  if (!state.chatEl || !state.doc) return;
  // Keep system prompt + last 3 exchanges (6 messages)
  const systemMsg = state.messages[0]?.role === "system" ? [state.messages[0]] : [];
  const recentMsgs = state.messages.slice(-6);
  const dropped = state.messages.length - systemMsg.length - recentMsgs.length;
  state.messages = [...systemMsg, ...recentMsgs];

  // Rebuild chat DOM
  while (state.chatEl.firstChild) state.chatEl.removeChild(state.chatEl.firstChild);

  const summary = state.doc.createElement("div");
  summary.className = "llmwiki-msg llmwiki-msg-system";
  summary.textContent = dropped > 0
    ? `Compacted: dropped ${dropped} older messages, kept last ${recentMsgs.length}`
    : "Nothing to compact";
  state.chatEl.appendChild(summary);

  // Re-render kept messages
  let first = true;
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
      const preview = msg.content.length > 2000
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
          result = hits.map((h: SearchResult) =>
              `- **${h.title}** (${h.filePath})\n  ${h.snippet}`
            ).join("\n\n");
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
      case "update_wiki_section": {
        appendToSection(args.slug || "", args.section || "Additional Notes", args.content || "");
        result = `Wiki updated. Now answer the user's original question.`;
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

function addToolCard(name: string, _args: Record<string, unknown>): ToolCard {
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
  label.textContent = name;

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
