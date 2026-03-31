/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IRequestService, asJson, asText, isSuccess } from '../../../../platform/request/common/request.js';
import { AgentBackendLocation, IAgentBackendInitializationData, IAgentBackendRuntimeMetadata, IAgentBackendService, IAgentModelSelection, OpenCodeBackendAPI } from '../common/agentBackendService.js';

const OPEN_CODE_BASE_URL = 'http://127.0.0.1:4096';

class OpenCodeClient {
	constructor(
		private readonly _baseUrl: string,
		private readonly _requestService: IRequestService,
	) { }

	async health(): Promise<{ healthy: boolean; version: string }> {
		return this._fetchJson('/global/health');
	}

	async getConfig(): Promise<OpenCodeBackendAPI.Config> {
		return this._fetchJson('/config');
	}

	async getAgents(): Promise<OpenCodeBackendAPI.AgentInfo[]> {
		const response = await this._fetchJson<OpenCodeBackendAPI.AgentInfo[] | { value?: OpenCodeBackendAPI.AgentInfo[]; Count?: number }>('/agent');
		if (Array.isArray(response)) {
			return response;
		}

		return response.value ?? [];
	}

	async getProvidersConfig(): Promise<OpenCodeBackendAPI.ProvidersConfigResponse> {
		return this._fetchJson('/config/providers');
	}

	async listSessions(): Promise<OpenCodeBackendAPI.SessionInfo[]> {
		return this._fetchJson('/session?roots=true');
	}

