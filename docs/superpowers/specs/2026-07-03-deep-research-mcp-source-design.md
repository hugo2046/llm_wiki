# 设计：deep-research 接入 MCP 数据源

日期：2026-07-03
状态：已确认（用户批准：检索源模式；配置放「外部信息源」设置区）

## 背景与动机

deep-research 目前只有两类信息来源：网页搜索 Provider 与本地 AnyTXT
（`DeepResearchSource = "web" | "anytxt" | "both"`）。用户希望能从自己部署的
MCP server（如金融数据服务 tushare 的 MCP 封装）获取结构化数据参与研究，
而非只能依赖网上搜索。

应用现有 `mcp-server/` 子包是反方向（对外暴露本应用能力），本设计新增的
是 **MCP 客户端**能力。

## 范围

**做**（检索源模式）：

1. 极简 MCP Streamable HTTP 客户端（纯 TS，走 `tauri-fetch`，零新依赖）。
2. `SearchApiConfig` 增加 `mcpServers?: McpServerConfig[]`；每个 server 自带
   `enabled` 开关，启用者在 research 时并行参战。
3. `collectResearchSources` 归并 MCP 结果进现有 `WebSearchResult[]` 管线
   （统一去重与 20 条封顶）。
4. 「外部信息源」设置区（`web-search-section.tsx`）新增「MCP 数据源」卡片：
   server 列表增删改、启用开关、测试连接。
5. 四语 i18n 文案（`settings.sections.webSearch.mcp*`）。

**不做**（未来扩展，YAGNI）：

- Agentic 工具模式（综合阶段 LLM 多轮调用 MCP 工具）——另一个量级的
  架构，不为其预留事前抽象。
- stdio 传输（本地进程型 server）——用户可用 `fastmcp` 的 HTTP 模式或
  `mcp-proxy` 桥接，文档写明；Rust stdio 客户端待有真实需求再做。
- MCP resources/prompts/采样/通知等协议能力——只用 `initialize`、
  `tools/list`（测试连接）、`tools/call`（检索）。

## 组件设计

### 1. `src/lib/mcp-search.ts`（新模块，纯逻辑 + IO 包装分离）

```ts
export interface McpServerConfig {
  id: string            // 稳定标识（增删用）
  name: string          // 显示名，也进结果 source 字段
  url: string           // Streamable HTTP 端点，如 http://127.0.0.1:8000/mcp
  authHeader?: string   // 可选 Authorization 头的完整值，如 "Bearer xxx"
  toolName: string      // 要调用的工具名
  queryParam: string    // 查询词写入的参数名，默认 "query"
  extraArgs?: string    // 可选固定参数（JSON 对象字符串），与查询词合并
  enabled: boolean
}

/** 对单个 server 执行一次检索调用。 */
export async function callMcpTool(
  server: McpServerConfig,
  query: string,
  timeoutMs?: number,          // 默认 30_000
): Promise<WebSearchResult[]>

/** 测试连接：initialize + tools/list，校验 toolName 存在。 */
export async function testMcpServer(
  server: McpServerConfig,
): Promise<{ ok: boolean; toolCount: number; hasTool: boolean; error?: string }>
```

**协议流程**（Streamable HTTP，JSON-RPC 2.0）：

1. `POST url`：`initialize`（protocolVersion `2025-03-26`，最小 client 能力），
   记录响应头 `Mcp-Session-Id`（若有，后续请求带上）。
2. `POST url`：`notifications/initialized`（无 id 通知）。
3. `POST url`：`tools/call`，参数 `{ name: toolName, arguments: { [queryParam]: query, ...extraArgs } }`。
4. 请求头 `Accept: application/json, text/event-stream`；响应两种形态都要解析：
   直接 JSON，或 SSE 流（取 `data:` 行中携带该请求 id 的 JSON-RPC response）。

**结果映射**：`tools/call` 结果的每个 `type: "text"` content block 映射为一条
`WebSearchResult`：

```ts
{
  title: `${server.name}/${server.toolName}`,
  url: "",                       // MCP 结果无 URL；去重键回退 source:title:snippet
  snippet: <block.text，超长截断至 2000 字符>,
  source: `MCP:${server.name}`,
}
```

`result.isError === true` 时抛错（文本进错误消息）；非 text block 忽略。

