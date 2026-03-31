/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { hasKey } from '../../../../base/common/types.js';
import { timeout } from '../../../../base/common/async.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { AgentBackendLocation, IAgentBackendRuntimeMetadata, IAgentBackendService } from '../common/agentBackendService.js';

export type AgentTimelineItemKind = 'user' | 'assistant' | 'reasoning' | 'tool' | 'command' | 'patch' | 'approval' | 'status' | 'error';
export type AgentTimelineTone = 'neutral' | 'running' | 'success' | 'warning' | 'error';
export type AgentProcessPhase = 'pending' | 'running' | 'waitingApproval' | 'succeeded' | 'failed' | 'cancelled';
export type AgentSessionPhase = 'idle' | 'running' | 'waitingApproval' | 'error' | 'offline';
export type AgentSessionSummaryTone = 'draft' | 'running' | 'warning' | 'idle' | 'error' | 'offline';

export type AgentComposerState = 'idle' | 'running' | 'waitingApproval' | 'stopped' | 'error' | 'offline';

export interface IAgentTimelineDetail {
	readonly label: string;
	readonly value: string;
}

export interface IAgentTimelineSection {
	readonly label: string;
	readonly type: 'list' | 'code';
	readonly presentation?: 'default' | 'stdout' | 'stderr' | 'scope';
	readonly items?: readonly string[];
	readonly value?: string;
}

export interface IAgentTimelineItem {
	readonly id: string;
	readonly kind: AgentTimelineItemKind;
	readonly label: string;
	readonly title?: string;
	readonly body: string;
	readonly bullets?: readonly string[];
	readonly meta?: readonly string[];
	readonly code?: string;
	readonly details?: readonly IAgentTimelineDetail[];
	readonly sections?: readonly IAgentTimelineSection[];
	readonly rawData?: string;
	readonly tone?: AgentTimelineTone;
	readonly permissionRequestId?: string;
	readonly filePaths?: readonly string[];
	readonly sourceMessageId?: string;
	readonly processGroupId?: string;
	readonly phase?: AgentProcessPhase;
	readonly stateLabel?: string;
}

export type AgentTurnAttachmentKind = 'reasoning' | 'command' | 'tool' | 'patch' | 'approval' | 'debug';

export interface IAgentTurnAttachment {
	readonly id: string;
	readonly kind: AgentTurnAttachmentKind;
	readonly summary: string;
	readonly expandedByDefault: boolean;
	readonly item: IAgentTimelineItem;
}

export interface IAgentConversationTurn {
	readonly id: string;
	readonly userMessage?: IAgentTimelineItem;
	readonly assistantMessage?: IAgentTimelineItem;
	readonly attachments: readonly IAgentTurnAttachment[];
	readonly statusMeta?: readonly string[];
	readonly hasPendingApproval: boolean;
}

interface IMutableAgentConversationTurn {
	id: string;
	userMessage?: IAgentTimelineItem;
	assistantMessage?: IAgentTimelineItem;
	attachments: IAgentTurnAttachment[];
	statusMeta: string[];
	hasPendingApproval: boolean;
}

export function shouldSurfaceStepFinishReason(reason: string | undefined): boolean {
	const normalizedReason = reason?.trim().toLowerCase();
	if (!normalizedReason) {
		return false;
	}

	const suppressedReasons = [
		'completed', 'complete', 'success', 'succeeded', 'done',
		'stop', 'stopped', 'end_turn', 'end', 'finish', 'finished',
		'max_tokens', 'length', 'tool_use', 'tool_calls', 'tool calls'
	];
	return !suppressedReasons.includes(normalizedReason);
}

const genericSessionTitleRe = /^(new session(?:\s*-\s*.*)?|session|untitled(?: session)?|chat)$/i;

export function cleanupAgentSessionTitle(title: string | undefined): string {
	const normalized = title?.trim();
	if (!normalized) {
		return 'New session';
	}

	return normalized.startsWith('New session - ') ? 'New session' : normalized;
}

export function getAgentSessionDisplayTitle(title: string | undefined, preview: string | undefined): string {
	const cleanedTitle = cleanupAgentSessionTitle(title);
	if (!isGenericAgentSessionTitle(cleanedTitle)) {
		return cleanedTitle;
	}

	if (getAgentSessionSnippet(preview, 54)) {
		return getAgentSessionSnippet(preview, 54)!;
	}

	const suffix = extractSessionTitleSuffix(title);
	if (suffix) {
		return suffix;
	}

	return cleanedTitle;
}

export function getAgentSessionDisplayPreview(preview: string | undefined, title: string | undefined, status: string, previewLoading = false): string {
	const normalizedPreview = getAgentSessionSnippet(preview, 96);
	const normalizedTitle = getAgentSessionSnippet(title, 96);
	if (previewLoading && !normalizedPreview) {
		return 'Loading preview...';
	}

	if (normalizedPreview && normalizedTitle && normalizeAgentSessionText(normalizedPreview) === normalizeAgentSessionText(normalizedTitle)) {
		return getAgentSessionPreviewFallback(status);
	}

	return normalizedPreview ?? getAgentSessionPreviewFallback(status);
}

function isGenericAgentSessionTitle(title: string | undefined): boolean {
	return genericSessionTitleRe.test(cleanupAgentSessionTitle(title));
}

function extractSessionTitleSuffix(title: string | undefined): string | undefined {
	const prefix = 'New session - ';
	const normalized = title?.trim();
	if (normalized && normalized.startsWith(prefix)) {
		return getAgentSessionSnippet(normalized.slice(prefix.length), 54) ?? undefined;
	}
	return undefined;
}

