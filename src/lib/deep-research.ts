import { anyTxtSearchSmart, hasConfiguredAnyTxt } from "./anytxt-search"
import { hasConfiguredSearchProvider, resolveSearchConfig, webSearch } from "./web-search"
import { callMcpTool } from "./mcp-search"
import { streamChat } from "./llm-client"
import { autoIngest, currentWikiDate } from "./ingest"
import { writeFile, readFile } from "@/commands/fs"
import { useWikiStore, type LlmConfig, type SearchApiConfig } from "@/stores/wiki-store"
import { useResearchStore } from "@/stores/research-store"
import { normalizePath } from "@/lib/path-utils"
import { buildLanguageDirective } from "@/lib/output-language"
import { makeQueryFileName } from "@/lib/wiki-filename"
import { refreshProjectFileTree } from "@/lib/project-file-tree-refresh"
import { isFinanceNamingEnabled, parseNormalizedFinanceName, type NormalizedFinanceName } from "./finance-naming"
import { appendProjectLog } from "./project-log"

const MAX_RESEARCH_SOURCES = 20

/** 本地来源超过该天数视为可能过期，上下文中显式标记。 */
const STALE_SOURCE_DAYS = 180

/** 金融模式追加到系统提示词 Time Sensitivity 段的指令。 */
export const FINANCE_TIME_DIRECTIVES = [
  "- Local sources (AnyTXT) carry a deterministic 日期 parsed from their normalized filenames; trust these dates over any dates appearing inside snippets.",
  "- Organize the synthesis along the timeline (最新数据优先); when data points conflict, adopt the most recently dated source and note the older value it supersedes.",
].join("\n")

