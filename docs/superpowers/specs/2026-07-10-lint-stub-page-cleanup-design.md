# Wiki Lint 占位页(stub-page)检测与批量清理 — 设计稿

- 日期:2026-07-10
- 状态:待评审(用户 + Fable 已参与设计)
- 相关 memory:`wiki-consistency-pageid-analysis`(basename 撞车同根缺陷)

## 1. 问题与根因

用户真实 wiki 库积累了 176 个空占位页(`tags:[stub,lint]` + 一句 sentinel、无信息价值),占空间、污染搜索与图谱。

**根因链**:

1. `runStructuralLint`(`src/lib/lint.ts:150`)检测到 `[[断链]]` 指向不存在的页 → 报 `broken-link`。
2. 用户在 Lint 面板点"修复",触发 `ensureBrokenLinkStub`(`src/lib/lint-fixes.ts:68`,调用点 `src/components/lint/lint-view.tsx:197`):**新建**一个占位页(单段 slug 落到 `queries/<slug>.md`,多段落原路径;frontmatter `tags:[stub,lint]`;正文只有 sentinel `Created by Wiki Lint as a placeholder for a missing wikilink target.`),再用 `rewriteWikilinkTarget` 把断链改写为指向该占位页。
3. **关键**:占位页因此**有入链**,永远不是 orphan,现有 4 条 lint 规则(orphan / broken-link / no-outlinks / semantic)都抓不到它。

图中那张 `[stale]` 卡片是 **semantic lint**(LLM 生成,不可靠,自带臆造引用),只是转述现象,不能作为清理依据。

## 2. 放置决策:Lint 结构规则,不进代审阅区

| | Wiki 检查(structural lint) | 代审阅区(semantic/review) |
|---|---|---|
| 来源 | 确定性规则 | LLM 生成,不可靠 |
| 已有能力 | 删除原语、勾选、dismiss | 仅"打开/跳过" |
| 与本问题关系 | **正是它制造了 stub** | 只转述 |

**决策:新增确定性结构规则 `stub-page`。** 理由:①判定是纯规则可判的事实,不该挂 LLM 输出;②复用已有删除原语;③破坏性批量删必须由可信来源驱动;④一次性脚本劣于常驻可重跑规则 —— stub 由"修复断链且无建议目标"持续生产,会复发。

## 3. 实证数据(项目 `/Users/hugo/Documents/yin_sheng/fin_test`)

