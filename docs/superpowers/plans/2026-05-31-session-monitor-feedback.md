# Session Monitor — Feedback Auto-Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically detect 6 types of anomalous conversation signals and save session snapshots to `llm-wiki/feedback/` for post-hoc analysis.

**Architecture:** New module `src/modules/sessionMonitor.ts` maintains a 20-event ring buffer, runs 6 independent signal detectors on each new event, and writes JSON snapshots to disk when any detector fires. `agentPanel.ts` adds 5 `track()` calls at key touch points — fire-and-forget, never blocking.

**Tech Stack:** TypeScript, Firefox XPCOM file I/O, binary JSON write

---

## File Structure

| File | Action | Purpose |
|------|--------|---------|
| `src/modules/sessionMonitor.ts` | Create | Ring buffer, 6 detectors, snapshot writer, `track()` API |
| `src/modules/agentPanel.ts` | Modify | Add 5 `track()` calls at integration points |

---

### Task 1: Create sessionMonitor.ts module

**Files:**
- Create: `src/modules/sessionMonitor.ts`

- [ ] **Step 1: Write the module**

Create `src/modules/sessionMonitor.ts`:

```typescript
import { makeDir, writeBinaryFile } from "../utils/xpcom";

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

function detectRepeatQuestion(ctx: Record<string, unknown>): SignalRecord | null {
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
    context: {
      leaked_text: text.slice(0, 300),
    },
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
      failure_count: failures,
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
  const assistantMsgs = buffer.filter(e => e.type === "assistant_response").length;
  const toolCalls = buffer.filter(e => e.type === "tool_result");
  const deepResearch = buffer.some(e => e.type === "deep_research_done");
  return {
    total_events: buffer.length,
    user_messages: userMsgs,
    assistant_responses: assistantMsgs,
    tools_called: toolCalls.map(e => `${e.context.name}: ${e.context.success ? "ok" : "fail"}`),
    deep_research_active: deepResearch,
  };
}

function buildRawMessages(): string[] {
  return buffer.slice(-10).map(e => {
    const role = e.type === "user_message" ? "user" : e.type === "assistant_response" ? "assistant" : e.type;
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
    writeBinaryFile(path, JSON.stringify(signal, null, 2));

    // Purge oldest if > 50 files
    purgeOldSnapshots();
  } catch (_e) {
    // Never throw — feedback logging is non-blocking
  }
}

function purgeOldSnapshots(): void {
  try {
    const dir = getFeedbackDir();
    // @ts-expect-error - XPCOM
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
    const monitorEvent: MonitorEvent = {
      type: event,
      timestamp: Date.now(),
      context,
    };
    pushEvent(monitorEvent);

    let signal: SignalRecord | null = null;

    switch (event) {
      case "user_message":
        signal = detectRepeatQuestion(context);
        break;
      case "user_message":
        signal = detectUserFrustration(context);
        break;
      case "deep_research_done":
        signal = detectShortReport(context);
        break;
      case "assistant_response":
        signal = detectReasoningLeak(context);
        break;
      case "tool_result":
        if (context.success === false) {
          signal = detectToolFailureChain();
        }
        break;
      case "api_error":
        signal = detectApiFault(context);
        break;
    }

    if (signal) {
      logSessionSnapshot(signal);
    }
  } catch (_e) {
    // Never throw
  }
}

export function getSignalHistory(): SignalRecord[] {
  // Read the feedback directory and return recent signals
  // Used for debugging only, not part of normal flow
  const results: SignalRecord[] = [];
  try {
    const dir = getFeedbackDir();
    // @ts-expect-error - XPCOM
    const nsIFile = Components.classes["@mozilla.org/file/local;1"]
      .createInstance(Components.interfaces.nsIFile) as any;
    nsIFile.initWithPath(dir);
    if (!nsIFile.exists()) return results;
    const enumerator = nsIFile.directoryEntries;
    while (enumerator.hasMoreElements()) {
      const raw = enumerator.getNext();
      const file = raw.QueryInterface(Components.interfaces.nsIFile);
      if (file && file.path && file.path.endsWith(".json")) {
        try {
          // @ts-expect-error - XPCOM
          const stream = Components.classes["@mozilla.org/network/file-input-stream;1"]
            .createInstance(Components.interfaces.nsIFileInputStream) as any;
          stream.init(file, 0x01, 0o644, 0);
          const available = stream.available();
          // @ts-expect-error - XPCOM
          const data = Components.classes["@mozilla.org/binaryinputstream;1"]
            .createInstance(Components.interfaces.nsIBinaryInputStream) as any;
          data.setInputStream(stream);
          const text = data.readBytes(available);
          stream.close();
          results.push(JSON.parse(text) as SignalRecord);
        } catch (_) { /* skip corrupt files */ }
      }
    }
    enumerator.close();
  } catch (_) { /* skip */ }
  return results;
}
```

