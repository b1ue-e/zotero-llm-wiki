# Zotero LLM-Wiki Plugin — MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Zotero 9 plugin that adds a right-click "LLM Wiki: Ingest" menu item, extracts paper metadata, calls an OpenAI-compatible API, and saves a structured wiki Markdown entry.

**Architecture:** Zotero plugin based on windingwind/zotero-plugin-template v3.1.0. Operates as a Firefox WebExtension inside Zotero 9. Uses zotero-plugin-toolkit for menus/preferences, custom modules for LLM API calls and wiki file I/O.

**Tech Stack:** TypeScript, zotero-plugin-toolkit v5, zotero-plugin-scaffold, Zotero 9 API (Firefox 115 ESR target)

---

## File Structure

```
zotero-llm-wiki/
├── addon/
│   ├── bootstrap.js              # Plugin entry (copy from template, placeholders replaced by scaffold)
│   ├── manifest.json              # Zotero 9 target (template, updated strict_max_version)
│   └── content/
│       └── preferences.xhtml      # Settings panel UI
├── src/
│   ├── index.ts                   # Plugin bootstrap (copy from template)
│   ├── addon.ts                   # Addon class (copy from template)
│   ├── hooks.ts                   # Lifecycle hooks: startup, menu, prefs, notifier
│   └── modules/
│       ├── ingest.ts              # Ingest orchestration: extract → call LLM → write
│       ├── llmProvider.ts         # OpenAI-compatible API client
│       ├── wikiStorage.ts         # Markdown file read/write under Zotero data dir
│       └── preferenceScript.ts    # Preferences panel bindings
│   └── utils/
│       ├── locale.ts              # i18n (copy from template)
│       ├── prefs.ts               # Preference get/set helpers (copy from template)
│       ├── sanitize.ts            # Filename sanitization for paper titles
│       └── ztoolkit.ts            # ZToolkit singleton (copy from template)
├── typings/
│   ├── global.d.ts               # (copy from template)
│   ├── i10n.d.ts                 # FTl locale type defs
│   └── prefs.d.ts                # Plugin preference type definitions
├── addon.ftl                     # Fluent locale strings (English + Chinese)
├── package.json                  # Plugin metadata and build config
├── tsconfig.json                 # TypeScript config (copy from template)
└── zotero-plugin.config.ts       # Scaffold build config (copy from template, updated)
```

---

### Task 1: Scaffold the Plugin Project

**Files:**
- All files under `~/zotero-llm-wiki/` (initialize from template)

- [ ] **Step 1: Copy template files to project**

```bash
cp -r /tmp/zotero-plugin-template/src ~/zotero-llm-wiki/
cp -r /tmp/zotero-plugin-template/addon ~/zotero-llm-wiki/
cp -r /tmp/zotero-plugin-template/typings ~/zotero-llm-wiki/
cp /tmp/zotero-plugin-template/tsconfig.json ~/zotero-llm-wiki/
cp /tmp/zotero-plugin-template/eslint.config.mjs ~/zotero-llm-wiki/
cp /tmp/zotero-plugin-template/zotero-plugin.config.ts ~/zotero-llm-wiki/
cp /tmp/zotero-plugin-template/.gitignore ~/zotero-llm-wiki/
cp /tmp/zotero-plugin-template/.env.example ~/zotero-llm-wiki/
```

- [ ] **Step 2: Configure package.json**

Read `~/zotero-llm-wiki/package.json` and update the `config` block:

```json
{
  "name": "zotero-llm-wiki",
  "type": "module",
  "version": "0.1.0",
  "description": "LLM-Wiki plugin for Zotero - compile paper knowledge with AI",
  "config": {
    "addonName": "LLM Wiki",
    "addonID": "llmwiki@zotero.org",
    "addonRef": "llmwiki",
    "addonInstance": "LLMWiki",
    "prefsPrefix": "extensions.zotero.llmwiki"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/b1ue-e/zotero-llm-wiki.git"
  },
  "author": "b1ue-e",
  "license": "AGPL-3.0-or-later",
  "scripts": {
    "start": "zotero-plugin serve",
    "build": "zotero-plugin build && tsc --noEmit",
    "lint:check": "prettier --check . && eslint .",
    "lint:fix": "prettier --write . && eslint . --fix",
    "release": "zotero-plugin release",
    "test": "zotero-plugin test"
  },
  "dependencies": {
    "zotero-plugin-toolkit": "^5.1.0-beta.13"
  },
  "devDependencies": {
    "@types/node": "^24.10.0",
    "@zotero-plugin/eslint-config": "^0.6.7",
    "eslint": "^9.39.2",
    "prettier": "^3.7.4",
    "typescript": "^5.9.3",
    "zotero-plugin-scaffold": "^0.8.2",
    "zotero-types": "^4.1.0-beta.4"
  }
}
```

- [ ] **Step 3: Update zotero-plugin.config.ts**

Read `~/zotero-llm-wiki/zotero-plugin.config.ts` and update the repository references:

```typescript
import { defineConfig } from "zotero-plugin-scaffold";
import pkg from "./package.json";

export default defineConfig({
  source: ["src", "addon"],
  dist: ".scaffold/build",
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,
  updateURL: `https://github.com/b1ue-e/zotero-llm-wiki/releases/download/release/${
    pkg.version.includes("-") ? "update-beta.json" : "update.json"
  }`,
  xpiDownloadLink:
    "https://github.com/b1ue-e/zotero-llm-wiki/releases/download/v{{version}}/{{xpiName}}.xpi",

  build: {
    assets: ["addon/**/*.*"],
    define: {
      ...pkg.config,
      author: pkg.author,
      description: pkg.description,
      homepage: pkg.homepage,
      buildVersion: pkg.version,
      buildTime: "{{buildTime}}",
    },
    prefs: {
      prefix: pkg.config.prefsPrefix,
    },
    esbuildOptions: [
      {
        entryPoints: ["src/index.ts"],
        define: {
          __env__: `"${process.env.NODE_ENV}"`,
        },
        bundle: true,
        target: "firefox115",
        outfile: `.scaffold/build/addon/content/scripts/${pkg.config.addonRef}.js`,
      },
    ],
  },

  test: {
    waitForPlugin: `() => Zotero.${pkg.config.addonInstance}.data.initialized`,
  },
});
```

- [ ] **Step 4: Update manifest.json for Zotero 9**

Read `~/zotero-llm-wiki/addon/manifest.json` and update `applications.zotero`:

```json
{
  "manifest_version": 2,
  "name": "__addonName__",
  "version": "__buildVersion__",
  "description": "__description__",
  "homepage_url": "__homepage__",
  "author": "__author__",
  "icons": {
    "48": "content/icons/favicon@0.5x.png",
    "96": "content/icons/favicon.png"
  },
  "applications": {
    "zotero": {
      "id": "__addonID__",
      "update_url": "__updateURL__",
      "strict_min_version": "7.0",
      "strict_max_version": "9.*"
    }
  }
}
```

- [ ] **Step 5: Install dependencies**

```bash
cd ~/zotero-llm-wiki && npm install
```
Expected: installs all packages, no errors.

- [ ] **Step 6: Commit scaffold**

```bash
cd ~/zotero-llm-wiki
git add -A
git commit -m "feat: scaffold plugin from zotero-plugin-template v3.1.0"
```

---

### Task 2: Remove Template Example Code

**Files:**
- Modify: `src/hooks.ts`
- Delete content in: `src/modules/examples.ts`
- Modify: `src/modules/preferenceScript.ts`

Stripping template examples so we have a clean slate.

- [ ] **Step 1: Rewrite src/hooks.ts — strip examples, keep structure**

Replace the entire file content at `~/zotero-llm-wiki/src/hooks.ts`:

