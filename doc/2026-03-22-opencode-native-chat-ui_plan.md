# OpenCode Native Chat UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace OpenCode's terminal TUI with a native VS Code agent UI, keeping OpenCode as the backend agent process.

**Architecture:** VS Code starts one OpenCode backend process per window (`opencode serve --port <dynamic>`). That backend manages multiple OpenCode sessions. A new `IChatSessionContentProvider` bridges its REST API + global SSE event stream to the agent UI, routing messages by `sessionID`. The final product architecture is a single OSS workbench shell with `Editor Mode` and `Agent Mode` layout switching; `src/vs/sessions` is only a reference implementation and source of reusable pieces, not the final product shell.

**Tech Stack:** TypeScript, VS Code Sessions layer, OpenCode REST API (Hono), Server-Sent Events

**Spec:** `doc/2026-03-22-opencode-native-chat-ui.md`

**Reference implementation:** `src/vs/workbench/contrib/chat/browser/agentSessions/agentHost/` (AgentHostContribution pattern)

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/vs/sessions/contrib/opencode/common/opencode.ts` | Types for OpenCode API responses + fetch helper class |
| `src/vs/sessions/contrib/opencode/browser/opencodeProcessManager.ts` | Spawn/monitor/restart the single window-scoped `opencode serve` child process |
| `src/vs/sessions/contrib/opencode/browser/opencodeEventMapper.ts` | SSE listener, maps OpenCode events → `IChatProgress[]` |
| `src/vs/sessions/contrib/opencode/browser/opencodeSessionHandler.ts` | `IChatSessionContentProvider` implementation |
| `src/vs/sessions/contrib/opencode/browser/opencodeSessionListController.ts` | `IChatSessionItemController` for session sidebar |
| `src/vs/sessions/contrib/opencode/browser/opencode.contribution.ts` | Wires everything together, registers with `IChatSessionsService` |
| `src/vs/sessions/sessions.desktop.main.ts` | Add import for opencode contribution |
| `src/vs/sessions/sessions.web.main.ts` | Add import for opencode contribution |
| `src/vs/sessions/contrib/welcome/browser/welcome.contribution.ts` | Add OpenCode bypass logic |

---

## Decision Record

- Decision date: 2026-03-23
- Product mode model: keep one OSS workbench shell and expose two top-level layout modes:
  - `Editor Mode`: current OSS layout
  - `Agent Mode`: AI-first layout
- The final mode switch must live in the main workbench, not inside a standalone `sessions` shell.
- Process model: single `opencode serve` per VS Code window.
- Session model: multiple chat sessions are created inside that backend via `POST /session`.
- Event model: one shared `GET /global/event` SSE connection, demultiplexed by `sessionID`.
- Non-goal for v1: do not spawn one OpenCode process per chat session.
- Reason: the documented OpenCode API is already multi-session, so the per-session process model is unnecessary extra complexity, and keeping `Editor Mode` unchanged reduces integration risk while `Agent Mode` evolves.

## Planning Note

- This plan still references `src/vs/sessions` heavily because it is the current closest in-repo implementation of agent/session UX.
- Before implementation continues, the code should be re-oriented so that:
  - workbench-level mode switching is added in the main OSS shell
  - reusable `sessions` code is extracted or adapted
  - `sessions` itself is not treated as the final `Agent Mode` shell

### Task 1: OpenCode API Types and Fetch Helper

**Files:**
- Create: `src/vs/sessions/contrib/opencode/common/opencode.ts`

- [ ] **Step 1: Create the OpenCode API types and client class**

```typescript
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export namespace OpenCodeAPI {

	// --- Session types ---

	export interface SessionInfo {
		readonly id: string;
		readonly slug: string;
		readonly projectID: string;
		readonly title: string;
		readonly version: string;
		readonly parentID?: string;
		readonly summary?: {
			readonly additions: number;
			readonly deletions: number;
			readonly files: number;
		};
		readonly time: {
			readonly created: number;
			readonly updated: number;
			readonly archived?: number;
		};
	}

	// --- Message types ---

	export interface MessageInfo {
		readonly id: string;
		readonly sessionID: string;
		readonly role: 'user' | 'assistant';
		readonly agent?: string;
		readonly time: { readonly created: number };
	}

	export interface MessageWithParts {
		readonly info: MessageInfo;
		readonly parts: Part[];
	}

	// --- Part types ---

	export type Part =
		| TextPart
		| ReasoningPart
		| ToolInvocationPart
		| ToolResultPart
		| PatchPart
		| SnapshotPart;

	export interface TextPart {
		readonly id: string;
		readonly sessionID: string;
		readonly messageID: string;
		readonly type: 'text';
		readonly text: string;
	}

	export interface ReasoningPart {
		readonly id: string;
		readonly sessionID: string;
		readonly messageID: string;
		readonly type: 'reasoning';
		readonly reasoning: string;
	}

	export interface ToolInvocationPart {
		readonly id: string;
		readonly sessionID: string;
		readonly messageID: string;
		readonly type: 'tool-invocation';
		readonly toolInvocation: {
			readonly toolName: string;
			readonly toolCallId: string;
			readonly state: 'call' | 'partial-call' | 'result';
			readonly args?: unknown;
			readonly result?: unknown;
		};
	}

	export interface ToolResultPart {
		readonly id: string;
		readonly sessionID: string;
		readonly messageID: string;
		readonly type: 'tool-result';
		readonly toolResult: {
			readonly toolName: string;
			readonly toolCallId: string;
			readonly result: unknown;
		};
	}

	export interface PatchPart {
		readonly id: string;
		readonly sessionID: string;
		readonly messageID: string;
		readonly type: 'patch';
		readonly hash: string;
		readonly files: string[];
	}

	export interface SnapshotPart {
		readonly id: string;
		readonly sessionID: string;
		readonly messageID: string;
		readonly type: 'snapshot';
		readonly snapshot: string;
	}

	// --- SSE Event types ---

	export interface SSEEvent {
		readonly directory?: string;
		readonly payload: {
			readonly type: string;
			readonly properties: Record<string, unknown>;
		};
	}

	// --- Prompt input ---

	export interface PromptInput {
		readonly parts: Array<{ readonly type: 'text'; readonly text: string }>;
		readonly agent?: string;
	}

	// --- Health ---

	export interface HealthResponse {
		readonly healthy: boolean;
		readonly version: string;
	}

	// --- Permission ---

	export interface PermissionReply {
		readonly reply: 'once' | 'always' | 'reject';
	}
}

