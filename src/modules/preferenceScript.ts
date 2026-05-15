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
