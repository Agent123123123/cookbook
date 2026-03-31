/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/agentModeView.css';
import { Codicon } from '../../../../base/common/codicons.js';
import { $, addDisposableListener, append, clearNode, EventType, getWindow } from '../../../../base/browser/dom.js';
import { localize, localize2 } from '../../../../nls.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewletViewOptions } from '../../../browser/parts/views/viewsViewlet.js';
import { WorkbenchAgentModeContext } from '../../../common/contextkeys.js';
import { Extensions as ViewContainerExtensions, IViewContainersRegistry, IViewDescriptor, IViewDescriptorService, IViewsRegistry, ViewContainer, ViewContainerLocation } from '../../../common/views.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IAgentSessionService } from './agentSessionService.js';

export const AGENT_MODE_VIEW_CONTAINER_ID = 'workbench.view.agentMode';
export const AGENT_MODE_VIEW_ID = 'workbench.view.agentMode.main';
export const AGENT_MODE_SESSIONS_VIEW_CONTAINER_ID = 'workbench.view.agentModeSessions';
export const AGENT_MODE_SESSIONS_VIEW_ID = 'workbench.view.agentModeSessions.list';

const agentModeViewIcon = registerIcon('agent-mode-view-icon', Codicon.agent, localize('agentModeViewIcon', 'Icon for the Agent Mode view.'));
const agentModeSessionsViewIcon = registerIcon('agent-mode-sessions-view-icon', Codicon.history, localize('agentModeSessionsViewIcon', 'Icon for the Agent Mode sessions view.'));
const sessionToneClasses = ['agent-mode-sessions__item--draft', 'agent-mode-sessions__item--running', 'agent-mode-sessions__item--warning', 'agent-mode-sessions__item--idle', 'agent-mode-sessions__item--error', 'agent-mode-sessions__item--offline'];

interface ISessionItemTemplate {
	readonly item: HTMLElement;
	readonly button: HTMLButtonElement;
	readonly title: HTMLElement;
	readonly status: HTMLElement;
	readonly preview: HTMLElement;
	readonly updated: HTMLElement;
}

interface ISessionsBodyTemplate {
	readonly root: HTMLElement;
	readonly newButton: HTMLButtonElement;
	readonly list: HTMLElement;
}

interface IContextBodyTemplate {
	readonly root: HTMLElement;
	readonly title: HTMLElement;
	readonly summary: HTMLElement;
	readonly chips: HTMLElement;
	readonly sections: HTMLElement;
}

class AgentModeSessionsViewPane extends ViewPane {

	private _bodyTemplate: ISessionsBodyTemplate | undefined;
	private readonly _bodyDisposables = this._register(new DisposableStore());
	private readonly _sessionListDisposables = this._register(new DisposableStore());
	private readonly _sessionItems = new Map<string, ISessionItemTemplate>();
	private _emptyStateElement: HTMLElement | undefined;
	private _renderedSessionOrder: string[] = [];

