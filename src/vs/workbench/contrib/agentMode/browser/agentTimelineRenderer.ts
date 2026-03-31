/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { renderMarkdown } from '../../../../base/browser/markdownRenderer.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IAgentConversationTurn, IAgentTimelineItem, IAgentTurnAttachment } from './agentSessionService.js';

export interface IAgentTimelineRenderOptions {
	readonly hasLiveExecution: boolean;
	readonly renderDisposables: DisposableStore;
}

interface IProcessSummaryData {
	readonly primaryText?: string;
	readonly secondaryText?: string;
	readonly metaEntries: readonly string[];
}

export function renderAgentConversationTurn(turn: IAgentConversationTurn, options: IAgentTimelineRenderOptions): HTMLElement {
	const container = createElement('div', 'agent-mode-editor-surface__turn');
	container.dataset.turnId = turn.id;

	if (turn.userMessage) {
		container.append(renderMessageCard(turn.userMessage, options));
	}

	if (turn.attachments.length) {
		const attachments = createElement('div', 'agent-mode-editor-surface__turn-attachments');
		if (!turn.userMessage && !turn.assistantMessage) {
			attachments.classList.add('agent-mode-editor-surface__turn-attachments--standalone');
		}
		for (const attachment of sortTurnAttachments(turn.attachments)) {
			attachments.append(renderTurnAttachment(attachment, options));
		}
		container.append(attachments);
	}

	if (turn.assistantMessage) {
		container.append(renderMessageCard(turn.assistantMessage, options));
	}

	if (turn.statusMeta?.length) {
		const footer = createElement('div', 'agent-mode-editor-surface__turn-footer');
		footer.textContent = turn.statusMeta.join(' | ');
		container.append(footer);
	}

	return container;
}

export function getAgentConversationTurnSignature(turn: IAgentConversationTurn, hasLiveExecution: boolean): string {
	return JSON.stringify({
		id: turn.id,
		userMessage: turn.userMessage ? getAgentTimelineSignature(turn.userMessage, hasLiveExecution) : undefined,
		assistantMessage: turn.assistantMessage ? getAgentTimelineSignature(turn.assistantMessage, hasLiveExecution) : undefined,
		attachments: turn.attachments.map(attachment => ({
			id: attachment.id,
			kind: attachment.kind,
			summary: attachment.summary,
			expandedByDefault: attachment.expandedByDefault,
			item: getAgentTimelineSignature(attachment.item, hasLiveExecution)
		})),
		statusMeta: turn.statusMeta ?? [],
		hasPendingApproval: turn.hasPendingApproval
	});
}

export function renderAgentTimelineNode(item: IAgentTimelineItem, options: IAgentTimelineRenderOptions): HTMLElement {
	if (item.id.startsWith('__thinking__:')) {
		const row = createElement('div', 'agent-mode-editor-surface__message-row agent-mode-editor-surface__message-row--working');
		const indicator = createElement('div', 'agent-mode-editor-surface__working-indicator');
		indicator.setAttribute('aria-live', 'polite');
		const spinner = createElement('span', 'agent-mode-editor-surface__working-spinner');
		spinner.setAttribute('aria-hidden', 'true');
		const label = document.createElement('span');
		label.textContent = item.body;
		indicator.append(spinner, label);
		row.append(indicator);
		return row;
	}

	if (item.kind === 'reasoning') {
		return renderReasoningAttachment(item, options);
	}

	if (item.kind === 'user' || item.kind === 'assistant') {
		return renderMessageCard(item, options);
	}

	if (item.kind === 'status') {
		return renderStatusRow(item, options);
	}

	if (item.kind === 'patch') {
		return renderPatchCard(item, options);
	}

	if (item.kind === 'approval') {
		return renderApprovalCard(item, options);
	}

	return renderProcessCard(item, options);
}

export function getAgentTimelineSignature(item: IAgentTimelineItem, hasLiveExecution: boolean): string {
	return JSON.stringify({
		id: item.id,
		kind: item.kind,
		label: item.label,
		title: item.title ?? '',
		body: item.body,
		bullets: item.bullets ?? [],
		meta: item.meta ?? [],
		code: item.code ?? '',
		details: item.details ?? [],
		sections: item.sections ?? [],
		rawData: item.rawData ?? '',
		phase: item.phase ?? '',
		stateLabel: item.stateLabel ?? '',
		collapsed: item.kind === 'reasoning'
			? true
			: shouldRenderCollapsibleProcess(item)
				? !shouldExpandProcessDetails(item)
				: undefined
	});
}

function renderTurnAttachment(attachment: IAgentTurnAttachment, options: IAgentTimelineRenderOptions): HTMLElement {
	const row = renderAgentTimelineNode(attachment.item, options);
	row.classList.add('agent-mode-editor-surface__turn-attachment', `agent-mode-editor-surface__turn-attachment--${attachment.kind}`);
	if (!isPrimaryTurnAttachment(attachment.item, options.hasLiveExecution)) {
		row.classList.add('agent-mode-editor-surface__turn-attachment--secondary');
	}
	if (isSettledTurnAttachment(attachment.item)) {
		row.classList.add('agent-mode-editor-surface__turn-attachment--settled');
	}
	if (attachment.kind === 'approval' && attachment.item.phase === 'waitingApproval') {
		row.classList.add('agent-mode-editor-surface__turn-attachment--blocking');
	}
	return row;
}

