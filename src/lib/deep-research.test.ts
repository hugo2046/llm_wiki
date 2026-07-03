import { describe, expect, it, vi } from "vitest"
import { collectResearchSources, makeDeepResearchFileName, noResearchSourcesTaskPatch, buildFinanceSearchContext } from "./deep-research"
import type { SearchApiConfig } from "@/stores/wiki-store"
import type { WebSearchResult } from "./web-search"

const webResult: WebSearchResult = {
  title: "Web",
  url: "https://example.com/web",
  snippet: "web snippet",
  source: "example.com",
}

const localResult: WebSearchResult = {
  title: "Local",
  url: "file:///C:/docs/local.md",
  snippet: "local snippet",
  source: "AnyTXT",
}

function config(patch: Partial<SearchApiConfig>): SearchApiConfig {
  return {
    provider: "none",
    apiKey: "",
    ...patch,
  }
}

describe("makeDeepResearchFileName", () => {
  it("keeps Unicode topics and includes time to avoid same-day overwrite", () => {
    const first = makeDeepResearchFileName(
      "反硝化除磷",
      new Date("2026-06-06T10:00:00.000Z"),
    )
    const second = makeDeepResearchFileName(
      "反硝化除磷",
      new Date("2026-06-06T10:00:01.000Z"),
    )

    expect(first.fileName).toBe("research-反硝化除磷-2026-06-06-100000.md")
    expect(second.fileName).toBe("research-反硝化除磷-2026-06-06-100001.md")
    expect(first.fileName).not.toBe(second.fileName)
  })

  it("uses the local calendar date for frontmatter metadata", () => {
    const localMorning = new Date(2026, 5, 6, 1, 30, 0)

    expect(makeDeepResearchFileName("政策版本差异", localMorning).date).toBe("2026-06-06")
  })
})

describe("noResearchSourcesTaskPatch", () => {
  it("marks source failures as an error instead of completed", () => {
    expect(noResearchSourcesTaskPatch(["Firecrawl blocked this IP", "AnyTXT offline"])).toEqual({
      status: "error",
      synthesis: "",
      error: "Firecrawl blocked this IP\nAnyTXT offline",
    })
  })

  it("marks an empty successful search as done", () => {
    expect(noResearchSourcesTaskPatch([])).toEqual({
      status: "done",
      synthesis: "No research sources found.",
      error: null,
    })
  })
})

describe("collectResearchSources", () => {
  it("uses only Web Search when source mode is web", async () => {
    const webSearch = vi.fn().mockResolvedValue([webResult])
    const anyTxtSearch = vi.fn().mockResolvedValue([localResult])

    const out = await collectResearchSources(
      ["alpha"],
      config({ deepResearchSource: "web", provider: "tavily", apiKey: "tvly" }),
      "/project",
      { webSearch, anyTxtSearch },
    )

    expect(webSearch).toHaveBeenCalledTimes(1)
    expect(anyTxtSearch).not.toHaveBeenCalled()
    expect(out.results).toEqual([webResult])
  })

  it("uses only AnyTXT when source mode is anytxt", async () => {
    const webSearch = vi.fn().mockResolvedValue([webResult])
    const anyTxtSearch = vi.fn().mockResolvedValue([localResult])

    const out = await collectResearchSources(
      ["alpha"],
      config({
        deepResearchSource: "anytxt",
        provider: "tavily",
        apiKey: "tvly",
        anyTxt: { endpoint: "http://127.0.0.1:9920" },
      }),
      "/project",
      { webSearch, anyTxtSearch },
    )

    expect(webSearch).not.toHaveBeenCalled()
    expect(anyTxtSearch).toHaveBeenCalledTimes(1)
    expect(anyTxtSearch.mock.calls[0][0]).toEqual(["alpha"])
    expect(out.results).toEqual([localResult])
  })

  it("uses both sources concurrently and deduplicates by URL", async () => {
    const duplicate = { ...localResult, url: webResult.url }
    const webSearch = vi.fn().mockResolvedValue([webResult])
    const anyTxtSearch = vi.fn().mockResolvedValue([duplicate, localResult])

    const out = await collectResearchSources(
      ["alpha"],
      config({
        deepResearchSource: "both",
        provider: "tavily",
        apiKey: "tvly",
        anyTxt: { endpoint: "http://127.0.0.1:9920" },
      }),
      "/project",
      { webSearch, anyTxtSearch },
    )

    expect(webSearch).toHaveBeenCalledTimes(1)
    expect(anyTxtSearch).toHaveBeenCalledTimes(1)
    expect(out.results).toEqual([webResult, localResult])
  })

  it("keeps web results when AnyTXT fails and exposes the source error", async () => {
    const webSearch = vi.fn().mockResolvedValue([webResult])
    const anyTxtSearch = vi.fn().mockRejectedValue(new Error("Check that ATGUI.exe is running"))

    const out = await collectResearchSources(
      ["alpha"],
      config({
        deepResearchSource: "both",
        provider: "tavily",
        apiKey: "tvly",
        anyTxt: { endpoint: "http://127.0.0.1:9920" },
      }),
      "/project",
      { webSearch, anyTxtSearch },
    )

    expect(out.results).toEqual([webResult])
    expect(out.errors).toEqual(["Check that ATGUI.exe is running"])
  })

  it("skips Web Search in both mode when no web provider is configured", async () => {
    const webSearch = vi.fn().mockResolvedValue([webResult])
    const anyTxtSearch = vi.fn().mockResolvedValue([localResult])

    const out = await collectResearchSources(
      ["alpha"],
      config({
        deepResearchSource: "both",
        provider: "none",
        anyTxt: { endpoint: "http://127.0.0.1:9920" },
      }),
      "/project",
      { webSearch, anyTxtSearch },
    )

    expect(webSearch).not.toHaveBeenCalled()
    expect(anyTxtSearch).toHaveBeenCalledTimes(1)
    expect(out.results).toEqual([localResult])
  })

  it("returns no results for blank queries", async () => {
    const webSearch = vi.fn().mockResolvedValue([webResult])
    const anyTxtSearch = vi.fn().mockResolvedValue([localResult])

    const out = await collectResearchSources(
      [" ", ""],
      config({ deepResearchSource: "both", provider: "tavily", apiKey: "tvly" }),
      "/project",
      { webSearch, anyTxtSearch },
    )

    expect(webSearch).not.toHaveBeenCalled()
    expect(anyTxtSearch).not.toHaveBeenCalled()
    expect(out.results).toEqual([])
  })

  it("logs once when research sources are capped", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {})
    const webSearch = vi.fn().mockResolvedValue(
      Array.from({ length: 25 }, (_, index) => ({
        title: `Result ${index}`,
        url: `https://example.com/${index}`,
        snippet: "snippet",
        source: "example.com",
      })),
    )
    const anyTxtSearch = vi.fn().mockResolvedValue([])

    const out = await collectResearchSources(
      ["alpha", "beta"],
      config({ deepResearchSource: "web", provider: "tavily", apiKey: "tvly" }),
      "/project",
      { webSearch, anyTxtSearch },
    )

    expect(out.results).toHaveLength(20)
    expect(infoSpy).toHaveBeenCalledTimes(1)
    infoSpy.mockRestore()
  })
})