	constructor(
		options: IViewletViewOptions,
		@IAgentSessionService private readonly _agentSessionService: IAgentSessionService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this.element.classList.add('agent-mode-sessions-pane');
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		const root = append(container, $('.agent-mode-sessions'));
		const actions = append(root, $('.agent-mode-sessions__actions'));
		const newButton = append(actions, $('button.agent-mode-sessions__action', { type: 'button' },
			$('.agent-mode-sessions__action-icon.codicon.codicon-add'),
			$('.agent-mode-sessions__action-label', undefined, localize('agentModeSessionsNewButton', 'New session'))
		)) as HTMLButtonElement;
		append(root, $('.agent-mode-sessions__divider'));
		append(root, $('.agent-mode-sessions__section-title', undefined, localize('agentModeSessionsRecentTitle', 'Recent sessions')));
		const list = append(root, $('.agent-mode-sessions__list'));
		this._bodyTemplate = { root, newButton, list };

		this._register(this._agentSessionService.onDidChangeActiveSession(() => this._renderSessions()));
		this._bodyDisposables.add(addDisposableListener(newButton, EventType.CLICK, () => {
			this._agentSessionService.createNewSession();
		}));
		this._bindSessionListInteractions();
		this._renderSessions();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this._bodyTemplate) {
			this._bodyTemplate.root.style.height = `${height}px`;
			this._bodyTemplate.root.style.width = `${width}px`;
		}
	}

	private _renderSessions(): void {
		const bodyTemplate = this._bodyTemplate;
		if (!bodyTemplate) {
			return;
		}

		const listElement = bodyTemplate.list;
		const previousOrder = [...this._renderedSessionOrder];
		const previousPositions = new Map<string, DOMRect>();
		for (const sessionId of previousOrder) {
			const template = this._sessionItems.get(sessionId);
			if (template) {
				previousPositions.set(sessionId, template.item.getBoundingClientRect());
			}
		}

		this._sessionListDisposables.clear();
		const activeSessionId = this._agentSessionService.activeSession.id;
		const recentSessions = this._agentSessionService.sessions.filter(session => !session.isDraft);

		if (!recentSessions.length) {
			this._pruneSessionItems(listElement, new Set());
			this._renderedSessionOrder = [];
			if (!this._emptyStateElement) {
				this._emptyStateElement = append(listElement, $('.agent-mode-sessions__empty', undefined, localize('agentModeSessionsEmpty', 'No previous sessions yet. Start a new one from the action above.')));
			} else if (this._emptyStateElement.parentElement !== listElement) {
				append(listElement, this._emptyStateElement);
			}
			return;
		}

		this._emptyStateElement?.remove();
		const retainedSessionIds = new Set<string>();
		for (const session of recentSessions) {
			const template = this._getOrCreateSessionItem(session.id);
			retainedSessionIds.add(session.id);
			this._updateSessionItem(template, session.id, session.title, session.preview, session.previewLoading, session.status, session.updatedLabel, session.statusTone, session.id === activeSessionId);

			this._sessionListDisposables.add(addDisposableListener(template.button, EventType.CLICK, () => {
				this._agentSessionService.setActiveSession(session.id);
			}));
		}

		this._pruneSessionItems(listElement, retainedSessionIds);
		const nextOrder = recentSessions.map(session => session.id);
		this._reorderSessionItems(listElement, nextOrder);
		this._renderedSessionOrder = nextOrder;

		if (!this._areSessionOrdersEqual(previousOrder, nextOrder)) {
			this._animateSessionReorder(listElement, previousPositions, nextOrder);
		}

		this._revealActiveSessionIfNeeded(listElement, activeSessionId);
	}

	private _getOrCreateSessionItem(sessionId: string): ISessionItemTemplate {
		const existing = this._sessionItems.get(sessionId);
		if (existing) {
			return existing;
		}

		const item = $('.agent-mode-sessions__item');
		item.dataset.sessionId = sessionId;
		const button = append(item, $('button.agent-mode-sessions__button', { type: 'button' })) as HTMLButtonElement;
		const content = append(button, $('.agent-mode-sessions__item-content'));
		const header = append(content, $('.agent-mode-sessions__item-header'));
		const title = append(header, $('.agent-mode-sessions__item-title'));
		const meta = append(header, $('.agent-mode-sessions__item-meta'));
		const status = append(meta, $('.agent-mode-sessions__item-status'));
		const updated = append(meta, $('.agent-mode-sessions__item-updated'));
		const preview = append(content, $('.agent-mode-sessions__item-preview'));
		const template: ISessionItemTemplate = { item, button, title, status, preview, updated };
		this._sessionItems.set(sessionId, template);
		return template;
	}

	private _updateSessionItem(template: ISessionItemTemplate, sessionId: string, title: string, preview: string, previewLoading: boolean, status: string, updatedLabel: string, statusTone: string, active: boolean): void {
		template.item.dataset.sessionId = sessionId;
		template.item.classList.remove(...sessionToneClasses);
		template.item.classList.add(`agent-mode-sessions__item--${statusTone}`);
		template.item.classList.toggle('agent-mode-sessions__item--active', active);
		template.button.setAttribute('aria-label', localize(
			'agentModeSessionsItemAriaLabel',
			'Session {0}. {1} Status {2}. Updated {3}.',
			title,
			previewLoading ? 'Loading preview.' : `${preview}.`,
			status,
			updatedLabel
		));
		template.title.textContent = title;
		template.status.textContent = status;
		template.preview.textContent = previewLoading ? localize('agentModeSessionsPreviewLoading', 'Loading preview...') : preview;
		template.preview.classList.toggle('agent-mode-sessions__item-preview--loading', previewLoading);
		template.updated.textContent = updatedLabel;
	}

	private _pruneSessionItems(listElement: HTMLElement, retainedSessionIds: ReadonlySet<string>): void {
		for (const [sessionId, template] of this._sessionItems) {
			if (retainedSessionIds.has(sessionId)) {
				continue;
			}

			template.item.remove();
			this._sessionItems.delete(sessionId);
		}
	}

	private _reorderSessionItems(listElement: HTMLElement, orderedSessionIds: readonly string[]): void {
		for (let index = 0; index < orderedSessionIds.length; index++) {
			const sessionId = orderedSessionIds[index];
			const template = this._sessionItems.get(sessionId);
			if (!template) {
				continue;
			}

			const currentChild = listElement.children.item(index);
			if (currentChild !== template.item) {
				listElement.insertBefore(template.item, currentChild ?? null);
			}
		}
	}

	private _bindSessionListInteractions(): void {
		const listElement = this._bodyTemplate?.list;
		if (!listElement) {
			return;
		}

		const targetWindow = getWindow(listElement);
		let animationFrameHandle: number | undefined;
		let targetScrollTop = listElement.scrollTop;

		const animateWheelScroll = () => {
			const delta = targetScrollTop - listElement.scrollTop;
			if (Math.abs(delta) < 0.5) {
				listElement.scrollTop = targetScrollTop;
				animationFrameHandle = undefined;
				return;
			}

			listElement.scrollTop += delta * 0.24;
			animationFrameHandle = targetWindow.requestAnimationFrame(animateWheelScroll);
		};

		const routeWheelToList = (event: WheelEvent) => {
			if (listElement.scrollHeight <= listElement.clientHeight) {
				return;
			}

			const maxScrollTop = Math.max(0, listElement.scrollHeight - listElement.clientHeight);
			const nextScrollTop = Math.min(maxScrollTop, Math.max(0, targetScrollTop + event.deltaY));
			if (nextScrollTop !== targetScrollTop) {
				targetScrollTop = nextScrollTop;
				if (animationFrameHandle === undefined) {
					animationFrameHandle = targetWindow.requestAnimationFrame(animateWheelScroll);
				}
				event.preventDefault();
				event.stopPropagation();
			}
		};

		this._bodyDisposables.add({
			dispose: () => {
				if (animationFrameHandle !== undefined) {
					targetWindow.cancelAnimationFrame(animationFrameHandle);
					animationFrameHandle = undefined;
				}
			}
		});
		this._bodyDisposables.add(addDisposableListener(listElement, EventType.WHEEL, routeWheelToList, { capture: true }));
	}

	private _animateSessionReorder(listElement: HTMLElement, previousPositions: Map<string, DOMRect>, orderedSessionIds: readonly string[]): void {
		const targetWindow = getWindow(listElement);
		targetWindow.requestAnimationFrame(() => {
			for (const sessionId of orderedSessionIds) {
				const element = this._sessionItems.get(sessionId)?.item;
				if (!element) {
					continue;
				}

				const previousRect = previousPositions.get(sessionId);
				if (!previousRect) {
					continue;
				}

				const nextRect = element.getBoundingClientRect();
				const deltaY = previousRect.top - nextRect.top;
				if (Math.abs(deltaY) < 1) {
					continue;
				}

				element.animate([
					{ transform: `translateY(${deltaY}px)` },
					{ transform: 'translateY(0px)' }
				], {
					duration: 220,
					easing: 'cubic-bezier(0.2, 0, 0, 1)'
				});
			}
		});
	}

	private _areSessionOrdersEqual(previousOrder: readonly string[], nextOrder: readonly string[]): boolean {
		if (previousOrder.length !== nextOrder.length) {
			return false;
		}

		for (let index = 0; index < previousOrder.length; index++) {
			if (previousOrder[index] !== nextOrder[index]) {
				return false;
			}
		}

		return true;
	}

	private _revealActiveSessionIfNeeded(listElement: HTMLElement, activeSessionId: string): void {
		const activeItem = this._sessionItems.get(activeSessionId)?.item;
		if (!activeItem) {
			return;
		}

		const itemTop = activeItem.offsetTop;
		const itemBottom = itemTop + activeItem.offsetHeight;
		const visibleTop = listElement.scrollTop;
		const visibleBottom = visibleTop + listElement.clientHeight;

		if (itemTop >= visibleTop && itemBottom <= visibleBottom) {
			return;
		}

		activeItem.scrollIntoView({ block: 'nearest' });
	}
}