**纯函数拆分**（可脱离网络测试）：JSON-RPC 请求体构造、SSE 文本解析出
response、content blocks → WebSearchResult 映射，均为导出纯函数。

### 2. 配置（`src/stores/wiki-store.ts`）

`SearchApiConfig` 增加 `mcpServers?: McpServerConfig[]`（默认 undefined，
向后兼容旧持久化配置）。不改动 `DeepResearchSource` 联合类型——启用与否
由每个 server 的 `enabled` 决定，避免来源模式组合爆炸。

### 3. 接线（`src/lib/deep-research.ts` 的 `collectResearchSources`）

- `ResearchSourceDeps` 增加 `mcpCall: typeof callMcpTool`（依赖注入，便于 mock）。
- 对每个 `enabled` 的 server × 每个查询词，向现有 `calls` 数组追加
  `mcpCall(server, query)`，追加位置在 web 与 anytxt 调用之后。
- 失败进 `errors`（现有错误通道，`Promise.allSettled` 已保证单源失败不
  拖累整体）；结果进统一 `addResults`（去重 + 20 条封顶）。
- 与金融时间感知的关系：MCP 结果 `source` 非 `"AnyTXT"`，在金融模式的
  `buildFinanceSearchContext` 中自然落入 web 组（保持原序在后），无需改动。

### 4. 设置 UI（`src/components/settings/sections/web-search-section.tsx`）

「外部信息源」区新增「MCP 数据源」卡片，排在 AnyTXT 卡片之后，交互沿用
现有卡片样式（展开/收起、已配置徽章）：

- server 列表：每项显示 name/url/enabled 开关；增删按钮。
- 编辑字段：name、url、authHeader（密码型输入）、toolName、queryParam
  （默认占位 "query"）、extraArgs（JSON 文本域，保存前 `JSON.parse` 校验）。
- 「测试连接」按钮：调 `testMcpServer`，成功显示工具数量与 toolName 是否
  存在；失败显示错误消息。复用现有测试按钮的状态样式。
- i18n：`settings.sections.webSearch.mcpTitle/mcpDescription/mcpAddServer/
  mcpToolName/mcpQueryParam/mcpExtraArgs/mcpTestConnection/...`，
  zh/en/ja/de 四语同步。

## 硬性约束

- 零新 npm 依赖；HTTP 一律走 `@/lib/tauri-fetch`。
- 未配置或全部禁用 MCP 时，`collectResearchSources` 行为与现状完全一致。
- `authHeader` 仅发送到该 server 配置的 URL，存储方式与现有搜索 API key
  一致（本地设置持久化）。
- 单次 `tools/call` 超时默认 30 秒；超时/失败计入 `errors`，不中断其他源。
- 所有源皆空且有错误时沿用 `noResearchSourcesTaskPatch` 现有语义。

## 数据流

```
查询词 → collectResearchSources
  ├─ webSearch（现状）
  ├─ anyTxtSearch（现状）
  └─ callMcpTool × 启用的 server × 查询词
       initialize → notifications/initialized → tools/call
       → text blocks → WebSearchResult[]（source: "MCP:<name>"）
  → addResults 去重封顶 → 综合管线（金融模式时间排序对 MCP 结果不特殊处理）
```

## 错误处理

- initialize/tools/call 网络错误、非 2xx、JSON-RPC error、`isError` 结果、
  SSE 中找不到对应 response、extraArgs 非法 JSON（UI 保存前拦截）→ 均转为
  带 server 名前缀的 Error 消息进 `errors`。
- 测试连接失败不写配置状态，仅展示错误。

## 测试

- `src/lib/mcp-search.test.ts`：mock fetch——JSON-RPC 请求体构造（含
  session 头透传、extraArgs 合并、authHeader）；JSON 与 SSE 两种响应解析；
  text block 映射与截断；isError/JSON-RPC error/超时路径；`testMcpServer`
  的 hasTool 判定。
- `src/lib/deep-research.test.ts`：`collectResearchSources` 注入 mock
  `mcpCall`——启用 server 参战且结果归并去重；禁用/未配置时不调用；单
  server 失败进 errors 且不影响其他源。

## 文档

`docs/` 新增使用指南（中文）：如何把 stdio 型 MCP server（以 tushare 类
金融数据服务为例）用 `fastmcp run --transport streamable-http` 或
`mcp-proxy` 以 HTTP 模式暴露，并在「外部信息源」中配置。
