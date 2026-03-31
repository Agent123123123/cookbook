# AI IDE UI Trimming Spec

## Decision Record

- Decision date: 2026-03-23
- The product should use a single OSS workbench shell.
- `Editor Mode` preserves the traditional OSS layout and should be treated as the baseline product experience.
- `Agent Mode` is an AI-first layout mode inside the same shell, not a separate sessions window or second application shell.
- The product mode switch should be modeled after Cursor-style layout modes: a top-level `Editor Mode` / `Agent Mode` switch, plus a separate agent-runtime mode picker inside the agent surface.
- Phase 1 focuses on workbench-level layout switching and reuse of existing OSS capabilities, not broad physical removal of workbench parts from the default product path.
- Deeper trimming remains a later-stage optimization after `Agent Mode` is validated inside the main workbench shell.

## Agent Mode UI Strategy

### Product Architecture

- We should not ship a dual-shell product where `sessions` acts as the final `Agent Mode` application.
- We should ship one OSS workbench shell with two layout modes:
  - `Editor Mode`: OSS-native layout
  - `Agent Mode`: AI-first layout
- `sessions` can still be mined for reusable agent/session/chat implementation pieces, but it should not define the final mode-switching architecture.

### Phase 1: Reuse OSS Chat as a View Layer

- `Agent Mode` should initially reuse OSS chat/session infrastructure to validate the end-to-end flow quickly.
- This reuse should be limited to chat-oriented capabilities such as message rendering, session history, input handling, streaming progress, markdown/code rendering, and session switching.
- New `Agent Mode` tabs, bars, and side surfaces must not read state back from OSS chat internals.
- Instead, they should depend on an `Agent Session Domain` owned by our integration layer, which acts as the single source of truth for agent state, outputs, tool activity, approvals, sub-agents, and other mode-specific data.

### Phase 2: Move to a Custom Agent Conversation View if Needed

- If the validated `Agent Mode` experience remains primarily a linear conversation with auxiliary panels around it, continuing to reuse OSS chat view is acceptable.
- If the main experience evolves into a task-oriented surface where sub-agents, outputs, approvals, plans, or execution state become first-class objects in the primary timeline, we should stop extending the OSS chat view and introduce a custom `Agent Conversation View`.
- A custom conversation view should still reuse OSS platform capabilities where practical, including editor integration, markdown rendering, actions, theming, accessibility, and session infrastructure, but it should own its layout and interaction model.

### Decision Table

| Requirement pattern | Recommendation |
|---|---|
| Linear chat remains the primary interaction, and extra information lives in tabs/bars outside the message stream | Reuse OSS chat view in `Agent Mode` |
| We need richer session headers, custom tool/approval cards, or custom side tabs, but the core remains chat-shaped | Reuse OSS chat view first, while keeping a separate `Agent Session Domain` |
| Sub-agents, outputs, todos, approvals, or execution state need to be first-class elements in the main content flow | Plan to build a custom `Agent Conversation View` |
| The primary experience is no longer a linear conversation but a task graph, execution flow, or multi-agent workspace | Build a custom `Agent Conversation View` |
| New UI surfaces depend on chat internal state to function | Do not proceed with that design; move shared state into the `Agent Session Domain` first |

### Engineering Boundary

- We should not treat OSS chat as the system of record for `Agent Mode`.
- We should treat OSS chat as a replaceable view adapter during Phase 1.
- We should not treat `sessions` as the final product shell.
- The long-term stable boundary is:
  - backend integration layer
  - agent session domain layer
  - chat adapter or custom conversation view
  - workbench-level agent mode shell

> 基于 VS Code OSS 构建 AI-first EDA IDE 的 UI 裁剪方案

## 1. 产品定位

将 VS Code OSS 改造为以 AI Agent 对话为核心交互的 EDA IDE：

- **核心入口**：AI Chat 面板，用户通过对话驱动 agent 完成代码编写、EDA 工具操作等任务
- **辅助工具**：编辑器、文件树、终端、tmux 面板（嵌入 Cadence Genus/Innovus 等 EDA 工具 GUI）
- **设计原则**：用户尽量少手动编辑代码，agent 为第一操作者
- **扩展系统**：保留完整 Extension API，EDA 工具集成可通过扩展实现

## 2. 裁剪策略

重构 workbench layout 让 Chat 成为主面板，编辑器/终端/tmux 作为辅助工具区。


## 3. Workbench 布局重构

### 3.1 目标布局

```
┌─────────────────────────────────────────────┐
│                 TITLEBAR                     │
├──────────┬──────────────────────────────────┤
│          │                                  │
│          │         TOOL AREA                │
│  CHAT    │  (Editor / Terminal / Tmux tabs) │
│  (主面板) │                                  │
│          │                                  │
│          │                                  │
├──────────┴──────────────────────────────────┤
│                 STATUSBAR                   │
└─────────────────────────────────────────────┘
```

- **Chat** 占据左侧主视口，是用户的唯一交互入口
- **工具区** 以 tab 形式切换：编辑器、终端、文件树、tmux 面板（EDA GUI）
- Chat 与工具区的比例可拖拽调整

### 3.2 Parts 处理明细

| Part | 当前用途 | 处理 | 说明 |
|---|---|---|---|
| `TITLEBAR_PART` | 窗口标题栏、菜单、command center | **保留，精简** | 移除 menu bar 和 command center，仅保留窗口控制 |
| `CHATBAR_PART` | AI 聊天辅助面板 | **升级为主面板** | 从辅助位置提升为左侧主视口 |
| `EDITOR_PART` | 主编辑区域 | **保留，降为 tool tab** | 作为工具区的一个 tab |
| `STATUSBAR_PART` | 底部状态栏 | **保留，精简** | 仅显示 agent 状态、连接状态等基本信息 |
| `SIDEBAR_PART` | 主侧栏（资源管理器、搜索等） | **移除** | 文件树改为工具区 tab |
| `ACTIVITYBAR_PART` | 侧栏图标导航条 | **移除** | 无 sidebar 则不需要 |
| `PANEL_PART` | 底部面板（终端、输出、问题） | **合并到工具区** | Terminal/Output 合并到工具区 tab |
| `AUXILIARYBAR_PART` | 右侧辅助侧栏 | **移除** | 不再需要 |
| `BANNER_PART` | 顶部告警横幅 | **移除** | 通知通过 Chat 面板展示 |


## 4. 实施注意事项

### 4.1 依赖关系
移除 contrib 模块前需检查模块间依赖。以下模块被其他保留模块依赖，移除时需特别注意：
- `codeActions` — 编辑器核心可能依赖其注册机制
- `markers` — `files` 模块可能引用 markers 数据
- `output` — 扩展 API 的 `OutputChannel` 依赖此模块

### 4.2 扩展 API 兼容性
保留 Extension API 意味着部分被移除的 contrib 对应的 API namespace 仍需提供 stub 实现，避免扩展加载失败。例如：
- `vscode.debug` API — 即使移除 debug UI，如果扩展调用此 API 不应崩溃
- `vscode.scm` API — 同理

### 4.3 后续工作（不在本 spec 范围内）
- Chat 面板升级为主面板的 layout 代码实现
- tmux 面板嵌入 EDA GUI 的技术方案
- opencode agent 底座集成
- Verilog/SystemVerilog/VHDL 语言支持扩展