/**
 * Lightweight HTTP client for the OpenCode server.
 */
export class OpenCodeClient {

	constructor(private readonly _baseUrl: string) { }

	get baseUrl(): string {
		return this._baseUrl;
	}

	async health(): Promise<OpenCodeAPI.HealthResponse> {
		const res = await fetch(`${this._baseUrl}/global/health`);
		return res.json();
	}

	async createSession(): Promise<OpenCodeAPI.SessionInfo> {
		const res = await fetch(`${this._baseUrl}/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
		return res.json();
	}

	async listSessions(): Promise<OpenCodeAPI.SessionInfo[]> {
		const res = await fetch(`${this._baseUrl}/session?roots=true`);
		return res.json();
	}

	async getSession(sessionID: string): Promise<OpenCodeAPI.SessionInfo> {
		const res = await fetch(`${this._baseUrl}/session/${sessionID}`);
		return res.json();
	}

	async getMessages(sessionID: string): Promise<OpenCodeAPI.MessageWithParts[]> {
		const res = await fetch(`${this._baseUrl}/session/${sessionID}/message`);
		return res.json();
	}

	async promptAsync(sessionID: string, input: OpenCodeAPI.PromptInput): Promise<void> {
		await fetch(`${this._baseUrl}/session/${sessionID}/prompt_async`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(input),
		});
	}

	async abort(sessionID: string): Promise<void> {
		await fetch(`${this._baseUrl}/session/${sessionID}/abort`, { method: 'POST' });
	}

	async replyPermission(sessionID: string, permissionID: string, reply: OpenCodeAPI.PermissionReply): Promise<void> {
		try {
			await fetch(`${this._baseUrl}/permission/${permissionID}/reply`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(reply),
			});
		} catch {
			await fetch(`${this._baseUrl}/session/${sessionID}/permissions/${permissionID}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					response: reply.reply === 'once' ? 'allow' : reply.reply === 'always' ? 'allowAll' : 'deny'
				}),
			});
		}
	}

	async dispose(): Promise<void> {
		try {
			await fetch(`${this._baseUrl}/global/dispose`, { method: 'POST' });
		} catch {
			// Server may already be gone
		}
	}

	connectSSE(onEvent: (event: OpenCodeAPI.SSEEvent) => void, signal: AbortSignal): void {
		const connect = () => {
			if (signal.aborted) {
				return;
			}
			const eventSource = new EventSource(`${this._baseUrl}/global/event`);
			eventSource.onmessage = (e) => {
				try {
					const parsed: OpenCodeAPI.SSEEvent = JSON.parse(e.data);
					onEvent(parsed);
				} catch {
					// Ignore malformed events
				}
			};
			eventSource.onerror = () => {
				eventSource.close();
				if (!signal.aborted) {
					setTimeout(connect, 2000);
				}
			};
			signal.addEventListener('abort', () => eventSource.close());
		};
		connect();
	}
}
```

- [ ] **Step 2: Verify no TypeScript errors**

Run: `npm run compile-check-ts-native`

- [ ] **Step 3: Commit**

```bash
git add src/vs/sessions/contrib/opencode/common/opencode.ts
git commit -m "feat: add OpenCode API types and fetch client"
```

---

### Task 2: OpenCode Process Manager

**Files:**
- Create: `src/vs/sessions/contrib/opencode/browser/opencodeProcessManager.ts`

- [ ] **Step 1: Create the process manager**

```typescript
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../../base/common/event.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { OpenCodeClient } from '../common/opencode.js';

