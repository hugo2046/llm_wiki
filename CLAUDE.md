# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

LLM Wiki 是一个 Tauri v2 跨平台桌面应用：LLM 读取用户文档，增量构建并维护一个持久化的个人 Wiki（基于 Karpathy 的 llm-wiki 模式，见 `llm-wiki.md`）。前端为 React 19 + TypeScript + Vite + Tailwind v4 + shadcn/ui，后端为 Rust（`src-tauri/`）。

## 常用命令

```bash
npm run tauri dev        # 启动完整桌面应用（前端 + Rust 后端）
npm run dev              # 仅启动 Vite 前端（无 Tauri 能力）
npm run typecheck        # TypeScript 类型检查（tsc --build）
npm run build            # typecheck + vite build

npm run test:mocks       # 运行 mock 测试（排除 *.real-llm.test.ts 与 mcp-server）
npm run test:llm         # 运行真实 LLM 测试（需要 .env.test.local 提供 API 密钥）
npx vitest run src/lib/ingest.test.ts        # 运行单个测试文件
npx vitest run -t "测试名称片段"              # 按名称过滤测试

npm run mcp:build        # 构建 mcp-server 子包（先 npm --prefix mcp-server ci）
npm run mcp:test         # mcp-server 测试（node --test，非 vitest）

cd src-tauri && cargo build   # 仅编译 Rust 后端（需要系统安装 protobuf，LanceDB 依赖）
```

- 测试框架为 Vitest，`environment: "node"`，测试文件与被测模块同目录放置（`src/lib/foo.ts` ↔ `src/lib/foo.test.ts`），不放在独立 tests 目录。
- `*.real-llm.test.ts` 需要真实 LLM 端点，由 `src/test-helpers/load-test-env.ts` 从 `.env.test.local` 加载环境变量；日常开发只跑 `test:mocks`。
- 属性测试使用 fast-check（`*.property.test.ts`）。

## 架构

### 分层：components → stores → lib → commands → Rust

- **`src/lib/`** — 核心业务逻辑，纯 TypeScript 模块（ingest 两步链式摄取、lint、search、dedup、graph 相关性、deep-research、LLM 客户端等）。几乎每个模块都有同名测试文件。新业务逻辑应放这里并保持可脱离 UI 测试。
- **`src/stores/`** — Zustand 全局状态（wiki-store、chat-store、review-store、lint-store、activity-store 等）。
- **`src/commands/`** — 前端对 Tauri invoke 的薄封装（fs、file-sync），是前端访问文件系统的唯一通道。
- **`src/components/`** — 按功能域分目录（chat、editor、graph、lint、review、search、settings、sources、layout、ui）。
- **`src-tauri/src/`** — Rust 后端：
  - `commands/` — Tauri 命令（fs、project、search、vectorstore/LanceDB、extract_images、claude_cli/codex_cli 等）。
  - `api_server.rs` — 本地 HTTP JSON API（`127.0.0.1:19828`，端口常量在 `src/lib/api-server-constants.ts`），供 MCP server 与外部 Agent 调用。
  - `clip_server.rs` — Chrome 剪藏扩展的接收端。
  - `panic_guard.rs` — 所有 Tauri 命令通过 `run_guarded` 包裹以捕获 panic。

### 子包与外围

- **`mcp-server/`** — 独立 npm 包（`@modelcontextprotocol/sdk`），通过本地 HTTP API 暴露混合搜索/文件读取/图遍历等 MCP 工具。有自己的 package.json、tsconfig 和测试（node --test）。
- **`extension/`** — Chrome 网页剪藏扩展（纯 JS，Readability + Turndown），无构建步骤，直接 Load unpacked。

### Wiki 数据模型（三层）

用户项目目录遵循：`raw/sources/`（不可变原始文档）→ `wiki/`（LLM 生成的页面，YAML frontmatter + `[[wikilink]]`，兼容 Obsidian）→ schema/purpose（规则与意图）。`index.md` 是内容目录，`log.md` 是操作日志。相关读写逻辑集中在 `src/lib/`（frontmatter、wikilink-transform、wiki-page-resolver、source-lifecycle 等）。

### 其他约定

- LLM 调用通过 `src/lib/llm-client.ts` / `llm-providers.ts` 的流式抽象，支持 OpenAI/Anthropic/Google/Ollama/自定义端点；HTTP 请求经 `tauri-fetch.ts` 走 Tauri 的 http 插件。
- 应用版本从 package.json 经 Vite `define` 注入为 `__APP_VERSION__`；发版需同步 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 版本号。
- 路径别名 `@/` 指向 `src/`。
- Git 提交采用 Conventional Commits 风格（`feat:`、`fix:`、`ci:`、`docs:`、`release:`）。