```typescript
import { getString, initLocale } from "./utils/locale";
import { registerPrefsScripts } from "./modules/preferenceScript";
import { createZToolkit } from "./utils/ztoolkit";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

  // Register preferences pane
  Zotero.PreferencePanes.register({
    pluginID: addon.data.config.addonID,
    src: rootURI + "content/preferences.xhtml",
    label: getString("prefs-title"),
    image: `chrome://${addon.data.config.addonRef}/content/icons/favicon.png`,
  });

  // Register item notifier for future auto-ingest
  const notifierCallback = {
    notify: async (
      event: string,
      type: string,
      ids: number[] | string[],
      extraData: { [key: string]: any },
    ) => {
      if (!addon?.data.alive) {
        Zotero.Notifier.unregisterObserver(notifierID);
        return;
      }
      addon.hooks.onNotify(event, type, ids, extraData);
    },
  };
  const notifierID = Zotero.Notifier.registerObserver(notifierCallback, [
    "item",
  ]);

  Zotero.Plugins.addObserver({
    shutdown: ({ id }) => {
      if (id === addon.data.config.addonID) {
        Zotero.Notifier.unregisterObserver(notifierID);
      }
    },
  });

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  addon.data.ztoolkit = createZToolkit();

  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );

  // Register right-click menu item
  ztoolkit.Menu.register("item", {
    tag: "menuitem",
    id: "zotero-itemmenu-llmwiki-ingest",
    label: getString("menuitem-ingest"),
    icon: `chrome://${addon.data.config.addonRef}/content/icons/favicon@0.5x.png`,
    commandListener: (ev) => addon.hooks.onMenuIngest(),
  });
}

async function onMainWindowUnload(win: Window): Promise<void> {
  ztoolkit.unregisterAll();
}

