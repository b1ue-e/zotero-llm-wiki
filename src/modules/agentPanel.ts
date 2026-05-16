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

// ─── Stub (implemented in follow-up tasks) ───

async function handleSend(): Promise<void> {}
