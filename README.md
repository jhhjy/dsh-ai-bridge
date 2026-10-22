# dsh-ai-bridge · AI 接线板

让**别的 AI** 通过本机 HTTP 把提示词递进 DeepSeek Harness 的会话，我的回复也同步到 outbox 供对方读取 —— **双向**。

> Two-way prompt relay for [DeepSeek Harness](https://github.com/deepseek-ai): any external AI (another chat window, a script, an automation) can POST a prompt into a live DSH session over the local HTTP server, and read the session's replies back from an outbox.

---

## 它解决什么问题

单窗口里只有一个模型在跑，但现实里你常有**两个 AI 同时干活**：一个在 DSH 里改代码，另一个在别的窗口里查资料/写需求。没有这个插件时，你只能人肉复制粘贴。

装上之后，另一个 AI 直接调用两个接口：

| 方向 | 机制 | 接口 |
| --- | --- | --- |
| 外部 AI → 我 | 入站队列；投递时变成**这个会话里真正的用户消息**（会唤醒 agent） | `POST /api/ai-bridge/post` |
| 我 → 外部 AI | 我的每条回复自动进 outbox；也能主动写一条 | `GET /api/ai-bridge/outbox` |

外部来的话会被明确标注成「【外部 AI 输入 · 来自 X】」，不会被误当成用户本人说的。

## 安装

插件是纯 JS 的 Cordis bundle（宿主半 + 浏览器半），不需要构建。

### 1. 拿到源码

```powershell
git clone https://github.com/OWNER/dsh-ai-bridge.git "$env:USERPROFILE\.dsh\plugins\dsh-ai-bridge"
```

（或者直接把这个仓库的 zip 解压到 `%USERPROFILE%\.dsh\plugins\dsh-ai-bridge`。）

### 2. 挂进 profile

**方式 A（推荐，让 agent 装）**：在 DSH 里对 agent 说「把这个本地包装成插件」，它会用 `plugin_manager` 的
`install_bundle` 指向该目录，走 link 安装。

**方式 B（手工两步）**：编辑 `%USERPROFILE%\.dsh\profiles\<profile>\package.json`

- `dependencies` 加一行 `"dsh-ai-bridge": "link:../../plugins/dsh-ai-bridge"`
- `dsh.profile.bundles` 加一行 `"dsh-ai-bridge"`

然后重开 DSH。

### 3. 使用

设置 → **接线板**。第一次打开会看到「接入说明」，点「复制给另一个 AI」，把那段话（地址 + 令牌 + 示例）贴到另一个窗口，对面照着做就能说话。

## 设置页

- **目标会话**：默认「跟随最近活跃会话」，也可以钉死某一个；
- **三个开关**：启用 / 收到就自动投递 / 我的回复同步到 outbox；
- **入站队列**：逐条「投递进会话」或「丢弃」，带状态（未投递 / 已投递 / 已处理）；
- **出站列表**：看我的回复、复制；
- **主动发一条**：写进 outbox，对方按时间戳增量拉取；
- **换令牌**：一键轮换。

## HTTP API

基础地址：`http://127.0.0.1:<DSH 端口>/api/ai-bridge`，写操作都要 `x-bridge-token`（也接受 `?token=`）。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/state` | 全量状态（开关、目标会话、队列、令牌、会话列表） |
| POST | `/post` | 外部 AI 发提示词 `{from, text}`，按配置自动投递 |
| GET | `/outbox?since=<ms>` | 按时间戳增量拉我的消息 |
| POST | `/reply` | 我这边主动写一条给出站（也由模型工具 `ai_bridge` 调用） |
| POST | `/deliver` | 把某条入站消息立刻投递给模型 `{id}` |
| POST | `/ack` | 把入站消息标记为已处理 `{ids: []}` |
| POST | `/config` | 改开关 / 目标会话 |
| POST | `/rotate-token` | 换令牌 |
| GET | `/diag` | 运行时自检（目标会话、agent 方法、投递通道） |

### 中文必须走 UTF-8

最常见的坑：发送端把字符串按 ANSI/GBK 编码，对面收到的全是 `???`。正确姿势——先转字节：

```powershell
$json  = '{"from":"Claude","text":"看一下这个报错"}'
$bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:PORT/api/ai-bridge/post" `
  -Headers @{"x-bridge-token"="<TOKEN>"} `
  -ContentType "application/json; charset=utf-8" -Body $bytes
```

curl：`curl.exe -X POST ... -H "content-type: application/json; charset=utf-8" --data-binary "@body.json"`。

## 投递是怎么实现的

优先走官方入口 `sessionController.prompt({ sessionId, mode:'queue', content:[{type:'text', text}] })`
—— 这就是一条真正的用户消息，会唤起 agent；该服务不可用时退化为 `agent.inject()` + `agent.followup()`。

回复同步监听 `session/event` 的 `assistant/message`，只处理目标会话，文本上限 16k。

## 安全与数据

- 服务只在 DSH 自己的 loopback HTTP 上，不额外开端口、不对外暴露；
- 写接口校验令牌，可随时轮换；
- 请求体上限 1 MB，单条文本上限 16k；
- 数据落在 `<DSH_HOME>/ai-bridge/`：`state.json` + `inbox.jsonl` + `outbox.jsonl`（追加写、坏行跳过）。

## 兼容性

- 需要 DSH 提供 `webServer`（同源 HTTP）；`sessionController` / `agents` / `sessions` 都是可选读取；
- 浏览器半侧用 `settings.section` 槽位，宿主不提供该槽位的旧版本上只是页面不出现，投递仍可用。

## 卸载

从 profile 的 `dsh.profile.bundles` / `dependencies` 删掉两行，删掉 `node_modules/dsh-ai-bridge`，重启即可。数据目录可保留。

## License

MIT
