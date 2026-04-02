/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../base/common/event.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { IProcessEnvironment } from '../../../base/common/platform.js';
import { SSEParser } from '../../../base/common/sseParser.js';
import { ILogService } from '../../log/common/log.js';
import { AgentBackendLocation, IAgentBackendInitializationData, IAgentBackendRuntimeMetadata, IAgentBackendService, IAgentModelSelection, OpenCodeBackendAPI } from '../common/agentBackendService.js';
import { OpenCodeClient } from '../node/opencodeClient.js';
import { OpenCodeProcessManager, OpenCodeProcessState } from './opencodeProcessManager.js';

export interface IAgentBackendLaunchContext {
	readonly cwd?: string;
	readonly env?: IProcessEnvironment;
	readonly requestedLocation: AgentBackendLocation;
	readonly remoteAuthority?: string;
	readonly opencodePath?: string;
}

export class AgentBackendMainService extends Disposable implements IAgentBackendService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidReceiveEvent = this._register(new Emitter<OpenCodeBackendAPI.SSEEvent>());
	readonly onDidReceiveEvent = this._onDidReceiveEvent.event;

	private readonly _onDidDisconnect = this._register(new Emitter<void>());
	readonly onDidDisconnect = this._onDidDisconnect.event;

	private readonly _eventStreamLifecycle = this._register(new MutableDisposable());

	private readonly _processManager: OpenCodeProcessManager;
	private _client: OpenCodeClient | undefined;
	private _eventStreamBaseUrl: string | undefined;
	private _launchContext: IAgentBackendLaunchContext | undefined;

	get location(): AgentBackendLocation {
		return AgentBackendLocation.Local;
	}

	get ownedByCurrentWindow(): boolean {
		return this._processManager.connection?.ownedByWindow ?? false;
	}

	get connectionLabel(): string {
		return this._processManager.connectionLabel;
	}

	get eventStreamAvailable(): boolean {
		return !!this._eventStreamLifecycle.value;
	}

	constructor(
		@ILogService private readonly _logService: ILogService,
		private readonly _resolveLaunchContext: () => Promise<IAgentBackendLaunchContext>,
	) {
		super();
		this._processManager = this._register(new OpenCodeProcessManager(this._logService));
		this._register(this._processManager.onDidChangeState(state => {
			if (state === OpenCodeProcessState.Failed || state === OpenCodeProcessState.Stopped) {
				this._client = undefined;
				this._eventStreamBaseUrl = undefined;
				this._eventStreamLifecycle.clear();
				this._onDidDisconnect.fire();
			}
		}));
	}

	async initialize(): Promise<IAgentBackendInitializationData> {
		const client = await this._getClient();
		const [health, config, providersConfig, agents] = await Promise.all([
			client.health(),
			client.getConfig(),
			client.getProvidersConfig(),
			client.getAgents()
		]);
		await this._ensureEventStream();

		return {
			health,
			config,
			providersConfig,
			agents,
			runtime: this._getRuntimeMetadata(),
		};
	}

	async listSessions(): Promise<OpenCodeBackendAPI.SessionInfo[]> {
		return (await this._getClient()).listSessions();
	}

	async createSession(): Promise<OpenCodeBackendAPI.SessionInfo> {
		return (await this._getClient()).createSession();
	}

	async getSession(sessionId: string): Promise<OpenCodeBackendAPI.SessionInfo> {
		return (await this._getClient()).getSession(sessionId);
	}

	async getMessages(sessionId: string): Promise<OpenCodeBackendAPI.MessageWithParts[]> {
		return (await this._getClient()).getMessages(sessionId);
	}

	async listPermissions(): Promise<OpenCodeBackendAPI.PermissionRequest[]> {
		return (await this._getClient()).listPermissions();
	}

	async promptAsync(sessionId: string, prompt: string, agent?: string, model?: IAgentModelSelection): Promise<void> {
		return (await this._getClient()).promptAsync(sessionId, prompt, agent, model);
	}

	async abort(sessionId: string): Promise<void> {
		return (await this._getClient()).abort(sessionId);
	}

	async replyPermission(sessionId: string, requestId: string, response: 'allow' | 'deny' | 'allowAll'): Promise<void> {
		return (await this._getClient()).replyPermission(sessionId, requestId, response);
	}

	private async _getClient(): Promise<OpenCodeClient> {
		if (this._client) {
			return this._client;
		}

		const launchContext = await this._resolveLaunchContext();
		this._launchContext = launchContext;
		if (launchContext.requestedLocation === AgentBackendLocation.Remote) {
			this._logService.info(`[AgentMode] Remote OpenCode backend requested for authority '${launchContext.remoteAuthority ?? 'unknown'}'. The renderer should route to the remote server channel; this main-process backend serves as a local fallback.`);
		}
		const connection = await this._processManager.start({
			cwd: launchContext.cwd,
			env: launchContext.env,
			command: launchContext.opencodePath,
		});
		this._client = new OpenCodeClient(connection.baseUrl);
		this._eventStreamBaseUrl = connection.baseUrl;
		return this._client;
	}

	private async _ensureEventStream(): Promise<void> {
		if (this._eventStreamLifecycle.value) {
			return;
		}

		const client = await this._getClient();
		const abortController = new AbortController();
		const eventStreamBaseUrl = this._eventStreamBaseUrl ?? client.baseUrl;

		this._eventStreamLifecycle.value = toDisposable(() => abortController.abort());
		void this._consumeEventStream(eventStreamBaseUrl, abortController);
	}

	private async _consumeEventStream(baseUrl: string, abortController: AbortController): Promise<void> {
		try {
			const response = await fetch(`${baseUrl}/global/event`, {
				headers: { Accept: 'text/event-stream' },
				signal: abortController.signal,
			});

			if (!response.ok || !response.body) {
				throw new Error(`OpenCode SSE request failed with status ${response.status}`);
			}

			const reader = response.body.getReader();
			const parser = new SSEParser(event => {
				if (!event.data) {
					return;
				}

				try {
					const parsed = JSON.parse(event.data);
					if (typeof parsed !== 'object' || parsed === null) {
						this._logService.trace('[AgentMode] Ignoring non-object OpenCode SSE payload', parsed);
						return;
					}

					const backendEvent = ('type' in parsed && typeof parsed.type === 'string')
						? parsed as OpenCodeBackendAPI.SSEEvent
						: { ...parsed, type: event.type } as OpenCodeBackendAPI.SSEEvent;

					this._onDidReceiveEvent.fire(backendEvent);
				} catch (error) {
					this._logService.trace('[AgentMode] Failed to parse OpenCode SSE payload', error);
				}
			});

			while (!abortController.signal.aborted) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}

				if (value) {
					parser.feed(value);
				}
			}
		} catch (error) {
			if (abortController.signal.aborted) {
				return;
			}

			this._logService.warn('[AgentMode] OpenCode SSE stream disconnected', error);
		} finally {
			if (this._eventStreamLifecycle.value) {
				this._eventStreamLifecycle.clear();
			}

			if (!abortController.signal.aborted) {
				this._onDidDisconnect.fire();
			}
		}
	}

	private _getRuntimeMetadata(): IAgentBackendRuntimeMetadata {
		return {
			location: this.location,
			requestedLocation: this._launchContext?.requestedLocation ?? AgentBackendLocation.Local,
			remoteAuthority: this._launchContext?.remoteAuthority,
			ownedByCurrentWindow: this.ownedByCurrentWindow,
			connectionLabel: this.connectionLabel,
			eventStreamAvailable: this.eventStreamAvailable,
		};
	}
}
