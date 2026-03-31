/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAgentModelSelection, OpenCodeBackendAPI } from '../common/agentBackendService.js';

/**
 * REST client for the OpenCode backend HTTP API.
 * Uses native `fetch` so it is usable from both electron-main and server/node layers.
 */
export class OpenCodeClient {
	constructor(private readonly _baseUrl: string) { }

	get baseUrl(): string {
		return this._baseUrl;
	}

	async health(): Promise<{ healthy: boolean; version: string }> {
		return this._fetchJson('/global/health');
	}

	async getConfig(): Promise<OpenCodeBackendAPI.Config> {
		return this._fetchJson('/config');
	}

	async getAgents(): Promise<OpenCodeBackendAPI.AgentInfo[]> {
		const response = await this._fetchJson<OpenCodeBackendAPI.AgentInfo[] | { value?: OpenCodeBackendAPI.AgentInfo[]; Count?: number }>('/agent');
		if (Array.isArray(response)) {
			return response;
		}

		return response.value ?? [];
	}

	async getProvidersConfig(): Promise<OpenCodeBackendAPI.ProvidersConfigResponse> {
		return this._fetchJson('/config/providers');
	}

	async listSessions(): Promise<OpenCodeBackendAPI.SessionInfo[]> {
		return this._fetchJson('/session?roots=true');
	}

	async createSession(): Promise<OpenCodeBackendAPI.SessionInfo> {
		return this._fetchJson('/session', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: '{}'
		});
	}

	async getSession(sessionId: string): Promise<OpenCodeBackendAPI.SessionInfo> {
		return this._fetchJson(`/session/${sessionId}`);
	}

	async getMessages(sessionId: string): Promise<OpenCodeBackendAPI.MessageWithParts[]> {
		return this._fetchJson(`/session/${sessionId}/message`);
	}

	async listPermissions(): Promise<OpenCodeBackendAPI.PermissionRequest[]> {
		return this._fetchJson('/permission');
	}

	async promptAsync(sessionId: string, prompt: string, agent?: string, model?: IAgentModelSelection): Promise<void> {
		await this._fetchJson(`/session/${sessionId}/prompt_async`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				parts: [{ type: 'text', text: prompt }],
				...(agent ? { agent } : {}),
				...(model ? { model } : {})
			})
		});
	}

	async abort(sessionId: string): Promise<void> {
		await this._fetchJson(`/session/${sessionId}/abort`, { method: 'POST' });
	}

	async replyPermission(sessionId: string, requestId: string, response: 'allow' | 'deny' | 'allowAll'): Promise<void> {
		const reply = response === 'allow'
			? 'once'
			: response === 'allowAll'
				? 'always'
				: 'reject';

		try {
			await this._fetchJson(`/permission/${requestId}/reply`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ reply })
			});
			return;
		} catch {
			await this._fetchJson(`/session/${sessionId}/permissions/${requestId}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ response })
			});
		}
	}

	private async _fetchJson<T>(path: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<T> {
		const response = await fetch(`${this._baseUrl}${path}`, {
			method: init?.method ?? 'GET',
			headers: init?.headers,
			body: init?.body,
		});

		if (!response.ok) {
			const errorBody = (await response.text()).trim();
			throw new Error(errorBody
				? `OpenCode request failed (${response.status} ${path}): ${errorBody}`
				: `OpenCode request failed (${response.status} ${path})`);
		}

		if (response.status === 204) {
			return undefined as T;
		}

		return await response.json() as T;
	}
}
