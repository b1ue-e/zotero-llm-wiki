# LLM Wiki for Zotero

> 将学术论文编译为结构化、双向链接的 Markdown 知识库 — 基于 Karpathy 的 LLM-Wiki 模式
>
> Compile academic papers into a structured, interlinked Markdown knowledge base — based on Karpathy's LLM-Wiki pattern

## 功能 / Features

- **📄 一键编译 / One-Click Ingest** — 选中论文，右键 → "LLM Wiki: Ingest"，自动调用 LLM 生成结构化 Wiki 页面（研究问题、方法、关键发现等）
- **🤖 AI 对话助手 / Agent Chat** — 内置 Agent 面板，支持 OpenAI function-calling，可搜索、阅读、更新 Wiki，回答研究问题
- **📚 Wiki 浏览器 / Wiki Browser** — 文件树浏览 + Markdown 预览 + 在线编辑，支持 `[[wikilinks]]` 双向导航
- **🏷️ 概念/实体自动提取 / Concept & Entity Extraction** — Ingest 时自动识别关键概念和命名实体，生成概念页面并建立双向链接，形成知识图谱
- **📄 PDF 全文提取 / PDF Fulltext** — 自动提取 PDF 全文，原始数据层作为搜索回退，确保信息不丢失
- **🌐 双语本地化 / Bilingual** — 完整支持英文和中文界面

## 安装 / Installation

### 从 Release 安装 / Install from Release

1. 下载最新 `.xpi` 文件 / Download the latest `.xpi` file from [Releases](https://github.com/b1ue-e/zotero-llm-wiki/releases)
2. Zotero → Tools → Add-ons → ⚙️ → "Install Add-on From File"
3. 选择下载的 `.xpi` 文件 / Select the downloaded `.xpi` file

### 配置 / Configuration

安装后在 Zotero Preferences → LLM Wiki 中配置 API：

- **API Endpoint** — OpenAI 兼容的 API 地址（默认 `https://api.openai.com/v1`）
- **API Key** — 你的 API 密钥
- **Model Name** — 模型名称（默认 `gpt-4o`）
- **Request Timeout** — 请求超时秒数（默认 120）
- **Auto-extract concepts** — 编译时是否自动提取概念和实体（默认开启）

## 使用 / Usage

### 编译论文 / Ingest Papers

1. 在 Zotero 中选中一篇或多篇论文
2. 右键 → **"LLM Wiki: Ingest"**
3. 等待进度条完成 — Wiki 页面将保存至 `{Zotero data}/llm-wiki/wiki/papers/`

### Wiki 浏览器 / Wiki Browser

- 选中任意文献 → 右侧面板切换到 **"Wiki Browser"** tab
- 左侧文件树浏览 papers、concepts、entities
- 点击文件预览渲染后的 Markdown
- 点击 **Edit** 进入编辑模式，**Save** 保存更改
- 点击 `[[wikilinks]]` 跳转到关联页面

### Agent 对话 / Agent Chat

- 右侧面板切换到 **"Agent"** tab
- 用自然语言提问，Agent 会搜索和阅读 Wiki 来回答
- 支持斜杠命令：
  - `/clear` — 重置对话
  - `/compact` — 压缩上下文（保留系统提示 + 最近几轮对话）
  - `/save` — 导出对话为 Markdown 文件

## 开发 / Development

### 环境要求 / Prerequisites

- Node.js ≥ 20
- Zotero 9 (Firefox ESR 115)
- 配置 `.env` 文件（参考 `.env.example`）

### 命令 / Commands

```bash
npm install        # 安装依赖
npm start          # 开发服务器：构建 + 安装到 Zotero + 热重载
npm run build      # 生产构建 (esbuild + tsc 类型检查)
npm run lint:check # Prettier + ESLint 检查
npm run lint:fix   # Prettier + ESLint 自动修复
npm run release    # 构建 + 打包 .xpi
npm test           # Zotero 集成测试（需要运行中的 Zotero）
```

### 技术栈 / Tech Stack

- TypeScript + esbuild (target: Firefox 115)
- `zotero-plugin-scaffold` — 插件脚手架和构建管线
- `zotero-plugin-toolkit` — ProgressWindow UI 组件
- `marked` — Markdown 渲染
- Firefox XPCOM API — 所有文件 I/O、网络请求（无 Node.js / fetch）

### 架构 / Architecture

```
src/
├── index.ts              # 入口 — 创建 Addon 全局单例
├── addon.ts              # Addon 类：持有 data、hooks、api
├── hooks.ts              # 生命周期回调 + 菜单/通知处理器
├── modules/
│   ├── ingest.ts          # Ingest 流程编排
│   ├── llmProvider.ts     # OpenAI 兼容 API (XMLHttpRequest)
│   ├── wikiStorage.ts     # Wiki 页面创建、索引/日志维护、LLM prompts
│   ├── wikiReader.ts      # Wiki 页面读取/搜索/树操作
│   ├── wikiBrowser.ts     # Wiki 文件浏览器 + 预览 + 编辑器面板
│   ├── agentPanel.ts      # AI Agent 对话面板 (function-calling)
│   ├── conceptExtractor.ts# LLM 驱动的概念/实体提取
│   ├── rawStorage.ts      # 原始数据 JSON 层（PDF 全文 + 元数据）
│   ├── pdfExtractor.ts    # PDF 全文提取
│   └── preferenceScript.ts# 偏好设置面板初始化
└── utils/
    ├── xpcom.ts           # Firefox XPCOM 文件 I/O 封装
    ├── locale.ts          # Fluent 本地化封装
    ├── prefs.ts           # 类型化偏好设置封装
    ├── sanitize.ts        # 文件名安全 slug 生成
    ├── ztoolkit.ts        # ZoteroToolkit 单例工厂
    └── window.ts          # 窗口有效性检查
```

插件代码运行在 Zotero 的 privileged sandbox 中 — **不能使用 `fetch`/`AbortController`/Node.js API**。所有 I/O 通过 Firefox XPCOM (`Components.classes`/`Components.interfaces`)。

### 数据架构 / Data Architecture

采用两层架构（Karpathy 模式）：

- **Raw 层** (`rawStorage.ts`)：论文元数据 + PDF 全文的不可变 JSON 快照，在 LLM 调用*之前*保存。当 Wiki 页面信息不足时作为搜索回退。
- **Wiki 层** (`wikiStorage.ts` + `wikiReader.ts`)：LLM 生成的结构化 Markdown 页面，包含 `index.md`（目录）和 `log.md`（操作日志）。

## License

AGPL-3.0-or-later
