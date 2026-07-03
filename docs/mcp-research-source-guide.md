# MCP 数据源使用指南

Deep Research 支持把 MCP server（Model Context Protocol，Streamable HTTP
传输）的工具调用结果作为信息来源，与网页搜索 / AnyTXT 并行使用。
典型场景：接入金融数据服务（如 tushare 的 MCP 封装），让研究报告直接
引用结构化行情/财报数据，而非只依赖网上搜索。

## 工作方式

- 在「设置 → 外部信息源 → MCP 数据源」中配置 server；**启用**的 server
  在每次 Deep Research 时自动参战（不受"深度研究来源模式"三选一影响）。
- 每个查询词对每个启用 server 调用一次配置的工具（`tools/call`），查询词
  写入「查询参数名」指定的参数（默认 `query`），「固定参数」中的 JSON
  对象会一并合并进调用参数。
- 工具返回的每个文本块成为一条研究来源（来源标注 `MCP:<名称>`），与
  其他来源统一去重，总量封顶 20 条。
- 单个 server 失败（超时 30 秒/连接拒绝/工具报错）只计入错误提示，
  不影响其他来源。

## 配置字段

| 字段 | 说明 |
|---|---|
| 名称 | 显示名，也用于结果来源标注（`MCP:<名称>`） |
| 端点 URL | Streamable HTTP 端点，如 `http://127.0.0.1:8000/mcp` |
| Authorization 头 | 可选；完整头值（如 `Bearer xxx`），只发送给该端点 |
| 工具名 | 要调用的 MCP 工具（可用「测试连接」列出并校验） |
| 查询参数名 | 查询词写入的参数，默认 `query` |
| 固定参数 | 可选 JSON 对象，随每次调用发送（如 `{"limit": 10}`） |

## 接入 stdio 型 server（本地进程）

许多数据类 MCP server 是本地 stdio 进程（Python/Node）。本应用只支持
Streamable HTTP，两种桥接方式任选：

### 方式一：fastmcp 的 HTTP 模式（推荐，Python server）

如果 server 用 [FastMCP](https://github.com/jlowin/fastmcp) 编写：

    fastmcp run server.py --transport streamable-http --port 8000

端点即 `http://127.0.0.1:8000/mcp`。

### 方式二：mcp-proxy 通用桥接

任意 stdio server 均可用 [mcp-proxy](https://github.com/sparfenyuk/mcp-proxy)：

    uvx mcp-proxy --port 8000 -- python your_stdio_server.py

## 示例：tushare 类金融数据 server

假设有一个暴露 `stock_news` 工具（参数 `query`、`limit`）的金融数据
MCP server 跑在本机 8000 端口：

- 名称：`tushare`
- 端点 URL：`http://127.0.0.1:8000/mcp`
- 工具名：`stock_news`
- 查询参数名：`query`
- 固定参数：`{"limit": 10}`

点「测试连接」确认工具存在后启用。之后发起 Deep Research（如
"贵州茅台 一季报"），综合报告会把该 server 返回的数据作为编号来源引用。

## 安全提示

- 查询词会发送给启用的 MCP server，只配置**可信**服务。
- Authorization 头以明文存于本地设置，与搜索 API key 同等对待。