/**
 * Manages the lifecycle of an `opencode serve` child process.
 *
 * In the web (browser) environment, no child process is spawned —
 * we assume the user has started `opencode serve` externally and
 * just probe the configured port until healthy.
 */
export class OpenCodeProcessManager extends Disposable {

	private readonly _onReady = this._register(new Emitter<OpenCodeClient>());
	readonly onReady = this._onReady.event;

	private readonly _onFailed = this._register(new Emitter<Error>());
	readonly onFailed = this._onFailed.event;

	private _client: OpenCodeClient | undefined;

	get client(): OpenCodeClient | undefined {
		return this._client;
	}

	constructor(
		private readonly _port: number,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
	}

	async start(): Promise<OpenCodeClient> {
		const baseUrl = `http://localhost:${this._port}`;
		const client = new OpenCodeClient(baseUrl);

		// Poll for health
		const maxRetries = 20;
		const interval = 500;
		for (let i = 0; i < maxRetries; i++) {
			try {
				const health = await client.health();
				if (health.healthy) {
					this._logService.info(`[OpenCode] Server healthy at ${baseUrl}, version ${health.version}`);
					this._client = client;
					this._onReady.fire(client);
					return client;
				}
			} catch {
				// Not ready yet
			}
			await new Promise(resolve => setTimeout(resolve, interval));
		}

		const err = new Error(`[OpenCode] Server at ${baseUrl} did not become healthy after ${maxRetries * interval}ms`);
		this._logService.error(err.message);
		this._onFailed.fire(err);
		throw err;
	}

	override dispose(): void {
		this._client?.dispose();
		super.dispose();
	}
}
```

- [ ] **Step 2: Verify no TypeScript errors**

Run: `npm run compile-check-ts-native`

- [ ] **Step 3: Commit**

```bash
git add src/vs/sessions/contrib/opencode/browser/opencodeProcessManager.ts
git commit -m "feat: add OpenCode process manager"
```

---

### Task 3: OpenCode Event Mapper

**Files:**
- Create: `src/vs/sessions/contrib/opencode/browser/opencodeEventMapper.ts`

- [ ] **Step 1: Create the SSE → IChatProgress mapper**

```typescript
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../../base/common/event.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IChatProgress } from '../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { OpenCodeClient, OpenCodeAPI } from '../common/opencode.js';

