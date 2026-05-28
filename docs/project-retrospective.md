# LLM-Wiki for Zotero — 项目回顾

> 100+ commits | 4 个阶段 | Firefox ESR 115 特权沙箱

## 1. 项目简介

**LLM-Wiki for Zotero** 是一个 Zotero 9 插件，将学术论文编译为结构化、互相链接的 Markdown 知识库，并提供 AI 对话界面来查询、浏览和丰富这个知识库。

灵感来自 Andrej Karpathy 的 LLM-Wiki 模式。插件围绕三层数据架构构建：

| 层       | 位置                      | 用途                                           |
| -------- | ------------------------- | ---------------------------------------------- |
| Wiki     | `llm-wiki/wiki/papers/`   | LLM 生成的结构化 Markdown，含 YAML frontmatter |
| Raw      | `llm-wiki/raw/papers/`    | 原始元数据 + PDF 全文，JSON 格式               |
| Concepts | `llm-wiki/wiki/concepts/` | 自动提取的跨论文概念，含反向链接               |

插件在 Zotero 右侧面板注册两个标签页——Wiki 浏览器用于浏览/编辑文件，Agent 用于 AI 问答并可调用工具访问整个知识库。

### 核心流程

```
选中论文 → 右键 "LLM Wiki: 编译 Wiki"
  → 提取元数据 + PDF 全文
  → 写入 raw JSON（不可变的原文层）
  → 调用 LLM 生成结构化 wiki 页面
  → 调用 LLM 提取概念/实体
  → 写入概念页面 + 反向链接
  → 更新 index.md + log.md
```

---

## 2. 架构

```
src/
├── index.ts              # 插件入口 — 实例化 Addon 单例
├── addon.ts              # 生命周期管理：持有 hooks、data、prefs
├── hooks.ts              # Zotero 生命周期回调 + 菜单/面板注册
├── modules/
│   ├── ingest.ts          # 编译编排：提取 → raw → LLM → wiki → 概念
│   ├── llmProvider.ts     # OpenAI 兼容 API，通过 XMLHttpRequest 调用
│   ├── wikiStorage.ts     # Wiki 页面 CRUD、索引/日志、appendToSection
│   ├── wikiReader.ts      # Wiki 层统一读/搜 API
│   ├── wikiBrowser.ts     # Wiki 浏览器侧边栏 UI
│   ├── agentPanel.ts      # Agent 聊天侧边栏 UI + 工具调用循环
│   ├── rawStorage.ts      # Raw JSON 层，二进制 I/O + 搜索
│   ├── pdfExtractor.ts    # PDF 全文提取，通过 Zotero.Fulltext API
│   ├── conceptExtractor.ts# LLM 概念/实体提取
│   └── preferenceScript.ts# 偏好设置面板
└── utils/
    ├── xpcom.ts           # 全部文件系统 I/O，通过 Firefox XPCOM
    ├── locale.ts          # Fluent 本地化封装
    ├── prefs.ts           # 类型化偏好设置封装
    ├── sanitize.ts        # 标题 → 文件系统安全 slug
    └── window.ts          # 窗口存活检查

addon/
├── bootstrap.js           # Firefox 引导扩展生命周期
├── manifest.json          # 扩展清单
├── prefs.js               # 偏好设置默认值
├── content/               # 静态资源（XHTML、CSS、图标）
└── locale/{en-US,zh-CN}/  # Fluent (.ftl) 本地化
```

### 两个面板，一个共享数据层

两个面板均通过 `Zotero.ItemPaneManager.registerSection()` 注册：

```
Zotero 主窗口
┌──────────┬──────────────┬─────────────────────────┐
│ 左侧     │ 中间          │ 右侧面板                 │
│ 集合列表 │ 条目列表       │ Info | Wiki | Agent     │
└──────────┴──────────────┴─────────────────────────┘
```

`wikiReader.ts` 是共享数据层，Wiki 浏览器（展示）和 Agent（工具执行）都依赖它。

---

## 3. 关键设计决策

### 3.1 两层数据架构（Karpathy 模式）

`raw/` + `wiki/` 的分层是刻意设计的：

- **Raw 层**：不可变的 JSON 快照，保存论文原始数据。在 LLM 调用之前写入，即使 LLM 失败也不丢数据。用作可搜索的降级方案。
- **Wiki 层**：LLM 生成的结构化 Markdown。人类可读、可编辑，含 `[[wikilinks]]` 导航。

### 3.2 DOM 构建策略

所有 UI 均使用 `doc.createElement()` + `appendChild()` 构建。**结构元素绝不用 `innerHTML`。** 这不是偏好——是 Zotero XUL 沙箱的硬性要求（详见 §4.1）。