function isPrimaryTurnAttachment(item: IAgentTimelineItem, hasLiveExecution: boolean): boolean {
	if (item.kind === 'approval' && item.phase === 'waitingApproval') {
		return true;
	}

	if (item.phase === 'failed' || item.phase === 'cancelled') {
		return true;
	}

	return hasLiveExecution && (item.kind === 'reasoning' || item.phase === 'pending' || item.phase === 'running');
}

function isSettledTurnAttachment(item: IAgentTimelineItem): boolean {
	return item.phase === 'succeeded' || item.phase === 'cancelled' || item.phase === 'failed' || item.phase === 'waitingApproval' || item.phase === undefined;
}

function sortTurnAttachments(attachments: readonly IAgentTurnAttachment[]): readonly IAgentTurnAttachment[] {
	return [...attachments].sort((left, right) => getAttachmentWeight(left) - getAttachmentWeight(right));
}

function getAttachmentWeight(attachment: IAgentTurnAttachment): number {
	switch (attachment.kind) {
		case 'approval':
			return attachment.item.phase === 'waitingApproval' ? 0 : 3;
		case 'patch':
			return 1;
		case 'reasoning':
			return 2;
		case 'command':
		case 'tool':
			return 3;
		case 'debug':
		default:
			return 4;
	}
}

function renderReasoningAttachment(item: IAgentTimelineItem, options: IAgentTimelineRenderOptions): HTMLElement {
	const row = createProcessRow(item);
	row.classList.add('agent-mode-editor-surface__message-row--substep', 'agent-mode-editor-surface__message-row--reasoning');
	const details = createElement('details', 'agent-mode-editor-surface__substep agent-mode-editor-surface__substep--reasoning agent-mode-editor-surface__substep--neutral') as HTMLDetailsElement;
	setDisclosureIdentity(details, item.id, 'reasoning');
	details.open = false;
	const reasoningPreview = getReasoningPreview(item.body);
	const summary = createElement('summary', 'agent-mode-editor-surface__reasoning-inline-summary');
	const preview = createElement('span', 'agent-mode-editor-surface__reasoning-inline-preview', reasoningPreview ?? localize('agentModeEditorSurfaceReasoningThinking', 'Thinking…'));
	summary.append(preview);
	const chevron = createElement('span', 'agent-mode-editor-surface__reasoning-inline-chevron');
	chevron.setAttribute('aria-hidden', 'true');
	summary.append(chevron);
	const content = createElement('div', 'agent-mode-editor-surface__reasoning-inline-content');
	const reasoningBody = createElement('div', 'agent-mode-editor-surface__reasoning-body');
	renderMarkdownContent(reasoningBody, item.body, options.renderDisposables);
	content.append(reasoningBody);
	details.append(summary, content);
	row.append(details);
	return row;
}

function renderMessageCard(item: IAgentTimelineItem, options: IAgentTimelineRenderOptions): HTMLElement {
	const rowModifier = item.kind === 'user' ? ' agent-mode-editor-surface__message-row--user' : ' agent-mode-editor-surface__message-row--agent';
	const cardModifier = item.kind === 'user' ? ' agent-mode-editor-surface__message--user' : ' agent-mode-editor-surface__message--agent';
	const row = createElement('div', `agent-mode-editor-surface__message-row${rowModifier}`);
	row.dataset.kind = item.kind;
	const card = createElement('div', `agent-mode-editor-surface__message${cardModifier}`);
	if (item.title) {
		card.append(createElement('div', 'agent-mode-editor-surface__message-title', item.title));
	}
	const messageCopy = createElement('div', 'agent-mode-editor-surface__message-copy');
	renderMarkdownContent(messageCopy, item.body, options.renderDisposables);
	card.append(messageCopy);
	const bulletList = createBulletList(item.bullets, 'agent-mode-editor-surface__message-list');
	if (bulletList) {
		card.append(bulletList);
	}
	row.append(card);
	return row;
}

function renderProcessCard(item: IAgentTimelineItem, options: IAgentTimelineRenderOptions): HTMLElement {
	if (shouldRenderCollapsibleProcess(item)) {
		return renderCollapsibleProcessCard(item, options);
	}

	const row = createProcessRow(item);
	const card = createProcessCardElement(item);
	appendProcessCardContent(card, item, options);
	row.append(card);
	return row;
}

