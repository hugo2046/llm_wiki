import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  buildToolArguments,
  callMcpTool,
  callMcpToolBatch,
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
  it("text block 映射为 WebSearchResult 并截断超长文本；title 携带查询词", () => {
    const long = "甲".repeat(2500)
    const out = mapMcpContent(server, [
      { type: "text", text: "第一段" },
      { type: "image", text: "忽略" },
      { type: "text", text: long },
    ], "贵州茅台 财报")
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({
      title: "tushare/stock_news: 贵州茅台 财报",
      url: "",
      snippet: "第一段",
      source: "MCP:tushare",
    })
    expect(out[1].snippet.length).toBe(2001) // 2000 字符 + 省略号
    expect(out[1].snippet.endsWith("…")).toBe(true)
  })

  it("超长查询词在 title 中截断", () => {
    const out = mapMcpContent(server, [{ type: "text", text: "x" }], "查".repeat(60))
    expect(out[0].title).toBe(`tushare/stock_news: ${"查".repeat(40)}…`)
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
      title: "tushare/stock_news: 贵州茅台 财报",
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

  it("网络类错误归一为友好文案", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"))
    await expect(callMcpTool(server, "q")).rejects.toThrow(/MCP tushare: 网络请求失败：无法连接 MCP 端点/)
  })
})

describe("callMcpToolBatch", () => {
  it("多查询复用一次会话：initialize/initialized 各一次 + 每查询一次 tools/call", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(
        { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26" } },
        { "mcp-session-id": "sess-9" },
      ))
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(jsonResponse({
        jsonrpc: "2.0",
        id: 2,
        result: { content: [{ type: "text", text: "r1" }] },
      }))
      .mockResolvedValueOnce(jsonResponse({
        jsonrpc: "2.0",
        id: 3,
        result: { content: [{ type: "text", text: "r2" }] },
      }))

    const { results, errors } = await callMcpToolBatch(server, ["q1", "q2"])

    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(errors).toEqual([])
    expect(results.map((r) => r.snippet)).toEqual(["r1", "r2"])
    expect(results.map((r) => r.title)).toEqual([
      "tushare/stock_news: q1",
      "tushare/stock_news: q2",
    ])
    // 第二次 tools/call 递增 id 且沿用 session 头
    const secondCall = JSON.parse(fetchMock.mock.calls[3][1]?.body as string)
    expect(secondCall.id).toBe(3)
    expect((fetchMock.mock.calls[3][1]?.headers as Record<string, string>)["Mcp-Session-Id"]).toBe("sess-9")
  })

  it("批内单查询失败不中断其余查询，错误带前缀归集", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(
        { jsonrpc: "2.0", id: 1, result: {} },
        { "mcp-session-id": "sess-9" },
      ))
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(jsonResponse({
        jsonrpc: "2.0",
        id: 2,
        error: { code: -32602, message: "unknown tool" },
      }))
      .mockResolvedValueOnce(jsonResponse({
        jsonrpc: "2.0",
        id: 3,
        result: { content: [{ type: "text", text: "ok" }] },
      }))

    const { results, errors } = await callMcpToolBatch(server, ["bad", "good"])

    expect(results).toHaveLength(1)
    expect(results[0].snippet).toBe("ok")
    expect(errors).toEqual(["MCP tushare: tools/call: unknown tool"])
  })

  it("会话建立失败时整批失败", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"))
    const { results, errors } = await callMcpToolBatch(server, ["q1", "q2"])
    expect(results).toEqual([])
    expect(errors).toEqual(["MCP tushare: ECONNREFUSED"])
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
