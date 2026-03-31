/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event, Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IAgentSessionService } from './agentSessionService.js';
import { IWorkbenchModeService } from './agentMode.contribution.js';

export interface IAgentModeChatOpenOptions {
	readonly query?: string;
	readonly isPartialQuery?: boolean;
	readonly newSession?: boolean;
}

export interface IAgentModeChatRouteRequest {
	readonly requestedChatMode?: string;
	readonly openChatMode?: string;
	readonly currentWorkbenchMode?: 'editor' | 'agent';
	readonly hasComplexOptions?: boolean;
	readonly blockOnResponse?: boolean;
}

export function shouldOpenInAgentModeChat(request: IAgentModeChatRouteRequest): boolean {
	if (request.hasComplexOptions || request.blockOnResponse) {
		return false;
	}

	if (request.requestedChatMode && request.requestedChatMode.toLowerCase() !== 'agent') {
		return false;
	}

	if (request.openChatMode && request.openChatMode.toLowerCase() !== 'agent') {
		return false;
	}

	if (request.requestedChatMode?.toLowerCase() === 'agent' || request.openChatMode?.toLowerCase() === 'agent') {
		return true;
	}

	return request.currentWorkbenchMode === 'agent';
}

export interface IAgentModeChatService {
	readonly _serviceBrand: undefined;
	readonly onDidRequestComposerFocus: Event<void>;
	openChat(options?: IAgentModeChatOpenOptions): Promise<void>;
	toggleChat(): Promise<void>;
}

export const IAgentModeChatService = createDecorator<IAgentModeChatService>('agentModeChatService');

export class AgentModeChatService extends Disposable implements IAgentModeChatService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidRequestComposerFocus = this._register(new Emitter<void>());
	readonly onDidRequestComposerFocus = this._onDidRequestComposerFocus.event;

	constructor(
		@IWorkbenchModeService private readonly _workbenchModeService: IWorkbenchModeService,
		@IAgentSessionService private readonly _agentSessionService: IAgentSessionService,
	) {
		super();
	}

	async openChat(options?: IAgentModeChatOpenOptions): Promise<void> {
		this._workbenchModeService.setMode('agent');

		if (options?.newSession) {
			this._agentSessionService.createNewSession();
		}

		if (options?.query !== undefined) {
			this._agentSessionService.updateComposerDraft(options.query);
			if (!options.isPartialQuery && options.query.trim()) {
				await this._agentSessionService.sendComposerPrompt();
			}
		}

		this._onDidRequestComposerFocus.fire();
	}

	async toggleChat(): Promise<void> {
		if (this._workbenchModeService.mode === 'agent') {
			this._workbenchModeService.setMode('editor');
			return;
		}

		await this.openChat();
	}
}

registerSingleton(IAgentModeChatService, AgentModeChatService, InstantiationType.Delayed);