function renderCollapsibleProcessCard(item: IAgentTimelineItem, options: IAgentTimelineRenderOptions): HTMLElement {
	const row = createProcessRow(item);
	row.classList.add('agent-mode-editor-surface__message-row--substep');
	const isExpanded = shouldExpandProcessDetails(item);
	const isSettled = item.phase === 'succeeded' || item.phase === 'cancelled' || item.phase === 'failed' || item.phase === undefined;
	const isCompact = isSettled && !isExpanded;
	const details = createElement('details', `agent-mode-editor-surface__substep agent-mode-editor-surface__substep--${item.kind} agent-mode-editor-surface__substep--${item.tone ?? 'neutral'}${isCompact ? ' agent-mode-editor-surface__substep--compact' : ''}`) as HTMLDetailsElement;
	setDisclosureIdentity(details, item.id, 'process');
	details.open = isExpanded;
	const summaryData = getProcessSummaryData(item);
	if (isCompact) {
		const summary = createCompactProcessSummary(item, summaryData);
		const content = createElement('div', 'agent-mode-editor-surface__substep-content');
		const body = createElement('div', `agent-mode-editor-surface__substep-body agent-mode-editor-surface__substep-body--${item.kind}`);
		appendProcessCardContent(body, item, options, { omitSummaryHeader: true, compactBody: true, summaryData });
		content.append(body);
		details.append(summary, content);
	} else {
		const summary = createSubstepSummary(item, {
			label: item.label,
			primaryText: summaryData.primaryText,
			secondaryText: summaryData.secondaryText,
			metaEntries: summaryData.metaEntries,
			codeStyle: item.kind === 'command' && !!item.code?.trim(),
			kindClassName: item.kind,
		});
		const content = createElement('div', 'agent-mode-editor-surface__substep-content');
		const body = createElement('div', `agent-mode-editor-surface__substep-body agent-mode-editor-surface__substep-body--${item.kind}`);
		appendProcessCardContent(body, item, options, { omitSummaryHeader: true, compactBody: true, summaryData });
		content.append(body);
		details.append(summary, content);
	}
	row.append(details);
	return row;
}

function renderStatusRow(item: IAgentTimelineItem, options: IAgentTimelineRenderOptions): HTMLElement {
	const row = createProcessRow(item);
	const container = createElement('div', 'agent-mode-editor-surface__status-row');
	const title = item.title ?? item.label;
	container.append(createElement('span', 'agent-mode-editor-surface__status-title', title));
	if (item.body && !equalsNormalized(item.body, title)) {
		container.append(createElement('span', 'agent-mode-editor-surface__status-body', item.body));
	}
	const metaEntries = [...(item.stateLabel ? [item.stateLabel] : []), ...(item.meta ?? [])];
	if (metaEntries.length) {
		container.append(createElement('span', 'agent-mode-editor-surface__status-meta', metaEntries.join(' | ')));
	}
	if (item.details?.length) {
		const details = item.details.map(detail => `${detail.label}: ${detail.value}`);
		container.append(createElement('span', 'agent-mode-editor-surface__status-meta', details.join(' | ')));
	}
	row.append(container);
	return row;
}

function renderPatchCard(item: IAgentTimelineItem, options: IAgentTimelineRenderOptions): HTMLElement {
	const row = createProcessRow(item);
	const card = createProcessCardElement(item, 'agent-mode-editor-surface__patch-card');
	const summaryLine = createElement('div', 'agent-mode-editor-surface__patch-summary-line');
	const summaryText = item.body || item.title || localize('agentModeEditorSurfacePatchDefault', 'Edited files');
	summaryLine.append(createElement('span', 'agent-mode-editor-surface__patch-summary-text', summaryText));
	card.append(summaryLine);
	const actions = createPatchSummaryActionsElement(item);
	if (actions) {
		card.append(actions);
	}
	const details = createPatchDetailsElement(item);
	if (details) {
		card.append(details);
	}
	row.append(card);
	return row;
}

function renderApprovalCard(item: IAgentTimelineItem, options: IAgentTimelineRenderOptions): HTMLElement {
	const waitingApproval = item.phase === 'waitingApproval';
	if (!waitingApproval) {
		return renderSettledApprovalCard(item, options);
	}

	const row = createProcessRow(item);
	const card = createProcessCardElement(item, 'agent-mode-editor-surface__approval-card');
	card.classList.add('agent-mode-editor-surface__approval-card--pending');
	card.append(createElement('div', 'agent-mode-editor-surface__message-meta', item.label));

	if (item.title) {
		card.append(createElement('div', 'agent-mode-editor-surface__approval-headline', item.title));
	}

	if (item.code) {
		const pre = createElement('pre', 'agent-mode-editor-surface__process-code agent-mode-editor-surface__process-code--approval');
		const code = document.createElement('code');
		code.textContent = item.code;
		pre.append(code);
		card.append(pre);
	}

	const actions = createProcessActionsElement(item);
	if (actions) {
		card.append(actions);
	}

	const hasInspectionContent = !!item.details?.length || !!item.sections?.length || !!item.rawData?.trim();
	if (hasInspectionContent) {
		const inspectDetails = createElement('details', 'agent-mode-editor-surface__approval-inspection') as HTMLDetailsElement;
		setDisclosureIdentity(inspectDetails, item.id, 'approval-details');
		const inspectSummary = createElement('summary', 'agent-mode-editor-surface__approval-inspection-summary');
		inspectSummary.append(
			createElement('span', 'agent-mode-editor-surface__approval-inspection-label', localize('agentModeEditorSurfaceApprovalDetails', 'Details')),
			createElement('span', 'agent-mode-editor-surface__approval-inspection-chevron')
		);
		inspectSummary.lastElementChild?.setAttribute('aria-hidden', 'true');
		const inspectContent = createElement('div', 'agent-mode-editor-surface__approval-inspection-content');

		const detailGrid = createProcessDetailGrid(item);
		if (detailGrid) {
			inspectContent.append(detailGrid);
		}

		const sections = createProcessSections(item, { skipRequestedCommand: !!item.code });
		if (sections) {
			inspectContent.append(sections);
		}

		const rawDetails = createRawDetailsElement(item);
		if (rawDetails) {
			inspectContent.append(rawDetails);
		}

		inspectDetails.append(inspectSummary, inspectContent);
		card.append(inspectDetails);
	}

	row.append(card);
	return row;
}

