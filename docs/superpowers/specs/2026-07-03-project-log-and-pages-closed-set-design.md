# 设计：项目级运行日志 + 审阅 PAGES 闭集约束

日期：2026-07-03
状态：已确认（用户批准；两部分共用一份 spec，分任务实现）

## Part 1：运行日志落盘到项目目录

### 背景

应用无落盘运行日志（Rust 侧 eprintln 只进终端；panic 转 UI 错误不留痕）。
排查今晨异常时唯一可用的是 `ingest-warnings.log`——该模式（项目
`.llm-wiki/` 下追加式日志）已被验证有效，本设计将其泛化为通用项目日志。

### 组件：`src/lib/project-log.ts`（新模块）

```ts
/** 追加一批日志行到项目 .llm-wiki/app.log；绝不抛出。 */
export async function appendProjectLog(
  projectPath: string,
  scope: string,          // 如 "deep-research"、"mcp"、"ingest"、"finance-import"
  lines: readonly string[],
): Promise<void>

/** 纯函数：格式化条目（可单测）。 */
export function formatProjectLogEntry(scope: string, lines: readonly string[], now?: Date): string

/** 纯函数：超限时按条目边界截尾（可单测）。 */
export function trimProjectLog(content: string, maxBytes?: number, keepBytes?: number): string
```

- 条目格式与 ingest-warnings 一致：`## <ISO时间> | <scope>` + 编号行 +
  空行分隔。
- 轮转：写入前若现有内容 > 512KB（`MAX_LOG_BYTES`），按条目边界
  （`\n\n## `）截留尾部 ≤ 256KB（`KEEP_LOG_BYTES`），并在文件头加一行
  `（日志已轮转，早期条目被截断）`。
- `lines` 为空直接返回；所有 IO 错误吞掉并 `console.warn`（与
  `appendIngestWarningLog` 同姿态）。

### 一期接线点（每处一行调用，均在错误/收尾既有分支内）

| 位置 | scope | 记什么 |
|---|---|---|
| `deep-research.ts` `executeResearch` 任务结束（done/error 两分支） | `deep-research` | 主题、状态、来源数、sourceErrors 各条 |
| `deep-research.ts` `collectResearchSources` 调用方（executeResearch 内已有 errors） | （并入上一条） | — |
| `ingest.ts` 硬失败分支（`hardFailures.length > 0`） | `ingest` | 源标识 + 各失败信息 |
| `source-lifecycle` / 金融导入批次完成处 | `finance-import` | 本批改名条数与 NA 条数摘要 |

`ingest-warnings.log` 保留现状不动（专用通道）。Rust 侧不改。

### 测试

`project-log.test.ts`：格式化纯函数（时间戳/编号/空行分隔）；trim 纯函数
（不足上限原样返回、超限按条目边界截尾、头部标记行）；`appendProjectLog`
mock fs 的追加与吞错行为。

## Part 2：审阅 PAGES 闭集约束（修复误联/丢弃）

### 根因（证据链）

- 项目 `schema.md` 要求 `kebab-case.md` 英文 slug，但模型建页（FILE 块）
  实际使用中文文件名（如 `北川精机.md`）；写 REVIEW PAGES 与 log 记述时
  却按 schema 想象英文 slug（`heduan-intelligent.md`）——同一响应内自相
  矛盾。
- 现有提示词"从 CURRENT index 逐字复制路径"无效：注入的是 index.md
  内容（wikilink 形式），模型看不到确切的 `wiki/...` 相对路径。
- resolver（`affected-pages-resolver.ts`）行为正确：解析不到就 drop 并
  记警告。问题在生成端。

### 方案：生成端闭集注入；校验端零改动（零模糊匹配）

1. **清单构建**：`buildWikiPageInventory(projectPath): Promise<string>`
   （放 `affected-pages-resolver.ts`，复用其 `flattenMdFiles` 列举逻辑）——
   返回按目录分组、排序的真实相对路径清单文本；上限 500 条，超限时
   优先保留 `entities/`、`concepts/`、`findings/`、`thesis/` 并在末尾注明
   `（清单已截断，共 N 页）`。
2. **注入位置**：ingest.ts 两处 REVIEW 模板（约 :2140 与 :2203 的
   `PAGES entries MUST ...` 行附近），紧邻输出格式段（模型对近处指令
   权重最高）。注入段：
   `## Existing Wiki Pages (PAGES 闭集清单)\n<清单>`。
3. **指令改写**（两处同步）：
   `PAGES entries MUST be chosen ONLY from the "Existing Wiki Pages" list above, or be the exact path of a FILE block you emit in THIS response. Anything else will be dropped. NEVER translate, transliterate, or invent slugs.`
4. **校验端不动**：不加前缀/模糊匹配——`siemens-energy` ≠
   `siemens-energy西门子能源` 就该 drop，这是防误联的最后防线；drop
   警告照旧写 `ingest-warnings.log`。

### 边界与不做

- 空 wiki（清单为空）：注入段省略，指令退化为"只允许本响应 FILE 块
  路径"。
- schema.md 与实际建页命名的矛盾属于项目模板问题，不在本次代码修复
  范围（存量中文命名已成事实，不迁移）。
- 不做 resolver 端模糊匹配扩展（用户明确要求避免误联风险）。

### 测试

- `affected-pages-resolver.test.ts`：`buildWikiPageInventory` 分组/排序/
  截断/空 wiki 用例。
- ingest 提示词测试（沿用现有 mock 测试模式）：REVIEW 模板段包含清单
  文本与新指令；空 wiki 时省略清单段。

## 验收标准

- Part 1：deep-research 失败/ingest 硬失败/金融导入后，`.llm-wiki/app.log`
  出现对应条目；超 512KB 自动截尾且旧条目边界完整。
- Part 2：对含既有页面的项目做一次 ingest，REVIEW 提示词含真实路径
  闭集清单；`dropped unresolvable PAGES` 警告量显著下降（提示词层面
  可断言的部分以单测钉住）。