export interface OpenCodeSessionEvent {
	readonly sessionID: string;
	readonly progress: IChatProgress[];
}

export interface OpenCodeSessionComplete {
	readonly sessionID: string;
}

/**
 * Connects to the OpenCode SSE event stream and translates
 * events into IChatProgress arrays, dispatched per session.
 */
export class OpenCodeEventMapper extends Disposable {

	private readonly _onProgress = this._register(new Emitter<OpenCodeSessionEvent>());
	readonly onProgress = this._onProgress.event;

	private readonly _onComplete = this._register(new Emitter<OpenCodeSessionComplete>());
	readonly onComplete = this._onComplete.event;

	private readonly _onPermissionAsked = this._register(new Emitter<{ sessionID: string; requestID: string; toolName: string; args: unknown }>());
	readonly onPermissionAsked = this._onPermissionAsked.event;

	private readonly _abort = new AbortController();

	constructor(
		client: OpenCodeClient,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		client.connectSSE(event => this._handleEvent(event), this._abort.signal);
	}

	private _handleEvent(event: OpenCodeAPI.SSEEvent): void {
		const { type, properties } = event.payload;

		switch (type) {
			case 'message.part.delta': {
				const sessionID = properties['sessionID'] as string;
				if (!sessionID) {
					break;
				}
				const partType = properties['type'] as string;
				const progress: IChatProgress[] = [];

				if (partType === 'text') {
					const text = properties['delta'] as string ?? properties['text'] as string ?? '';
					progress.push({
						kind: 'markdownContent',
						content: new MarkdownString(text),
					});
				} else if (partType === 'reasoning') {
					const text = properties['delta'] as string ?? properties['reasoning'] as string ?? '';
					progress.push({
						kind: 'markdownContent',
						content: new MarkdownString(`*Thinking:* ${text}`),
					});
				}

				if (progress.length > 0) {
					this._onProgress.fire({ sessionID, progress });
				}
				break;
			}

			case 'message.part.updated': {
				const sessionID = (properties['part'] as Record<string, unknown>)?.['sessionID'] as string;
				const part = properties['part'] as OpenCodeAPI.Part | undefined;
				if (!sessionID || !part) {
					break;
				}

				const progress: IChatProgress[] = [];

				if (part.type === 'tool-invocation') {
					const inv = part.toolInvocation;
					const label = inv.state === 'result'
						? `✓ ${inv.toolName}`
						: `⟳ ${inv.toolName}`;
					progress.push({
						kind: 'progressMessage',
						content: new MarkdownString(label),
					});

					if (inv.state === 'result' && inv.result !== undefined) {
						const resultStr = typeof inv.result === 'string' ? inv.result : JSON.stringify(inv.result, null, 2);
						progress.push({
							kind: 'markdownContent',
							content: new MarkdownString(`\n\`\`\`\n${resultStr}\n\`\`\`\n`),
						});
					}
				} else if (part.type === 'text') {
					progress.push({
						kind: 'markdownContent',
						content: new MarkdownString(part.text),
					});
				}

				if (progress.length > 0) {
					this._onProgress.fire({ sessionID, progress });
				}
				break;
			}

			case 'session.idle': {
				const sessionID = properties['sessionID'] as string;
				if (sessionID) {
					this._onComplete.fire({ sessionID });
				}
				break;
			}

			case 'session.error': {
				const sessionID = properties['sessionID'] as string;
				const message = properties['error'] as string ?? 'Unknown error';
				if (sessionID) {
					this._onProgress.fire({
						sessionID,
						progress: [{
							kind: 'markdownContent',
							content: new MarkdownString(`**Error:** ${message}`),
						}],
					});
					this._onComplete.fire({ sessionID });
				}
				break;
			}

			case 'permission.asked': {
				const sessionID = properties['sessionID'] as string;
				const requestID = properties['requestID'] as string ?? properties['id'] as string;
				const toolName = properties['toolName'] as string ?? 'unknown';
				const args = properties['args'];
				if (sessionID && requestID) {
					this._onPermissionAsked.fire({ sessionID, requestID, toolName, args });
				}
				break;
			}

			case 'server.heartbeat':
			case 'server.connected':
				break;

			default:
				this._logService.trace(`[OpenCode] Unhandled SSE event: ${type}`);
				break;
		}
	}

