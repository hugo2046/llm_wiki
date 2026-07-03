# deep-research 接入 MCP 数据源 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** deep-research 可从用户配置的 MCP server（Streamable HTTP）获取数据，作为与网页搜索/AnyTXT 并列的第三类检索源。

**Architecture:** 极简 MCP 客户端（`initialize → notifications/initialized → tools/call` 三个 JSON-RPC POST）放在新模块 `src/lib/mcp-search.ts`，纯逻辑（参数构造/SSE 解析/结果映射）与 IO 分离；`collectResearchSources` 对启用的 server × 查询词并发调用并归并进现有 `WebSearchResult[]` 管线；配置存 `SearchApiConfig.mcpServers`，UI 在「外部信息源」区新增卡片。

**Tech Stack:** TypeScript、tauri-fetch（`getHttpFetch`）、Vitest（`vi.stubGlobal("fetch", ...)` mock 模式）、react-i18next（zh/en 两语，`i18n-parity.test.ts` 强制键对齐）。

**Spec:** `docs/superpowers/specs/2026-07-03-deep-research-mcp-source-design.md`

## Global Constraints

- 零新 npm 依赖；HTTP 一律走 `@/lib/tauri-fetch` 的 `getHttpFetch()`。
- 未配置或全部禁用 MCP 时，`collectResearchSources` 行为与现状完全一致（现有测试零改动）。
- `tools/call` 超时默认 30_000 ms；任何失败转为带 `MCP <server.name>: ` 前缀的 Error 进现有 `errors` 通道，不中断其他源。
- 结果映射：仅 `type: "text"` 的 content block，每块一条 `WebSearchResult`：`title: "<name>/<toolName>"`、`url: ""`、`snippet` 截断至 2000 字符、`source: "MCP:<name>"`。
- MCP 协议版本常量 `2025-03-26`；响应需同时支持 `application/json` 与 `text/event-stream` 两种形态。
- 启用的 server 不受 `DeepResearchSource` 模式影响，始终参战；调用追加在 web 与 anytxt 之后（受全局 20 条封顶）。
- i18n：zh/en 两语同步（spec 中「四语」为笔误，实际项目仅 zh.json/en.json）。
- 注释中文、公共函数 Sphinx docstring；提交信息 Conventional Commits + `Co-Authored-By: Hugo <shen.lan123@gmail.com>`。

---

### Task 1: `src/lib/mcp-search.ts`（MCP 客户端与纯函数）

**Files:**
- Create: `src/lib/mcp-search.ts`
- Create: `src/lib/mcp-search.test.ts`

**Interfaces:**
- Consumes: `getHttpFetch` from `@/lib/tauri-fetch`；`WebSearchResult` type from `./web-search`。
- Produces（Task 2、3 依赖）:
  ```ts
  export interface McpServerConfig {
    id: string
    name: string
    url: string
    authHeader?: string
    toolName: string
    queryParam: string
    extraArgs?: string
    enabled: boolean
  }
  export function buildToolArguments(server: McpServerConfig, query: string): Record<string, unknown>
  export function parseSseJsonRpcResponse(body: string, id: number): JsonRpcResponse | null
  export function mapMcpContent(server: McpServerConfig, blocks: McpContentBlock[]): WebSearchResult[]
  export async function callMcpTool(server: McpServerConfig, query: string, timeoutMs?: number): Promise<WebSearchResult[]>
  export async function testMcpServer(server: McpServerConfig): Promise<{ ok: boolean; toolCount: number; hasTool: boolean; error?: string }>
  ```

- [ ] **Step 1: 写失败测试**

创建 `src/lib/mcp-search.test.ts`：

