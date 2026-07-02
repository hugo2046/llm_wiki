# 设计：金融项目 deep-research 时间感知

日期：2026-07-02
状态：已确认（用户批准，限定条件：仅金融模式项目生效）

## 背景与动机

金融项目导入来源时，文件名已由 `finance-naming.ts` 规范化为
`yyyymmdd-<ts_code|NA>-<简称>-<标题>.<ext>`，日期与标的信息成为来源身份的一部分。
但 `deep-research.ts` 目前把本地 AnyTXT 结果当普通网页结果对待：综合提示词中的
Time Sensitivity 约束只依赖 snippet 里碰巧出现的日期，完全没有利用文件名中
确定性的 `yyyymmdd` 与 `ts_code`。

本设计让 deep-research 在金融项目中确定性地消费这些元数据，使综合报告具备
可靠的时间脉络。

## 范围

**做**：

1. 确定性解析本地来源文件名中的日期与标的。
2. 本地来源按日期倒序排列，并前置于 web 来源之前注入 LLM 上下文。
3. 每条本地来源在上下文中显式标注日期、距今天数、标的；超过 6 个月追加
   「数据时效存疑」标记。
4. 金融模式下强化系统提示词：说明本地来源日期为确定性元数据（可信度高于
   snippet 中出现的日期），要求报告按时间脉络组织、结论以最新来源为准。

**不做**（未来扩展，YAGNI）：

- 时间窗口过滤（硬过滤需 UI 入参且会丢失历史脉络；标注+排序已实现软降权）。
- 标的维度聚合（报告组织交给 LLM 提示词引导，不做代码硬编码分组）。

## 硬性约束

- **仅金融模式生效**：通过 `isFinanceNamingEnabled(projectPath)` 门控
  （读取 `.llm-wiki/source-naming.json` 的 `mode === "finance"`）。
  非金融项目走现有路径，零行为变化。
- 解析失败（文件名不符合规范化形状）的本地来源按现状处理，不硬猜。

## 组件设计

### 1. `parseNormalizedFinanceName`（新增纯函数，`src/lib/finance-naming.ts`）

```ts
export function parseNormalizedFinanceName(fileName: string):
  | { date: string; tsCode: string | null; stockName: string | null }
  | null
```

- 只认严格的规范化形状：`^(20\d{6})-(<ts_code>|NA)-…`；
  `ts_code` 形状为 `\d{5,6}\.[A-Z]{2,4}`（兼容 A 股与港股代码）。
- `NA` 段返回 `tsCode: null, stockName: null`；匹配 ts_code 时第三段为简称。
- 认不出（非金融命名、web 标题等）返回 `null`。
- 与既有解析逻辑同居一个模块，配套单测。

### 2. deep-research 上下文构建（改 `src/lib/deep-research.ts`）

在 `executeResearch` Step 2（LLM 综合）之前：

1. `isFinanceNamingEnabled(pp)` 一次异步判定；`false` 时完全走现有逻辑。
2. 金融模式下，对 `source === "AnyTXT"` 的结果用 `parseNormalizedFinanceName(title)`
   解析（title 即规范化文件名）。
3. 排序规则：解析出日期的本地来源按日期倒序在前 → 未解析出日期的本地来源 →
   web 来源保持原顺序在后。编号 `[N]` 按最终顺序重排，References 一节同步。
4. 上下文条目格式（本地来源，解析成功时）：

   ```
   [3] **20260512-600519.SH-贵州茅台-一季报纪要.pdf** (AnyTXT, 日期: 2026-05-12, 距今 51 天, 标的: 贵州茅台 600519.SH)
   <snippet>
   ```

   超过 180 天追加 ` ⚠️ 数据时效存疑`。距今天数以 `currentWikiDate()` 的当天为基准。
5. 金融模式下在系统提示词 Time Sensitivity 段追加小节，说明：
   - 本地来源标注的「日期」解析自规范化文件名，是确定性元数据，
     可信度高于 snippet 内出现的日期；
   - 报告需按时间脉络组织，数据冲突时以最新日期来源为准并注明。

抽出纯函数（便于测试，均不做 IO）：

```ts
export function buildFinanceSearchContext(
  results: WebSearchResult[],
  today: string,
): { context: string; ordered: WebSearchResult[] }
```

`ordered` 用于让 References 与正文 `[N]` 编号保持一致。

### 3. 错误处理

- `isFinanceNamingEnabled` 读取失败 → 视为非金融模式（该函数已自带 try/catch）。
- 解析返回 `null` → 该条来源不标注、不参与日期排序，按「未解析」组处理。
- 全部来源都解析失败 → 行为等同现状（仅提示词小节仍生效，无副作用）。

## 数据流

```
AnyTXT 结果(title=规范化文件名)
  → parseNormalizedFinanceName → {date, tsCode, stockName} | null
  → buildFinanceSearchContext（排序+标注+编号重排）
  → searchContext + 金融版系统提示词 → streamChat
  → 综合报告（带时间脉络） → 保存/摄取（现有流程不变）
```

## 测试

- `finance-naming.test.ts`：`parseNormalizedFinanceName` 用例——标准形状（A 股/
  港股/NA）、幂等产物、非金融文件名、web 标题、边界（日期非法、段缺失）。
- `deep-research.test.ts`（mock）：
  - 金融模式：上下文含日期标注、按日期倒序、本地在 web 之前、编号与
    References 一致、>180 天来源带「数据时效存疑」。
  - 非金融模式：searchContext 与系统提示词与现状完全一致（零行为变化）。