	override dispose(): void {
		this._abort.abort();
		super.dispose();
	}
}
```

- [ ] **Step 2: Verify no TypeScript errors**

Run: `npm run compile-check-ts-native`

- [ ] **Step 3: Commit**

```bash
git add src/vs/sessions/contrib/opencode/browser/opencodeEventMapper.ts
git commit -m "feat: add OpenCode SSE event mapper"
```

---

### Task 4: OpenCode Session Handler

**Files:**
- Create: `src/vs/sessions/contrib/opencode/browser/opencodeSessionHandler.ts`

- [ ] **Step 1: Create the IChatSessionContentProvider implementation**

```typescript
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IChatProgress } from '../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { IChatSession, IChatSessionContentProvider, IChatSessionHistoryItem } from '../../../../workbench/contrib/chat/common/chatSessionsService.js';
import { OpenCodeClient, OpenCodeAPI } from '../common/opencode.js';
import { OpenCodeEventMapper } from './opencodeEventMapper.js';

class OpenCodeChatSession extends Disposable implements IChatSession {

	readonly progressObs = observableValue<IChatProgress[]>('opencodeProgress', []);
	readonly isCompleteObs = observableValue<boolean>('opencodeComplete', true);

	private readonly _onWillDispose = this._register(new Emitter<void>());
	readonly onWillDispose = this._onWillDispose.event;

	readonly requestHandler: IChatSession['requestHandler'];
	readonly interruptActiveResponseCallback: IChatSession['interruptActiveResponseCallback'];

	constructor(
		readonly sessionResource: URI,
		readonly history: readonly IChatSessionHistoryItem[],
		private readonly _opencodeSessionID: string,
		private readonly _client: OpenCodeClient,
		private readonly _eventMapper: OpenCodeEventMapper,
		private readonly _logService: ILogService,
	) {
		super();

		this._register(toDisposable(() => this._onWillDispose.fire()));

		// Listen for progress events for our session
		this._register(this._eventMapper.onProgress(e => {
			if (e.sessionID === this._opencodeSessionID) {
				const current = this.progressObs.get();
				this.progressObs.set([...current, ...e.progress], undefined);
			}
		}));

		// Listen for completion
		this._register(this._eventMapper.onComplete(e => {
			if (e.sessionID === this._opencodeSessionID) {
				this.isCompleteObs.set(true, undefined);
			}
		}));

		this.requestHandler = async (request, _progress, _history, token) => {
			this._logService.info('[OpenCode] requestHandler called');
			this.isCompleteObs.set(false, undefined);
			this.progressObs.set([], undefined);

			const input: OpenCodeAPI.PromptInput = {
				parts: [{ type: 'text', text: request.message }],
			};

			token.onCancellationRequested(() => {
				this._client.abort(this._opencodeSessionID);
			});

			await this._client.promptAsync(this._opencodeSessionID, input);
			// Response comes via SSE events → progressObs / isCompleteObs
		};

		this.interruptActiveResponseCallback = async () => {
			await this._client.abort(this._opencodeSessionID);
			return true;
		};
	}
}

export class OpenCodeSessionHandler extends Disposable implements IChatSessionContentProvider {

	static readonly SESSION_TYPE = 'opencode';

	constructor(
		private readonly _client: OpenCodeClient,
		private readonly _eventMapper: OpenCodeEventMapper,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
	}

