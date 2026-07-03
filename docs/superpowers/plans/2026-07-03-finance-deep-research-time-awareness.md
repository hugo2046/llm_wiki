# 金融项目 deep-research 时间感知 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 金融模式项目的 deep-research 确定性解析本地来源文件名中的日期/标的，按时间倒序前置注入 LLM 上下文，并强化时间脉络提示词。

**Architecture:** 两个纯函数承载全部逻辑——`parseNormalizedFinanceName`（finance-naming.ts，解析规范化文件名）与 `buildFinanceSearchContext`（deep-research.ts，排序+标注+编号重排）；`executeResearch` 仅在 `isFinanceNamingEnabled` 为真时切换到金融上下文构建分支，非金融路径字节级不变。

**Tech Stack:** TypeScript（Vite 前端 lib 层，无 UI 改动），Vitest mock 测试。

**Spec:** `docs/superpowers/specs/2026-07-02-finance-deep-research-time-awareness-design.md`

## Global Constraints

- 仅金融模式生效：门控为 `isFinanceNamingEnabled(projectPath)`（读 `.llm-wiki/source-naming.json` 的 `mode === "finance"`）；非金融项目 searchContext 与系统提示词零行为变化。
- 解析失败的文件名返回 `null`，不硬猜；该来源按「未解析」组处理（不标注、不参与日期排序）。
- 过期阈值 180 天，追加 ` ⚠️ 数据时效存疑`；距今天数以 `currentWikiDate()`（本地日历日，`yyyy-mm-dd`）为基准。
- 排序：有日期的本地来源按日期倒序 → 无日期本地来源 → web 来源原序；`[N]` 编号按最终顺序重排，References 同步。
- 不做时间窗口过滤、不做标的聚合（YAGNI，见 spec）。
- 注释用中文；提交信息遵循项目 Conventional Commits + `Co-Authored-By: Hugo <shen.lan123@gmail.com>`。
- 测试命令：`npx vitest run src/lib/finance-naming.test.ts src/lib/deep-research.test.ts`；类型检查：`npm run typecheck`。

---

### Task 1: `parseNormalizedFinanceName`（规范化文件名解析）

**Files:**
- Modify: `src/lib/finance-naming.ts`（在 `buildFinanceFileName` 之后、`// ── IO 包装` 之前插入）
- Test: `src/lib/finance-naming.test.ts`

**Interfaces:**
- Consumes: 模块内已有私有函数 `isValidMonthDay(mm, dd)`。
- Produces（Task 2 依赖）:
  ```ts
  export interface NormalizedFinanceName {
    date: string          // yyyymmdd
    tsCode: string | null // 如 "600519.SH"；NA 时为 null
    stockName: string | null
  }
  export function parseNormalizedFinanceName(fileName: string): NormalizedFinanceName | null
  ```

- [ ] **Step 1: 写失败测试**

在 `src/lib/finance-naming.test.ts` 顶部 import 中加入 `parseNormalizedFinanceName`，文件末尾追加：

```ts
describe("parseNormalizedFinanceName", () => {
  it("解析 A 股规范化文件名", () => {
    expect(parseNormalizedFinanceName("20260512-600519.SH-贵州茅台-一季报纪要.pdf")).toEqual({
      date: "20260512",
      tsCode: "600519.SH",
      stockName: "贵州茅台",
    })
  })

  it("解析港股规范化文件名（5 位代码）", () => {
    expect(parseNormalizedFinanceName("20260415-00700.HK-腾讯控股-业绩会纪要.docx")).toEqual({
      date: "20260415",
      tsCode: "00700.HK",
      stockName: "腾讯控股",
    })
  })

  it("解析 NA 段（未匹配标的）", () => {
    expect(parseNormalizedFinanceName("20260630-NA-稀美资源-小范围交流.pdf")).toEqual({
      date: "20260630",
      tsCode: null,
      stockName: null,
    })
  })

  it("拒绝非法月日", () => {
    expect(parseNormalizedFinanceName("20261332-NA-乱写.pdf")).toBeNull()
  })

  it("拒绝非规范化文件名与 web 标题", () => {
    expect(parseNormalizedFinanceName("研报总结.pdf")).toBeNull()
    expect(parseNormalizedFinanceName("Anthropic raises new round")).toBeNull()
    // 有日期但缺 ts_code/NA 段：不是本管线的产物，不认
    expect(parseNormalizedFinanceName("20260630-稀美资源-小范围交流.pdf")).toBeNull()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/lib/finance-naming.test.ts -t parseNormalizedFinanceName`
Expected: FAIL（`parseNormalizedFinanceName` 未导出）

- [ ] **Step 3: 最小实现**

在 `src/lib/finance-naming.ts` 的 `buildFinanceFileName` 函数之后插入：

```ts
export interface NormalizedFinanceName {
  date: string
  tsCode: string | null
  stockName: string | null
}

/**
 * 解析规范化金融文件名 `yyyymmdd-<ts_code|NA>-<简称>-<标题>.<ext>`。
 *
 * 只认本管线产出的严格形状（deep-research 用它确定性读取日期/标的），
 * 认不出返回 null——非金融命名不硬猜。
 *
 * :param fileName: 待解析文件名
 * :returns: { date: yyyymmdd, tsCode, stockName }；不符合形状为 null
 */
export function parseNormalizedFinanceName(fileName: string): NormalizedFinanceName | null {
  const match = fileName.match(
    /^(20\d{2})(\d{2})(\d{2})-(?:(\d{5,6}\.[A-Z]{2,4})-([^-]+?)|NA)(?:[-.]|$)/,
  )
  if (!match) return null
  if (!isValidMonthDay(Number(match[2]), Number(match[3]))) return null
  return {
    date: `${match[1]}${match[2]}${match[3]}`,
    tsCode: match[4] ?? null,
    stockName: match[4] ? match[5] : null,
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/lib/finance-naming.test.ts`
Expected: 全部 PASS（含既有用例）