function renderSettledApprovalCard(item: IAgentTimelineItem, options: IAgentTimelineRenderOptions): HTMLElement {
	const row = createProcessRow(item);
	const details = createElement('details', 'agent-mode-editor-surface__process-disclosure agent-mode-editor-surface__process-disclosure--approval-settled') as HTMLDetailsElement;
	setDisclosureIdentity(details, item.id, 'approval');
	details.open = shouldExpandProcessDetails(item);
	const summary = createProcessDisclosureSummary(item);
	const content = createElement('div', 'agent-mode-editor-surface__process-disclosure-content');
	const card = createProcessCardElement(item, 'agent-mode-editor-surface__approval-card agent-mode-editor-surface__approval-card--settled');
	appendProcessCardContent(card, item, options, { omitSummaryHeader: true });
	content.append(card);
	details.append(summary, content);
	row.append(details);
	return row;
}

function createProcessCardElement(item: IAgentTimelineItem, extraClassName?: string): HTMLElement {
	const className = `agent-mode-editor-surface__process-card agent-mode-editor-surface__process-card--${item.kind} agent-mode-editor-surface__process-card--${item.tone ?? 'neutral'}${extraClassName ? ` ${extraClassName}` : ''}`;
	return createElement('div', className);
}


function appendProcessCardContent(card: HTMLElement, item: IAgentTimelineItem, options: IAgentTimelineRenderOptions, config?: { readonly omitSummaryHeader?: boolean; readonly compactBody?: boolean; readonly summaryData?: IProcessSummaryData }): void {
	const summaryData = config?.summaryData ?? getProcessSummaryData(item);
	const summaryComparisonValues = getProcessSummaryComparisonValues(item, summaryData);
	if (!config?.omitSummaryHeader) {
		card.append(createElement('div', 'agent-mode-editor-surface__message-meta', item.label));
		if (item.title) {
			card.append(createElement('div', 'agent-mode-editor-surface__process-title', item.title));
		}
		if (item.body) {
			const processCopy = createElement('div', 'agent-mode-editor-surface__process-copy');
			renderMarkdownContent(processCopy, item.body, options.renderDisposables);
			card.append(processCopy);
		}
	} else if (item.body && shouldRenderExpandedProcessBody(item, summaryComparisonValues)) {
		const processCopy = createElement('div', 'agent-mode-editor-surface__process-copy agent-mode-editor-surface__process-copy--substep');
		renderMarkdownContent(processCopy, item.body, options.renderDisposables);
		card.append(processCopy);
	}

	const detailGrid = createProcessDetailGrid(item, summaryComparisonValues);
	if (detailGrid) {
		card.append(detailGrid);
	}

	if (shouldRenderProcessCodeBlock(item, config, summaryData)) {
		const pre = createElement('pre', 'agent-mode-editor-surface__process-code');
		const code = document.createElement('code');
		code.textContent = item.code ?? '';
		pre.append(code);
		card.append(pre);
	}

	const sections = createProcessSections(item, {
		skipRequestedCommand: false,
		compactBody: config?.compactBody,
		summaryComparisonValues
	});
	if (sections) {
		card.append(sections);
	}

	const rawDetails = createRawDetailsElement(item);
	if (rawDetails) {
		card.append(rawDetails);
	}

	const metaRow = createProcessMetaRow(item, summaryComparisonValues);
	if (metaRow && !config?.omitSummaryHeader && !config?.compactBody) {
		card.append(metaRow);
	}

	const bulletList = !config?.omitSummaryHeader || !item.sections?.length
		? createBulletList(filterDuplicateEntries(item.bullets, summaryComparisonValues), 'agent-mode-editor-surface__process-list')
		: undefined;
	if (bulletList) {
		card.append(bulletList);
	}

	const actions = createProcessActionsElement(item);
	if (actions) {
		card.append(actions);
	}
}

function createProcessDisclosureSummary(item: IAgentTimelineItem): HTMLElement {
	const summary = createElement('summary', 'agent-mode-editor-surface__process-disclosure-summary');
	const summaryCopy = createElement('div', 'agent-mode-editor-surface__process-disclosure-summary-copy');
	summaryCopy.append(createElement('span', 'agent-mode-editor-surface__message-meta', item.label));

	const summaryData = getProcessSummaryData(item);
	const primaryText = summaryData.primaryText;
	if (primaryText) {
		summaryCopy.append(createElement('div', `agent-mode-editor-surface__process-disclosure-primary${item.kind === 'command' && item.code?.trim() ? ' agent-mode-editor-surface__process-disclosure-primary--code' : ''}`, primaryText));
	}

	const secondaryText = summaryData.secondaryText;
	if (secondaryText) {
		summaryCopy.append(createElement('div', 'agent-mode-editor-surface__process-disclosure-secondary', secondaryText));
	}

	const metaEntries = summaryData.metaEntries;
	if (metaEntries.length) {
		summaryCopy.append(createElement('div', 'agent-mode-editor-surface__process-disclosure-meta', metaEntries.join(' · ')));
	}

	summary.append(
		summaryCopy,
		createElement('span', 'agent-mode-editor-surface__process-disclosure-chevron')
	);
	summary.lastElementChild?.setAttribute('aria-hidden', 'true');
	return summary;
}

