<p align="center">
  <img src="addon/content/icons/favicon.png" width="96" height="96" alt="LLM Wiki" />
</p>
<h1 align="center">LLM Wiki for Zotero</h1>
<p align="center">
  <sup>中文</sup> 将学术论文编译为结构化 · 双向链接的 Markdown 知识库<br />
  <sub>EN</sub> Compile academic papers into a structured, interlinked Markdown knowledge base
</p>
<p align="center">
  <sub>Based on <a href="https://github.com/karpathy/llm-wiki">Karpathy's LLM-Wiki</a> pattern</sub>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Zotero-9-blue?logo=zotero" alt="Zotero 9" />
  <img src="https://img.shields.io/badge/license-AGPL--3.0-green" alt="AGPL-3.0" />
  <img src="https://img.shields.io/badge/version-0.1.0-lightgrey" alt="v0.1.0" />
</p>

---

**<sup>中文</sup>** 在 Zotero 中选中论文，右键 → "LLM Wiki: Ingest"，插件调用 OpenAI 兼容 API 自动生成结构化 Wiki 页面。支持 AI Agent 对话、概念/实体自动提取、PDF 全文搜索。<br />
**<sub>EN</sub>** Select a paper in Zotero, right-click → "LLM Wiki: Ingest", and the plugin calls an OpenAI-compatible API to generate a structured wiki page. Includes AI Agent chat, concept/entity extraction, and PDF fulltext search.

---

## 功能 Features

<table>
<tr>
<td width="50%">

**中文**

- 🚀 **一键编译** — 自动生成包含研究问题、方法、关键发现等章节的 Wiki 页面
- 🤖 **AI Agent** — Function-calling 驱动的研究助手，可搜索、阅读、更新 Wiki
- 📚 **Wiki 浏览器** — 文件树 + Markdown 预览 + 在线编辑 + `[[wikilinks]]` 导航
- 🏷️ **概念/实体提取** — 自动识别关键概念，生成知识图谱双向链接
- 📄 **PDF 全文** — 自动提取全文作为搜索回退层
- 🌐 **双语界面** — 完整中英文支持

</td>
<td width="50%">

**English**

- 🚀 **One-Click Ingest** — Auto-generates wiki pages with Research Question, Method, Key Findings sections
- 🤖 **AI Agent** — Function-calling research assistant that searches, reads, and updates the wiki
- 📚 **Wiki Browser** — File tree + Markdown preview + inline editor + `[[wikilinks]]` navigation
- 🏷️ **Concept/Entity Extraction** — Auto-identifies key concepts, builds knowledge graph backlinks
- 📄 **PDF Fulltext** — Auto-extracts fulltext as fallback search layer
- 🌐 **Bilingual UI** — Full English and Chinese support

</td>
</tr>
</table>

---

## 安装 Installation

<table>
<tr>
<td width="50%">

**中文**

1. 从 [Releases](https://github.com/b1ue-e/zotero-llm-wiki/releases) 下载 `.xpi`
2. Zotero → 工具 → 插件 → ⚙️ → "从文件安装附加组件"
3. 偏好设置 → LLM Wiki → 填入 API Endpoint 和 Key

</td>
<td width="50%">

**English**

1. Download `.xpi` from [Releases](https://github.com/b1ue-e/zotero-llm-wiki/releases)
2. Zotero → Tools → Add-ons → ⚙️ → "Install Add-on From File"
3. Preferences → LLM Wiki → set API Endpoint and Key

</td>
</tr>
</table>

### 配置项 Preferences

| 配置项 | 默认值 Default | 说明 Description |
|--------|---------------|------------------|
| API Endpoint | `https://api.openai.com/v1` | OpenAI 兼容 API 地址 |
| API Key | — | 你的 API 密钥 / Your API key |
| Model Name | `gpt-4o` | 模型名称 / Model to use |
| Request Timeout | `120` | 超时秒数 / Timeout in seconds |
| Auto-extract concepts | ✔ | 编译时自动提取概念 / Auto-extract during ingest |

---

## 使用 Usage

### 编译论文 Ingest

<table>
<tr>
<td width="50%">

**中文**

1. 选中一篇或多篇论文
2. 右键 → **"LLM Wiki: Ingest"**
3. Wiki 页面保存至 `{Zotero data}/llm-wiki/wiki/papers/`

</td>
<td width="50%">

**English**

1. Select one or more papers
2. Right-click → **"LLM Wiki: Ingest"**
3. Wiki saved to `{Zotero data}/llm-wiki/wiki/papers/`

</td>
</tr>
</table>

### Agent 命令 Commands

| 命令 | 说明 Description |
|------|------------------|
| `/clear` | 重置对话 / Reset conversation |
| `/compact` | 压缩上下文，保留最近对话 / Compress context window |
| `/save` | 导出对话为 Markdown / Export conversation as Markdown |

---

## 开发 Development

```bash
npm install        # 安装依赖 Install
npm start          # 开发服务器 Dev server (hot reload)
npm run build      # 生产构建 Production build
npm run lint:check # 代码检查 Lint check
npm run lint:fix   # 代码修复 Lint fix
npm run release    # 打包 .xpi Package for distribution
```

**技术栈 Tech Stack:** TypeScript · esbuild (Firefox 115) · `zotero-plugin-scaffold` · `marked` · Firefox XPCOM

> 插件运行在 Zotero privileged sandbox 中，不可以使用 `fetch` / `AbortController` / Node.js API。所有 I/O 通过 `Components.classes` / `Components.interfaces`。
>
> The plugin runs in Zotero's privileged sandbox — no `fetch`, `AbortController`, or Node.js APIs. All I/O via `Components.classes` / `Components.interfaces`.

### 架构 Architecture

```
src/
├── index.ts               # 入口 Entry — 全局单例 Addon
├── addon.ts               # Addon 类：data, hooks, api
├── hooks.ts               # 生命周期 + 菜单/通知 Lifecycle + menu + notifier
├── modules/
│   ├── ingest.ts           # Ingest 流程编排 Pipeline orchestration
│   ├── llmProvider.ts      # OpenAI API → XMLHttpRequest
│   ├── wikiStorage.ts      # Wiki 页面创建 + 索引/日志 Page CRUD + index/log
│   ├── wikiReader.ts       # 搜索/读取/树操作 Search/read/tree
│   ├── wikiBrowser.ts      # 文件浏览器面板 File browser tab panel
│   ├── agentPanel.ts       # AI Agent 对话面板 Chat tab panel (tool-calling)
│   ├── conceptExtractor.ts # 概念/实体 LLM 提取 Concept extraction
│   ├── rawStorage.ts       # 原始 JSON 数据层 Raw paper data layer
│   ├── pdfExtractor.ts     # PDF 全文提取 Fulltext extraction
│   └── preferenceScript.ts # 偏好设置面板 Preferences pane
└── utils/
    ├── xpcom.ts            # XPCOM 文件 I/O 封装
    ├── locale.ts           # Fluent 本地化封装
    ├── prefs.ts            # 类型化偏好设置
    ├── sanitize.ts         # 文件名安全 slug
    ├── ztoolkit.ts         # ZoteroToolkit 工厂
    └── window.ts           # 窗口有效性检查
```

### 数据流 Data Flow

```
Zotero Item → extractMetadata() → writeRaw() → LLM Call #1 → writeWikiPage()
                                                                      ↓
                                                          LLM Call #2 (conceptExtractor)
                                                                      ↓
                                                          writeConceptPage() + backlinks
```

---

## License

AGPL-3.0-or-later · [b1ue-e](https://github.com/b1ue-e)