function getAgentSessionSnippet(value: string | undefined, maxLength: number): string | undefined {
	let normalized = value?.replace(/\s+/g, ' ').trim();
	if (!normalized) {
		return undefined;
	}

	normalized = normalized.replace(/^[-*]\s+/, '');
	if (normalized.length <= maxLength) {
		return normalized;
	}

	return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function normalizeAgentSessionText(value: string | undefined): string {
	return value?.trim().replace(/[.!]+$/g, '').toLowerCase() ?? '';
}

function getAgentSessionPreviewFallback(status: string): string {
	switch (status.toLowerCase()) {
		case 'draft':
			return 'Ready for the first prompt.';
		case 'running':
			return 'Generating a response.';
		case 'waiting approval':
			return 'Approval required.';
		case 'error':
			return 'Last request failed.';
		case 'offline':
			return 'Backend is offline.';
		default:
			return 'Ready for the next prompt.';
	}
}

export function buildAgentConversationTurns(items: readonly IAgentTimelineItem[], hasLiveExecution: boolean): readonly IAgentConversationTurn[] {
	const turns: IMutableAgentConversationTurn[] = [];
	let currentTurn: IMutableAgentConversationTurn | undefined;

	for (const item of items) {
		if (item.kind === 'user') {
			const turn = createConversationTurn(item.id);
			turn.userMessage = item;
			turns.push(turn);
			currentTurn = turn;
			continue;
		}

		if (item.kind === 'assistant') {
			const turn = currentTurn && !currentTurn.assistantMessage
				? currentTurn
				: createConversationTurn(item.id);
			if (!turns.includes(turn)) {
				turns.push(turn);
			}
			turn.assistantMessage = item;
			currentTurn = turn;
			continue;
		}

		if (shouldFoldIntoTurnFooter(item)) {
			const turn = findConversationTurnForItem(turns, item, currentTurn) ?? createConversationTurn(`turn:${item.id}`);
			if (!turns.includes(turn)) {
				turns.push(turn);
			}
			appendTurnStatusMeta(turn, item);
			currentTurn = turn;
			continue;
		}

		const attachmentKind = getConversationAttachmentKind(item);
		if (!attachmentKind) {
			continue;
		}

		const turn = findConversationTurnForItem(turns, item, currentTurn) ?? createConversationTurn(`turn:${item.id}`);
		if (!turns.includes(turn)) {
			turns.push(turn);
		}

		turn.attachments.push({
			id: item.id,
			kind: attachmentKind,
			summary: getConversationAttachmentSummary(item),
			expandedByDefault: shouldExpandConversationAttachment(item, hasLiveExecution),
			item
		});
		turn.hasPendingApproval = turn.hasPendingApproval || (attachmentKind === 'approval' && item.phase === 'waitingApproval');
		currentTurn = turn;
	}

	return turns.map(turn => ({
		id: turn.id,
		userMessage: turn.userMessage,
		assistantMessage: turn.assistantMessage,
		attachments: turn.attachments,
		statusMeta: turn.statusMeta.length ? [...turn.statusMeta] : undefined,
		hasPendingApproval: turn.hasPendingApproval
	}));
}

function createConversationTurn(id: string): IMutableAgentConversationTurn {
	return {
		id,
		attachments: [],
		statusMeta: [],
		hasPendingApproval: false
	};
}

function shouldFoldIntoTurnFooter(item: IAgentTimelineItem): boolean {
	return item.kind === 'status' && !item.id.startsWith('__thinking__:');
}

function getConversationAttachmentKind(item: IAgentTimelineItem): AgentTurnAttachmentKind | undefined {
	switch (item.kind) {
		case 'reasoning':
		case 'command':
		case 'tool':
		case 'patch':
		case 'approval':
			return item.kind;
		case 'error':
		case 'status':
			return 'debug';
		default:
			return undefined;
	}
}

function findConversationTurnForItem(
	turns: readonly IMutableAgentConversationTurn[],
	item: IAgentTimelineItem,
	currentTurn: IMutableAgentConversationTurn | undefined
): IMutableAgentConversationTurn | undefined {
	if (item.sourceMessageId) {
		for (let index = turns.length - 1; index >= 0; index--) {
			const turn = turns[index];
			if (turn.assistantMessage?.id === item.sourceMessageId || turn.userMessage?.id === item.sourceMessageId) {
				return turn;
			}
		}
	}

	if (item.processGroupId) {
		for (let index = turns.length - 1; index >= 0; index--) {
			const turn = turns[index];
			if (turn.attachments.some(attachment => attachment.item.processGroupId === item.processGroupId)) {
				return turn;
			}
		}
	}

	return currentTurn ?? turns.at(-1);
}

function appendTurnStatusMeta(turn: IMutableAgentConversationTurn, item: IAgentTimelineItem): void {
	const entries = getTurnStatusEntries(item);

	for (const entry of entries) {
		const normalized = normalizeConversationMetaEntry(entry);
		if (!normalized || turn.statusMeta.includes(normalized)) {
			continue;
		}
		turn.statusMeta.push(normalized);
	}
}

function getTurnStatusEntries(item: IAgentTimelineItem): readonly string[] {
	const entries: string[] = [];
	const title = normalizeConversationMetaEntry(item.title ?? item.label);
	if (title) {
		entries.push(title);
	}
	if (item.stateLabel) {
		entries.push(item.stateLabel);
	}

	return entries;
}

function normalizeConversationMetaEntry(value: string | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized ? normalized : undefined;
}

function getConversationAttachmentSummary(item: IAgentTimelineItem): string {
	if (item.kind === 'patch') {
		return item.body || item.title || 'Edited files';
	}

	if (item.kind === 'approval') {
		return item.code?.trim() || item.title || item.body;
	}

	if (item.kind === 'command') {
		return item.code?.trim() || item.title || item.body;
	}

	return item.title || item.body || item.label;
}

function shouldExpandConversationAttachment(item: IAgentTimelineItem, hasLiveExecution: boolean): boolean {
	if (item.kind === 'reasoning') {
		return hasLiveExecution;
	}

	if (item.kind === 'approval') {
		return item.phase === 'waitingApproval';
	}

	if (item.kind === 'command' || item.kind === 'tool') {
		return item.phase === 'failed' || item.phase === 'cancelled' || item.sections?.some(section => section.presentation === 'stderr') === true;
	}

	return false;
}

export interface IAgentSidebarSection {
	readonly id: string;
	readonly title: string;
	readonly body?: string;
	readonly bullets?: readonly string[];
}

export interface IAgentComposerOption {
	readonly id: string;
	readonly label: string;
	readonly detail?: string;
	readonly maxContextWindow?: number;
	readonly maxInputTokens?: number;
	readonly maxOutputTokens?: number;
	readonly totalContextWindow?: number;
}

export interface IAgentSessionContextUsage {
	readonly usedTokens: number;
	readonly totalContextWindow: number;
	readonly percentage: number;
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly reasoningTokens?: number;
}

interface IAgentModelSelection {
	readonly providerID: string;
	readonly modelID: string;
}

interface IAgentErrorPresentation {
	readonly label: string;
	readonly body: string;
	readonly meta?: readonly string[];
	readonly composerStatus: string;
	readonly composerError: string;
	readonly subtitle: string;
}

export interface IAgentSessionSummary {
	readonly id: string;
	readonly title: string;
	readonly status: string;
	readonly preview: string;
	readonly previewLoading: boolean;
	readonly updatedLabel: string;
	readonly statusTone: AgentSessionSummaryTone;
	readonly isDraft: boolean;
}

export interface IAgentSessionModel {
	readonly id: string;
	readonly title: string;
	readonly subtitle: string;
	readonly backendLabel: string;
	readonly backendTone: 'connected' | 'offline' | 'error';
	readonly workingDirectoryLabel?: string;
	readonly sessionPhase: AgentSessionPhase;
	readonly stateLabel: string;
	readonly modelLabel: string;
	readonly runtimeModeLabel: string;
	readonly sessionLabel: string;
	readonly timeline: readonly IAgentTimelineItem[];
	readonly sidebarSections: readonly IAgentSidebarSection[];
	readonly composerDraft: string;
	readonly composerPlaceholder: string;
	readonly composerState: AgentComposerState;
	readonly composerStatus: string;
	readonly composerError?: string;
	readonly contextUsage?: IAgentSessionContextUsage;
	readonly selectedAgent: string;
	readonly selectedModel: string;
	readonly availableAgents: readonly IAgentComposerOption[];
	readonly availableModels: readonly IAgentComposerOption[];
}

export interface IAgentExecutionPhaseMessage {
	readonly info: {
		readonly role: 'user' | 'assistant';
		readonly error?: unknown;
		readonly time?: { readonly completed?: number };
	};
	readonly parts: readonly unknown[];
}

export interface IAgentSessionService {
	readonly _serviceBrand: undefined;
	readonly sessions: readonly IAgentSessionSummary[];
	readonly activeSession: IAgentSessionModel;
	readonly onDidChangeActiveSession: Event<IAgentSessionModel>;
	updateComposerDraft(draft: string): void;
	setSelectedAgent(agentId: string): void;
	setSelectedModel(modelId: string): void;
	setActiveSession(sessionId: string): void;
	createNewSession(): void;
	seedDeveloperFixture(fixture: 'approvalReview'): void;
	sendComposerPrompt(): Promise<void>;
	stopActiveRequest(): Promise<void>;
	replyToApproval(requestId: string, response: 'allow' | 'deny' | 'allowAll'): Promise<void>;
	getTimelineDisclosureState(sessionId: string, disclosureId: string): boolean | undefined;
	setTimelineDisclosureState(sessionId: string, disclosureId: string, open: boolean): void;
}

export const IAgentSessionService = createDecorator<IAgentSessionService>('agentSessionService');

const DEFAULT_OPEN_CODE_PROVIDER_ID = 'minimax-cn-coding-plan';
const DEFAULT_OPEN_CODE_MODEL_ID = 'MiniMax-M2.7-highspeed';
const DEFAULT_OPEN_CODE_MODEL_OPTION_ID = `${DEFAULT_OPEN_CODE_PROVIDER_ID}::${DEFAULT_OPEN_CODE_MODEL_ID}`;
const RUNNING_VISUAL_GRACE_PERIOD = 600;

namespace OpenCodeAPI {
	export interface Config {
		readonly agent?: Record<string, unknown>;
		readonly mode?: Record<string, unknown>;
	}

	export interface AgentInfo {
		readonly name: string;
		readonly description?: string;
		readonly mode?: string;
		readonly hidden?: boolean;
	}

	export interface ProvidersConfigResponse {
		readonly providers: readonly ProviderInfo[];
		readonly default?: Record<string, string>;
	}

	export interface ProviderInfo {
		readonly id: string;
		readonly name?: string;
		readonly models?: Record<string, ProviderModelInfo>;
	}

	export interface ProviderModelInfo {
		readonly id?: string;
		readonly name?: string;
		readonly status?: string;
		readonly providerID?: string;
		readonly maxContextWindow?: number | string;
		readonly maxInputTokens?: number | string;
		readonly maxOutputTokens?: number | string;
	}

	export interface SessionInfo {
		readonly id: string;
		readonly slug: string;
		readonly title: string;
		readonly version: string;
		readonly directory?: string;
		readonly time: {
			readonly created: number;
			readonly updated: number;
		};
	}

	export interface MessageInfo {
		readonly id: string;
		readonly sessionID: string;
		readonly role: 'user' | 'assistant';
		readonly agent?: string;
		readonly mode?: string;
		readonly error?: unknown;
		readonly summary?: {
			readonly diffs?: readonly string[];
		};
		readonly modelID?: string;
		readonly providerID?: string;
		readonly model?: {
			readonly providerID?: string;
			readonly modelID?: string;
		};
		readonly path?: {
			readonly cwd?: string;
			readonly root?: string;
		};
		readonly time?: { readonly created: number; readonly completed?: number };
	}

	export interface MessageWithParts {
		readonly info: MessageInfo;
		readonly parts: readonly Part[];
	}

	export type Part = TextPart | ReasoningPart | ToolInvocationPart | ToolResultPart | LegacyToolPart | PatchPart | StepStartPart | StepFinishPart | SnapshotPart;

	export interface TextPart {
		readonly type: 'text';
		readonly text: string;
	}

	export interface ReasoningPart {
		readonly id?: string;
		readonly type: 'reasoning';
		readonly text?: string;
		readonly reasoning?: string;
	}

	export interface StepStartPart {
		readonly id: string;
		readonly type: 'step-start';
	}

	export interface StepFinishPart {
		readonly id: string;
		readonly type: 'step-finish';
		readonly reason?: string;
		readonly cost?: number;
		readonly tokens?: {
			readonly total?: number;
			readonly input?: number;
			readonly output?: number;
			readonly reasoning?: number;
			readonly cache?: {
				readonly read?: number;
				readonly write?: number;
			};
		};
	}

	export interface ToolInvocationPart {
		readonly id?: string;
		readonly type: 'tool-invocation';
		readonly toolInvocation?: {
			readonly toolName?: string;
			readonly toolCallId?: string;
			readonly state?: string;
			readonly args?: unknown;
		};
	}

	export interface ToolResultPart {
		readonly id?: string;
		readonly type: 'tool-result';
		readonly toolResult?: {
			readonly toolName?: string;
			readonly toolCallId?: string;
			readonly result?: unknown;
		};
	}

	export interface LegacyToolPart {
		readonly id?: string;
		readonly type: 'tool';
		readonly tool?: string;
		readonly callID?: string;
		readonly state?: {
			readonly status?: string;
			readonly input?: unknown;
			readonly output?: unknown;
			readonly error?: unknown;
			readonly time?: {
				readonly start?: number;
				readonly end?: number;
			};
		};
	}

	export interface PatchPart {
		readonly id?: string;
		readonly type: 'patch';
		readonly files?: readonly string[];
	}

	export interface SnapshotPart {
		readonly id: string;
		readonly type: 'snapshot';
		readonly snapshot?: string;
	}

	export interface SSEMessagePart {
		readonly id?: string;
		readonly sessionID?: string;
		readonly messageID?: string;
		readonly type: Part['type'];
		readonly text?: string;
		readonly reasoning?: string;
		readonly tool?: string;
		readonly callID?: string;
		readonly state?: LegacyToolPart['state'];
		readonly toolInvocation?: ToolInvocationPart['toolInvocation'];
		readonly toolResult?: ToolResultPart['toolResult'];
		readonly files?: readonly string[];
		readonly snapshot?: string;
		readonly reason?: string;
		readonly cost?: number;
		readonly tokens?: StepFinishPart['tokens'];
	}

	export interface SSEEvent {
		readonly directory?: string;
		readonly payload?: {
			readonly type?: string;
			readonly properties?: Record<string, unknown>;
		};
	}

	export interface PermissionRequest {
		readonly id: string;
		readonly permission: string;
		readonly patterns?: readonly string[];
		readonly sessionID: string;
		readonly tool?: {
			readonly messageID?: string;
			readonly callID?: string;
		};
	}
}

export function deriveAgentSessionExecutionPhase(currentPhase: AgentSessionPhase, messages: readonly IAgentExecutionPhaseMessage[], timeline: readonly Pick<IAgentTimelineItem, 'phase'>[]): AgentSessionPhase {
	if (timeline.some(item => item.phase === 'waitingApproval')) {
		return 'waitingApproval';
	}

	if (
		timeline.some(item => item.phase === 'pending' || item.phase === 'running')
		|| (currentPhase === 'running' && hasIncompleteAssistantMessage(messages))
	) {
		return 'running';
	}

	const lastMessage = messages.at(-1);
	if (!lastMessage) {
		return currentPhase === 'running' || currentPhase === 'waitingApproval' ? currentPhase : 'idle';
	}

	if (lastMessage.info.error) {
		return 'error';
	}

	if (lastMessage.info.role !== 'assistant' && currentPhase === 'running') {
		return 'running';
	}

	return 'idle';
}

export function getAgentComposerStateForPhase(phase: AgentSessionPhase): AgentComposerState {
	switch (phase) {
		case 'running':
			return 'running';
		case 'waitingApproval':
			return 'waitingApproval';
		case 'error':
			return 'error';
		case 'offline':
			return 'offline';
		case 'idle':
		default:
			return 'idle';
	}
}

export function deriveAgentSessionSummaryStatusTone(status: string, sessionPhase: AgentSessionPhase): AgentSessionSummaryTone {
	if (status.toLowerCase() === 'draft') {
		return 'draft';
	}

	switch (sessionPhase) {
		case 'running':
			return 'running';
		case 'waitingApproval':
			return 'warning';
		case 'error':
			return 'error';
		case 'offline':
			return 'offline';
		case 'idle':
		default:
			return 'idle';
	}
}

function hasIncompleteAssistantMessage(messages: readonly IAgentExecutionPhaseMessage[]): boolean {
	const lastMessage = messages.at(-1);
	if (!lastMessage) {
		return false;
	}

	if (lastMessage.info.role !== 'assistant' || lastMessage.info.error) {
		return false;
	}

	if (!lastMessage.info.time || lastMessage.info.time.completed === undefined) {
		return true;
	}

	return lastMessage.parts.length === 0;
}

function extractCommandText(value: unknown): string | undefined {
	if (typeof value === 'string' && value.trim()) {
		return value.trim();
	}

	if (!value || typeof value !== 'object') {
		return undefined;
	}

	const record = value as Record<string, unknown>;
	for (const candidate of ['command', 'cmd', 'bash', 'script', 'input']) {
		const entry = record[candidate];
		if (typeof entry === 'string' && entry.trim()) {
			return entry.trim();
		}
	}

	return undefined;
}

function normalizeLegacyToolResult(part: OpenCodeAPI.LegacyToolPart): unknown {
	const command = extractCommandText(part.state?.input);
	const error = part.state?.error;
	const output = part.state?.output;

	if (error !== undefined) {
		if (error && typeof error === 'object' && !Array.isArray(error)) {
			const record = error as Record<string, unknown>;
			return command && record['command'] === undefined ? { command, ...record } : record;
		}

		return {
			...(command ? { command } : {}),
			error,
			success: false
		};
	}

	if (output !== undefined) {
		if (output && typeof output === 'object' && !Array.isArray(output)) {
			const record = output as Record<string, unknown>;
			return command && record['command'] === undefined ? { command, ...record } : record;
		}

		return command ? { command, output } : output;
	}

	return command ? { command, success: true } : { success: true };
}

export function normalizeOpenCodePart(part: OpenCodeAPI.Part): Exclude<OpenCodeAPI.Part, OpenCodeAPI.LegacyToolPart> {
	if (part.type !== 'tool') {
		return part;
	}

	const legacyState = part.state;
	const normalizedStatus = part.state?.status?.toLowerCase();
	const toolName = part.tool;
	const toolCallId = part.callID ?? part.id;
	const partIdentity = part.id ? { id: part.id } : {};

	switch (normalizedStatus) {
		case 'pending':
			return {
				...partIdentity,
				type: 'tool-invocation',
				toolInvocation: {
					toolName,
					toolCallId,
					state: 'partial-call',
					args: legacyState?.input
				}
			};
		case 'waiting-approval':
		case 'needs-approval':
		case 'approval-required':
			return {
				...partIdentity,
				type: 'tool-invocation',
				toolInvocation: {
					toolName,
					toolCallId,
					state: 'waiting-approval',
					args: legacyState?.input
				}
			};
		case 'cancelled':
		case 'canceled':
			return {
				...partIdentity,
				type: 'tool-invocation',
				toolInvocation: {
					toolName,
					toolCallId,
					state: 'cancelled',
					args: legacyState?.input
				}
			};
		case 'completed':
		case 'complete':
		case 'succeeded':
		case 'success':
		case 'failed':
		case 'error':
			return {
				...partIdentity,
				type: 'tool-result',
				toolResult: {
					toolName,
					toolCallId,
					result: normalizeLegacyToolResult(part)
				}
			};
		default:
			if (legacyState?.error !== undefined || legacyState?.output !== undefined) {
				return {
					...partIdentity,
					type: 'tool-result',
					toolResult: {
						toolName,
						toolCallId,
						result: normalizeLegacyToolResult(part)
					}
				};
			}

			return {
				...partIdentity,
				type: 'tool-invocation',
				toolInvocation: {
					toolName,
					toolCallId,
					state: 'call',
					args: legacyState?.input
				}
			};
	}
}

interface AgentSessionState {
	readonly id: string;
	remoteId?: string;
	readonly createdAt: number;
	updatedAt: number;
	title: string;
	subtitle: string;
	backendLabel: string;
	backendTone: 'connected' | 'offline' | 'error';
	workingDirectoryLabel?: string;
	sessionPhase: AgentSessionPhase;
	stateLabel: string;
	modelLabel: string;
	runtimeModeLabel: string;
	sessionLabel: string;
	timeline: IAgentTimelineItem[];
	sidebarSections: IAgentSidebarSection[];
	composerDraft: string;
	composerPlaceholder: string;
	composerState: AgentComposerState;
	composerStatus: string;
	composerError?: string;
	contextUsage?: IAgentSessionContextUsage;
	selectedAgent: string;
	selectedModel: string;
	availableAgents: IAgentComposerOption[];
	availableModels: IAgentComposerOption[];
	status: string;
	preview: string;
	previewLoading: boolean;
	visualRunningUntil: number;
	pendingApprovals: IAgentTimelineItem[];
	liveMessages: Map<string, OpenCodeAPI.MessageWithParts>;
}

interface IProcessAggregationResult {
	readonly key: string;
	readonly item: IAgentTimelineItem;
}

class AgentSessionService extends Disposable implements IAgentSessionService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeActiveSession = this._register(new Emitter<IAgentSessionModel>());
	readonly onDidChangeActiveSession = this._onDidChangeActiveSession.event;

	private readonly _sessions = new Map<string, AgentSessionState>();
	private readonly _sessionOrder: string[] = [];
	private readonly _pollTokens = new Map<string, number>();
	private readonly _timelineDisclosureStates = new Map<string, Map<string, boolean>>();
	private _availableAgents: IAgentComposerOption[] = [{ id: 'agent', label: 'Agent' }];
	private _availableModels: IAgentComposerOption[] = [{ id: 'default', label: 'Default model' }];

	private _activeSessionId: string;
	private _backendVersion = 'OpenCode';
	private _backendRuntime: IAgentBackendRuntimeMetadata | undefined;
	private _refreshHandle: number | undefined;
	private _backendReconnectHandle: number | undefined;

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IAgentBackendService private readonly _agentBackendService: IAgentBackendService,
	) {
		super();

		this._register(this._agentBackendService.onDidReceiveEvent(event => this._handleBackendEvent(event)));
		this._register(this._agentBackendService.onDidDisconnect(() => {
			this._logService.warn('[AgentMode] OpenCode event stream disconnected');
			this._markRemoteSessionsOffline();
			this._scheduleBackendReconnect();
		}));

		const session = this._createDraftSession();
		this._insertSession(session, true);
		this._activeSessionId = session.id;

		void this._initializeBackend();
	}

	get sessions(): readonly IAgentSessionSummary[] {
		return [...this._sessionOrder]
			.map(id => this._sessions.get(id)!)
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.map(session => {
				const title = getAgentSessionDisplayTitle(session.title, session.preview);
				return {
					id: session.id,
					title,
					status: session.status,
					preview: getAgentSessionDisplayPreview(session.preview, title, session.status, session.previewLoading),
					previewLoading: session.previewLoading,
					updatedLabel: this._formatUpdatedLabel(session.updatedAt),
					statusTone: this._deriveSummaryStatusTone(session),
					isDraft: !session.remoteId
				};
			});
	}

	get activeSession(): IAgentSessionModel {
		return this._toSessionModel(this._sessions.get(this._activeSessionId) ?? this._sessions.get(this._sessionOrder[0]!)!);
	}

	updateComposerDraft(draft: string): void {
		const session = this._getMutableActiveSession();
		if (session.composerDraft === draft) {
			return;
		}

		session.composerDraft = draft;
	}

	setSelectedAgent(agentId: string): void {
		const session = this._getMutableActiveSession();
		if (session.selectedAgent === agentId) {
			return;
		}

		session.selectedAgent = agentId;
		this._emitChange();
	}

	setSelectedModel(modelId: string): void {
		const session = this._getMutableActiveSession();
		if (session.selectedModel === modelId) {
			return;
		}

		session.selectedModel = modelId;
		this._emitChange();
	}

	setActiveSession(sessionId: string): void {
		if (sessionId === this._activeSessionId || !this._sessions.has(sessionId)) {
			return;
		}

		this._activeSessionId = sessionId;
		const session = this._sessions.get(sessionId)!;
		if (session.remoteId) {
			void this._refreshRemoteSession(session.id);
		}
		this._emitChange();
	}

	createNewSession(): void {
		const session = this._createDraftSession();
		session.stateLabel = 'Idle';
		session.status = 'Draft';
		session.composerStatus = 'Draft session ready. Type a prompt to create a new backend session.';
		session.subtitle = `This draft will become a real OpenCode session when you send the first prompt.`;
		this._insertSession(session, true);
		this._activeSessionId = session.id;
		this._emitChange();
	}

	seedDeveloperFixture(fixture: 'approvalReview'): void {
		const session = this._createDraftSession();
		switch (fixture) {
			case 'approvalReview':
			default:
				this._seedDeveloperApprovalFixture(session);
				break;
		}

		this._insertSession(session, true);
		this._activeSessionId = session.id;
		this._emitChange();
	}

	async sendComposerPrompt(): Promise<void> {
		const session = this._getMutableActiveSession();
		const prompt = session.composerDraft.trim();
		if (!prompt) {
			return;
		}

		session.composerDraft = '';
		this._applySessionPhase(session, 'running');
		session.composerStatus = '';
		session.composerError = undefined;
		session.preview = prompt;
		session.previewLoading = false;
		session.title = getAgentSessionDisplayTitle(session.title, session.preview);
		session.sessionLabel = session.title;
		session.updatedAt = Date.now();
		session.timeline = [
			...session.timeline,
			{
				id: generateUuid(),
				kind: 'user',
				label: 'User request',
				body: prompt
			}
		];
		this._updateSidebarSections(session, undefined);
		this._emitChange();

		try {
			if (!session.remoteId) {
				const created = await this._agentBackendService.createSession();
				session.remoteId = created.id;
				session.title = getAgentSessionDisplayTitle(this._cleanupSessionTitle(created.title), session.preview);
				session.sessionLabel = session.title;
				session.updatedAt = created.time.updated;
			}

			await this._agentBackendService.promptAsync(
				session.remoteId,
				prompt,
				session.selectedAgent,
				this._parseSelectedModel(session.selectedModel)
			);
			if (!this._agentBackendService.eventStreamAvailable) {
				void this._pollSessionUntilSettled(session.id);
			}
		} catch (error) {
			this._logService.error('[AgentMode] Failed to send OpenCode prompt', error);
			this._applySessionPhase(session, 'error');
			session.composerStatus = 'Last request failed.';
			session.composerError = this._renderErrorSubtitle(error);
			session.subtitle = this._renderErrorSubtitle(error);
			session.updatedAt = Date.now();
			session.previewLoading = false;
			session.timeline = [
				...session.timeline,
				{
					id: generateUuid(),
					kind: 'error',
					label: 'Connection error',
					body: this._renderErrorSubtitle(error)
				}
			];
			this._emitChange();
		}
	}

	async stopActiveRequest(): Promise<void> {
		const session = this._getMutableActiveSession();
		if (!session.remoteId) {
			return;
		}

		this._invalidatePoll(session.id);
		try {
			await this._agentBackendService.abort(session.remoteId);
		} catch (error) {
			this._logService.warn('[AgentMode] Failed to abort OpenCode request', error);
		}

		this._applySessionPhase(session, 'idle');
		session.composerState = 'stopped';
		session.composerStatus = 'Request stopped.';
		session.composerError = undefined;
		session.updatedAt = Date.now();
		this._emitChange();
	}

	async replyToApproval(requestId: string, response: 'allow' | 'deny' | 'allowAll'): Promise<void> {
		const session = this._getMutableActiveSession();
		if (!session.remoteId) {
			this._resolveLocalApprovalFixture(session, requestId, response);
			return;
		}

		await this._agentBackendService.replyPermission(session.remoteId, requestId, response);
		const resolution = this._resolveApprovalDecision(response);
		const approvalItem = session.pendingApprovals.find(item => item.permissionRequestId === requestId);
		if (approvalItem) {
			const resolvedApproval: IAgentTimelineItem = {
				...approvalItem,
				body: resolution.body,
				tone: resolution.tone,
				phase: resolution.phase,
				stateLabel: resolution.stateLabel
			};
			session.pendingApprovals = session.pendingApprovals.map(item => item.permissionRequestId === requestId ? resolvedApproval : item);
			session.timeline = session.timeline.map(item => {
				if (item.permissionRequestId === requestId) {
					return resolvedApproval;
				}

				if (approvalItem.processGroupId && item.processGroupId === approvalItem.processGroupId && (item.kind === 'tool' || item.kind === 'command')) {
					return this._applyApprovalResolutionToProcessItem(item, response);
				}

				return item;
			});
		}

		session.composerStatus = resolution.composerStatus;
		this._applySessionPhase(session, response === 'deny' ? 'idle' : 'running');
		session.updatedAt = Date.now();
		this._emitChange();
		void this._refreshRemoteSession(session.id);
	}

	private _seedDeveloperApprovalFixture(session: AgentSessionState): void {
		const processGroupId = `fixture:approval:${generateUuid()}`;
		const commandArgs = {
			command: 'git status --short',
			cwd: 'c:\\prj\\vscode',
			description: 'Inspect local workspace changes before applying edits',
			timeout: 20000,
			patterns: [
				'src/vs/workbench/contrib/agentMode/browser/**',
				'src/vs/workbench/contrib/chat/browser/actions/**'
			]
		};

		session.title = 'APPROVAL_VISUAL_TEST deterministic approval';
		session.subtitle = 'Developer fixture session for validating approval, command, and continuation cards.';
		session.backendLabel = 'OpenCode fixture';
		session.backendTone = 'connected';
		session.workingDirectoryLabel = 'c:\\prj\\vscode';
		session.sessionLabel = session.title;
		session.runtimeModeLabel = 'Agent';
		session.modelLabel = 'Fixture';
		session.status = 'Waiting approval';
		session.preview = 'Run git status --short after approval.';
		session.previewLoading = false;
		session.updatedAt = Date.now();
		session.timeline = [
			{
				id: `fixture:user:${generateUuid()}`,
				kind: 'user',
				label: 'User request',
				body: 'Check the current workspace changes before you continue.'
			},
			{
				id: `fixture:reasoning:${generateUuid()}`,
				kind: 'reasoning',
				label: 'Reasoning',
				body: 'I want to inspect the working tree before making any edits, so I need to run a shell command that reads repository state.'
			},
			{
				id: `fixture:command:${generateUuid()}`,
				kind: 'command',
				label: 'Command',
				title: 'bash',
				body: 'OpenCode is ready to run this command once approval is granted.',
				code: commandArgs.command,
				details: this._buildCommandContextDetails(commandArgs),
				rawData: this._serializeRawData(commandArgs),
				tone: 'warning',
				phase: 'waitingApproval',
				stateLabel: 'Waiting approval',
				processGroupId,
				sourceMessageId: 'fixture:approval:source'
			}
		];
		session.pendingApprovals = [
			this._createApprovalTimelineItem({
				requestId: 'fixture-approval-request',
				title: 'bash',
				args: {
					permission: 'execute_command',
					...commandArgs
				},
				linkedProcess: session.timeline[2],
				permissionLabel: 'Execute Command',
				patterns: commandArgs.patterns,
				rawData: this._serializeRawData({
					permission: 'execute_command',
					...commandArgs
				}),
				sourceMessageId: 'fixture:approval:source'
			})
		];
		session.timeline = [...session.timeline, ...session.pendingApprovals];
		session.composerDraft = '';
		session.composerStatus = 'Approval required. Review the fixture request below to continue.';
		session.composerError = undefined;
		this._applySessionPhase(session, 'waitingApproval');
		this._updateSidebarSections(session, undefined);
	}

	private _resolveLocalApprovalFixture(session: AgentSessionState, requestId: string, response: 'allow' | 'deny' | 'allowAll'): void {
		const resolution = this._resolveApprovalDecision(response);
		const approvalItem = session.pendingApprovals.find(item => item.permissionRequestId === requestId);
		if (!approvalItem) {
			return;
		}

		const resolvedApproval: IAgentTimelineItem = {
			...approvalItem,
			body: resolution.body,
			tone: resolution.tone,
			phase: resolution.phase,
			stateLabel: resolution.stateLabel
		};

		session.pendingApprovals = session.pendingApprovals.map(item => item.permissionRequestId === requestId ? resolvedApproval : item);
		session.timeline = session.timeline.map(item => {
			if (item.permissionRequestId === requestId) {
				return resolvedApproval;
			}

			if (approvalItem.processGroupId && item.processGroupId === approvalItem.processGroupId && item.kind === 'command') {
				if (response === 'deny') {
					return this._applyApprovalResolutionToProcessItem(item, response);
				}

				return {
					...item,
					body: 'Command finished.',
					sections: this._mergeSections(item.sections, [{
						label: 'Standard output',
						type: 'code',
						value: 'M src/vs/workbench/contrib/agentMode/browser/agentSessionService.ts\nM src/vs/workbench/contrib/agentMode/browser/agentMode.contribution.ts',
						presentation: 'stdout'
					}]),
					rawData: this._serializeRawData({
						command: item.code,
						output: 'M src/vs/workbench/contrib/agentMode/browser/agentSessionService.ts\nM src/vs/workbench/contrib/agentMode/browser/agentMode.contribution.ts\n'
					}),
					tone: 'success',
					phase: 'succeeded',
					stateLabel: 'Completed'
				};
			}

			return item;
		});

		if (response !== 'deny') {
			session.timeline.push({
				id: `fixture:assistant:${generateUuid()}`,
				kind: 'assistant',
				label: 'Assistant response',
				body: 'Permission granted. I inspected the workspace and found local changes in the agent mode implementation files.'
			});
		}

		session.composerStatus = response === 'deny'
			? 'Fixture approval denied.'
			: 'Fixture approval granted.';
		session.status = response === 'deny' ? 'Idle' : 'Completed';
		session.updatedAt = Date.now();
		this._applySessionPhase(session, 'idle');
		this._updateSidebarSections(session, undefined);
		this._emitChange();
	}

	getTimelineDisclosureState(sessionId: string, disclosureId: string): boolean | undefined {
		return this._timelineDisclosureStates.get(sessionId)?.get(disclosureId);
	}

	setTimelineDisclosureState(sessionId: string, disclosureId: string, open: boolean): void {
		let sessionStates = this._timelineDisclosureStates.get(sessionId);
		if (!sessionStates) {
			sessionStates = new Map<string, boolean>();
			this._timelineDisclosureStates.set(sessionId, sessionStates);
		}

		sessionStates.set(disclosureId, open);
	}

	private async _initializeBackend(): Promise<void> {
		try {
			if (this._backendReconnectHandle !== undefined) {
				clearTimeout(this._backendReconnectHandle);
				this._backendReconnectHandle = undefined;
			}
			const { health, config, providersConfig, agents, runtime } = await this._agentBackendService.initialize();
			this._backendVersion = `OpenCode ${health.version}`;
			this._backendRuntime = runtime;
			this._logService.info(`[AgentMode] Backend initialized (active=${runtime.location}, requested=${runtime.requestedLocation}, authority=${runtime.remoteAuthority ?? 'local'}, target=${runtime.connectionLabel})`);
			this._updateComposerOptions(config, providersConfig, agents);
			await this._hydrateSessionsFromBackend();
		} catch (error) {
			this._logService.warn('[AgentMode] OpenCode backend unavailable', error);
			this._markRemoteSessionsOffline();
			this._scheduleBackendReconnect();
		}
	}

	private _handleBackendEvent(event: OpenCodeAPI.SSEEvent): void {
		try {
			const type = event.payload?.type;
			const properties = event.payload?.properties ?? {};
			if (!type) {
				this._scheduleRefresh();
				return;
			}

			switch (type) {
				case 'message.updated': {
					const info = properties['info'];
					if (this._isMessageInfo(info)) {
						this._applyMessageUpdated(info);
					} else {
						this._scheduleRefresh();
					}
					break;
				}
				case 'message.part.updated': {
					const part = properties['part'];
					if (this._isMessagePart(part)) {
						this._applyMessagePartUpdated(part);
					} else {
						this._scheduleRefresh();
					}
					break;
				}
				case 'session.updated': {
					const info = properties['info'];
					if (this._isSessionInfo(info)) {
						this._applySessionUpdated(info);
					} else {
						this._scheduleRefresh();
					}
					break;
				}
				case 'session.status': {
					const sessionId = typeof properties['sessionID'] === 'string' ? properties['sessionID'] : undefined;
					const status = properties['status'];
					if (sessionId && this._isSessionStatus(status)) {
						this._applySessionStatus(sessionId, status.type);
					} else {
						this._scheduleRefresh();
					}
					break;
				}
				case 'session.error': {
					const sessionId = typeof properties['sessionID'] === 'string' ? properties['sessionID'] : undefined;
					if (sessionId) {
						this._applySessionError(sessionId, properties['error']);
					} else {
						this._scheduleRefresh();
					}
					break;
				}
				case 'permission.asked': {
					const sessionId = typeof properties['sessionID'] === 'string' ? properties['sessionID'] : undefined;
					const requestId = typeof properties['requestID'] === 'string'
						? properties['requestID']
						: (typeof properties['id'] === 'string' ? properties['id'] : undefined);
					const toolName = typeof properties['toolName'] === 'string' ? properties['toolName'] : 'Tool';
					const tool = properties['tool'] && typeof properties['tool'] === 'object'
						? properties['tool'] as Record<string, unknown>
						: undefined;
					const toolMessageId = typeof tool?.['messageID'] === 'string' ? tool['messageID'] : undefined;
					const toolCallId = typeof tool?.['callID'] === 'string' ? tool['callID'] : undefined;
					if (sessionId && requestId) {
						this._upsertPendingApproval(sessionId, requestId, toolName, properties['args'], toolMessageId, toolCallId);
					}
					break;
				}
				case 'session.idle': {
					const sessionId = typeof properties['sessionID'] === 'string' ? properties['sessionID'] : undefined;
					if (sessionId) {
						this._clearPendingApprovals(sessionId);
						this._applySessionStatus(sessionId, 'idle');
						const session = this._findSessionByRemoteId(sessionId);
						if (session) {
							void this._refreshRemoteSession(session.id);
						}
					}
					break;
				}
				default:
					this._scheduleRefresh();
					break;
			}
		} catch (error) {
			this._logService.trace('[AgentMode] Failed to parse OpenCode SSE payload', error);
			this._scheduleRefresh();
		}
	}

	private _scheduleRefresh(): void {
		if (this._refreshHandle !== undefined) {
			return;
		}

		this._refreshHandle = setTimeout(() => {
			this._refreshHandle = undefined;
			const session = this._sessions.get(this._activeSessionId);
			if (session?.remoteId) {
				void this._refreshRemoteSession(session.id);
			}
		}, 300) as unknown as number;
	}

	private _scheduleBackendReconnect(): void {
		if (this._backendReconnectHandle !== undefined) {
			return;
		}

		this._backendReconnectHandle = setTimeout(() => {
			this._backendReconnectHandle = undefined;
			void this._initializeBackend();
		}, 1200) as unknown as number;
	}

	private _applyMessageUpdated(info: OpenCodeAPI.MessageInfo): void {
		const session = this._findSessionByRemoteId(info.sessionID);
		if (!session) {
			this._scheduleRefresh();
			return;
		}

		const existing = session.liveMessages.get(info.id);
		session.liveMessages.set(info.id, {
			info,
			parts: existing ? [...existing.parts] : []
		});
		this._applyLiveSessionState(session);
	}

	private _applyMessagePartUpdated(part: OpenCodeAPI.SSEMessagePart): void {
		const remoteSessionId = part.sessionID;
		const messageId = part.messageID;
		if (!remoteSessionId || !messageId) {
			this._scheduleRefresh();
			return;
		}

		const session = this._findSessionByRemoteId(remoteSessionId);
		if (!session) {
			this._scheduleRefresh();
			return;
		}

		const existingMessage = session.liveMessages.get(messageId);
		if (!existingMessage) {
			this._scheduleRefresh();
			return;
		}

		const nextPart = this._normalizeSsePart(part);
		const nextParts = [...existingMessage.parts];
		const existingIndex = part.id ? nextParts.findIndex(candidate => hasKey(candidate, { id: true }) && candidate.id === part.id) : -1;
		if (existingIndex >= 0) {
			nextParts.splice(existingIndex, 1, nextPart);
		} else {
			nextParts.push(nextPart);
		}

		session.liveMessages.set(messageId, {
			info: existingMessage.info,
			parts: nextParts
		});
		this._applyLiveSessionState(session);
	}

	private _applySessionUpdated(info: OpenCodeAPI.SessionInfo): void {
		const session = this._findSessionByRemoteId(info.id);
		if (!session) {
			this._scheduleRefresh();
			return;
		}

		session.title = getAgentSessionDisplayTitle(this._cleanupSessionTitle(info.title), session.preview);
		session.sessionLabel = session.title;
		session.workingDirectoryLabel = info.directory;
		session.updatedAt = info.time.updated;
		this._emitIfActive(session);
	}

	private _applySessionStatus(remoteSessionId: string, statusType: string): void {
		const session = this._findSessionByRemoteId(remoteSessionId);
		if (!session) {
			return;
		}

		if (statusType === 'busy') {
			const nextPhase = this._hasWaitingApprovalProcesses(session.pendingApprovals) ? 'waitingApproval' : 'running';
			this._applySessionPhase(session, nextPhase);
			session.composerStatus = this._getComposerStatusForExecution(session, nextPhase);
		} else if (statusType === 'idle') {
			this._applySessionPhase(session, 'idle');
			session.composerStatus = '';
			session.composerError = undefined;
			this._invalidatePoll(session.id);
		}

		session.updatedAt = Date.now();
		this._emitIfActive(session);
	}

	private _applySessionError(remoteSessionId: string, error: unknown): void {
		const session = this._findSessionByRemoteId(remoteSessionId);
		if (!session) {
			return;
		}

		const errorPresentation = this._createErrorPresentation(error, session.modelLabel);

		this._applySessionPhase(session, 'error');
		session.composerStatus = errorPresentation.composerStatus;
		session.composerError = errorPresentation.composerError;
		session.subtitle = errorPresentation.subtitle;
		session.timeline = [
			...session.timeline.filter(item => item.kind !== 'error'),
			{
				id: `error:${session.remoteId}:${Date.now()}`,
				kind: 'error',
				label: errorPresentation.label,
				body: errorPresentation.body,
				meta: errorPresentation.meta,
				tone: 'error'
			}
		];
		session.updatedAt = Date.now();
		this._emitIfActive(session);
	}

	private _applyLiveSessionState(session: AgentSessionState): void {
		const messages = [...session.liveMessages.values()].sort((a, b) => {
			const left = a.info.time?.created ?? 0;
			const right = b.info.time?.created ?? 0;
			return left - right;
		});
		const timeline = this._createTimeline(messages);
		const combinedTimeline = [...timeline, ...session.pendingApprovals];
		const agentLabel = this._deriveAgentLabel(messages);
		const lastMessageError = this._extractLastMessageError(messages);

		if (messages.length) {
			session.modelLabel = this._deriveModelLabel(messages);
			session.runtimeModeLabel = agentLabel;
			session.selectedModel = this._resolveSelectedModelId(session.modelLabel, session.selectedModel);
			session.selectedAgent = this._resolveSelectedAgentId(agentLabel, session.selectedAgent);
			session.preview = this._derivePreview(messages);
			session.previewLoading = false;
			session.title = getAgentSessionDisplayTitle(session.title, session.preview);
			session.sessionLabel = session.title;
		}

		session.timeline = combinedTimeline;
		session.contextUsage = this._deriveContextUsage(session);
		if (lastMessageError && session.composerState !== 'stopped') {
			this._applySessionPhase(session, 'error');
			session.composerStatus = lastMessageError.composerStatus;
			session.composerError = lastMessageError.composerError;
			session.subtitle = lastMessageError.subtitle;
		} else {
			const executionPhase = this._deriveExecutionPhase(session, messages, combinedTimeline);
			this._applySessionPhase(session, executionPhase);
			session.composerStatus = this._getComposerStatusForExecution(session, executionPhase);
			session.composerError = undefined;
		}
		session.updatedAt = Date.now();
		this._emitIfActive(session);
	}

	private _emitIfActive(session: AgentSessionState): void {
		this._emitChange();
	}

	private _normalizeSsePart(part: OpenCodeAPI.SSEMessagePart): OpenCodeAPI.Part {
		switch (part.type) {
			case 'text':
				return { type: 'text', text: part.text ?? '' };
			case 'reasoning':
				return { id: part.id, type: 'reasoning', text: part.text, reasoning: part.reasoning };
			case 'tool':
				return normalizeOpenCodePart({
					id: part.id,
					type: 'tool',
					tool: part.tool,
					callID: part.callID,
					state: part.state
				});
			case 'tool-invocation':
				return { id: part.id, type: 'tool-invocation', toolInvocation: part.toolInvocation };
			case 'tool-result':
				return { id: part.id, type: 'tool-result', toolResult: part.toolResult };
			case 'patch':
				return { id: part.id, type: 'patch', files: part.files };
			case 'snapshot':
				return { id: part.id ?? generateUuid(), type: 'snapshot', snapshot: part.snapshot };
			case 'step-start':
				return { id: part.id ?? generateUuid(), type: 'step-start' };
			case 'step-finish':
				return {
					id: part.id ?? generateUuid(),
					type: 'step-finish',
					reason: part.reason,
					cost: part.cost,
					tokens: part.tokens
				};
		}
	}

	private _isMessageInfo(value: unknown): value is OpenCodeAPI.MessageInfo {
		return !!value && typeof value === 'object' && typeof (value as OpenCodeAPI.MessageInfo).id === 'string' && typeof (value as OpenCodeAPI.MessageInfo).sessionID === 'string';
	}

	private _isSessionInfo(value: unknown): value is OpenCodeAPI.SessionInfo {
		return !!value && typeof value === 'object' && typeof (value as OpenCodeAPI.SessionInfo).id === 'string';
	}

	private _isMessagePart(value: unknown): value is OpenCodeAPI.SSEMessagePart {
		return !!value && typeof value === 'object' && typeof (value as OpenCodeAPI.SSEMessagePart).type === 'string';
	}

	private _isSessionStatus(value: unknown): value is { type: string } {
		return !!value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string';
	}

	private async _hydrateSessionsFromBackend(): Promise<void> {
		const remoteSessions = await this._agentBackendService.listSessions();
		if (!remoteSessions.length) {
			const session = this._getMutableActiveSession();
			this._applySessionPhase(session, 'idle');
			session.stateLabel = 'Idle';
			session.status = 'Idle';
			session.modelLabel = this._backendVersion;
			session.selectedModel = this._resolveSelectedModelId(session.modelLabel, session.selectedModel);
			session.selectedAgent = this._resolveSelectedAgentId(session.runtimeModeLabel, session.selectedAgent);
			session.availableAgents = [...this._availableAgents];
			session.availableModels = [...this._availableModels];
			session.backendLabel = `Connected to ${this._backendVersion}`;
			session.backendTone = 'connected';
			session.workingDirectoryLabel = undefined;
			session.subtitle = `Connected to ${this._backendVersion}${this._describeBackendTargetSuffix()}.`;
			session.composerStatus = 'Connected. Start a prompt to begin.';
			session.composerError = undefined;
			session.updatedAt = Date.now();
			this._updateSidebarSections(session, undefined);
			this._emitChange();
			return;
		}

		this._sessions.clear();
		this._sessionOrder.length = 0;

		const draft = this._createDraftSession();
		draft.stateLabel = 'Idle';
		draft.status = 'Idle';
		draft.modelLabel = this._backendVersion;
		draft.backendLabel = `Connected to ${this._backendVersion}`;
		draft.backendTone = 'connected';
		draft.workingDirectoryLabel = undefined;
		this._applySessionPhase(draft, 'idle');
		draft.composerStatus = '';
		draft.composerError = undefined;
		draft.selectedModel = this._resolveSelectedModelId(draft.modelLabel, draft.selectedModel);
		draft.selectedAgent = this._resolveSelectedAgentId(draft.runtimeModeLabel, draft.selectedAgent);
		draft.availableAgents = [...this._availableAgents];
		draft.availableModels = [...this._availableModels];
		draft.subtitle = `Connected to ${this._backendVersion}. Start a fresh conversation or switch to an existing session from the left rail.`;
		draft.updatedAt = Date.now();
		this._insertSession(draft, true);

		const sorted = [...remoteSessions].sort((a, b) => b.time.updated - a.time.updated);
		let firstRemoteLocalId: string | undefined;
		for (const info of sorted) {
			const session = this._createStateFromRemote(info);
			this._insertSession(session, false);
			firstRemoteLocalId ??= session.id;
		}

		this._activeSessionId = firstRemoteLocalId ?? draft.id;
		if (firstRemoteLocalId) {
			await this._refreshRemoteSession(firstRemoteLocalId);
		}
		this._emitChange();

		const remainingSessionIds = this._sessionOrder.filter(id => {
			if (id === firstRemoteLocalId) {
				return false;
			}
			const session = this._sessions.get(id);
			return !!session?.remoteId;
		});

		void this._hydrateRecentSessionSummaries(remainingSessionIds);
	}

	private async _refreshRemoteSession(localSessionId: string): Promise<void> {
		const session = this._sessions.get(localSessionId);
		if (!session?.remoteId) {
			return;
		}

		try {
			const [info, messages, permissions] = await Promise.all([
				this._agentBackendService.getSession(session.remoteId),
				this._agentBackendService.getMessages(session.remoteId),
				this._agentBackendService.listPermissions().catch(() => [])
			]);

			const timeline = this._createTimeline(messages);
			const lastMessage = messages.at(-1);
			const agentLabel = this._deriveAgentLabel(messages);
			const lastMessageError = this._extractLastMessageError(messages);
			this._syncPendingApprovalsFromBackend(session, timeline, permissions.filter(permission => permission.sessionID === session.remoteId));
			session.liveMessages = new Map(messages.map(message => [message.info.id, { info: message.info, parts: [...message.parts] }]));
			session.backendLabel = `Connected to ${this._backendVersion}`;
			session.backendTone = 'connected';
			session.workingDirectoryLabel = info.directory;
			session.subtitle = info.directory
				? `Connected to ${this._backendVersion}. Working directory: ${info.directory}`
				: `Connected to ${this._backendVersion}.`;
			session.modelLabel = this._deriveModelLabel(messages);
			session.runtimeModeLabel = agentLabel;
			session.selectedModel = this._resolveSelectedModelId(session.modelLabel, session.selectedModel);
			session.selectedAgent = this._resolveSelectedAgentId(agentLabel, session.selectedAgent);
			session.availableAgents = [...this._availableAgents];
			session.availableModels = [...this._availableModels];
			session.preview = this._derivePreview(messages);
			session.previewLoading = false;
			session.title = getAgentSessionDisplayTitle(this._cleanupSessionTitle(info.title), session.preview);
			session.sessionLabel = session.title;
			const combinedTimeline = [...timeline, ...session.pendingApprovals];
			session.timeline = combinedTimeline;
			session.contextUsage = this._deriveContextUsage(session);
			session.updatedAt = info.time.updated;
			if (lastMessageError && session.composerState !== 'stopped') {
				this._applySessionPhase(session, 'error');
				session.composerStatus = lastMessageError.composerStatus;
				session.composerError = lastMessageError.composerError;
				session.subtitle = lastMessageError.subtitle;
			} else {
				const executionPhase = this._deriveExecutionPhase(session, messages, combinedTimeline);
				this._applySessionPhase(session, executionPhase);
				session.composerStatus = this._getComposerStatusForExecution(session, executionPhase);
				session.composerError = undefined;
			}
			this._updateSidebarSections(session, { info, messages, agentLabel });

			if (!lastMessage || (lastMessage.info.role === 'assistant' && lastMessage.parts.length > 0)) {
				this._invalidatePoll(localSessionId);
			}

			this._emitChange();
		} catch (error) {
			this._logService.warn('[AgentMode] Failed to refresh OpenCode session', error);
			this._applySessionPhase(session, 'offline');
			session.composerStatus = 'Failed to refresh session state.';
			session.composerError = this._renderErrorSubtitle(error);
			session.backendLabel = 'OpenCode refresh failed';
			session.backendTone = 'error';
			session.updatedAt = Date.now();
			this._emitChange();
			this._scheduleBackendReconnect();
		}
	}

	private async _pollSessionUntilSettled(localSessionId: string): Promise<void> {
		const token = Date.now();
		this._pollTokens.set(localSessionId, token);

		for (let attempt = 0; attempt < 30; attempt++) {
			if (this._pollTokens.get(localSessionId) !== token) {
				return;
			}

			await timeout(750);
			await this._refreshRemoteSession(localSessionId);

			const session = this._sessions.get(localSessionId);
			if (!session?.remoteId || !this._isRunningPhase(session.sessionPhase)) {
				return;
			}
		}

		const session = this._sessions.get(localSessionId);
		if (session) {
			this._applySessionPhase(session, 'idle');
			session.composerStatus = 'Response timeout reached. You can retry or stop the request.';
			session.updatedAt = Date.now();
			this._emitChange();
		}
	}

	private async _hydrateRecentSessionSummaries(localSessionIds: readonly string[]): Promise<void> {
		for (const sessionId of localSessionIds) {
			await this._refreshRemoteSession(sessionId);
			await timeout(60);
		}
	}

	private _invalidatePoll(localSessionId: string): void {
		this._pollTokens.delete(localSessionId);
	}

	private _createDraftSession(): AgentSessionState {
		return {
			id: `local-${generateUuid()}`,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			title: 'New session',
			subtitle: 'Connect Agent Mode to an OpenCode backend to start this conversation.',
			backendLabel: 'Connecting to OpenCode',
			backendTone: 'connected',
			workingDirectoryLabel: undefined,
			sessionPhase: 'idle',
			stateLabel: 'Connecting',
			modelLabel: 'OpenCode',
			runtimeModeLabel: 'Agent',
			sessionLabel: 'New session',
			timeline: [],
			sidebarSections: [
				{
					id: 'plan',
					title: 'Current plan',
					body: 'This rail will switch from placeholder state to live session context once OpenCode is reachable.',
				},
				{
					id: 'todo',
					title: 'Todo',
					bullets: [
						'Start the OpenCode backend',
						'Send the first prompt',
						'Map tool and approval events into richer blocks'
					]
				},
				{
					id: 'subagents',
					title: 'Subagents',
					body: 'No runtime state yet.'
				},
				{
					id: 'domain',
					title: 'Agent session domain',
					body: this._describeBackendTarget()
				}
			],
			composerDraft: '',
			composerPlaceholder: 'Prompt the agent...',
			composerState: 'idle',
			composerStatus: 'Attempting to connect to OpenCode...',
			selectedAgent: this._availableAgents[0]?.id ?? 'agent',
			selectedModel: this._availableModels[0]?.id ?? 'default',
			availableAgents: [...this._availableAgents],
			availableModels: [...this._availableModels],
			status: 'Connecting',
			preview: 'Start a new OpenCode-backed conversation',
			previewLoading: false,
			visualRunningUntil: 0,
			pendingApprovals: [],
			liveMessages: new Map()
		};
	}

	private _markRemoteSessionsOffline(): void {
		const now = Date.now();
		for (const session of this._sessions.values()) {
			if (!session.remoteId) {
				continue;
			}

			this._applySessionPhase(session, 'offline');
			session.backendLabel = 'OpenCode offline';
			session.backendTone = 'offline';
			session.composerStatus = 'OpenCode backend is offline.';
			session.composerError = 'OpenCode backend is unavailable.';
			session.updatedAt = now;
		}

		const activeSession = this._sessions.get(this._activeSessionId);
		if (activeSession) {
			activeSession.subtitle = `OpenCode backend is unavailable${this._describeBackendTargetSuffix()}.`;
			activeSession.workingDirectoryLabel = activeSession.remoteId ? activeSession.workingDirectoryLabel : undefined;
			this._updateSidebarSections(activeSession, undefined);
		}

		this._emitChange();
	}

	private _createStateFromRemote(info: OpenCodeAPI.SessionInfo): AgentSessionState {
		return {
			id: `opencode-${info.id}`,
			remoteId: info.id,
			createdAt: info.time.updated,
			updatedAt: info.time.updated,
			title: this._cleanupSessionTitle(info.title),
			subtitle: info.directory
				? `Connected to ${this._backendVersion}. Working directory: ${info.directory}`
				: `Connected to ${this._backendVersion}.`,
			backendLabel: `Connected to ${this._backendVersion}`,
			backendTone: 'connected',
			workingDirectoryLabel: info.directory,
			sessionPhase: 'idle',
			stateLabel: 'Idle',
			modelLabel: this._backendVersion,
			runtimeModeLabel: 'Agent',
			sessionLabel: this._cleanupSessionTitle(info.title),
			timeline: [],
			sidebarSections: [],
			composerDraft: '',
			composerPlaceholder: 'Reply to this OpenCode session...',
			composerState: 'idle',
			composerStatus: 'Ready for the next prompt.',
			selectedAgent: this._availableAgents[0]?.id ?? 'agent',
			selectedModel: this._availableModels[0]?.id ?? 'default',
			availableAgents: [...this._availableAgents],
			availableModels: [...this._availableModels],
			status: 'Idle',
			preview: '',
			previewLoading: true,
			visualRunningUntil: 0,
			pendingApprovals: [],
			liveMessages: new Map()
		};
	}

	private _createTimeline(messages: readonly OpenCodeAPI.MessageWithParts[]): IAgentTimelineItem[] {
		const items: IAgentTimelineItem[] = [];
		for (const message of messages) {
			items.push(...this._createTimelineItemsForMessage(message));
		}

		return items;
	}

	private _createTimelineItemsForMessage(message: OpenCodeAPI.MessageWithParts): IAgentTimelineItem[] {
		const items: IAgentTimelineItem[] = [];
		const processIndexes = new Map<string, number>();
		const textSegments: string[] = [];
		const flushText = () => {
			const body = textSegments.join('\n\n').trim();
			if (!body) {
				textSegments.length = 0;
				return;
			}

			items.push({
				id: `${message.info.id}:text:${items.length}`,
				kind: message.info.role === 'user' ? 'user' : 'assistant',
				label: message.info.role === 'user' ? 'User request' : 'Agent response',
				body
			});
			textSegments.length = 0;
		};
		const upsertProcessItem = (result: IProcessAggregationResult) => {
			const existingIndex = processIndexes.get(result.key);
			if (existingIndex === undefined) {
				processIndexes.set(result.key, items.length);
				items.push(result.item);
				return;
			}

			items.splice(existingIndex, 1, result.item);
		};
		const getExistingProcessItem = (key: string): IAgentTimelineItem | undefined => {
			const existingIndex = processIndexes.get(key);
			return existingIndex === undefined ? undefined : items[existingIndex];
		};

		for (const [index, rawPart] of message.parts.entries()) {
			const part = normalizeOpenCodePart(rawPart);
			switch (part.type) {
				case 'text':
					if (part.text.trim()) {
						textSegments.push(part.text.trim());
					}
					break;
				case 'reasoning': {
					flushText();
					const reasoning = part.reasoning?.trim() || part.text?.trim();
					if (reasoning) {
						items.push({
							id: `${message.info.id}:${part.id ?? `reasoning:${index}`}`,
							kind: 'reasoning',
							label: 'Reasoning',
							title: 'Model reasoning',
							body: reasoning,
							tone: 'neutral'
						});
					}
					break;
				}
				case 'step-start':
					break;
				case 'step-finish':
					flushText();
					if (shouldSurfaceStepFinishReason(part.reason)) {
						items.push(this._createStepFinishItem(message, part, index));
					}
					break;
				case 'tool-invocation':
					flushText();
					upsertProcessItem(this._createToolInvocationItem(message, part, index, getExistingProcessItem));
					break;
				case 'tool-result':
					flushText();
					upsertProcessItem(this._createToolResultItem(message, part, index, getExistingProcessItem));
					break;
				case 'patch':
					flushText();
					items.push(this._createPatchItem(message, part, index));
					break;
				case 'snapshot':
					flushText();
					break;
			}
		}

		const summaryDiffs = this._extractSummaryDiffs(message);
		if (summaryDiffs.length) {
			flushText();
			items.push({
				id: `${message.info.id}:summary-diff`,
				kind: 'patch',
				label: 'Patch',
				title: 'Workspace changes',
				body: `Edited ${summaryDiffs.length} file(s).`,
				bullets: summaryDiffs,
				tone: 'success',
				phase: 'succeeded',
				stateLabel: 'Changed',
				filePaths: summaryDiffs,
				sourceMessageId: message.info.id
			});
		}

		flushText();

		const messageError = this._createMessageErrorItem(message);
		if (messageError) {
			items.push(messageError);
		}

		return items;
	}

	private _derivePreview(messages: readonly OpenCodeAPI.MessageWithParts[]): string {
		for (let index = messages.length - 1; index >= 0; index--) {
			const items = this._createTimelineItemsForMessage(messages[index]);
			for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex--) {
				const item = items[itemIndex];
				if (item.kind === 'user' || item.kind === 'assistant') {
					return item.body;
				}
				if (item.kind === 'command' || item.kind === 'tool' || item.kind === 'patch') {
					return item.title ? `${item.label}: ${item.title}` : item.label;
				}
				if (item.kind === 'error') {
					return item.body;
				}
			}
		}

		return 'OpenCode session';
	}

	private _deriveModelLabel(messages: readonly OpenCodeAPI.MessageWithParts[]): string {
		for (let index = messages.length - 1; index >= 0; index--) {
			const info = messages[index].info;
			const selection = this._getMessageModelSelection(info);
			if (selection) {
				return this._labelForModelSelection(selection);
			}
		}

		return this._backendVersion;
	}

	private _deriveAgentLabel(messages: readonly OpenCodeAPI.MessageWithParts[]): string {
		for (let index = messages.length - 1; index >= 0; index--) {
			const info = messages[index].info;
			if (info.agent || info.mode) {
				return info.agent ?? info.mode ?? 'Agent';
			}
		}

		return 'Agent';
	}

	private _updateComposerOptions(config: OpenCodeAPI.Config, providersConfig: OpenCodeAPI.ProvidersConfigResponse, agents: readonly OpenCodeAPI.AgentInfo[]): void {
		const primaryAgents = agents
			.filter(agent => !agent.hidden && (agent.mode === 'primary' || !agent.mode))
			.map(agent => ({ id: agent.name, label: agent.name }));
		const configuredAgents = Object.keys(config.agent ?? {}).map(id => ({ id, label: id }));
		const configuredModes = Object.keys(config.mode ?? {}).map(id => ({ id, label: id }));

		const mergedAgents = [...primaryAgents, ...configuredAgents, ...configuredModes]
			.filter((option, index, array) => array.findIndex(entry => entry.id === option.id) === index);

		this._availableAgents = mergedAgents.length ? mergedAgents : [{ id: 'agent', label: 'Agent' }];

		const models: IAgentComposerOption[] = [];
		for (const provider of providersConfig.providers ?? []) {
			for (const [modelKey, modelInfo] of Object.entries(provider.models ?? {})) {
				if (modelInfo.status && modelInfo.status !== 'active') {
					continue;
				}

				const modelId = modelInfo.id ?? modelKey;
				const modelName = modelInfo.name ?? modelId;
				const providerLabel = provider.name ?? provider.id;
				const contextWindowInfo = this._parseContextWindowInfo(modelInfo);
				models.push({
					id: this._toModelOptionId(modelInfo.providerID ?? provider.id, modelId),
					label: modelName,
					detail: providerLabel,
					...contextWindowInfo
				});
			}
		}

		models.sort((left, right) => {
			if (left.id === DEFAULT_OPEN_CODE_MODEL_OPTION_ID) {
				return -1;
			}

			if (right.id === DEFAULT_OPEN_CODE_MODEL_OPTION_ID) {
				return 1;
			}

			return left.label.localeCompare(right.label);
		});

		this._availableModels = models.length ? models : [{ id: 'default', label: 'Default model' }];

		for (const session of this._sessions.values()) {
			session.availableAgents = [...this._availableAgents];
			session.availableModels = [...this._availableModels];
			session.selectedAgent = this._resolveSelectedAgentId(session.runtimeModeLabel, session.selectedAgent);
			session.selectedModel = this._resolveSelectedModelId(session.modelLabel, session.selectedModel);
			session.contextUsage = this._deriveContextUsage(session);
		}

		this._emitChange();
	}

	private _parseContextWindowInfo(modelInfo: OpenCodeAPI.ProviderModelInfo): Pick<IAgentComposerOption, 'maxContextWindow' | 'maxInputTokens' | 'maxOutputTokens' | 'totalContextWindow'> {
		const maxContextWindow = this._coercePositiveNumber(modelInfo.maxContextWindow);
		const maxInputTokens = this._coercePositiveNumber(modelInfo.maxInputTokens);
		const maxOutputTokens = this._coercePositiveNumber(modelInfo.maxOutputTokens);
		const totalContextWindow = maxInputTokens !== undefined && maxOutputTokens !== undefined
			? maxInputTokens + maxOutputTokens
			: maxContextWindow;

		return {
			...(maxContextWindow !== undefined ? { maxContextWindow } : {}),
			...(maxInputTokens !== undefined ? { maxInputTokens } : {}),
			...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
			...(totalContextWindow !== undefined ? { totalContextWindow } : {}),
		};
	}

	private _coercePositiveNumber(value: unknown): number | undefined {
		const parsedValue = typeof value === 'number'
			? value
			: typeof value === 'string'
				? Number(value)
				: NaN;

		return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : undefined;
	}

	private _resolveSelectedAgentId(preferredLabel: string, currentId: string | undefined): string {
		const current = currentId && this._availableAgents.find(option => option.id === currentId);
		if (current) {
			return current.id;
		}

		const preferred = this._availableAgents.find(option =>
			option.id === preferredLabel ||
			option.label.toLowerCase() === preferredLabel.toLowerCase()
		);

		return preferred?.id ?? this._availableAgents[0]?.id ?? 'agent';
	}

	private _resolveSelectedModelId(preferredLabel: string, currentId: string | undefined): string {
		const current = currentId && this._availableModels.find(option => option.id === currentId);
		if (current) {
			return current.id;
		}

		const matchingOptions = this._availableModels.filter(option =>
			option.id === preferredLabel ||
			this._parseSelectedModel(option.id)?.modelID === preferredLabel ||
			option.label === preferredLabel ||
			option.detail === preferredLabel ||
			(option.detail ? `${option.label} (${option.detail})` === preferredLabel : false) ||
			(option.detail ? `${option.label} · ${option.detail}` === preferredLabel : false)
		);

		const preferred = matchingOptions.find(option => option.id === DEFAULT_OPEN_CODE_MODEL_OPTION_ID)
			?? matchingOptions[0];
		const defaultOption = this._availableModels.find(option => option.id === DEFAULT_OPEN_CODE_MODEL_OPTION_ID);

		return preferred?.id ?? defaultOption?.id ?? this._availableModels[0]?.id ?? 'default';
	}

	private _toModelOptionId(providerID: string, modelID: string): string {
		return `${providerID}::${modelID}`;
	}

	private _parseSelectedModel(selectedModel: string | undefined): IAgentModelSelection | undefined {
		if (!selectedModel) {
			return undefined;
		}

		const separatorIndex = selectedModel.indexOf('::');
		if (separatorIndex < 0) {
			return undefined;
		}

		const providerID = selectedModel.slice(0, separatorIndex);
		const modelID = selectedModel.slice(separatorIndex + 2);
		if (!providerID || !modelID) {
			return undefined;
		}

		return { providerID, modelID };
	}

	private _getMessageModelSelection(info: OpenCodeAPI.MessageInfo): IAgentModelSelection | undefined {
		const providerID = info.providerID ?? info.model?.providerID;
		const modelID = info.modelID ?? info.model?.modelID;
		if (!providerID || !modelID) {
			return undefined;
		}

		return { providerID, modelID };
	}

	private _labelForModelSelection(selection: IAgentModelSelection): string {
		const optionId = this._toModelOptionId(selection.providerID, selection.modelID);
		const matchingOption = this._availableModels.find(option => option.id === optionId);
		if (matchingOption) {
			return matchingOption.label;
		}

		return selection.modelID;
	}

	private _createMessageErrorItem(message: OpenCodeAPI.MessageWithParts): IAgentTimelineItem | undefined {
		if (!message.info.error) {
			return undefined;
		}

		const presentation = this._createErrorPresentation(message.info.error, this._getMessageModelSelection(message.info));
		return {
			id: `${message.info.id}:error`,
			kind: 'error',
			label: presentation.label,
			body: presentation.body,
			meta: presentation.meta,
			tone: 'error',
			sourceMessageId: message.info.id
		};
	}

	private _extractLastMessageError(messages: readonly OpenCodeAPI.MessageWithParts[]): IAgentErrorPresentation | undefined {
		const lastMessage = messages.at(-1);
		if (!lastMessage?.info.error) {
			return undefined;
		}

		return this._createErrorPresentation(lastMessage.info.error, this._getMessageModelSelection(lastMessage.info));
	}

	private _syncPendingApprovalsFromBackend(session: AgentSessionState, timeline: IAgentTimelineItem[], requests: readonly OpenCodeAPI.PermissionRequest[]): void {
		const pendingApprovals: IAgentTimelineItem[] = [];

		for (const request of requests) {
			const linkedProcess = this._findTimelineProcessByToolIdentifiers(timeline, request.tool?.messageID, request.tool?.callID);
			if (linkedProcess?.processGroupId) {
				for (let index = 0; index < timeline.length; index++) {
					const item = timeline[index];
					if (item.processGroupId === linkedProcess.processGroupId && (item.kind === 'tool' || item.kind === 'command')) {
						timeline[index] = {
							...item,
							tone: 'warning',
							phase: 'waitingApproval',
							stateLabel: 'Waiting approval'
						};
					}
				}
			}

			pendingApprovals.push(this._createApprovalTimelineItem({
				requestId: request.id,
				title: linkedProcess?.title ?? this._formatPermissionLabel(request.permission),
				args: { permission: request.permission, patterns: request.patterns, tool: request.tool },
				linkedProcess,
				permissionLabel: this._formatPermissionLabel(request.permission),
				patterns: request.patterns,
				rawData: this._serializeRawData({ permission: request.permission, patterns: request.patterns, tool: request.tool }),
				sourceMessageId: request.tool?.messageID ?? linkedProcess?.sourceMessageId
			}));
		}

		session.pendingApprovals = pendingApprovals;
	}

	private _formatPermissionLabel(permission: string): string {
		if (!permission) {
			return 'Tool';
		}

		const words = permission.split('_').filter(Boolean);
		return words.map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
	}

	private _createErrorPresentation(error: unknown, model: IAgentModelSelection | string | undefined): IAgentErrorPresentation {
		const record = error && typeof error === 'object' ? error as Record<string, unknown> : undefined;
		const errorMessage = this._extractErrorMessage(error);
		const statusCode = typeof record?.['statusCode'] === 'number' ? record['statusCode'] : undefined;
		const upstream = typeof record?.['url'] === 'string' ? record['url'] : undefined;
		const modelLabel = typeof model === 'string'
			? model
			: model
				? this._labelForModelSelection(model)
				: undefined;
		const composerParts = [
			modelLabel,
			statusCode !== undefined ? `HTTP ${statusCode}` : undefined,
			errorMessage
		].filter((entry): entry is string => !!entry);
		const meta = [
			modelLabel ? `Model: ${modelLabel}` : undefined,
			statusCode !== undefined ? `HTTP ${statusCode}` : undefined,
			upstream ? `Upstream: ${upstream}` : undefined
		].filter((entry): entry is string => !!entry);

		return {
			label: 'Request failed',
			body: errorMessage,
			meta: meta.length ? meta : undefined,
			composerStatus: 'Last request failed.',
			composerError: composerParts.join(' · '),
			subtitle: modelLabel
				? `Connected to ${this._backendVersion}. Last error: ${modelLabel} · ${errorMessage}`
				: `Connected to ${this._backendVersion}. Last error: ${errorMessage}`
		};
	}

	private _extractErrorMessage(error: unknown): string {
		if (typeof error === 'string' && error.trim()) {
			return error.trim();
		}

		if (error && typeof error === 'object') {
			const record = error as Record<string, unknown>;
			for (const key of ['message', 'error', 'description', 'details']) {
				const value = record[key];
				if (typeof value === 'string' && value.trim()) {
					return value.trim();
				}
			}
		}

		return this._stringifyUnknownValue(error);
	}

	private _deriveExecutionPhase(session: AgentSessionState, messages: readonly OpenCodeAPI.MessageWithParts[], timeline: readonly IAgentTimelineItem[]): AgentSessionPhase {
		return deriveAgentSessionExecutionPhase(session.sessionPhase, messages, timeline);
	}

	private _hasRunningTimelineProcesses(timeline: readonly IAgentTimelineItem[]): boolean {
		return timeline.some(item => item.phase === 'pending' || item.phase === 'running');
	}

	private _hasWaitingApprovalProcesses(timeline: readonly IAgentTimelineItem[]): boolean {
		return timeline.some(item => item.phase === 'waitingApproval');
	}

	private _getComposerStatusForExecution(session: AgentSessionState, phase: AgentSessionPhase): string {
		if (phase === 'waitingApproval') {
			return 'Approval required. Review the request below to continue.';
		}

		if (phase !== 'running') {
			return '';
		}

		return session.composerStatus;
	}

	private _applySessionPhase(session: AgentSessionState, phase: AgentSessionPhase): void {
		session.sessionPhase = phase;
		session.stateLabel = this._getSessionPhaseLabel(phase);
		session.status = this._getSessionPhaseLabel(phase);
		session.composerState = getAgentComposerStateForPhase(phase);
	}

	private _getSessionPhaseLabel(phase: AgentSessionPhase): string {
		switch (phase) {
			case 'running':
				return 'Running';
			case 'waitingApproval':
				return 'Waiting approval';
			case 'error':
				return 'Error';
			case 'offline':
				return 'Offline';
			case 'idle':
			default:
				return 'Idle';
		}
	}

	private _isRunningPhase(phase: AgentSessionPhase): boolean {
		return phase === 'running';
	}

	private _updateSidebarSections(session: AgentSessionState, remote: { info: OpenCodeAPI.SessionInfo; messages: readonly OpenCodeAPI.MessageWithParts[]; agentLabel: string } | undefined): void {
		if (!remote) {
			session.sidebarSections = [
				{
					id: 'plan',
					title: 'Current plan',
					body: 'Get the first real OpenCode conversation flowing through the custom Agent Mode surface.'
				},
				{
					id: 'todo',
					title: 'Todo',
					bullets: [
						'Create or attach a backend session',
						'Stream messages into the center timeline',
						'Promote tool calls into richer blocks'
					]
				},
				{
					id: 'subagents',
					title: 'Subagents',
					body: 'Runtime state will appear here once the backend reports it.'
				},
				{
					id: 'domain',
					title: 'Agent session domain',
					body: this._describeBackendTarget()
				}
			];
			return;
		}

		const toolCalls = remote.messages.flatMap(message =>
			message.parts
				.map(part => normalizeOpenCodePart(part))
				.filter((part): part is OpenCodeAPI.ToolInvocationPart => part.type === 'tool-invocation')
				.map(part => `${part.toolInvocation?.toolName ?? 'Unknown tool'} (${part.toolInvocation?.state ?? 'running'})`)
		);

		session.sidebarSections = [
			{
				id: 'plan',
				title: 'Current plan',
				body: 'The first integration pass keeps the main conversation live and uses this rail for stable execution context.',
				bullets: [
					'Refresh timeline from OpenCode messages',
					'Keep the editor area focused on the latest exchange',
					'Promote richer tool state in later iterations'
				]
			},
			{
				id: 'todo',
				title: 'Todo',
				bullets: toolCalls.length ? toolCalls.slice(-4) : ['No tool activity captured yet']
			},
			{
				id: 'subagents',
				title: 'Subagents',
				bullets: [`Current runtime: ${remote.agentLabel}`]
			},
			{
				id: 'domain',
				title: 'Agent session domain',
				bullets: [
					`Session ID: ${remote.info.id}`,
					`Version: ${remote.info.version}`,
					...(remote.info.directory ? [`Directory: ${remote.info.directory}`] : [])
				]
			}
		];
	}

	private _createToolInvocationItem(message: OpenCodeAPI.MessageWithParts, part: OpenCodeAPI.ToolInvocationPart, index: number, getExistingProcessItem: (key: string) => IAgentTimelineItem | undefined): IProcessAggregationResult {
		return this._createToolLifecycleInvocationItem(message, part, index, getExistingProcessItem);
		/*
		const toolName = part.toolInvocation?.toolName ?? 'Unknown tool';
		const state = part.toolInvocation?.state ?? 'call';
		const args = part.toolInvocation?.args;
		const command = this._extractCommandText(args);
		if (command || this._looksLikeTerminalTool(toolName)) {
			return {
				id: `${message.info.id}:${part.id ?? `tool-invocation:${index}`}`,
				kind: 'command',
				label: 'Run command',
				title: toolName,
				body: state === 'partial-call' ? 'Preparing command…' : 'Running command',
				code: command ?? '',
				bullets: this._buildCommandContext(args),
				tone: 'running'
			};
		}

		return {
			id: `${message.info.id}:${part.id ?? `tool-invocation:${index}`}`,
			kind: 'tool',
			label: 'Tool call',
			title: toolName,
			body: this._formatToolStateBody(state),
			bullets: this._stringifyUnknownEntries(args),
			tone: state === 'result' ? 'success' : 'running',
			sourceMessageId: message.info.id
		};
		*/
	}

	private _createToolResultItem(message: OpenCodeAPI.MessageWithParts, part: OpenCodeAPI.ToolResultPart, index: number, getExistingProcessItem: (key: string) => IAgentTimelineItem | undefined): IProcessAggregationResult {
		return this._createToolLifecycleResultItem(message, part, index, getExistingProcessItem);
		/*
		const toolName = part.toolResult?.toolName ?? 'Unknown tool';
		const result = part.toolResult?.result;
		const command = this._extractCommandText(result);
		const flattenedResult = this._stringifyUnknownEntries(result);
		if (command || this._looksLikeTerminalTool(toolName)) {
			return {
				id: `${message.info.id}:${part.id ?? `tool-result:${index}`}`,
				kind: 'command',
				label: 'Command result',
				title: toolName,
				body: 'Command finished.',
				code: command,
				bullets: flattenedResult?.slice(0, 8),
				tone: 'success',
				sourceMessageId: message.info.id
			};
		}

		return {
			id: `${message.info.id}:${part.id ?? `tool-result:${index}`}`,
			kind: 'tool',
			label: 'Tool result',
			title: toolName,
			body: `${toolName} returned a result.`,
			bullets: flattenedResult?.slice(0, 8),
			tone: 'success',
			sourceMessageId: message.info.id
		};
		*/
	}

	private _createPatchItem(message: OpenCodeAPI.MessageWithParts, part: OpenCodeAPI.PatchPart, index: number): IAgentTimelineItem {
		const files = (part.files?.length ? [...part.files] : this._extractSummaryDiffs(message)).slice(0, 12);
		return {
			id: `${message.info.id}:${part.id ?? `patch:${index}`}`,
			kind: 'patch',
			label: 'Patch',
			title: 'Workspace changes',
			body: files.length ? `Edited ${files.length} file(s).` : 'Patch generated.',
			bullets: files.length ? files : undefined,
			details: files.length ? [{ label: 'Files changed', value: String(files.length) }] : undefined,
			sections: files.length ? [{ label: 'Changed files', type: 'list', items: files }] : undefined,
			rawData: files.length ? files.join('\n') : undefined,
			tone: 'success',
			phase: 'succeeded',
			stateLabel: 'Changed',
			filePaths: files.length ? files : undefined,
			sourceMessageId: message.info.id
		};
	}

	private _createToolLifecycleInvocationItem(message: OpenCodeAPI.MessageWithParts, part: OpenCodeAPI.ToolInvocationPart, index: number, getExistingProcessItem: (key: string) => IAgentTimelineItem | undefined): IProcessAggregationResult {
		const toolName = part.toolInvocation?.toolName ?? 'Unknown tool';
		const state = part.toolInvocation?.state ?? 'call';
		const args = part.toolInvocation?.args;
		const command = this._extractCommandText(args);
		const key = this._getToolProcessKey(message.info.id, part.toolInvocation?.toolCallId, part.id ?? `tool-invocation:${index}`);
		const existing = getExistingProcessItem(key);
		const lifecycle = this._resolveToolInvocationLifecycle(state);

		if (command || this._looksLikeTerminalTool(toolName)) {
			return {
				key,
				item: {
					id: existing?.id ?? `${message.info.id}:${part.id ?? `tool-invocation:${index}`}`,
					kind: 'command',
					label: 'Command',
					title: toolName,
					body: this._formatCommandLifecycleBody(lifecycle.phase),
					code: command ?? existing?.code ?? '',
					bullets: this._mergeTextEntries(existing?.bullets, this._buildCommandContext(args)),
					details: this._mergeDetails(existing?.details, this._buildCommandContextDetails(args)),
					rawData: existing?.rawData ?? this._serializeRawData(args),
					meta: existing?.meta,
					tone: lifecycle.tone,
					phase: lifecycle.phase,
					stateLabel: lifecycle.stateLabel,
					processGroupId: key,
					sourceMessageId: message.info.id
				}
			};
		}

		return {
			key,
			item: {
				id: existing?.id ?? `${message.info.id}:${part.id ?? `tool-invocation:${index}`}`,
				kind: 'tool',
				label: 'Tool',
				title: toolName,
				body: this._formatToolLifecycleBody(lifecycle.phase),
				bullets: this._mergeTextEntries(existing?.bullets, this._stringifyUnknownEntries(args)),
				sections: this._mergeSections(existing?.sections, this._buildToolInvocationSections(args)),
				rawData: existing?.rawData ?? this._serializeRawData(args),
				tone: lifecycle.tone,
				phase: lifecycle.phase,
				stateLabel: lifecycle.stateLabel,
				processGroupId: key,
				sourceMessageId: message.info.id
			}
		};
	}

	private _createToolLifecycleResultItem(message: OpenCodeAPI.MessageWithParts, part: OpenCodeAPI.ToolResultPart, index: number, getExistingProcessItem: (key: string) => IAgentTimelineItem | undefined): IProcessAggregationResult {
		const toolName = part.toolResult?.toolName ?? 'Unknown tool';
		const result = part.toolResult?.result;
		const command = this._extractCommandText(result);
		const flattenedResult = this._stringifyUnknownEntries(result);
		const key = this._getToolProcessKey(message.info.id, part.toolResult?.toolCallId, part.id ?? `tool-result:${index}`);
		const existing = getExistingProcessItem(key);
		const lifecycle = this._resolveToolResultLifecycle(result);
		const commandLike = existing?.kind === 'command' || !!command || this._looksLikeTerminalTool(toolName);

		if (commandLike) {
			const commandResultDetails = this._mergeDetails(existing?.details, this._buildCommandResultDetails(result));
			const commandSections = this._mergeSections(existing?.sections, this._buildCommandResultSections(result));
			return {
				key,
				item: {
					id: existing?.id ?? `${message.info.id}:${part.id ?? `tool-result:${index}`}`,
					kind: 'command',
					label: 'Command',
					title: toolName,
					body: this._formatCommandLifecycleBody(lifecycle.phase),
					code: existing?.code ?? command ?? '',
					bullets: this._mergeTextEntries(existing?.bullets, this._buildCommandResultSummaryBullets(result)),
					details: commandResultDetails,
					sections: commandSections,
					rawData: this._serializeRawData(result) ?? existing?.rawData,
					meta: this._mergeTextEntries(existing?.meta, this._buildCommandResultMeta(result)),
					tone: lifecycle.tone,
					phase: lifecycle.phase,
					stateLabel: lifecycle.stateLabel,
					processGroupId: key,
					sourceMessageId: message.info.id
				}
			};
		}

		return {
			key,
			item: {
				id: existing?.id ?? `${message.info.id}:${part.id ?? `tool-result:${index}`}`,
				kind: 'tool',
				label: 'Tool',
				title: toolName,
				body: this._formatToolLifecycleBody(lifecycle.phase),
				bullets: this._mergeTextEntries(existing?.bullets, flattenedResult?.slice(0, 8)),
				sections: this._mergeSections(existing?.sections, this._buildToolResultSections(result)),
				rawData: this._serializeRawData(result) ?? existing?.rawData,
				tone: lifecycle.tone,
				phase: lifecycle.phase,
				stateLabel: lifecycle.stateLabel,
				processGroupId: key,
				sourceMessageId: message.info.id
			}
		};
	}

	private _createStepFinishItem(message: OpenCodeAPI.MessageWithParts, part: OpenCodeAPI.StepFinishPart, index: number): IAgentTimelineItem {
		const stateLabel = part.reason ? this._formatStepFinishReason(part.reason) : 'Completed';
		return {
			id: `${message.info.id}:${part.id ?? `step-finish:${index}`}`,
			kind: 'status',
			label: 'Execution',
			title: stateLabel,
			body: part.reason ? `Execution ended with reason: ${this._formatStepFinishReason(part.reason)}.` : 'Execution ended.',
			details: this._buildStepFinishDetails(part),
			tone: part.reason === 'cancelled' ? 'warning' : 'success',
			phase: part.reason === 'cancelled' ? 'cancelled' : 'succeeded',
			stateLabel
		};
	}

	private _getToolProcessKey(messageId: string, toolCallId: string | undefined, fallbackId: string): string {
		return `${messageId}:tool:${toolCallId ?? fallbackId}`;
	}

	private _mergeTextEntries(existing: readonly string[] | undefined, next: readonly string[] | undefined): string[] | undefined {
		const merged = [...(existing ?? []), ...(next ?? [])].filter((entry, index, array) => !!entry && array.indexOf(entry) === index);
		return merged.length ? merged : undefined;
	}

	private _mergeDetails(existing: readonly IAgentTimelineDetail[] | undefined, next: readonly IAgentTimelineDetail[] | undefined): IAgentTimelineDetail[] | undefined {
		const merged = [...(existing ?? []), ...(next ?? [])].filter((entry, index, array) =>
			!!entry.value && array.findIndex(candidate => candidate.label === entry.label && candidate.value === entry.value) === index
		);
		return merged.length ? merged : undefined;
	}

	private _mergeSections(existing: readonly IAgentTimelineSection[] | undefined, next: readonly IAgentTimelineSection[] | undefined): IAgentTimelineSection[] | undefined {
		const merged = [...(existing ?? []), ...(next ?? [])].filter((entry, index, array) =>
			(entry.type === 'code' ? !!entry.value : !!entry.items?.length)
			&& array.findIndex(candidate =>
				candidate.label === entry.label
				&& candidate.type === entry.type
				&& candidate.presentation === entry.presentation
				&& candidate.value === entry.value
				&& JSON.stringify(candidate.items ?? []) === JSON.stringify(entry.items ?? [])
			) === index
		);
		return merged.length ? merged : undefined;
	}

	private _resolveToolInvocationLifecycle(state: string): { phase: AgentProcessPhase; tone: AgentTimelineTone; stateLabel: string } {
		switch (state) {
			case 'partial-call':
				return { phase: 'pending', tone: 'neutral', stateLabel: 'Preparing' };
			case 'waiting-approval':
			case 'needs-approval':
				return { phase: 'waitingApproval', tone: 'warning', stateLabel: 'Waiting approval' };
			case 'cancelled':
				return { phase: 'cancelled', tone: 'warning', stateLabel: 'Cancelled' };
			case 'call':
			default:
				return { phase: 'running', tone: 'running', stateLabel: 'Running' };
		}
	}

	private _resolveToolResultLifecycle(result: unknown): { phase: AgentProcessPhase; tone: AgentTimelineTone; stateLabel: string } {
		if (this._isFailedToolResult(result)) {
			return { phase: 'failed', tone: 'error', stateLabel: 'Failed' };
		}

		return { phase: 'succeeded', tone: 'success', stateLabel: 'Completed' };
	}

	private _isFailedToolResult(result: unknown): boolean {
		if (!result || typeof result !== 'object') {
			return false;
		}

		const record = result as Record<string, unknown>;
		if (typeof record['success'] === 'boolean') {
			return !record['success'];
		}
		if (typeof record['exitCode'] === 'number') {
			return record['exitCode'] !== 0;
		}
		if (typeof record['code'] === 'number') {
			return record['code'] !== 0;
		}
		if (record['error']) {
			return true;
		}

		return false;
	}

	private _buildCommandResultMeta(result: unknown): string[] | undefined {
		if (!result || typeof result !== 'object') {
			return undefined;
		}

		const record = result as Record<string, unknown>;
		const meta: string[] = [];
		if (typeof record['exitCode'] === 'number') {
			meta.push(`exit code: ${record['exitCode']}`);
		} else if (typeof record['code'] === 'number') {
			meta.push(`exit code: ${record['code']}`);
		}

		return meta.length ? meta : undefined;
	}

	private _buildStepFinishDetails(part: OpenCodeAPI.StepFinishPart): IAgentTimelineDetail[] | undefined {
		const details: IAgentTimelineDetail[] = [];
		if (part.reason) {
			details.push({ label: 'Reason', value: this._formatStepFinishReason(part.reason) });
		}
		if (typeof part.cost === 'number') {
			details.push({ label: 'Cost', value: String(part.cost) });
		}
		if (typeof part.tokens?.total === 'number') {
			details.push({ label: 'Tokens', value: String(part.tokens.total) });
		}
		if (typeof part.tokens?.input === 'number') {
			details.push({ label: 'Input tokens', value: String(part.tokens.input) });
		}
		if (typeof part.tokens?.output === 'number') {
			details.push({ label: 'Output tokens', value: String(part.tokens.output) });
		}
		if (typeof part.tokens?.reasoning === 'number') {
			details.push({ label: 'Reasoning tokens', value: String(part.tokens.reasoning) });
		}
		if (typeof part.tokens?.cache?.read === 'number') {
			details.push({ label: 'Cache read', value: String(part.tokens.cache.read) });
		}
		if (typeof part.tokens?.cache?.write === 'number') {
			details.push({ label: 'Cache write', value: String(part.tokens.cache.write) });
		}
		return details.length ? details : undefined;
	}

	private _buildCommandContextDetails(args: unknown): IAgentTimelineDetail[] | undefined {
		if (!args || typeof args !== 'object') {
			return undefined;
		}

		const record = args as Record<string, unknown>;
		const details: IAgentTimelineDetail[] = [];
		if (typeof record['cwd'] === 'string' && record['cwd']) {
			details.push({ label: 'Cwd', value: record['cwd'] });
		}
		if (typeof record['workdir'] === 'string' && record['workdir']) {
			details.push({ label: 'Workdir', value: record['workdir'] });
		}
		if (typeof record['timeout'] === 'number') {
			details.push({ label: 'Timeout', value: `${record['timeout']}ms` });
		}
		if (typeof record['description'] === 'string' && record['description']) {
			details.push({ label: 'Purpose', value: record['description'] });
		}
		return details.length ? details : undefined;
	}

	private _buildCommandResultDetails(result: unknown): IAgentTimelineDetail[] | undefined {
		if (!result || typeof result !== 'object') {
			return undefined;
		}

		const record = result as Record<string, unknown>;
		const details: IAgentTimelineDetail[] = [];
		if (typeof record['exitCode'] === 'number') {
			details.push({ label: 'Exit code', value: String(record['exitCode']) });
		} else if (typeof record['code'] === 'number') {
			details.push({ label: 'Exit code', value: String(record['code']) });
		}
		if (typeof record['success'] === 'boolean') {
			details.push({ label: 'Success', value: record['success'] ? 'Yes' : 'No' });
		}
		return details.length ? details : undefined;
	}

	private _buildCommandResultSections(result: unknown): IAgentTimelineSection[] | undefined {
		if (!result || typeof result !== 'object') {
			return undefined;
		}

		const record = result as Record<string, unknown>;
		const sections: IAgentTimelineSection[] = [];
		const stdout = this._coerceTextBlock(record['stdout']) ?? this._coerceTextBlock(record['output']);
		const stderr = this._coerceTextBlock(record['stderr']) ?? this._coerceTextBlock(record['error']);
		if (stdout) {
			sections.push({ label: 'Standard output', type: 'code', value: stdout, presentation: 'stdout' });
		}
		if (stderr) {
			sections.push({ label: 'Standard error', type: 'code', value: stderr, presentation: 'stderr' });
		}

		const remainder = { ...record };
		delete remainder['command'];
		delete remainder['stdout'];
		delete remainder['output'];
		delete remainder['stderr'];
		delete remainder['error'];
		delete remainder['exitCode'];
		delete remainder['code'];
		delete remainder['success'];
		const remainderEntries = this._stringifyUnknownEntries(remainder);
		if (remainderEntries?.length) {
			sections.push({ label: 'Structured result', type: 'list', items: remainderEntries.slice(0, 10) });
		}

		return sections.length ? sections : undefined;
	}

	private _buildCommandResultSummaryBullets(result: unknown): string[] | undefined {
		if (!result || typeof result !== 'object') {
			return undefined;
		}

		const record = { ...(result as Record<string, unknown>) };
		delete record['command'];
		delete record['stdout'];
		delete record['output'];
		delete record['stderr'];
		delete record['error'];
		delete record['exitCode'];
		delete record['code'];
		delete record['success'];
		return this._stringifyUnknownEntries(record)?.slice(0, 8);
	}

	private _buildToolInvocationSections(args: unknown): IAgentTimelineSection[] | undefined {
		const entries = this._stringifyUnknownEntries(args);
		return entries?.length ? [{ label: 'Arguments', type: 'list', items: entries.slice(0, 10) }] : undefined;
	}

	private _buildToolResultSections(result: unknown): IAgentTimelineSection[] | undefined {
		const entries = this._stringifyUnknownEntries(result);
		return entries?.length ? [{ label: 'Result', type: 'list', items: entries.slice(0, 10) }] : undefined;
	}

	private _extractSummaryDiffs(message: OpenCodeAPI.MessageWithParts): string[] {
		return Array.isArray(message.info.summary?.diffs)
			? message.info.summary.diffs.filter((entry): entry is string => typeof entry === 'string' && !!entry)
			: [];
	}

	private _looksLikeTerminalTool(toolName: string): boolean {
		const value = toolName.toLowerCase();
		return value.includes('bash') || value.includes('shell') || value.includes('terminal') || value.includes('command');
	}

	private _extractCommandText(value: unknown): string | undefined {
		return extractCommandText(value);
	}

	private _buildCommandContext(args: unknown): string[] | undefined {
		if (!args || typeof args !== 'object') {
			return undefined;
		}

		const record = args as Record<string, unknown>;
		const context: string[] = [];
		if (typeof record['cwd'] === 'string' && record['cwd']) {
			context.push(`cwd: ${record['cwd']}`);
		}
		if (typeof record['workdir'] === 'string' && record['workdir']) {
			context.push(`workdir: ${record['workdir']}`);
		}
		if (typeof record['description'] === 'string' && record['description']) {
			context.push(`description: ${record['description']}`);
		}
		if (typeof record['timeout'] === 'number') {
			context.push(`timeout: ${record['timeout']}ms`);
		}

		return context.length ? context : undefined;
	}

	private _formatCommandLifecycleBody(phase: AgentProcessPhase): string {
		switch (phase) {
			case 'pending':
				return 'Preparing';
			case 'running':
				return 'Running';
			case 'waitingApproval':
				return 'Waiting for approval';
			case 'failed':
				return 'Failed';
			case 'cancelled':
				return 'Cancelled';
			case 'succeeded':
			default:
				return 'Completed';
		}
	}

	private _formatToolLifecycleBody(phase: AgentProcessPhase): string {
		switch (phase) {
			case 'pending':
				return this._formatLifecycleToolBody('partial-call');
			case 'running':
				return this._formatLifecycleToolBody('call');
			case 'waitingApproval':
				return this._formatLifecycleToolBody('waiting-approval');
			case 'failed':
				return 'Failed';
			case 'cancelled':
				return this._formatLifecycleToolBody('cancelled');
			case 'succeeded':
			default:
				return 'Completed';
		}
	}

	private _formatStepFinishReason(reason: string): string {
		const normalized = reason.trim().replace(/[-_]+/g, ' ');
		return normalized ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : 'Completed';
	}

	private _formatLifecycleToolBody(state: string): string {
		switch (state) {
			case 'partial-call':
				return 'Preparing tool call...';
			case 'waiting-approval':
			case 'needs-approval':
				return 'Waiting for approval.';
			case 'cancelled':
				return 'Tool call cancelled.';
			case 'call':
			default:
				return this._formatToolStateBody(state);
		}
	}

	private _formatToolStateBody(state: string): string {
		switch (state) {
			case 'partial-call':
				return 'Preparing tool call…';
			case 'result':
				return 'Tool finished.';
			case 'call':
			default:
				return 'Running tool';
		}
	}

	private _describeBackendTarget(): string {
		const runtime = this._backendRuntime;
		if (!runtime) {
			return `Backend target: ${this._agentBackendService.connectionLabel}`;
		}

		const active = runtime.location === AgentBackendLocation.Remote ? 'remote' : 'local';
		const requested = runtime.requestedLocation === AgentBackendLocation.Remote ? 'remote' : 'local';
		const authoritySuffix = runtime.remoteAuthority ? ` via ${runtime.remoteAuthority}` : '';
		const requestedSuffix = requested === active ? '' : ` (requested ${requested}${authoritySuffix})`;
		return `Backend target: ${runtime.connectionLabel} [${active}]${requestedSuffix}`;
	}

	private _cleanupSessionTitle(title: string): string {
		return cleanupAgentSessionTitle(title);
	}

	private _renderErrorSubtitle(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	private _describeBackendTargetSuffix(): string {
		const label = this._agentBackendService.connectionLabel.trim();
		return label ? ` at ${label}` : '';
	}

	private _insertSession(session: AgentSessionState, prepend: boolean): void {
		this._sessions.set(session.id, session);
		if (prepend) {
			this._sessionOrder.unshift(session.id);
		} else {
			this._sessionOrder.push(session.id);
		}
	}

	private _formatUpdatedLabel(timestamp: number): string {
		const deltaMinutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
		if (deltaMinutes < 1) {
			return 'Just now';
		}
		if (deltaMinutes < 60) {
			return `${deltaMinutes}m ago`;
		}
		const deltaHours = Math.floor(deltaMinutes / 60);
		if (deltaHours < 24) {
			return `${deltaHours}h ago`;
		}
		const deltaDays = Math.floor(deltaHours / 24);
		return `${deltaDays}d ago`;
	}

	private _deriveSummaryStatusTone(
		session: AgentSessionState,
	): AgentSessionSummaryTone {
		return deriveAgentSessionSummaryStatusTone(session.status, session.sessionPhase);
	}

	private _toSessionModel(session: AgentSessionState): IAgentSessionModel {
		return {
			id: session.id,
			title: session.title,
			subtitle: session.subtitle,
			backendLabel: session.backendLabel,
			backendTone: session.backendTone,
			workingDirectoryLabel: session.workingDirectoryLabel,
			sessionPhase: session.sessionPhase,
			stateLabel: session.stateLabel,
			modelLabel: session.modelLabel,
			runtimeModeLabel: session.runtimeModeLabel,
			sessionLabel: session.sessionLabel,
			timeline: session.timeline,
			sidebarSections: session.sidebarSections,
			composerDraft: session.composerDraft,
			composerPlaceholder: session.composerPlaceholder,
			composerState: session.composerState,
			composerStatus: session.composerStatus,
			composerError: session.composerError,
			contextUsage: session.contextUsage,
			selectedAgent: session.selectedAgent,
			selectedModel: session.selectedModel,
			availableAgents: session.availableAgents,
			availableModels: session.availableModels
		};
	}

	private _deriveContextUsage(session: AgentSessionState): IAgentSessionContextUsage | undefined {
		const totalContextWindow = this._resolveSessionContextWindow(session);
		if (totalContextWindow === undefined) {
			return undefined;
		}

		const latestTokens = this._findLatestStepFinishTokens(session);
		if (!latestTokens) {
			return undefined;
		}

		const usedTokens = this._deriveUsedTokens(latestTokens);
		if (usedTokens === undefined) {
			return undefined;
		}

		return {
			usedTokens,
			totalContextWindow,
			percentage: (usedTokens / totalContextWindow) * 100,
			inputTokens: latestTokens.input,
			outputTokens: latestTokens.output,
			reasoningTokens: latestTokens.reasoning
		};
	}

	private _resolveSessionContextWindow(session: AgentSessionState): number | undefined {
		const modelOption = this._findContextWindowModelOption(session);
		const totalContextWindow = modelOption?.totalContextWindow;
		return totalContextWindow !== undefined && totalContextWindow > 0 ? totalContextWindow : undefined;
	}

	private _findContextWindowModelOption(session: AgentSessionState): IAgentComposerOption | undefined {
		const messages = [...session.liveMessages.values()].sort((a, b) => {
			const left = a.info.time?.created ?? 0;
			const right = b.info.time?.created ?? 0;
			return right - left;
		});

		for (const message of messages) {
			const selection = this._getMessageModelSelection(message.info);
			if (!selection) {
				continue;
			}

			const optionId = this._toModelOptionId(selection.providerID, selection.modelID);
			const modelOption = session.availableModels.find(option => option.id === optionId);
			if (modelOption?.totalContextWindow !== undefined) {
				return modelOption;
			}
		}

		return session.availableModels.find(option => option.id === session.selectedModel && option.totalContextWindow !== undefined);
	}

	private _findLatestStepFinishTokens(session: AgentSessionState): OpenCodeAPI.StepFinishPart['tokens'] | undefined {
		const messages = [...session.liveMessages.values()].sort((a, b) => {
			const left = a.info.time?.created ?? 0;
			const right = b.info.time?.created ?? 0;
			return right - left;
		});

		for (const message of messages) {
			for (let index = message.parts.length - 1; index >= 0; index--) {
				const part = message.parts[index];
				if (part.type !== 'step-finish') {
					continue;
				}

				if (this._deriveUsedTokens(part.tokens) !== undefined) {
					return part.tokens;
				}
			}
		}

		return undefined;
	}

	private _deriveUsedTokens(tokens: OpenCodeAPI.StepFinishPart['tokens'] | undefined): number | undefined {
		if (!tokens) {
			return undefined;
		}

		if (typeof tokens.total === 'number' && Number.isFinite(tokens.total) && tokens.total >= 0) {
			return tokens.total;
		}

		const parts = [
			tokens.input,
			tokens.output,
			tokens.reasoning,
			tokens.cache?.read,
			tokens.cache?.write
		].filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0);

		if (!parts.length) {
			return undefined;
		}

		return parts.reduce((total, value) => total + value, 0);
	}

	private _stringifyUnknownEntries(value: unknown): string[] | undefined {
		if (value === undefined || value === null) {
			return undefined;
		}

		if (Array.isArray(value)) {
			const normalized = value
				.map(entry => this._stringifyUnknownValue(entry))
				.filter((entry): entry is string => !!entry);
			return normalized.length ? normalized : undefined;
		}

		if (typeof value === 'object') {
			const normalized = Object.entries(value)
				.map(([key, entry]) => `${key}: ${this._stringifyUnknownValue(entry)}`)
				.filter((entry): entry is string => !!entry);
			return normalized.length ? normalized : undefined;
		}

		return [this._stringifyUnknownValue(value)];
	}

	private _stringifyUnknownValue(value: unknown): string {
		if (value === undefined) {
			return 'undefined';
		}

		if (value === null) {
			return 'null';
		}

		if (typeof value === 'string') {
			return value;
		}

		if (typeof value === 'number' || typeof value === 'boolean') {
			return String(value);
		}

		try {
			return JSON.stringify(value);
		} catch {
			return String(value);
		}
	}

	private _coerceTextBlock(value: unknown): string | undefined {
		if (typeof value === 'string' && value.trim()) {
			return value.trim();
		}
		if (Array.isArray(value)) {
			const lines = value
				.map(entry => typeof entry === 'string' ? entry.trim() : this._stringifyUnknownValue(entry).trim())
				.filter((entry): entry is string => !!entry);
			return lines.length ? lines.join('\n') : undefined;
		}
		return undefined;
	}

	private _serializeRawData(value: unknown): string | undefined {
		if (value === undefined || value === null) {
			return undefined;
		}
		if (typeof value === 'string') {
			return value;
		}
		try {
			return JSON.stringify(value, null, 2);
		} catch {
			return this._stringifyUnknownValue(value);
		}
	}

	private _findSessionByRemoteId(remoteSessionId: string): AgentSessionState | undefined {
		for (const session of this._sessions.values()) {
			if (session.remoteId === remoteSessionId) {
				return session;
			}
		}

		return undefined;
	}

	private _upsertPendingApproval(remoteSessionId: string, requestId: string, toolName: string, args: unknown, toolMessageId?: string, toolCallId?: string): void {
		const session = this._findSessionByRemoteId(remoteSessionId);
		if (!session) {
			return;
		}

		const linkedProcess = this._findPendingApprovalProcess(session, toolName, toolMessageId, toolCallId);
		if (linkedProcess?.processGroupId) {
			session.timeline = session.timeline.map(item => {
				if (item.processGroupId === linkedProcess.processGroupId && (item.kind === 'tool' || item.kind === 'command')) {
					return {
						...item,
						tone: 'warning',
						phase: 'waitingApproval',
						stateLabel: 'Waiting approval'
					};
				}

				return item;
			});
		}

		const approvalItem = this._createApprovalTimelineItem({
			requestId,
			title: linkedProcess?.title ?? toolName,
			args,
			linkedProcess,
			rawData: this._serializeRawData(args),
			sourceMessageId: toolMessageId ?? linkedProcess?.sourceMessageId
		});

		const existingIndex = session.pendingApprovals.findIndex(item => item.id === approvalItem.id);
		if (existingIndex >= 0) {
			session.pendingApprovals.splice(existingIndex, 1, approvalItem);
		} else {
			session.pendingApprovals.push(approvalItem);
		}

		session.timeline = [...session.timeline.filter(item => item.kind !== 'approval'), ...session.pendingApprovals];
		session.updatedAt = Date.now();
		this._applySessionPhase(session, 'waitingApproval');
		session.composerStatus = 'Approval required. Review the request below to continue.';
		if (session.id === this._activeSessionId) {
			this._emitChange();
		}
	}

	private _clearPendingApprovals(remoteSessionId: string): void {
		const session = this._findSessionByRemoteId(remoteSessionId);
		if (!session || !session.pendingApprovals.length) {
			return;
		}

		const unresolvedApprovalIds = new Set(
			session.pendingApprovals
				.filter(item => item.phase === 'waitingApproval')
				.map(item => item.id)
		);
		if (!unresolvedApprovalIds.size) {
			return;
		}

		session.pendingApprovals = session.pendingApprovals.filter(item => item.phase !== 'waitingApproval');
		session.timeline = session.timeline.filter(item => !unresolvedApprovalIds.has(item.id));
	}

	private _findPendingApprovalProcess(session: AgentSessionState, toolName: string, toolMessageId?: string, toolCallId?: string): IAgentTimelineItem | undefined {
		const identifierMatch = this._findTimelineProcessByToolIdentifiers(session.timeline, toolMessageId, toolCallId);
		if (identifierMatch) {
			return identifierMatch;
		}

		for (let index = session.timeline.length - 1; index >= 0; index--) {
			const item = session.timeline[index];
			if ((item.kind !== 'tool' && item.kind !== 'command') || !item.processGroupId) {
				continue;
			}

			if (item.title !== toolName) {
				continue;
			}

			if (item.phase === 'pending' || item.phase === 'running' || item.phase === 'waitingApproval') {
				return item;
			}
		}

		return undefined;
	}

	private _findTimelineProcessByToolIdentifiers(timeline: readonly IAgentTimelineItem[], toolMessageId?: string, toolCallId?: string): IAgentTimelineItem | undefined {
		if (toolMessageId && toolCallId) {
			const exactProcessGroupId = this._getToolProcessKey(toolMessageId, toolCallId, toolCallId);
			const exactMatch = timeline.find(item =>
				(item.kind === 'tool' || item.kind === 'command') &&
				item.processGroupId === exactProcessGroupId
			);
			if (exactMatch) {
				return exactMatch;
			}
		}

		if (toolMessageId) {
			const messageMatch = [...timeline].reverse().find(item =>
				(item.kind === 'tool' || item.kind === 'command') &&
				item.sourceMessageId === toolMessageId &&
				(item.phase === 'pending' || item.phase === 'running' || item.phase === 'waitingApproval')
			);
			if (messageMatch) {
				return messageMatch;
			}
		}

		return undefined;
	}

	private _resolveApprovalDecision(response: 'allow' | 'deny' | 'allowAll'): { phase: AgentProcessPhase; tone: AgentTimelineTone; stateLabel: string; body: string; composerStatus: string } {
		switch (response) {
			case 'allow':
				return {
					phase: 'succeeded',
					tone: 'success',
					stateLabel: 'Approved',
					body: 'Approval granted. OpenCode can continue this tool call.',
					composerStatus: 'Approval sent to OpenCode.'
				};
			case 'allowAll':
				return {
					phase: 'succeeded',
					tone: 'success',
					stateLabel: 'Approved',
					body: 'Approval granted for this and subsequent matching requests.',
					composerStatus: 'OpenCode can continue future matching requests.'
				};
			case 'deny':
			default:
				return {
					phase: 'cancelled',
					tone: 'warning',
					stateLabel: 'Denied',
					body: 'Approval denied. OpenCode will not continue this tool call.',
					composerStatus: 'Approval denied.'
				};
		}
	}

	private _applyApprovalResolutionToProcessItem(item: IAgentTimelineItem, response: 'allow' | 'deny' | 'allowAll'): IAgentTimelineItem {
		if (response === 'deny') {
			return {
				...item,
				body: item.kind === 'command' ? 'Command blocked after approval was denied.' : 'Tool call blocked after approval was denied.',
				tone: 'warning',
				phase: 'cancelled',
				stateLabel: 'Denied'
			};
		}

		return {
			...item,
			body: item.kind === 'command' ? 'Running command.' : 'Continuing after approval.',
			tone: 'running',
			phase: 'running',
			stateLabel: 'Running'
		};
	}

	private _createApprovalTimelineItem(options: {
		readonly requestId: string;
		readonly title: string;
		readonly args: unknown;
		readonly linkedProcess?: IAgentTimelineItem;
		readonly permissionLabel?: string;
		readonly patterns?: readonly string[];
		readonly rawData?: string;
		readonly sourceMessageId?: string;
	}): IAgentTimelineItem {
		const { args, linkedProcess, patterns } = options;
		const normalizedPatterns = patterns?.filter((pattern): pattern is string => typeof pattern === 'string' && !!pattern);
		const sections = this._buildApprovalSectionsFromSource(args, linkedProcess, normalizedPatterns);
		const details = this._mergeDetails(
			this._buildApprovalDetails(args, options.permissionLabel, normalizedPatterns, linkedProcess),
			linkedProcess?.details
		);
		const code = this._extractCommandText(args) ?? linkedProcess?.code;
		const bullets = this._mergeTextEntries(
			this._stringifyUnknownEntries(args)?.slice(0, 8),
			linkedProcess?.bullets
		);

		return {
			id: `approval:${options.requestId}`,
			kind: 'approval',
			label: 'Approval required',
			title: options.title,
			body: this._buildApprovalBody(code, normalizedPatterns, options.permissionLabel),
			bullets,
			details,
			code,
			sections,
			rawData: options.rawData,
			tone: 'warning',
			permissionRequestId: options.requestId,
			processGroupId: linkedProcess?.processGroupId,
			sourceMessageId: options.sourceMessageId,
			phase: 'waitingApproval',
			stateLabel: 'Waiting approval'
		};
	}

	private _buildApprovalBody(command: string | undefined, patterns: readonly string[] | undefined, permissionLabel: string | undefined): string {
		if (command) {
			return 'OpenCode is waiting for permission to run this command.';
		}

		if (patterns?.length) {
			return 'OpenCode is waiting for permission to access the paths below.';
		}

		if (permissionLabel) {
			return `OpenCode is waiting for permission to continue with ${permissionLabel.toLowerCase()}.`;
		}

		return 'Review this request before OpenCode can continue.';
	}

	private _buildApprovalDetails(args: unknown, permissionLabel: string | undefined, patterns: readonly string[] | undefined, linkedProcess: IAgentTimelineItem | undefined): IAgentTimelineDetail[] | undefined {
		const details: IAgentTimelineDetail[] = [];
		if (permissionLabel) {
			details.push({ label: 'Permission', value: permissionLabel });
		}
		if (linkedProcess?.title) {
			details.push({ label: linkedProcess.kind === 'command' ? 'Command tool' : 'Tool', value: linkedProcess.title });
		}
		if (patterns?.length) {
			details.push({ label: 'Paths', value: String(patterns.length) });
		}

		return this._mergeDetails(details, this._buildCommandContextDetails(args));
	}

	private _buildApprovalSectionsFromSource(args: unknown, linkedProcess?: IAgentTimelineItem, patterns?: readonly string[]): IAgentTimelineSection[] | undefined {
		if (!args || typeof args !== 'object') {
			return patterns?.length
				? [{ label: 'Affected paths', type: 'list', items: patterns, presentation: 'scope' }]
				: linkedProcess?.sections ? [...linkedProcess.sections] : undefined;
		}

		const record = args as Record<string, unknown>;
		const sections: IAgentTimelineSection[] = [];
		const command = this._extractCommandText(record);
		if (command) {
			sections.push({ label: 'Requested command', type: 'code', value: command });
		}
		const normalizedPatterns = patterns ?? (Array.isArray(record['patterns'])
			? record['patterns'].filter((entry): entry is string => typeof entry === 'string' && !!entry)
			: undefined);
		if (normalizedPatterns?.length) {
			sections.push({ label: 'Affected paths', type: 'list', items: normalizedPatterns, presentation: 'scope' });
		}

		const remainder = { ...record };
		delete remainder['command'];
		delete remainder['patterns'];
		delete remainder['permission'];
		delete remainder['tool'];
		delete remainder['cwd'];
		delete remainder['workdir'];
		delete remainder['timeout'];
		delete remainder['description'];
		const remainderEntries = this._stringifyUnknownEntries(remainder);
		if (remainderEntries?.length) {
			sections.push({ label: 'Request details', type: 'list', items: remainderEntries.slice(0, 10) });
		}

		return this._mergeSections(sections, linkedProcess?.sections);
	}

	private _getMutableActiveSession(): AgentSessionState {
		return this._sessions.get(this._activeSessionId) ?? this._sessions.get(this._sessionOrder[0]!)!;
	}

	private _refreshVisualRunningState(): void {
		const now = Date.now();
		for (const session of this._sessions.values()) {
			if (
				this._isRunningPhase(session.sessionPhase)
				|| this._hasRunningTimelineProcesses(session.timeline)
			) {
				session.visualRunningUntil = now + RUNNING_VISUAL_GRACE_PERIOD;
			}
		}
	}

	private _emitChange(): void {
		this._refreshVisualRunningState();
		this._onDidChangeActiveSession.fire(this.activeSession);
	}
}

registerSingleton(IAgentSessionService, AgentSessionService, InstantiationType.Delayed);