describe("buildFinanceSearchContext", () => {
  const today = "2026-07-02"
  const web: WebSearchResult = {
    title: "Web",
    url: "https://example.com/web",
    snippet: "web snippet",
    source: "example.com",
  }
  const localNew: WebSearchResult = {
    title: "20260512-600519.SH-贵州茅台-一季报纪要.pdf",
    url: "file:///C:/docs/a.pdf",
    snippet: "茅台一季报",
    source: "AnyTXT",
  }
  const localOld: WebSearchResult = {
    title: "20251201-NA-行业峰会纪要.pdf",
    url: "file:///C:/docs/b.pdf",
    snippet: "峰会纪要",
    source: "AnyTXT",
  }
  const localUnparsed: WebSearchResult = {
    title: "random-notes.md",
    url: "file:///C:/docs/c.md",
    snippet: "随手记",
    source: "AnyTXT",
  }

  it("有日期的本地来源按日期倒序在前，未解析本地次之，web 原序在后", () => {
    const { ordered } = buildFinanceSearchContext([web, localOld, localNew, localUnparsed], today)
    expect(ordered).toEqual([localNew, localOld, localUnparsed, web])
  })

  it("标注日期/距今天数/标的，编号按最终顺序重排", () => {
    const { context } = buildFinanceSearchContext([web, localOld, localNew, localUnparsed], today)
    const lines = context.split("\n\n")
    expect(lines[0]).toBe(
      "[1] **20260512-600519.SH-贵州茅台-一季报纪要.pdf** (AnyTXT, 日期: 2026-05-12, 距今 51 天, 标的: 贵州茅台 600519.SH)\n茅台一季报",
    )
    expect(lines[2]).toBe("[3] **random-notes.md** (AnyTXT)\n随手记")
    expect(lines[3]).toBe("[4] **Web** (example.com)\nweb snippet")
  })

  it("超过 180 天的来源追加数据时效存疑标记", () => {
    const { context } = buildFinanceSearchContext([localOld], today)
    expect(context).toBe(
      "[1] **20251201-NA-行业峰会纪要.pdf** (AnyTXT, 日期: 2025-12-01, 距今 213 天) ⚠️ 数据时效存疑\n峰会纪要",
    )
  })
})

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

  it("启用的 server 收到一次批量调用（全部查询词），结果归并去重", async () => {
    const mcpBatch = vi.fn().mockResolvedValue({ results: [mcpResult, mcpResult], errors: [] })
    const { results, errors } = await collectResearchSources(
      ["q1", "q2"],
      config({ deepResearchSource: "web", mcpServers: [mcpServer] }),
      "C:/proj",
      { webSearch: vi.fn().mockResolvedValue([]), anyTxtSearch: vi.fn().mockResolvedValue([]), mcpBatch },
    )
    expect(mcpBatch).toHaveBeenCalledTimes(1)
    expect(mcpBatch).toHaveBeenCalledWith(mcpServer, ["q1", "q2"])
    expect(results).toEqual([mcpResult]) // 相同结果被去重为一条
    expect(errors).toEqual([])
  })

  it("禁用与配置不全的 server 不调用", async () => {
    const mcpBatch = vi.fn()
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
      { webSearch: vi.fn().mockResolvedValue([]), anyTxtSearch: vi.fn().mockResolvedValue([]), mcpBatch },
    )
    expect(mcpBatch).not.toHaveBeenCalled()
  })

  it("批内失败进 errors 且不影响其他源", async () => {
    const { results, errors } = await collectResearchSources(
      ["q"],
      config({ provider: "tavily", apiKey: "k", deepResearchSource: "web", mcpServers: [mcpServer] }),
      "C:/proj",
      {
        webSearch: vi.fn().mockResolvedValue([webResult]),
        anyTxtSearch: vi.fn().mockResolvedValue([]),
        mcpBatch: vi.fn().mockResolvedValue({ results: [], errors: ["MCP tushare: ECONNREFUSED"] }),
      },
    )
    expect(results).toEqual([webResult])
    expect(errors).toEqual(["MCP tushare: ECONNREFUSED"])
  })
})
