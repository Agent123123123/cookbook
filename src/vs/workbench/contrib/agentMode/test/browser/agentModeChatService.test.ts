/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AgentModeChatService, shouldOpenInAgentModeChat } from '../../../agentMode/browser/agentModeChatService.js';
import type { IAgentSessionService } from '../../../agentMode/browser/agentSessionService.js';
import type { IWorkbenchModeService, WorkbenchMode } from '../../../agentMode/browser/agentMode.contribution.js';

suite('AgentModeChatService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('routes only the supported chat-open shapes into Agent Mode', () => {
		assert.deepStrictEqual([
			shouldOpenInAgentModeChat({}),
			shouldOpenInAgentModeChat({ currentWorkbenchMode: 'agent' }),
			shouldOpenInAgentModeChat({ openChatMode: 'agent' }),
			shouldOpenInAgentModeChat({ requestedChatMode: 'agent', openChatMode: 'agent' }),
			shouldOpenInAgentModeChat({ requestedChatMode: 'ask' }),
			shouldOpenInAgentModeChat({ openChatMode: 'edit' }),
			shouldOpenInAgentModeChat({ hasComplexOptions: true }),
			shouldOpenInAgentModeChat({ blockOnResponse: true }),
		], [
			false,
			true,
			true,
			true,
			false,
			false,
			false,
			false,
		]);
	});

	test('opens a new Agent Mode chat session and sends a complete query', async () => {
		const calls: string[] = [];
		let mode: WorkbenchMode = 'editor';
		const modeService: IWorkbenchModeService = {
			_serviceBrand: undefined,
			get mode() { return mode; },
			onDidChangeMode: () => ({ dispose() { } }),
			setMode(nextMode) {
				mode = nextMode;
				calls.push(`mode:${nextMode}`);
			}
		};
		const sessionService: IAgentSessionService = {
			_serviceBrand: undefined,
			sessions: [],
			activeSession: {} as IAgentSessionService['activeSession'],
			onDidChangeActiveSession: () => ({ dispose() { } }),
			getTimelineDisclosureState() {
				return undefined;
			},
			setTimelineDisclosureState() { },
			updateComposerDraft(draft) {
				calls.push(`draft:${draft}`);
			},
			setSelectedAgent() { },
			setSelectedModel() { },
			setActiveSession() { },
			createNewSession() {
				calls.push('new-session');
			},
			seedDeveloperFixture() { },
			async sendComposerPrompt() {
				calls.push('send');
			},
			async stopActiveRequest() { },
			async replyToApproval() { }
		};

		const service = new AgentModeChatService(modeService, sessionService);
		let focusRequests = 0;
		const listener = service.onDidRequestComposerFocus(() => {
			focusRequests++;
		});

		await service.openChat({ newSession: true, query: 'run pwd' });

		listener.dispose();
		service.dispose();

		assert.deepStrictEqual(calls, ['mode:agent', 'new-session', 'draft:run pwd', 'send']);
		assert.strictEqual(mode, 'agent');
		assert.strictEqual(focusRequests, 1);
	});

	test('keeps partial queries in the Agent Mode composer without sending', async () => {
		const calls: string[] = [];
		const modeService: IWorkbenchModeService = {
			_serviceBrand: undefined,
			mode: 'editor',
			onDidChangeMode: () => ({ dispose() { } }),
			setMode(mode) {
				calls.push(`mode:${mode}`);
			}
		};
		const sessionService: IAgentSessionService = {
			_serviceBrand: undefined,
			sessions: [],
			activeSession: {} as IAgentSessionService['activeSession'],
			onDidChangeActiveSession: () => ({ dispose() { } }),
			getTimelineDisclosureState() {
				return undefined;
			},
			setTimelineDisclosureState() { },
			updateComposerDraft(draft) {
				calls.push(`draft:${draft}`);
			},
			setSelectedAgent() { },
			setSelectedModel() { },
			setActiveSession() { },
			createNewSession() { },
			seedDeveloperFixture() { },
			async sendComposerPrompt() {
				calls.push('send');
			},
			async stopActiveRequest() { },
			async replyToApproval() { }
		};

		const service = new AgentModeChatService(modeService, sessionService);
		await service.openChat({ query: '/create-skill ', isPartialQuery: true });
		service.dispose();

		assert.deepStrictEqual(calls, ['mode:agent', 'draft:/create-skill ']);
	});

	test('toggleChat enters Agent Mode and toggles back to Editor Mode', async () => {
		const calls: string[] = [];
		let mode: WorkbenchMode = 'editor';
		const modeService: IWorkbenchModeService = {
			_serviceBrand: undefined,
			get mode() { return mode; },
			onDidChangeMode: () => ({ dispose() { } }),
			setMode(nextMode) {
				mode = nextMode;
				calls.push(`mode:${nextMode}`);
			}
		};
		const sessionService: IAgentSessionService = {
			_serviceBrand: undefined,
			sessions: [],
			activeSession: {} as IAgentSessionService['activeSession'],
			onDidChangeActiveSession: () => ({ dispose() { } }),
			getTimelineDisclosureState() {
				return undefined;
			},
			setTimelineDisclosureState() { },
			updateComposerDraft() {
				assert.fail('toggle should not update draft');
			},
			setSelectedAgent() { },
			setSelectedModel() { },
			setActiveSession() { },
			createNewSession() {
				assert.fail('toggle should not create a session');
			},
			seedDeveloperFixture() { },
			async sendComposerPrompt() {
				assert.fail('toggle should not send');
			},
			async stopActiveRequest() { },
			async replyToApproval() { }
		};

		const service = new AgentModeChatService(modeService, sessionService);
		await service.toggleChat();
		await service.toggleChat();
		service.dispose();

		assert.deepStrictEqual(calls, ['mode:agent', 'mode:editor']);
	});
});
