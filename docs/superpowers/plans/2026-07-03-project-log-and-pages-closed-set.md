# 项目级运行日志 + 审阅 PAGES 闭集约束 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ① 关键运行事件落盘到项目 `.llm-wiki/app.log`（带轮转）；② 审阅 REVIEW 块的 PAGES 引用受真实页面闭集约束（生成端注入清单，校验端零改动）。

**Architecture:** Part 1 泛化 `appendIngestWarningLog` 已验证的模式为新模块 `project-log.ts`（纯函数格式化/轮转 + IO 包装），在 deep-research/ingest/金融导入三处错误与收尾分支各加一行调用。Part 2 在 `affected-pages-resolver.ts` 增加清单构建纯函数，`ingest.ts` 两个提示词构建器加可选 `pageInventory` 参数并改写 PAGES 指令为闭集形式；resolver 与 drop 行为完全不动。

**Tech Stack:** TypeScript、Vitest（`@/commands/fs` 用 `vi.mock` 模拟）。

**Spec:** `docs/superpowers/specs/2026-07-03-project-log-and-pages-closed-set-design.md`

## Global Constraints

- 日志条目格式与 ingest-warnings 一致：`## <ISO时间> | <scope>`、编号行、空行分隔；`lines` 为空直接返回；所有 IO 错误吞掉并 `console.warn`，绝不抛出。
- 轮转阈值：现有内容 > 512KB（`MAX_LOG_BYTES = 512 * 1024`）时按条目边界截留尾部 ≤ 256KB（`KEEP_LOG_BYTES = 256 * 1024`），文件头加 `（日志已轮转，早期条目被截断）`。
- `ingest-warnings.log` 保留现状不动；Rust 侧不改。
- 清单上限 500 条，超限优先保留 `entities/`、`concepts/`、`findings/`、`thesis/`，末尾注明 `（清单已截断，共 N 页）`。
- 校验端（`createPageResolver`/`resolveAffectedPages`/drop 警告）零改动、零模糊匹配。
- 空 wiki（清单为空串）：省略清单段，指令退化为"只允许本响应 FILE 块路径"。
- 注释中文、公共函数 Sphinx docstring；提交信息 Conventional Commits + `Co-Authored-By: Hugo <shen.lan123@gmail.com>`。

---

### Task 1: `src/lib/project-log.ts`（通用项目日志）

**Files:**
- Create: `src/lib/project-log.ts`
- Create: `src/lib/project-log.test.ts`

**Interfaces:**
- Consumes: `readFile, writeFile, createDirectory` from `@/commands/fs`；`normalizePath` from `@/lib/path-utils`。
- Produces（Task 2 依赖）:
  ```ts
  export function formatProjectLogEntry(scope: string, lines: readonly string[], now?: Date): string
  export function trimProjectLog(content: string, maxBytes?: number, keepBytes?: number): string
  export async function appendProjectLog(projectPath: string, scope: string, lines: readonly string[]): Promise<void>
  ```

- [ ] **Step 1: 写失败测试**

创建 `src/lib/project-log.test.ts`：