### 3.3 工具调用硬限制

Agent 的 LLM 循环有代码层面的强制执行：

- 最大 10 轮工具调用
- 每次提问最多 5 次搜索——超过后强制返回"请停止搜索并回答"消息
- Wiki 搜索无结果时自动 fallback 到 raw 搜索

这些限制之所以存在，是因为 LLM 在不受约束的情况下会用略有不同的查询反复调用 `search_wiki` 20 次以上。

### 3.4 PDF 提取策略

三次尝试后放弃：

1. 检查 PDF 是否已被索引：`Zotero.Fulltext.isFullyIndexed(attachment)`
2. 触发索引：`Zotero.Fulltext.indexPDF(filePath, attachmentID)`
3. 通过 XPCOM gzip 转换器读取并解压 `.zotero-ft-cache`

所有失败返回 `null`——PDF 提取绝不会阻塞 compile 流程。

---

## 4. 调试踩坑与解决方案

本节记录最耗时的坑以及如何解决的。

### 4.1 XUL 的 innerHTML 问题（Phase 1 + 2）

**现象：** `body.innerHTML = htmlString` 视觉上渲染了内容，但 `body.children.length` 返回 `0`。`querySelector` 和 `getElementById` 返回 `null`。

**根因：** Zotero 9 运行在 XUL（XML 用户界面语言）文档中。在 XUL 元素上设置 `innerHTML` 时，浏览器解析 HTML 并视觉渲染，但解析出的节点进入了匿名 XUL 内容作用域，无法通过标准 DOM API（`.children`、`.querySelector`、`.getElementById`）访问。

**解决方案：** 绝不对需要后续引用的元素使用 `innerHTML`。全部用 `doc.createElement("div")` 构建，直接设置属性（`el.className = "..."`，`el.textContent = "..."`），用 `el.appendChild()` 追加。将创建的元素引用保存在模块的 state 对象中。

对于渲染的 Markdown 内容（不需要查找子元素），在叶子元素上使用 `innerHTML` 作为纯展示是可以接受的。

**涉及文件：** `wikiBrowser.ts`、`agentPanel.ts`

### 4.2 XUL 中的 Markdown 渲染（Phase 2）

**现象：** 所有基于 HTML 字符串的方法都无法渲染 Markdown：`innerHTML`、`createContextualFragment()`、`insertAdjacentHTML`、`createElementNS(XHTML)`——要么剥离了 HTML 标签，要么直接抛异常。

**尝试过的修复（全部失败）：**

1. `el.innerHTML = marked.parse(text)` — 标签被剥离
2. `doc.createElementNS(XHTML_NS, "div")` + `innerHTML` — 标签被剥离
3. `range.createContextualFragment(html)` — 曾经成功过一次，后来又不行了
4. `el.insertAdjacentHTML("beforeend", html)` — 标签被剥离
5. `new DOMParser().parseFromString()` + `importNode()` — DOMParser 不可用
6. pdf.js（pdfjs-dist npm 包）— 缺少 canvas/Worker 导致插件崩溃

**解决方案：** 手写了一个 Markdown 转 DOM 的渲染器（`renderMarkdownTo` + `renderInlineTo`）。逐行解析 Markdown 并直接创建 DOM 元素：

- `## 标题` → `doc.createElement("h2")`
- `**粗体**` → `doc.createElement("strong")`
- `- 列表` → `doc.createElement("ul")` + `doc.createElement("li")`
- 表格、代码块、引用块、链接均支持

支持：h1-h4 标题、段落、粗体、斜体、行内代码、链接、有序/无序列表、表格、代码块、引用块、分割线。

**文件：** `agentPanel.ts`（renderMarkdownTo、renderInlineTo 函数）

### 4.3 PDF 二进制读取损坏（Phase 3）

**现象：** `readFile(pdfPath)` 抛出 `NS_ERROR_ILLEGAL_INPUT [nsIConverterInputStream.readString]`。

**根因：** `readFile` 使用 `nsIConverterInputStream("UTF-8")` 将字节按 UTF-8 文本解码。PDF 文件是二进制文件——包含对 UTF-8 无效的字节序列。转换器遇到无效序列时抛出异常。

**解决方案：** 在 `xpcom.ts` 中新增 `readBinaryFile()`——使用 `nsIBinaryInputStream.readBytes()` 直接读原始字节，不做任何编码转换。同时新增 `writeBinaryFile()` 实现对称的二进制写入。

**文件：** `xpcom.ts`、`pdfExtractor.ts`、`rawStorage.ts`

### 4.4 UTF-8 转换器损坏 JSON（Phase 3）