function onShutdown(): void {
  ztoolkit.unregisterAll();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

async function onNotify(
  event: string,
  type: string,
  ids: Array<string | number>,
  extraData: { [key: string]: any },
) {
  ztoolkit.log("notify", event, type, ids, extraData);
}

async function onPrefsEvent(type: string, data: { [key: string]: any }) {
  switch (type) {
    case "load":
      registerPrefsScripts(data.window);
      break;
    default:
      return;
  }
}

async function onMenuIngest() {
  const items = ZoteroPane.getSelectedItems();
  if (items.length === 0) {
    new ztoolkit.ProgressWindow(addon.data.config.addonName)
      .createLine({
        text: getString("ingest-no-selection"),
        type: "warning",
        progress: 100,
      })
      .show();
    return;
  }
  // Delegate to ingest module
  const { runIngest } = require("./modules/ingest");
  for (const item of items) {
    if (item.isRegularItem() && !(item as any).isFeedItem) {
      await runIngest(item);
    }
  }
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onNotify,
  onPrefsEvent,
  onMenuIngest,
};
```

- [ ] **Step 2: Rewrite src/modules/preferenceScript.ts — minimal version**

Replace the entire file content at `~/zotero-llm-wiki/src/modules/preferenceScript.ts`:

```typescript
import { config } from "../../package.json";

export async function registerPrefsScripts(_window: Window) {
  if (!addon.data.prefs) {
    addon.data.prefs = {
      window: _window,
      columns: [],
      rows: [],
    };
  } else {
    addon.data.prefs.window = _window;
  }
  bindPrefEvents();
}

function bindPrefEvents() {
  // Preference values are auto-bound via the `preference` attribute in XHTML.
  // No additional binding needed for simple text/password fields.
}
```

- [ ] **Step 3: Delete examples module**

```bash
rm ~/zotero-llm-wiki/src/modules/examples.ts
```

- [ ] **Step 4: Commit cleanup**

```bash
cd ~/zotero-llm-wiki
git add -A
git commit -m "refactor: strip template examples, set up clean hooks structure"
```

---

### Task 3: Define Plugin Preferences

**Files:**
- Create: `typings/prefs.d.ts`
- Modify: `addon/content/preferences.xhtml`
- Create: `addon.ftl` (if not exists, create locale strings)

- [ ] **Step 1: Write typings/prefs.d.ts**

Replace the file content at `~/zotero-llm-wiki/typings/prefs.d.ts`:

```typescript
declare namespace _ZoteroTypes {
  interface Prefs {
    PluginPrefsMap: {
      "apiKey": string;
      "apiEndpoint": string;
      "modelName": string;
      "requestTimeout": number;
    };
  }
}
```

- [ ] **Step 2: Write addon/content/preferences.xhtml**

Replace the file content at `~/zotero-llm-wiki/addon/content/preferences.xhtml`:

```xhtml
<linkset>
  <html:link rel="localization" href="__addonRef__-preferences.ftl" />
</linkset>
<groupbox
  onload="Zotero.__addonInstance__.hooks.onPrefsEvent('load', { window })"
>
  <label><html:h2 data-l10n-id="pref-title"></html:h2></label>

  <html:label for="zotero-prefpane-__addonRef__-apiEndpoint"
    data-l10n-id="pref-api-endpoint"></html:label>
  <html:input
    type="text"
    id="zotero-prefpane-__addonRef__-apiEndpoint"
    preference="apiEndpoint"
    style="width: 100%;"
  ></html:input>

  <html:label for="zotero-prefpane-__addonRef__-apiKey"
    data-l10n-id="pref-api-key"></html:label>
  <html:input
    type="password"
    id="zotero-prefpane-__addonRef__-apiKey"
    preference="apiKey"
    style="width: 100%;"
  ></html:input>

  <html:label for="zotero-prefpane-__addonRef__-modelName"
    data-l10n-id="pref-model-name"></html:label>
  <html:input
    type="text"
    id="zotero-prefpane-__addonRef__-modelName"
    preference="modelName"
    style="width: 100%;"
  ></html:input>

  <html:label for="zotero-prefpane-__addonRef__-requestTimeout"
    data-l10n-id="pref-request-timeout"></html:label>
  <html:input
    type="number"
    id="zotero-prefpane-__addonRef__-requestTimeout"
    preference="requestTimeout"
    min="10"
    max="600"
    style="width: 100%;"
  ></html:input>
</groupbox>
<vbox>
  <html:label
    data-l10n-id="pref-help"
    data-l10n-args='{"time": "__buildTime__","name": "__addonName__","version":"__buildVersion__"}'
  ></html:label>
</vbox>
```

- [ ] **Step 3: Write locale file addon.ftl**

Create `~/zotero-llm-wiki/addon.ftl`:

```ftl
# Menus
menuitem-ingest = LLM Wiki: Ingest
menupopup-label = LLM Wiki

# Preferences
prefs-title = LLM Wiki
pref-api-endpoint = API Endpoint
pref-api-key = API Key
pref-model-name = Model Name
pref-request-timeout = Request Timeout (seconds)

# Ingest
ingest-no-selection = No item selected. Right-click a paper and try again.
ingest-start = Ingesting "{ $title }"...
ingest-success = Wiki saved for "{ $title }"
ingest-error-network = Network error: Unable to reach API. Check your endpoint and connection.
ingest-error-auth = API key rejected (401). Check your key in Preferences.
ingest-error-timeout = Request timed out. Try a smaller document or increase timeout in Preferences.
ingest-error-unknown = LLM API error: { $message }
ingest-error-no-metadata = Selected item has no title or abstract to ingest.
```

- [ ] **Step 4: Commit preferences**

```bash
cd ~/zotero-llm-wiki
git add addon/content/preferences.xhtml typings/prefs.d.ts addon.ftl
git commit -m "feat: add preferences panel for API configuration"
```

---

### Task 4: Implement Filename Sanitizer

**Files:**
- Create: `src/utils/sanitize.ts`

- [ ] **Step 1: Write sanitize.ts**

Create `~/zotero-llm-wiki/src/utils/sanitize.ts`:

```typescript
/**
 * Convert a paper title into a safe filename slug.
 * Replaces filesystem-unsafe characters, truncates to 100 chars,
 * and appends a short hash to avoid collisions.
 */
export function titleToSlug(title: string): string {
  const hash = simpleHash(title).slice(0, 8);
  let slug = title
    .replace(/[/\\:*?"<>|]/g, "")   // remove unsafe chars
    .replace(/\s+/g, "-")           // spaces to hyphens
    .replace(/-+/g, "-")            // collapse hyphens
    .replace(/^-|-$/g, "")          // trim leading/trailing hyphens
    .toLowerCase()
    .slice(0, 100);                 // truncate

  return `${slug}-${hash}`;
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(16);
}
```

- [ ] **Step 2: Commit sanitizer**

```bash
cd ~/zotero-llm-wiki
git add src/utils/sanitize.ts
git commit -m "feat: add filename sanitizer for paper titles"
```

---

### Task 5: Implement Wiki Storage Module

**Files:**
- Create: `src/modules/wikiStorage.ts`

- [ ] **Step 1: Write wikiStorage.ts**

Create `~/zotero-llm-wiki/src/modules/wikiStorage.ts`:

```typescript
import { titleToSlug } from "../utils/sanitize";

/**
 * Get the wiki base directory under Zotero data directory.
 * Uses Zotero.DataDirectory which resolves to the active profile's data folder.
 */
function getWikiBaseDir(): string {
  const dataDir = Zotero.DataDirectory || Zotero.getStorageDirectory();
  // Zotero.DataDirectory returns an nsIFile
  let path: string;
  if (typeof dataDir === "string") {
    path = dataDir;
  } else {
    path = dataDir.path;
  }
  return `${path}/llm-wiki/wiki/papers`;
}

/**
 * Ensure the wiki papers directory exists, creating it if needed.
 */
async function ensureWikiDir(): Promise<string> {
  const dir = getWikiBaseDir();
  const nsIFile = Components.classes["@mozilla.org/file/local;1"]
    .createInstance(Components.interfaces.nsIFile);
  nsIFile.initWithPath(dir);

  if (!nsIFile.exists()) {
    nsIFile.create(Components.interfaces.nsIFile.DIRECTORY_TYPE, 0o755);
  }
  return dir;
}

/**
 * Write a wiki markdown page for a paper.
 * @returns The file path of the written page
 */
export async function writeWikiPage(
  title: string,
  content: string,
): Promise<string> {
  const dir = await ensureWikiDir();
  const filename = `${titleToSlug(title)}.md`;

  const file = Components.classes["@mozilla.org/file/local;1"]
    .createInstance(Components.interfaces.nsIFile);
  file.initWithPath(`${dir}/${filename}`);

  const stream = Components.classes["@mozilla.org/network/file-output-stream;1"]
    .createInstance(Components.interfaces.nsIFileOutputStream);
  stream.init(file, 0x02 | 0x08 | 0x20, 0o644, 0); // WRITE | CREATE | TRUNCATE

  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  stream.write(data, data.length);
  stream.close();

  return file.path;
}

/**
 * Build a system prompt for the LLM wiki ingest.
 */
export function buildSystemPrompt(): string {
  return `You are a research assistant. Your task is to compile a structured wiki entry for an academic paper.

Generate a Markdown wiki page with the following sections:

## Research Question
What problem does this paper address?

## Method
How did the authors approach the problem? Key methodology details.

## Key Findings
What are the main results and contributions?

## Conclusions
What do the authors conclude? Implications of the work.

## Limitations
What limitations do the authors acknowledge (or are apparent)?

## Related Work
Mention key related papers or competing approaches discussed.

Use clear, academic language. Be precise and concise. Write in the same language as the paper's abstract.`;
}

/**
 * Build a user prompt from paper metadata.
 */
export function buildUserPrompt(metadata: PaperMetadata): string {
  const parts: string[] = [];
  if (metadata.title) parts.push(`# Title\n${metadata.title}`);
  if (metadata.authors) parts.push(`# Authors\n${metadata.authors}`);
  if (metadata.abstract) parts.push(`# Abstract\n${metadata.abstract}`);
  if (metadata.year) parts.push(`# Year\n${metadata.year}`);
  if (metadata.publication) parts.push(`# Publication\n${metadata.publication}`);
  if (metadata.doi) parts.push(`# DOI\n${metadata.doi}`);
  return parts.join("\n\n");
}

export interface PaperMetadata {
  title: string;
  authors?: string;
  abstract?: string;
  year?: string;
  publication?: string;
  doi?: string;
}
```

- [ ] **Step 2: Commit storage module**

```bash
cd ~/zotero-llm-wiki
git add src/modules/wikiStorage.ts
git commit -m "feat: add wiki storage module with Markdown file I/O"
```

---

### Task 6: Implement LLM Provider Module

**Files:**
- Create: `src/modules/llmProvider.ts`

- [ ] **Step 1: Write llmProvider.ts**

Create `~/zotero-llm-wiki/src/modules/llmProvider.ts`:

```typescript
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
      // Retry once after 5s for rate limits
      await delay(5000);
      return callLLM(messages);
    }
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`API error (${response.status}): ${text.slice(0, 200)}`);
    }

    const data: ChatCompletionResponse = await response.json();
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
    const timer = Components.classes["@mozilla.org/timer;1"]
      .createInstance(Components.interfaces.nsITimer);
    timer.initWithCallback(resolve, ms, Components.interfaces.nsITimer.TYPE_ONE_SHOT);
  });
}
```

- [ ] **Step 2: Commit LLM provider**

```bash
cd ~/zotero-llm-wiki
git add src/modules/llmProvider.ts
git commit -m "feat: add OpenAI-compatible LLM provider with timeout and auth error handling"
```

---

### Task 7: Implement Ingest Module

**Files:**
- Create: `src/modules/ingest.ts`

- [ ] **Step 1: Write ingest.ts**

Create `~/zotero-llm-wiki/src/modules/ingest.ts`:

```typescript
import { callLLM } from "./llmProvider";
import { buildSystemPrompt, buildUserPrompt, writeWikiPage, PaperMetadata } from "./wikiStorage";
import { getString } from "../utils/locale";

