# Session Monitor — Feedback Auto-Capture Design Spec

> 2026-05-31 | Phase 7

## Goal

Automatically detect anomalous conversation signals (repeat questions, user frustration, tool failures, API errors, low-quality outputs) and save session snapshots to `llm-wiki/feedback/` for post-hoc analysis, without requiring any user action.

## Architecture

New module `src/modules/sessionMonitor.ts` — a stateful signal detector. `agentPanel.ts` calls `monitor.track(event, context)` at 5-6 key touch points. The monitor maintains a ring buffer of recent events, runs 6 independent detectors on each new event, and when any detector fires, writes a JSON snapshot to disk.

```
agentPanel.ts                         sessionMonitor.ts
────────────                          ──────────────────
handleSend() ──track("user_message")──→ SignalBuffer (ring, 20 events)
callLLM() ────track("api_error")──────→ │
executeToolCall() ─track("tool_result")→ ├─ Detector 1: repeat_question
executeDeepResearch() ─track(...)──────→ ├─ Detector 2: user_frustration
                                        ├─ Detector 3: short_report
                                        ├─ Detector 4: reasoning_leak
                                        ├─ Detector 5: tool_failure_chain
                                        └─ Detector 6: api_fault

Any detector fires → logSessionSnapshot() → llm-wiki/feedback/{ts}-{signal}.json
```

## Signal Detectors

| # | Signal | Trigger | Threshold |
|---|--------|---------|-----------|
| 1 | `repeat_question` | Consecutive user messages with text overlap > 80% | 2 |
| 2 | `user_frustration` | User message matches `/不对|wrong|no|错了|重新|重来|不行/i` | 1 |
| 3 | `short_report` | Deep research ended with reportLen < 300 | 1 |
| 4 | `reasoning_leak` | Assistant message matches `/^(Let me|I'll|I will|让我|我来)/i` and len < 300 | 1 |
| 5 | `tool_failure_chain` | ≥ 2 failures in last 3 tool calls | Window of 3 |
| 6 | `api_fault` | Any 4xx/5xx status, timeout, or network error | 1 |

Overlap similarity for detector 1 uses character-level Jaccard: `intersection / union` of character bigrams. Values ≥ 0.80 are considered repeats.

## Snapshot Data Format

Saved to `{dataDir}/llm-wiki/feedback/{timestamp}-{signal_type}.json`:

```json
{
  "signal": "repeat_question",
  "timestamp": "2026-05-31T10:30:00Z",
  "severity": "warning",
  "context": {
    "user_messages": ["...", "..."],
    "assistant_responses": ["...", "..."],
    "similarity": 0.85
  },
  "session_summary": {
    "total_rounds": 3,
    "tools_called": ["search_wiki: 2", "read_page: 1"],
    "deep_research_active": false
  },
  "raw_messages": []
}
```

- `raw_messages` capped at last 10 messages, each truncated to 100 chars
- `context` fields are signal-specific (detector 3 includes `reportLen`, detector 6 includes `statusCode`)
- `severity` is `"warning"` for repeat/frustration/short/leak, `"error"` for tool_failure_chain/api_fault
- Directory auto-created on first write, individual files limited to ~50 most recent (oldest purged)

## Module API

```typescript
// Exported for agentPanel.ts
export function track(event: string, context: Record<string, unknown>): void;
export function getSignalHistory(): SignalRecord[];
```

`track()` is the only function called from agentPanel.ts. It is fire-and-forget — never throws, never blocks.

## Integration Points (agentPanel.ts)

| Location | Call |
|----------|------|
| `handleSend()` — after user message parsed | `track("user_message", { text })` |
| `handleSend()` — after adding final assistant response | `track("assistant_response", { text, hasContent: !!response.content })` |
| `executeDeepResearch()` — after loop ended | `track("deep_research_done", { reportLen, rounds, searches })` |
| `callLLM()` — on XHR error/timeout | `track("api_error", { status, message })` |
| `executeToolCall()` — on tool failure | `track("tool_result", { name, success: false, error })` |

## File Changes

| File | Action | Purpose |
|------|--------|---------|
| `src/modules/sessionMonitor.ts` | Create | Signal detection, ring buffer, snapshot writer |
| `src/modules/agentPanel.ts` | Modify | 6 `track()` calls at integration points |

## Non-goals

- No user-facing UI for feedback
- No `/feedback` slash command
- No automatic reporting/telemetry — files are local only
- No rate limiting beyond the 50-file purge