```ts
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  buildToolArguments,
  callMcpTool,
  mapMcpContent,
  parseSseJsonRpcResponse,
  testMcpServer,
  type McpServerConfig,
} from "./mcp-search"

const fetchMock = vi.fn<typeof fetch>()

const server: McpServerConfig = {
  id: "s1",
  name: "tushare",
  url: "http://127.0.0.1:8000/mcp",
  authHeader: "Bearer token-1",
  toolName: "stock_news",
  queryParam: "query",
  extraArgs: "",
  enabled: true,
}

function jsonResponse(payload: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  })
}

/** 依次入队 initialize / notifications/initialized / 第三请求 的响应。 */
function queueSession(thirdResponse: Response) {
  fetchMock
    .mockResolvedValueOnce(jsonResponse(
      { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26" } },
      { "mcp-session-id": "sess-9" },
    ))
    .mockResolvedValueOnce(new Response(null, { status: 202 }))
    .mockResolvedValueOnce(thirdResponse)
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal("fetch", fetchMock)
})

describe("buildToolArguments", () => {
  it("查询词写入 queryParam 并合并 extraArgs", () => {
    expect(buildToolArguments({ ...server, extraArgs: '{"limit": 5}' }, "贵州茅台"))
      .toEqual({ limit: 5, query: "贵州茅台" })
  })

  it("queryParam 为空时回退 query", () => {
    expect(buildToolArguments({ ...server, queryParam: "" }, "x")).toEqual({ query: "x" })
  })

  it("extraArgs 非 JSON 对象时抛错", () => {
    expect(() => buildToolArguments({ ...server, extraArgs: "[1,2]" }, "x")).toThrow()
    expect(() => buildToolArguments({ ...server, extraArgs: "{bad" }, "x")).toThrow()
  })
})

describe("parseSseJsonRpcResponse", () => {
  it("从 SSE 文本中取出匹配 id 的 response", () => {
    const body = [
      "event: message",
      'data: {"jsonrpc":"2.0","id":9,"result":{}}',
      "",
      'data: {"jsonrpc":"2.0","id":2,"result":{"content":[]}}',
      "",
    ].join("\n")
    expect(parseSseJsonRpcResponse(body, 2)).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: { content: [] },
    })
  })

  it("找不到匹配 id 时返回 null", () => {
    expect(parseSseJsonRpcResponse("data: {\"jsonrpc\":\"2.0\",\"id\":1}\n", 2)).toBeNull()
  })
})

describe("mapMcpContent", () => {
  it("text block 映射为 WebSearchResult 并截断超长文本", () => {
    const long = "甲".repeat(2500)
    const out = mapMcpContent(server, [
      { type: "text", text: "第一段" },
      { type: "image", text: "忽略" },
      { type: "text", text: long },
    ])
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({
      title: "tushare/stock_news",
      url: "",
      snippet: "第一段",
      source: "MCP:tushare",
    })
    expect(out[1].snippet.length).toBe(2001) // 2000 字符 + 省略号
    expect(out[1].snippet.endsWith("…")).toBe(true)
  })
})

describe("callMcpTool", () => {
  it("完整会话流程：initialize 带协议版本，后续请求透传 session 与 auth 头", async () => {
    queueSession(jsonResponse({
      jsonrpc: "2.0",
      id: 2,
      result: { content: [{ type: "text", text: "净利润同比 +12%" }] },
    }))

    const results = await callMcpTool(server, "贵州茅台 财报")

    expect(results).toEqual([{
      title: "tushare/stock_news",
      url: "",
      snippet: "净利润同比 +12%",
      source: "MCP:tushare",
    }])
    // initialize 请求体
    const initBody = JSON.parse(fetchMock.mock.calls[0][1]?.body as string)
    expect(initBody.method).toBe("initialize")
    expect(initBody.params.protocolVersion).toBe("2025-03-26")
    // 三个请求都带 Authorization；第 2、3 个带 session 头
    for (const call of fetchMock.mock.calls) {
      expect((call[1]?.headers as Record<string, string>).Authorization).toBe("Bearer token-1")
    }
    expect((fetchMock.mock.calls[1][1]?.headers as Record<string, string>)["Mcp-Session-Id"]).toBe("sess-9")
    expect((fetchMock.mock.calls[2][1]?.headers as Record<string, string>)["Mcp-Session-Id"]).toBe("sess-9")
    // tools/call 请求体
    const callBody = JSON.parse(fetchMock.mock.calls[2][1]?.body as string)
    expect(callBody.method).toBe("tools/call")
    expect(callBody.params).toEqual({ name: "stock_news", arguments: { query: "贵州茅台 财报" } })
  })

  it("解析 SSE 形态的 tools/call 响应", async () => {
    queueSession(new Response(
      'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"ok"}]}}\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ))
    const results = await callMcpTool(server, "q")
    expect(results).toHaveLength(1)
    expect(results[0].snippet).toBe("ok")
  })

  it("isError 结果抛出带 server 名前缀的错误", async () => {
    queueSession(jsonResponse({
      jsonrpc: "2.0",
      id: 2,
      result: { isError: true, content: [{ type: "text", text: "invalid token" }] },
    }))
    await expect(callMcpTool(server, "q")).rejects.toThrow(/^MCP tushare: .*invalid token/)
  })

  it("JSON-RPC error 与非 2xx 都抛错", async () => {
    queueSession(jsonResponse({
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32602, message: "unknown tool" },
    }))
    await expect(callMcpTool(server, "q")).rejects.toThrow(/unknown tool/)

    fetchMock.mockReset()
    fetchMock.mockResolvedValueOnce(new Response("boom", { status: 500 }))
    await expect(callMcpTool(server, "q")).rejects.toThrow(/MCP tushare: .*500/)
  })
})

describe("testMcpServer", () => {
  it("返回工具数量与 toolName 是否存在", async () => {
    queueSession(jsonResponse({
      jsonrpc: "2.0",
      id: 2,
      result: { tools: [{ name: "stock_news" }, { name: "other" }] },
    }))
    expect(await testMcpServer(server)).toEqual({ ok: true, toolCount: 2, hasTool: true })
  })

  it("连接失败时返回 ok:false 与错误消息", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"))
    const out = await testMcpServer(server)
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/ECONNREFUSED/)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/lib/mcp-search.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/lib/mcp-search.ts`**

