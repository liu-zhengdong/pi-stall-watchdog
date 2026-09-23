# pi-stall-watchdog

模型流停摆看门狗。一次模型请求在设定时间内没有任何流事件，就中断它并交给 Pi 自带的 auto-retry 重发这一轮。另外处理 Claude Code 的 safeguards 误拦：识别到拒答后自动换新会话继续（见「拒答恢复」）。

## 为什么需要

provider 的流式响应会停摆：连接还活着，但长时间不出内容。会话就停在那里，只能按 ESC 再说「继续」。链路上三层都不会放弃——

- Claude Code 的字节级 watchdog 只看有没有字节（首方默认 180 秒），SSE 保活会不断重置它的计时器；
- pi-ai 里只有 `dist/api/openai-codex-responses.js` 实现了 `idleTimeout`，anthropic 和其他 api 没有流级停摆检测；
- Pi 的 `httpIdleTimeoutMs`（默认 300 秒）作用在 undici dispatcher 上，管不到 claude-bridge 这类子进程 provider。

实测过的停摆：2026-09-21 有两次单轮请求分别耗时 195 秒（产出 814 tokens）和 273 秒（4224 tokens），同期会话吐字速率中位数是 72 tok/s。

## 安装

```sh
pi install git:github.com/liu-zhengdong/pi-stall-watchdog@v0.1.2
```

装完新开的会话自动生效，已经在跑的会话不受影响。

## 做法

包装 provider 的 `streamSimple` 和 `stream`。每收到一个流事件就重置计时器，超时就：

1. 用派生的 `AbortController` 中断底层请求，provider 自己的清理照常跑；
2. 向上发一条 `stopReason: "error"`、`errorMessage` 含 `timeout` 的 assistant 消息。

第 2 步的文本命中 pi-ai 的 `RETRYABLE_PROVIDER_ERROR_PATTERN`（`dist/utils/retry.js`），Pi 的 auto-retry（`settings.retry`，默认 3 次、2s/4s/8s 退避）就会重发这一轮，并把这条错误消息从 agent state 里移除。

不发 `aborted`：pi-ai 的 `retryAssistantCall` 永远不重试 `stopReason === "aborted"` 的消息，发 aborted 的效果和用户按 ESC 一样，还是停在那里。

## 拒答恢复

Claude Code 的 safeguards 偶尔会把正常请求判成违规，报 `...'s safeguards flagged this message`（社区反馈里多为误报）。这类错误不在 pi-ai 的可重试集合里，轮次直接结束、会话停住，同样内容重发还常被再次拦下。

看门狗识别到这条错误后，等这一轮完全停稳（`agent_settled`）自动：

1. 新开会话，用 `parentSession` 链接到原会话（原会话文件原样保留）；
2. 写入一条接续说明（custom message，界面上可见，也进入模型上下文）；
3. 发送「继续上次的任务」。

默认只对交互会话（`hasUI`）生效；两次恢复之间冷却 5 分钟，防止新会话又被拦下时连环换会话。`/recover` 命令可以手动做同样的切换。

## 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PI_STALL_WATCHDOG_MS` | `120000` | 无流事件多少毫秒判定停摆。设 `0` 关闭停摆检测（拒答恢复不受影响） |
| `PI_STALL_WATCHDOG_RECOVER` | 未设置 | 拒答恢复：默认只对交互会话自动恢复；设 `1` 无 UI 也恢复，设 `0` 关闭 |
| `PI_STALL_WATCHDOG_DEBUG` | 未设置 | 设为 `1` 时把包装和触发写入 `~/.pi/agent/stall-watchdog.log` |

`/stall-watchdog` 命令显示当前阈值和活动 provider 是否已挂上。包装依赖 `ModelRuntime` 每次请求都从 registry 取 provider 对象，Pi 升级后若改了这个解析方式，包装会静默失效、卡死照旧，用这个命令当场核对。

120 秒的依据：实测 Claude Code 单轮首字延迟 p50 6.2 秒、p90 25.7 秒、p99 77.4 秒，而真实停摆从 132 秒起。Pi 侧收到流事件比 Claude Code 写完整个 block 更早，所以实际间隔比这组数字更小。

## 代价

对 claude-bridge，一次中断等同于用户按 ESC：它会标记 Claude Code 会话需要重建，下一次调用从 Pi 的历史重建，丢一次 prompt cache。所以阈值要保守，不要为了「早点重试」调到几十秒。

## 限制

只在「一个流事件都收不到」时触发。如果某个 provider 停摆时仍在发事件，这个看门狗看不出来。

**工具结果续接处的停摆需要 claude-bridge 配合**（[#3](https://github.com/liu-zhengdong/pi-stall-watchdog/issues/3)）。看门狗中断后 Pi 会重试，但未修复的 bridge 会把重发请求认成「用户按 ESC 后的孤儿工具结果」，返回一条零 token 的空消息；Pi 看到 `stopReason: "stop"` 就当重试成功，轮次正常结束，用户侧表现为报错后停住。

修复在 bridge 侧：[liu-zhengdong/pi-claude-bridge#2](https://github.com/liu-zhengdong/pi-claude-bridge/pull/2)（已合入，`v0.7.0-fork.1`）。用 npm 版 `@schuettc/pi-claude-bridge` 的仍会碰到。

停摆发生在用户消息之后（没有待续接的工具结果）时不受影响，任何 provider 都正常重试。

## 测试

```sh
npm test
```

13 个用例，覆盖停摆触发、正常透传、有进展续命、调用方中断、底层抛异常、deferred 豁免、阈值为 0 关闭、停摆消息保留已收到内容、反向断言（配额/计费类错误和 `aborted` 确实不可重试），以及拒答恢复的判定、决策与派发（含冷却）。

测试从当前安装的 pi 里解析 `@earendil-works/pi-ai`，所以需要本机装好 pi。

## License

MIT
