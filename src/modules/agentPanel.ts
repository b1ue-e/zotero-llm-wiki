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
    resize: none; background: var(--fill-primary, #fff); color: inherit;
    font-family: inherit; }
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
    background: var(--fill-secondary, #f0f0f0); color: inherit; }
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
  const welcome = doc.createElement("div");
  welcome.className = "llmwiki-msg llmwiki-msg-assistant";
  welcome.textContent = "Hello! I can search your wiki, read papers, list your library, and compile new papers. Ask me anything about your research.";
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
  const el = state.doc.createElement("div");
  el.className = "llmwiki-msg llmwiki-msg-assistant";
  el.textContent = text;
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
        reject(new Error(`API error (${xhr.status})`));
        return;
      }
      try {
        const data = JSON.parse(xhr.responseText || "{}");
        const choice = data.choices?.[0]?.message;
        resolve({
          content: choice?.content || null,
          tool_calls: choice?.tool_calls || null,
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

    const response = await callLLM(state.messages);

    if (thinkingEl) thinkingEl.remove();

    if (response.tool_calls && response.tool_calls.length > 0) {
      // Add assistant message with tool calls
      state.messages.push({
        role: "assistant",
        content: response.content || "",
        tool_calls: response.tool_calls,
      });

      // Execute tools (stub — implemented in Task 3)
      for (const tc of response.tool_calls) {
        const result = await executeToolCall(tc);
        state.messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: result,
        });
      }

      // Get final response
      const thinkingEl2 = addThinking();
      const finalResponse = await callLLM(state.messages);

      if (thinkingEl2) thinkingEl2.remove();

      if (finalResponse.content) {
        state.messages.push({ role: "assistant", content: finalResponse.content });
        addAssistantMessage(finalResponse.content);
      }
    } else if (response.content) {
      state.messages.push({ role: "assistant", content: response.content });
      addAssistantMessage(response.content);
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

// ─── Stub (implemented in Task 3) ───

async function executeToolCall(_tc: ToolCall): Promise<string> {
  return "";
}
