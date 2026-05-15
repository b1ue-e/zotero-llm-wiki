# LLM-Wiki for Zotero — Development Report

> Karpathy LLM-Wiki 模式的 Zotero 9 插件实现。  
> 将学术论文通过 LLM 编译为结构化、互相链接的 Markdown 知识库。

## 项目状态：MVP 完成

**Date**: 2026-05-15  
**Version**: 0.1.0  
**Platform**: Zotero 9.0.3 / Firefox ESR 115

---

## 已实现功能

### Ingest（论文编译）
| 步骤 | 状态 |
|------|------|
| 右键菜单 → "LLM Wiki: 编译 Wiki" | ✅ |
| 菜单本地化（中/英） | ✅ |
| 提取 Zotero Item 元数据（标题/作者/摘要/DOI/年份/期刊） | ✅ |
| 调用 OpenAI 兼容 API（XHR + 超时） | ✅ |
| LLM 生成结构化 Wiki 页面 | ✅ |
| 进度窗口（编译中 / 成功 / 失败） | ✅ |
| 错误分类提示（网络/认证/超时/未知） | ✅ |

### Wiki 存储（Karpathy 模式）
| 功能 | 状态 |
|------|------|
| 目录结构 `llm-wiki/wiki/{papers,concepts,entities}/` + `raw/` | ✅ |
| `index.md` — 全局论文目录，每次 ingest 自动追加 | ✅ |
| `log.md` — append-only 操作日志 | ✅ |
| 论文 Wiki 页 — YAML frontmatter（title, type, slug, created, year, doi, tags） | ✅ |
| 结构化章节（Research Question / Method / Findings / Conclusions / Limitations / Related Work / See Also） | ✅ |
| `[[wikilinks]]` 交叉引用（Obsidian 兼容） | ✅ |
| UTF-8 编码（nsIConverterOutputStream） | ✅ |
| 文件名 slugify（含 hash 防冲突） | ✅ |

### 偏好设置
| 配置项 | 说明 |
|--------|------|
| API Endpoint | OpenAI 兼容 API 地址 |
| API Key | 密钥 |
| Model Name | 模型名称（默认 gpt-4o） |
| Request Timeout | 超时秒数（默认 120） |

---

## 架构

```
项目代码                            Zotero 数据目录
─────────                          ──────────────
src/                               ~/Zotero/llm-wiki/
├── index.ts         入口            ├── raw/              (预留)
├── addon.ts         Addon 类       └── wiki/
├── hooks.ts         生命周期            ├── index.md      全局目录
└── modules/                            ├── log.md        操作日志
    ├── ingest.ts       Ingest 编排     ├── papers/       论文 Wiki
    ├── llmProvider.ts  XHR API 调用    ├── concepts/     概念页（预留）
    ├── wikiStorage.ts  文件 I/O        └── entities/     实体页（预留）
    └── preferenceScript.ts  偏好设置
```

---

## 每篇论文 Wiki 页面 Schema

```yaml
---
title: "论文标题"
type: paper
slug: title-slug-xxxxxxxx
created: 2026-05-15
updated: 2026-05-15
authors: "作者列表"
year: 2024
doi: "10.xxx/xxx"
publication: "期刊名"
tags: ["genomics", "machine-learning"]
---
## Research Question
...

## Method
...

## Key Findings
...

## Conclusions
...

## Limitations
...

## Related Work
... [[wikilinks]] ...

## See Also
... [[concepts/...]] [[entities/...]] ...
```

---

## 关键技术决策与问题记录

### 1. ztoolkit.Menu 不可用 🔧
- **问题**: zotero-plugin-toolkit v5.1.0-beta.13 移除了 Menu 模块
- **解决**: DOM `popupshowing` 捕获 + `createXULElement("menuitem")` + `setAttribute("label", ...)`

### 2. AbortController 不可用 🔧
- **问题**: Zotero 9 特权沙箱不支持 `AbortController` / `fetch` 内部依赖
- **解决**: 改用 `XMLHttpRequest`（原生 Firefox XPCOM 支持）

### 3. 文件写入编码损坏 🔧
- **问题**: `nsIFileOutputStream.write(string)` 不保证 UTF-8，非 ASCII 字符损坏
- **解决**: `nsIConverterOutputStream` + `"UTF-8"` 确保编码

### 4. 数据目录路径 🔧
- **问题**: `Zotero.getStorageDirectory()` 返回 `storage/` 子目录
- **解决**: 使用 `Zotero.Prefs.get("dataDir")` 获取数据根目录

### 5. XPCOM 文件 I/O 🔧
- 目录创建: `nsIFile.DIRECTORY_TYPE`
- 文件写入: `nsIFileOutputStream` → `nsIConverterOutputStream("UTF-8")`
- 文件读取: `nsIFileInputStream` → `nsIBinaryInputStream`

---

## 开发环境

```bash
# 启动（自动构建 + 安装 + Zotero 启动 + 热更新）
npm start

# 手动构建
npm run build

# 调试日志
# Zotero → Help → Debug Output Logging → Enable → View Output
# 搜索 [llmwiki] 查看插件日志

# 验证插件状态（Run JavaScript）
Zotero.LLMWiki.data.initialized
Zotero.Prefs.get("dataDir")
```

### 热更新
- 监听 `src/` `addon/` 文件变更
- 自动 esbuild + 重载（~1-2秒）

---

## 依赖

| 包 | 版本 | 用途 |
|-----|------|------|
| zotero-plugin-toolkit | ^5.1.0-beta.13 | ProgressWindow, 工具 |
| zotero-plugin-scaffold | ^0.8.2 | 构建系统 |
| zotero-types | ^4.1.0-beta.4 | 类型定义 |
| esbuild | — | 打包（firefox115 target） |

---

## 下一步

1. **Query** — 跨论文查询，index.md 定位 → 读相关页面 → LLM 综合
2. **Lint** — 检查矛盾、孤立页面、死链
3. **Concept/Entity 页面自动生成** — ingest 时自动更新 concepts/ entities/
4. **PDF 全文提取** — 从 Zotero 附件读取 PDF 文本
5. **Anthropic API 支持**
6. **侧边栏面板** — Zotero 内浏览 Wiki