function createSubstepSummary(item: IAgentTimelineItem, options: {
	readonly label: string;
	readonly primaryText?: string;
	readonly secondaryText?: string;
	readonly metaEntries?: readonly string[];
	readonly codeStyle?: boolean;
	readonly kindClassName: string;
}): HTMLElement {
	const summary = createElement('summary', 'agent-mode-editor-surface__substep-summary');
	const icon = createElement('span', `agent-mode-editor-surface__substep-icon agent-mode-editor-surface__substep-icon--${options.kindClassName} agent-mode-editor-surface__substep-icon--${item.tone ?? 'neutral'}`);
	icon.setAttribute('aria-hidden', 'true');
	const summaryCopy = createElement('div', 'agent-mode-editor-surface__substep-summary-copy');
	summaryCopy.append(createElement('span', 'agent-mode-editor-surface__substep-label', options.label));

	if (options.primaryText) {
		summaryCopy.append(createElement('div', `agent-mode-editor-surface__substep-primary${options.codeStyle ? ' agent-mode-editor-surface__substep-primary--code' : ''}`, options.primaryText));
	}

	if (options.secondaryText) {
		summaryCopy.append(createElement('div', 'agent-mode-editor-surface__substep-secondary', options.secondaryText));
	}

	if (options.metaEntries?.length) {
		summaryCopy.append(createElement('div', 'agent-mode-editor-surface__substep-meta', options.metaEntries.join(' · ')));
	}

	const chevron = createElement('span', 'agent-mode-editor-surface__substep-chevron');
	chevron.setAttribute('aria-hidden', 'true');
	summary.append(icon, summaryCopy, chevron);
	return summary;
}

function createCompactProcessSummary(item: IAgentTimelineItem, summaryData: IProcessSummaryData): HTMLElement {
	const summary = createElement('summary', 'agent-mode-editor-surface__compact-summary');
	const primaryText = summaryData.primaryText ?? item.label;
	const isCode = item.kind === 'command' && !!item.code?.trim();
	summary.append(createElement('span', `agent-mode-editor-surface__compact-summary-text${isCode ? ' agent-mode-editor-surface__compact-summary-text--code' : ''}`, primaryText));
	if (summaryData.metaEntries.length) {
		summary.append(createElement('span', 'agent-mode-editor-surface__compact-summary-meta', summaryData.metaEntries.join(' · ')));
	}
	const chevron = createElement('span', 'agent-mode-editor-surface__compact-summary-chevron');
	chevron.setAttribute('aria-hidden', 'true');
	summary.append(chevron);
	return summary;
}

function createPatchSummaryActionsElement(item: IAgentTimelineItem): HTMLElement | undefined {
	if (item.kind !== 'patch' || !item.filePaths?.length) {
		return undefined;
	}

	const container = createElement('div', 'agent-mode-editor-surface__process-actions agent-mode-editor-surface__process-actions--summary');
	container.append(
		createActionButton(item.id, 'patch:openDiff', localize('agentModeEditorSurfacePatchOpenDiff', 'Open Diff'), true),
		createActionButton(item.id, 'patch:viewFiles', localize('agentModeEditorSurfacePatchViewFiles', 'View Files'))
	);
	return container;
}

function createPatchDetailsElement(item: IAgentTimelineItem): HTMLElement | undefined {
	const hasExpandableContent = !!item.details?.length || !!item.sections?.length || !!item.bullets?.length;
	if (!hasExpandableContent) {
		return undefined;
	}

	const details = createElement('details', 'agent-mode-editor-surface__patch-details') as HTMLDetailsElement;
	setDisclosureIdentity(details, item.id, 'patch-details');
	const summary = createElement('summary', 'agent-mode-editor-surface__patch-details-summary');
	summary.append(
		createElement('span', 'agent-mode-editor-surface__patch-details-label', localize('agentModeEditorSurfacePatchDetails', 'Changed files')),
		createElement('span', 'agent-mode-editor-surface__patch-details-chevron')
	);
	summary.lastElementChild?.setAttribute('aria-hidden', 'true');
	const content = createElement('div', 'agent-mode-editor-surface__patch-details-content');

	const detailGrid = createProcessDetailGrid(item);
	if (detailGrid) {
		content.append(detailGrid);
	}

	const sections = createProcessSections(item);
	if (sections) {
		content.append(sections);
	}

	if (!item.sections?.length) {
		const bulletList = createBulletList(item.bullets, 'agent-mode-editor-surface__process-list');
		if (bulletList) {
			content.append(bulletList);
		}
	}

	details.append(summary, content);
	return details;
}

