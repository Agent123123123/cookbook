# OpenCode Native Chat UI for VS Code Sessions

## Decision Record

- Decision date: 2026-03-23
- We use a single `opencode serve` process per VS Code window, not one process per chat session.
- OpenCode is treated as a multi-session backend. New Sessions UI conversations create OpenCode sessions via `POST /session`, and all subsequent operations are routed by `sessionID`.
- The VS Code shell is responsible for starting, monitoring, and disposing that single backend process. It must not depend on the user having already started OpenCode on a fixed port.
- The global SSE endpoint `GET /global/event` is shared by all sessions, and the integration layer dispatches events to the correct `IChatSession` by `sessionID`.
- Rationale: the documented OpenCode API already exposes first-class multi-session resources (`GET /session`, `POST /session`, `GET /session/:id`, `POST /session/:id/*`), so a per-session child-process model adds lifecycle and port complexity without architectural benefit for v1.
- The OpenCode native chat UI is an `Agent Mode` experience inside the main OSS workbench shell.
- `Editor Mode` keeps the current OSS layout unchanged.
- `Agent Mode` must not be implemented as a separate final shell based on `src/vs/sessions`; instead, the product should expose a Cursor-style layout mode switch inside the main workbench and reuse `sessions` only where it provides useful building blocks.

## Shell Strategy

- Final product architecture: one OSS workbench shell, two top-level layout modes.
  - `Editor Mode`: traditional OSS layout
  - `Agent Mode`: AI-first layout
- `sessions` is a reference implementation and a source of reusable components, not the final mode-switching shell.
- The mode switch should live at the workbench level. Agent-specific runtime modes such as `Agent`, `Ask`, or `Manual` should live inside the agent surface, not at the same level as `Editor Mode` / `Agent Mode`.

## Overview

将 VS Code Sessions（Agentic Window）的 chat UI 作为 OpenCode agent 的前端，替代当前 terminal 中的 TUI 体验。OpenCode 以子进程方式运行 `opencode serve`，通过 REST API + SSE 通信。所有 agent 逻辑、tool 执行、LLM 调用均由 OpenCode 全权处理，VS Code 仅负责渲染。

## 核心设计决策

### 复用 VS Code chat 架构，不替换

VS Code 的 chat 架构核心是插件化的，以下能力可以直接复用：

| VS Code 提供的能力 | 接口 | Copilot 耦合度 |
|---|---|---|
| Chat UI 渲染（消息列表、markdown、代码块） | `IChatService` + chat widget | 无 — 通用渲染器 |
| Session 管理（创建/切换/历史） | `IChatSessionsService` | 无 — 纯插件化 |
| 消息流式推送 | `IChatProgress[]` + `progressObs` | 无 — 通用协议 |
| Option picker（模型选择、agent 选择） | `IChatSessionProviderOptionGroup` | 无 — provider 自定义 |
| Session 列表 sidebar | `IChatSessionItemController` | 无 — provider 自定义 |
| Fork / 历史回放 | `IChatSession.forkSession` | 无 — provider 可选实现 |

以下部分硬编码绑定 Copilot，需要修改或绕过：

| 模块 | 文件 | 耦合方式 | 处理方式 |
|---|---|---|---|
| Welcome overlay | `sessions/contrib/welcome/` | 检查 `product.defaultChatAgent.chatExtensionId` | 修改：检测 OpenCode 可用时跳过 |
| Entitlement service | `workbench/services/chat/common/chatEntitlementService.ts` | 硬编码 GitHub OAuth + `product.json` | 绕过：不依赖此 service |
| Chat Setup | `workbench/contrib/chat/browser/chatSetup/` | 安装 Copilot 扩展流程 | 绕过：不触发 |
| `product.json` | `defaultChatAgent` 配置 | 指向 `GitHub.copilot` | 修改：清空或指向 OpenCode |

### 参照 `AgentHostContribution` 模式

`AgentHostContribution`（`agentHostChatContribution.ts`）已经实现了完全相同的模式：
- 注册自定义 session type（`agent-host-<provider>`）
- 提供 `IChatSessionContentProvider`（`AgentHostSessionHandler`）
- 提供 session 列表控制器（`AgentHostSessionListController`）
- 提供 language model provider（`AgentHostLanguageModelProvider`）
- `requestHandler` 完全绕过标准 `IChatAgentService` 调度
- 不触碰 entitlement / sign-in 逻辑

