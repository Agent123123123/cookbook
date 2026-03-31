/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildAgentConversationTurns, cleanupAgentSessionTitle, deriveAgentSessionExecutionPhase, deriveAgentSessionSummaryStatusTone, getAgentComposerStateForPhase, getAgentSessionDisplayPreview, getAgentSessionDisplayTitle, normalizeOpenCodePart, shouldSurfaceStepFinishReason, type IAgentExecutionPhaseMessage, type IAgentTimelineItem } from '../../../agentMode/browser/agentSessionService.js';

suite('AgentSessionService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('completed assistant message with mismatched step ids does not stay running', () => {
		const messages: IAgentExecutionPhaseMessage[] = [{
			info: {
				role: 'assistant',
				time: { completed: Date.now() }
			},
			parts: [
				{ type: 'step-start', id: 'step-start-1' },
				{ type: 'step-finish', id: 'step-finish-1' },
				{ type: 'text', text: 'Done.' }
			]
		}];

		assert.deepStrictEqual(
			deriveAgentSessionExecutionPhase('running', messages, []),
			'idle'
		);
	});

	test('stale incomplete assistant message does not revive an idle session', () => {
		const messages: IAgentExecutionPhaseMessage[] = [{
			info: {
				role: 'assistant'
			},
			parts: [{ type: 'text', text: 'Still working' }]
		}];

		assert.deepStrictEqual(
			deriveAgentSessionExecutionPhase('idle', messages, []),
			'idle'
		);
	});

	test('waiting approval beats running heuristics', () => {
		const timeline: Pick<IAgentTimelineItem, 'phase'>[] = [{ phase: 'waitingApproval' }];

		assert.deepStrictEqual(
			deriveAgentSessionExecutionPhase('running', [], timeline),
			'waitingApproval'
		);
	});

	test('incomplete assistant message keeps an active session running', () => {
		const messages: IAgentExecutionPhaseMessage[] = [{
			info: {
				role: 'assistant'
			},
			parts: [{ type: 'text', text: 'Still working' }]
		}];

		assert.deepStrictEqual(
			deriveAgentSessionExecutionPhase('running', messages, []),
			'running'
		);
	});

	test('waiting approval uses a dedicated composer state', () => {
		assert.deepStrictEqual(
			getAgentComposerStateForPhase('waitingApproval'),
			'waitingApproval'
		);
	});

	test('step finish visibility hides normal completion reasons', () => {
		assert.deepStrictEqual([
			shouldSurfaceStepFinishReason(undefined),
			shouldSurfaceStepFinishReason('stop'),
			shouldSurfaceStepFinishReason('completed'),
			shouldSurfaceStepFinishReason('max_tokens'),
			shouldSurfaceStepFinishReason('end_turn'),
			shouldSurfaceStepFinishReason('tool_use')
		], [
			false,
			false,
			false,
			false,
			false,
			false
		]);
	});

	test('step finish visibility surfaces exceptional reasons', () => {
		assert.deepStrictEqual([
			shouldSurfaceStepFinishReason('cancelled'),
			shouldSurfaceStepFinishReason('failed'),
			shouldSurfaceStepFinishReason('timeout')
		], [
			true,
			true,
			true
		]);
	});

	test('summary status tone follows canonical session phase', () => {
		assert.deepStrictEqual([
			deriveAgentSessionSummaryStatusTone('Draft', 'idle'),
			deriveAgentSessionSummaryStatusTone('Idle', 'idle'),
			deriveAgentSessionSummaryStatusTone('Idle', 'running'),
			deriveAgentSessionSummaryStatusTone('Idle', 'waitingApproval'),
			deriveAgentSessionSummaryStatusTone('Idle', 'error'),
			deriveAgentSessionSummaryStatusTone('Idle', 'offline')
		], [
			'draft',
			'idle',
			'running',
			'warning',
			'error',
			'offline'
		]);
	});

	test('summary status tone ignores stale running labels once the phase settles', () => {
		assert.deepStrictEqual(
			deriveAgentSessionSummaryStatusTone('Running', 'idle'),
			'idle'
		);

		assert.deepStrictEqual(
			deriveAgentSessionSummaryStatusTone('Running', 'waitingApproval'),
			'warning'
		);
	});

	test('session title cleanup trims generic backend titles', () => {
		assert.strictEqual(cleanupAgentSessionTitle('New session - 2026-03-28'), 'New session');
		assert.strictEqual(cleanupAgentSessionTitle('  Untitled session  '), 'Untitled session');
	});

	test('session display title promotes the preview when the title is generic', () => {
		assert.strictEqual(
			getAgentSessionDisplayTitle('New session', 'Inspect the current workspace changes before continuing with the refactor'),
			'Inspect the current workspace changes before continui…'
		);
	});

	test('session display title uses title suffix when preview is unavailable', () => {
		assert.strictEqual(
			getAgentSessionDisplayTitle('New session - Fix the login bug', undefined),
			'Fix the login bug'
		);
		assert.strictEqual(
			getAgentSessionDisplayTitle('New session - 2026-03-28', 'Refactor the widget'),
			'Refactor the widget'
		);
		assert.strictEqual(
			getAgentSessionDisplayTitle('New session', undefined),
			'New session'
		);
	});

	test('session display preview avoids repeating the title and falls back to state copy', () => {
		assert.strictEqual(
			getAgentSessionDisplayPreview('Inspect the current workspace changes', 'Inspect the current workspace changes', 'Idle'),
			'Ready for the next prompt.'
		);

		assert.strictEqual(
			getAgentSessionDisplayPreview(undefined, 'New session', 'Draft', true),
			'Loading preview...'
		);
	});

	test('normalizes a running legacy tool part into a tool invocation', () => {
		const normalized = normalizeOpenCodePart({
			type: 'tool',
			tool: 'bash',
			callID: 'call-1',
			state: {
				status: 'running',
				input: {
					command: 'pwd',
					workdir: '/',
					description: 'seed bash permission request'
				}
			}
		});

		assert.deepStrictEqual(normalized, {
			type: 'tool-invocation',
			toolInvocation: {
				toolName: 'bash',
				toolCallId: 'call-1',
				state: 'call',
				args: {
					command: 'pwd',
					workdir: '/',
					description: 'seed bash permission request'
				}
			}
		});
	});

	test('normalizes a completed legacy tool part into a tool result while preserving command context', () => {
		const normalized = normalizeOpenCodePart({
			type: 'tool',
			tool: 'bash',
			callID: 'call-2',
			state: {
				status: 'completed',
				input: {
					command: 'pwd'
				},
				output: {
					exitCode: 0,
					stdout: '/workspace'
				}
			}
		});

		assert.deepStrictEqual(normalized, {
			type: 'tool-result',
			toolResult: {
				toolName: 'bash',
				toolCallId: 'call-2',
				result: {
					command: 'pwd',
					exitCode: 0,
					stdout: '/workspace'
				}
			}
		});
	});

	test('normalizes a legacy approval wait into a waiting-approval invocation', () => {
		const normalized = normalizeOpenCodePart({
			type: 'tool',
			tool: 'bash',
			callID: 'call-3',
			state: {
				status: 'needs-approval',
				input: {
					command: 'pwd'
				}
			}
		});

		assert.deepStrictEqual(normalized, {
			type: 'tool-invocation',
			toolInvocation: {
				toolName: 'bash',
				toolCallId: 'call-3',
				state: 'waiting-approval',
				args: {
					command: 'pwd'
				}
			}
		});
	});

	test('groups a flat timeline into a conversation turn with attachments and footer meta', () => {
		const timeline: IAgentTimelineItem[] = [
			{
				id: 'user-1',
				kind: 'user',
				label: 'You',
				body: 'Check the workspace'
			},
			{
				id: 'reasoning-1',
				kind: 'reasoning',
				label: 'Reasoning',
				body: 'Need to inspect files.',
				sourceMessageId: 'assistant-1'
			},
			{
				id: 'command-1',
				kind: 'command',
				label: 'Command',
				title: 'Completed',
				body: 'Completed',
				code: 'git status --short',
				sourceMessageId: 'assistant-1',
				phase: 'succeeded'
			},
			{
				id: 'assistant-1',
				kind: 'assistant',
				label: 'Agent',
				body: 'Workspace is clean.'
			},
			{
				id: 'status-1',
				kind: 'status',
				label: 'Execution',
				title: 'Execution',
				body: 'Completed',
				meta: ['120 tokens']
			}
		];

		assert.deepStrictEqual(buildAgentConversationTurns(timeline, false), [
			{
				id: 'user-1',
				userMessage: timeline[0],
				assistantMessage: timeline[3],
				attachments: [
					{
						id: 'reasoning-1',
						kind: 'reasoning',
						summary: 'Need to inspect files.',
						expandedByDefault: false,
						item: timeline[1]
					},
					{
						id: 'command-1',
						kind: 'command',
						summary: 'git status --short',
						expandedByDefault: false,
						item: timeline[2]
					}
				],
				statusMeta: ['Execution'],
				hasPendingApproval: false
			}
		]);
	});

	test('keeps pending approval attached to its originating assistant turn', () => {
		const timeline: IAgentTimelineItem[] = [
			{
				id: 'assistant-1',
				kind: 'assistant',
				label: 'Agent',
				body: 'I need permission before continuing.'
			},
			{
				id: 'approval-1',
				kind: 'approval',
				label: 'Approval required',
				title: 'bash',
				body: 'OpenCode is waiting for permission to run this command.',
				code: 'git status --short',
				sourceMessageId: 'assistant-1',
				phase: 'waitingApproval'
			}
		];

		assert.deepStrictEqual(buildAgentConversationTurns(timeline, true), [
			{
				id: 'assistant-1',
				userMessage: undefined,
				assistantMessage: timeline[0],
				attachments: [
					{
						id: 'approval-1',
						kind: 'approval',
						summary: 'git status --short',
						expandedByDefault: true,
						item: timeline[1]
					}
				],
				statusMeta: undefined,
				hasPendingApproval: true
			}
		]);
	});
});