```ts
/**
 * 极简 MCP Streamable HTTP 客户端——deep-research 的第三类检索源。
 *
 * 只实现协议子集：initialize → notifications/initialized → tools/call
 * （检索）或 tools/list（测试连接），全部为 JSON-RPC 2.0 POST。
 * 纯逻辑（参数构造/SSE 解析/结果映射）与 IO（callMcpTool/testMcpServer）
 * 分离，前者可脱离网络单测。
 */
import { getHttpFetch } from "@/lib/tauri-fetch"
import type { WebSearchResult } from "./web-search"

export interface McpServerConfig {
  id: string
  name: string
  url: string
  /** 完整 Authorization 头值，如 "Bearer xxx"；仅发送到本 server 的 url */
  authHeader?: string
  toolName: string
  /** 查询词写入的参数名；空串回退 "query" */
  queryParam: string
  /** 固定参数（JSON 对象字符串），与查询词合并 */
  extraArgs?: string
  enabled: boolean
}

export interface JsonRpcResponse {
  jsonrpc: "2.0"
  id?: number | string | null
  result?: unknown
  error?: { code: number; message: string }
}

export interface McpContentBlock {
  type: string
  text?: string
}

export const MCP_PROTOCOL_VERSION = "2025-03-26"
const DEFAULT_TIMEOUT_MS = 30_000
const SNIPPET_MAX_CHARS = 2000

/**
 * 构造 tools/call 的 arguments：extraArgs（JSON 对象）与查询词合并，
 * 查询词写入 queryParam（空串回退 "query"）。
 *
 * :param server: server 配置
 * :param query: 查询词
 * :returns: arguments 对象
 * :raises Error: extraArgs 非合法 JSON 对象
 */
export function buildToolArguments(
  server: McpServerConfig,
  query: string,
): Record<string, unknown> {
  let extra: Record<string, unknown> = {}
  const raw = server.extraArgs?.trim()
  if (raw) {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("extraArgs 必须是 JSON 对象")
    }
    extra = parsed as Record<string, unknown>
  }
  return { ...extra, [server.queryParam.trim() || "query"]: query }
}

/**
 * 从 SSE 响应文本中取出匹配 id 的 JSON-RPC response。
 *
 * 简化假设：MCP server 的每条 data 载荷单行完整（主流实现如此）；
 * 非 JSON 的 data 行忽略。
 *
 * :param body: SSE 全文
 * :param id: 目标请求 id
 * :returns: 匹配的 response；找不到为 null
 */
export function parseSseJsonRpcResponse(body: string, id: number): JsonRpcResponse | null {
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue
    const payload = line.slice(5).trim()
    if (!payload) continue
    try {
      const msg = JSON.parse(payload) as JsonRpcResponse
      if (msg && typeof msg === "object" && msg.id === id) return msg
    } catch {
      // 非 JSON 的 data 行（心跳等）忽略
    }
  }
  return null
}

/**
 * tools/call 结果的 text block 映射为检索结果。
 *
 * :param server: server 配置（供 title/source 命名）
 * :param blocks: content blocks
 * :returns: 每个非空 text block 一条结果，snippet 截断至 2000 字符
 */
export function mapMcpContent(
  server: McpServerConfig,
  blocks: McpContentBlock[],
): WebSearchResult[] {
  const out: WebSearchResult[] = []
  for (const block of blocks) {
    const text = block.type === "text" ? block.text?.trim() : ""
    if (!text) continue
    out.push({
      title: `${server.name}/${server.toolName}`,
      url: "",
      snippet: text.length > SNIPPET_MAX_CHARS ? `${text.slice(0, SNIPPET_MAX_CHARS)}…` : text,
      source: `MCP:${server.name}`,
    })
  }
  return out
}

function baseHeaders(server: McpServerConfig, sessionId: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  }
  const auth = server.authHeader?.trim()
  if (auth) headers.Authorization = auth
  if (sessionId) headers["Mcp-Session-Id"] = sessionId
  return headers
}

/** 解析 JSON 或 SSE 形态的响应体，取出匹配 id 的 JSON-RPC response。 */
async function readJsonRpc(res: Response, id: number): Promise<JsonRpcResponse | null> {
  const contentType = res.headers.get("content-type") ?? ""
  const bodyText = await res.text()
  if (contentType.includes("text/event-stream")) {
    return parseSseJsonRpcResponse(bodyText, id)
  }
  if (!bodyText.trim()) return null
  const msg = JSON.parse(bodyText) as JsonRpcResponse
  return msg.id === id ? msg : null
}

interface McpSession {
  post: (id: number, method: string, params?: unknown) => Promise<JsonRpcResponse | null>
}

/** 建立会话：initialize + notifications/initialized，返回带 session 头的 post。 */
async function openMcpSession(server: McpServerConfig, signal: AbortSignal): Promise<McpSession> {
  const httpFetch = await getHttpFetch()

  async function rawPost(payload: object, sessionId: string | null): Promise<Response> {
    return httpFetch(server.url, {
      method: "POST",
      headers: baseHeaders(server, sessionId),
      body: JSON.stringify(payload),
      signal,
    })
  }

  const initRes = await rawPost({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "llm-wiki", version: "0" },
    },
  }, null)
  if (!initRes.ok) throw new Error(`initialize HTTP ${initRes.status}`)
  const sessionId = initRes.headers.get("mcp-session-id")
  const initMsg = await readJsonRpc(initRes, 1)
  if (initMsg?.error) throw new Error(`initialize: ${initMsg.error.message}`)

  await rawPost({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionId)

  return {
    post: async (id, method, params) => {
      const res = await rawPost(
        params === undefined
          ? { jsonrpc: "2.0", id, method }
          : { jsonrpc: "2.0", id, method, params },
        sessionId,
      )
      if (!res.ok) throw new Error(`${method} HTTP ${res.status}`)
      return readJsonRpc(res, id)
    },
  }
}

/**
 * 对单个 MCP server 执行一次检索调用。
 *
 * :param server: server 配置
 * :param query: 查询词
 * :param timeoutMs: 整个会话的超时（默认 30 秒）
 * :returns: 映射后的检索结果
 * :raises Error: 任何失败均带 `MCP <name>: ` 前缀
 */
export async function callMcpTool(
  server: McpServerConfig,
  query: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<WebSearchResult[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const args = buildToolArguments(server, query)
    const session = await openMcpSession(server, controller.signal)
    const msg = await session.post(2, "tools/call", { name: server.toolName, arguments: args })
    if (!msg) throw new Error("响应中未找到 tools/call 结果")
    if (msg.error) throw new Error(`tools/call: ${msg.error.message}`)
    const result = (msg.result ?? {}) as { content?: McpContentBlock[]; isError?: boolean }
    if (result.isError) {
      const detail = (result.content ?? [])
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text)
        .join(" ")
      throw new Error(detail || "工具返回 isError")
    }
    return mapMcpContent(server, result.content ?? [])
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`MCP ${server.name}: ${message}`)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 测试连接：initialize + tools/list，校验配置的 toolName 是否存在。
 *
 * :param server: server 配置
 * :returns: ok/toolCount/hasTool；失败时 ok:false 且带 error 消息
 */
export async function testMcpServer(
  server: McpServerConfig,
): Promise<{ ok: boolean; toolCount: number; hasTool: boolean; error?: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
  try {
    const session = await openMcpSession(server, controller.signal)
    const msg = await session.post(2, "tools/list")
    if (!msg) throw new Error("响应中未找到 tools/list 结果")
    if (msg.error) throw new Error(`tools/list: ${msg.error.message}`)
    const tools = ((msg.result ?? {}) as { tools?: Array<{ name: string }> }).tools ?? []
    return {
      ok: true,
      toolCount: tools.length,
      hasTool: tools.some((tool) => tool.name === server.toolName),
    }
  } catch (err) {
    return {
      ok: false,
      toolCount: 0,
      hasTool: false,
      error: err instanceof Error ? err.message : String(err),
    }
  } finally {
    clearTimeout(timer)
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/lib/mcp-search.test.ts && npm run typecheck`
Expected: 全部 PASS，typecheck 干净