	async provideChatSessionContent(sessionResource: URI, _token: CancellationToken): Promise<IChatSession> {
		const resourceKey = sessionResource.path.substring(1);
		const isUntitled = resourceKey.startsWith('untitled-');

		let opencodeSession: OpenCodeAPI.SessionInfo;
		let history: IChatSessionHistoryItem[] = [];

		if (isUntitled) {
			// Create a new OpenCode session
			opencodeSession = await this._client.createSession();
			this._logService.info(`[OpenCode] Created new session: ${opencodeSession.id}`);
		} else {
			// Load existing session
			opencodeSession = await this._client.getSession(resourceKey);
			const messages = await this._client.getMessages(resourceKey);
			history = this._messagesToHistory(messages);
			this._logService.info(`[OpenCode] Loaded session: ${opencodeSession.id}, ${messages.length} messages`);
		}

		const store = new DisposableStore();
		const session = store.add(new OpenCodeChatSession(
			sessionResource,
			history,
			opencodeSession.id,
			this._client,
			this._eventMapper,
			this._logService,
		));

		return session;
	}

	private _messagesToHistory(messages: OpenCodeAPI.MessageWithParts[]): IChatSessionHistoryItem[] {
		const result: IChatSessionHistoryItem[] = [];
		for (const msg of messages) {
			if (msg.info.role === 'user') {
				const text = msg.parts
					.filter((p): p is OpenCodeAPI.TextPart => p.type === 'text')
					.map(p => p.text)
					.join('\n');
				result.push({
					type: 'request',
					prompt: text,
					participant: 'opencode',
				});
			} else if (msg.info.role === 'assistant') {
				const progress: IChatProgress[] = [];
				for (const part of msg.parts) {
					if (part.type === 'text') {
						const { MarkdownString } = require('../../../../../base/common/htmlContent.js');
						progress.push({
							kind: 'markdownContent',
							content: new MarkdownString(part.text),
						});
					}
				}
				result.push({
					type: 'response',
					parts: progress,
					participant: 'opencode',
				});
			}
		}
		return result;
	}
}
```

- [ ] **Step 2: Verify no TypeScript errors**

Run: `npm run compile-check-ts-native`

- [ ] **Step 3: Commit**

```bash
git add src/vs/sessions/contrib/opencode/browser/opencodeSessionHandler.ts
git commit -m "feat: add OpenCode session handler"
```

---

### Task 5: OpenCode Session List Controller

**Files:**
- Create: `src/vs/sessions/contrib/opencode/browser/opencodeSessionListController.ts`

- [ ] **Step 1: Create the IChatSessionItemController implementation**

```typescript
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ChatSessionStatus, IChatSessionItem, IChatSessionItemController, IChatSessionItemsDelta } from '../../../../workbench/contrib/chat/common/chatSessionsService.js';
import { OpenCodeClient } from '../common/opencode.js';
import { OpenCodeSessionHandler } from './opencodeSessionHandler.js';
import { OpenCodeEventMapper } from './opencodeEventMapper.js';

export class OpenCodeSessionListController extends Disposable implements IChatSessionItemController {

	private readonly _onDidChangeChatSessionItems = this._register(new Emitter<IChatSessionItemsDelta>());
	readonly onDidChangeChatSessionItems = this._onDidChangeChatSessionItems.event;

	private _items: IChatSessionItem[] = [];

	constructor(
		private readonly _client: OpenCodeClient,
		eventMapper: OpenCodeEventMapper,
	) {
		super();

		// React to session events for incremental updates
		this._register(eventMapper.onComplete(() => {
			this.refresh(CancellationToken.None);
		}));
	}

	get items(): readonly IChatSessionItem[] {
		return this._items;
	}

