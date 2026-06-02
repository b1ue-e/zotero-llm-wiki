<p align="center">
  <img src="./wikipedia.png" width="96" height="96" alt="LLM Wiki" />
</p>

<h1 align="center">LLM Wiki for Zotero</h1>

<p align="center">
  <a href="#中文">中文</a> | <a href="#english">English</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Zotero-9-blue?logo=zotero" alt="Zotero 9" />
  <img src="https://img.shields.io/badge/license-AGPL--3.0-green" alt="AGPL-3.0" />
  <img src="https://img.shields.io/badge/version-0.2.1-lightgrey" alt="v0.2.1" />
</p>

---

## 中文

### 简介

在 Zotero 中选中论文，右键 → "LLM Wiki: Ingest"，插件调用 OpenAI 兼容 API 自动生成结构化 Wiki 页面。基于 [Karpathy 的 LLM-Wiki](https://github.com/karpathy/llm-wiki) 模式。

### 功能

- 🚀 **一键编译** — 自动生成包含研究问题、方法、关键发现、结论等章节的 Wiki 页面
- 🤖 **AI Agent** — Function-calling 驱动的研究助手，可搜索、阅读 Wiki、更新章节、编译新论文；支持 `/deep_research` 自主多步深度研究
- 🔬 **深度研究** — 多轮自主研究 + 结构化报告 + 元分析 + Session 复用，三阶段量化 Prompt
- 📚 **Wiki 浏览器** — 文件树浏览 + Markdown 预览 + 在线编辑 + `[[wikilinks]]` 双向导航
- 🏷️ **概念/实体自动提取** — 编译时自动识别关键概念和命名实体，生成概念页面并建立知识图谱双向链接
- 🕸️ **知识图谱探索** — Agent 图谱查询工具 + Wiki 浏览器卡片式关系视图，BFS 路径查找
- 💡 **主动建议** — 自动检测跨论文模式、知识空白、缺失论文，Wiki Browser 内联展示
- 📄 **PDF 全文搜索** — 自动提取 PDF 全文存入原始数据层，Wiki 信息不足时作为搜索回退
- 📊 **会话监控** — 6 种异常信号自动检测（重复提问/否定反馈/短报告/推理泄露/工具失败/API 故障），自动保存会话快照
- 🌐 **完整中英文本地化** — 所有界面文本支持中文和英文

### 安装

1. 从 [Releases](https://github.com/b1ue-e/zotero-llm-wiki/releases) 下载 `.xpi`
2. Zotero → 工具 → 插件 → ⚙️ → "从文件安装附加组件"
3. 偏好设置 → LLM Wiki → 配置 API Endpoint 和 Key

### 配置项

| 配置项                | 默认值                      | 说明                     |
| --------------------- | --------------------------- | ------------------------ |
| API Endpoint          | `https://api.openai.com/v1` | OpenAI 兼容 API 地址     |
| API Key               | —                           | 你的 API 密钥            |
| Model Name            | `gpt-4o`                    | 模型名称                 |
| Request Timeout       | `120`                       | 超时秒数                 |
| Auto-extract concepts | ✔                           | 编译时自动提取概念和实体 |

### 使用

**编译论文：** 选中论文 → 右键 → "LLM Wiki: Ingest" → Wiki 保存至 `{Zotero data}/llm-wiki/wiki/papers/`

**Wiki 浏览器：** 右侧面板 → "Wiki Browser" tab → 浏览、预览、编辑 Wiki 页面

**Agent 对话：** 右侧面板 → "Agent" tab → 用自然语言提问

| 命令       | 说明                     |
| ---------- | ------------------------ |
| `/clear`   | 重置对话                 |
| `/compact` | 压缩上下文，保留最近几轮 |
| `/save`             | 导出对话为 Markdown                       |
| `/deep_research`    | 启动自主多步深度研究，生成结构化报告和元分析 |

### 开发

```bash
npm install        # 安装依赖
npm start          # 开发服务器（热重载）
npm run build      # 生产构建
npm run release    # 打包 .xpi
npm test           # 集成测试（需运行 Zotero）
```

**技术栈：** TypeScript · esbuild (Firefox 115) · `zotero-plugin-scaffold` · `marked` · Firefox XPCOM

> 插件运行在 Zotero privileged sandbox 中，不可使用 `fetch` / `AbortController` / Node.js API。

### 架构

```
src/
├── index.ts               # 入口 — Addon 全局单例
├── addon.ts               # Addon 类：data, hooks, api
├── hooks.ts               # 生命周期 + 菜单 + 通知
├── modules/
│   ├── ingest.ts           # Ingest 流程编排
│   ├── llmProvider.ts      # OpenAI API (XMLHttpRequest)
│   ├── wikiStorage.ts      # Wiki 页面 CRUD + 索引/日志
│   ├── wikiReader.ts       # 搜索/读取/树操作
│   ├── wikiBrowser.ts      # Wiki 浏览器面板
│   ├── agentPanel.ts       # AI Agent 对话面板 (tool-calling + 深度研究)
│   ├── deepResearch.ts     # 自主多步研究 + Session 持久化 + 元分析
│   ├── sessionMonitor.ts   # 会话异常信号检测 + 自动反馈快照
│   ├── conceptExtractor.ts # 概念/实体 LLM 提取
│   ├── rawStorage.ts       # 原始 JSON 数据层
│   ├── pdfExtractor.ts     # PDF 全文提取
│   └── preferenceScript.ts # 偏好设置面板
└── utils/
    ├── xpcom.ts            # XPCOM 文件 I/O
    ├── locale.ts           # Fluent 本地化
    ├── prefs.ts            # 类型化偏好设置
    ├── sanitize.ts         # 文件名安全 slug
    ├── ztoolkit.ts         # ZoteroToolkit 工厂
    └── window.ts           # 窗口有效性检查
```

---

## English

### About

Select a paper in Zotero, right-click → "LLM Wiki: Ingest", and the plugin calls an OpenAI-compatible API to generate a structured wiki page. Based on [Karpathy's LLM-Wiki](https://github.com/karpathy/llm-wiki) pattern.

### Features

- 🚀 **One-Click Ingest** — Auto-generates wiki pages with Research Question, Method, Key Findings, Conclusions sections
- 🤖 **AI Agent** — Function-calling research assistant that searches, reads, updates the wiki; supports `/deep_research` for autonomous multi-step research
- 🔬 **Deep Research** — Multi-round autonomous research + structured reports + meta-analysis + session reuse with quantified three-phase prompts
- 📚 **Wiki Browser** — File tree + Markdown preview + inline editor + `[[wikilinks]]` navigation
- 🏷️ **Concept/Entity Extraction** — Auto-identifies key concepts and named entities, builds knowledge graph with bidirectional links
- 🕸️ **Knowledge Graph Explorer** — Agent graph query tools + Wiki Browser card-style relationship view, BFS path finding
- 💡 **Proactive Suggestions** — Auto-detects cross-paper patterns, knowledge gaps, missing papers with inline Suggestions bar
- 📄 **PDF Fulltext Search** — Auto-extracts PDF fulltext into raw data layer as search fallback
- 📊 **Session Monitor** — 6 auto-detected anomaly signals (repeat questions, frustration, short reports, reasoning leaks, tool failures, API faults) with session snapshots
- 🌐 **Bilingual UI** — Full English and Chinese localization

### Installation

1. Download `.xpi` from [Releases](https://github.com/b1ue-e/zotero-llm-wiki/releases)
2. Zotero → Tools → Add-ons → ⚙️ → "Install Add-on From File"
3. Preferences → LLM Wiki → set API Endpoint and Key

### Preferences

| Setting               | Default                     | Description                         |
| --------------------- | --------------------------- | ----------------------------------- |
| API Endpoint          | `https://api.openai.com/v1` | OpenAI-compatible API URL           |
| API Key               | —                           | Your API key                        |
| Model Name            | `gpt-4o`                    | Model to use                        |
| Request Timeout       | `120`                       | Timeout in seconds                  |
| Auto-extract concepts | ✔                           | Auto-extract concepts during ingest |

### Usage

**Ingest:** Select papers → right-click → "LLM Wiki: Ingest" → Wiki saved to `{Zotero data}/llm-wiki/wiki/papers/`

**Wiki Browser:** Right panel → "Wiki Browser" tab → browse, preview, edit pages

**Agent Chat:** Right panel → "Agent" tab → ask questions in natural language

| Command    | Description                     |
| ---------- | ------------------------------- |
| `/clear`   | Reset conversation              |
| `/compact` | Compress context window         |
| `/save`             | Export conversation as Markdown                   |
| `/deep_research`    | Start autonomous multi-step research with report    |

### Development

```bash
npm install        # Install dependencies
npm start          # Dev server (hot reload)
npm run build      # Production build
npm run release    # Package .xpi
npm test           # Integration tests (requires running Zotero)
```

**Tech Stack:** TypeScript · esbuild (Firefox 115) · `zotero-plugin-scaffold` · `marked` · Firefox XPCOM

> The plugin runs in Zotero's privileged sandbox — no `fetch`, `AbortController`, or Node.js APIs.

### Architecture

```
src/
├── index.ts               # Entry — Addon global singleton
├── addon.ts               # Addon class: data, hooks, api
├── hooks.ts               # Lifecycle + menu + notifier
├── modules/
│   ├── ingest.ts           # Ingest pipeline orchestration
│   ├── llmProvider.ts      # OpenAI API (XMLHttpRequest)
│   ├── wikiStorage.ts      # Wiki page CRUD + index/log
│   ├── wikiReader.ts       # Search/read/tree operations
│   ├── wikiBrowser.ts      # Wiki browser tab panel
│   ├── agentPanel.ts       # AI Agent chat panel (tool-calling + deep research)
│   ├── deepResearch.ts     # Autonomous multi-step research + session persistence
│   ├── sessionMonitor.ts   # Auto feedback capture + signal detection
│   ├── conceptExtractor.ts # Concept/entity LLM extraction
│   ├── rawStorage.ts       # Raw JSON data layer
│   ├── pdfExtractor.ts     # PDF fulltext extraction
│   └── preferenceScript.ts # Preferences pane
└── utils/
    ├── xpcom.ts            # XPCOM file I/O
    ├── locale.ts           # Fluent localization
    ├── prefs.ts            # Typed preferences
    ├── sanitize.ts         # Safe filename slugs
    ├── ztoolkit.ts         # ZoteroToolkit factory
    └── window.ts           # Window liveness check
```

---

<p align="center">
  <sub>AGPL-3.0-or-later · <a href="https://github.com/b1ue-e">b1ue-e</a></sub>
</p>