- [ ] **Step 5: 提交**

```bash
git add src/lib/mcp-search.ts src/lib/mcp-search.test.ts
git commit -m "feat: 新增极简 MCP Streamable HTTP 客户端 mcp-search

Co-Authored-By: Hugo <shen.lan123@gmail.com>"
```

---

### Task 2: 配置类型 + `collectResearchSources` 接线

**Files:**
- Modify: `src/stores/wiki-store.ts`（`SearchApiConfig` 接口，约 98-108 行）
- Modify: `src/lib/deep-research.ts`（imports、`ResearchSourceDeps`、`collectResearchSources`）
- Test: `src/lib/deep-research.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `callMcpTool` / `McpServerConfig`。
- Produces（Task 3 依赖）: `SearchApiConfig.mcpServers?: McpServerConfig[]`；`ResearchSourceDeps.mcpCall?: typeof callMcpTool`（可选，缺省回退真实实现——现有测试零改动）。

- [ ] **Step 1: 写失败测试**

在 `src/lib/deep-research.test.ts` 文件末尾追加（`collectResearchSources` 的既有 describe 之外新建）：

```ts
describe("collectResearchSources with MCP", () => {
  const mcpServer = {
    id: "s1",
    name: "tushare",
    url: "http://127.0.0.1:8000/mcp",
    toolName: "stock_news",
    queryParam: "query",
    enabled: true,
  }
  const mcpResult: WebSearchResult = {
    title: "tushare/stock_news",
    url: "",
    snippet: "mcp snippet",
    source: "MCP:tushare",
  }

  it("启用的 server 对每个查询词调用并归并结果", async () => {
    const mcpCall = vi.fn().mockResolvedValue([mcpResult])
    const { results, errors } = await collectResearchSources(
      ["q1", "q2"],
      config({ deepResearchSource: "web", mcpServers: [mcpServer] }),
      "C:/proj",
      { webSearch: vi.fn().mockResolvedValue([]), anyTxtSearch: vi.fn().mockResolvedValue([]), mcpCall },
    )
    expect(mcpCall).toHaveBeenCalledTimes(2)
    expect(mcpCall).toHaveBeenCalledWith(mcpServer, "q1")
    expect(mcpCall).toHaveBeenCalledWith(mcpServer, "q2")
    expect(results).toEqual([mcpResult]) // 两次相同结果被去重为一条
    expect(errors).toEqual([])
  })

  it("禁用与配置不全的 server 不调用", async () => {
    const mcpCall = vi.fn()
    await collectResearchSources(
      ["q"],
      config({
        mcpServers: [
          { ...mcpServer, enabled: false },
          { ...mcpServer, id: "s2", url: "  " },
          { ...mcpServer, id: "s3", toolName: "" },
        ],
      }),
      "C:/proj",
      { webSearch: vi.fn().mockResolvedValue([]), anyTxtSearch: vi.fn().mockResolvedValue([]), mcpCall },
    )
    expect(mcpCall).not.toHaveBeenCalled()
  })

  it("单 server 失败进 errors 且不影响其他源", async () => {
    const { results, errors } = await collectResearchSources(
      ["q"],
      config({ provider: "tavily", apiKey: "k", deepResearchSource: "web", mcpServers: [mcpServer] }),
      "C:/proj",
      {
        webSearch: vi.fn().mockResolvedValue([webResult]),
        anyTxtSearch: vi.fn().mockResolvedValue([]),
        mcpCall: vi.fn().mockRejectedValue(new Error("MCP tushare: ECONNREFUSED")),
      },
    )
    expect(results).toEqual([webResult])
    expect(errors).toEqual(["MCP tushare: ECONNREFUSED"])
  })
})
```

说明：`config()`、`webResult` 为该测试文件既有的 helper 与常量；`WebSearchResult` 已在文件顶部 import。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/lib/deep-research.test.ts -t "with MCP"`
Expected: FAIL（`mcpServers` 不在 `SearchApiConfig`、`mcpCall` 不在 deps 类型上，类型错误或行为不匹配）

