// ─── Path helpers ───

function getWikiBaseDir(): string {
  let dataPath = Zotero.Prefs.get("dataDir") as string;
  if (!dataPath) {
    const storagePath = Zotero.getStorageDirectory().path;
    dataPath = storagePath.substring(0, storagePath.lastIndexOf("/"));
  }
  return `${dataPath}/llm-wiki/wiki`;
}

function getRawDir(): string {
  let dataPath = Zotero.Prefs.get("dataDir") as string;
  if (!dataPath) {
    const storagePath = Zotero.getStorageDirectory().path;
    dataPath = storagePath.substring(0, storagePath.lastIndexOf("/"));
  }
  return `${dataPath}/llm-wiki/raw`;
}

// ─── XPCOM file I/O ───

function makeDir(path: string): void {
  // @ts-expect-error - Mozilla XPCOM
  const nsIFile = Components.classes["@mozilla.org/file/local;1"]
    .createInstance(Components.interfaces.nsIFile) as any;
  nsIFile.initWithPath(path);
  if (!nsIFile.exists()) {
    nsIFile.create(Components.interfaces.nsIFile.DIRECTORY_TYPE, 0o755);
  }
}

function writeFile(path: string, content: string): void {
  // @ts-expect-error - Mozilla XPCOM
  const file = Components.classes["@mozilla.org/file/local;1"]
    .createInstance(Components.interfaces.nsIFile) as any;
  file.initWithPath(path);
  // @ts-expect-error - Mozilla XPCOM
  const stream = Components.classes["@mozilla.org/network/file-output-stream;1"]
    .createInstance(Components.interfaces.nsIFileOutputStream) as any;
  stream.init(file, 0x02 | 0x08 | 0x20, 0o644, 0);
  // @ts-expect-error - Mozilla XPCOM
  const converter = Components.classes["@mozilla.org/intl/converter-output-stream;1"]
    .createInstance(Components.interfaces.nsIConverterOutputStream) as any;
  converter.init(stream, "UTF-8", 0, 0x0000);
  converter.writeString(content);
  converter.close();
  stream.close();
}

function readFile(path: string): string | null {
  // @ts-expect-error - Mozilla XPCOM
  const file = Components.classes["@mozilla.org/file/local;1"]
    .createInstance(Components.interfaces.nsIFile) as any;
  file.initWithPath(path);
  if (!file.exists()) return null;
  // @ts-expect-error - Mozilla XPCOM
  const stream = Components.classes["@mozilla.org/network/file-input-stream;1"]
    .createInstance(Components.interfaces.nsIFileInputStream) as any;
  stream.init(file, 0x01, 0o644, 0);
  // @ts-expect-error - Mozilla XPCOM
  const converter = Components.classes["@mozilla.org/intl/converter-input-stream;1"]
    .createInstance(Components.interfaces.nsIConverterInputStream) as any;
  converter.init(stream, "UTF-8", 0, 0);
  const str: { value: string } = { value: "" };
  converter.readString(-1, str);
  converter.close();
  stream.close();
  return str.value;
}

function listDir(path: string): string[] {
  // @ts-expect-error - Mozilla XPCOM
  const dir = Components.classes["@mozilla.org/file/local;1"]
    .createInstance(Components.interfaces.nsIFile) as any;
  dir.initWithPath(path);
  if (!dir.exists() || !dir.isDirectory()) return [];
  const enumerator = dir.directoryEntries;
  const result: string[] = [];
  while (enumerator.hasMoreElements()) {
    const raw = enumerator.getNext();
    const file = raw.QueryInterface(Components.interfaces.nsIFile);
    if (file && file.path) {
      result.push(file.path);
    }
  }
  enumerator.close();
  return result;
}

function fileExists(path: string): boolean {
  // @ts-expect-error - Mozilla XPCOM
  const file = Components.classes["@mozilla.org/file/local;1"]
    .createInstance(Components.interfaces.nsIFile) as any;
  file.initWithPath(path);
  return file.exists();
}

function ensureDirs(): void {
  const base = getWikiBaseDir();
  makeDir(base);
  makeDir(`${base}/papers`);
  makeDir(`${base}/concepts`);
  makeDir(`${base}/entities`);
  makeDir(getRawDir());
}

export {
  getWikiBaseDir,
  getRawDir,
  makeDir,
  writeFile,
  readFile,
  listDir,
  fileExists,
  ensureDirs,
};
