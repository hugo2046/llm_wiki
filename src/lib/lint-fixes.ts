import { createDirectory, fileExists, writeFile } from "@/commands/fs"
import { getFileName, normalizePath } from "@/lib/path-utils"
import { makeQuerySlug } from "@/lib/wiki-filename"
import { parseFrontmatterArray } from "@/lib/sources-merge"

/**
 * The exact sentinel line `ensureBrokenLinkStub` writes into a freshly
 * created placeholder page. Shared by the generator and the detector
 * (`isDeletableLintStub`) so the two can never drift out of sync.
 */
export const LINT_STUB_SENTINEL =
  "Created by Wiki Lint as a placeholder for a missing wikilink target."

export function lintLinkTarget(target: string): string {
  return normalizePath(target)
    .replace(/^wiki\//i, "")
    .replace(/\.md$/i, "")
    .trim()
}

function normalizedLintLinkTarget(target: string): string {
  return lintLinkTarget(target).toLowerCase()
}

function hasWikilinkToTarget(content: string, target: string): boolean {
  const normalized = normalizedLintLinkTarget(target)
  return Array.from(content.matchAll(/\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g))
    .some((match) => normalizedLintLinkTarget(match[1]) === normalized)
}

export function appendWikilink(content: string, target: string): string {
  const linkTarget = lintLinkTarget(target)
  if (hasWikilinkToTarget(content, linkTarget)) return content
  const linkLine = `- [[${linkTarget}]]`
  const relatedHeading = /^##\s+Related\s*$/im.exec(content)
  if (relatedHeading) {
    const insertAt = relatedHeading.index + relatedHeading[0].length
    return `${content.slice(0, insertAt)}\n${linkLine}${content.slice(insertAt)}`
  }
  return `${content.trimEnd()}\n\n## Related\n${linkLine}\n`
}

export function rewriteWikilinkTarget(
  content: string,
  brokenTarget: string,
  suggestedTarget: string,
): string {
  const broken = normalizedLintLinkTarget(brokenTarget)
  const replacement = lintLinkTarget(suggestedTarget)
  return content.replace(
    /\[\[([^\]|]+?)(\|[^\]]+?)?\]\]/g,
    (match, rawTarget: string, rawAlias?: string) => {
      if (normalizedLintLinkTarget(rawTarget) !== broken) return match
      return `[[${replacement}${rawAlias ?? ""}]]`
    },
  )
}

export function stubRelativePathFromBrokenTarget(brokenTarget: string): string {
  const normalized = lintLinkTarget(brokenTarget)
  const parts = normalized
    .split("/")
    .map((part) => makeQuerySlug(part))
    .filter(Boolean)
  const rel = parts.length > 1
    ? parts.join("/")
    : `queries/${parts[0] ?? "missing-page"}`
  return `${rel}.md`
}

function stubTitleFromBrokenTarget(brokenTarget: string): string {
  return getFileName(lintLinkTarget(brokenTarget))
    .replace(/[-_]+/g, " ")
    .trim() || "Missing Page"
}

export async function ensureBrokenLinkStub(
  projectPath: string,
  brokenTarget: string,
): Promise<{ fullPath: string; relativePath: string; created: boolean }> {
  const relativePath = stubRelativePathFromBrokenTarget(brokenTarget)
  const fullPath = `${projectPath}/wiki/${relativePath}`
  if (await fileExists(fullPath)) {
    return { fullPath, relativePath, created: false }
  }

  const parent = fullPath.split("/").slice(0, -1).join("/")
  await createDirectory(parent)
  const title = stubTitleFromBrokenTarget(brokenTarget)
  const date = new Date().toISOString().slice(0, 10)
  const content = [
    "---",
    "type: query",
    `title: "${title.replace(/"/g, '\\"')}"`,
    `created: ${date}`,
    `updated: ${date}`,
    "tags: [stub, lint]",
    "related: []",
    "sources: []",
    "---",
    "",
    `# ${title}`,
    "",
    LINT_STUB_SENTINEL,
    "",
  ].join("\n")
  await writeFile(fullPath, content)
  return { fullPath, relativePath, created: true }
}

// A Related-list item that carries no human information: either a
// wikilink (`- [[queries/foo]]`) or a bare-slug residue left behind when
// `stripDeletedWikilinks` degraded a dead link (`- queries/ansaldo`). The
// `[\w./-]+` branch is deliberately ASCII-only so any free-text note
// (e.g. `- 记得核对产能`) fails to match and blocks deletion.
const RELATED_ITEM_RE = /^-\s+(\[\[[^\]]+\]\]|[\w./-]+)\s*$/

/**
 * Decide whether a wiki page is a Wiki-Lint placeholder safe to delete:
 * a page that carries the `stub`+`lint` tags and the sentinel line, and
 * whose body holds nothing beyond an auto-generated `## Related` list.
 *
 * The check is deliberately conservative — any prose paragraph, any
 * heading other than the H1 title / `## Related`, or a non-link Related
 * item makes it return `false`, so a placeholder a human later filled in
 * with real analysis is never mistaken for deletable cruft.
 *
 * :param content: Full markdown source of the page (frontmatter + body).
 * :returns: ``True`` only when the page is an empty lint placeholder.
 */
export function isDeletableLintStub(content: string): boolean {
  // Fail-safe: a malformed/unreadable frontmatter (incl. CRLF files the
  // parser can't handle) yields no tags → not deletable.
  const fm = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(content)
  if (!fm) return false
  const tags = parseFrontmatterArray(content, "tags")
  if (!tags.includes("stub") || !tags.includes("lint")) return false

  const lines = content.slice(fm[0].length).split(/\r?\n/)
  if (!lines.some((line) => line.trim() === LINT_STUB_SENTINEL)) return false

  let inRelated = false
  for (const raw of lines) {
    const line = raw.trim()
    if (line === "" || line === LINT_STUB_SENTINEL) continue
    if (/^##\s+Related\s*$/i.test(line)) {
      inRelated = true
      continue
    }
    if (/^#\s/.test(line)) {
      // H1 title line — allowed, but closes any Related section.
      inRelated = false
      continue
    }
    if (inRelated && RELATED_ITEM_RE.test(line)) continue
    // Anything else (prose, other headings, free-text list items) means
    // the page has real content → keep it.
    return false
  }
  return true
}
