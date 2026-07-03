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
