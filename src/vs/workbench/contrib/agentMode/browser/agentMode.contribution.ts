/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IsDevelopmentContext } from '../../../../platform/contextkey/common/contextkeys.js';
import { createDecorator, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { WorkbenchAgentModeContext, WorkbenchModeContext } from '../../../common/contextkeys.js';
import { IPaneCompositePartService } from '../../../services/panecomposite/browser/panecomposite.js';
import { ViewContainerLocation } from '../../../common/views.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ChatContextKeys } from '../../chat/common/actions/chatContextKeys.js';
import { IAgentSessionService } from './agentSessionService.js';
import { AGENT_MODE_SESSIONS_VIEW_CONTAINER_ID, AGENT_MODE_VIEW_CONTAINER_ID } from './agentModeView.contribution.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';

const WORKBENCH_MODE_STORAGE_KEY = 'workbench.mode';
const WORKBENCH_MODE_TITLEBAR_MENU = new MenuId('WorkbenchModeTitleBarMenu');

export type WorkbenchMode = 'editor' | 'agent';

interface ILayoutSnapshot {
	readonly activityBarVisible: boolean;
	readonly sideBarVisible: boolean;
	readonly auxiliaryBarVisible: boolean;
	readonly panelVisible: boolean;
	readonly editorVisible: boolean;
	readonly auxiliaryBarMaximized: boolean;
	readonly sideBarWidth: number;
	readonly auxiliaryBarWidth: number;
	readonly panelHeight: number;
	readonly activeSideBarId: string | undefined;
	readonly activeAuxiliaryBarId: string | undefined;
	readonly activePanelId: string | undefined;
}

export interface IWorkbenchModeService {
	readonly _serviceBrand: undefined;
	readonly mode: WorkbenchMode;
	readonly onDidChangeMode: Event<WorkbenchMode>;
	setMode(mode: WorkbenchMode): void;
}

export const IWorkbenchModeService = createDecorator<IWorkbenchModeService>('workbenchModeService');

export function getInitialWorkbenchMode(storedMode: WorkbenchMode, args?: { 'agent-mode'?: boolean }): WorkbenchMode {
	return args?.['agent-mode'] ? 'agent' : storedMode;
}

class WorkbenchModeService extends Disposable implements IWorkbenchModeService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeMode = this._register(new Emitter<WorkbenchMode>());
	readonly onDidChangeMode = this._onDidChangeMode.event;

	private readonly _modeContext;
	private readonly _agentModeContext;
	private _mode: WorkbenchMode;

	get mode(): WorkbenchMode {
		return this._mode;
	}

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
	) {
		super();

		this._mode = getInitialWorkbenchMode(this._readStoredMode(), (environmentService as { args?: { 'agent-mode'?: boolean } }).args);
		this._modeContext = WorkbenchModeContext.bindTo(contextKeyService);
		this._agentModeContext = WorkbenchAgentModeContext.bindTo(contextKeyService);
		this._updateContexts();
	}

	setMode(mode: WorkbenchMode): void {
		if (this._mode === mode) {
			return;
		}

		this._mode = mode;
		this._updateContexts();
		this._storageService.store(WORKBENCH_MODE_STORAGE_KEY, mode, StorageScope.PROFILE, StorageTarget.USER);
		this._onDidChangeMode.fire(mode);
	}

	private _updateContexts(): void {
		this._modeContext.set(this._mode);
		this._agentModeContext.set(this._mode === 'agent');
	}

	private _readStoredMode(): WorkbenchMode {
		const value = this._storageService.get(WORKBENCH_MODE_STORAGE_KEY, StorageScope.PROFILE);
		return value === 'agent' ? 'agent' : 'editor';
	}
}

registerSingleton(IWorkbenchModeService, WorkbenchModeService, InstantiationType.Delayed);

class OpenEditorModeAction extends Action2 {
	static readonly ID = 'workbench.action.openEditorMode';

	constructor() {
		super({
			id: OpenEditorModeAction.ID,
			title: localize2('openEditorMode', 'Editor Mode'),
			icon: Codicon.layoutSidebarLeft,
			f1: true,
			toggled: ContextKeyExpr.equals(WorkbenchModeContext.key, 'editor'),
			menu: [{
				id: MenuId.LayoutControlMenuSubmenu,
				group: '0_workbench_mode',
				order: 0,
			}]
		});
	}

	run(accessor: ServicesAccessor): void {
		accessor.get(IWorkbenchModeService).setMode('editor');
	}
}

class OpenAgentModeAction extends Action2 {
	static readonly ID = 'workbench.action.openAgentMode';