	async createSession(): Promise<OpenCodeBackendAPI.SessionInfo> {
		return this._fetchJson('/session', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: '{}'
		});
	}

	async getSession(sessionId: string): Promise<OpenCodeBackendAPI.SessionInfo> {
		return this._fetchJson(`/session/${sessionId}`);
	}

	async getMessages(sessionId: string): Promise<OpenCodeBackendAPI.MessageWithParts[]> {
		return this._fetchJson(`/session/${sessionId}/message`);
	}

	async listPermissions(): Promise<OpenCodeBackendAPI.PermissionRequest[]> {
		return this._fetchJson('/permission');
	}

	async promptAsync(sessionId: string, prompt: string, agent?: string, model?: IAgentModelSelection): Promise<void> {
		await this._fetchJson(`/session/${sessionId}/prompt_async`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				parts: [{ type: 'text', text: prompt }],
				...(agent ? { agent } : {}),
				...(model ? { model } : {})
			})
		});
	}

	async abort(sessionId: string): Promise<void> {
		await this._fetchJson(`/session/${sessionId}/abort`, { method: 'POST' });
	}

	async replyPermission(sessionId: string, requestId: string, response: 'allow' | 'deny' | 'allowAll'): Promise<void> {
		const reply = response === 'allow'
			? 'once'
			: response === 'allowAll'
				? 'always'
				: 'reject';

		try {
			await this._fetchJson(`/permission/${requestId}/reply`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ reply })
			});
			return;
		} catch {
			await this._fetchJson(`/session/${sessionId}/permissions/${requestId}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ response })
			});
		}
	}

	private async _fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
		const method = init?.method ?? 'GET';
		const context = await this._requestService.request({
			type: method,
			url: `${this._baseUrl}${path}`,
			headers: init?.headers as Record<string, string | string[] | undefined> | undefined,
			data: typeof init?.body === 'string' ? init.body : undefined,
			callSite: this._createCallSite(method, path)
		}, CancellationToken.None);

		if (!isSuccess(context)) {
			const errorBody = (await asText(context))?.trim();
			const statusCode = context.res.statusCode ?? 0;
			throw new Error(errorBody
				? `OpenCode request failed (${method} ${path}): ${statusCode} ${errorBody}`
				: `OpenCode request failed (${method} ${path}): ${statusCode}`);
		}

		const data = await asJson<T>(context);
		return (data ?? undefined) as T;
	}

	private _createCallSite(method: string, path: string): string {
		const normalizedPath = path.replace(/^\//, '').replace(/[^a-z0-9]+/gi, '.');
		return `agentMode.openCode.${method.toLowerCase()}.${normalizedPath || 'root'}`;
	}
}

class AgentBackendService extends Disposable implements IAgentBackendService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidReceiveEvent = this._register(new Emitter<OpenCodeBackendAPI.SSEEvent>());
	readonly onDidReceiveEvent = this._onDidReceiveEvent.event;

	private readonly _onDidDisconnect = this._register(new Emitter<void>());
	readonly onDidDisconnect = this._onDidDisconnect.event;

	private readonly _client: OpenCodeClient;
	private _eventSource: EventSource | undefined;

	get location(): AgentBackendLocation {
		return AgentBackendLocation.Local;
	}

	get ownedByCurrentWindow(): boolean {
		return false;
	}

	get connectionLabel(): string {
		return OPEN_CODE_BASE_URL;
	}

	get eventStreamAvailable(): boolean {
		return !!this._eventSource;
	}

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IRequestService requestService: IRequestService,
	) {
		super();
		this._client = new OpenCodeClient(OPEN_CODE_BASE_URL, requestService);
	}

	async initialize(): Promise<IAgentBackendInitializationData> {
		const [health, config, providersConfig, agents] = await Promise.all([
			this._client.health(),
			this._client.getConfig(),
			this._client.getProvidersConfig(),
			this._client.getAgents()
		]);

		this._ensureEventSource();

		return {
			health,
			config,
			providersConfig,
			agents,
			runtime: this._getRuntimeMetadata(),
		};
	}

	listSessions(): Promise<OpenCodeBackendAPI.SessionInfo[]> {
		return this._client.listSessions();
	}

	createSession(): Promise<OpenCodeBackendAPI.SessionInfo> {
		return this._client.createSession();
	}

	getSession(sessionId: string): Promise<OpenCodeBackendAPI.SessionInfo> {
		return this._client.getSession(sessionId);
	}

	getMessages(sessionId: string): Promise<OpenCodeBackendAPI.MessageWithParts[]> {
		return this._client.getMessages(sessionId);
	}

	listPermissions(): Promise<OpenCodeBackendAPI.PermissionRequest[]> {
		return this._client.listPermissions();
	}

	promptAsync(sessionId: string, prompt: string, agent?: string, model?: IAgentModelSelection): Promise<void> {
		return this._client.promptAsync(sessionId, prompt, agent, model);
	}

	abort(sessionId: string): Promise<void> {
		return this._client.abort(sessionId);
	}

	replyPermission(sessionId: string, requestId: string, response: 'allow' | 'deny' | 'allowAll'): Promise<void> {
		return this._client.replyPermission(sessionId, requestId, response);
	}

	private _ensureEventSource(): void {
		if (typeof EventSource === 'undefined' || this._eventSource) {
			return;
		}

		let backendUrl: URL | undefined;
		try {
			backendUrl = new URL(OPEN_CODE_BASE_URL);
		} catch {
			return;
		}

		if (backendUrl.protocol !== 'https:') {
			this._logService.trace('[AgentMode] Skipping direct OpenCode EventSource because workbench CSP blocks non-https backend endpoints from the renderer');
			return;
		}

		try {
			this._eventSource = new EventSource(`${OPEN_CODE_BASE_URL}/global/event`);
			this._eventSource.onmessage = event => {
				try {
					this._onDidReceiveEvent.fire(JSON.parse(event.data) as OpenCodeBackendAPI.SSEEvent);
				} catch (error) {
					this._logService.trace('[AgentMode] Failed to parse OpenCode SSE payload', error);
				}
			};
			this._eventSource.onerror = () => {
				this._eventSource?.close();
				this._eventSource = undefined;
				this._onDidDisconnect.fire();
			};
			this._register({
				dispose: () => {
					this._eventSource?.close();
					this._eventSource = undefined;
				}
			});
		} catch (error) {
			this._logService.warn('[AgentMode] Failed to connect EventSource to OpenCode', error);
		}
	}

	private _getRuntimeMetadata(): IAgentBackendRuntimeMetadata {
		return {
			location: this.location,
			requestedLocation: this.location,
			remoteAuthority: undefined,
			ownedByCurrentWindow: this.ownedByCurrentWindow,
			connectionLabel: this.connectionLabel,
			eventStreamAvailable: this.eventStreamAvailable,
		};
	}
}

registerSingleton(IAgentBackendService, AgentBackendService, InstantiationType.Delayed);