/**
 * Main ingest flow: extract metadata from a Zotero item,
 * call LLM to generate wiki content, and save to disk.
 */
export async function runIngest(item: Zotero.Item): Promise<void> {
  const metadata = extractMetadata(item);

  if (!metadata.title || (!metadata.abstract && !metadata.title)) {
    showNotification(getString("ingest-error-no-metadata"), "warning");
    return;
  }

  const progress = new ztoolkit.ProgressWindow(addon.data.config.addonName)
    .createLine({
      text: getString("ingest-start", { args: { title: metadata.title.slice(0, 80) } }),
      type: "default",
      progress: 30,
    })
    .show();

  try {
    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserPrompt(metadata);

    const wikiContent = await callLLM([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ]);

    progress.changeLine({
      text: `Writing wiki for "${metadata.title.slice(0, 80)}"...`,
      progress: 80,
    });

    const filePath = await writeWikiPage(metadata.title, wikiContent);

    progress.changeLine({
      text: getString("ingest-success", { args: { title: metadata.title.slice(0, 80) } }),
      type: "success",
      progress: 100,
    });
    progress.startCloseTimer(5000);
  } catch (e: any) {
    progress.startCloseTimer(0);
    let errorKey = "ingest-error-unknown";
    if (e.message === "auth") errorKey = "ingest-error-auth";
    else if (e.message === "timeout") errorKey = "ingest-error-timeout";
    else if (e.message?.includes("fetch") || e.message?.includes("Network"))
      errorKey = "ingest-error-network";

    new ztoolkit.ProgressWindow(addon.data.config.addonName)
      .createLine({
        text: getString(errorKey, { args: { message: e.message?.slice(0, 100) || "" } }),
        type: "error",
        progress: 100,
      })
      .show();
  }
}

