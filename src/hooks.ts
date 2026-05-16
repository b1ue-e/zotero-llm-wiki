import { getString, initLocale, getLocaleID } from "./utils/locale";
import { registerPrefsScripts } from "./modules/preferenceScript";
import { createZToolkit } from "./utils/ztoolkit";
import { runIngest } from "./modules/ingest";
import { renderWikiBrowser } from "./modules/wikiBrowser";

async function onStartup() {
  Zotero.debug("[llmwiki] onStartup begin");

  initLocale();
  Zotero.debug("[llmwiki] initLocale done");

  // Register preferences pane
  Zotero.PreferencePanes.register({
    pluginID: addon.data.config.addonID,
    src: rootURI + "content/preferences.xhtml",
    label: getString("prefs-title"),
    image: `chrome://${addon.data.config.addonRef}/content/icons/favicon.png`,
  });

  // Register Wiki Browser panel
  Zotero.ItemPaneManager.registerSection({
    paneID: `${addon.data.config.addonRef}-wikiBrowser`,
    pluginID: addon.data.config.addonID,
    sidenav: {
      icon: `chrome://${addon.data.config.addonRef}/content/icons/favicon.png`,
      l10nID: getLocaleID("section-wikibrowser-sidenav-tooltip"),
    },
    header: {
      icon: `chrome://${addon.data.config.addonRef}/content/icons/favicon.png`,
      l10nID: getLocaleID("section-wikibrowser-head-text"),
    },
    onRender: ({ body, doc }) => {
      renderWikiBrowser({ body, doc });
    },
  });

  // Register item notifier
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
    shutdown: ({ id }: { id: string }) => {
      if (id === addon.data.config.addonID) {
        Zotero.Notifier.unregisterObserver(notifierID);
      }
    },
  });

  await Promise.all(
    Zotero.getMainWindows().map((win: _ZoteroTypes.MainWindow) => onMainWindowLoad(win)),
  );

  addon.data.initialized = true;
  Zotero.debug("[llmwiki] onStartup complete");
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  Zotero.debug("[llmwiki] onMainWindowLoad running");

  // Wait for document to be ready (matches Knowledge4Zotero pattern)
  await new Promise<void>((resolve) => {
    if (win.document.readyState === "complete") {
      resolve();
    } else {
      win.document.addEventListener("DOMContentLoaded", () => resolve(), { once: true });
    }
  });

  addon.data.ztoolkit = createZToolkit();

  // Register item context menu via DOM capture-phase listener (most reliable approach)
  const menuID = `${addon.data.config.addonRef}-itemmenu-ingest`;
  const menuLabel = getString("menuitem-ingest");
  const menuIcon = `chrome://${addon.data.config.addonRef}/content/icons/favicon@0.5x.png`;

  win.document.addEventListener(
    "popupshowing",
    (event: Event) => {
      const popup = event.target as Element;
      if (!popup || popup.id !== "zotero-itemmenu") return;

      // Remove existing instance to avoid duplicates
      const existing = popup.querySelector(`#${menuID}`);
      if (existing) existing.remove();

      const menuitem = (win.document as any).createXULElement("menuitem");
      menuitem.id = menuID;
      menuitem.setAttribute("label", menuLabel);
      menuitem.setAttribute("image", menuIcon);
      menuitem.addEventListener("command", () => addon.hooks.onMenuIngest());
      popup.appendChild(menuitem);
    },
    true,
  );

  Zotero.debug("[llmwiki] menu registered via DOM listener");
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
