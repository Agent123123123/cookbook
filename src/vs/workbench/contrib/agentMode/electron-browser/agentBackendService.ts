/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { AgentBackendChannelClient, AgentBackendChannelName } from '../../../../platform/agentMode/common/agentBackendIpc.js';
import { AgentBackendLocation, IAgentBackendInitializationData, IAgentBackendService, IAgentModelSelection, OpenCodeBackendAPI } from '../common/agentBackendService.js';
import { IRemoteAgentService } from '../../../services/remote/common/remoteAgentService.js';

/**
 * Desktop (Electron) agent backend service that routes to the appropriate
 * backend depending on whether a remote connection is active:
 *
 * - **No remote**: delegates to the Electron main process via IPC
 * - **Remote (WSL / SSH)**: delegates to the VS Code Server via the remote channel
 */
class AgentBackendDesktopService extends Disposable implements IAgentBackendService {
	declare readonly _serviceBrand: undefined;

	private readonly _delegate: AgentBackendChannelClient;

	readonly onDidReceiveEvent: Event<OpenCodeBackendAPI.SSEEvent>;
	readonly onDidDisconnect: Event<void>;

	get location(): AgentBackendLocation {
		return this._delegate.location;
	}

	get ownedByCurrentWindow(): boolean {
		return this._delegate.ownedByCurrentWindow;
	}

	get connectionLabel(): string {
		return this._delegate.connectionLabel;
	}

	get eventStreamAvailable(): boolean {
		return this._delegate.eventStreamAvailable;
	}

	constructor(
		@IRemoteAgentService remoteAgentService: IRemoteAgentService,
		@IMainProcessService mainProcessService: IMainProcessService,
		@ILogService logService: ILogService,
	) {
		super();

		const remoteConnection = remoteAgentService.getConnection();
		if (remoteConnection?.remoteAuthority) {
			logService.info(`[AgentMode] Remote authority detected (${remoteConnection.remoteAuthority}). Using remote agent backend channel.`);
			const remoteChannel = remoteConnection.getChannel(AgentBackendChannelName);
			this._delegate = this._register(new AgentBackendChannelClient(remoteChannel));
		} else {
			const mainChannel = mainProcessService.getChannel(AgentBackendChannelName);
			this._delegate = this._register(new AgentBackendChannelClient(mainChannel));
		}

		this.onDidReceiveEvent = this._delegate.onDidReceiveEvent;
		this.onDidDisconnect = this._delegate.onDidDisconnect;
	}

	initialize(): Promise<IAgentBackendInitializationData> {
		return this._delegate.initialize();
	}

	listSessions(): Promise<OpenCodeBackendAPI.SessionInfo[]> {
		return this._delegate.listSessions();
	}

	createSession(): Promise<OpenCodeBackendAPI.SessionInfo> {
		return this._delegate.createSession();
	}

	getSession(sessionId: string): Promise<OpenCodeBackendAPI.SessionInfo> {
		return this._delegate.getSession(sessionId);
	}

	getMessages(sessionId: string): Promise<OpenCodeBackendAPI.MessageWithParts[]> {
		return this._delegate.getMessages(sessionId);
	}

	listPermissions(): Promise<OpenCodeBackendAPI.PermissionRequest[]> {
		return this._delegate.listPermissions();
	}

	promptAsync(sessionId: string, prompt: string, agent?: string, model?: IAgentModelSelection): Promise<void> {
		return this._delegate.promptAsync(sessionId, prompt, agent, model);
	}

	abort(sessionId: string): Promise<void> {
		return this._delegate.abort(sessionId);
	}

	replyPermission(sessionId: string, requestId: string, response: 'allow' | 'deny' | 'allowAll'): Promise<void> {
		return this._delegate.replyPermission(sessionId, requestId, response);
	}
}

registerSingleton(IAgentBackendService, AgentBackendDesktopService, InstantiationType.Delayed);