/** yyyymmdd → yyyy-mm-dd。 */
function formatFinanceDate(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`
}

/** 两个 yyyy-mm-dd 日历日之间的天数（to - from）。 */
function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000)
}

/**
 * 金融模式的检索上下文构建：本地来源确定性解析日期/标的后按时间倒序
 * 前置，未解析本地来源次之，web 结果保持原序在后；[N] 编号按最终顺序
 * 重排，ordered 供 References 一节保持编号一致。
 *
 * :param results: 合并后的检索结果
 * :param today: 今天（yyyy-mm-dd，currentWikiDate 产物）
 * :returns: { context: 注入 LLM 的上下文, ordered: 重排后的结果 }
 */
export function buildFinanceSearchContext(
  results: import("./web-search").WebSearchResult[],
  today: string,
): { context: string; ordered: import("./web-search").WebSearchResult[] } {
  interface Annotated {
    result: import("./web-search").WebSearchResult
    parsed: NormalizedFinanceName | null
  }
  const dated: Annotated[] = []
  const undatedLocal: Annotated[] = []
  const rest: Annotated[] = []
  for (const result of results) {
    if (result.source !== "AnyTXT") {
      rest.push({ result, parsed: null })
      continue
    }
    const parsed = parseNormalizedFinanceName(result.title)
    if (parsed) dated.push({ result, parsed })
    else undatedLocal.push({ result, parsed: null })
  }
  // Array.sort 稳定：同日来源维持检索原序
  dated.sort((a, b) => b.parsed!.date.localeCompare(a.parsed!.date))

  const orderedAnnotated = [...dated, ...undatedLocal, ...rest]
  const context = orderedAnnotated
    .map((item, i) => {
      const r = item.result
      if (!item.parsed) return `[${i + 1}] **${r.title}** (${r.source})\n${r.snippet}`
      const iso = formatFinanceDate(item.parsed.date)
      const age = daysBetween(iso, today)
      const target = item.parsed.tsCode
        ? `, 标的: ${item.parsed.stockName} ${item.parsed.tsCode}`
        : ""
      const stale = age > STALE_SOURCE_DAYS ? " ⚠️ 数据时效存疑" : ""
      return `[${i + 1}] **${r.title}** (${r.source}, 日期: ${iso}, 距今 ${age} 天${target})${stale}\n${r.snippet}`
    })
    .join("\n\n")

  return { context, ordered: orderedAnnotated.map((a) => a.result) }
}

interface ResearchSourceDeps {
  webSearch: typeof webSearch
  anyTxtSearch: typeof anyTxtSearchSmart
  /** MCP 检索调用；缺省回退真实实现（便于测试注入） */
  mcpCall?: typeof callMcpTool
}

interface CollectResearchSourceOptions {
  llmConfig?: LlmConfig
}

interface ResearchSourceCollection {
  results: import("./web-search").WebSearchResult[]
  errors: string[]
}

export function noResearchSourcesTaskPatch(sourceErrors: string[]): {
  status: "done" | "error"
  synthesis: string
  error: string | null
} {
  // If every selected source produced zero usable results and at least
  // one source failed, surface the failure state explicitly. Otherwise
  // the UI shows "completed" for a task that could not actually search.
  if (sourceErrors.length > 0) {
    return {
      status: "error",
      synthesis: "",
      error: sourceErrors.join("\n"),
    }
  }
  return {
    status: "done",
    synthesis: "No research sources found.",
    error: null,
  }
}

export function makeDeepResearchFileName(topic: string, now: Date = new Date()): {
  fileName: string
  date: string
} {
  const { fileName } = makeQueryFileName(`research-${topic}`, now)
  return { fileName, date: currentWikiDate(now) }
}

/**
 * Queue a deep research task. Automatically starts processing if under concurrency limit.
 */
export function queueResearch(
  projectPath: string,
  topic: string,
  llmConfig: LlmConfig,
  searchConfig: SearchApiConfig,
  searchQueries?: string[],
): string {
  const store = useResearchStore.getState()
  const taskId = store.addTask(topic)
  // Store search queries on the task
  if (searchQueries && searchQueries.length > 0) {
    store.updateTask(taskId, { searchQueries })
  }
  // Ensure panel is open
  store.setPanelOpen(true)
  // Start processing on next tick to ensure React has rendered the panel
  setTimeout(() => {
    processQueue(projectPath, llmConfig, searchConfig)
  }, 50)
  return taskId
}

export async function collectResearchSources(
  queries: string[],
  searchConfig: SearchApiConfig,
  projectPath: string,
  deps: ResearchSourceDeps = { webSearch, anyTxtSearch: anyTxtSearchSmart },
  options: CollectResearchSourceOptions = {},
): Promise<ResearchSourceCollection> {
  const resolvedSearchConfig = resolveSearchConfig(searchConfig)
  const sourceMode = resolvedSearchConfig.deepResearchSource ?? "web"
  const useWeb = sourceMode === "web" || sourceMode === "both"
  const useAnyTxt = hasAnyTxtSource(resolvedSearchConfig) && hasConfiguredAnyTxt(resolvedSearchConfig.anyTxt)
  const webConfigured = hasConfiguredSearchProvider(resolvedSearchConfig)
  const allResults: import("./web-search").WebSearchResult[] = []
  const errors: string[] = []
  const seenUrls = new Set<string>()
  let cappedWarned = false

  function addResults(results: import("./web-search").WebSearchResult[]) {
    for (const r of results) {
      if (allResults.length >= MAX_RESEARCH_SOURCES) {
        if (!cappedWarned) {
          console.info(`[DeepResearch] capped at ${MAX_RESEARCH_SOURCES} research sources; later results were truncated.`)
          cappedWarned = true
        }
        return
      }
      const key = (r.url || `${r.source}:${r.title}:${r.snippet}`).toLowerCase()
      if (!seenUrls.has(key)) {
        seenUrls.add(key)
        allResults.push(r)
      }
    }
  }

  const webQueries = queries.map((q) => q.trim()).filter(Boolean)
  const calls: Array<Promise<{ results: import("./web-search").WebSearchResult[] }>> = []

  for (const webQuery of webQueries) {
    if (useWeb && webConfigured && webQuery) {
      calls.push(deps.webSearch(webQuery, resolvedSearchConfig, 5).then((results) => ({ results })))
    }
  }
  if (useAnyTxt) {
    calls.push(deps.anyTxtSearch(queries, resolvedSearchConfig.anyTxt, options.llmConfig, 15, projectPath).then((results) => ({ results })))
  }

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

  const settled = await Promise.allSettled(calls)
  for (const item of settled) {
    if (item.status === "fulfilled") {
      addResults(item.value.results)
    } else {
      const message = item.reason instanceof Error ? item.reason.message : String(item.reason)
      errors.push(message)
      console.warn("[DeepResearch] source search failed:", message)
    }
  }

  return { results: allResults, errors }
}

function hasAnyTxtSource(searchConfig: SearchApiConfig): boolean {
  const sourceMode = searchConfig.deepResearchSource ?? "web"
  return sourceMode === "anytxt" || sourceMode === "both"
}

function isActiveProjectPath(projectPath: string): boolean {
  const activePath = useWikiStore.getState().project?.path
  return Boolean(activePath && normalizePath(activePath) === normalizePath(projectPath))
}

function updateTaskIfActive(
  projectPath: string,
  taskId: string,
  patch: Parameters<ReturnType<typeof useResearchStore.getState>["updateTask"]>[1],
): boolean {
  if (!isActiveProjectPath(projectPath)) return false
  useResearchStore.getState().updateTask(taskId, patch)
  return true
}

/**
 * Process queued tasks up to maxConcurrent limit.
 */
function processQueue(
  projectPath: string,
  llmConfig: LlmConfig,
  searchConfig: SearchApiConfig,
) {
  const store = useResearchStore.getState()
  const running = store.getRunningCount()
  const available = store.maxConcurrent - running

  for (let i = 0; i < available; i++) {
    const next = useResearchStore.getState().getNextQueued()
    if (!next) break
    executeResearch(projectPath, next.id, next.topic, llmConfig, searchConfig)
  }
}

async function executeResearch(
  projectPath: string,
  taskId: string,
  topic: string,
  llmConfig: LlmConfig,
  searchConfig: SearchApiConfig,
) {
  const pp = normalizePath(projectPath)

  try {
    if (!isActiveProjectPath(pp)) return
    // Step 1: gather research sources — use multiple queries if available,
    // merge Web Search and local AnyTXT results, then deduplicate.
    if (!updateTaskIfActive(pp, taskId, { status: "searching" })) return

    const task = useResearchStore.getState().tasks.find((t) => t.id === taskId)
    const queries = task?.searchQueries && task.searchQueries.length > 0
      ? task.searchQueries
      : [topic]
    const { results: allResults, errors: sourceErrors } = await collectResearchSources(
      queries,
      searchConfig,
      pp,
      { webSearch, anyTxtSearch: anyTxtSearchSmart },
      { llmConfig },
    )
    if (!isActiveProjectPath(pp)) return

    const webResults = allResults
    if (!updateTaskIfActive(pp, taskId, { webResults })) return

    if (webResults.length === 0) {
      if (!updateTaskIfActive(pp, taskId, noResearchSourcesTaskPatch(sourceErrors))) return
      void appendProjectLog(pp, "deep-research", [
        `零来源结束: ${topic}`,
        ...sourceErrors,
      ])
      if (isActiveProjectPath(pp)) onTaskFinished(pp, llmConfig, searchConfig)
      return
    }

    // Step 2: LLM synthesis
    if (!updateTaskIfActive(pp, taskId, { status: "synthesizing" })) return

    // 金融模式：确定性消费规范化文件名中的日期/标的（仅金融项目生效）
    const today = currentWikiDate()
    const financeMode = await isFinanceNamingEnabled(pp)
    const { context: searchContext, ordered: orderedResults } = financeMode
      ? buildFinanceSearchContext(webResults, today)
      : {
          context: webResults
            .map((r, i) => `[${i + 1}] **${r.title}** (${r.source})\n${r.snippet}`)
            .join("\n\n"),
          ordered: webResults,
        }

    // 面板编号需与正文 [N]/References 对齐：金融模式下 orderedResults 已重排，回写任务以同步面板显示顺序
    if (!updateTaskIfActive(pp, taskId, { webResults: orderedResults })) return

    // Read existing wiki index to enable cross-referencing
    let wikiIndex = ""
    try {
      wikiIndex = await readFile(`${pp}/wiki/index.md`)
    } catch {
      // no index yet
    }

    const systemPrompt = [
      "You are a research assistant. Synthesize the collected research sources into a comprehensive wiki page.",
      "",
      buildLanguageDirective(topic),
      "",
      "## Time Sensitivity (CRITICAL)",
      `- Today's date is **${today}**. This knowledge base tracks time-sensitive information (e.g. market research); treat recency as a first-class quality signal.`,
      "- When a source snippet reveals its publication date, carry it inline next to the claim, e.g. (2026-06).",
      "- When sources conflict, prefer the most recent one and say so.",
      "- Explicitly flag data points that are older than ~6 months or undated as potentially stale (数据时效存疑) instead of presenting them as current facts.",
      ...(financeMode ? [FINANCE_TIME_DIRECTIVES] : []),
      "",
      "## Cross-referencing (IMPORTANT)",
      "- The wiki already has existing pages listed in the Wiki Index below.",
      "- When your synthesis mentions an entity or concept that exists in the wiki, ALWAYS use [[wikilink]] syntax to link to it.",
      "- For example, if the wiki has an entity 'anthropic', write [[anthropic]] when mentioning it.",
      "- This is critical for connecting new research to existing knowledge in the graph.",
      "",
      "## Writing Rules",
      "- Organize into clear sections with headings",
      "- Cite sources using [N] notation",
      "- Note contradictions or gaps",
      "- Suggest additional sources worth finding",
      "- Neutral, encyclopedic tone",
      "",
      wikiIndex ? `## Existing Wiki Index (link to these pages with [[wikilink]])\n${wikiIndex}` : "",
    ].filter(Boolean).join("\n")

    let accumulated = ""

    await streamChat(
      llmConfig,
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Research topic: **${topic}**\n\n## Research Sources\n\n${searchContext}\n\nSynthesize into a wiki page.` },
      ],
      {
        onToken: (token) => {
          if (!isActiveProjectPath(pp)) return
          accumulated += token
          // Update synthesis progressively so UI shows real-time text
          useResearchStore.getState().updateTask(taskId, { synthesis: accumulated })
        },
        onDone: () => {},
        onError: (err) => {
          if (!isActiveProjectPath(pp)) return
          useResearchStore.getState().updateTask(taskId, {
            status: "error",
            error: err.message,
          })
        },
      },
    )

    // Check if errored during streaming
    if (useResearchStore.getState().tasks.find((t) => t.id === taskId)?.status === "error") {
      if (isActiveProjectPath(pp)) onTaskFinished(pp, llmConfig, searchConfig)
      return
    }
    if (!isActiveProjectPath(pp)) return

    // Step 3: Save to wiki
    if (!updateTaskIfActive(pp, taskId, { status: "saving", synthesis: accumulated })) return

    const { fileName, date } = makeDeepResearchFileName(topic)
    const filePath = `${pp}/wiki/queries/${fileName}`

    const references = orderedResults
      .map((r, i) => `${i + 1}. [${r.title}](${r.url}) — ${r.source}`)
      .join("\n")

    // Strip <think>/<thinking> blocks before saving
    const cleanedSynthesis = accumulated
      .replace(/<think(?:ing)?>\s*[\s\S]*?<\/think(?:ing)?>\s*/gi, "")
      .replace(/<think(?:ing)?>\s*[\s\S]*$/gi, "") // unclosed thinking block
      .trimStart()

    const pageContent = [
      "---",
      `type: query`,
      `title: "Research: ${topic.replace(/"/g, '\\"')}"`,
      `created: ${date}`,
      `origin: deep-research`,
      `tags: [research]`,
      "---",
      "",
      `# Research: ${topic}`,
      "",
      cleanedSynthesis,
      "",
      `## References (retrieved ${date})`,
      "",
      references,
      "",
    ].join("\n")

    await writeFile(filePath, pageContent)
    const savedPath = `wiki/queries/${fileName}`

    if (!updateTaskIfActive(pp, taskId, {
      status: "done",
      savedPath,
    })) return

    void appendProjectLog(pp, "deep-research", [
      `完成: ${topic}`,
      `来源 ${orderedResults.length} 条，保存 ${savedPath}`,
      ...sourceErrors.map((e) => `部分来源失败: ${e}`),
    ])

    try {
      await refreshProjectFileTree(pp, { bumpDataVersion: true })
    } catch {
      // ignore
    }

    // Auto-ingest the research result to generate entities, concepts, cross-references
    if (isActiveProjectPath(pp)) {
      autoIngest(pp, `${pp}/${savedPath}`, llmConfig).catch((err) => {
        console.error("Failed to auto-ingest research result:", err)
      })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    updateTaskIfActive(pp, taskId, {
      status: "error",
      error: message,
    })
    void appendProjectLog(pp, "deep-research", [`失败: ${topic}`, message])
  }

  if (isActiveProjectPath(pp)) onTaskFinished(pp, llmConfig, searchConfig)
}

function onTaskFinished(
  projectPath: string,
  llmConfig: LlmConfig,
  searchConfig: SearchApiConfig,
) {
  // Process next queued task
  setTimeout(() => processQueue(projectPath, llmConfig, searchConfig), 100)
}
