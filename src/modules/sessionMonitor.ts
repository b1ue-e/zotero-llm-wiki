import { makeDir, writeFile, readBinaryFile } from "../utils/xpcom";

// ─── Types ───

interface MonitorEvent {
  type: string;
  timestamp: number;
  context: Record<string, unknown>;
}

interface SignalRecord {
  signal: string;
  timestamp: string;
  severity: "warning" | "error";
  context: Record<string, unknown>;
  session_summary: Record<string, unknown>;
  raw_messages: string[];
}

// ─── Ring Buffer ───

const BUFFER_SIZE = 20;
const buffer: MonitorEvent[] = [];

function pushEvent(event: MonitorEvent): void {
  buffer.push(event);
  if (buffer.length > BUFFER_SIZE) buffer.shift();
}

// ─── Path Helpers ───

function getFeedbackDir(): string {
  let dataPath = Zotero.Prefs.get("dataDir") as string;
  if (!dataPath) {
    const storagePath = Zotero.getStorageDirectory().path;
    dataPath = storagePath.substring(0, storagePath.lastIndexOf("/"));
  }
  return `${dataPath}/llm-wiki/feedback`;
}

function ensureFeedbackDir(): void {
  makeDir(getFeedbackDir());
}

// ─── Similarity Helper ───

function bigramSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const getBigrams = (s: string): Set<string> => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const ba = getBigrams(a);
  const bb = getBigrams(b);
  let intersection = 0;
  ba.forEach(bg => { if (bb.has(bg)) intersection++; });
  const union = new Set([...ba, ...bb]).size;
  return union === 0 ? 0 : intersection / union;
}

// ─── Detectors ───

function detectRepeatQuestion(): SignalRecord | null {
  const userMsgs = buffer.filter(e => e.type === "user_message");
  if (userMsgs.length < 2) return null;
  const last = userMsgs[userMsgs.length - 1].context.text as string;
  const prev = userMsgs[userMsgs.length - 2].context.text as string;
  const sim = bigramSimilarity(last, prev);
  if (sim < 0.80) return null;
  return {
    signal: "repeat_question",
    timestamp: new Date().toISOString(),
    severity: "warning",
    context: {
      user_messages: [prev.slice(0, 200), last.slice(0, 200)],
      similarity: Math.round(sim * 100) / 100,
    },
    session_summary: buildSummary(),
    raw_messages: buildRawMessages(),
  };
}

const FRUSTRATION_RE = /不对|wrong|no|错了|重新|重来|不行|不对的/i;

function detectUserFrustration(ctx: Record<string, unknown>): SignalRecord | null {
  const text = (ctx.text as string) || "";
  if (!FRUSTRATION_RE.test(text)) return null;
  return {
    signal: "user_frustration",
    timestamp: new Date().toISOString(),
    severity: "warning",
    context: {
      user_message: text.slice(0, 200),
      previous_assistant_response: getLastAssistantContent(),
    },
    session_summary: buildSummary(),
    raw_messages: buildRawMessages(),
  };
}

function detectShortReport(ctx: Record<string, unknown>): SignalRecord | null {
  const reportLen = (ctx.reportLen as number) || 0;
  if (reportLen >= 300) return null;
  return {
    signal: "short_report",
    timestamp: new Date().toISOString(),
    severity: "warning",
    context: {
      reportLen,
      rounds: ctx.rounds,
      searches: ctx.searches,
    },
    session_summary: buildSummary(),
    raw_messages: buildRawMessages(),
  };
}

