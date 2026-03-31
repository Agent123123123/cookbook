/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export interface IAgentModelSelection {
	readonly providerID: string;
	readonly modelID: string;
}

export namespace OpenCodeBackendAPI {
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

export const enum AgentBackendLocation {
	Local = 'local',
	Remote = 'remote',
}

export interface IAgentBackendRuntimeMetadata {
	readonly location: AgentBackendLocation;
	readonly requestedLocation: AgentBackendLocation;
	readonly remoteAuthority?: string;
	readonly ownedByCurrentWindow: boolean;
	readonly connectionLabel: string;
	readonly eventStreamAvailable: boolean;
}

export interface IAgentBackendInitializationData {
	readonly health: { healthy: boolean; version: string };
	readonly config: OpenCodeBackendAPI.Config;
	readonly providersConfig: OpenCodeBackendAPI.ProvidersConfigResponse;
	readonly agents: readonly OpenCodeBackendAPI.AgentInfo[];
	readonly runtime: IAgentBackendRuntimeMetadata;
}

export const IAgentBackendService = createDecorator<IAgentBackendService>('agentBackendService');

export interface IAgentBackendService {
	readonly _serviceBrand: undefined;
	readonly location: AgentBackendLocation;
	readonly ownedByCurrentWindow: boolean;
	readonly connectionLabel: string;
	readonly eventStreamAvailable: boolean;
	readonly onDidReceiveEvent: Event<OpenCodeBackendAPI.SSEEvent>;
	readonly onDidDisconnect: Event<void>;
	initialize(): Promise<IAgentBackendInitializationData>;
	listSessions(): Promise<OpenCodeBackendAPI.SessionInfo[]>;
	createSession(): Promise<OpenCodeBackendAPI.SessionInfo>;
	getSession(sessionId: string): Promise<OpenCodeBackendAPI.SessionInfo>;
	getMessages(sessionId: string): Promise<OpenCodeBackendAPI.MessageWithParts[]>;
	listPermissions(): Promise<OpenCodeBackendAPI.PermissionRequest[]>;
	promptAsync(sessionId: string, prompt: string, agent?: string, model?: IAgentModelSelection): Promise<void>;
	abort(sessionId: string): Promise<void>;
	replyPermission(sessionId: string, requestId: string, response: 'allow' | 'deny' | 'allowAll'): Promise<void>;
}