Wait — the switch statement above has a bug. The `user_message` case can only match one branch. I need to run BOTH detectors for `user_message`. Let me fix the implementation in the plan.

Actually, let me restructure the `track` function. Instead of a switch, use if/else chains or run all applicable detectors:

```typescript
export function track(event: string, context: Record<string, unknown>): void {
  try {
    pushEvent({ type: event, timestamp: Date.now(), context });

    let signal: SignalRecord | null = null;

    if (event === "user_message") {
      signal = detectRepeatQuestion(context) || detectUserFrustration(context);
    } else if (event === "deep_research_done") {
      signal = detectShortReport(context);
    } else if (event === "assistant_response") {
      signal = detectReasoningLeak(context);
    } else if (event === "tool_result" && context.success === false) {
      signal = detectToolFailureChain();
    } else if (event === "api_error") {
      signal = detectApiFault(context);
    }

    if (signal) logSessionSnapshot(signal);
  } catch (_e) { /* never throw */ }
}
```

This is better — `detectRepeatQuestion` runs first, and if it doesn't fire, `detectUserFrustration` runs.

Let me fix the plan. I'll write it correctly.

Also — `writeBinaryFile` may have issues with Chinese characters (like we discovered before). For feedback JSON files, the content is mostly ASCII (keys are English, user messages might have Chinese). Let me use `writeFile` (UTF-8) instead for the feedback files, since they don't contain binary PDF data.

Actually, looking at the current xpcom.ts, `writeBinaryFile` is used. But we learned that it corrupts non-ASCII. For feedback files that may contain Chinese user messages, I should use `writeFile` instead. But `writeFile` doesn't have the same append/create behavior... actually it does, it creates files.

Let me use `writeFile` for the snapshot files since they contain potentially Chinese text. But `writeFile` uses the converter output stream which is UTF-8 safe.

Actually, let me think about this more carefully. The `writeBinaryFile` function was problematic because it uses `nsIBinaryOutputStream.writeBytes()` which truncates each JS character to one byte. For Chinese text, this is corruption.

But `writeFile` uses `nsIConverterOutputStream("UTF-8")` which properly handles multi-byte characters. So I should use `writeFile` for feedback JSON files.

Let me update the plan to import `writeFile` instead of `writeBinaryFile`, and use `readFile` + `writeFile` for the snapshot files.

Let me rewrite the plan with these fixes.<｜end▁of▁thinking｜>Wait, I found a bug in the switch statement. Let me fix and write the correct plan.

<｜｜DSML｜｜tool_calls>
<｜｜DSML｜｜invoke name="Write">
<｜｜DSML｜｜parameter name="content" string="true"># Session Monitor — Feedback Auto-Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically detect 6 types of anomalous conversation signals and save session snapshots to `llm-wiki/feedback/` for post-hoc analysis.

**Architecture:** New module `src/modules/sessionMonitor.ts` maintains a 20-event ring buffer, runs 6 independent signal detectors on each new event, and writes JSON snapshots to disk when any detector fires. `agentPanel.ts` adds 5 `track()` calls at key touch points — fire-and-forget, never blocking.

**Tech Stack:** TypeScript, Firefox XPCOM file I/O (UTF-8 for JSON with user text)

---

## File Structure

| File | Action | Purpose |
|------|--------|---------|
| `src/modules/sessionMonitor.ts` | Create | Ring buffer, 6 detectors, snapshot writer, `track()` API |
| `src/modules/agentPanel.ts` | Modify | Add 5 `track()` calls at integration points |

---

### Task 1: Create sessionMonitor.ts module

**Files:**
- Create: `src/modules/sessionMonitor.ts`

- [ ] **Step 1: Write the module**