OpenCode 集成应按同样模式实现。

## 架构

```
┌──────────────────────────────────┐
│  VS Code Sessions Chat UI       │
│  （复用现有 chat widget）         │
│  消息列表 / 输入框 / diff 展示    │
└──────────────┬───────────────────┘
               │ IChatSessionContentProvider
               │ IChatSessionItemController
               │ IChatSessionProviderOptionGroup
┌──────────────▼───────────────────┐
│  OpenCode Integration Layer      │
│  - OpenCodeContribution          │
│  - OpenCodeSessionHandler        │
│  - OpenCodeSessionListController │
│  - OpenCodeEventMapper           │
│  - OpenCodePermissionHandler     │
│  - OpenCodeProcessManager       │
└──────────────┬───────────────────┘
               │ HTTP localhost:<dynamic-port>
┌──────────────▼───────────────────┐
│  opencode serve (子进程)          │
│  - Agent loop + Tool execution   │
│  - LLM provider 管理             │
│  - Session/SQLite 存储           │
└──────────────────────────────────┘
```

## 职责划分

| 职责 | 负责方 |
|------|--------|
| LLM 调用、模型选择 | OpenCode |
| Agent loop（tool calling 循环） | OpenCode |
| Tool 执行（bash、edit、read、grep 等） | OpenCode |
| Session 持久化 | OpenCode |
| Permission 判断与规则 | OpenCode |
| 渲染消息流（text、tool call、diff） | VS Code（复用 chat widget） |
| 用户输入采集 | VS Code（复用 chat input） |
| Session 列表与切换 | VS Code（复用 session sidebar） |
| 模型/Agent 选择 UI | VS Code（通过 option groups 桥接） |
| Permission UI（approve/deny） | VS Code |
| 进程生命周期管理 | VS Code |

## 组件设计

### 1. OpenCodeContribution

注册入口，参照 `AgentHostContribution` 模式，将所有组件连接到 Sessions 框架。

```
位置: src/vs/sessions/contrib/opencode/browser/opencode.contribution.ts
范本: src/vs/workbench/contrib/chat/browser/agentSessions/agentHost/agentHostChatContribution.ts
```

**注册流程：**
1. 通过 `registerWorkbenchContribution2` 注册，`WorkbenchPhase.AfterRestored`
2. 启动 `OpenCodeProcessManager`，等待 OpenCode server ready
3. 通过 `IChatSessionsService.registerChatSessionContribution` 注册 session type metadata：
   ```typescript
   {
     type: 'opencode',
     name: 'opencode',
     displayName: 'OpenCode',
     description: 'AI coding agent powered by OpenCode',
     inputPlaceholder: 'Ask OpenCode...',
     welcomeTitle: 'OpenCode',
     welcomeMessage: 'Open source AI coding agent',
   }
   ```
4. 通过 `IChatSessionsService.registerChatSessionContentProvider('opencode', handler)` 注册 content provider
5. 通过 `IChatSessionsService.registerChatSessionItemController('opencode', controller)` 注册 session 列表
6. 在 `sessions.common.main.ts` 中 import 此 contribution

### 2. OpenCodeProcessManager

管理 OpenCode server 子进程的生命周期。

```
位置: src/vs/sessions/contrib/opencode/browser/opencodeProcessManager.ts
```

**启动流程：**
1. 分配随机端口（16384–65535 范围）
2. Spawn `opencode serve --port <port>` 子进程，设置 `OPENCODE_CALLER=vscode` 环境变量
3. 轮询 `GET /global/health` 直到返回 `{ healthy: true }`（最多重试 10 次，间隔 500ms）
4. 健康检查通过后，连接 SSE 事件流

**生命周期：**
- VS Code 窗口激活时启动（如果尚未运行）
- VS Code 窗口关闭时调用 `POST /global/dispose` 后 SIGTERM
- 子进程异常退出时自动重启（指数退避，最多 3 次）
- 提供 `onReady` 事件供其他组件等待

**配置：**
- OpenCode 二进制路径可通过 setting `opencode.binaryPath` 配置，默认搜索 PATH 中的 `opencode`
- 工作目录设置为当前 workspace folder

### 3. OpenCodeSessionHandler

实现 `IChatSessionContentProvider`，将 OpenCode 的 session/message API 桥接到 VS Code chat UI。