function createProcessRow(item: IAgentTimelineItem): HTMLElement {
	const row = createElement('div', 'agent-mode-editor-surface__message-row agent-mode-editor-surface__message-row--process');
	row.dataset.kind = item.kind;
	row.dataset.itemId = item.id;
	row.tabIndex = -1;
	return row;
}

function shouldRenderCollapsibleProcess(item: IAgentTimelineItem): boolean {
	return item.kind === 'command' || item.kind === 'tool';
}

function shouldExpandProcessDetails(item: IAgentTimelineItem): boolean {
	if (item.phase === 'failed' || item.phase === 'cancelled') {
		return true;
	}

	return hasProcessStderr(item);
}

function hasProcessStderr(item: IAgentTimelineItem): boolean {
	return !!item.sections?.some(section => section.presentation === 'stderr' && !!section.value?.trim());
}

function getProcessSummaryPrimaryText(item: IAgentTimelineItem): string | undefined {
	if (item.kind === 'command' && item.code?.trim()) {
		return item.code.trim();
	}

	return item.title ?? item.body;
}

function getProcessSummaryData(item: IAgentTimelineItem): IProcessSummaryData {
	const primaryText = getProcessSummaryPrimaryText(item);
	return {
		primaryText,
		secondaryText: getProcessSummarySecondaryText(item, primaryText),
		metaEntries: getProcessSummaryMetaEntries(item)
	};
}

function getProcessSummarySecondaryText(item: IAgentTimelineItem, primaryText: string | undefined): string | undefined {
	const body = item.body?.trim();
	const title = item.title?.trim();
	if (body && body !== primaryText) {
		return body;
	}
	if (title && title !== primaryText) {
		return title;
	}
	return undefined;
}

function getProcessSummaryMetaEntries(item: IAgentTimelineItem): string[] {
	const entries: string[] = [];
	if (item.kind === 'command' && item.title?.trim()) {
		entries.push(item.title.trim());
	}

	if (item.stateLabel && !equalsNormalized(item.stateLabel, item.body)) {
		entries.push(item.stateLabel);
	}

	for (const entry of item.meta ?? []) {
		if (entry && !entries.includes(entry)) {
			entries.push(entry);
		}
	}

	return entries;
}

function getReasoningPreview(body: string): string | undefined {
	const normalized = body.replace(/\s+/g, ' ').trim();
	if (!normalized) {
		return undefined;
	}

	return normalized.length > 96 ? `${normalized.slice(0, 96).trimEnd()}…` : normalized;
}

function equalsNormalized(left: string | undefined, right: string | undefined): boolean {
	return normalizeComparisonText(left) === normalizeComparisonText(right);
}

function normalizeComparisonText(value: string | undefined): string {
	return value?.trim().replace(/[.!]+$/g, '').toLowerCase() ?? '';
}

function getProcessSummaryComparisonValues(item: IAgentTimelineItem, summaryData: IProcessSummaryData): string[] {
	const values = [
		item.label,
		summaryData.primaryText,
		summaryData.secondaryText,
		...summaryData.metaEntries,
	];
	return values.filter((value, index, array) => !!value && array.findIndex(candidate => equalsNormalized(candidate, value)) === index) as string[];
}

function shouldRenderExpandedProcessBody(item: IAgentTimelineItem, summaryComparisonValues: readonly string[]): boolean {
	return !!item.body?.trim() && !matchesComparisonValues(item.body, summaryComparisonValues);
}

function shouldRenderProcessCodeBlock(item: IAgentTimelineItem, config: { readonly omitSummaryHeader?: boolean; readonly compactBody?: boolean; readonly summaryData?: IProcessSummaryData } | undefined, summaryData: IProcessSummaryData): boolean {
	if (!item.code?.trim()) {
		return false;
	}

	if (!config?.compactBody) {
		return true;
	}

	return !equalsNormalized(item.code, summaryData.primaryText);
}

function createProcessMetaRow(item: IAgentTimelineItem, summaryComparisonValues?: readonly string[]): HTMLElement | undefined {
	const entries = filterDuplicateEntries([...(item.stateLabel ? [item.stateLabel] : []), ...(item.meta ?? [])], summaryComparisonValues);
	if (!entries.length) {
		return undefined;
	}

	const metaRow = createElement('div', 'agent-mode-editor-surface__process-meta-row');
	for (const entry of entries) {
		metaRow.append(createElement('span', 'agent-mode-editor-surface__process-meta-pill', entry));
	}

	return metaRow;
}

function createProcessDetailGrid(item: IAgentTimelineItem, summaryComparisonValues?: readonly string[]): HTMLElement | undefined {
	const details = item.details?.filter(detail => detail.value?.trim() && !matchesComparisonValues(detail.value, summaryComparisonValues));
	if (!details?.length) {
		return undefined;
	}

	const grid = createElement('div', 'agent-mode-editor-surface__process-details');
	for (const detail of details) {
		const entry = createElement('div', 'agent-mode-editor-surface__process-detail');
		entry.append(
			createElement('span', 'agent-mode-editor-surface__process-detail-label', detail.label),
			createElement('span', 'agent-mode-editor-surface__process-detail-value', detail.value)
		);
		grid.append(entry);
	}
	return grid;
}

