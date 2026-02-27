# GhostContext

Chrome 扩展：非侵入式 LLM 记忆增强。

## 架构

```
entrypoints/
  injected.content.ts   ← MAIN world: 劫持 fetch，注入 Profile
  content.ts            ← ISOLATED world: storage ↔ page 桥接 + DOM 清洗
  background.ts         ← Service worker (P0 最小化)
  popup/                ← Profile 编辑 UI
lib/
  adapters/types.ts     ← PlatformAdapter 接口
  adapters/deepseek.ts  ← DeepSeek 适配器
  profile.ts            ← UserProfile 类型 + storage helpers
  injection.ts          ← 注入文本格式化
  constants.ts          ← 共享常量
```

## 开发

```bash
pnpm install
pnpm dev              # HMR 开发模式 → 自动加载到 Chrome
pnpm build            # 生产构建 → .output/chrome-mv3/
```

## 校准 DeepSeek API

1. Popup 打开调试模式
2. 在 chat.deepseek.com 发一条消息
3. 打开 DevTools Console，找 `[GhostContext] 🔍 API call:` 日志
4. 根据实际 URL 和 body 格式调整 `lib/adapters/deepseek.ts`

## 当前状态

P0：仅 DeepSeek，仅注入 User Profile，不处理模型输出端。