- [ ] **Step 3: 实现**

`src/stores/wiki-store.ts`——`SearchApiConfig` 接口末尾加一个字段（`anyTxt?: AnyTxtConfig` 之后）：

```ts
  /** MCP 数据源列表（Streamable HTTP）；enabled 的 server 参与 deep-research */
  mcpServers?: import("@/lib/mcp-search").McpServerConfig[]
```

（用内联 `import()` 类型引用避免顶部 import 循环；该引用类型擦除后无运行时依赖。）

`src/lib/deep-research.ts`：

imports 区追加：

```ts
import { callMcpTool } from "./mcp-search"
```

`ResearchSourceDeps` 增加可选字段：

```ts
interface ResearchSourceDeps {
  webSearch: typeof webSearch
  anyTxtSearch: typeof anyTxtSearchSmart
  /** MCP 检索调用；缺省回退真实实现（便于测试注入） */
  mcpCall?: typeof callMcpTool
}
```

`collectResearchSources` 中，在 `if (useAnyTxt) { calls.push(...) }` 块之后、`const settled = await Promise.allSettled(calls)` 之前插入：

```ts
  // MCP 数据源：启用且配置完整的 server × 每个查询词，追加在 web/anytxt 之后
  const mcpCall = deps.mcpCall ?? callMcpTool
  const mcpServers = (resolvedSearchConfig.mcpServers ?? []).filter(
    (s) => s.enabled && s.url.trim() && s.toolName.trim(),
  )
  for (const server of mcpServers) {
    for (const mcpQuery of webQueries) {
      calls.push(mcpCall(server, mcpQuery).then((results) => ({ results })))
    }
  }
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/lib/deep-research.test.ts && npm run typecheck`
Expected: 全部 PASS（含既有用例——未配置 MCP 时行为不变），typecheck 干净

- [ ] **Step 5: 提交**

```bash
git add src/stores/wiki-store.ts src/lib/deep-research.ts src/lib/deep-research.test.ts
git commit -m "feat: collectResearchSources 接入 MCP 数据源（启用 server 并行参战）

Co-Authored-By: Hugo <shen.lan123@gmail.com>"
```

---

### Task 3: 「外部信息源」设置 UI + i18n

**Files:**
- Modify: `src/components/settings/sections/web-search-section.tsx`
- Modify: `src/i18n/zh.json`（`settings.sections.webSearch` 命名空间）
- Modify: `src/i18n/en.json`（同名键）

**Interfaces:**
- Consumes: Task 1 的 `testMcpServer` / `McpServerConfig`；Task 2 的 `SearchApiConfig.mcpServers`。组件既有基础设施：`persist`、`expanded`/`setExpanded`、`savedId`/`setSavedId`、`testStatus`/`setTestStatus`、`testRunRef`（key 用 `mcp-${server.id}`）。
- Produces: 无新导出。

- [ ] **Step 1: i18n 文案**

`src/i18n/zh.json` 的 `settings.sections.webSearch` 对象内追加（`anyTxtBroadDirWarning` 键之后）：