function extractMetadata(item: Zotero.Item): PaperMetadata {
  return {
    title: item.getField("title") || "",
    authors: formatCreators(item),
    abstract: item.getField("abstractNote") || "",
    year: item.getField("date")?.toString() || "",
    publication: item.getField("publicationTitle") || "",
    doi: item.getField("DOI") || "",
  };
}

function formatCreators(item: Zotero.Item): string {
  const creators = item.getCreators?.() || [];
  return creators
    .filter((c: any) => c.creatorType === "author")
    .map((c: any) => `${c.firstName || ""} ${c.lastName || ""}`.trim())
    .join(", ");
}
```

- [ ] **Step 2: Commit ingest module**

```bash
cd ~/zotero-llm-wiki
git add src/modules/ingest.ts
git commit -m "feat: add ingest module with metadata extraction and LLM orchestration"
```

---

### Task 8: Register Default Preferences

**Files:**
- Modify: `src/modules/preferenceScript.ts` (add default value initialization)

- [ ] **Step 1: Add default preference initialization**

Edit `~/zotero-llm-wiki/src/modules/preferenceScript.ts`, adding to `registerPrefsScripts` a default value check:

```typescript
import { config } from "../../package.json";
import { getPref, setPref } from "../utils/prefs";

export async function registerPrefsScripts(_window: Window) {
  if (!addon.data.prefs) {
    addon.data.prefs = {
      window: _window,
      columns: [],
      rows: [],
    };
  } else {
    addon.data.prefs.window = _window;
  }

  // Set defaults on first load
  ensureDefaults();
  bindPrefEvents();
}

