import { getPref } from "../utils/prefs";

interface ChatMessage {
  role: "system" | "user";
  content: string;
}

interface ChatCompletionResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

/**
 * Call the OpenAI-compatible chat completions API.
 * Uses XMLHttpRequest (available in Zotero privileged sandbox) instead of fetch
 * to avoid AbortController dependency issues.
 */
export async function callLLM(messages: ChatMessage[]): Promise<string> {
  const endpoint = getPref("apiEndpoint") as string;
  const apiKey = getPref("apiKey") as string;
  const model = getPref("modelName") as string;

  if (!endpoint || !apiKey) {
    throw new Error(
      "API endpoint or key not configured. Open Preferences → LLM Wiki.",
    );
  }

  const url = endpoint.endsWith("/chat/completions")
    ? endpoint
    : endpoint.replace(/\/$/, "") + "/chat/completions";

  const body = JSON.stringify({
    model,
    messages,
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
        reject(new Error("auth"));
        return;
      }
      if (xhr.status === 429) {
        delay(5000).then(() => resolve(callLLM(messages)));
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(
          new Error(
            `API error (${xhr.status}): ${xhr.responseText?.slice(0, 200) || ""}`,
          ),
        );
        return;
      }
      try {
        const data = JSON.parse(
          xhr.responseText || "{}",
        ) as unknown as ChatCompletionResponse;
        resolve(data.choices[0]?.message?.content || "");
      } catch (e: any) {
        reject(new Error(`Failed to parse response: ${e.message}`));
      }
    };

    xhr.onerror = () =>
      reject(new Error("Network error: Unable to reach API."));
    xhr.ontimeout = () => reject(new Error("timeout"));
    xhr.send(body);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    // @ts-expect-error - Mozilla XPCOM Components is only available in Zotero/Firefox runtime
    const timer = Components.classes["@mozilla.org/timer;1"].createInstance(
      Components.interfaces.nsITimer,
    ) as any;
    timer.initWithCallback(
      resolve,
      ms,
      Components.interfaces.nsITimer.TYPE_ONE_SHOT,
    );
  });
}