```json
"mcpTitle": "MCP 数据源",
"mcpDescription": "把 MCP server（Streamable HTTP）的工具调用结果作为 Deep Research 的信息来源。启用的 server 会与网页搜索 / AnyTXT 并行使用。",
"mcpAddServer": "添加 MCP server",
"mcpEmpty": "尚未配置 MCP server。",
"mcpName": "名称",
"mcpUrl": "端点 URL",
"mcpAuthHeader": "Authorization 头（可选）",
"mcpToolName": "工具名",
"mcpQueryParam": "查询参数名",
"mcpExtraArgs": "固定参数（JSON 对象，可选）",
"mcpExtraArgsInvalid": "不是合法的 JSON 对象，research 时该 server 会报错。",
"mcpTestConnection": "测试连接",
"mcpTestOk": "连接成功：{{count}} 个工具，包含 {{tool}}。",
"mcpTestNoTool": "连接成功（{{count}} 个工具），但未找到工具 {{tool}}。",
"mcpRemove": "删除",
"mcpHint": "stdio 型 server 可用 fastmcp 的 streamable-http 模式或 mcp-proxy 以 HTTP 暴露后接入，详见 docs/mcp-research-source-guide.md。查询词会发送给启用的 MCP server，请只配置可信服务。"
```

`src/i18n/en.json` 同位置追加：

```json
"mcpTitle": "MCP data sources",
"mcpDescription": "Use MCP server (Streamable HTTP) tool calls as Deep Research sources. Enabled servers run alongside web search / AnyTXT.",
"mcpAddServer": "Add MCP server",
"mcpEmpty": "No MCP servers configured yet.",
"mcpName": "Name",
"mcpUrl": "Endpoint URL",
"mcpAuthHeader": "Authorization header (optional)",
"mcpToolName": "Tool name",
"mcpQueryParam": "Query parameter",
"mcpExtraArgs": "Fixed arguments (JSON object, optional)",
"mcpExtraArgsInvalid": "Not a valid JSON object; this server will fail during research.",
"mcpTestConnection": "Test connection",
"mcpTestOk": "Connected: {{count}} tools, including {{tool}}.",
"mcpTestNoTool": "Connected ({{count}} tools), but tool {{tool}} was not found.",
"mcpRemove": "Remove",
"mcpHint": "Expose stdio servers over HTTP via fastmcp streamable-http mode or mcp-proxy; see docs/mcp-research-source-guide.md. Search queries are sent to enabled MCP servers — only configure services you trust."
```

- [ ] **Step 2: 组件实现**

`web-search-section.tsx` 顶部 imports 追加：

```ts
import { testMcpServer, type McpServerConfig } from "@/lib/mcp-search"
```

组件内（`updateAnyTxt` 函数之后）追加状态派生与处理函数：

```ts
  const mcpServers = resolvedConfig.mcpServers ?? []

  function updateMcpServers(next: McpServerConfig[]) {
    persist(resolveSearchConfig({ ...resolvedConfig, mcpServers: next })).catch(() => {})
    setSavedId("mcp")
    setTimeout(() => setSavedId((cur) => (cur === "mcp" ? null : cur)), 1500)
  }

  function addMcpServer() {
    const id = crypto.randomUUID()
    updateMcpServers([
      ...mcpServers,
      { id, name: "", url: "", toolName: "", queryParam: "query", extraArgs: "", enabled: false },
    ])
    setExpanded((prev) => ({ ...prev, [`mcp-${id}`]: true }))
  }

  function patchMcpServer(id: string, patch: Partial<McpServerConfig>) {
    updateMcpServers(mcpServers.map((s) => (s.id === id ? { ...s, ...patch } : s)))
  }

  function removeMcpServer(id: string) {
    updateMcpServers(mcpServers.filter((s) => s.id !== id))
  }

  /** extraArgs 是否为合法 JSON 对象（空串视为合法）。 */
  function isValidExtraArgs(raw: string | undefined): boolean {
    const trimmed = raw?.trim()
    if (!trimmed) return true
    try {
      const parsed = JSON.parse(trimmed) as unknown
      return !!parsed && typeof parsed === "object" && !Array.isArray(parsed)
    } catch {
      return false
    }
  }

  async function testMcp(server: McpServerConfig) {
    const key = `mcp-${server.id}`
    const runId = (testRunRef.current[key] ?? 0) + 1
    testRunRef.current[key] = runId
    setTestStatus((prev) => ({
      ...prev,
      [key]: { state: "testing", message: t("settings.sections.webSearch.testRunning") },
    }))
    const result = await testMcpServer(server)
    if (testRunRef.current[key] !== runId) return
    setTestStatus((prev) => ({
      ...prev,
      [key]: result.ok
        ? {
            state: result.hasTool ? "ok" : "warning",
            message: result.hasTool
              ? t("settings.sections.webSearch.mcpTestOk", { count: result.toolCount, tool: server.toolName })
              : t("settings.sections.webSearch.mcpTestNoTool", { count: result.toolCount, tool: server.toolName }),
          }
        : { state: "error", message: result.error ?? "error" },
    }))
  }
```

JSX：在 AnyTXT 卡片的收尾 `</div>`（`anyTxtHint` 段落所在卡片之后）与 `webProviders` 区块之间插入：