	constructor() {
		super({
			id: OpenAgentModeAction.ID,
			title: localize2('openAgentMode', 'Agent Mode'),
			icon: Codicon.agent,
			f1: true,
			toggled: ContextKeyExpr.equals(WorkbenchModeContext.key, 'agent'),
			menu: [{
				id: MenuId.LayoutControlMenuSubmenu,
				group: '0_workbench_mode',
				order: 1,
			}]
		});
	}

	run(accessor: ServicesAccessor): void {
		accessor.get(IWorkbenchModeService).setMode('agent');
	}
}

registerAction2(OpenEditorModeAction);
registerAction2(OpenAgentModeAction);
registerAction2(class SeedAgentModeApprovalFixtureAction extends Action2 {
	static readonly ID = 'workbench.action.agentMode.seedApprovalFixture';

	constructor() {
		super({
			id: SeedAgentModeApprovalFixtureAction.ID,
			title: localize2('seedAgentModeApprovalFixture', 'Seed Agent Mode Approval Fixture'),
			category: Categories.Developer,
			icon: Codicon.beaker,
			f1: true,
			precondition: ContextKeyExpr.and(IsDevelopmentContext, ChatContextKeys.enabled)
		});
	}

	run(accessor: ServicesAccessor): void {
		accessor.get(IWorkbenchModeService).setMode('agent');
		accessor.get(IAgentSessionService).seedDeveloperFixture('approvalReview');
	}
});

MenuRegistry.appendMenuItem(MenuId.TitleBar, {
	submenu: WORKBENCH_MODE_TITLEBAR_MENU,
	title: localize2('workbenchModeTitleBar', 'Mode'),
	group: 'navigation',
	icon: Codicon.layout,
	order: 0
});

MenuRegistry.appendMenuItem(WORKBENCH_MODE_TITLEBAR_MENU, {
	command: {
		id: OpenEditorModeAction.ID,
		title: localize2('editorModeMenu', 'Editor Mode'),
		icon: Codicon.layoutSidebarLeft,
		toggled: ContextKeyExpr.equals(WorkbenchModeContext.key, 'editor')
	},
	group: 'mode',
	order: 0
});

MenuRegistry.appendMenuItem(WORKBENCH_MODE_TITLEBAR_MENU, {
	command: {
		id: OpenAgentModeAction.ID,
		title: localize2('agentModeMenu', 'Agent Mode'),
		icon: Codicon.agent,
		toggled: ContextKeyExpr.equals(WorkbenchModeContext.key, 'agent')
	},
	group: 'mode',
	order: 1
});

class WorkbenchModeContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.agentMode';

	private _editorLayoutSnapshot: ILayoutSnapshot | undefined;

	constructor(
		@IWorkbenchModeService private readonly _workbenchModeService: IWorkbenchModeService,
		@IWorkbenchLayoutService private readonly _layoutService: IWorkbenchLayoutService,
		@IPaneCompositePartService private readonly _paneCompositePartService: IPaneCompositePartService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		if (this._workbenchModeService.mode === 'agent') {
			this._editorLayoutSnapshot = this._captureCurrentLayout();
			void this._applyAgentMode();
		}

		this._register(this._workbenchModeService.onDidChangeMode(mode => {
			void this._handleModeChange(mode);
		}));
	}

	private async _handleModeChange(mode: WorkbenchMode): Promise<void> {
		if (mode === 'agent') {
			this._editorLayoutSnapshot = this._captureCurrentLayout();
			await this._applyAgentMode();
			return;
		}

		this._restoreEditorMode(this._editorLayoutSnapshot);
	}

	private _captureCurrentLayout(): ILayoutSnapshot {
		return {
			activityBarVisible: this._layoutService.isVisible(Parts.ACTIVITYBAR_PART),
			sideBarVisible: this._layoutService.isVisible(Parts.SIDEBAR_PART),
			auxiliaryBarVisible: this._layoutService.isVisible(Parts.AUXILIARYBAR_PART),
			panelVisible: this._layoutService.isVisible(Parts.PANEL_PART),
			editorVisible: this._layoutService.isVisible(Parts.EDITOR_PART, mainWindow),
			auxiliaryBarMaximized: this._layoutService.isAuxiliaryBarMaximized(),
			sideBarWidth: this._layoutService.getSize(Parts.SIDEBAR_PART).width,
			auxiliaryBarWidth: this._layoutService.getSize(Parts.AUXILIARYBAR_PART).width,
			panelHeight: this._layoutService.getSize(Parts.PANEL_PART).height,
			activeSideBarId: this._paneCompositePartService.getActivePaneComposite(ViewContainerLocation.Sidebar)?.getId(),
			activeAuxiliaryBarId: this._paneCompositePartService.getActivePaneComposite(ViewContainerLocation.AuxiliaryBar)?.getId(),
			activePanelId: this._paneCompositePartService.getActivePaneComposite(ViewContainerLocation.Panel)?.getId(),
		};
	}

	private async _applyAgentMode(): Promise<void> {
		this._layoutService.setPartHidden(true, Parts.ACTIVITYBAR_PART);
		this._layoutService.setPartHidden(false, Parts.SIDEBAR_PART);
		this._layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
		this._layoutService.setPartHidden(true, Parts.PANEL_PART);
		this._layoutService.setPartHidden(false, Parts.EDITOR_PART);

		const sideBarSize = this._layoutService.getSize(Parts.SIDEBAR_PART);
		this._layoutService.setSize(Parts.SIDEBAR_PART, { width: Math.max(sideBarSize.width, 260), height: sideBarSize.height });
		const auxiliaryBarSize = this._layoutService.getSize(Parts.AUXILIARYBAR_PART);
		this._layoutService.setSize(Parts.AUXILIARYBAR_PART, { width: Math.max(auxiliaryBarSize.width, 320), height: auxiliaryBarSize.height });
		this._layoutService.setAuxiliaryBarMaximized(false);

		await this._paneCompositePartService.openPaneComposite(AGENT_MODE_SESSIONS_VIEW_CONTAINER_ID, ViewContainerLocation.Sidebar, false);
		await this._paneCompositePartService.openPaneComposite(AGENT_MODE_VIEW_CONTAINER_ID, ViewContainerLocation.AuxiliaryBar, false);
		this._layoutService.focusPart(Parts.EDITOR_PART, mainWindow);

		this._logService.info('[WorkbenchMode] Applied Agent Mode layout');
	}

	private _restoreEditorMode(snapshot: ILayoutSnapshot | undefined): void {
		if (!snapshot) {
			this._layoutService.setPartHidden(false, Parts.ACTIVITYBAR_PART);
			this._layoutService.setPartHidden(false, Parts.SIDEBAR_PART);
			this._layoutService.setPartHidden(true, Parts.AUXILIARYBAR_PART);
			this._layoutService.setPartHidden(true, Parts.PANEL_PART);
			this._layoutService.focusPart(Parts.EDITOR_PART, mainWindow);
			this._logService.info('[WorkbenchMode] Restored default Editor Mode layout');
			return;
		}

		this._layoutService.setPartHidden(!snapshot.activityBarVisible, Parts.ACTIVITYBAR_PART);
		this._layoutService.setPartHidden(!snapshot.sideBarVisible, Parts.SIDEBAR_PART);
		this._layoutService.setPartHidden(!snapshot.auxiliaryBarVisible, Parts.AUXILIARYBAR_PART);
		this._layoutService.setPartHidden(!snapshot.panelVisible, Parts.PANEL_PART);
		this._layoutService.setPartHidden(!snapshot.editorVisible, Parts.EDITOR_PART);
		this._layoutService.setAuxiliaryBarMaximized(snapshot.auxiliaryBarMaximized);

		this._layoutService.setSize(Parts.SIDEBAR_PART, { width: snapshot.sideBarWidth, height: this._layoutService.getSize(Parts.SIDEBAR_PART).height });
		this._layoutService.setSize(Parts.AUXILIARYBAR_PART, { width: snapshot.auxiliaryBarWidth, height: this._layoutService.getSize(Parts.AUXILIARYBAR_PART).height });
		this._layoutService.setSize(Parts.PANEL_PART, { width: this._layoutService.getSize(Parts.PANEL_PART).width, height: snapshot.panelHeight });

		if (snapshot.activeSideBarId) {
			void this._paneCompositePartService.openPaneComposite(snapshot.activeSideBarId, ViewContainerLocation.Sidebar, false);
		}
		if (snapshot.activeAuxiliaryBarId) {
			void this._paneCompositePartService.openPaneComposite(snapshot.activeAuxiliaryBarId, ViewContainerLocation.AuxiliaryBar, false);
		}
		if (snapshot.activePanelId) {
			void this._paneCompositePartService.openPaneComposite(snapshot.activePanelId, ViewContainerLocation.Panel, false);
		}

		this._layoutService.focusPart(Parts.EDITOR_PART, mainWindow);
		this._logService.info('[WorkbenchMode] Restored Editor Mode layout snapshot');
	}
}

registerWorkbenchContribution2(WorkbenchModeContribution.ID, WorkbenchModeContribution, WorkbenchPhase.AfterRestored);
