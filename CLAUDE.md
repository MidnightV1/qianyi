# GhostContext

Chrome 扩展：非侵入式 LLM 记忆增强。基于浏览器侧注入，将用户画像"隐藏"在对话流中，利用 LLM 上下文窗口实现跨会话记忆。

## 架构

三个 content script 各司其职：

| 脚本 | World | runAt | 职责 |
| --- | --- | --- | --- |
| `ghost-styles.content.ts` | ISOLATED | `document_start` | CSS 预注入，隐藏 ghost-ml 自定义元素（零闪烁） |
| `content.ts` | ISOLATED | `document_idle` | chrome.storage ↔ page 桥接 + MutationObserver DOM 清洗 + Bio 自动回写 |
| `injected.content.ts` | MAIN | `document_start` | XHR/fetch 劫持 + SSE 流监控 + info-control 提取 |

MAIN world 可 hook `window.fetch` / `XMLHttpRequest`，但无 `chrome.storage`；ISOLATED 反之。两者通过 `postMessage` 通信。

```
entrypoints/
  injected.content.ts   ← MAIN world: 劫持 fetch/XHR，注入 Profile，解析 SSE
  content.ts            ← ISOLATED world: storage 桥接 + DOM 清洗 + Bio 回写
  ghost-styles.content.ts ← ISOLATED world: document_start CSS 预注入
  background.ts         ← Service worker (最小化)
  popup/                ← Profile 编辑 UI (bio / persona / style)
lib/
  adapters/types.ts     ← PlatformAdapter 接口
  adapters/deepseek.ts  ← DeepSeek 适配器 (SSE 解析 + DOM 清理)
  stream-parser.ts      ← 流式 info-control 提取 (100 字符滑动窗口)
  injection.ts          ← ghost-ml 注入模板格式化
  profile.ts            ← UserProfile 类型 + storage helpers
  constants.ts          ← 标签名、消息类型、存储键
```

## 开发

```bash
pnpm install
pnpm dev              # HMR 开发模式 → 自动加载到 Chrome
pnpm build            # 生产构建 → .output/chrome-mv3/
```

## 关键实现要点

### DeepSeek SSE 格式

DeepSeek 使用 JSON-patch 风格的增量 SSE，**不是**简单的 `{"content":"text"}`。关键特性：

- 连续 APPEND 存在**隐式压缩**：后续消息省略 `o`/`p` 字段，仅发 `{"v":"text"}`
- Fragment 类型为 `"RESPONSE"`（非 `"TEXT"`），THINK 片段需过滤
- `extractContentDeltas` 覆盖 6 种 op 格式，通过 `lastOp`/`lastPath` 状态追踪实现继承
- `fragmentTypes: Map<number, string>` 跟踪每个 fragment 索引对应的类型

### DOM 清理三层防御

ghost-ml 标签在 DOM 中有两种形态（真实 HTML 元素 / 纯文本），需要多层处理：

1. **CSS 预注入** (`ghost-styles.content.ts`)：`document_start` 注入 `display:none`（元素形态）
2. **MutationObserver 同步处理**：ghost-ml 元素的 `remove()`/`unwrap` 在 MO callback 中同步执行（不经 rAF）
3. **文本节点 cleanGhostText**：STRIP 开标签（删标签保内容）+ TRUNCATE 闭标签/控制标签（截断）+ 部分标签前缀匹配

### 协议标签体系

使用 `*-ghost-ml` XML 自定义标签（非 Markdown 引用块），原因：结构边界清晰、LLM 遵循度高、可被 CSS 直接隐藏。

- 请求侧：`<main-ghost-ml>` 包裹注入块，`<origin-user-input-ghost-ml>` 包裹原始输入
- 响应侧：`<model-response-ghost-ml>` 包裹正文（保留用于扩展），`<info-control-ghost-ml>` 包含 `need-update` + `updated-user-bio`

### 注入频率控制

按 `chat_session_id` + `parent_message_id` 追踪，可配置 N 轮重注入（默认 10）。`parentId` 每轮 +2（user + assistant）。

## 当前状态

DeepSeek 适配器完成：请求注入 → SSE 解析 → info-control 提取 → Bio 回写 → DOM 零闪烁清理，全链路打通。

待做：多平台适配（Kimi / Qwen）、动态剪枝、记忆胶囊 UI。