function ensureDefaults() {
  if (!getPref("apiEndpoint")) {
    setPref("apiEndpoint", "https://api.openai.com/v1");
  }
  if (!getPref("modelName")) {
    setPref("modelName", "gpt-4o");
  }
  if (!getPref("requestTimeout")) {
    setPref("requestTimeout", 120);
  }
}

function bindPrefEvents() {
  // Preference values are auto-bound via the `preference` attribute in XHTML.
  // No additional binding needed for simple text/password fields.
}
```

- [ ] **Step 2: Commit defaults**

```bash
cd ~/zotero-llm-wiki
git add src/modules/preferenceScript.ts
git commit -m "feat: initialize default preference values on first load"
```

---

### Task 9: Verify TypeScript Compilation

**Files:**
- All source files

- [ ] **Step 1: Run TypeScript check**

```bash
cd ~/zotero-llm-wiki && npx tsc --noEmit
```
Expected: no type errors. Fix any that appear.

- [ ] **Step 2: Run build**

```bash
cd ~/zotero-llm-wiki && npx zotero-plugin build
```
Expected: builds successfully, produces bundled JS in `.scaffold/build/`.

- [ ] **Step 3: Commit any build fixes**

```bash
cd ~/zotero-llm-wiki
git add -A
git commit -m "fix: resolve build and type errors"
```

---

### Task 10: Zotero 9 Smoke Test

**Files:**
- `.scaffold/build/` output

- [ ] **Step 1: Build the XPI for testing**

```bash
cd ~/zotero-llm-wiki && npm run build
```

- [ ] **Step 2: Manual verification checklist**

1. In Zotero 9, go to Tools → Add-ons → Gear → "Install Add-on From File..."
2. Select the built `.xpi` from `.scaffold/build/`
3. Verify the plugin appears in Add-ons list with name "LLM Wiki"
4. Go to Tools → LLM Wiki Preferences (or Edit → Preferences → LLM Wiki)
5. Verify the preferences panel shows API Endpoint, API Key, Model Name, Request Timeout fields
6. Right-click any paper in your library
7. Verify "LLM Wiki: Ingest" appears in the context menu

- [ ] **Step 3: Fix any Zotero 9 compatibility issues**

If the plugin fails to load, check Zotero console (Tools → Developer → Error Console) for errors. Common issues:
- `strict_max_version` too low → should be `9.*`
- API changes in Zotero 9 → check zotero-plugin-toolkit changelog
- Missing Fluent locale files

---

### Task 11: Final Push

**Files:**
- All

- [ ] **Step 1: Push to GitHub**

```bash
cd ~/zotero-llm-wiki && git push origin main
```