function createProcessSections(item: IAgentTimelineItem, options?: { readonly skipRequestedCommand?: boolean; readonly compactBody?: boolean; readonly summaryComparisonValues?: readonly string[] }): HTMLElement | undefined {
	const sections = item.sections?.filter(section => {
		if (options?.skipRequestedCommand && section.label === localize('agentModeEditorSurfaceApprovalRequestedCommand', 'Requested command')) {
			return false;
		}

		if (section.type === 'code' && section.value?.trim()) {
			return !matchesComparisonValues(section.value, options?.summaryComparisonValues);
		}

		if (section.type === 'list' && section.items?.length) {
			return filterDuplicateEntries(section.items, options?.summaryComparisonValues).length > 0;
		}

		return false;
	});
	if (!sections?.length) {
		return undefined;
	}

	const container = createElement('div', 'agent-mode-editor-surface__process-sections');
	for (const section of sections) {
		const element = createElement('div', 'agent-mode-editor-surface__process-section');
		if (section.presentation === 'scope') {
			element.classList.add('agent-mode-editor-surface__process-section--scope');
		}
		element.append(createElement('div', 'agent-mode-editor-surface__process-section-label', section.label));
		if (section.type === 'code' && section.value) {
			if (shouldRenderCompactProcessSection(item, section, options)) {
				element.append(createElement('div', 'agent-mode-editor-surface__process-section-copy', normalizeInlineProcessOutput(section.value)));
			} else if (section.presentation === 'stdout' || section.presentation === 'stderr') {
				const details = createCollapsibleCodeSection(item.id, section);
				if (details) {
					element.append(details);
				}
			} else {
				const pre = createElement('pre', 'agent-mode-editor-surface__process-code agent-mode-editor-surface__process-code--section');
				const code = document.createElement('code');
				code.textContent = section.value;
				pre.append(code);
				element.append(pre);
			}
		} else if (section.type === 'list' && section.items?.length) {
			const list = createBulletList(filterDuplicateEntries(section.items, options?.summaryComparisonValues), 'agent-mode-editor-surface__process-section-list');
			if (list) {
				element.append(list);
			}
		}
		container.append(element);
	}
	return container;
}

function shouldRenderCompactProcessSection(item: IAgentTimelineItem, section: NonNullable<IAgentTimelineItem['sections']>[number], options?: { readonly compactBody?: boolean }): boolean {
	if (!options?.compactBody || section.type !== 'code' || section.presentation !== 'stdout' || item.phase !== 'succeeded') {
		return false;
	}

	if (hasProcessStderr(item)) {
		return false;
	}

	return isCompactProcessOutput(section.value);
}

function isCompactProcessOutput(value: string | undefined): boolean {
	if (!value?.trim()) {
		return false;
	}

	const lines = value.split(/\r?\n/).filter(line => !!line.trim());
	return lines.length <= 2 && normalizeInlineProcessOutput(value).length <= 140;
}

