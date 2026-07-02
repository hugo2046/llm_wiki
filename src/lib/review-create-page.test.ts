import { describe, expect, it } from "vitest"
import type { ReviewItem } from "@/stores/review-store"
import { buildReviewPageContent, createReviewPageDrafts } from "./review-create-page"

function review(overrides: Partial<ReviewItem>): ReviewItem {
  return {
    id: "review-1",
    type: "missing-page",
    title: "Missing page",
    description: "",
    options: [],
    resolved: false,
    createdAt: 0,
    ...overrides,
  }
}

describe("createReviewPageDrafts", () => {
  it("creates one entity page per missing entity named in Chinese review text", () => {
    const drafts = createReviewPageDrafts(
      review({
        title: "核心测试项实体页缺失：CallMethod、StartFunc、Print",
        description: "缺少 CallMethod、StartFunc、Print 等实体页面。",
      }),
      "Create Page",
    )

    expect(drafts).toEqual([
      { title: "CallMethod", pageType: "entity", dir: "entities" },
      { title: "StartFunc", pageType: "entity", dir: "entities" },
      { title: "Print", pageType: "entity", dir: "entities" },
    ])
  })

  it("keeps non-missing review creation as a single query page", () => {
    const drafts = createReviewPageDrafts(
      review({
        type: "suggestion",
        title: "Create: Policy version gap",
        description: "Review the policy changes.",
      }),
      "Create Page",
    )

    expect(drafts).toEqual([
      { title: "Policy version gap", pageType: "query", dir: "queries" },
    ])
  })
})

describe("buildReviewPageContent", () => {
  const draft = { title: "鲁巴亚矿区复产时间矛盾", pageType: "query" as const, dir: "queries" }

  it("writes sources from the review item's source identity", () => {
    const content = buildReviewPageContent(
      draft,
      review({ type: "contradiction", title: "鲁巴亚矿区复产时间矛盾", description: "两处复产时间相差一年。" }),
      "2026-07-02",
      ["20260630-稀美资源-小范围交流.docx"],
    )

    expect(content).toContain('sources: ["20260630-稀美资源-小范围交流.docx"]')
    expect(content).toContain("type: query")
    expect(content).toContain('title: "鲁巴亚矿区复产时间矛盾"')
    expect(content).toContain("# 鲁巴亚矿区复产时间矛盾\n\n两处复产时间相差一年。")
  })

  it("writes multiple deduped source identities so cross-source contradictions stay verifiable", () => {
    const content = buildReviewPageContent(
      draft,
      review({}),
      "2026-07-02",
      ["a-纪要.docx", "b-周报.md", "a-纪要.docx"],
    )

    expect(content).toContain('sources: ["a-纪要.docx", "b-周报.md"]')
  })

  it("fills related with slugs derived from affectedPages", () => {
    const content = buildReviewPageContent(
      draft,
      review({
        affectedPages: ["wiki/sources/20260630-稀美资源-小范围交流-updated.md", "wiki/entities/稀美资源.md"],
      }),
      "2026-07-02",
      [],
    )

    expect(content).toContain('related: ["20260630-稀美资源-小范围交流-updated", "稀美资源"]')
  })

  it("dedupes related slugs and unwraps wikilink-shaped entries", () => {
    const content = buildReviewPageContent(
      draft,
      review({
        affectedPages: ["wiki/entities/foo.md", "wiki/sources/foo.md", "[[rubin-dram-reduction]]"],
      }),
      "2026-07-02",
      [],
    )

    expect(content).toContain('related: ["foo", "rubin-dram-reduction"]')
  })

  it("omits sources line and keeps empty related when nothing is known", () => {
    const content = buildReviewPageContent(draft, review({}), "2026-07-02", [])

    expect(content).not.toContain("sources:")
    expect(content).toContain("related: []")
  })

  it("escapes double quotes in the title", () => {
    const content = buildReviewPageContent(
      { ...draft, title: 'He said "no"' },
      review({}),
      "2026-07-02",
      [],
    )

    expect(content).toContain('title: "He said \\"no\\""')
  })

  it("escapes backslashes so YAML double-quoted scalars stay valid", () => {
    const content = buildReviewPageContent(
      { ...draft, title: "C:\\temp 报告\\" },
      review({}),
      "2026-07-02",
      ["dir\\file.docx"],
    )

    expect(content).toContain('title: "C:\\\\temp 报告\\\\"')
    expect(content).toContain('sources: ["dir\\\\file.docx"]')
  })
})