```ts
import { beforeEach, describe, expect, it, vi } from "vitest"

const fsMock = vi.hoisted(() => ({
  readFile: vi.fn<(path: string) => Promise<string>>(),
  writeFile: vi.fn<(path: string, content: string) => Promise<void>>(),
  createDirectory: vi.fn<(path: string) => Promise<void>>(),
}))
vi.mock("@/commands/fs", () => fsMock)

import { appendProjectLog, formatProjectLogEntry, trimProjectLog } from "./project-log"

beforeEach(() => {
  fsMock.readFile.mockReset()
  fsMock.writeFile.mockReset().mockResolvedValue(undefined)
  fsMock.createDirectory.mockReset().mockResolvedValue(undefined)
})

describe("formatProjectLogEntry", () => {
  it("生成 ISO 时间头与编号行", () => {
    const now = new Date("2026-07-03T02:00:00.000Z")
    expect(formatProjectLogEntry("deep-research", ["失败: 主题X", "AnyTXT offline"], now)).toBe(
      "## 2026-07-03T02:00:00.000Z | deep-research\n\n1. 失败: 主题X\n2. AnyTXT offline\n",
    )
  })
})

describe("trimProjectLog", () => {
  const entry = (n: number) => `## 2026-07-03T0${n}:00:00.000Z | test\n\n1. line-${n}`

  it("未超限时原样返回", () => {
    const content = [entry(1), entry(2)].join("\n\n")
    expect(trimProjectLog(content, 1024, 512)).toBe(content)
  })

  it("超限时按条目边界截尾并加轮转标记", () => {
    const entries = Array.from({ length: 10 }, (_, i) => entry(i))
    const content = entries.join("\n\n")
    const budget = new TextEncoder().encode([entry(8), entry(9)].join("\n\n")).byteLength + 4
    const trimmed = trimProjectLog(content, 64, budget)
    expect(trimmed.startsWith("（日志已轮转，早期条目被截断）")).toBe(true)
    expect(trimmed).toContain("line-9")
    expect(trimmed).not.toContain("line-0")
    // 保留的条目头完整（边界未被腰斩）
    expect(trimmed).toContain("## 2026-07-03T09:00:00.000Z | test")
  })

  it("至少保留最后一个条目", () => {
    const content = [entry(1), entry(2)].join("\n\n")
    const trimmed = trimProjectLog(content, 1, 1)
    expect(trimmed).toContain("line-2")
    expect(trimmed).not.toContain("line-1")
  })
})

