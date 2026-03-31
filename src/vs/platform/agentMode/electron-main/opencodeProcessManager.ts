/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Re-export from the shared node layer so that existing electron-main consumers
// continue to work without import changes.
export {
	OpenCodeProcessState,
	OpenCodeProcessManager,
	type IOpenCodeProcessConnection,
	type IOpenCodeProcessStartOptions,
	type IOpenCodeProcessManagerOptions,
} from '../node/opencodeProcessManager.js';
