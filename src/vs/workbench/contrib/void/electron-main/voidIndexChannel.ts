/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { join, dirname } from 'path';
import { IVoidIndexChannel, CodeChunk, SearchResult } from '../common/voidIndexChannel.js';
import { createChannelSender } from '../../../../base/parts/ipc/common/ipc.js';
import { IPCClient } from '../../../../base/parts/ipc/common/ipc.net.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import * as readline from 'readline';

interface JSONRPCRequest {
	jsonrpc: '2.0';
	id: number | string | null;
	method: string;
	params?: any;
}

interface JSONRPCResponse {
	jsonrpc: '2.0';
	id: number | string | null;
	result?: any;
	error?: { code: number; message: string; data?: any };
}

export class VoidIndexChannel implements IServerChannel {
	private daemonProcess: ChildProcessWithoutNullStreams | null = null;
	private requestIdCounter = 0;
	private pendingRequests = new Map<number | string, {
		resolve: (value: any) => void;
		reject: (error: any) => void;
	}>();

	constructor(
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@ILogService private readonly logService: ILogService,
	) {
		// Cleanup on exit
		process.on('exit', () => this.cleanup());
		process.on('SIGINT', () => this.cleanup());
		process.on('SIGTERM', () => this.cleanup());
	}

	async listen(_: unknown, event: string): Promise<Event<any>> {
		throw new Error(`Event "${event}" not supported`);
	}

	async call(_: unknown, command: string, params: any): Promise<any> {
		if (command === 'initialize') {
			return this.initialize(params.workspacePath, params.ollamaUrl, params.ollamaModel, params.dbPath);
		} else if (command === 'indexChunks') {
			return this.indexChunks(params.path, params.chunks);
		} else if (command === 'search') {
			return this.search(params.query, params.limit);
		} else {
			throw new Error(`Command "${command}" not recognized`);
		}
	}

	private async ensureDaemonStarted(): Promise<void> {
		if (this.daemonProcess && !this.daemonProcess.killed) {
			return;
		}

		const daemonPath = this.getDaemonPath();
		this.logService.info(`[VoidIndex] Starting daemon: ${daemonPath}`);

		// In development, use cargo run
		if (process.env['VSCODE_DEV']) {
			const cliDir = join(this.environmentService.appRoot, '..', 'cli');
			this.daemonProcess = spawn('cargo', ['run', '--release', '--bin', 'void-index-daemon'], {
				stdio: ['pipe', 'pipe', 'pipe'],
				env: { ...process.env },
				cwd: cliDir,
			});
		} else {
			this.daemonProcess = spawn(daemonPath, [], {
				stdio: ['pipe', 'pipe', 'pipe'],
				env: { ...process.env },
			});
		}

		// Setup stdout reader for JSON-RPC responses
		const rl = readline.createInterface({
			input: this.daemonProcess.stdout!,
			crlfDelay: Infinity,
		});

		rl.on('line', (line) => {
			try {
				const response: JSONRPCResponse = JSON.parse(line);
				const pending = this.pendingRequests.get(response.id);
				if (pending) {
					this.pendingRequests.delete(response.id);
					if (response.error) {
						pending.reject(new Error(response.error.message));
					} else {
						pending.resolve(response.result);
					}
				}
			} catch (error: any) {
				this.logService.warn(`[VoidIndex] Failed to parse daemon response:`, error);
			}
		});

		// Handle stderr
		this.daemonProcess.stderr!.on('data', (data) => {
			this.logService.warn(`[VoidIndex] Daemon stderr: ${data.toString()}`);
		});

		// Handle process exit
		this.daemonProcess.on('exit', (code) => {
			this.logService.warn(`[VoidIndex] Daemon exited with code ${code}`);
			this.daemonProcess = null;
			// Reject all pending requests
			for (const [id, pending] of this.pendingRequests.entries()) {
				pending.reject(new Error('Daemon process exited'));
			}
			this.pendingRequests.clear();
		});

		this.daemonProcess.on('error', (error) => {
			this.logService.error(`[VoidIndex] Daemon process error:`, error);
			this.daemonProcess = null;
		});
	}

	private async sendRequest(method: string, params?: any): Promise<any> {
		await this.ensureDaemonStarted();

		if (!this.daemonProcess) {
			throw new Error('Daemon process not available');
		}

		const id = ++this.requestIdCounter;
		const request: JSONRPCRequest = {
			jsonrpc: '2.0',
			id,
			method,
			params,
		};

		return new Promise((resolve, reject) => {
			this.pendingRequests.set(id, { resolve, reject });

			const requestStr = JSON.stringify(request) + '\n';
			this.daemonProcess!.stdin!.write(requestStr, (error) => {
				if (error) {
					this.pendingRequests.delete(id);
					reject(error);
				}
			});

			// Timeout after 60 seconds
			setTimeout(() => {
				if (this.pendingRequests.has(id)) {
					this.pendingRequests.delete(id);
					reject(new Error(`Request timeout: ${method}`));
				}
			}, 60000);
		});
	}

	private getDaemonPath(): string {
		const appRoot = this.environmentService.appRoot;
		const isWindows = process.platform === 'win32';
		const ext = isWindows ? '.exe' : '';

		// In development, daemon should be in cli/target/debug or cli/target/release
		// In production, it should be in resources/app/bin or bin
		if (process.env['VSCODE_DEV']) {
			// Development: look for binary in cli/target
			const cliPath = join(appRoot, '..', 'cli', 'target', 'debug', `void-index-daemon${ext}`);
			return cliPath;
		} else {
			// Production: use compiled binary in bin directory
			return join(appRoot, 'bin', `void-index-daemon${ext}`);
		}
	}

	async initialize(workspacePath: string, ollamaUrl?: string, ollamaModel?: string, dbPath?: string): Promise<void> {
		await this.sendRequest('initialize', {
			workspacePath,
			ollamaUrl,
			ollamaModel,
			dbPath,
		});
	}

	async indexChunks(path: string, chunks: CodeChunk[]): Promise<{ indexed: number }> {
		return this.sendRequest('indexChunks', {
			path,
			chunks: chunks.map(chunk => ({
				path: chunk.path,
				content: chunk.content,
				startLine: chunk.startLine,
				endLine: chunk.endLine,
				chunkType: chunk.chunkType,
			})),
		});
	}

	async search(query: string, limit: number = 10): Promise<SearchResult> {
		return this.sendRequest('search', { query, limit });
	}

	private cleanup(): void {
		if (this.daemonProcess && !this.daemonProcess.killed) {
			this.daemonProcess.kill();
			this.daemonProcess = null;
		}
	}
}
