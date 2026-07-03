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

  it("同一日志文件的并发追加串行化，不丢条目（读-改-写竞争）", async () => {
    // 模拟慢读+慢写：无串行化时第二次读发生在第一次写落盘前，
    // 双方基于同一份旧内容构造，后写覆盖先写（丢失更新）
    let stored = ""
    fsMock.readFile.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      if (!stored) throw new Error("ENOENT")
      return stored
    })
    fsMock.writeFile.mockImplementation(async (_path, content) => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      stored = content
    })

    await Promise.all([
      appendProjectLog("C:/proj", "deep-research", ["完成: 任务A"]),
      appendProjectLog("C:/proj", "deep-research", ["完成: 任务B"]),
    ])

    expect(stored).toContain("任务A")
    expect(stored).toContain("任务B")
  })

  it("文件不存在时从空开始；写失败不抛出", async () => {
    fsMock.readFile.mockRejectedValue(new Error("ENOENT"))
    await appendProjectLog("C:/proj", "ingest", ["硬失败: a.md"])
    expect(fsMock.writeFile.mock.calls[0][1]).toMatch(/^## .+ \| ingest\n\n1\. 硬失败: a\.md\n$/)

    fsMock.writeFile.mockRejectedValue(new Error("EACCES"))
    await expect(appendProjectLog("C:/proj", "ingest", ["x"])).resolves.toBeUndefined()
  })
})
