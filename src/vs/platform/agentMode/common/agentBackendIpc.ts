/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { Disposable, DisposableMap } from '../../../base/common/lifecycle.js';
import { IChannel, IConnectionHub, IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import { AgentBackendLocation, IAgentBackendInitializationData, IAgentBackendService, IAgentModelSelection, OpenCodeBackendAPI } from './agentBackendService.js';

export const AgentBackendChannelName = 'agentModeBackend';

interface IAgentBackendStatusDto {
	location: AgentBackendLocation;
	ownedByCurrentWindow: boolean;
	connectionLabel: string;
	eventStreamAvailable: boolean;
}

export class AgentBackendChannel<TContext> extends Disposable implements IServerChannel<TContext> {

	private readonly _services = this._register(new DisposableMap<TContext, IAgentBackendService & Disposable>());

	constructor(
		private readonly _ipcServer: IConnectionHub<TContext>,
		private readonly _createService: (ctx: TContext) => IAgentBackendService & Disposable,
	) {
		super();
		this._register(this._ipcServer.onDidRemoveConnection(connection => {
			this._services.deleteAndDispose(connection.ctx);
		}));
	}

	listen<T>(ctx: TContext, event: string): Event<T> {
		const service = this._getService(ctx);

		switch (event) {
			case 'onDidReceiveEvent':
				return service.onDidReceiveEvent as Event<T>;
			case 'onDidDisconnect':
				return service.onDidDisconnect as Event<T>;
		}

		throw new Error(`Event not found: ${event}`);
	}

	call<T>(ctx: TContext, command: string, args?: unknown[]): Promise<T> {
		const service = this._getService(ctx);

		switch (command) {
			case '_getStatus':
				return Promise.resolve({
					location: service.location,
					ownedByCurrentWindow: service.ownedByCurrentWindow,
					connectionLabel: service.connectionLabel,
					eventStreamAvailable: service.eventStreamAvailable,
				} satisfies IAgentBackendStatusDto as T);
			case 'initialize':
				return service.initialize() as Promise<T>;
			case 'listSessions':
				return service.listSessions() as Promise<T>;
			case 'createSession':
				return service.createSession() as Promise<T>;
			case 'getSession':
				return service.getSession(args?.[0] as string) as Promise<T>;
			case 'getMessages':
				return service.getMessages(args?.[0] as string) as Promise<T>;
			case 'listPermissions':
				return service.listPermissions() as Promise<T>;
			case 'promptAsync':
				return service.promptAsync(
					args?.[0] as string,
					args?.[1] as string,
					args?.[2] as string | undefined,
					args?.[3] as IAgentModelSelection | undefined,
				) as Promise<T>;
			case 'abort':
				return service.abort(args?.[0] as string) as Promise<T>;
			case 'replyPermission':
				return service.replyPermission(
					args?.[0] as string,
					args?.[1] as string,
					args?.[2] as 'allow' | 'deny' | 'allowAll',
				) as Promise<T>;
		}

		throw new Error(`Call not found: ${command}`);
	}

	private _getService(ctx: TContext): IAgentBackendService & Disposable {
		let service = this._services.get(ctx);
		if (!service) {
			service = this._createService(ctx);
			this._services.set(ctx, service);
		}

		return service;
	}
}

export class AgentBackendChannelClient extends Disposable implements IAgentBackendService {
	declare readonly _serviceBrand: undefined;

	private readonly _status: IAgentBackendStatusDto = {
		location: AgentBackendLocation.Local,
		ownedByCurrentWindow: false,
		connectionLabel: 'OpenCode',
		eventStreamAvailable: false
	};

	readonly onDidReceiveEvent: Event<OpenCodeBackendAPI.SSEEvent>;
	readonly onDidDisconnect: Event<void>;

	get location(): AgentBackendLocation {
		return this._status.location;
	}

	get ownedByCurrentWindow(): boolean {
		return this._status.ownedByCurrentWindow;
	}

	get connectionLabel(): string {
		return this._status.connectionLabel;
	}

	get eventStreamAvailable(): boolean {
		return this._status.eventStreamAvailable;
	}

	constructor(private readonly _channel: IChannel) {
		super();
		this.onDidReceiveEvent = this._channel.listen<OpenCodeBackendAPI.SSEEvent>('onDidReceiveEvent');
		this.onDidDisconnect = Event.map(this._channel.listen<void>('onDidDisconnect'), () => {
			this._status.eventStreamAvailable = false;
		});
		void this._refreshStatus();
	}

	async initialize(): Promise<IAgentBackendInitializationData> {
		const result = await this._channel.call<IAgentBackendInitializationData>('initialize');
		await this._refreshStatus();
		return result;
	}

	listSessions(): Promise<OpenCodeBackendAPI.SessionInfo[]> {
		return this._channel.call('listSessions');
	}

	createSession(): Promise<OpenCodeBackendAPI.SessionInfo> {
		return this._channel.call('createSession');
	}

	getSession(sessionId: string): Promise<OpenCodeBackendAPI.SessionInfo> {
		return this._channel.call('getSession', [sessionId]);
	}

	getMessages(sessionId: string): Promise<OpenCodeBackendAPI.MessageWithParts[]> {
		return this._channel.call('getMessages', [sessionId]);
	}

	listPermissions(): Promise<OpenCodeBackendAPI.PermissionRequest[]> {
		return this._channel.call('listPermissions');
	}

	promptAsync(sessionId: string, prompt: string, agent?: string, model?: IAgentModelSelection): Promise<void> {
		return this._channel.call('promptAsync', [sessionId, prompt, agent, model]);
	}

	abort(sessionId: string): Promise<void> {
		return this._channel.call('abort', [sessionId]);
	}

	replyPermission(sessionId: string, requestId: string, response: 'allow' | 'deny' | 'allowAll'): Promise<void> {
		return this._channel.call('replyPermission', [sessionId, requestId, response]);
	}

	private async _refreshStatus(): Promise<void> {
		const status = await this._channel.call<IAgentBackendStatusDto>('_getStatus');
		this._status.location = status.location;
		this._status.ownedByCurrentWindow = status.ownedByCurrentWindow;
		this._status.connectionLabel = status.connectionLabel;
		this._status.eventStreamAvailable = status.eventStreamAvailable;
	}
}