- 全库 sentinel+tags 命中 **176** 页 = `queries/` 内 175 + `yuean-new-materials/query.md` 1(多段断链落原路径)。→ **规则必须扫全 wiki,不能只扫 queries/**。
- 176 页正文构成:**15** 纯 sentinel;**161** sentinel + 仅自动生成的 `## Related` 列表;**0** 含人写散文。
- Related 列表项**不全是 `- [[wikilink]]`**:有大量 `- queries/ansaldo` 裸 slug —— 是过往删页时 `stripDeletedWikilinks` 把死链降级留下的残渣。**判据条件 3 必须同时接受裸 slug**。
- 全库 740 个 .md,basename 重名仅 1 对(非 stub),无 CRLF,无多 Related 段。
- 幸存页中 **252 页、815 处**链接指向这批 stub(495 行内 + 320 Related 列表项 + index.md 171 行)。

## 4. 方案(5 部分)

### 4.1 `src/lib/lint-fixes.ts` — 常量 + 判据

把 L95 的 sentinel 提取为共享常量,生成与检测共用,防文案漂移:

```ts
export const LINT_STUB_SENTINEL =
  "Created by Wiki Lint as a placeholder for a missing wikilink target."
// Related 列表项:wikilink 或裸 slug(无空格纯 token,挡住中英文散文)
const RELATED_ITEM_RE = /^-\s+(\[\[[^\]]+\]\]|[\w./-]+)\s*$/

export function isDeletableLintStub(content: string): boolean {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content)
  if (!fm) return false
  const tags = parseFrontmatterArray(content, "tags") // 复用 sources-merge.ts:36
  if (!tags.includes("stub") || !tags.includes("lint")) return false
  const body = content.slice(fm[0].length)
  const lines = body.split(/\r?\n/)
  if (!lines.some((l) => l.trim() === LINT_STUB_SENTINEL)) return false
  let inRelated = false
  for (const raw of lines) {
    const l = raw.trim()
    if (l === "" || l === LINT_STUB_SENTINEL) continue
    if (/^##\s+Related\s*$/i.test(l)) { inRelated = true; continue }
    if (/^#\s/.test(l)) { inRelated = false; continue } // H1 标题
    if (inRelated && RELATED_ITEM_RE.test(l)) continue
    return false // 任何其他行(含其他 ## 标题、散文)→ 保守不删
  }
  return true
}
```

判据由 Fable 起草,已在 176 页真实数据上验证:**全命中、0 误报**。边界:多 Related 段(循环天然支持)、CRLF、frontmatter 缺失/畸形(fail-safe false)、sentinel 漂移(共享常量)、`- 中文散文` 不匹配 → 保守保留。

**已知局限**:`parseFrontmatterArray` 的 frontmatter 正则硬编码 `\n`(`sources-merge.ts:37`),CRLF 文件会解析失败 → 判据返回 false(保守方向,可接受,注释标注)。

### 4.2 `src/lib/lint.ts` — 新规则

- `LintResult["type"]` 增加 `"stub-page"`。
- `runStructuralLint` 页循环里:命中 `isDeletableLintStub(p.content)` → emit `{ type:"stub-page", severity:"info", page, detail }`,并 **`continue`/跳过该页的 orphan 与 no-outlinks 检查**(15 个纯 sentinel stub 无出链,会重复触发 no-outlinks 造成双卡片)。

### 4.3 `src/components/lint/lint-view.tsx` — 展示 + 高效批删

- `typeConfig` 加 `stub-page`(图标 `Trash2`/`FileX` + i18n 两语言 label)。
- LintCard:stub-page **显示 Delete、隐藏 Fix**(避免被卷进 `handleBatchFix` 的逐项循环)。
- 新增 `handleBatchDelete`:过滤选中项中的 stub-page → `window.confirm` 一次(带数量)→ **一次性**把路径数组传给 `cascadeDeleteWikiPagesWithRefs`(`wiki-page-delete.ts:161`)→ **只 refresh 一次**。
  - **性能红线**:严禁复用逐项循环 + 每项 refresh 的路径(176 项 × 全库 740 文件 sweep ≈ 13 万次 IPC)。

### 4.4 `src/lib/wiki-cleanup.ts` — 死链列表行整行删除(共享代码,用户已批准)

`stripDeletedWikilinks`(L123):当前把死链一律降级为纯文本,会把 320 个 `- [[queries/xxx]]` 变成 `- queries/xxx` 裸文本 —— 边删边往 252 页重撒噪音。

改动:**当一行仅由列表标记 + 单个死链构成**(如 `- [[deleted]]` / `- [[deleted|x]]`,允许前后空白)→ **整行删除**;其余情况(行内散文中的死链)保持降级。语义更优:只剩死链的列表项降级成裸 slug 毫无信息价值。源删除路径(`sources-view`)同样受益。需补单测。

### 4.5 测试

- `lint-fixes.test.ts`:判据用例 —— 纯 sentinel / +Related wikilink / +裸 slug 残渣 / 混人写散文不删 / 中文列表项不删 / 无 frontmatter / CRLF。
- `lint.test.ts`:stub-page 规则命中 + orphan/no-outlinks 抑制。
- `wiki-cleanup.test.ts`:死链列表行整行删除 vs 行内降级。

## 5. 风险与处置

1. **批删性能**(4.3 已处置):单次 cascade + 单次 refresh。
2. **删后残渣**(4.4 已处置):列表行整行删除。
3. **basename 撞车**(不修,标注):`normalizeWikiRefKey`(`wiki-cleanup.ts:49`)是 basename 级匹配,176 key 一次入池,幸存页 wikilink basename 撞名同名真页会被误降级。本库实测重名仅 1 对且非 stub,**本次安全**;属 cascade 固有缺陷(同 `wiki-consistency-pageid-analysis` 根因),批量越大风险越高 → 在 `handleBatchDelete` 注释标注,不在本次修。
4. 次要:`removePageEmbedding` 对 stub 近乎 no-op(无害);无事务回滚可接受(逐文件 try/catch 续跑 + 重跑 lint 幂等收敛)。

## 6. 预期效果

对 fin_test 一次批删清掉 176 页(含 queries 外 1 页),sweep 重写约 252 幸存页 + index.md 171 行,**不产生新断链、不留列表残渣**。规则常驻,日后 stub 复发可再次检出清理。

## 7. 不在本次范围

- basename 撞车缺陷的根治(见风险 3)。
- 阻止 `ensureBrokenLinkStub` 一开始就生成 stub(那是"修复断链"的独立产品决策,不在清理范畴)。