	async refresh(_token: CancellationToken): Promise<void> {
		try {
			const sessions = await this._client.listSessions();
			this._items = sessions.map(s => ({
				resource: URI.from({ scheme: OpenCodeSessionHandler.SESSION_TYPE, path: `/${s.id}` }),
				label: s.title,
				status: ChatSessionStatus.Completed,
				timing: {
					created: s.time.created,
					lastRequestStarted: s.time.updated,
					lastRequestEnded: s.time.updated,
				},
				archived: s.time.archived !== undefined,
				changes: s.summary ? {
					files: s.summary.files,
					insertions: s.summary.additions,
					deletions: s.summary.deletions,
				} : undefined,
			}));
			this._onDidChangeChatSessionItems.fire({ addedOrUpdated: this._items });
		} catch {
			// Server may be unavailable
		}
	}
}
```

- [ ] **Step 2: Verify no TypeScript errors**

Run: `npm run compile-check-ts-native`

- [ ] **Step 3: Commit**

```bash
git add src/vs/sessions/contrib/opencode/browser/opencodeSessionListController.ts
git commit -m "feat: add OpenCode session list controller"
```

---

### Task 6: OpenCode Contribution (Registration Entry Point)

**Files:**
- Create: `src/vs/sessions/contrib/opencode/browser/opencode.contribution.ts`

- [ ] **Step 1: Create the contribution that wires everything together**

```typescript
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IChatSessionsService } from '../../../../workbench/contrib/chat/common/chatSessionsService.js';
import { OpenCodeProcessManager } from './opencodeProcessManager.js';
import { OpenCodeEventMapper } from './opencodeEventMapper.js';
import { OpenCodeSessionHandler } from './opencodeSessionHandler.js';
import { OpenCodeSessionListController } from './opencodeSessionListController.js';

class OpenCodeContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'sessions.contrib.opencode';

	constructor(
		@IChatSessionsService private readonly _chatSessionsService: IChatSessionsService,
		@ILogService private readonly _logService: ILogService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();
		this._initialize();
	}

	private async _initialize(): Promise<void> {
		// 1. Register session contribution metadata
		this._register(this._chatSessionsService.registerChatSessionContribution({
			type: OpenCodeSessionHandler.SESSION_TYPE,
			name: 'opencode',
			displayName: 'OpenCode',
			description: 'AI coding agent powered by OpenCode',
			inputPlaceholder: 'Ask OpenCode...',
			welcomeTitle: 'OpenCode',
			welcomeMessage: 'Open source AI coding agent. Start typing to begin.',
		}));

		// 2. Start process manager (poll for existing server)
		const port = 4096; // Default OpenCode port; TODO: make configurable
		const processManager = this._register(this._instantiationService.createInstance(OpenCodeProcessManager, port));

		try {
			const client = await processManager.start();
			this._logService.info('[OpenCode] Connected to server, registering session provider');

			// 3. Connect SSE event stream
			const eventMapper = this._register(this._instantiationService.createInstance(OpenCodeEventMapper, client));

			// 4. Register session content provider
			const sessionHandler = this._register(this._instantiationService.createInstance(OpenCodeSessionHandler, client, eventMapper));
			this._register(this._chatSessionsService.registerChatSessionContentProvider(
				OpenCodeSessionHandler.SESSION_TYPE,
				sessionHandler,
			));

			// 5. Register session list controller
			const listController = this._register(new OpenCodeSessionListController(client, eventMapper));
			this._register(this._chatSessionsService.registerChatSessionItemController(
				OpenCodeSessionHandler.SESSION_TYPE,
				listController,
			));

			// Initial refresh
			await listController.refresh(/* token */ { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() { } }) } as any);

		} catch (err) {
			this._logService.warn('[OpenCode] Could not connect to OpenCode server. Make sure `opencode serve` is running.', err);
		}
	}
}

