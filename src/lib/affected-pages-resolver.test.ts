import { describe, expect, it } from "vitest"
import {
  buildPageResolutionIndex,
  formatWikiPageInventory,
  resolveAffectedPages,
} from "./affected-pages-resolver"

const index = buildPageResolutionIndex([
  { relativePath: "wiki/concepts/非晶纳米晶材料.md", title: "非晶/纳米晶材料" },
  { relativePath: "wiki/findings/悦安新材非晶粉体即将进入小批量量产.md", title: "悦安新材非晶粉体即将进入小批量量产，AI场景方案成头部客户主流选择" },
  { relativePath: "wiki/entities/openai.md", title: "OpenAI" },
  { relativePath: "wiki/sources/wei-2022-cot.md", title: "Source: wei-2022-cot.pdf" },
])

describe("resolveAffectedPages", () => {
  it("keeps exact relative paths verbatim", () => {
    const { resolved, dropped } = resolveAffectedPages(
      ["wiki/concepts/非晶纳米晶材料.md"],
      index,
    )
    expect(resolved).toEqual(["wiki/concepts/非晶纳米晶材料.md"])
    expect(dropped).toEqual([])
  })

  it("resolves bare stems and missing wiki/ prefix to the canonical path", () => {
    const { resolved } = resolveAffectedPages(
      ["openai", "concepts/非晶纳米晶材料.md"],
      index,
    )
    expect(resolved).toEqual([
      "wiki/entities/openai.md",
      "wiki/concepts/非晶纳米晶材料.md",
    ])
  })

  it("resolves frontmatter titles (case/width-insensitive) to the canonical path", () => {
    const { resolved } = resolveAffectedPages(
      ["非晶/纳米晶材料", "OPENAI"],
      index,
    )
    expect(resolved).toEqual([
      "wiki/concepts/非晶纳米晶材料.md",
      "wiki/entities/openai.md",
    ])
  })

  it("unwraps wikilink-shaped references before resolving", () => {
    const { resolved } = resolveAffectedPages(["[[openai|OpenAI 公司]]"], index)
    expect(resolved).toEqual(["wiki/entities/openai.md"])
  })

  it("matches across NFC/NFD unicode normal forms", () => {
    const nfdIndex = buildPageResolutionIndex([
      { relativePath: `wiki/entities/café.md`.normalize("NFD"), title: "café" },
    ])
    const { resolved } = resolveAffectedPages(["wiki/entities/café.md".normalize("NFC")], nfdIndex)
    expect(resolved.length).toBe(1)
  })

  it("drops unresolvable references and reports them", () => {
    const { resolved, dropped } = resolveAffectedPages(
      ["wiki/concepts/amorphous-nanocrystalline-material.md", "openai"],
      index,
    )
    expect(resolved).toEqual(["wiki/entities/openai.md"])
    expect(dropped).toEqual(["wiki/concepts/amorphous-nanocrystalline-material.md"])
  })

  it("dedupes references that resolve to the same page", () => {
    const { resolved } = resolveAffectedPages(
      ["openai", "wiki/entities/openai.md", "OpenAI"],
      index,
    )
    expect(resolved).toEqual(["wiki/entities/openai.md"])
  })
})

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

  it("字符预算触发截断（条数未满也截）", () => {
    const paths = Array.from({ length: 10 }, (_, i) => `wiki/entities/很长的中文实体页面名称示例-${i}.md`)
    const lineLength = `- ${paths[0]}\n`.length
    const out = formatWikiPageInventory(paths, 500, lineLength * 3)
    expect(out.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(3)
    expect(out).toContain("（清单已截断，共 10 页）")
  })

  it("空清单返回空串", () => {
    expect(formatWikiPageInventory([])).toBe("")
  })
})