class AgentModeContextViewPane extends ViewPane {

	private _bodyTemplate: IContextBodyTemplate | undefined;

	constructor(
		options: IViewletViewOptions,
		@IAgentSessionService private readonly _agentSessionService: IAgentSessionService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this.element.classList.add('agent-mode-context-pane');
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		const root = append(container, $('.agent-mode-context'));
		append(root, $('.agent-mode-context__eyebrow', undefined, localize('agentModeContextEyebrow', 'Current session')));
		const title = append(root, $('.agent-mode-context__title', undefined, localize('agentModeContextTitle', 'Context')));
		const summary = append(root, $('.agent-mode-context__summary'));
		const chips = append(root, $('.agent-mode-context__chips'));
		const sections = append(root, $('.agent-mode-context__sections'));
		this._bodyTemplate = { root, title, summary, chips, sections };

		this._register(this._agentSessionService.onDidChangeActiveSession(() => this._renderSessionContext()));
		this._renderSessionContext();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this._bodyTemplate) {
			this._bodyTemplate.root.style.height = `${height}px`;
			this._bodyTemplate.root.style.width = `${width}px`;
		}
	}

	private _renderSessionContext(): void {
		const bodyTemplate = this._bodyTemplate;
		if (!bodyTemplate) {
			return;
		}

		const session = this._agentSessionService.activeSession;
		bodyTemplate.title.textContent = session.sessionLabel;
		bodyTemplate.summary.textContent = localize(
			'agentModeContextSummary',
			'{0} context sections. Use this rail for persistent execution state while the main conversation keeps moving.',
			session.sidebarSections.length
		);

		clearNode(bodyTemplate.chips);
		append(bodyTemplate.chips,
			$('.agent-mode-context__chip', undefined, localize('agentModeContextStateChip', 'State: {0}', session.stateLabel)),
			$('.agent-mode-context__chip agent-mode-context__chip--muted', undefined, localize('agentModeContextModelChip', 'Model: {0}', session.modelLabel)),
			$('.agent-mode-context__chip agent-mode-context__chip--muted', undefined, localize('agentModeContextRuntimeChip', 'Mode: {0}', session.runtimeModeLabel))
		);

		clearNode(bodyTemplate.sections);
		for (const section of session.sidebarSections) {
			const sectionKindClass = section.id === 'plan'
				? 'agent-mode-context__section--plan'
				: section.id === 'todo'
					? 'agent-mode-context__section--todo'
					: section.id === 'subagents'
						? 'agent-mode-context__section--subagents'
						: 'agent-mode-context__section--domain';

			const labelText = section.id === 'plan'
				? localize('agentModeContextLabelPlan', 'Primary')
				: section.id === 'todo'
					? localize('agentModeContextLabelTodo', 'Actionable')
					: section.id === 'subagents'
						? localize('agentModeContextLabelSubagents', 'Runtime')
						: localize('agentModeContextLabelDomain', 'Reference');

			const card = $(`.agent-mode-context__section.${sectionKindClass}`,
				$('.agent-mode-context__section-header',
					$('.agent-mode-context__section-label', undefined, labelText),
					$('.agent-mode-context__section-title', undefined, section.title)
				)
			);

			if (section.body) {
				append(card, $('.agent-mode-context__section-copy', undefined, section.body));
			}

			if (section.bullets?.length) {
				const list = $('ol.agent-mode-context__list');
				for (const bullet of section.bullets) {
					append(list, $('li', undefined, bullet));
				}
				append(card, list);
			}

			append(bodyTemplate.sections, card);
		}
	}
}