const REASONING_LEAK_RE = /^(Let me|I'll|I will|I found|I see|让我|我来|发现|让我来)/i;

function detectReasoningLeak(ctx: Record<string, unknown>): SignalRecord | null {
  const text = (ctx.text as string) || "";
  if (text.length >= 300) return null;
  if (!REASONING_LEAK_RE.test(text.trim())) return null;
  return {
    signal: "reasoning_leak",
    timestamp: new Date().toISOString(),
    severity: "warning",
    context: { leaked_text: text.slice(0, 300) },
    session_summary: buildSummary(),
    raw_messages: buildRawMessages(),
  };
}

function detectToolFailureChain(): SignalRecord | null {
  const toolEvents = buffer.filter(e => e.type === "tool_result");
  if (toolEvents.length < 3) return null;
  const last3 = toolEvents.slice(-3);
  const failures = last3.filter(e => e.context.success === false).length;
  if (failures < 2) return null;
  return {
    signal: "tool_failure_chain",
    timestamp: new Date().toISOString(),
    severity: "error",
    context: {
      recent_tools: last3.map(e => ({
        name: e.context.name,
        success: e.context.success,
        error: (e.context.error as string)?.slice(0, 100) || "",
      })),
    },
    session_summary: buildSummary(),
    raw_messages: buildRawMessages(),
  };
}

function detectApiFault(ctx: Record<string, unknown>): SignalRecord | null {
  return {
    signal: "api_fault",
    timestamp: new Date().toISOString(),
    severity: "error",
    context: {
      status: ctx.status,
      message: (ctx.message as string)?.slice(0, 200) || "",
    },
    session_summary: buildSummary(),
    raw_messages: buildRawMessages(),
  };
}

// ─── Summary Builders ───

function buildSummary(): Record<string, unknown> {
  const userMsgs = buffer.filter(e => e.type === "user_message").length;
  const toolCalls = buffer.filter(e => e.type === "tool_result");
  const deepResearch = buffer.some(e => e.type === "deep_research_done");
  return {
    total_events: buffer.length,
    user_messages: userMsgs,
    tools_called: toolCalls.map(e => `${e.context.name}: ${e.context.success ? "ok" : "fail"}`),
    deep_research_active: deepResearch,
  };
}

function buildRawMessages(): string[] {
  return buffer.slice(-10).map(e => {
    const role = e.type === "user_message" ? "user"
      : e.type === "assistant_response" ? "assistant" : e.type;
    const preview = JSON.stringify(e.context).slice(0, 100);
    return `[${role}] ${preview}`;
  });
}

function getLastAssistantContent(): string {
  const last = [...buffer].reverse().find(e => e.type === "assistant_response");
  return ((last?.context.text) as string)?.slice(0, 200) || "";
}

// ─── Snapshot Writer ───

function logSessionSnapshot(signal: SignalRecord): void {
  try {
    ensureFeedbackDir();
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const slug = `${ts}-${signal.signal}`;
    const path = `${getFeedbackDir()}/${slug}.json`;
    writeFile(path, JSON.stringify(signal, null, 2));
    purgeOldSnapshots();
  } catch (_e) {
    // Never throw — feedback logging is non-blocking
  }
}

function purgeOldSnapshots(): void {
  try {
    const dir = getFeedbackDir();
    // @ts-expect-error - Mozilla XPCOM
    const nsIFile = Components.classes["@mozilla.org/file/local;1"]
      .createInstance(Components.interfaces.nsIFile) as any;
    nsIFile.initWithPath(dir);
    if (!nsIFile.exists() || !nsIFile.isDirectory()) return;
    const files: { path: string; time: number }[] = [];
    const enumerator = nsIFile.directoryEntries;
    while (enumerator.hasMoreElements()) {
      const raw = enumerator.getNext();
      const file = raw.QueryInterface(Components.interfaces.nsIFile);
      if (file && file.path && file.path.endsWith(".json")) {
        files.push({ path: file.path, time: file.lastModifiedTime });
      }
    }
    enumerator.close();
    if (files.length <= 50) return;
    files.sort((a, b) => a.time - b.time);
    for (let i = 0; i < files.length - 50; i++) {
      try {
        // @ts-expect-error - Mozilla XPCOM
        const f = Components.classes["@mozilla.org/file/local;1"]
          .createInstance(Components.interfaces.nsIFile) as any;
        f.initWithPath(files[i].path);
        if (f.exists()) f.remove(false);
      } catch (_) { /* skip */ }
    }
  } catch (_) {
    // Non-blocking
  }
}

// ─── Public API ───

export function track(event: string, context: Record<string, unknown>): void {
  try {
    pushEvent({ type: event, timestamp: Date.now(), context });

    let signal: SignalRecord | null = null;

    if (event === "user_message") {
      signal = detectRepeatQuestion() || detectUserFrustration(context);
    } else if (event === "deep_research_done") {
      signal = detectShortReport(context);
    } else if (event === "assistant_response") {
      signal = detectReasoningLeak(context);
    } else if (event === "tool_result" && context.success === false) {
      signal = detectToolFailureChain();
    } else if (event === "api_error") {
      signal = detectApiFault(context);
    }

    if (signal) {
      logSessionSnapshot(signal);
    }
  } catch (_e) {
    // Never throw — monitoring must not break the agent
  }
}

export function getSignalHistory(): SignalRecord[] {
  const results: SignalRecord[] = [];
  try {
    const dir = getFeedbackDir();
    // @ts-expect-error - Mozilla XPCOM
    const nsIFile = Components.classes["@mozilla.org/file/local;1"]
      .createInstance(Components.interfaces.nsIFile) as any;
    nsIFile.initWithPath(dir);
    if (!nsIFile.exists()) return results;
    const enumerator = nsIFile.directoryEntries;
    while (enumerator.hasMoreElements()) {
      const raw = enumerator.getNext();
      const file = raw.QueryInterface(Components.interfaces.nsIFile);
      if (file && file.path && file.path.endsWith(".json")) {
        const content = readBinaryFile(file.path);
        if (content) {
          try { results.push(JSON.parse(content) as SignalRecord); } catch (_) { /* skip */ }
        }
      }
    }
    enumerator.close();
  } catch (_) { /* skip */ }
  return results;
}