```
位置: src/vs/sessions/contrib/opencode/browser/opencodeSessionHandler.ts
范本: src/vs/workbench/contrib/chat/browser/agentSessions/agentHost/agentHostSessionHandler.ts
```

**Session 管理：**
- `provideChatSessionContent()` 调用 `POST /session` 创建 OpenCode session
- 返回 `IChatSession` 对象：
  - `requestHandler`: 调用 `POST /session/:id/prompt_async` 发送消息（异步，不阻塞）
  - `progressObs`: 由 `OpenCodeEventMapper` 驱动，流式推送 `IChatProgress[]`
  - `isCompleteObs`: 当收到 `session.idle` 事件时标记完成
  - `interruptActiveResponseCallback`: 调用 `POST /session/:id/abort`
  - `forkSession`: 调用 `POST /session/:id/fork`
  - `history`: 从 `GET /session/:id/message` 加载并转换为 `IChatSessionHistoryItem[]`

**消息发送：**
```typescript
requestHandler(request, progress, history, token) {
  // 1. POST /session/:id/prompt_async
  //    body: { parts: [{ type: "text", text: request.message }] }
  // 2. 响应通过 SSE 事件流 → OpenCodeEventMapper → progressObs 推送到 UI
  // 3. token.onCancellationRequested → POST /session/:id/abort
}
```

### 4. OpenCodeSessionListController

实现 `IChatSessionItemController`，提供 session 列表给 sidebar。

```
位置: src/vs/sessions/contrib/opencode/browser/opencodeSessionListController.ts
范本: src/vs/workbench/contrib/chat/browser/agentSessions/agentHost/agentHostSessionListController.ts
```

**功能：**
- `refresh()`: 调用 `GET /session?roots=true` 获取 session 列表
- 将 `Session.Info` 转换为 `IChatSessionItem`（映射 title、时间、状态、changes summary）
- 监听 SSE `session.created` / `session.updated` / `session.deleted` 事件，通过 `onDidChangeChatSessionItems` 推送增量更新
- `newChatSessionItem()`: 调用 `POST /session` + `POST /session/:id/prompt_async`

### 5. OpenCodeEventMapper

监听 SSE 事件流，将 OpenCode 事件转换为 VS Code 的 `IChatProgress` 并推送到 chat UI。

```
位置: src/vs/sessions/contrib/opencode/browser/opencodeEventMapper.ts
```

**SSE 连接：**
- 连接 `GET /global/event`，维持长连接
- 心跳超时（15s 无事件）自动重连
- 按 `sessionID` 分发事件到对应的 chat session 的 `progressObs`

**核心事件映射：**

| OpenCode SSE 事件 | VS Code IChatProgress 类型 | 说明 |
|---|---|---|
| `message.part.delta` (text) | `IChatResponseMarkdownPart` | 流式追加 markdown 文本 |
| `message.part.delta` (reasoning) | `IChatResponseMarkdownPart` (折叠) | 渲染为 "Thinking" 折叠区域 |
| `message.part.updated` (tool-invocation) | `IChatResponseProgressPart` | 工具名 + 参数 + 执行状态 |
| `message.part.updated` (tool-result) | `IChatResponseMarkdownPart` | 工具执行结果 |
| `message.part.updated` (patch) | `IChatResponseMarkdownPart` | File diff 预览 |
| `message.updated` | 更新消息元数据 | Token usage 等 |
| `session.updated` | 更新 session 标题 | 触发 sidebar 刷新 |
| `session.status` (completed) | 标记 response 结束 | `isCompleteObs` → true |
| `session.idle` | Session 空闲 | 可接受新输入 |
| `session.error` | 错误消息 | 显示在 chat UI |
| `permission.asked` | 触发 Permission UI | 转交 PermissionHandler |
| `todo.updated` | 更新 todo 展示 | Task 进度 |

### 6. OpenCodePermissionHandler

处理 OpenCode 的权限请求，在 VS Code 中展示审批 UI。

```
位置: src/vs/sessions/contrib/opencode/browser/opencodePermissionHandler.ts
```

**流程：**
1. 收到 `permission.asked` SSE 事件（包含 `requestID`、工具名、参数）
2. 在 chat UI 中渲染权限请求卡片（显示工具名、参数、风险等级）
3. 用户点击 Approve / Deny / Allow All
4. 优先调用 `POST /permission/:requestID/reply` 回复 `{ reply: "once" | "always" | "reject" }`，仅为兼容旧版 OpenCode 时回退到 `POST /session/:id/permissions/:permissionID` 和 `{ response: "allow" | "deny" | "allowAll" }`

