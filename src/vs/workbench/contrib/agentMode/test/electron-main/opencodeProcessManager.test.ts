/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { OpenCodeProcessManager, OpenCodeProcessState } from '../../../agentMode/electron-main/opencodeProcessManager.js';

class TestChildProcess extends EventEmitter {
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly pid = 4242;
	killCount = 0;

	kill(): boolean {
		this.killCount++;
		this.emit('exit', 0);
		return true;
	}
}

suite('OpenCodeProcessManager', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('start transitions into running with a fallback connection label', async () => {
		const store = new DisposableStore();
		try {
			const manager = new OpenCodeProcessManager(new NullLogService(), { fallbackBaseUrl: 'http://127.0.0.1:4096' });
			store.add(manager);
			const states: OpenCodeProcessState[] = [];
			store.add(manager.onDidChangeState(state => states.push(state)));

			const connection = await manager.start();

			assert.deepStrictEqual(connection, {
				baseUrl: 'http://127.0.0.1:4096',
				ownedByWindow: false
			});
			assert.deepStrictEqual(manager.state, OpenCodeProcessState.Running);
			assert.deepStrictEqual(manager.connectionLabel, 'http://127.0.0.1:4096');
			assert.deepStrictEqual(states, [OpenCodeProcessState.Starting, OpenCodeProcessState.Running]);
		} finally {
			store.dispose();
		}
	});

	test('repeated start reuses the active connection', async () => {
		const store = new DisposableStore();
		try {
			const manager = new OpenCodeProcessManager(new NullLogService(), { fallbackBaseUrl: 'http://127.0.0.1:4096' });
			store.add(manager);

			const first = await manager.start();
			const second = await manager.start();

			assert.strictEqual(first, second);
			assert.deepStrictEqual(manager.state, OpenCodeProcessState.Running);
		} finally {
			store.dispose();
		}
	});

	test('start spawns a managed process and waits for health', async () => {
		const store = new DisposableStore();
		try {
			const child = new TestChildProcess();
			let capturedCommand: string | undefined;
			let capturedArgs: string[] | undefined;
			let capturedCwd: string | undefined;
			const manager = new OpenCodeProcessManager(new NullLogService(), {
				command: 'opencode',
				findExecutable: async () => 'opencode',
				findFreePort: async () => 4411,
				spawnFactory: ((command, args, options) => {
					capturedCommand = command;
					capturedArgs = [...(args ?? [])];
					capturedCwd = typeof options?.cwd === 'string' ? options.cwd : undefined;
					queueMicrotask(() => child.emit('spawn'));
					return child as unknown as ReturnType<typeof import('child_process').spawn>;
				}) as typeof import('child_process').spawn,
				waitForHealth: async (baseUrl) => {
					assert.strictEqual(baseUrl, 'http://127.0.0.1:4411');
				},
			});
			store.add(manager);

			const connection = await manager.start({ cwd: 'C:/workspace' });

			assert.strictEqual(capturedCommand, 'opencode');
			assert.deepStrictEqual(capturedArgs, ['serve', '--hostname', '127.0.0.1', '--port', '4411']);
			assert.strictEqual(capturedCwd, 'C:/workspace');
			assert.deepStrictEqual(connection, {
				baseUrl: 'http://127.0.0.1:4411',
				ownedByWindow: true,
			});
			assert.deepStrictEqual(manager.state, OpenCodeProcessState.Running);
		} finally {
			store.dispose();
		}
	});

	test('mark crashed clears connection and enters failed state', async () => {
		const store = new DisposableStore();
		try {
			const manager = new OpenCodeProcessManager(new NullLogService(), { fallbackBaseUrl: 'http://127.0.0.1:4096' });
			store.add(manager);
			await manager.start();

			manager.markCrashed(new Error('boom'));

			assert.deepStrictEqual(manager.state, OpenCodeProcessState.Failed);
			assert.strictEqual(manager.connection, undefined);
			assert.deepStrictEqual(manager.connectionLabel, 'http://127.0.0.1:4096');
		} finally {
			store.dispose();
		}
	});

	test('stop clears connection and returns to stopped', async () => {
		const store = new DisposableStore();
		try {
			const manager = new OpenCodeProcessManager(new NullLogService(), { fallbackBaseUrl: 'http://127.0.0.1:4096' });
			store.add(manager);
			await manager.start();

			await manager.stop();

			assert.deepStrictEqual(manager.state, OpenCodeProcessState.Stopped);
			assert.strictEqual(manager.connection, undefined);
		} finally {
			store.dispose();
		}
	});
});
