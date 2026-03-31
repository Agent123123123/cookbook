/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/agentModeCompactChatViewPane.css';
import './media/agentModeEditorSurface.css';
import './media/agentModeView.css';
import { $, addDisposableListener, append, clearNode, EventType, getWindow, isHTMLElement, isHTMLTextAreaElement } from '../../../../base/browser/dom.js';
import { ISelectOptionItem, SelectBox } from '../../../../base/browser/ui/selectBox/selectBox.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { win32 } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewletViewOptions } from '../../../browser/parts/views/viewsViewlet.js';
import { IContextMenuService, IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IAgentModeChatService } from './agentModeChatService.js';
import { buildAgentConversationTurns, IAgentConversationTurn, IAgentSessionModel, IAgentSessionService, IAgentTimelineItem } from './agentSessionService.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';
import { IQuickDiffService } from '../../scm/common/quickDiff.js';
import { getOriginalResource } from '../../scm/common/quickDiffService.js';
import { getSelectBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IWorkbenchModeService } from './agentMode.contribution.js';
import { AgentModeContextUsageWidget } from './agentModeContextUsageWidget.js';
import { getAgentConversationTurnSignature, renderAgentConversationTurn } from './agentTimelineRenderer.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';

interface ICompactChatTemplate {
	readonly root: HTMLElement;
	readonly sessionsView: HTMLElement;
	readonly sessionsList: HTMLElement;
	readonly sessionsEmpty: HTMLElement;
	readonly sessionListTitle: HTMLElement;
	readonly conversationView: HTMLElement;
	readonly backButton: HTMLButtonElement;
	readonly newButton: HTMLButtonElement;
	readonly headlineTitle: HTMLElement;
	readonly headerMeta: HTMLElement;
	readonly timeline: HTMLElement;
	readonly composerShell: HTMLElement;
	readonly composerBanner: HTMLButtonElement;
	readonly composerInput: HTMLTextAreaElement;
	readonly composerStatus: HTMLElement;
	readonly composerError: HTMLElement;
	readonly contextUsageWidget: AgentModeContextUsageWidget;
	readonly agentPickerHost: HTMLElement;
	readonly modelPickerHost: HTMLElement;
	readonly primaryActionButton: HTMLButtonElement;
	readonly attachmentButton: HTMLButtonElement;
	readonly sessionsButtons: HTMLButtonElement[];
}

export class AgentModeCompactChatViewPane extends ViewPane {

	private _template: ICompactChatTemplate | undefined;
	private readonly _bodyDisposables = this._register(new DisposableStore());
	private readonly _chromeDisposables = this._register(new DisposableStore());
	private readonly _composerDisposables = this._register(new DisposableStore());
	private readonly _timelineDisposables = this._register(new DisposableStore());
	private readonly _sessionListDisposables = this._register(new DisposableStore());
	private _renderedSessionId: string | undefined;
	private _renderedTimelineIds: string[] = [];
	private _timelineShowsEmptyState = false;
	private _timelineAutoFollow = true;
	private _showSessionsList = false;
	private _pendingComposerFocus = false;
	private _renderedComposerPhase: IAgentSessionModel['sessionPhase'] | undefined;