registerWorkbenchContribution2(OpenCodeContribution.ID, OpenCodeContribution, WorkbenchPhase.AfterRestored);
```

- [ ] **Step 2: Verify no TypeScript errors**

Run: `npm run compile-check-ts-native`

- [ ] **Step 3: Commit**

```bash
git add src/vs/sessions/contrib/opencode/browser/opencode.contribution.ts
git commit -m "feat: add OpenCode contribution registration"
```

---

### Task 7: Wire Up Entry Points and Bypass Welcome

**Files:**
- Modify: `src/vs/sessions/sessions.desktop.main.ts:221` (before welcome import)
- Modify: `src/vs/sessions/sessions.web.main.ts:168` (before welcome import)
- Modify: `src/vs/sessions/contrib/welcome/browser/welcome.contribution.ts:145-147`

- [ ] **Step 1: Add OpenCode import to sessions.desktop.main.ts**

Add this line at line 221, before the welcome contribution import:

```typescript
import './contrib/opencode/browser/opencode.contribution.js';
```

- [ ] **Step 2: Add OpenCode import to sessions.web.main.ts**

Add this line at line 168, before the welcome contribution import:

```typescript
import './contrib/opencode/browser/opencode.contribution.js';
```

- [ ] **Step 3: Bypass welcome overlay when OpenCode is available**

In `src/vs/sessions/contrib/welcome/browser/welcome.contribution.ts`, modify the constructor of `SessionsWelcomeContribution` at line 145. Change:

```typescript
if (!this.productService.defaultChatAgent?.chatExtensionId) {
    return;
}
```

to:

```typescript
if (!this.productService.defaultChatAgent?.chatExtensionId) {
    return;
}

// Skip welcome overlay when OpenCode session provider is registered
if (this.chatSessionsService?.getChatSessionContribution?.('opencode')) {
    return;
}
```

This requires adding `IChatSessionsService` to the constructor injection. Add the import and parameter:

Import: `import { IChatSessionsService } from '../../../../workbench/contrib/chat/common/chatSessionsService.js';`

Constructor parameter: `@IChatSessionsService private readonly chatSessionsService: IChatSessionsService,`

- [ ] **Step 4: Verify no TypeScript errors**

Run: `npm run compile-check-ts-native`

- [ ] **Step 5: Commit**

```bash
git add src/vs/sessions/sessions.desktop.main.ts src/vs/sessions/sessions.web.main.ts src/vs/sessions/contrib/welcome/browser/welcome.contribution.ts
git commit -m "feat: wire OpenCode into Sessions entry points and bypass welcome overlay"
```

---

### Task 8: End-to-End Smoke Test

**Files:** None (manual verification)

- [ ] **Step 1: Start OpenCode server**

In a separate terminal, navigate to the workspace and start:

```bash
cd /home/zick/prj/opencode && bun dev serve
```

Wait until it shows the server is running on port 4096.

- [ ] **Step 2: Build and run VS Code**

```bash
cd /home/zick/prj/vscode
npm run watch &   # incremental build
```

Wait for compilation to complete, then:

```bash
./scripts/code-web.sh --port 8080
```

- [ ] **Step 3: Open in browser and verify**

Navigate to `http://localhost:8080/?skip-sessions-welcome`

Verify:
1. Sessions window loads without sign-in overlay
2. Chat input box is visible with "Ask OpenCode..." placeholder
3. Type a message and send — the message goes to OpenCode
4. Response streams back in the chat UI
5. Tool calls show as progress messages

- [ ] **Step 4: Test with Playwright (optional)**

Use Playwright MCP to automate the verification:
- Navigate to `http://localhost:8080/?skip-sessions-welcome`
- Take screenshot to verify UI loaded
- Type in chat input and verify response appears

---

## Notes

- **First demo scope:** Text streaming and tool call display only. Diff previews, permission UI, and model picker are deferred to follow-up tasks.
- **Port configuration:** Hardcoded to 4096 for demo. The target design is still one window-scoped backend process on a VS Code-managed port, not one process per chat session.
- **Process spawning:** This document should be read with the updated process model: VS Code is expected to manage startup and shutdown of the single backend process. Depending on an externally started fixed-port server is only acceptable as a temporary local-debug shortcut, not the product design.
- **EventSource availability:** `EventSource` is available in browser environments. For desktop (Electron renderer), it's also available. If issues arise, fall back to `fetch` with streaming response body.