```tsx
      <div className="space-y-3 rounded-lg border p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <Label>{t("settings.sections.webSearch.mcpTitle")}</Label>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("settings.sections.webSearch.mcpDescription")}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {savedId === "mcp" && (
              <span className="text-[10px] text-emerald-600">
                {t("settings.sections.webSearch.savedBadge")}
              </span>
            )}
            <button
              type="button"
              onClick={addMcpServer}
              className="rounded-md border px-2 py-1 text-xs hover:bg-accent"
            >
              {t("settings.sections.webSearch.mcpAddServer")}
            </button>
          </div>
        </div>
        {mcpServers.length === 0 && (
          <p className="text-xs text-muted-foreground">
            {t("settings.sections.webSearch.mcpEmpty")}
          </p>
        )}
        {mcpServers.map((server) => {
          const key = `mcp-${server.id}`
          const isExpanded = !!expanded[key]
          const status = testStatus[key]
          return (
            <div key={server.id} className={`rounded-lg border ${server.enabled ? "border-primary/60 bg-primary/5" : "border-border"}`}>
              <div className="flex items-center justify-between gap-2 px-3 py-2">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  onClick={() => setExpanded((prev) => ({ ...prev, [key]: !isExpanded }))}
                >
                  {isExpanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
                  <span className="truncate text-sm">
                    {server.name || server.url || t("settings.sections.webSearch.mcpName")}
                  </span>
                </button>
                <div className="flex shrink-0 items-center gap-2">
                  {server.enabled && (
                    <span className="rounded-full bg-primary/20 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                      {t("settings.sections.webSearch.activeBadge")}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => patchMcpServer(server.id, { enabled: !server.enabled })}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full border transition-colors ${
                      server.enabled
                        ? "border-primary bg-primary"
                        : "border-muted-foreground/30 bg-muted-foreground/20 hover:bg-muted-foreground/30"
                    }`}
                    aria-label={server.enabled ? t("settings.sections.webSearch.deactivate") : t("settings.sections.webSearch.activate")}
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm ring-1 ring-black/10 transition-transform ${
                        server.enabled ? "translate-x-4" : "translate-x-0.5"
                      }`}
                    />
                  </button>
                </div>
              </div>
              {isExpanded && (
                <div className="space-y-3 border-t px-3 py-3">
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label>{t("settings.sections.webSearch.mcpName")}</Label>
                      <Input
                        value={server.name}
                        onChange={(e) => patchMcpServer(server.id, { name: e.target.value })}
                        placeholder="tushare"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>{t("settings.sections.webSearch.mcpUrl")}</Label>
                      <Input
                        value={server.url}
                        onChange={(e) => patchMcpServer(server.id, { url: e.target.value })}
                        placeholder="http://127.0.0.1:8000/mcp"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>{t("settings.sections.webSearch.mcpToolName")}</Label>
                      <Input
                        value={server.toolName}
                        onChange={(e) => patchMcpServer(server.id, { toolName: e.target.value })}
                        placeholder="stock_news"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>{t("settings.sections.webSearch.mcpQueryParam")}</Label>
                      <Input
                        value={server.queryParam}
                        onChange={(e) => patchMcpServer(server.id, { queryParam: e.target.value })}
                        placeholder="query"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>{t("settings.sections.webSearch.mcpAuthHeader")}</Label>
                      <Input
                        type="password"
                        value={server.authHeader ?? ""}
                        onChange={(e) => patchMcpServer(server.id, { authHeader: e.target.value })}
                        placeholder="Bearer …"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>{t("settings.sections.webSearch.mcpExtraArgs")}</Label>
                      <Input
                        value={server.extraArgs ?? ""}
                        onChange={(e) => patchMcpServer(server.id, { extraArgs: e.target.value })}
                        placeholder='{"limit": 10}'
                      />
                      {!isValidExtraArgs(server.extraArgs) && (
                        <p className="text-xs text-destructive">
                          {t("settings.sections.webSearch.mcpExtraArgsInvalid")}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => testMcp(server)}
                      className="rounded-md border px-2 py-1 text-xs hover:bg-accent"
                    >
                      {t("settings.sections.webSearch.mcpTestConnection")}
                    </button>
                    <button
                      type="button"
                      onClick={() => removeMcpServer(server.id)}
                      className="rounded-md border border-destructive/40 px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
                    >
                      {t("settings.sections.webSearch.mcpRemove")}
                    </button>
                    {status && (
                      <span
                        className={`text-xs ${
                          status.state === "ok"
                            ? "text-emerald-600"
                            : status.state === "warning"
                              ? "text-amber-600"
                              : status.state === "error"
                                ? "text-destructive"
                                : "text-muted-foreground"
                        }`}
                      >
                        {status.message}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          )
        })}
        <p className="text-xs text-muted-foreground">
          {t("settings.sections.webSearch.mcpHint")}
        </p>
      </div>
```

设计取舍说明（相对 spec 的微调）：extraArgs 非法 JSON 时**不阻断保存**（避免用户输入途中丢内容），改为字段下方红字提示 + research 时该 server 报错进 errors——错误面是可见且可恢复的。

- [ ] **Step 3: 验证**

Run: `npm run typecheck && npx vitest run src/i18n/i18n-parity.test.ts`
Expected: typecheck 干净；i18n 键对齐测试 PASS

- [ ] **Step 4: 提交**