describe("appendProjectLog", () => {
  it("追加到已有内容之后（空行分隔）", async () => {
    fsMock.readFile.mockResolvedValue("## old | x\n\n1. old-line\n")
    await appendProjectLog("C:/proj", "mcp", ["调用失败"])
    expect(fsMock.createDirectory).toHaveBeenCalledWith("C:/proj/.llm-wiki")
    const [path, content] = fsMock.writeFile.mock.calls[0]
    expect(path).toBe("C:/proj/.llm-wiki/app.log")
    expect(content).toMatch(/^## old \| x\n\n1\. old-line\n\n## .+ \| mcp\n\n1\. 调用失败\n$/)
  })

  it("lines 为空直接返回，不做任何 IO", async () => {
    await appendProjectLog("C:/proj", "mcp", [])
    expect(fsMock.writeFile).not.toHaveBeenCalled()
  })

  it("文件不存在时从空开始；写失败不抛出", async () => {
    fsMock.readFile.mockRejectedValue(new Error("ENOENT"))
    await appendProjectLog("C:/proj", "ingest", ["硬失败: a.md"])
    expect(fsMock.writeFile.mock.calls[0][1]).toMatch(/^## .+ \| ingest\n\n1\. 硬失败: a\.md\n$/)

    fsMock.writeFile.mockRejectedValue(new Error("EACCES"))
    await expect(appendProjectLog("C:/proj", "ingest", ["x"])).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/lib/project-log.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/lib/project-log.ts`**

```ts
/**
 * 通用项目日志：关键运行事件追加写到项目 `.llm-wiki/app.log`。
 *
 * 泛化自 ingest-warnings.log 的既有模式（追加式、条目化、吞错）；
 * 额外提供体积轮转保护。纯函数（格式化/截尾）与 IO 包装分离。
 */
import { createDirectory, readFile, writeFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"

const MAX_LOG_BYTES = 512 * 1024
const KEEP_LOG_BYTES = 256 * 1024
const ROTATION_NOTICE = "（日志已轮转，早期条目被截断）"

function byteSize(text: string): number {
  return new TextEncoder().encode(text).byteLength
}

/**
 * 格式化一个日志条目：ISO 时间 + scope 头，编号正文行。
 *
 * :param scope: 事件域，如 "deep-research" / "ingest" / "finance-import"
 * :param lines: 正文行（调用方保证非空）
 * :param now: 时间注入点（测试用）
 * :returns: 条目文本（尾部单换行）
 */
export function formatProjectLogEntry(
  scope: string,
  lines: readonly string[],
  now: Date = new Date(),
): string {
  const numbered = lines.map((line, i) => `${i + 1}. ${line}`)
  return `## ${now.toISOString()} | ${scope}\n\n${numbered.join("\n")}\n`
}

/**
 * 超限时按条目边界截留尾部：内容 > maxBytes 则丢弃最早条目直到
 * ≤ keepBytes，并在头部加轮转标记；至少保留最后一个条目。
 *
 * :param content: 日志全文
 * :param maxBytes: 触发阈值（默认 512KB）
 * :param keepBytes: 截留预算（默认 256KB）
 * :returns: 原文或截尾后的文本
 */
export function trimProjectLog(
  content: string,
  maxBytes: number = MAX_LOG_BYTES,
  keepBytes: number = KEEP_LOG_BYTES,
): string {
  if (byteSize(content) <= maxBytes) return content
  const entries = content.split(/\n\n(?=## )/)
  const sizes = entries.map(byteSize)
  // 分隔符 "\n\n" 计 2 字节
  let total = sizes.reduce((sum, s) => sum + s, 0) + (entries.length - 1) * 2
  let start = 0
  while (entries.length - start > 1 && total > keepBytes) {
    total -= sizes[start] + 2
    start++
  }
  return `${ROTATION_NOTICE}\n\n${entries.slice(start).join("\n\n")}`
}

/**
 * 追加一批日志行到项目 `.llm-wiki/app.log`；任何失败只 console.warn。
 *
 * :param projectPath: 项目根路径
 * :param scope: 事件域
 * :param lines: 正文行；为空直接返回
 */
export async function appendProjectLog(
  projectPath: string,
  scope: string,
  lines: readonly string[],
): Promise<void> {
  if (lines.length === 0) return
  const pp = normalizePath(projectPath)
  const logPath = `${pp}/.llm-wiki/app.log`
  try {
    await createDirectory(`${pp}/.llm-wiki`)
    let existing = ""
    try {
      existing = await readFile(logPath)
    } catch {
      // 首次写入
    }
    const combined = `${existing.trimEnd()}${existing.trim() ? "\n\n" : ""}${formatProjectLogEntry(scope, lines).trimEnd()}\n`
    await writeFile(logPath, trimProjectLog(combined))
  } catch (err) {
    console.warn(
      `[project-log] Failed to append (${scope}):`,
      err instanceof Error ? err.message : err,
    )
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/lib/project-log.test.ts && npm run typecheck`
Expected: 全部 PASS，typecheck 干净

- [ ] **Step 5: 提交**

```bash
git add src/lib/project-log.ts src/lib/project-log.test.ts
git commit -m "feat: 新增通用项目日志模块 project-log（追加式+轮转）

Co-Authored-By: Hugo <shen.lan123@gmail.com>"
```

---

### Task 2: 日志接线（deep-research / ingest / 金融导入）

**Files:**
- Modify: `src/lib/deep-research.ts`（`executeResearch` 收尾与错误分支）
- Modify: `src/lib/ingest.ts`（hardFailures 分支，约 :1303）
- Modify: `src/lib/source-lifecycle.ts`（两处 `appendRenameMap(pp, renameRecords)` 之后，约 :226 与 :310）

**Interfaces:**
- Consumes: Task 1 的 `appendProjectLog(projectPath, scope, lines)`。
- Produces: 无新导出；行为仅增加日志副作用（`void` 调用，不影响主流程）。

- [ ] **Step 1: 接线（无新单测——appendProjectLog 自身已测；本任务验证靠 typecheck + 全量回归）**

三个文件各自顶部 import：

```ts
import { appendProjectLog } from "./project-log"
```

（source-lifecycle.ts 若使用 `@/lib/` 别名风格则写 `from "@/lib/project-log"`，与该文件既有 import 风格一致。）

**deep-research.ts**——`executeResearch` 中三处：

① 零来源提前返回分支（`webResults.length === 0` 内，`onTaskFinished` 之前）：

```ts
      void appendProjectLog(pp, "deep-research", [
        `零来源结束: ${topic}`,
        ...sourceErrors,
      ])
```

② 保存成功后（`status: "done"` 的 `updateTaskIfActive` 调用成功之后、`refreshProjectFileTree` 之前）：

```ts
    void appendProjectLog(pp, "deep-research", [
      `完成: ${topic}`,
      `来源 ${orderedResults.length} 条，保存 ${savedPath}`,
      ...sourceErrors.map((e) => `部分来源失败: ${e}`),
    ])
```

③ 最外层 catch 块（`updateTaskIfActive(..., { status: "error", ... })` 之后）：

```ts
    void appendProjectLog(pp, "deep-research", [`失败: ${topic}`, message])
```

**ingest.ts**——`else if (hardFailures.length > 0)` 分支（现有 `console.warn` 之后）：

```ts
    void appendProjectLog(pp, "ingest", [
      `${sourceIdentity}: ${hardFailures.length} 个块写入失败（本次结果未入缓存）`,
      ...hardFailures,
    ])
```

**source-lifecycle.ts**——两处 `await appendRenameMap(pp, renameRecords)` 之后各加：

```ts
  if (renameRecords.length > 0) {
    const naCount = renameRecords.filter((r) => !r.tsCode).length
    void appendProjectLog(pp, "finance-import", [
      `本批规范化 ${renameRecords.length} 个文件，未匹配标的(NA) ${naCount} 个`,
    ])
  }
```

- [ ] **Step 2: 验证**

Run: `npm run typecheck && npm run test:mocks`
Expected: 均 PASS（接线为 `void` 副作用调用，不改变任何既有断言路径）

- [ ] **Step 3: 提交**

```bash
git add src/lib/deep-research.ts src/lib/ingest.ts src/lib/source-lifecycle.ts
git commit -m "feat: deep-research/ingest/金融导入关键事件写入项目日志 app.log

Co-Authored-By: Hugo <shen.lan123@gmail.com>"
```

---

### Task 3: `buildWikiPageInventory`（真实页面清单构建）

**Files:**
- Modify: `src/lib/affected-pages-resolver.ts`（文件末尾追加）
- Test: `src/lib/affected-pages-resolver.test.ts`

**Interfaces:**
- Consumes: 模块内已有 `flattenMdFiles`、`listDirectory`、`getRelativePath`、`normalizePath`。
- Produces（Task 4 依赖）:
  ```ts
  export function formatWikiPageInventory(relativePaths: string[], limit?: number): string
  export async function buildWikiPageInventory(projectPath: string): Promise<string>
  ```

- [ ] **Step 1: 写失败测试**

在 `src/lib/affected-pages-resolver.test.ts` 顶部 import 中加入 `formatWikiPageInventory`，文件末尾追加：

```ts
describe("formatWikiPageInventory", () => {
  it("按优先目录排序并每行一条", () => {
    const out = formatWikiPageInventory([
      "wiki/queries/q1.md",
      "wiki/entities/安泰科技-000969sz.md",
      "wiki/concepts/大钨管.md",
      "wiki/findings/f1.md",
      "wiki/thesis/t1.md",
    ])
    const lines = out.split("\n")
    expect(lines[0]).toBe("- wiki/entities/安泰科技-000969sz.md")
    expect(lines[1]).toBe("- wiki/concepts/大钨管.md")
    expect(lines[2]).toBe("- wiki/findings/f1.md")
    expect(lines[3]).toBe("- wiki/thesis/t1.md")
    expect(lines[4]).toBe("- wiki/queries/q1.md")
  })

  it("超限截断并注明总数，优先目录先保留", () => {
    const paths = [
      ...Array.from({ length: 3 }, (_, i) => `wiki/queries/q${i}.md`),
      ...Array.from({ length: 3 }, (_, i) => `wiki/entities/e${i}.md`),
    ]
    const out = formatWikiPageInventory(paths, 4)
    expect(out).toContain("- wiki/entities/e0.md")
    expect(out).toContain("- wiki/entities/e2.md")
    expect(out).not.toContain("q2.md")
    expect(out).toContain("（清单已截断，共 6 页）")
  })

  it("空清单返回空串", () => {
    expect(formatWikiPageInventory([])).toBe("")
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/lib/affected-pages-resolver.test.ts -t formatWikiPageInventory`
Expected: FAIL（未导出）

- [ ] **Step 3: 实现（affected-pages-resolver.ts 末尾追加）**

```ts
/** 清单目录优先级：截断时先保留知识主体页，再保留其余目录。 */
const INVENTORY_PRIORITY = ["wiki/entities/", "wiki/concepts/", "wiki/findings/", "wiki/thesis/"]

function inventoryRank(relativePath: string): number {
  const hit = INVENTORY_PRIORITY.findIndex((prefix) => relativePath.startsWith(prefix))
  return hit >= 0 ? hit : INVENTORY_PRIORITY.length
}

/**
 * 把真实页面路径清单格式化为提示词注入文本（纯函数）。
 *
 * 按目录优先级（entities/concepts/findings/thesis 优先）+ 字典序排序，
 * 每行 `- <相对路径>`；超过 limit 截断并注明总数。
 *
 * :param relativePaths: wiki 相对路径列表
 * :param limit: 上限条数（默认 500）
 * :returns: 清单文本；空列表为空串
 */
export function formatWikiPageInventory(relativePaths: string[], limit = 500): string {
  if (relativePaths.length === 0) return ""
  const sorted = [...relativePaths].sort(
    (a, b) => inventoryRank(a) - inventoryRank(b) || a.localeCompare(b),
  )
  const kept = sorted.slice(0, limit)
  const lines = kept.map((p) => `- ${p}`)
  if (sorted.length > limit) lines.push(`（清单已截断，共 ${sorted.length} 页）`)
  return lines.join("\n")
}

/**
 * 从磁盘构建项目的真实页面路径清单（供 REVIEW 提示词闭集约束）。
 *
 * :param projectPath: 项目根路径
 * :returns: 清单文本；wiki 目录缺失或为空时为空串
 */
export async function buildWikiPageInventory(projectPath: string): Promise<string> {
  const pp = normalizePath(projectPath)
  try {
    const files = flattenMdFiles(await listDirectory(`${pp}/wiki`))
    const relativePaths = files.map((file) => {
      const relative = getRelativePath(file.path, pp)
      return relative.startsWith("wiki/") ? relative : `wiki/${file.name}`
    })
    return formatWikiPageInventory(relativePaths)
  } catch {
    return ""
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/lib/affected-pages-resolver.test.ts && npm run typecheck`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/affected-pages-resolver.ts src/lib/affected-pages-resolver.test.ts
git commit -m "feat: 新增真实页面清单构建（REVIEW PAGES 闭集约束数据源）

Co-Authored-By: Hugo <shen.lan123@gmail.com>"
```

---

### Task 4: 提示词闭集注入（两处 REVIEW 模板）

**Files:**
- Modify: `src/lib/ingest.ts`（`buildGenerationPrompt` :1996、`buildReviewSuggestionPrompt` :2167、`autoIngestImpl` 两个调用点 :1001/:1057）
- Test: `src/lib/ingest.prompt.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `buildWikiPageInventory`（`autoIngestImpl` 调用）。
- Produces: `buildGenerationPrompt(..., pageInventory?: string)` 末尾新增可选参数；`buildReviewSuggestionPrompt(..., pageInventory?: string)` 同。

- [ ] **Step 1: 写失败测试**

在 `src/lib/ingest.prompt.test.ts` 追加（import 沿用文件既有的 `buildGenerationPrompt`）：

```ts
describe("REVIEW PAGES 闭集约束", () => {
  const inventory = "- wiki/entities/安泰科技-000969sz.md\n- wiki/concepts/大钨管.md"

  it("注入清单段与闭集指令（generation prompt）", () => {
    const prompt = buildGenerationPrompt("", "", "", "s.pdf", undefined, "", undefined, inventory)
    expect(prompt).toContain("## Existing Wiki Pages")
    expect(prompt).toContain("- wiki/entities/安泰科技-000969sz.md")
    expect(prompt).toContain("chosen ONLY from the \"Existing Wiki Pages\" list")
    expect(prompt).toContain("or be the exact relative path of a FILE block you emit in THIS response")
    expect(prompt).not.toContain("exist in the CURRENT index above")
  })

  it("空清单省略清单段，指令退化为仅允许本响应 FILE 路径", () => {
    const prompt = buildGenerationPrompt("", "", "", "s.pdf")
    expect(prompt).not.toContain("## Existing Wiki Pages")
    expect(prompt).toContain("PAGES entries MUST be the exact relative path of a FILE block you emit in THIS response")
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/lib/ingest.prompt.test.ts -t 闭集`
Expected: FAIL

- [ ] **Step 3: 实现**

`buildGenerationPrompt` 签名末尾加参数：

```ts
export function buildGenerationPrompt(
  schema: string,
  purpose: string,
  index: string,
  sourceFileName: string,
  overview?: string,
  sourceContent: string = "",
  sourceSummaryPath?: string,
  pageInventory?: string,
): string {
```

其模板数组中，将原行：

```ts
    "PAGES: wiki/page1.md, wiki/page2.md",
    "PAGES entries MUST be exact relative paths of wiki pages that exist in the CURRENT index above (copy the path verbatim, including non-ASCII filenames). NEVER translate, transliterate, or invent slugs.",
```

替换为：

```ts
    "PAGES: wiki/page1.md, wiki/page2.md",
    ...(pageInventory
      ? [
          "PAGES entries MUST be chosen ONLY from the \"Existing Wiki Pages\" list below, or be the exact relative path of a FILE block you emit in THIS response. Anything else will be dropped. NEVER translate, transliterate, or invent slugs.",
          "",
          "## Existing Wiki Pages (closed set for PAGES)",
          pageInventory,
        ]
      : [
          "PAGES entries MUST be the exact relative path of a FILE block you emit in THIS response. Anything else will be dropped.",
        ]),
```

`buildReviewSuggestionPrompt` 同样在签名末尾加 `pageInventory?: string`，其模板中的对应两行（:2203 附近）做同一替换，但闭集指令措辞改为（该阶段不产 FILE 块，引用的是 generation 输出里的路径）：

```ts
    ...(pageInventory
      ? [
          "PAGES entries MUST be chosen ONLY from the \"Existing Wiki Pages\" list below, or be an exact FILE path present in the generation output above. Anything else will be dropped. NEVER translate, transliterate, or invent slugs.",
          "",
          "## Existing Wiki Pages (closed set for PAGES)",
          pageInventory,
        ]
      : [
          "PAGES entries MUST be an exact FILE path present in the generation output above. Anything else will be dropped.",
        ]),
```

`autoIngestImpl` 中，在 generation 的 `streamChat` 调用之前加：

```ts
  // REVIEW PAGES 闭集：注入磁盘真实页面清单，杜绝臆造 slug
  const pageInventory = await buildWikiPageInventory(pp)
```

两个调用点分别把 `pageInventory` 作为新的末位实参传入（generation :1001 与 review-suggestion :1057）。imports 区追加 `buildWikiPageInventory` 到既有的 `./affected-pages-resolver` import（若无则新建该行）。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/lib/ingest.prompt.test.ts src/lib/ingest-parse.test.ts src/lib/ingest.scenarios.test.ts && npm run typecheck && npm run test:mocks`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/ingest.ts src/lib/ingest.prompt.test.ts
git commit -m "feat: REVIEW PAGES 闭集约束——提示词注入真实页面清单

生成端只允许从磁盘清单或本响应 FILE 路径中选取 PAGES；
校验端 drop 行为不变（零模糊匹配，杜绝误联）。

Co-Authored-By: Hugo <shen.lan123@gmail.com>"
```

---

## 验收对照（spec → task）

| Spec 要求 | Task |
|---|---|
| `formatProjectLogEntry`/`trimProjectLog`/`appendProjectLog`（格式/轮转/吞错） | Task 1 |
| 接线：deep-research 完成/失败/零来源、ingest 硬失败、金融导入摘要 | Task 2 |
| `ingest-warnings.log` 不动、Rust 不动 | Task 2（不触碰） |
| `formatWikiPageInventory`/`buildWikiPageInventory`（优先级/截断/空 wiki） | Task 3 |
| 两处提示词闭集注入 + 指令改写 + 空清单退化 | Task 4 |
| 校验端零改动零模糊 | Task 4（不触碰 resolver） |