function normalizeInlineProcessOutput(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

function createCollapsibleCodeSection(itemId: string, section: NonNullable<IAgentTimelineItem['sections']>[number]): HTMLElement | undefined {
	if (!section.value) {
		return undefined;
	}

	const lineCount = section.value.split(/\r?\n/).filter(line => !!line).length || 1;
	const details = createElement('details', `agent-mode-editor-surface__process-stream agent-mode-editor-surface__process-stream--${section.presentation ?? 'default'}`) as HTMLDetailsElement;
	setDisclosureIdentity(details, itemId, `stream:${section.label}`);
	details.open = section.presentation === 'stderr';
	const summary = createElement('summary', 'agent-mode-editor-surface__process-stream-summary');
	summary.append(
		createElement('span', 'agent-mode-editor-surface__process-stream-label', section.label),
		createElement('span', 'agent-mode-editor-surface__process-stream-meta', localize('agentModeEditorSurfaceProcessStreamLines', '{0} lines', lineCount)),
		createElement('span', 'agent-mode-editor-surface__process-stream-chevron')
	);
	summary.lastElementChild?.setAttribute('aria-hidden', 'true');
	const content = createElement('div', 'agent-mode-editor-surface__process-stream-content');
	const pre = createElement('pre', 'agent-mode-editor-surface__process-code agent-mode-editor-surface__process-code--section');
	const code = document.createElement('code');
	code.textContent = section.value;
	pre.append(code);
	content.append(pre);
	details.append(summary, content);
	return details;
}

function createRawDetailsElement(item: IAgentTimelineItem): HTMLElement | undefined {
	if (!item.rawData?.trim() || (item.kind !== 'command' && item.kind !== 'tool' && item.kind !== 'approval')) {
		return undefined;
	}

	const details = createElement('details', 'agent-mode-editor-surface__process-inspector') as HTMLDetailsElement;
	setDisclosureIdentity(details, item.id, 'raw');
	const summary = createElement('summary', 'agent-mode-editor-surface__process-inspector-summary');
	summary.append(
		createElement('span', 'agent-mode-editor-surface__process-inspector-label', localize('agentModeEditorSurfaceRawDetails', 'Raw details')),
		createElement('span', 'agent-mode-editor-surface__process-inspector-chevron')
	);
	summary.lastElementChild?.setAttribute('aria-hidden', 'true');
	const content = createElement('div', 'agent-mode-editor-surface__process-inspector-content');
	const pre = createElement('pre', 'agent-mode-editor-surface__process-code agent-mode-editor-surface__process-code--section');
	const code = document.createElement('code');
	code.textContent = item.rawData;
	pre.append(code);
	content.append(pre);
	details.append(summary, content);
	return details;
}

function createBulletList(bullets: readonly string[] | undefined, className: string): HTMLElement | undefined {
	if (!bullets?.length) {
		return undefined;
	}

	const list = createElement('ul', className);
	for (const bullet of bullets) {
		list.append(createElement('li', undefined, bullet));
	}
	return list;
}

function filterDuplicateEntries(entries: readonly string[] | undefined, summaryComparisonValues?: readonly string[]): string[] {
	if (!entries?.length) {
		return [];
	}

	return entries.filter((entry, index, array) => {
		if (!entry?.trim() || matchesComparisonValues(entry, summaryComparisonValues)) {
			return false;
		}

		return array.findIndex(candidate => equalsNormalized(candidate, entry)) === index;
	});
}

function matchesComparisonValues(value: string | undefined, summaryComparisonValues?: readonly string[]): boolean {
	if (!value?.trim() || !summaryComparisonValues?.length) {
		return false;
	}

	return summaryComparisonValues.some(candidate => equalsNormalized(candidate, value));
}

function createProcessActionsElement(item: IAgentTimelineItem): HTMLElement | undefined {
	const actions: { id: string; label: string; primary?: boolean; utility?: boolean }[] = [];

	if (item.kind === 'approval' && item.permissionRequestId && item.phase === 'waitingApproval') {
		actions.push(
			{ id: 'approval:allow', label: localize('agentModeEditorSurfaceApprovalAllow', 'Allow Once'), primary: true },
			{ id: 'approval:deny', label: localize('agentModeEditorSurfaceApprovalDeny', 'Deny') },
			{ id: 'approval:allowAll', label: localize('agentModeEditorSurfaceApprovalAllowAll', 'Allow Always') }
		);
	}

	if (item.kind === 'command' && item.code?.trim()) {
		actions.push({ id: 'command:openTerminal', label: localize('agentModeEditorSurfaceCommandOpenTerminal', 'Open Terminal') });
		actions.push({ id: 'command:copy', label: localize('agentModeEditorSurfaceCommandCopy', 'Copy Command') });
	}

	if (item.kind === 'approval' && item.code?.trim()) {
		actions.push({ id: 'approval:copyCommand', label: localize('agentModeEditorSurfaceApprovalCopyCommand', 'Copy Command'), utility: true });
	}

	if ((item.kind === 'command' || item.kind === 'tool' || item.kind === 'approval') && item.rawData?.trim()) {
		actions.push({ id: 'process:copyRaw', label: localize('agentModeEditorSurfaceProcessCopyRaw', 'Copy Details'), utility: true });
	}

	if (item.kind === 'patch' && item.filePaths?.length) {
		actions.push({ id: 'patch:openDiff', label: localize('agentModeEditorSurfacePatchOpenDiff', 'Open Diff'), primary: true });
		actions.push({ id: 'patch:viewFiles', label: localize('agentModeEditorSurfacePatchViewFiles', 'View Files') });
	}

	if (!actions.length) {
		return undefined;
	}

	const containerClassName = item.kind === 'approval' && item.phase === 'waitingApproval'
		? 'agent-mode-editor-surface__process-actions agent-mode-editor-surface__process-actions--approval'
		: 'agent-mode-editor-surface__process-actions';
	const container = createElement('div', containerClassName);
	for (const action of actions) {
		container.append(createActionButton(item.id, action.id, action.label, action.primary, action.utility));
	}
	return container;
}

function createActionButton(itemId: string, actionId: string, label: string, primary?: boolean, utility?: boolean): HTMLButtonElement {
	const button = document.createElement('button');
	button.className = `agent-mode-editor-surface__process-action${primary ? ' agent-mode-editor-surface__process-action--primary' : ''}${utility ? ' agent-mode-editor-surface__process-action--utility' : ''}`;
	button.type = 'button';
	button.dataset.action = actionId;
	button.dataset.itemId = itemId;
	button.textContent = label;
	return button;
}

function setDisclosureIdentity(details: HTMLDetailsElement, itemId: string, disclosureKind: string): void {
	details.dataset.itemId = itemId;
	details.dataset.disclosureId = `${itemId}:${disclosureKind}`;
}

function renderMarkdownContent(container: HTMLElement, body: string | undefined, renderDisposables: DisposableStore): void {
	if (!body) {
		return;
	}

	const markdown = new MarkdownString(body, {
		supportThemeIcons: true,
		supportAlertSyntax: true,
		supportHtml: false
	});
	const rendered = renderMarkdown(markdown);
	renderDisposables.add(rendered);
	container.replaceChildren(rendered.element);
}

function createElement<K extends keyof HTMLElementTagNameMap>(tagName: K, className?: string, textContent?: string): HTMLElementTagNameMap[K] {
	const element = document.createElement(tagName);
	if (className) {
		element.className = className;
	}
	if (textContent !== undefined) {
		element.textContent = textContent;
	}
	return element;
}
