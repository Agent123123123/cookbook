/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { homedir } from 'os';
import { timeout } from '../../../base/common/async.js';
import { Emitter } from '../../../base/common/event.js';
import { MutableDisposable, Disposable, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { join } from '../../../base/common/path.js';
import { isWindows, IProcessEnvironment } from '../../../base/common/platform.js';
import { findFreePort } from '../../../base/node/ports.js';
import { findExecutable, killTree } from '../../../base/node/processes.js';
import { ILogService } from '../../log/common/log.js';

export const enum OpenCodeProcessState {
	Stopped = 'stopped',
	Starting = 'starting',
	Running = 'running',
	Failed = 'failed'
}

export interface IOpenCodeProcessConnection {
	readonly baseUrl: string;
	readonly ownedByWindow: boolean;
}

export interface IOpenCodeProcessStartOptions {
	readonly cwd?: string;
	readonly env?: IProcessEnvironment;
	readonly command?: string;
}

export interface IOpenCodeProcessManagerOptions {
	readonly command?: string;
	readonly hostname?: string;
	readonly fallbackBaseUrl?: string;
	readonly preferredPort?: number;
	readonly healthTimeoutMs?: number;
	readonly additionalArgs?: readonly string[];
	readonly spawnFactory?: typeof spawn;
	readonly findExecutable?: typeof findExecutable;
	readonly findFreePort?: typeof findFreePort;
	readonly waitForHealth?: (baseUrl: string) => Promise<void>;
	readonly killProcessTree?: typeof killTree;
}

/**
 * Skeleton lifecycle manager for the future window-owned OpenCode subprocess.
 *
 * Today it models state transitions and exposes a stable connection contract
 * while continuing to point at the existing external backend endpoint. The
 * actual child-process spawn/restart logic will land in follow-up changes.
 */
export class OpenCodeProcessManager extends Disposable {

	private readonly _onDidChangeState = this._register(new Emitter<OpenCodeProcessState>());
	readonly onDidChangeState = this._onDidChangeState.event;

	private readonly _onDidChangeConnection = this._register(new Emitter<IOpenCodeProcessConnection | undefined>());
	readonly onDidChangeConnection = this._onDidChangeConnection.event;

	private readonly _childProcessDisposables = this._register(new MutableDisposable<DisposableStore>());

	private _state = OpenCodeProcessState.Stopped;
	private _connection: IOpenCodeProcessConnection | undefined;
	private _childProcess: ChildProcessWithoutNullStreams | undefined;
	private _startPromise: Promise<IOpenCodeProcessConnection> | undefined;
	private _lastStartKey: string | undefined;
	private _isStopping = false;

	get state(): OpenCodeProcessState {
		return this._state;
	}

	get connection(): IOpenCodeProcessConnection | undefined {
		return this._connection;
	}

	get connectionLabel(): string {
		return this._connection?.baseUrl ?? this._options.fallbackBaseUrl ?? 'OpenCode';
	}

	constructor(
		@ILogService private readonly _logService: ILogService,
		private readonly _options: IOpenCodeProcessManagerOptions = {},
	) {
		super();
	}

	async start(options?: IOpenCodeProcessStartOptions): Promise<IOpenCodeProcessConnection> {
		const startKey = options?.cwd ?? '';
		if (this._connection && this._state === OpenCodeProcessState.Running && this._lastStartKey === startKey) {
			return this._connection;
		}

		if (this._connection && this._state === OpenCodeProcessState.Running && this._lastStartKey !== startKey) {
			await this.stop();
		}

		if (this._startPromise) {
			return this._startPromise;
		}

		this._startPromise = this._doStart(options, startKey).finally(() => {
			this._startPromise = undefined;
		});

		return this._startPromise;
	}

	private async _doStart(options: IOpenCodeProcessStartOptions | undefined, startKey: string): Promise<IOpenCodeProcessConnection> {
		const env: IProcessEnvironment = {
			...process.env,
			...options?.env,
			OPENCODE_CLIENT: options?.env?.OPENCODE_CLIENT ?? process.env['OPENCODE_CLIENT'] ?? 'vscode',
		};
		const cwd = options?.cwd ?? process.cwd();
		const command = env['OPENCODE_PATH'] || options?.command || this._options.command || 'opencode';
		const resolve = this._options.findExecutable ?? findExecutable;
		let resolvedExecutable = await resolve(command, cwd, undefined, env);

		// When no explicit path was configured and the bare 'opencode' was not
		// found on PATH, try well-known install locations as a fallback.
		if (!resolvedExecutable && command === 'opencode') {
			const home = homedir();
			const fallbackPaths = isWindows
				? [join(home, '.opencode', 'bin', 'opencode.exe')]
				: [join(home, '.opencode', 'bin', 'opencode'), join(home, '.local', 'bin', 'opencode')];
			for (const candidate of fallbackPaths) {
				const found = await resolve(candidate, cwd, undefined, env);
				if (found) {
					this._logService.info(`[AgentMode] OpenCode not found in PATH; using fallback location: ${found}`);
					resolvedExecutable = found;
					break;
				}
			}
		}

		if (!resolvedExecutable) {
			if (this._options.fallbackBaseUrl) {
				this._setState(OpenCodeProcessState.Starting);
				this._logService.warn(`[AgentMode] OpenCode executable '${command}' was not found. Falling back to external backend ${this._options.fallbackBaseUrl}.`);
				const fallbackConnection: IOpenCodeProcessConnection = {
					baseUrl: this._options.fallbackBaseUrl,
					ownedByWindow: false
				};
				this._lastStartKey = startKey;
				this._connection = fallbackConnection;
				this._onDidChangeConnection.fire(fallbackConnection);
				this._setState(OpenCodeProcessState.Running);
				return fallbackConnection;
			}

			throw new Error(`OpenCode executable '${command}' was not found in PATH.`);
		}

		this._setState(OpenCodeProcessState.Starting);

		const port = await this._resolvePort();
		if (!port) {
			throw new Error('Failed to find a free port for the OpenCode backend.');
		}

		const hostname = this._options.hostname ?? '127.0.0.1';
		const args = ['serve', '--hostname', hostname, '--port', String(port), ...(this._options.additionalArgs ?? [])];
		const formatted = await formatSubprocessArguments(resolvedExecutable, args, cwd, env);

		this._logService.info(`[AgentMode] Starting managed OpenCode backend: ${resolvedExecutable} ${args.join(' ')} (cwd: ${cwd})`);

		const childProcess = (this._options.spawnFactory ?? spawn)(formatted.executable, formatted.args, {
			cwd,
			env,
			shell: formatted.shell,
			stdio: 'pipe',
		});

		this._childProcess = childProcess;
		this._lastStartKey = startKey;
		this._registerChildProcess(childProcess);

		const baseUrl = `http://${hostname}:${port}`;
		try {
			await (this._options.waitForHealth ?? (url => this._waitForHealth(url, childProcess)))(baseUrl);
		} catch (error) {
			await this._terminateChildProcess(childProcess);
			this.markCrashed(error);
			throw error;
		}

		const connection: IOpenCodeProcessConnection = {
			baseUrl,
			ownedByWindow: true
		};

		this._connection = connection;
		this._onDidChangeConnection.fire(connection);
		this._setState(OpenCodeProcessState.Running);

		return connection;
	}

	async stop(): Promise<void> {
		if (this._state === OpenCodeProcessState.Stopped && !this._connection) {
			return;
		}

		this._isStopping = true;
		this._clearConnection();

		const childProcess = this._childProcess;
		if (childProcess) {
			try {
				childProcess.kill();
			} catch (error) {
				this._logService.warn('[AgentMode] Failed to gracefully stop managed OpenCode process', error);
			}

			await Promise.race([
				new Promise<void>(resolve => childProcess.once('exit', () => resolve())),
				timeout(3000),
			]);

			if (this._childProcess === childProcess && typeof childProcess.pid === 'number') {
				await (this._options.killProcessTree ?? killTree)(childProcess.pid, true).catch(error => {
					this._logService.warn('[AgentMode] Failed to force-kill managed OpenCode process tree', error);
				});
			}
		}

		this._disposeChildProcess();
		this._setState(OpenCodeProcessState.Stopped);
		this._isStopping = false;
	}

	markCrashed(error?: unknown): void {
		this._logService.warn('[AgentMode] OpenCode process manager marked failed', error);
		this._clearConnection();
		this._disposeChildProcess();
		this._setState(OpenCodeProcessState.Failed);
	}

	private async _resolvePort(): Promise<number> {
		const preferredPort = this._options.preferredPort ?? 4096;
		return (this._options.findFreePort ?? findFreePort)(preferredPort, 20, 5000);
	}

	private _registerChildProcess(childProcess: ChildProcessWithoutNullStreams): void {
		const store = new DisposableStore();
		const onStdoutData = (chunk: string | Buffer) => {
			const text = typeof chunk === 'string' ? chunk : chunk.toString();
			for (const line of text.split(/\r?\n/)) {
				if (line.trim().length > 0) {
					this._logService.trace(`[AgentMode][OpenCode:stdout] ${line}`);
				}
			}
		};
		const onStderrData = (chunk: string | Buffer) => {
			const text = typeof chunk === 'string' ? chunk : chunk.toString();
			for (const line of text.split(/\r?\n/)) {
				if (line.trim().length > 0) {
					this._logService.warn(`[AgentMode][OpenCode:stderr] ${line}`);
				}
			}
		};
		const onError = (error: Error) => {
			if (this._childProcess !== childProcess || this._isStopping) {
				return;
			}
			this.markCrashed(error);
		};
		const onExit = (code: number | null) => {
			if (this._childProcess !== childProcess) {
				return;
			}

			this._logService.info(`[AgentMode] Managed OpenCode backend exited with code ${code ?? -1}.`);
			this._disposeChildProcess();

			if (this._isStopping) {
				this._setState(OpenCodeProcessState.Stopped);
				return;
			}

			this._clearConnection();
			this._setState(OpenCodeProcessState.Failed);
		};

		childProcess.stdout.on('data', onStdoutData);
		childProcess.stderr.on('data', onStderrData);
		childProcess.on('error', onError);
		childProcess.on('exit', onExit);

		store.add(toDisposable(() => childProcess.stdout.off('data', onStdoutData)));
		store.add(toDisposable(() => childProcess.stderr.off('data', onStderrData)));
		store.add(toDisposable(() => childProcess.off('error', onError)));
		store.add(toDisposable(() => childProcess.off('exit', onExit)));

		this._childProcessDisposables.value = store;
	}

	private _disposeChildProcess(): void {
		this._childProcessDisposables.clear();
		this._childProcess = undefined;
	}

	private async _terminateChildProcess(childProcess: ChildProcessWithoutNullStreams): Promise<void> {
		if (this._childProcess !== childProcess) {
			return;
		}

		this._isStopping = true;
		try {
			try {
				childProcess.kill();
			} catch (error) {
				this._logService.warn('[AgentMode] Failed to terminate managed OpenCode process during startup cleanup', error);
			}

			await Promise.race([
				new Promise<void>(resolve => childProcess.once('exit', () => resolve())),
				timeout(3000),
			]);

			if (this._childProcess === childProcess && typeof childProcess.pid === 'number') {
				await (this._options.killProcessTree ?? killTree)(childProcess.pid, true).catch(error => {
					this._logService.warn('[AgentMode] Failed to force-kill managed OpenCode process during startup cleanup', error);
				});
			}
		} finally {
			this._disposeChildProcess();
			this._isStopping = false;
		}
	}

	private _clearConnection(): void {
		if (!this._connection) {
			return;
		}

		this._connection = undefined;
		this._onDidChangeConnection.fire(undefined);
	}

	private async _waitForHealth(baseUrl: string, childProcess: ChildProcessWithoutNullStreams): Promise<void> {
		const deadline = Date.now() + (this._options.healthTimeoutMs ?? 30000);
		let lastError: string | undefined;

		while (Date.now() < deadline) {
			if (this._childProcess !== childProcess) {
				throw new Error('Managed OpenCode process stopped before it became healthy.');
			}

			try {
				const controller = new AbortController();
				const handle = setTimeout(() => controller.abort(), 1500);
				try {
					const response = await fetch(`${baseUrl}/global/health`, { signal: controller.signal });
					if (response.ok) {
						return;
					}
					lastError = `HTTP ${response.status}`;
				} finally {
					clearTimeout(handle);
				}
			} catch (error) {
				lastError = error instanceof Error ? error.message : String(error);
			}

			await timeout(250);
		}

		throw new Error(lastError
			? `Timed out waiting for managed OpenCode backend health: ${lastError}`
			: 'Timed out waiting for managed OpenCode backend health.');
	}

	private _setState(state: OpenCodeProcessState): void {
		if (this._state === state) {
			return;
		}

		this._state = state;
		this._onDidChangeState.fire(state);
	}
}

const windowsShellScriptRe = /\.(bat|cmd)$/i;
const windowsPowerShellScriptRe = /\.ps1$/i;

async function formatSubprocessArguments(
	executable: string,
	args: readonly string[],
	cwd: string,
	env: IProcessEnvironment,
): Promise<{ executable: string; args: string[]; shell: boolean }> {
	if (process.platform !== 'win32') {
		return { executable, args: [...args], shell: false };
	}

	const found = await findExecutable(executable, cwd, undefined, env);
	if (found && windowsShellScriptRe.test(found)) {
		const quote = (value: string) => value.includes(' ') ? `"${value}"` : value;
		return {
			executable: quote(found),
			args: args.map(quote),
			shell: true,
		};
	}

	if (found && windowsPowerShellScriptRe.test(found)) {
		return {
			executable: await resolveWindowsPowerShellExecutable(cwd, env),
			args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', found, ...args],
			shell: false,
		};
	}

	return { executable, args: [...args], shell: false };
}

async function resolveWindowsPowerShellExecutable(cwd: string, env: IProcessEnvironment): Promise<string> {
	const powerShellCore = await findExecutable('pwsh', cwd, undefined, env);
	if (powerShellCore) {
		return powerShellCore;
	}

	const windowsPowerShell = await findExecutable('powershell', cwd, undefined, env);
	if (windowsPowerShell) {
		return windowsPowerShell;
	}

	return 'powershell.exe';
}
