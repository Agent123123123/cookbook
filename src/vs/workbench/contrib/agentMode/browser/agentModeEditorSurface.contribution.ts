/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/agentModeEditorSurface.css';
import { addDisposableListener, append, EventType, getWindow, isHTMLElement, isHTMLTextAreaElement } from '../../../../base/browser/dom.js';
import { ISelectOptionItem, SelectBox } from '../../../../base/browser/ui/selectBox/selectBox.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { win32 } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { buildAgentConversationTurns, IAgentConversationTurn, IAgentSessionModel, IAgentSessionService, IAgentTimelineItem } from './agentSessionService.js';
import { IWorkbenchModeService } from './agentMode.contribution.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';
import { getSelectBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IQuickDiffService } from '../../scm/common/quickDiff.js';
import { getOriginalResource } from '../../scm/common/quickDiffService.js';
import { IAgentModeChatService } from './agentModeChatService.js';
import { AgentModeContextUsageWidget } from './agentModeContextUsageWidget.js';
import { getAgentConversationTurnSignature, renderAgentConversationTurn } from './agentTimelineRenderer.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';

class AgentModeEditorSurfaceContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.agentModeEditorSurface';

	private _overlayElement: HTMLElement | undefined;
	private readonly _overlayDisposables = this._register(new DisposableStore());
	private readonly _timelineRenderDisposables = this._register(new DisposableStore());
	private _renderedSessionId: string | undefined;
	private _renderedTimelineIds: string[] = [];
	private _timelineShowsEmptyState = false;
	private _timelineAutoFollow = true;
	private _pendingComposerFocus = false;
	private _renderedComposerPhase: IAgentSessionModel['sessionPhase'] | undefined;
	private _shellElements: {
		headlineTitle: HTMLElement;
		headerMeta: HTMLElement;
		timeline: HTMLElement;
		composerShell: HTMLElement;
		composerBanner: HTMLButtonElement;
		composerInput: HTMLTextAreaElement;
		composerStatus: HTMLElement;
		composerError: HTMLElement;
		contextUsageWidget: AgentModeContextUsageWidget;
		agentPickerHost: HTMLElement;
		modelPickerHost: HTMLElement;
		primaryActionButton: HTMLButtonElement;
		attachmentButton: HTMLButtonElement;
	} | undefined;

	constructor(
		@IWorkbenchLayoutService private readonly _layoutService: IWorkbenchLayoutService,
		@IWorkbenchModeService private readonly _workbenchModeService: IWorkbenchModeService,
		@IAgentSessionService private readonly _agentSessionService: IAgentSessionService,
		@IAgentModeChatService private readonly _agentModeChatService: IAgentModeChatService,
		@IContextViewService private readonly _contextViewService: IContextViewService,
		@IEditorService private readonly _editorService: IEditorService,
		@ITerminalService private readonly _terminalService: ITerminalService,
		@IQuickDiffService private readonly _quickDiffService: IQuickDiffService,
		@IClipboardService private readonly _clipboardService: IClipboardService,
	) {
		super();

		this._register(this._workbenchModeService.onDidChangeMode(() => this._render()));
		this._register(this._agentSessionService.onDidChangeActiveSession(() => this._render()));
		this._register(this._agentModeChatService.onDidRequestComposerFocus(() => {
			this._pendingComposerFocus = true;
			this._render();
		}));
		this._register(this._layoutService.onDidChangePartVisibility(event => {
			if (event.partId === Parts.EDITOR_PART) {
				this._render();
			}
		}));

		this._render();
	}

	private _ensureOverlay(): HTMLElement | undefined {
		const editorContainer = this._layoutService.getContainer(mainWindow, Parts.EDITOR_PART);
		if (!editorContainer) {
			return undefined;
		}

		editorContainer.classList.add('agent-mode-editor-surface-parent');

		if (!this._overlayElement || !editorContainer.contains(this._overlayElement)) {
			this._overlayElement = append(editorContainer, document.createElement('div'));
			this._overlayElement.className = 'agent-mode-editor-surface';
		}

		return this._overlayElement;
	}

	private _render(): void {
		const overlay = this._ensureOverlay();
		if (!overlay) {
			return;
		}

		const visible = this._workbenchModeService.mode === 'agent' && this._layoutService.isVisible(Parts.EDITOR_PART, getWindow(overlay));
		overlay.style.display = visible ? 'flex' : 'none';
		if (!visible) {
			return;
		}

		const previousTimelineState = this._captureTimelineState();
		const targetWindow = getWindow(overlay);
		const activeElement = targetWindow.document.activeElement;
		const focusedComposer = isHTMLTextAreaElement(activeElement) && activeElement.classList.contains('agent-mode-editor-surface__composer-input');
		const focusedComposerControl = isHTMLElement(activeElement) && this._isComposerControlElement(activeElement);
		const shouldFocusComposer = this._pendingComposerFocus;
		const composerSelection = focusedComposer ? {
			start: activeElement.selectionStart ?? activeElement.value.length,
			end: activeElement.selectionEnd ?? activeElement.value.length
		} : undefined;

		const session = this._agentSessionService.activeSession;
		const enteredWaitingApproval = this._renderedSessionId === session.id && this._renderedComposerPhase !== 'waitingApproval' && session.sessionPhase === 'waitingApproval';
		const sessionChanged = this._renderedSessionId !== session.id;
		this._ensureShell(overlay);
		this._bindInteractions(overlay);
		this._updateHeader(session);
		this._updateComposer(session, { preserveDraftValue: focusedComposer });
		this._updateTimeline(session, { sessionChanged, previousTimelineState });
		this._renderedSessionId = session.id;

		const composerBanner = this._shellElements?.composerBanner;
		if (enteredWaitingApproval && focusedComposerControl && composerBanner && composerBanner.style.display !== 'none') {
			composerBanner.focus({ preventScroll: true });
		} else if (focusedComposer || shouldFocusComposer) {
			const nextComposer = this._shellElements?.composerInput;
			if (nextComposer && !nextComposer.disabled) {
				nextComposer.focus({ preventScroll: true });
				if (composerSelection) {
					nextComposer.setSelectionRange(composerSelection.start, composerSelection.end);
				} else if (shouldFocusComposer) {
					const cursor = nextComposer.value.length;
					nextComposer.setSelectionRange(cursor, cursor);
				}
			}
		}

		this._pendingComposerFocus = false;
		this._renderedComposerPhase = session.sessionPhase;
	}

	private _ensureShell(overlay: HTMLElement): void {
		if (this._shellElements && overlay.contains(this._shellElements.timeline)) {
			return;
		}

		overlay.replaceChildren();

		const header = this._createElement('div', 'agent-mode-editor-surface__header');
		const headline = this._createElement('div', 'agent-mode-editor-surface__headline');
		const eyebrow = this._createElement('div', 'agent-mode-editor-surface__eyebrow', localize('agentModeEditorSurfaceEyebrow', 'Current session'));
		const headlineTitle = this._createElement('div', 'agent-mode-editor-surface__title');
		headline.append(eyebrow, headlineTitle);
		const headerMeta = this._createElement('div', 'agent-mode-editor-surface__header-meta');
		header.append(headline, headerMeta);

		const body = this._createElement('div', 'agent-mode-editor-surface__body');
		const main = this._createElement('div', 'agent-mode-editor-surface__main');
		const timeline = this._createElement('div', 'agent-mode-editor-surface__timeline');
		const composer = this._createElement('div', 'agent-mode-editor-surface__composer');
		const composerShell = this._createElement('div', 'agent-mode-editor-surface__composer-shell');
		const composerBanner = document.createElement('button');
		composerBanner.className = 'agent-mode-editor-surface__composer-banner';
		composerBanner.type = 'button';
		composerBanner.style.display = 'none';
		const composerInput = document.createElement('textarea');
		composerInput.className = 'agent-mode-editor-surface__composer-input';
		const composerStatus = this._createElement('div', 'agent-mode-editor-surface__composer-status');
		composerStatus.setAttribute('aria-live', 'polite');
		const composerError = this._createElement('div', 'agent-mode-editor-surface__composer-error');
		composerError.setAttribute('role', 'alert');
		const composerMeta = this._createElement('div', 'agent-mode-editor-surface__composer-meta');
		const composerControls = this._createElement('div', 'agent-mode-editor-surface__composer-controls');
		const attachmentButton = document.createElement('button');
		attachmentButton.className = 'agent-mode-editor-surface__attachment-button';
		attachmentButton.type = 'button';
		attachmentButton.setAttribute('aria-label', localize('agentModeEditorSurfaceAttach', 'Attach files'));
		attachmentButton.textContent = '+';
		const agentPickerHost = this._createElement('div', 'agent-mode-editor-surface__composer-picker-host agent-mode-editor-surface__composer-picker-host--agent');
		const modelPickerHost = this._createElement('div', 'agent-mode-editor-surface__composer-picker-host agent-mode-editor-surface__composer-picker-host--model');
		const contextUsageWidget = new AgentModeContextUsageWidget();
		composerControls.append(attachmentButton, agentPickerHost, modelPickerHost, contextUsageWidget.domNode);
		const composerActions = this._createElement('div', 'agent-mode-editor-surface__composer-actions');
		const primaryActionButton = document.createElement('button');
		primaryActionButton.className = 'agent-mode-editor-surface__action agent-mode-editor-surface__action--primary';
		primaryActionButton.type = 'button';
		primaryActionButton.textContent = localize('agentModeEditorSurfaceSend', 'Send');
		composerActions.append(primaryActionButton);
		composerMeta.append(composerControls, composerActions);
		composerShell.append(composerBanner, composerInput, composerStatus, composerError, composerMeta);
		composer.append(composerShell);
		main.append(timeline, composer);
		body.append(main);
		overlay.append(header, body);

		this._shellElements = {
			headlineTitle,
			headerMeta,
			timeline,
			composerShell,
			composerBanner,
			composerInput,
			composerStatus,
			composerError,
			contextUsageWidget,
			agentPickerHost,
			modelPickerHost,
			primaryActionButton,
			attachmentButton,
		};
		this._renderedTimelineIds = [];
		this._timelineShowsEmptyState = false;
		this._timelineRenderDisposables.clear();
	}

	private _isComposerControlElement(element: HTMLElement): boolean {
		return element.classList.contains('agent-mode-editor-surface__composer-input')
			|| element.classList.contains('agent-mode-editor-surface__composer-banner')
			|| element.classList.contains('agent-mode-editor-surface__attachment-button')
			|| element.classList.contains('agent-mode-editor-surface__action')
			|| element.classList.contains('select-box')
			|| !!element.closest('.agent-mode-editor-surface__composer');
	}

	private _captureTimelineState(): { scrollTop: number; nearBottom: boolean } | undefined {
		const timeline = this._shellElements?.timeline;
		if (!timeline) {
			return undefined;
		}

		const nearBottom = timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop < 24;
		this._timelineAutoFollow = nearBottom;

		return {
			scrollTop: timeline.scrollTop,
			nearBottom
		};
	}

	private _updateHeader(session: IAgentSessionModel): void {
		const elements = this._shellElements;
		if (!elements) {
			return;
		}

		elements.headlineTitle.textContent = session.title;
		const backendMeta = this._createElement('div', `agent-mode-editor-surface__meta agent-mode-editor-surface__meta--${session.backendTone}`, session.backendLabel);
		const metaChildren: HTMLElement[] = [backendMeta];
		if (session.workingDirectoryLabel) {
			const directoryMeta = this._createElement('div', 'agent-mode-editor-surface__meta agent-mode-editor-surface__meta--directory', session.workingDirectoryLabel);
			directoryMeta.title = session.workingDirectoryLabel;
			metaChildren.push(directoryMeta);
		}
		elements.headerMeta.replaceChildren(...metaChildren);
	}

	private _updateComposer(session: IAgentSessionModel, options: { preserveDraftValue: boolean }): void {
		const elements = this._shellElements;
		if (!elements) {
			return;
		}

		const running = this._isSessionRunning(session);
		const waitingApproval = session.sessionPhase === 'waitingApproval';
		const offline = session.sessionPhase === 'offline';
		const error = session.sessionPhase === 'error';

		elements.composerShell.classList.toggle('agent-mode-editor-surface__composer-shell--running', running);
		elements.composerShell.classList.toggle('agent-mode-editor-surface__composer-shell--warning', waitingApproval);
		elements.composerShell.classList.toggle('agent-mode-editor-surface__composer-shell--error', error);
		elements.composerShell.classList.toggle('agent-mode-editor-surface__composer-shell--offline', offline);

		if (!options.preserveDraftValue) {
			elements.composerInput.value = session.composerDraft;
		}
		elements.composerInput.placeholder = session.composerPlaceholder;
		elements.composerInput.disabled = offline || waitingApproval;

		const pendingApproval = this._getPendingApprovalItem(session);
		if (waitingApproval && pendingApproval) {
			elements.composerBanner.textContent = this._getComposerBannerText(pendingApproval);
			elements.composerBanner.setAttribute('aria-label', this._getComposerBannerAriaLabel(pendingApproval));
			elements.composerBanner.title = this._getComposerBannerAriaLabel(pendingApproval);
			elements.composerBanner.dataset.itemId = pendingApproval.id;
			elements.composerBanner.style.display = '';
		} else {
			elements.composerBanner.textContent = '';
			elements.composerBanner.removeAttribute('aria-label');
			elements.composerBanner.removeAttribute('title');
			delete elements.composerBanner.dataset.itemId;
			elements.composerBanner.style.display = 'none';
		}

		elements.composerStatus.textContent = session.composerStatus;
		elements.composerStatus.classList.toggle('agent-mode-editor-surface__composer-status--running', running);
		elements.composerStatus.classList.toggle('agent-mode-editor-surface__composer-status--warning', waitingApproval);
		elements.composerStatus.classList.toggle('agent-mode-editor-surface__composer-status--error', error);
		elements.composerStatus.classList.toggle('agent-mode-editor-surface__composer-status--offline', offline);
		elements.composerStatus.style.display = session.composerStatus && !(waitingApproval && pendingApproval) ? '' : 'none';

		elements.composerError.textContent = session.composerError ?? '';
		elements.composerError.style.display = session.composerError ? '' : 'none';
		elements.contextUsageWidget.update(session.contextUsage);

		elements.primaryActionButton.disabled = offline || waitingApproval;
		elements.primaryActionButton.textContent = running
			? localize('agentModeEditorSurfaceStop', 'Stop')
			: waitingApproval
				? localize('agentModeEditorSurfacePaused', 'Paused')
				: localize('agentModeEditorSurfaceSend', 'Send');
		elements.primaryActionButton.classList.toggle('agent-mode-editor-surface__action--running', running);
		elements.primaryActionButton.classList.toggle('agent-mode-editor-surface__action--warning', waitingApproval);
		elements.attachmentButton.disabled = offline || waitingApproval;

		elements.agentPickerHost.dataset.disabled = offline ? 'true' : 'false';
		elements.modelPickerHost.dataset.disabled = offline ? 'true' : 'false';
		this._renderSelectBox(elements.agentPickerHost, session.availableAgents, session.selectedAgent, localize('agentModeEditorSurfaceAgentPickerAria', 'Select agent'), option => this._agentSessionService.setSelectedAgent(option), 'plain');
		this._renderSelectBox(elements.modelPickerHost, session.availableModels, session.selectedModel, localize('agentModeEditorSurfaceModelPickerAria', 'Select model'), option => this._agentSessionService.setSelectedModel(option), 'model');
	}

	private _updateTimeline(session: IAgentSessionModel, options: { sessionChanged: boolean; previousTimelineState: { scrollTop: number; nearBottom: boolean } | undefined }): void {
		const elements = this._shellElements;
		if (!elements) {
			return;
		}

		const timeline = elements.timeline;
		const nextItems = this._getRenderableTimeline(session);
		const nextIds = nextItems.map(item => this._timelineSignature(item, session));

		if (!nextItems.length) {
			if (this._renderedTimelineIds.length !== 0 || !this._timelineShowsEmptyState) {
				timeline.replaceChildren(this._createElement('div', 'agent-mode-editor-surface__empty', localize('agentModeEditorSurfaceEmpty', 'Start the session with a prompt. New messages, tool activity, and execution details will land here.')));
				this._renderedTimelineIds = [];
				this._timelineShowsEmptyState = true;
				this._timelineRenderDisposables.clear();
			}
			return;
		}

		if (this._timelineShowsEmptyState) {
			timeline.replaceChildren();
			this._timelineShowsEmptyState = false;
		}

		if (options.sessionChanged || !this._isTimelinePrefixStable(this._renderedTimelineIds, nextIds)) {
			if (!options.sessionChanged && this._isTimelineLastTurnChanged(this._renderedTimelineIds, nextIds)) {
				const lastChild = timeline.lastElementChild;
				if (lastChild) {
					const newNode = this._createTimelineNode(nextItems[nextItems.length - 1]);
					timeline.replaceChild(newNode, lastChild);
					this._restoreTimelineDisclosureState(session.id, newNode);
					this._renderedTimelineIds = [...nextIds];
					if (this._timelineAutoFollow || (options.previousTimelineState?.nearBottom ?? true)) {
						timeline.scrollTop = Math.max(0, timeline.scrollHeight - timeline.clientHeight);
					}
					return;
				}
			}

			timeline.replaceChildren();
			this._timelineRenderDisposables.clear();
			for (const item of nextItems) {
				timeline.appendChild(this._createTimelineNode(item));
			}
			this._restoreTimelineDisclosureState(session.id, timeline);
			this._renderedTimelineIds = [...nextIds];
			this._restoreTimelinePosition(timeline, options.previousTimelineState, options.sessionChanged);
			return;
		}

		if (nextIds.length === this._renderedTimelineIds.length) {
			return;
		}

		const shouldStickToBottom = options.previousTimelineState?.nearBottom ?? true;
		for (let index = this._renderedTimelineIds.length; index < nextItems.length; index++) {
			timeline.appendChild(this._createTimelineNode(nextItems[index]));
		}
		this._restoreTimelineDisclosureState(session.id, timeline);
		this._renderedTimelineIds = [...nextIds];
		if (this._timelineAutoFollow || shouldStickToBottom) {
			timeline.scrollTop = Math.max(0, timeline.scrollHeight - timeline.clientHeight);
		}
	}

	private _restoreTimelinePosition(timeline: HTMLElement, previousState: { scrollTop: number; nearBottom: boolean } | undefined, sessionChanged: boolean): void {
		if (!previousState) {
			timeline.scrollTop = sessionChanged ? Math.max(0, timeline.scrollHeight - timeline.clientHeight) : 0;
			return;
		}

		if (sessionChanged || this._timelineAutoFollow || previousState.nearBottom) {
			timeline.scrollTop = Math.max(0, timeline.scrollHeight - timeline.clientHeight);
			return;
		}

		const maxScrollTop = Math.max(0, timeline.scrollHeight - timeline.clientHeight);
		timeline.scrollTop = Math.min(previousState.scrollTop, maxScrollTop);
	}

	private _isTimelinePrefixStable(previousIds: readonly string[], nextIds: readonly string[]): boolean {
		if (previousIds.length > nextIds.length) {
			return false;
		}

		for (let index = 0; index < previousIds.length; index++) {
			if (previousIds[index] !== nextIds[index]) {
				return false;
			}
		}

		return true;
	}

	private _isTimelineLastTurnChanged(previousIds: readonly string[], nextIds: readonly string[]): boolean {
		if (previousIds.length === 0 || previousIds.length !== nextIds.length) {
			return false;
		}

		for (let index = 0; index < previousIds.length - 1; index++) {
			if (previousIds[index] !== nextIds[index]) {
				return false;
			}
		}

		return previousIds[previousIds.length - 1] !== nextIds[nextIds.length - 1];
	}

	private _timelineSignature(turn: IAgentConversationTurn, session: IAgentSessionModel): string {
		return getAgentConversationTurnSignature(turn, this._hasLiveExecution(session));
	}

	private _getRenderableTimeline(session: IAgentSessionModel): readonly IAgentConversationTurn[] {
		const items = [...session.timeline];
		const runningPlaceholder = this._createRunningPlaceholderItem(session, items);
		if (runningPlaceholder) {
			items.push(runningPlaceholder);
		}

		return buildAgentConversationTurns(items, this._hasLiveExecution(session));
	}

	private _createRunningPlaceholderItem(session: IAgentSessionModel, items: readonly IAgentTimelineItem[]): IAgentTimelineItem | undefined {
		if (!this._isSessionRunning(session) || this._hasVisibleAgentContent(items)) {
			return undefined;
		}

		return {
			id: `__thinking__:${session.id}`,
			kind: 'status',
			label: 'Thinking',
			body: this._getRunningPlaceholderText(items),
			tone: 'running'
		};
	}

	private _getRunningPlaceholderText(items: readonly IAgentTimelineItem[]): string {
		const activeProcess = [...items].reverse().find(item =>
			item.kind !== 'user'
			&& item.phase !== undefined
			&& (item.phase === 'pending' || item.phase === 'running')
		);

		if (!activeProcess) {
			return localize('agentModeEditorSurfaceThinkingIndicator', 'Thinking...');
		}

		switch (activeProcess.kind) {
			case 'command':
				return localize('agentModeEditorSurfaceRunningCommandsIndicator', 'Running commands...');
			case 'patch':
				return localize('agentModeEditorSurfaceMakingEditsIndicator', 'Making edits...');
			case 'tool':
				return this._getToolPlaceholderText(activeProcess);
			default:
				return localize('agentModeEditorSurfaceThinkingIndicator', 'Thinking...');
		}
	}

	private _getToolPlaceholderText(item: IAgentTimelineItem): string {
		const toolContext = `${item.title ?? ''} ${item.label} ${(item.bullets ?? []).join(' ')}`.toLowerCase();

		if (/webfetch|web search|websearch|fetch webpage|fetch_webpage|browser/.test(toolContext)) {
			return localize('agentModeEditorSurfaceSearchingWebIndicator', 'Searching the web...');
		}

		if (/grep|glob|code search|codesearch|search|ripgrep/.test(toolContext)) {
			return localize('agentModeEditorSurfaceSearchingCodebaseIndicator', 'Searching the codebase...');
		}

		if (/read|list|directory|file/.test(toolContext)) {
			return localize('agentModeEditorSurfaceGatheringContextIndicator', 'Exploring...');
		}

		if (/agent|delegate|subagent/.test(toolContext)) {
			return localize('agentModeEditorSurfaceDelegatingIndicator', 'Delegating work...');
		}

		return localize('agentModeEditorSurfaceThinkingIndicator', 'Thinking...');
	}

	private _hasVisibleAgentContent(items: readonly IAgentTimelineItem[]): boolean {
		return items.some(item => item.kind !== 'user' && item.kind !== 'status');
	}

	private _createTimelineNode(turn: IAgentConversationTurn): HTMLElement {
		return this._createTimelineNodeElement(turn);
	}

	private _createTimelineNodeElement(turn: IAgentConversationTurn): HTMLElement {
		return renderAgentConversationTurn(turn, {
			hasLiveExecution: this._hasLiveExecution(this._agentSessionService.activeSession),
			renderDisposables: this._timelineRenderDisposables
		});
	}

	private _restoreTimelineDisclosureState(sessionId: string, timeline: HTMLElement): void {
		for (const element of this._walkDescendantElements(timeline)) {
			if (element.tagName !== 'DETAILS') {
				continue;
			}

			const disclosure = element as HTMLDetailsElement;
			const disclosureId = disclosure.dataset.disclosureId;
			if (!disclosureId) {
				continue;
			}

			const open = this._agentSessionService.getTimelineDisclosureState(sessionId, disclosureId);
			if (open !== undefined) {
				disclosure.open = open;
			}
		}
	}

	private _createElement<K extends keyof HTMLElementTagNameMap>(tagName: K, className?: string, textContent?: string): HTMLElementTagNameMap[K] {
		const element = document.createElement(tagName);
		if (className) {
			element.className = className;
		}
		if (textContent !== undefined) {
			element.textContent = textContent;
		}
		return element;
	}

	private _bindInteractions(overlay: HTMLElement): void {
		this._overlayDisposables.clear();

		const elements = this._shellElements;
		if (!elements) {
			return;
		}

		const textarea = elements.composerInput;
		const agentSelectContainer = elements.agentPickerHost;
		const modelSelectContainer = elements.modelPickerHost;
		const primaryActionButton = elements.primaryActionButton;
		const timeline = elements.timeline;

		if (timeline) {
			let animationFrameHandle: number | undefined;
			let targetScrollTop = timeline.scrollTop;

			const animateWheelScroll = () => {
				const delta = targetScrollTop - timeline.scrollTop;
				if (Math.abs(delta) < 0.5) {
					timeline.scrollTop = targetScrollTop;
					animationFrameHandle = undefined;
					return;
				}

				timeline.scrollTop += delta * 0.24;
				animationFrameHandle = mainWindow.requestAnimationFrame(animateWheelScroll);
			};

			const routeWheelToTimeline = (event: WheelEvent) => {
				if (!timeline || timeline.scrollHeight <= timeline.clientHeight) {
					return;
				}

				const target = event.target as HTMLElement | null;
				if (target?.closest('.agent-mode-editor-surface__composer')) {
					return;
				}

				const maxScrollTop = Math.max(0, timeline.scrollHeight - timeline.clientHeight);
				const nextScrollTop = Math.min(maxScrollTop, Math.max(0, targetScrollTop + event.deltaY));
				if (nextScrollTop !== targetScrollTop) {
					targetScrollTop = nextScrollTop;
					if (animationFrameHandle === undefined) {
						animationFrameHandle = mainWindow.requestAnimationFrame(animateWheelScroll);
					}
					event.preventDefault();
					event.stopPropagation();
				}
			};

			this._overlayDisposables.add({
				dispose: () => {
					if (animationFrameHandle !== undefined) {
						mainWindow.cancelAnimationFrame(animationFrameHandle);
						animationFrameHandle = undefined;
					}
				}
			});
			this._overlayDisposables.add(addDisposableListener(overlay, EventType.WHEEL, routeWheelToTimeline, { capture: true }));
			this._overlayDisposables.add(addDisposableListener(timeline, EventType.WHEEL, routeWheelToTimeline, { capture: true }));
			this._overlayDisposables.add(addDisposableListener(timeline, EventType.SCROLL, () => {
				targetScrollTop = timeline.scrollTop;
				this._timelineAutoFollow = timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop < 24;
			}));
		}

		if (textarea && !textarea.disabled) {
			this._overlayDisposables.add(addDisposableListener(textarea, EventType.INPUT, () => {
				this._agentSessionService.updateComposerDraft(textarea.value);
			}));
			this._overlayDisposables.add(addDisposableListener(textarea, EventType.KEY_DOWN, event => {
				if (event.key !== 'ArrowUp' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || textarea.selectionStart !== 0 || textarea.selectionEnd !== 0) {
					return;
				}

				if (this._focusComposerAdjacentTarget()) {
					event.preventDefault();
					event.stopPropagation();
				}
			}));
		}

		this._renderSelectBox(agentSelectContainer, this._agentSessionService.activeSession.availableAgents, this._agentSessionService.activeSession.selectedAgent, localize('agentModeEditorSurfaceAgentPickerAria', 'Select agent'), option => this._agentSessionService.setSelectedAgent(option), 'plain');
		this._renderSelectBox(modelSelectContainer, this._agentSessionService.activeSession.availableModels, this._agentSessionService.activeSession.selectedModel, localize('agentModeEditorSurfaceModelPickerAria', 'Select model'), option => this._agentSessionService.setSelectedModel(option), 'model');

		if (primaryActionButton && !primaryActionButton.disabled) {
			this._overlayDisposables.add(addDisposableListener(primaryActionButton, EventType.CLICK, () => {
				if (this._isSessionRunning(this._agentSessionService.activeSession)) {
					void this._agentSessionService.stopActiveRequest();
					return;
				}

				void this._agentSessionService.sendComposerPrompt();
			}));
		}

		for (const element of [elements.attachmentButton, elements.primaryActionButton, elements.agentPickerHost, elements.modelPickerHost]) {
			this._overlayDisposables.add(addDisposableListener(element, EventType.KEY_DOWN, event => {
				if (event.key !== 'ArrowUp' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
					return;
				}

				if (this._focusComposerAdjacentTarget()) {
					event.preventDefault();
					event.stopPropagation();
				}
			}));
		}

		if (elements.composerBanner.style.display !== 'none') {
			this._overlayDisposables.add(addDisposableListener(elements.composerBanner, EventType.CLICK, event => {
				event.preventDefault();
				event.stopPropagation();
				const itemId = elements.composerBanner.dataset.itemId;
				if (itemId) {
					this._revealTimelineItem(itemId, true);
				}
			}));
			this._overlayDisposables.add(addDisposableListener(elements.composerBanner, EventType.KEY_DOWN, event => {
				if (event.key !== 'ArrowDown' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || elements.composerInput.disabled) {
					return;
				}

				event.preventDefault();
				event.stopPropagation();
				elements.composerInput.focus({ preventScroll: true });
			}));
		}

		if (timeline) {
			this._overlayDisposables.add(addDisposableListener(timeline, EventType.CLICK, event => {
				const target = event.target as HTMLElement | null;
				const actionButton = target?.closest<HTMLButtonElement>('.agent-mode-editor-surface__process-action[data-action][data-item-id]');
				if (!actionButton) {
					return;
				}

				const action = actionButton.dataset.action;
				const itemId = actionButton.dataset.itemId;
				if (!action || !itemId) {
					return;
				}

				event.preventDefault();
				event.stopPropagation();
				void this._handleTimelineAction(action, itemId);
			}));
			this._overlayDisposables.add(addDisposableListener(timeline, 'toggle', event => {
				const target = event.target;
				if (!isHTMLElement(target) || target.tagName !== 'DETAILS') {
					return;
				}
				const disclosure = target as HTMLDetailsElement;

				const disclosureId = disclosure.dataset.disclosureId;
				if (!disclosureId) {
					return;
				}

				this._agentSessionService.setTimelineDisclosureState(this._agentSessionService.activeSession.id, disclosureId, disclosure.open);
			}));
			this._overlayDisposables.add(addDisposableListener(timeline, EventType.KEY_DOWN, event => {
				if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
					return;
				}

				if (event.key === 'Escape') {
					event.preventDefault();
					event.stopPropagation();
					elements.composerInput.focus({ preventScroll: true });
					return;
				}

				if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
					const target = event.target as HTMLElement | null;
					if (!target) {
						return;
					}

					const focusTargets = this._collectTimelineFocusTargets(timeline);
					const currentIndex = focusTargets.indexOf(target);
					if (currentIndex === -1) {
						return;
					}

					if (event.key === 'ArrowDown') {
						if (currentIndex < focusTargets.length - 1) {
							event.preventDefault();
							event.stopPropagation();
							focusTargets[currentIndex + 1].focus({ preventScroll: true });
							focusTargets[currentIndex + 1].scrollIntoView({ block: 'nearest' });
						} else if (!elements.composerInput.disabled) {
							event.preventDefault();
							event.stopPropagation();
							elements.composerInput.focus({ preventScroll: true });
						}
					} else {
						if (currentIndex > 0) {
							event.preventDefault();
							event.stopPropagation();
							focusTargets[currentIndex - 1].focus({ preventScroll: true });
							focusTargets[currentIndex - 1].scrollIntoView({ block: 'nearest' });
						}
					}
				}
			}));
		}
	}

	private async _handleTimelineAction(action: string, itemId: string): Promise<void> {
		const session = this._agentSessionService.activeSession;
		const item = session.timeline.find(candidate => candidate.id === itemId);
		if (!item) {
			return;
		}

		switch (action) {
			case 'approval:allow':
				if (item.permissionRequestId) {
					this._pendingComposerFocus = true;
					await this._agentSessionService.replyToApproval(item.permissionRequestId, 'allow');
				}
				return;
			case 'approval:deny':
				if (item.permissionRequestId) {
					this._pendingComposerFocus = true;
					await this._agentSessionService.replyToApproval(item.permissionRequestId, 'deny');
				}
				return;
			case 'approval:allowAll':
				if (item.permissionRequestId) {
					this._pendingComposerFocus = true;
					await this._agentSessionService.replyToApproval(item.permissionRequestId, 'allowAll');
				}
				return;
			case 'command:openTerminal':
				await this._openCommandInTerminal(session, item);
				return;
			case 'command:copy':
			case 'approval:copyCommand':
				await this._clipboardService.writeText(item.code ?? '');
				return;
			case 'process:copyRaw':
				await this._clipboardService.writeText(item.rawData ?? '');
				return;
			case 'patch:viewFiles':
				await this._openPatchFiles(session, item);
				return;
			case 'patch:openDiff':
				await this._openPatchDiff(session, item);
				return;
		}
	}

	private async _openCommandInTerminal(session: IAgentSessionModel, item: IAgentTimelineItem): Promise<void> {
		const terminal = await this._terminalService.createAndFocusTerminal({
			cwd: this._resolveTerminalCwd(session.workingDirectoryLabel),
			location: TerminalLocation.Panel
		});
		this._layoutService.setPartHidden(false, Parts.PANEL_PART);
		await terminal.sendText(item.code ?? '', false);
	}

	private async _openPatchFiles(session: IAgentSessionModel, item: IAgentTimelineItem): Promise<void> {
		const resources = (item.filePaths ?? [])
			.map(filePath => this._resolveFileResource(filePath, session.workingDirectoryLabel))
			.filter((resource): resource is URI => !!resource);
		if (!resources.length) {
			return;
		}

		this._workbenchModeService.setMode('editor');
		await this._editorService.openEditors(resources.map(resource => ({
			resource,
			options: { pinned: true }
		})));
	}

	private async _openPatchDiff(session: IAgentSessionModel, item: IAgentTimelineItem): Promise<void> {
		const resources = (item.filePaths ?? [])
			.map(filePath => this._resolveFileResource(filePath, session.workingDirectoryLabel))
			.filter((resource): resource is URI => !!resource);
		if (!resources.length) {
			return;
		}

		const editors = await Promise.all(resources.map(async resource => {
			const originalResource = await getOriginalResource(this._quickDiffService, resource, undefined, undefined);
			if (originalResource) {
				return {
					original: { resource: originalResource },
					modified: { resource },
					options: { pinned: true }
				};
			}

			return {
				resource,
				options: { pinned: true }
			};
		}));

		this._workbenchModeService.setMode('editor');
		await this._editorService.openEditors(editors);
	}

	private _getPendingApprovalItem(session: IAgentSessionModel): IAgentTimelineItem | undefined {
		return session.timeline.find(item => item.kind === 'approval' && item.phase === 'waitingApproval');
	}

	private _getComposerBannerText(item: IAgentTimelineItem): string {
		const target = this._getComposerBannerTarget(item);
		return target
			? localize('agentModeEditorSurfaceComposerBanner', 'Permission required: {0}', target)
			: localize('agentModeEditorSurfaceComposerBannerFallback', 'Permission required');
	}

	private _getComposerBannerAriaLabel(item: IAgentTimelineItem): string {
		const target = this._getComposerBannerTarget(item);
		return target
			? localize('agentModeEditorSurfaceComposerBannerDetailed', 'Approval required: {0}', target)
			: localize('agentModeEditorSurfaceComposerBannerFallback', 'Permission required');
	}

	private _getComposerBannerTarget(item: IAgentTimelineItem): string | undefined {
		const candidate = item.title || item.body || item.code?.trim();
		if (!candidate) {
			return undefined;
		}

		const normalized = candidate.replace(/\s+/g, ' ').trim();
		return normalized.length > 72 ? `${normalized.slice(0, 72).trimEnd()}...` : normalized;
	}

	private _revealTimelineItem(itemId: string, focus = false): void {
		const timeline = this._shellElements?.timeline;
		const target = timeline ? this._findTimelineItemElement(timeline, itemId) : undefined;
		if (!timeline || !target) {
			return;
		}

		for (let element: HTMLElement | null = target.parentElement; element; element = element.parentElement) {
			if (element.tagName === 'DETAILS') {
				(element as HTMLDetailsElement).open = true;
			}
		}

		target.scrollIntoView({ block: 'center', behavior: 'smooth' });
		target.classList.add('agent-mode-editor-surface__message-row--targeted');
		if (focus) {
			const focusTarget = this._findTimelineFocusTarget(target) ?? target;
			focusTarget.focus({ preventScroll: true });
		}
		mainWindow.setTimeout(() => target.classList.remove('agent-mode-editor-surface__message-row--targeted'), 1400);
	}

	private _focusComposerAdjacentTarget(): boolean {
		const elements = this._shellElements;
		if (!elements) {
			return false;
		}

		if (elements.composerBanner.style.display !== 'none') {
			elements.composerBanner.focus({ preventScroll: true });
			return true;
		}

		const lastTimelineTarget = this._findLastTimelineFocusTarget(elements.timeline);
		if (!lastTimelineTarget) {
			return false;
		}

		lastTimelineTarget.focus({ preventScroll: true });
		return true;
	}

	private _findTimelineItemElement(timeline: HTMLElement, itemId: string): HTMLElement | undefined {
		for (const element of this._walkDescendantElements(timeline)) {
			if (element.classList.contains('agent-mode-editor-surface__message-row') && element.dataset.itemId === itemId) {
				return element;
			}
		}

		return undefined;
	}

	private _findTimelineFocusTarget(target: HTMLElement): HTMLElement | undefined {
		for (const element of this._walkDescendantElements(target)) {
			if (element.tagName === 'BUTTON' && (element as HTMLButtonElement).disabled === false) {
				return element;
			}
		}

		for (const element of this._walkDescendantElements(target)) {
			if (element.tagName === 'SUMMARY') {
				return element;
			}
		}

		return undefined;
	}

	private _findLastTimelineFocusTarget(timeline: HTMLElement): HTMLElement | undefined {
		const descendants = [...this._walkDescendantElements(timeline)];
		for (let index = descendants.length - 1; index >= 0; index--) {
			const element = descendants[index];
			if (element.tagName === 'BUTTON' && (element as HTMLButtonElement).disabled === false) {
				return element;
			}
		}

		for (let index = descendants.length - 1; index >= 0; index--) {
			const element = descendants[index];
			if (element.tagName === 'SUMMARY') {
				return element;
			}
		}

		return undefined;
	}

	private _collectTimelineFocusTargets(timeline: HTMLElement): HTMLElement[] {
		const targets: HTMLElement[] = [];
		for (const element of this._walkDescendantElements(timeline)) {
			if ((element.tagName === 'BUTTON' && (element as HTMLButtonElement).disabled === false) || element.tagName === 'SUMMARY') {
				targets.push(element);
			}
		}
		return targets;
	}

	private *_walkDescendantElements(root: HTMLElement): Iterable<HTMLElement> {
		for (let element = root.firstElementChild; element; element = element.nextElementSibling) {
			if (!isHTMLElement(element)) {
				continue;
			}

			yield element;
			yield* this._walkDescendantElements(element);
		}
	}

	private _resolveTerminalCwd(workingDirectory: string | undefined): string | URI | undefined {
		if (!workingDirectory) {
			return undefined;
		}

		if (workingDirectory.includes('://')) {
			return URI.parse(workingDirectory);
		}

		return workingDirectory;
	}

	private _resolveFileResource(filePath: string, workingDirectory: string | undefined): URI | undefined {
		if (!filePath) {
			return undefined;
		}

		if (filePath.includes('://')) {
			return URI.parse(filePath);
		}

		const absolutePath = win32.isAbsolute(filePath)
			? filePath
			: (workingDirectory ? win32.resolve(workingDirectory, filePath) : undefined);
		if (!absolutePath) {
			return undefined;
		}

		return URI.file(absolutePath);
	}

	private _isSessionRunning(session: IAgentSessionModel): boolean {
		return session.sessionPhase === 'running';
	}

	private _hasLiveExecution(session: IAgentSessionModel): boolean {
		return session.sessionPhase === 'running' || session.sessionPhase === 'waitingApproval';
	}

	private _renderSelectBox(
		container: HTMLElement | null,
		options: readonly { id: string; label: string; detail?: string }[],
		selectedId: string,
		ariaLabel: string,
		onSelect: (optionId: string) => void,
		displayMode: 'plain' | 'model'
	): void {
		if (!container) {
			return;
		}

		container.replaceChildren();
		const selectOptions = options.map(option => this._toSelectOption(option.label, option.detail, displayMode));
		const selectedIndex = Math.max(0, options.findIndex(option => option.id === selectedId));
		const selectBox = new SelectBox(selectOptions, selectedIndex, this._contextViewService, getSelectBoxStyles({}), {
			ariaLabel,
			useCustomDrawn: true
		});
		selectBox.setFocusable(true);
		selectBox.setEnabled(container.dataset.disabled !== 'true');
		this._overlayDisposables.add(selectBox);
		this._overlayDisposables.add(selectBox.onDidSelect(({ index }) => {
			const option = options[index];
			if (option) {
				onSelect(option.id);
			}
		}));
		selectBox.render(container);

		const selectedOption = selectOptions[selectedIndex];
		const width = this._measureComposerPickerWidth(selectedOption?.text ?? '');
		container.style.width = `${width}px`;
		const renderedSelect = container.firstElementChild;
		if (renderedSelect) {
			if (isHTMLElement(renderedSelect)) {
				renderedSelect.style.width = `${width}px`;
			}
		}
	}

	private _toSelectOption(label: string, detail: string | undefined, displayMode: 'plain' | 'model'): ISelectOptionItem {
		if (displayMode === 'plain') {
			return { text: label };
		}

		const modelName = label.replace(/-/g, ' ');

		return {
			text: modelName,
			detail: detail ? localize('agentModeEditorSurfaceModelPickerDescription', '· {0}', detail) : undefined,
			description: detail ? localize('agentModeEditorSurfaceModelPickerAriaDescription', '{0} ({1})', modelName, detail) : modelName
		};
	}

	private _measureComposerPickerWidth(text: string): number {
		const measurementNode = document.createElement('span');
		measurementNode.textContent = text;
		measurementNode.style.position = 'absolute';
		measurementNode.style.visibility = 'hidden';
		measurementNode.style.pointerEvents = 'none';
		measurementNode.style.whiteSpace = 'pre';
		measurementNode.style.fontSize = '11px';
		measurementNode.style.fontWeight = '500';
		measurementNode.style.fontFamily = 'Segoe WPC, Segoe UI, sans-serif';
		mainWindow.document.body.appendChild(measurementNode);
		const textWidth = measurementNode.getBoundingClientRect().width;
		measurementNode.remove();
		return Math.max(72, Math.min(220, Math.ceil(textWidth) + 42));
	}

}

registerWorkbenchContribution2(AgentModeEditorSurfaceContribution.ID, AgentModeEditorSurfaceContribution, WorkbenchPhase.AfterRestored);
