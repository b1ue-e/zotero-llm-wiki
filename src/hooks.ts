import { getString, initLocale } from "./utils/locale";
import { registerPrefsScripts } from "./modules/preferenceScript";
import { createZToolkit } from "./utils/ztoolkit";
import { runIngest } from "./modules/ingest";

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
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  addon.data.ztoolkit = createZToolkit();

  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );

  // Register right-click menu item
  (ztoolkit as any).Menu.register("item", {
    tag: "menuitem",
    id: "zotero-itemmenu-llmwiki-ingest",
    label: getString("menuitem-ingest"),
    icon: `chrome://${addon.data.config.addonRef}/content/icons/favicon@0.5x.png`,
    commandListener: (ev: Event) => addon.hooks.onMenuIngest(),
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