const agentModeViewContainer: ViewContainer = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry).registerViewContainer({
	id: AGENT_MODE_VIEW_CONTAINER_ID,
	title: localize2('agentModeViewContainer', 'Context'),
	icon: agentModeViewIcon,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [AGENT_MODE_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: AGENT_MODE_VIEW_CONTAINER_ID,
	hideIfEmpty: true,
	order: 0,
}, ViewContainerLocation.AuxiliaryBar, { isDefault: true, doNotRegisterOpenCommand: true });

const agentModeSessionsViewContainer: ViewContainer = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry).registerViewContainer({
	id: AGENT_MODE_SESSIONS_VIEW_CONTAINER_ID,
	title: localize2('agentModeSessionsViewContainer', 'Sessions'),
	icon: agentModeSessionsViewIcon,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [AGENT_MODE_SESSIONS_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: AGENT_MODE_SESSIONS_VIEW_CONTAINER_ID,
	hideIfEmpty: true,
	order: 0,
}, ViewContainerLocation.Sidebar, { isDefault: true, doNotRegisterOpenCommand: true });

const agentModeViewDescriptor: IViewDescriptor = {
	id: AGENT_MODE_VIEW_ID,
	containerIcon: agentModeViewContainer.icon,
	containerTitle: agentModeViewContainer.title.value,
	singleViewPaneContainerTitle: agentModeViewContainer.title.value,
	name: localize2('agentModeView', 'Context'),
	canToggleVisibility: false,
	canMoveView: false,
	ctorDescriptor: new SyncDescriptor(AgentModeContextViewPane),
	when: WorkbenchAgentModeContext,
};

const agentModeSessionsViewDescriptor: IViewDescriptor = {
	id: AGENT_MODE_SESSIONS_VIEW_ID,
	containerIcon: agentModeSessionsViewContainer.icon,
	containerTitle: agentModeSessionsViewContainer.title.value,
	singleViewPaneContainerTitle: agentModeSessionsViewContainer.title.value,
	name: localize2('agentModeSessionsView', 'Sessions'),
	canToggleVisibility: false,
	canMoveView: false,
	ctorDescriptor: new SyncDescriptor(AgentModeSessionsViewPane),
	when: WorkbenchAgentModeContext,
};

Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry).registerViews([agentModeViewDescriptor], agentModeViewContainer);
Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry).registerViews([agentModeSessionsViewDescriptor], agentModeSessionsViewContainer);
