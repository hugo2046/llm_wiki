import { beforeEach, describe, expect, it, vi } from "vitest"

const fsMocks = vi.hoisted(() => ({
  createDirectory: vi.fn(),
  fileExists: vi.fn(),
  writeFile: vi.fn(),
}))

vi.mock("@/commands/fs", () => fsMocks)

import {
  appendWikilink,
  ensureBrokenLinkStub,
  isDeletableLintStub,
  LINT_STUB_SENTINEL,
  rewriteWikilinkTarget,
  stubRelativePathFromBrokenTarget,
} from "./lint-fixes"

beforeEach(() => {
  fsMocks.createDirectory.mockReset()
  fsMocks.fileExists.mockReset()
  fsMocks.writeFile.mockReset()
})

describe("rewriteWikilinkTarget", () => {
  it("rewrites a matching wikilink and preserves aliases", () => {
    const out = rewriteWikilinkTarget(
      "See [[transfomer|the Transformer page]] and [[attention]].",
      "transfomer",
      "entities/transformer.md",
    )

    expect(out).toBe("See [[entities/transformer|the Transformer page]] and [[attention]].")
  })

  it("leaves non-matching wikilinks byte-identical", () => {
    const input = "See [[attention|Attention]] only."
    expect(rewriteWikilinkTarget(input, "transformer", "entities/transformer.md")).toBe(input)
  })
})

describe("appendWikilink", () => {
  it("does not duplicate an existing aliased wikilink", () => {
    const input = "See [[entities/transformer|Transformer]]."
    expect(appendWikilink(input, "entities/transformer.md")).toBe(input)
  })

  it("appends a related section when the target is absent", () => {
    expect(appendWikilink("# Page\nBody", "entities/transformer.md")).toBe(
      "# Page\nBody\n\n## Related\n- [[entities/transformer]]\n",
    )
  })

  it("adds to an existing related section without duplicating the heading", () => {
    const out = appendWikilink(
      "# Page\n\n## Related\n- [[entities/attention]]\n",
      "entities/transformer.md",
    )

    expect(out.match(/^## Related$/gm)).toHaveLength(1)
    expect(out).toContain("## Related\n- [[entities/transformer]]\n- [[entities/attention]]")
  })
})

describe("ensureBrokenLinkStub", () => {
  it("reuses an existing slugified target instead of overwriting it", async () => {
    fsMocks.fileExists.mockResolvedValue(true)

    const result = await ensureBrokenLinkStub("/project", "Foo Bar")

    expect(result).toEqual({
      fullPath: "/project/wiki/queries/foo-bar.md",
      relativePath: "queries/foo-bar.md",
      created: false,
    })
    expect(fsMocks.writeFile).not.toHaveBeenCalled()
  })

  it("creates a safe stub path when no target exists", async () => {
    fsMocks.fileExists.mockResolvedValue(false)

    const result = await ensureBrokenLinkStub("/project", "Foo Bar")

    expect(result.relativePath).toBe("queries/foo-bar.md")
    expect(fsMocks.createDirectory).toHaveBeenCalledWith("/project/wiki/queries")
    expect(fsMocks.writeFile).toHaveBeenCalledWith(
      "/project/wiki/queries/foo-bar.md",
      expect.stringContaining("title: \"Foo Bar\""),
    )
  })

  it("keeps explicit wiki subdirectories when building stub paths", () => {
    expect(stubRelativePathFromBrokenTarget("concepts/Foo Bar")).toBe("concepts/foo-bar.md")
  })
})

describe("isDeletableLintStub", () => {
  // A stub as freshly written by ensureBrokenLinkStub: tags + sentinel,
  // no other body.
  function stub(body: string, tags = "[stub, lint]"): string {
    return [
      "---",
      "type: query",
      'title: "Foo"',
      `tags: ${tags}`,
      "related: []",
      "sources: []",
      "---",
      "",
      "# Foo",
      "",
      LINT_STUB_SENTINEL,
      body,
    ].join("\n")
  }

  it("deletes a pure-sentinel stub", () => {
    expect(isDeletableLintStub(stub(""))).toBe(true)
  })

  it("deletes a stub carrying only an auto-generated Related wikilink list", () => {
    const body = "\n## Related\n- [[queries/foo]]\n- [[queries/bar]]\n"
    expect(isDeletableLintStub(stub(body))).toBe(true)
  })

  it("deletes a stub whose Related list holds bare-slug residue from prior deletes", () => {
    // `stripDeletedWikilinks` degrades dead `[[queries/ansaldo]]` to plain
    // `queries/ansaldo`; that residue must not block deletion.
    const body = "\n## Related\n- [[queries/foo]]\n- queries/ansaldo\n"
    expect(isDeletableLintStub(stub(body))).toBe(true)
  })

  it("keeps a stub-tagged page that gained human prose", () => {
    const body = "\n## 背景\n这是用户后来补写的真实分析。\n"
    expect(isDeletableLintStub(stub(body))).toBe(false)
  })

  it("keeps a page whose Related item is a free-text note, not a link", () => {
    const body = "\n## Related\n- 记得核对这个供应商的产能\n"
    expect(isDeletableLintStub(stub(body))).toBe(false)
  })

  it("keeps a page missing the stub/lint tags even if the sentinel is present", () => {
    expect(isDeletableLintStub(stub("", "[天然铀, 价格催化]"))).toBe(false)
  })

  it("keeps a tagged page that no longer contains the sentinel", () => {
    const content = [
      "---",
      "tags: [stub, lint]",
      "---",
      "",
      "# Foo",
      "",
      "Real content now.",
    ].join("\n")
    expect(isDeletableLintStub(content)).toBe(false)
  })

  it("returns false (conservative) for a CRLF file the frontmatter parser can't read", () => {
    const content = stub("").replace(/\n/g, "\r\n")
    expect(isDeletableLintStub(content)).toBe(false)
  })

  it("returns false when there is no frontmatter at all", () => {
    expect(isDeletableLintStub(`# Foo\n\n${LINT_STUB_SENTINEL}\n`)).toBe(false)
  })
})