**现象：** 对 raw JSON 文件执行 `JSON.parse()` 失败，报 "unterminated string at line 8 column 7967"。

**根因：** `writeFile` 使用 `nsIConverterOutputStream("UTF-8")`。写入含有来自 PDF 全文的特殊字符（未配对 surrogate、null 字节、控制字符）的大字符串时，UTF-8 转换器产生损坏的输出，导致 JSON 无效。

**解决方案：** 将 `rawStorage` 切换为使用 `writeBinaryFile` + `readBinaryFile` 进行所有 JSON I/O。二进制 I/O 按原始字节写入，不经过编码转换，保留 `JSON.stringify` 的精确输出。同时将 fulltext 截断至 200KB 以限制文件大小。

**文件：** `xpcom.ts`（新增 writeBinaryFile）、`rawStorage.ts`

### 4.5 选中条目时面板被销毁（Phase 1 + 2）

**现象：** 点击不同的 Zotero 条目会导致 Wiki 浏览器或 Agent 面板丢失所有状态——对话消失，文件树变空白。

**根因：** Zotero 在条目面板刷新时（选中条目、切换标签页）会调用 `onRender`。我们的代码每次 `onRender` 都会从头重建整个 DOM。

**尝试过的修复（失败）：**

1. `if (body.firstChild) return;` — 无效，因为 Zotero 销毁了旧的 body 元素并创建了新的空 body

**解决方案：** 通过 `state.tree?.parentNode`（或 `state.chatEl?.parentNode`）检查我们的元素是否仍在 DOM 中。如果已脱离，重建外壳并从内存恢复状态。如果仍连接，跳过。

对于 Agent 面板，对话历史（`state.messages`）在重建时保留并重新渲染到新 DOM 中。

**文件：** `wikiBrowser.ts`、`agentPanel.ts`

### 4.6 XPCOM 目录枚举（Phase 1）

**现象：** `listDir()` 返回空数组，尽管磁盘上存在文件。

**根因：** Firefox XPCOM 的 `nsIDirectoryEnumerator` 有多个问题：

1. `enumerator.getNext()` 返回 `nsISupports`——必须 `QueryInterface(nsIFile)` 才能访问 `.path`
2. 去掉 `QueryInterface`（作为 #1 的修复尝试）导致 `.path` 返回 `undefined`
3. 需要调用 `enumerator.close()` 释放枚举器

**解决方案：** 使用 `enumerator.getNext().QueryInterface(Components.interfaces.nsIFile)` 模式，push 前检查 `file && file.path`，调用 `enumerator.close()`。

**文件：** `xpcom.ts`（listDir）

### 4.7 XPCOM Gzip 解压（Phase 3）

**现象：** 用 XPCOM 解压 `.zotero-ft-cache` 花了 4 轮迭代才搞定。

**迭代记录：**

1. `nsIStringInputStream.setData(raw, raw.length)` → "setData is not a function"（FF115 已废弃）
2. `adoptData()` / `setByteStringData()` / `setUTF8String()` → 全都无效
3. `nsIStreamConverter.convert(inputStream)` → "Not enough arguments"（需要 4 个参数）
4. `nsIStreamConverterService.convert(inputStream, "gzip", "uncompressed", null)` → "NS_ERROR_NOT_IMPLEMENTED"
5. 发现缓存并非 gzip 压缩——文本与二进制词位置数据直接交织存储

**解决方案：** 缓存文件直接存储文本，不需要 gzip 解压。完全跳过解压步骤。用正则过滤不可打印字符，提取可读句子。gzip 解压路径保留作为降级方案。

**文件：** `pdfExtractor.ts`（tryReadCache、decompressGzip、extractReadableText）

### 4.8 LLM 工具调用死循环（Phase 2 + 3）

**现象：** Agent 用不同查询调用了 8 次以上的 `search_wiki`，始终不回答。

**根因：** LLM 看到了论文的 raw 片段，但用户询问的特定小节不在片段中（位于全文更深处）。LLM 不断重新构造查询，希望找到目标段落。

**解决方案（分层）：**

1. **System prompt**："停止并回答"规则，最多 3 次搜索 → LLM 无视
2. **代码级限制**：`MAX_SEARCHES = 5`——5 次搜索后返回"请停止搜索并回答" → 有效
3. **位置步进片段**：每次 `searchRaw` 返回全文不同 5KB 区段（10KB 步长），而不是每次都返回同一段 intro → LLM 获得多样化内容

**文件：** `agentPanel.ts`（handleSend 工具循环）、`rawStorage.ts`（searchRaw 步进）

### 4.9 Raw 搜索精确短语匹配（Phase 3）