Create `src/modules/sessionMonitor.ts`:

```typescript
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
```

Note: `writeFile` is used for snapshots (UTF-8 safe for Chinese user messages) and `readBinaryFile` for `getSignalHistory()` (reads raw bytes back as JSON).

- [ ] **Step 2: Verify build**

```bash
cd /Users/shouyaoqi/zotero-llm-wiki
npm run build
```

Expected: TypeScript compilation passes, no errors.

- [ ] **Step 3: Commit**

```bash
git add src/modules/sessionMonitor.ts
git commit -m "feat: add sessionMonitor module with 6 signal detectors and feedback auto-capture"
```

---

### Task 2: Add track() calls to agentPanel.ts

**Files:**
- Modify: `src/modules/agentPanel.ts`

- [ ] **Step 1: Add import**

Add after the deepResearch import (line 15):

```typescript
import { track } from "./sessionMonitor";
```

- [ ] **Step 2: Add track("user_message") in handleSend()**

In `handleSend()`, after extracting the user text and before the slash command checks, add:

Find the line after `const text = state.inputEl.value.trim();` and `if (!text) return;`. After the slash command handlers (after `/save` block), and after `state.busy = true;`, find where `state.messages.push({ role: "user", content: text });` is called. Add after this line:

```typescript
track("user_message", { text });
```

- [ ] **Step 3: Add track("assistant_response") in handleSend()**

In `handleSend()`, after the final `addAssistantMessage(response.content);` call (around line ~1145), add:

```typescript
track("assistant_response", { text: response.content?.slice(0, 300) || "", hasContent: !!response.content });
```

- [ ] **Step 4: Add track("deep_research_done") in executeDeepResearch()**

In `executeDeepResearch()`, after `Zotero.debug(\`[llmwiki] deep_research: loop ended, round=${round}, reportLen=${report.length}\`);` (around line ~860), add:

```typescript
track("deep_research_done", { reportLen: report.length, rounds: round, searches: searchCount });
```

- [ ] **Step 5: Add track("api_error") in callLLM()**

In `callLLM()` (the agentPanel's internal XHR-based version), in the `xhr.onload` handler where non-2xx statuses are handled, and in `xhr.onerror` and `xhr.ontimeout`, add tracking calls.

In `xhr.onload` error branch (where `< 200 || >= 300` after the 401/403 check):

```typescript
track("api_error", { status: xhr.status, message: xhr.responseText?.slice(0, 200) || "" });
```

In `xhr.onerror`:

```typescript
track("api_error", { status: 0, message: "Network error" });
```

In `xhr.ontimeout`:

```typescript
track("api_error", { status: 0, message: "Timeout" });
```

- [ ] **Step 6: Add track("tool_result") in executeToolCall()**

In `executeToolCall()`, in the catch block (where `card.update("failed", ...)` is called), add before the return:

```typescript
track("tool_result", { name, success: false, error: e?.message?.slice(0, 200) || String(e) });
```

Also add at the end of the try block, before `return result;`:

```typescript
track("tool_result", { name, args: JSON.stringify(args).slice(0, 100), success: true });
```

- [ ] **Step 7: Verify build**

```bash
cd /Users/shouyaoqi/zotero-llm-wiki
npm run build
```

Must pass with no TypeScript errors. Fix any type issues.

- [ ] **Step 8: Commit**

```bash
git add src/modules/agentPanel.ts
git commit -m "feat: add sessionMonitor track() calls at agent integration points"
```

---

### Task 3: Integration test

- [ ] **Step 1: Start dev server**

```bash
npm start
```

- [ ] **Step 2: Manual test checklist**

1. Trigger repeat_question: type the same question twice → check `llm-wiki/feedback/` for `*-repeat_question.json`
2. Trigger user_frustration: type "不对" → check `*-user_frustration.json`
3. Trigger api_fault: temporarily set wrong API key in preferences, send a message → check `*-api_fault.json`
4. Trigger tool_failure_chain: ask a question that would cause repeated tool failures
5. Verify snapshots have valid JSON, correct signal field, and contain session_summary + raw_messages
6. Verify feedback directory auto-created on first snapshot

- [ ] **Step 3: Commit any fixes**

```bash
git add -A
git commit -m "fix: sessionMonitor integration polish"
```
