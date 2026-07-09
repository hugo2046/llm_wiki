import { beforeEach, describe, expect, it, vi } from "vitest"
import { hasConfiguredDeepResearchSources, hasConfiguredSearchProvider, resolveSearchConfig, webSearch } from "./web-search"

const invokeMock = vi.hoisted(() => vi.fn())

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}))

describe("webSearch", () => {
  beforeEach(() => {
    invokeMock.mockReset()
  })

  it("delegates provider search to the Rust backend command", async () => {
    invokeMock.mockResolvedValueOnce([
      { title: "A", url: "https://example.com/a", snippet: "Alpha", source: "web" },
    ])

    const out = await webSearch("alpha", { provider: "tavily", apiKey: "tvly" }, 3)

    expect(invokeMock).toHaveBeenCalledWith("web_search", {
      query: "alpha",
      maxResults: 3,
      config: expect.objectContaining({
        provider: "tavily",
        apiKey: "tvly",
      }),
    })
    expect(out).toEqual([
      { title: "A", url: "https://example.com/a", snippet: "Alpha", source: "web" },
    ])
  })

  it("passes provider-specific config to Rust", async () => {
    invokeMock.mockResolvedValueOnce([])

    await webSearch(
      "ai policy",
      {
        provider: "serpapi",
        apiKey: "",
        providerConfigs: {
          tavily: { apiKey: "tavily-key" },
          serpapi: { apiKey: "serp-key", serpApiEngine: "google_news" },
        },
      },
      5,
    )

    expect(invokeMock).toHaveBeenCalledWith("web_search", {
      query: "ai policy",
      maxResults: 5,
      config: expect.objectContaining({
        provider: "serpapi",
        apiKey: "serp-key",
        serpApiEngine: "google_news",
      }),
    })
  })

  it("requires a configured search provider and key", async () => {
    await expect(webSearch("x", { provider: "none", apiKey: "" }, 5))
      .rejects.toThrow("Web search not configured")
    await expect(webSearch("x", { provider: "serpapi", apiKey: "" }, 5))
      .rejects.toThrow("Add a Tavily, SerpApi, or Brave Search API key")
    await expect(webSearch("x", { provider: "searxng", apiKey: "" }, 5))
      .rejects.toThrow("Add a SearXNG instance URL")
    await expect(webSearch("x", { provider: "ollama", apiKey: "" }, 5))
      .rejects.toThrow("Ollama Web Search API requires an Ollama API key")
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it("treats key-free providers as configured", () => {
    expect(hasConfiguredSearchProvider({ provider: "searxng", apiKey: "", searXngUrl: "http://localhost:8080" })).toBe(true)
    expect(hasConfiguredSearchProvider({ provider: "firecrawl", apiKey: "" })).toBe(true)
  })

  it("does not leak a stale top-level Ollama URL into non-Ollama providers", () => {
    const resolved = resolveSearchConfig({
      provider: "firecrawl",
      apiKey: "",
      ollamaUrl: "http://localhost:11434",
    })

    expect(resolved.provider).toBe("firecrawl")
    expect(resolved.ollamaUrl).toBe("https://ollama.com")
  })

  it("tracks Deep Research source configuration independently from the active web provider", () => {
    expect(hasConfiguredDeepResearchSources({
      provider: "none",
      apiKey: "",
      deepResearchSource: "anytxt",
      anyTxt: { enabled: true, endpoint: "http://127.0.0.1:9920" },
    })).toBe(true)
    expect(hasConfiguredDeepResearchSources({
      provider: "none",
      apiKey: "",
      deepResearchSource: "both",
      anyTxt: { enabled: false, endpoint: "" },
    })).toBe(false)

    expect(hasConfiguredDeepResearchSources({
      provider: "none",
      apiKey: "",
      deepResearchSource: "web",
      anyTxt: { endpoint: "http://127.0.0.1:9920" },
    })).toBe(false)

    expect(resolveSearchConfig({
      provider: "none",
      apiKey: "",
    }).deepResearchSource).toBe("web")
  })

  it("treats an enabled MCP server as a configured Deep Research source (MCP-only setup)", () => {
    const mcpServer = {
      id: "s1",
      name: "tushare",
      url: "http://127.0.0.1:8000/mcp",
      toolName: "stock_news",
      queryParam: "query",
      enabled: true,
    }
    // 仅配置 MCP、无 web/anytxt：应可启动研究（与 collectResearchSources 的参战条件一致）
    expect(hasConfiguredDeepResearchSources({
      provider: "none",
      apiKey: "",
      deepResearchSource: "web",
      mcpServers: [mcpServer],
    })).toBe(true)

    // 禁用或配置不全的 server 不算
    expect(hasConfiguredDeepResearchSources({
      provider: "none",
      apiKey: "",
      mcpServers: [
        { ...mcpServer, enabled: false },
        { ...mcpServer, id: "s2", url: " " },
        { ...mcpServer, id: "s3", toolName: "" },
      ],
    })).toBe(false)
  })
})
