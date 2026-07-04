/**
 * 极简 MCP Streamable HTTP 客户端——deep-research 的第三类检索源。
 *
 * 只实现协议子集：initialize → notifications/initialized → tools/call
 * （检索）或 tools/list（测试连接），全部为 JSON-RPC 2.0 POST。
 * 纯逻辑（参数构造/SSE 解析/结果映射）与 IO（callMcpTool/testMcpServer）
 * 分离，前者可脱离网络单测。
 */
import { getHttpFetch, isFetchNetworkError } from "@/lib/tauri-fetch"
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

/** title 中查询词的截断上限（保持引用行紧凑）。 */
const TITLE_QUERY_MAX_CHARS = 40

/**
 * tools/call 结果的 text block 映射为检索结果。
 *
 * title 携带查询词：同一 server×tool 对多个查询的结果在 References
 * 中可区分、可回溯（url 恒为空，title 是唯一的辨识信息）。
 *
 * :param server: server 配置（供 title/source 命名）
 * :param blocks: content blocks
 * :param query: 本次调用的查询词
 * :returns: 每个非空 text block 一条结果，snippet 截断至 2000 字符
 */
export function mapMcpContent(
  server: McpServerConfig,
  blocks: McpContentBlock[],
  query: string,
): WebSearchResult[] {
  const shortQuery = query.length > TITLE_QUERY_MAX_CHARS
    ? `${query.slice(0, TITLE_QUERY_MAX_CHARS)}…`
    : query
  const out: WebSearchResult[] = []
  for (const block of blocks) {
    const text = block.type === "text" ? block.text?.trim() : ""
    if (!text) continue
    out.push({
      title: `${server.name}/${server.toolName}: ${shortQuery}`,
      url: "",
      snippet: text.length > SNIPPET_MAX_CHARS ? `${text.slice(0, SNIPPET_MAX_CHARS)}…` : text,
      source: `MCP:${server.name}`,
    })
  }
  return out
}

/** 网络类错误归一为友好文案（沿用 tauri-fetch 的跨平台判定，与兄弟集成一致）。 */
function describeMcpError(err: unknown): string {
  if (isFetchNetworkError(err)) {
    return "网络请求失败：无法连接 MCP 端点，请确认 server 正在运行且 URL 正确"
  }
  return err instanceof Error ? err.message : String(err)
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
  post: (
    id: number,
    method: string,
    params?: unknown,
    signal?: AbortSignal,
  ) => Promise<JsonRpcResponse | null>
}

/** 建立会话：initialize + notifications/initialized，返回带 session 头的 post。 */
async function openMcpSession(server: McpServerConfig, signal: AbortSignal): Promise<McpSession> {
  const httpFetch = await getHttpFetch()

  async function rawPost(
    payload: object,
    sessionId: string | null,
    requestSignal: AbortSignal = signal,
  ): Promise<Response> {
    return httpFetch(server.url, {
      method: "POST",
      headers: baseHeaders(server, sessionId),
      body: JSON.stringify(payload),
      signal: requestSignal,
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
    post: async (id, method, params, requestSignal) => {
      const res = await rawPost(
        params === undefined
          ? { jsonrpc: "2.0", id, method }
          : { jsonrpc: "2.0", id, method, params },
        sessionId,
        requestSignal,
      )
      if (!res.ok) throw new Error(`${method} HTTP ${res.status}`)
      return readJsonRpc(res, id)
    },
  }
}

/**
 * 对单个 MCP server 批量执行检索：一次会话（initialize/initialized）
 * 复用于多个查询的 tools/call——S×Q 扇出下请求量从 3×S×Q 降为
 * S×(2+Q)。查询间并行执行、各自独立超时；单查询失败不中断其余。
 *
 * :param server: server 配置
 * :param queries: 查询词列表
 * :param timeoutMs: 会话建立与每个查询各自的超时（默认 30 秒）
 * :returns: { results: 按查询顺序归集的成功结果, errors: 带前缀的失败消息 }
 */
export async function callMcpToolBatch(
  server: McpServerConfig,
  queries: string[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<{ results: WebSearchResult[]; errors: string[] }> {
  const results: WebSearchResult[] = []
  const errors: string[] = []

  // 会话建立有独立超时；失败则整批失败
  const openController = new AbortController()
  const openTimer = setTimeout(() => openController.abort(), timeoutMs)
  let session: McpSession
  try {
    session = await openMcpSession(server, openController.signal)
  } catch (err) {
    errors.push(`MCP ${server.name}: ${describeMcpError(err)}`)
    return { results, errors }
  } finally {
    clearTimeout(openTimer)
  }

  // 查询并行执行、各自独立超时——保持旧实现的每查询并发语义，
  // 慢工具 × 多查询不再互相挤占同一个时间预算；结果按查询顺序归集
  const perQuery = await Promise.all(
    queries.map(async (query, index) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const args = buildToolArguments(server, query)
        const msg = await session.post(
          2 + index,
          "tools/call",
          { name: server.toolName, arguments: args },
          controller.signal,
        )
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
        return { items: mapMcpContent(server, result.content ?? [], query), error: null as string | null }
      } catch (err) {
        return { items: [] as WebSearchResult[], error: `MCP ${server.name}: ${describeMcpError(err)}` }
      } finally {
        clearTimeout(timer)
      }
    }),
  )
  for (const outcome of perQuery) {
    results.push(...outcome.items)
    if (outcome.error) errors.push(outcome.error)
  }
  return { results, errors }
}

/**
 * 对单个 MCP server 执行一次检索调用（单查询便捷封装）。
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
  const { results, errors } = await callMcpToolBatch(server, [query], timeoutMs)
  if (errors.length > 0) throw new Error(errors[0])
  return results
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
