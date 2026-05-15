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
 * Reads API key, endpoint, and model from plugin preferences.
 */
export async function callLLM(messages: ChatMessage[]): Promise<string> {
  const endpoint = getPref("apiEndpoint") as string;
  const apiKey = getPref("apiKey") as string;
  const model = getPref("modelName") as string;
  const timeout = (getPref("requestTimeout") as number) || 120;

  if (!endpoint || !apiKey) {
    throw new Error("API endpoint or key not configured. Open Preferences → LLM Wiki.");
  }

  const url = endpoint.endsWith("/chat/completions")
    ? endpoint
    : endpoint.replace(/\/$/, "") + "/chat/completions";

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout * 1000);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.3,
        max_tokens: 4096,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.status === 401 || response.status === 403) {
      throw new Error("auth");
    }
    if (response.status === 429) {
      await delay(5000);
      return callLLM(messages);
    }
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`API error (${response.status}): ${text.slice(0, 200)}`);
    }

    const data = await response.json() as unknown as ChatCompletionResponse;
    return data.choices[0]?.message?.content || "";
  } catch (e: any) {
    clearTimeout(timeoutId);
    if (e.name === "AbortError") {
      throw new Error("timeout");
    }
    throw e;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    // @ts-expect-error - Mozilla XPCOM Components is only available in Zotero/Firefox runtime
    const timer = Components.classes["@mozilla.org/timer;1"]
      .createInstance(Components.interfaces.nsITimer) as any;
    timer.initWithCallback(resolve, ms, Components.interfaces.nsITimer.TYPE_ONE_SHOT);
  });
}