## 需要修改的现有代码

### 1. Welcome overlay 绕过

**文件：** `src/vs/sessions/contrib/welcome/browser/welcome.contribution.ts`

当前逻辑：检查 `productService.defaultChatAgent?.chatExtensionId` 是否安装，不满足则显示 sign-in overlay。

**修改方案：** 在 `SessionsWelcomeContribution` 构造函数中增加 OpenCode 检测逻辑：
```typescript
// 新增：检测 OpenCode provider 是否已注册
if (this.chatSessionsService.getChatSessionContribution('opencode')) {
  return; // OpenCode 可用，跳过 Copilot welcome overlay
}
```

或者更简洁：在 `product.json` 中清空 `defaultChatAgent.chatExtensionId`，使 welcome overlay 的前置条件 `if (!this.productService.defaultChatAgent?.chatExtensionId)` 直接 return。

### 2. product.json 调整

**选项 A（推荐）：** 清空 `defaultChatAgent.chatExtensionId`，使所有依赖此字段的 Copilot 逻辑变为 no-op：
```json
"defaultChatAgent": {
  "chatExtensionId": ""
}
```

**选项 B：** 创建新的配置字段 `defaultSessionProvider: "opencode"`，在 welcome contribution 中优先检查。

### 3. sessions.common.main.ts

在入口文件中添加 OpenCode contribution 的 import：
```typescript
import './contrib/opencode/browser/opencode.contribution.js';
```

## 文件结构

```
src/vs/sessions/contrib/opencode/
├── browser/
│   ├── opencode.contribution.ts          # 注册入口（参照 AgentHostContribution）
│   ├── opencodeProcessManager.ts         # 进程生命周期
│   ├── opencodeSessionHandler.ts         # IChatSessionContentProvider 实现
│   ├── opencodeSessionListController.ts  # IChatSessionItemController 实现
│   ├── opencodeEventMapper.ts            # SSE → IChatProgress 转换
│   └── opencodePermissionHandler.ts      # 权限审批 UI
└── common/
    └── opencode.ts                       # OpenCode API 类型 + fetch helpers
```

## OpenCode API 使用清单

| 用途 | API |
|------|-----|
| 健康检查 | `GET /global/health` |
| 事件流 | `GET /global/event` (SSE) |
| 创建 session | `POST /session` |
| 列出 sessions | `GET /session` |
| 获取 session | `GET /session/:id` |
| 发送消息（异步） | `POST /session/:id/prompt_async` |
| 发送消息（同步） | `POST /session/:id/message` |
| 获取消息历史 | `GET /session/:id/message` |
| 中止 session | `POST /session/:id/abort` |
| 回复权限请求 | `POST /permission/:requestID/reply`（旧版回退：`POST /session/:id/permissions/:permissionID`） |
| 获取 session diff | `GET /session/:id/diff?messageID=` |
| 获取 session 状态 | `GET /session/status` |
| 获取 providers/模型 | `GET /config/providers` |
| 获取 todo | `GET /session/:id/todo` |
| Fork session | `POST /session/:id/fork` |
| Revert | `POST /session/:id/revert` |
| 删除 session | `DELETE /session/:id` |
| 更新 session | `PATCH /session/:id` |
| 关闭 server | `POST /global/dispose` |

## 不做的事

- 不修改 OpenCode 代码
- 不实现自己的 agent loop / tool calling
- 不替换 VS Code 的 chat 架构核心 — 只新增一个 session content provider + 绕过 Copilot welcome
- 不做文件编辑的原生 VS Code editor 集成（OpenCode 直接操作文件系统，VS Code 通过 file watcher 自动刷新）

## 后续可扩展

- 通过 `GET /config/providers` + `IChatSessionProviderOptionGroup` 在 VS Code 中展示模型选择器
- 将 OpenCode 的 `patch` part 转换为 VS Code 原生 diff editor 预览
- 将 `bash` tool 执行桥接到 VS Code integrated terminal
- 支持 OpenCode 的 slash commands（`/share`、`/compact` 等）通过 `POST /session/:id/command` + `IChatSessionCommandContribution`
- 多 workspace 支持（每个 workspace folder 启动独立 OpenCode 实例）
- Question handler：桥接 OpenCode 的 `question.asked` 事件到 VS Code 的 quick input UI