- [ ] **Step 5: 提交**

```bash
git add src/lib/finance-naming.ts src/lib/finance-naming.test.ts
git commit -m "feat: 新增规范化金融文件名解析函数 parseNormalizedFinanceName

Co-Authored-By: Hugo <shen.lan123@gmail.com>"
```

---

### Task 2: `buildFinanceSearchContext`（时间排序 + 标注的上下文构建）

**Files:**
- Modify: `src/lib/deep-research.ts`
- Test: `src/lib/deep-research.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `parseNormalizedFinanceName` / `NormalizedFinanceName`。
- Produces（Task 3 依赖）:
  ```ts
  export function buildFinanceSearchContext(
    results: import("./web-search").WebSearchResult[],
    today: string, // yyyy-mm-dd（currentWikiDate() 产物）
  ): { context: string; ordered: import("./web-search").WebSearchResult[] }
  export const FINANCE_TIME_DIRECTIVES: string
  ```

- [ ] **Step 1: 写失败测试**

在 `src/lib/deep-research.test.ts` 的 import 中加入 `buildFinanceSearchContext`，文件末尾追加：

```ts
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
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/lib/deep-research.test.ts -t buildFinanceSearchContext`
Expected: FAIL（`buildFinanceSearchContext` 未导出）

- [ ] **Step 3: 最小实现**

在 `src/lib/deep-research.ts`：

顶部 import 区加入（放在既有 `./anytxt-search` import 之后）：

```ts
import { isFinanceNamingEnabled, parseNormalizedFinanceName, type NormalizedFinanceName } from "./finance-naming"
```

（`isFinanceNamingEnabled` 供 Task 3 使用，此处一并引入。）

在 `MAX_RESEARCH_SOURCES` 常量之后插入：

```ts
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
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/lib/deep-research.test.ts`
Expected: 全部 PASS。注意此步 `isFinanceNamingEnabled` 已 import 但尚未使用，TypeScript `noUnusedLocals` 可能报错——若 `npm run typecheck` 失败，把该 import 拆到 Task 3 再加（本步只 import `parseNormalizedFinanceName` 与类型）。

- [ ] **Step 5: 提交**

```bash
git add src/lib/deep-research.ts src/lib/deep-research.test.ts
git commit -m "feat: deep-research 金融上下文构建（时间倒序+日期/标的标注）

Co-Authored-By: Hugo <shen.lan123@gmail.com>"
```

---

### Task 3: 接线 `executeResearch`（金融模式门控 + 提示词强化 + References 对齐）

**Files:**
- Modify: `src/lib/deep-research.ts`（`executeResearch` 内 Step 2 区域，约 220-305 行）

**Interfaces:**
- Consumes: Task 2 的 `buildFinanceSearchContext` / `FINANCE_TIME_DIRECTIVES`；`isFinanceNamingEnabled`（Task 2 已 import 或本任务补上）。
- Produces: 无新导出；行为变化仅限金融模式项目。

- [ ] **Step 1: 改写上下文构建与提示词**

将 `executeResearch` 中的这段：

```ts
    const searchContext = webResults
      .map((r, i) => `[${i + 1}] **${r.title}** (${r.source})\n${r.snippet}`)
      .join("\n\n")
```

替换为：

```ts
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
```

删除下方原有的 `const today = currentWikiDate()` 行（已上移）。

系统提示词 Time Sensitivity 段的最后一行之后插入金融指令（数组元素级追加）：

```ts
      "- Explicitly flag data points that are older than ~6 months or undated as potentially stale (数据时效存疑) instead of presenting them as current facts.",
      ...(financeMode ? [FINANCE_TIME_DIRECTIVES] : []),
```

References 一节改用重排后的结果，保证 `[N]` 编号一致：

```ts
    const references = orderedResults
      .map((r, i) => `${i + 1}. [${r.title}](${r.url}) — ${r.source}`)
      .join("\n")
```

- [ ] **Step 2: 类型检查与全量 mock 测试**

Run: `npm run typecheck && npm run test:mocks`
Expected: 均 PASS（非金融路径字节级不变，既有 deep-research 相关测试不受影响）

- [ ] **Step 3: 提交**

```bash
git add src/lib/deep-research.ts
git commit -m "feat: 金融模式 deep-research 注入时间排序上下文与时间脉络指令

仅 isFinanceNamingEnabled 项目生效；References 编号与上下文重排对齐。

Co-Authored-By: Hugo <shen.lan123@gmail.com>"
```

---

## 验收对照（spec → task）

| Spec 要求 | Task |
|---|---|
| `parseNormalizedFinanceName` 严格解析、null 不硬猜 | Task 1 |
| 排序（日期倒序本地 → 未解析本地 → web 原序）+ 编号重排 | Task 2 |
| 日期/距今/标的标注、>180 天「数据时效存疑」 | Task 2 |
| `isFinanceNamingEnabled` 门控、非金融零变化 | Task 3 |
| 金融版提示词小节（确定性日期可信、时间脉络组织） | Task 3 |
| References 与 `[N]` 一致 | Task 3 |
| 单测（解析/排序/标注/阈值） | Task 1、2 |