	constructor(
		options: IViewletViewOptions,
		@IAgentSessionService private readonly _agentSessionService: IAgentSessionService,
		@IAgentModeChatService private readonly _agentModeChatService: IAgentModeChatService,
		@IWorkbenchModeService private readonly _workbenchModeService: IWorkbenchModeService,
		@IWorkbenchLayoutService private readonly _layoutService: IWorkbenchLayoutService,
		@IEditorService private readonly _editorService: IEditorService,
		@ITerminalService private readonly _terminalService: ITerminalService,
		@IQuickDiffService private readonly _quickDiffService: IQuickDiffService,
		@IClipboardService private readonly _clipboardService: IClipboardService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IContextViewService private readonly _contextViewService: IContextViewService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this.element.classList.add('agent-mode-compact-chat-pane');
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		const root = append(container, $('.agent-mode-compact-chat'));
		const sessionsView = append(root, $('.agent-mode-compact-chat__sessions-view'));
		const sessionsHeader = append(sessionsView, $('.agent-mode-compact-chat__sessions-header'));
		const sessionListTitle = append(sessionsHeader, $('.agent-mode-compact-chat__sessions-title', undefined, localize('agentModeCompactChatSessionsTitle', 'Sessions')));
		const newListButton = append(sessionsHeader, $('button.agent-mode-compact-chat__toolbar-button.agent-mode-compact-chat__toolbar-button--icon.agent-mode-compact-chat__toolbar-button--primary', { type: 'button', 'aria-label': localize('agentModeCompactChatNewSessionAria', 'New session') })) as HTMLButtonElement;
		append(newListButton, $('span.codicon.codicon-add'));
		const sessionsList = append(sessionsView, $('.agent-mode-sessions__list.agent-mode-compact-chat__sessions-list'));
		const sessionsEmpty = append(sessionsView, $('.agent-mode-compact-chat__sessions-empty', undefined, localize('agentModeCompactChatEmptySessions', 'No previous sessions yet. Start a new one to begin.')));

		const conversationView = append(root, $('.agent-mode-compact-chat__conversation-view'));
		const conversationHeader = append(conversationView, $('.agent-mode-compact-chat__conversation-header'));
		const backButton = append(conversationHeader, $('button.agent-mode-compact-chat__toolbar-button.agent-mode-compact-chat__toolbar-button--icon', { type: 'button', 'aria-label': localize('agentModeCompactChatBackAria', 'Back to sessions') })) as HTMLButtonElement;
		append(backButton, $('span.codicon.codicon-arrow-left'));
		const headerCenter = append(conversationHeader, $('.agent-mode-compact-chat__conversation-header-main'));
		const headlineTitle = append(headerCenter, $('.agent-mode-compact-chat__conversation-title'));
		const headerMeta = append(headerCenter, $('.agent-mode-compact-chat__conversation-meta'));
		const newButton = append(conversationHeader, $('button.agent-mode-compact-chat__toolbar-button.agent-mode-compact-chat__toolbar-button--icon.agent-mode-compact-chat__toolbar-button--primary', { type: 'button', 'aria-label': localize('agentModeCompactChatNewSessionAria', 'New session') })) as HTMLButtonElement;
		append(newButton, $('span.codicon.codicon-add'));

		const conversationBody = append(conversationView, $('.agent-mode-compact-chat__conversation-body'));
		const timeline = append(conversationBody, $('.agent-mode-editor-surface__timeline.agent-mode-compact-chat__timeline'));
		const composer = append(conversationBody, $('.agent-mode-editor-surface__composer.agent-mode-compact-chat__composer'));
		const composerShell = append(composer, $('.agent-mode-editor-surface__composer-shell.agent-mode-compact-chat__composer-shell'));
		const composerBanner = append(composerShell, $('button.agent-mode-editor-surface__composer-banner', { type: 'button' })) as HTMLButtonElement;
		composerBanner.style.display = 'none';
		const composerInput = document.createElement('textarea');
		composerInput.className = 'agent-mode-editor-surface__composer-input';
		const composerStatus = append(composerShell, $('.agent-mode-editor-surface__composer-status'));
		composerStatus.setAttribute('aria-live', 'polite');
		const composerError = append(composerShell, $('.agent-mode-editor-surface__composer-error'));
		composerError.setAttribute('role', 'alert');
		const composerMeta = append(composerShell, $('.agent-mode-editor-surface__composer-meta'));
		const composerControls = append(composerMeta, $('.agent-mode-editor-surface__composer-controls'));
		const attachmentButton = document.createElement('button');
		attachmentButton.className = 'agent-mode-editor-surface__attachment-button';
		attachmentButton.type = 'button';
		attachmentButton.setAttribute('aria-label', localize('agentModeEditorSurfaceAttach', 'Attach files'));
		attachmentButton.textContent = '+';
		const agentPickerHost = append(composerControls, $('.agent-mode-editor-surface__composer-picker-host.agent-mode-editor-surface__composer-picker-host--agent'));
		const modelPickerHost = append(composerControls, $('.agent-mode-editor-surface__composer-picker-host.agent-mode-editor-surface__composer-picker-host--model'));
		const contextUsageWidget = new AgentModeContextUsageWidget();
		composerControls.prepend(attachmentButton);
		composerControls.appendChild(contextUsageWidget.domNode);
		const composerActions = append(composerMeta, $('.agent-mode-editor-surface__composer-actions'));
		const primaryActionButton = document.createElement('button');
		primaryActionButton.className = 'agent-mode-editor-surface__action agent-mode-editor-surface__action--primary';
		primaryActionButton.type = 'button';
		primaryActionButton.textContent = localize('agentModeEditorSurfaceSend', 'Send');
		composerActions.append(primaryActionButton);
		composerShell.prepend(composerInput);

		this._template = {
			root,
			sessionsView,
			sessionsList,
			sessionsEmpty,
			sessionListTitle,
			conversationView,
			backButton,
			newButton,
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
			sessionsButtons: [],
		};

		this._register(this._agentSessionService.onDidChangeActiveSession(() => this._renderActiveState()));
		this._register(this._agentModeChatService.onDidRequestComposerFocus(() => {
			this._showSessionsList = false;
			this._pendingComposerFocus = true;
			this._renderActiveState();
		}));
		this._chromeDisposables.add(addDisposableListener(newListButton, EventType.CLICK, () => this._createNewSession()));
		this._chromeDisposables.add(addDisposableListener(newButton, EventType.CLICK, () => this._createNewSession()));
		this._chromeDisposables.add(addDisposableListener(backButton, EventType.CLICK, () => {
			this._showSessionsList = true;
			this._renderActiveState();
			this.focus();
		}));
		this._chromeDisposables.add(addDisposableListener(timeline, EventType.SCROLL, () => {
			this._timelineAutoFollow = timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop < 24;
		}));
		this._chromeDisposables.add(addDisposableListener(timeline, 'toggle', event => {
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
		this._chromeDisposables.add(addDisposableListener(timeline, EventType.KEY_DOWN, event => {
			if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
				return;
			}

			if (event.key === 'Escape') {
				event.preventDefault();
				event.stopPropagation();
				this._template?.composerInput.focus({ preventScroll: true });
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
					} else if (this._template && !this._template.composerInput.disabled) {
						event.preventDefault();
						event.stopPropagation();
						this._template.composerInput.focus({ preventScroll: true });
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

		this._renderActiveState();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this._template) {
			this._template.root.style.height = `${height}px`;
			this._template.root.style.width = `${width}px`;
		}
	}

	override focus(): void {
		if (!this._template) {
			return;
		}

		if (this._showSessionsList) {
			const firstButton = this._template.sessionsButtons[0];
			(firstButton ?? this._template.newButton).focus();
			return;
		}

		this._template.composerInput.focus();
	}

	private _createNewSession(): void {
		this._agentSessionService.createNewSession();
		this._showSessionsList = false;
		this._pendingComposerFocus = true;
		this._renderActiveState();
	}

	private _renderActiveState(): void {
		const template = this._template;
		if (!template) {
			return;
		}

		const previousTimelineState = this._captureTimelineState();
		const session = this._agentSessionService.activeSession;
		const activeElement = getWindow(template.root).document.activeElement;
		const focusedComposer = isHTMLTextAreaElement(activeElement) && activeElement === template.composerInput;
		const focusedComposerControl = isHTMLElement(activeElement) && this._isComposerControlElement(activeElement);
		const enteredWaitingApproval = this._renderedSessionId === session.id && this._renderedComposerPhase !== 'waitingApproval' && session.sessionPhase === 'waitingApproval';
		const recentSessions = this._agentSessionService.sessions.filter(item => !item.isDraft);
		if (!this._renderedSessionId && recentSessions.length > 0 && !session.timeline.length && !session.composerDraft) {
			this._showSessionsList = true;
		}

		template.sessionsView.style.display = this._showSessionsList ? 'flex' : 'none';
		template.conversationView.style.display = this._showSessionsList ? 'none' : 'flex';
		template.backButton.style.visibility = recentSessions.length ? 'visible' : 'hidden';
		template.sessionListTitle.textContent = localize('agentModeCompactChatSessionsTitle', 'Sessions');

		this._renderSessionsList(recentSessions, session.id);
		if (!this._showSessionsList) {
			this._updateConversationHeader(session);
			this._updateComposer(session, { preserveDraftValue: focusedComposer });
			this._updateTimeline(session, { sessionChanged: this._renderedSessionId !== session.id, previousTimelineState });
			if (enteredWaitingApproval && focusedComposerControl && template.composerBanner.style.display !== 'none') {
				template.composerBanner.focus({ preventScroll: true });
			} else if (this._pendingComposerFocus && !template.composerInput.disabled) {
				template.composerInput.focus({ preventScroll: true });
				const cursor = template.composerInput.value.length;
				template.composerInput.setSelectionRange(cursor, cursor);
			}
		}
		this._pendingComposerFocus = false;
		this._renderedSessionId = session.id;
		this._renderedComposerPhase = session.sessionPhase;
	}

	private _isComposerControlElement(element: HTMLElement): boolean {
		return element.classList.contains('agent-mode-editor-surface__composer-input')
			|| element.classList.contains('agent-mode-editor-surface__composer-banner')
			|| element.classList.contains('agent-mode-editor-surface__attachment-button')
			|| element.classList.contains('agent-mode-editor-surface__action')
			|| element.classList.contains('select-box')
			|| !!element.closest('.agent-mode-editor-surface__composer');
	}

	private _renderSessionsList(recentSessions: readonly { id: string; title: string; preview: string; previewLoading: boolean; status: string; updatedLabel: string; statusTone: string }[], activeSessionId: string): void {
		const template = this._template;
		if (!template) {
			return;
		}

		this._sessionListDisposables.clear();
		template.sessionsButtons.length = 0;
		clearNode(template.sessionsList);
		template.sessionsEmpty.style.display = recentSessions.length ? 'none' : '';
		for (const session of recentSessions) {
			const item = append(template.sessionsList, $('.agent-mode-sessions__item'));
			item.classList.add(`agent-mode-sessions__item--${session.statusTone}`);
			item.classList.toggle('agent-mode-sessions__item--active', session.id === activeSessionId && !this._showSessionsList);
			const button = append(item, $('button.agent-mode-sessions__button', { type: 'button' })) as HTMLButtonElement;
			template.sessionsButtons.push(button);
			button.setAttribute('aria-label', localize('agentModeCompactChatSessionAria', 'Session {0}. {1} Status {2}. Updated {3}.', session.title, session.previewLoading ? 'Loading preview.' : `${session.preview}.`, session.status, session.updatedLabel));
			const content = append(button, $('.agent-mode-sessions__item-content'));
			const header = append(content, $('.agent-mode-sessions__item-header'));
			append(header, $('.agent-mode-sessions__item-title', undefined, session.title));
			append(header, $('.agent-mode-sessions__item-updated', undefined, session.updatedLabel));
			const preview = append(content, $('.agent-mode-sessions__item-preview', undefined, session.previewLoading ? localize('agentModeCompactChatPreviewLoading', 'Loading preview...') : session.preview));
			preview.classList.toggle('agent-mode-sessions__item-preview--loading', session.previewLoading);
			this._sessionListDisposables.add(addDisposableListener(button, EventType.CLICK, () => {
				this._agentSessionService.setActiveSession(session.id);
				this._showSessionsList = false;
				this._pendingComposerFocus = true;
				this._renderActiveState();
			}));
		}
	}

	private _updateConversationHeader(session: IAgentSessionModel): void {
		const template = this._template;
		if (!template) {
			return;
		}

		template.headlineTitle.textContent = session.title;
		clearNode(template.headerMeta);
		append(template.headerMeta,
			$('.agent-mode-compact-chat__meta-pill', undefined, session.backendLabel),
			$('.agent-mode-compact-chat__meta-pill.agent-mode-compact-chat__meta-pill--muted', undefined, session.stateLabel)
		);
	}

	private _updateComposer(session: IAgentSessionModel, options: { preserveDraftValue: boolean }): void {
		const template = this._template;
		if (!template) {
			return;
		}

		const running = this._isSessionRunning(session);
		const waitingApproval = session.sessionPhase === 'waitingApproval';
		const offline = session.sessionPhase === 'offline';
		const error = session.sessionPhase === 'error';

		template.composerShell.classList.toggle('agent-mode-editor-surface__composer-shell--running', running);
		template.composerShell.classList.toggle('agent-mode-editor-surface__composer-shell--warning', waitingApproval);
		template.composerShell.classList.toggle('agent-mode-editor-surface__composer-shell--error', error);
		template.composerShell.classList.toggle('agent-mode-editor-surface__composer-shell--offline', offline);

		if (!options.preserveDraftValue || !template.composerInput.matches(':focus')) {
			template.composerInput.value = session.composerDraft;
		}
		template.composerInput.placeholder = session.composerPlaceholder;
		template.composerInput.disabled = offline || waitingApproval;

		const pendingApproval = this._getPendingApprovalItem(session);
		if (waitingApproval && pendingApproval) {
			template.composerBanner.textContent = this._getComposerBannerText(pendingApproval);
			template.composerBanner.setAttribute('aria-label', this._getComposerBannerAriaLabel(pendingApproval));
			template.composerBanner.title = this._getComposerBannerAriaLabel(pendingApproval);
			template.composerBanner.dataset.itemId = pendingApproval.id;
			template.composerBanner.style.display = '';
		} else {
			template.composerBanner.textContent = '';
			template.composerBanner.removeAttribute('aria-label');
			template.composerBanner.removeAttribute('title');
			delete template.composerBanner.dataset.itemId;
			template.composerBanner.style.display = 'none';
		}

		template.composerStatus.textContent = session.composerStatus;
		template.composerStatus.classList.toggle('agent-mode-editor-surface__composer-status--running', running);
		template.composerStatus.classList.toggle('agent-mode-editor-surface__composer-status--warning', waitingApproval);
		template.composerStatus.classList.toggle('agent-mode-editor-surface__composer-status--error', error);
		template.composerStatus.classList.toggle('agent-mode-editor-surface__composer-status--offline', offline);
		template.composerStatus.style.display = session.composerStatus && !(waitingApproval && pendingApproval) ? '' : 'none';

		template.composerError.textContent = session.composerError ?? '';
		template.composerError.style.display = session.composerError ? '' : 'none';
		template.contextUsageWidget.update(session.contextUsage);

		template.primaryActionButton.disabled = offline || waitingApproval;
		template.primaryActionButton.textContent = running
			? localize('agentModeEditorSurfaceStop', 'Stop')
			: waitingApproval
				? localize('agentModeEditorSurfacePaused', 'Paused')
				: localize('agentModeEditorSurfaceSend', 'Send');
		template.attachmentButton.disabled = offline || waitingApproval;
		template.agentPickerHost.dataset.disabled = offline ? 'true' : 'false';
		template.modelPickerHost.dataset.disabled = offline ? 'true' : 'false';
		this._renderSelectBox(template.agentPickerHost, session.availableAgents, session.selectedAgent, localize('agentModeEditorSurfaceAgentPickerAria', 'Select agent'), option => this._agentSessionService.setSelectedAgent(option), 'plain');
		this._renderSelectBox(template.modelPickerHost, session.availableModels, session.selectedModel, localize('agentModeEditorSurfaceModelPickerAria', 'Select model'), option => this._agentSessionService.setSelectedModel(option), 'model');

		this._composerDisposables.clear();
		this._composerDisposables.add(addDisposableListener(template.composerInput, EventType.INPUT, () => {
			this._agentSessionService.updateComposerDraft(template.composerInput.value);
		}));
		this._composerDisposables.add(addDisposableListener(template.composerInput, EventType.KEY_DOWN, event => {
			if (event.key !== 'ArrowUp' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || template.composerInput.selectionStart !== 0 || template.composerInput.selectionEnd !== 0) {
				return;
			}

			if (this._focusComposerAdjacentTarget()) {
				event.preventDefault();
				event.stopPropagation();
			}
		}));
		this._composerDisposables.add(addDisposableListener(template.primaryActionButton, EventType.CLICK, () => {
			if (this._isSessionRunning(this._agentSessionService.activeSession)) {
				void this._agentSessionService.stopActiveRequest();
				return;
			}
			void this._agentSessionService.sendComposerPrompt();
		}));
		for (const element of [template.attachmentButton, template.primaryActionButton, template.agentPickerHost, template.modelPickerHost]) {
			this._composerDisposables.add(addDisposableListener(element, EventType.KEY_DOWN, event => {
				if (event.key !== 'ArrowUp' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
					return;
				}

				if (this._focusComposerAdjacentTarget()) {
					event.preventDefault();
					event.stopPropagation();
				}
			}));
		}
		if (template.composerBanner.style.display !== 'none') {
			this._composerDisposables.add(addDisposableListener(template.composerBanner, EventType.CLICK, event => {
				event.preventDefault();
				event.stopPropagation();
				const itemId = template.composerBanner.dataset.itemId;
				if (itemId) {
					this._revealTimelineItem(itemId, true);
				}
			}));
			this._composerDisposables.add(addDisposableListener(template.composerBanner, EventType.KEY_DOWN, event => {
				if (event.key !== 'ArrowDown' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || template.composerInput.disabled) {
					return;
				}

				event.preventDefault();
				event.stopPropagation();
				template.composerInput.focus({ preventScroll: true });
			}));
		}
		this._composerDisposables.add(addDisposableListener(template.timeline, EventType.CLICK, event => {
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
	}

	private _updateTimeline(session: IAgentSessionModel, options: { sessionChanged: boolean; previousTimelineState: { scrollTop: number; nearBottom: boolean } | undefined }): void {
		const template = this._template;
		if (!template) {
			return;
		}

		const timeline = template.timeline;
		const nextItems = this._getRenderableTimeline(session);
		const nextIds = nextItems.map(item => this._timelineSignature(item, session));

		if (!nextItems.length) {
			if (this._renderedTimelineIds.length !== 0 || !this._timelineShowsEmptyState) {
				clearNode(timeline);
				append(timeline, $('.agent-mode-editor-surface__empty', undefined, localize('agentModeEditorSurfaceEmpty', 'Start the session with a prompt. New messages, tool activity, and execution details will land here.')));
				this._renderedTimelineIds = [];
				this._timelineShowsEmptyState = true;
				this._timelineDisposables.clear();
			}
			return;
		}

		if (this._timelineShowsEmptyState) {
			clearNode(timeline);
			this._timelineShowsEmptyState = false;
		}

		if (options.sessionChanged || !this._isTimelinePrefixStable(this._renderedTimelineIds, nextIds)) {
			if (!options.sessionChanged && this._isTimelineLastTurnChanged(this._renderedTimelineIds, nextIds)) {
				const lastChild = timeline.lastElementChild;
				if (lastChild) {
					const newNode = this._createTimelineNodeElement(nextItems[nextItems.length - 1]);
					timeline.replaceChild(newNode, lastChild);
					this._restoreTimelineDisclosureState(session.id, newNode);
					this._renderedTimelineIds = [...nextIds];
					if (this._timelineAutoFollow || (options.previousTimelineState?.nearBottom ?? true)) {
						timeline.scrollTop = Math.max(0, timeline.scrollHeight - timeline.clientHeight);
					}
					return;
				}
			}

			clearNode(timeline);
			this._timelineDisposables.clear();
			for (const item of nextItems) {
				timeline.appendChild(this._createTimelineNodeElement(item));
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
			timeline.appendChild(this._createTimelineNodeElement(nextItems[index]));
		}
		this._restoreTimelineDisclosureState(session.id, timeline);
		this._renderedTimelineIds = [...nextIds];
		if (this._timelineAutoFollow || shouldStickToBottom) {
			timeline.scrollTop = Math.max(0, timeline.scrollHeight - timeline.clientHeight);
		}
	}

	private _captureTimelineState(): { scrollTop: number; nearBottom: boolean } | undefined {
		const timeline = this._template?.timeline;
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

	private _createTimelineNodeElement(turn: IAgentConversationTurn): HTMLElement {
		return renderAgentConversationTurn(turn, {
			hasLiveExecution: this._hasLiveExecution(this._agentSessionService.activeSession),
			renderDisposables: this._timelineDisposables
		});
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
		const resources = (item.filePaths ?? []).map(filePath => this._resolveFileResource(filePath, session.workingDirectoryLabel)).filter((resource): resource is URI => !!resource);
		if (!resources.length) {
			return;
		}
		this._workbenchModeService.setMode('editor');
		await this._editorService.openEditors(resources.map(resource => ({ resource, options: { pinned: true } })));
	}

	private async _openPatchDiff(session: IAgentSessionModel, item: IAgentTimelineItem): Promise<void> {
		const resources = (item.filePaths ?? []).map(filePath => this._resolveFileResource(filePath, session.workingDirectoryLabel)).filter((resource): resource is URI => !!resource);
		if (!resources.length) {
			return;
		}
		const editors = await Promise.all(resources.map(async resource => {
			const originalResource = await getOriginalResource(this._quickDiffService, resource, undefined, undefined);
			if (originalResource) {
				return { original: { resource: originalResource }, modified: { resource }, options: { pinned: true } };
			}
			return { resource, options: { pinned: true } };
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
		const timeline = this._template?.timeline;
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
		const timeline = this._template?.timeline;
		const banner = this._template?.composerBanner;
		if (!timeline || !banner) {
			return false;
		}

		if (banner.style.display !== 'none') {
			banner.focus({ preventScroll: true });
			return true;
		}

		const lastTimelineTarget = this._findLastTimelineFocusTarget(timeline);
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
		const absolutePath = win32.isAbsolute(filePath) ? filePath : (workingDirectory ? win32.resolve(workingDirectory, filePath) : undefined);
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
		const activeProcess = [...items].reverse().find(item => item.kind !== 'user' && item.phase !== undefined && (item.phase === 'pending' || item.phase === 'running'));
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

	private _renderSelectBox(container: HTMLElement | null, options: readonly { id: string; label: string; detail?: string }[], selectedId: string, ariaLabel: string, onSelect: (optionId: string) => void, displayMode: 'plain' | 'model'): void {
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
		this._bodyDisposables.add(selectBox);
		this._bodyDisposables.add(selectBox.onDidSelect(({ index }) => {
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
		if (renderedSelect && isHTMLElement(renderedSelect)) {
			renderedSelect.style.width = `${width}px`;
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
		return Math.max(72, Math.min(200, Math.ceil(textWidth) + 42));
	}
}