```bash
git add src/components/settings/sections/web-search-section.tsx src/i18n/zh.json src/i18n/en.json
git commit -m "feat: 外部信息源新增 MCP 数据源配置卡片（增删改/启用/测试连接）

Co-Authored-By: Hugo <shen.lan123@gmail.com>"
```

---

### Task 4: 使用指南文档

**Files:**
- Create: `docs/mcp-research-source-guide.md`

**Interfaces:**
- Consumes: Task 3 的 UI 字段命名（保持文档与界面一致）。
- Produces: 无代码接口。

- [ ] **Step 1: 写文档**

创建 `docs/mcp-research-source-guide.md`：

```markdown
# MCP 数据源使用指南

Deep Research 支持把 MCP server（Model Context Protocol，Streamable HTTP
传输）的工具调用结果作为信息来源，与网页搜索 / AnyTXT 并行使用。
典型场景：接入金融数据服务（如 tushare 的 MCP 封装），让研究报告直接
引用结构化行情/财报数据，而非只依赖网上搜索。

## 工作方式

- 在「设置 → 外部信息源 → MCP 数据源」中配置 server；**启用**的 server
  在每次 Deep Research 时自动参战（不受"深度研究来源模式"三选一影响）。
- 每个查询词对每个启用 server 调用一次配置的工具（`tools/call`），查询词
  写入「查询参数名」指定的参数（默认 `query`），「固定参数」中的 JSON
  对象会一并合并进调用参数。
- 工具返回的每个文本块成为一条研究来源（来源标注 `MCP:<名称>`），与
  其他来源统一去重，总量封顶 20 条。
- 单个 server 失败（超时 30 秒/连接拒绝/工具报错）只计入错误提示，
  不影响其他来源。

## 配置字段

| 字段 | 说明 |
|---|---|
| 名称 | 显示名，也用于结果来源标注（`MCP:<名称>`） |
| 端点 URL | Streamable HTTP 端点，如 `http://127.0.0.1:8000/mcp` |
| Authorization 头 | 可选；完整头值（如 `Bearer xxx`），只发送给该端点 |
| 工具名 | 要调用的 MCP 工具（可用「测试连接」列出并校验） |
| 查询参数名 | 查询词写入的参数，默认 `query` |
| 固定参数 | 可选 JSON 对象，随每次调用发送（如 `{"limit": 10}`） |

## 接入 stdio 型 server（本地进程）

许多数据类 MCP server 是本地 stdio 进程（Python/Node）。本应用只支持
Streamable HTTP，两种桥接方式任选：

### 方式一：fastmcp 的 HTTP 模式（推荐，Python server）

如果 server 用 [FastMCP](https://github.com/jlowin/fastmcp) 编写：

    fastmcp run server.py --transport streamable-http --port 8000

端点即 `http://127.0.0.1:8000/mcp`。

### 方式二：mcp-proxy 通用桥接

任意 stdio server 均可用 [mcp-proxy](https://github.com/sparfenyuk/mcp-proxy)：

    uvx mcp-proxy --port 8000 -- python your_stdio_server.py

## 示例：tushare 类金融数据 server

假设有一个暴露 `stock_news` 工具（参数 `query`、`limit`）的金融数据
MCP server 跑在本机 8000 端口：

- 名称：`tushare`
- 端点 URL：`http://127.0.0.1:8000/mcp`
- 工具名：`stock_news`
- 查询参数名：`query`
- 固定参数：`{"limit": 10}`

点「测试连接」确认工具存在后启用。之后发起 Deep Research（如
"贵州茅台 一季报"），综合报告会把该 server 返回的数据作为编号来源引用。

## 安全提示

- 查询词会发送给启用的 MCP server，只配置**可信**服务。
- Authorization 头以明文存于本地设置，与搜索 API key 同等对待。
```

- [ ] **Step 2: 提交**

```bash
git add -f docs/mcp-research-source-guide.md
git commit -m "docs: 新增 MCP 数据源使用指南（含 stdio 桥接说明）

Co-Authored-By: Hugo <shen.lan123@gmail.com>"
```

（注意：上游 `.gitignore` 忽略 `docs/`，必须 `git add -f`。）

---

## 验收对照（spec → task）

| Spec 要求 | Task |
|---|---|
| 极简 Streamable HTTP 客户端（initialize/initialized/tools/call、JSON+SSE 双形态、session 头、authHeader、超时 30s、错误前缀） | Task 1 |
| 结果映射（text block → WebSearchResult、2000 字符截断、source: "MCP:<name>"） | Task 1 |
| `testMcpServer`（tools/list + hasTool） | Task 1 |
| `SearchApiConfig.mcpServers`（向后兼容） | Task 2 |
| `collectResearchSources` 归并（enabled × 查询词、追加在 web/anytxt 后、单源失败进 errors） | Task 2 |
| 「外部信息源」MCP 卡片（增删改/启用开关/测试连接/extraArgs 校验提示） | Task 3 |
| i18n（zh/en，parity 测试） | Task 3 |
| stdio 桥接使用指南（fastmcp/mcp-proxy、tushare 示例） | Task 4 |
| 未配置时零行为变化 | Task 2（既有测试）+ Global Constraints |
```
