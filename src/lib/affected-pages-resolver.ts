/**
 * 审阅项 PAGES 引用的确定性解析器。
 *
 * LLM 在 REVIEW 块的 PAGES 行给出的页面引用不可靠：可能是确切路径、
 * 裸 slug、frontmatter 标题，甚至是对中文文件名的英文转写（臆造）。
 * 本模块在写入 review-store 之前把每个引用解析为真实存在的 wiki
 * 相对路径；无法解析的引用被丢弃并上报为 ingest 警告——保证持久化的
 * affectedPages 永远指向真实页面，下游（来源并集/related/级联删除）
 * 不再消费脏引用。
 */
import { listDirectory, readFile } from "@/commands/fs"
import { getFileStem, normalizePath } from "@/lib/path-utils"
import { unwrapWikilink } from "@/lib/wiki-page-resolver"
import type { FileNode } from "@/types/wiki"

export interface PageIndexEntry {
  /** 规范的 wiki 相对路径，如 `wiki/concepts/foo.md` */
  relativePath: string
  /** frontmatter title；缺失时为 null */
  title: string | null
}

export interface PageResolutionIndex {
  byPath: Map<string, string>
  byStem: Map<string, string>
  byTitle: Map<string, string>
}

/**
 * 模糊匹配键：NFKC 统一全角/半角与兼容字形（同时覆盖 NFC/NFD 差异），
 * 再小写。仅用于解析查找，不改变存储值本身。
 */
function pageKey(value: string): string {
  return value.normalize("NFKC").toLowerCase().trim()
}

/**
 * 由页面清单构建解析索引（纯函数，供测试直接使用）。
 *
 * :param entries: 页面清单（相对路径 + frontmatter 标题）
 * :returns: 路径/文件名主干/标题三层查找索引
 */
export function buildPageResolutionIndex(entries: PageIndexEntry[]): PageResolutionIndex {
  const byPath = new Map<string, string>()
  const byStem = new Map<string, string>()
  const byTitle = new Map<string, string>()
  for (const entry of entries) {
    const canonical = entry.relativePath
    byPath.set(pageKey(canonical), canonical)
    // 先入者优先：重名 stem/title 保留第一个，歧义引用宁可解析到稳定目标
    const stemKey = pageKey(getFileStem(canonical))
    if (!byStem.has(stemKey)) byStem.set(stemKey, canonical)
    if (entry.title) {
      const titleKey = pageKey(entry.title)
      if (!byTitle.has(titleKey)) byTitle.set(titleKey, canonical)
    }
  }
  return { byPath, byStem, byTitle }
}

/**
 * 把 PAGES 引用列表解析为真实存在的页面路径。
 *
 * 解析顺序：剥 wikilink → 精确路径（含补 wiki/ 前缀、补 .md 后缀的
 * 变体）→ 文件名主干 → frontmatter 标题；全部落空则计入 dropped。
 *
 * :param refs: LLM 给出的原始引用列表
 * :param index: buildPageResolutionIndex 产出的索引
 * :returns: resolved（去重的规范路径，保持原顺序）与 dropped（无法解析的原始引用）
 */
export function resolveAffectedPages(
  refs: string[],
  index: PageResolutionIndex,
): { resolved: string[]; dropped: string[] } {
  const resolved: string[] = []
  const dropped: string[] = []
  const seen = new Set<string>()

  for (const raw of refs) {
    const candidate = unwrapWikilink(raw.trim()).slug.trim()
    if (candidate.length === 0) continue

    const target = lookupCandidate(candidate, index)
    if (target === null) {
      dropped.push(raw)
      continue
    }
    if (!seen.has(target)) {
      seen.add(target)
      resolved.push(target)
    }
  }

  return { resolved, dropped }
}

function lookupCandidate(candidate: string, index: PageResolutionIndex): string | null {
  const normalized = candidate.replace(/^\.\//, "")
  const withMd = normalized.endsWith(".md") ? normalized : `${normalized}.md`
  const pathVariants = [normalized, withMd, `wiki/${normalized}`, `wiki/${withMd}`]
  for (const variant of pathVariants) {
    const hit = index.byPath.get(pageKey(variant))
    if (hit) return hit
  }
  const stemHit = index.byStem.get(pageKey(getFileStem(normalized)))
  if (stemHit) return stemHit
  const titleHit = index.byTitle.get(pageKey(normalized.replace(/\.md$/i, "")))
  if (titleHit) return titleHit
  return null
}

/** 递归收集 wiki 树下全部 .md 文件节点。 */
function flattenMdFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) files.push(...flattenMdFiles(node.children))
    else if (!node.is_dir && node.name.toLowerCase().endsWith(".md")) files.push(node)
  }
  return files
}

const TITLE_RE = /^---\n[\s\S]*?^title:\s*["']?(.+?)["']?\s*$/m

/**
 * 扫描项目 wiki 目录构建解析索引（IO 包装）。
 *
 * :param projectPath: 项目根路径
 * :returns: 解析索引；wiki 目录缺失或不可读时返回空索引
 */
export async function buildPageResolutionIndexFromDisk(
  projectPath: string,
): Promise<PageResolutionIndex> {
  const pp = normalizePath(projectPath)
  const entries: PageIndexEntry[] = []
  try {
    const tree = await listDirectory(`${pp}/wiki`)
    for (const file of flattenMdFiles(tree)) {
      const relativePath = normalizePath(file.path).startsWith(`${pp}/`)
        ? normalizePath(file.path).slice(pp.length + 1)
        : `wiki/${file.name}`
      let title: string | null = null
      try {
        title = readFileTitle(await readFile(file.path))
      } catch {
        // 单页不可读不影响整体索引
      }
      entries.push({ relativePath, title })
    }
  } catch {
    // wiki 目录尚不存在：返回空索引，调用方将把全部引用计入 dropped
  }
  return buildPageResolutionIndex(entries)
}

function readFileTitle(content: string): string | null {
  const match = content.match(TITLE_RE)
  return match ? match[1].trim() : null
}