**现象：** `searchRaw("Trait-associated neurons mouse hippocampus")` 返回空，尽管全文中包含所有这些词。

**根因：** 搜索使用 `fulltext.includes(query)`，要求完整查询字符串作为连续子串出现。多词查询几乎不可能按精确短语匹配到。

**解决方案：** 将查询按词拆分，任一单词出现在文本中即匹配。`queryWords.some(w => fulltextLower.includes(w))`。

**文件：** `rawStorage.ts`（searchRaw）

### 4.10 DeepSeek reasoning_content（Phase 2）

**现象：** API 返回 400："reasoning_content in thinking mode must be passed back."

**根因：** DeepSeek 的思考模式在 assistant 消息中返回 `reasoning_content`。当我们将消息重新构建后发送下一次 API 调用时，只保留了 `content` 和 `tool_calls`，丢弃了 `reasoning_content`。

**解决方案：** 存储 API 返回的完整原始消息（`rawMessage`），在重建 assistant 消息时展开其属性：`{ role: "assistant", content, tool_calls, ...rawMessage }`。

**文件：** `agentPanel.ts`（LLMResponse 接口、callLLM、handleSend）

### 4.11 `appendToSection` 双层 `papers/` 前缀（Phase 3）

**现象：** `update_wiki_section` 工具报告成功，但磁盘上的 wiki 文件没有变化。

**根因：** LLM 传入 `slug = "papers/spatially-resolved-..."`，`appendToSection` 拼接路径为 `/wiki/papers/papers/spatially-resolved-...md`——双层 `papers/` 前缀，写入了不存在的目录。

**解决方案：** 在 `appendToSection` 中自动去除 `papers/` 前缀和 `.md` 后缀。

**文件：** `wikiStorage.ts`（appendToSection）

---

## 5. Zotero 9 沙箱速查表

### 可用

- `XMLHttpRequest` — 没有 `fetch`
- `Components.classes` / `Components.interfaces` — XPCOM
- `doc.createElement("div")` — XUL 元素
- `element.appendChild()`、`element.removeChild()`、`element.firstChild`
- `element.className`、`element.textContent`、`element.style`
- `element.addEventListener("click", fn)`
- `setTimeout` — 标准浏览器定时器
- `async/await` — 可用
- `JSON.parse` / `JSON.stringify`
- `Zotero.Prefs.get()`、`Zotero.debug()`、`Zotero.Items.get()`
- `Zotero.ItemPaneManager.registerSection()`

### 不可用

- `fetch`、`AbortController` — 使用 XHR
- panel 上下文中的 `document` 全局变量 — 使用 `element.ownerDocument`
- XUL 注入内容上的 `querySelector`、`getElementById` — 使用保存的引用
- 结构元素上的 `innerHTML` — 内容进入匿名作用域
- `DOMParser`、`Worker`、`canvas` — 没有 web worker 或 canvas
- `require()` — 仅支持 ESM，esbuild 打包 `import`
- `window` 全局变量 — 可能不存在

### XHR 模式

```typescript
return new Promise((resolve, reject) => {
  const xhr = new XMLHttpRequest();
  xhr.open("POST", url, true);
  xhr.setRequestHeader("Content-Type", "application/json");
  xhr.setRequestHeader("Authorization", `Bearer ${apiKey}`);
  xhr.timeout = timeoutMs;
  xhr.onload = () => {
    /* 解析响应 */
  };
  xhr.onerror = () => reject(new Error("Network error"));
  xhr.ontimeout = () => reject(new Error("Timeout"));
  xhr.send(body);
});
```

### XPCOM 文件 I/O

```typescript
// 文本（UTF-8）：nsIConverterOutputStream 写入，nsIConverterInputStream 读取
// 二进制：nsIBinaryOutputStream 写入，nsIBinaryInputStream 读取
// 目录列表：nsIFile.directoryEntries → nsISimpleEnumerator → QueryInterface(nsIFile)
```

---

## 6. 总结

项目成功将 Zotero 论文库与 LLM 驱动的知识管理连接起来。三点最重要的体会：

1. **XUL 沙箱是最主要的约束。** 每个 UI 决策都源于 `innerHTML` 不能用于元素访问这一事实。用 `createElement` 构建 DOM 虽然冗长，但是可靠的。

2. **LLM 需要代码级护栏，而非 prompt 指令。** 诸如"3 次搜索后停止"的 system prompt 规则被持续无视。工具循环中的硬限制才是必要的。

3. **raw + wiki 两层模式非常强大。** Wiki 层为快速回答提供结构化摘要。Raw 层为深入问题提供原始文本。两者之间的自动降级使系统稳健可靠。
