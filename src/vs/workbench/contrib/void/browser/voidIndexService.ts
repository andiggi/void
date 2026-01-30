/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ITreeSitterParserService, ITreeSitterImporter } from '../../../../editor/common/services/treeSitterParserService.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { Event, Emitter } from '../../../../base/common/event.js';
import type * as Parser from '@vscode/tree-sitter-wasm';
import { CodeChunk, SearchResult } from '../common/voidIndexTypes.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';


export interface IVoidIndexService {
	readonly _serviceBrand: undefined;

	/**
	 * Initialize the indexing service
	 */
	initialize(workspacePath: string, ollamaUrl?: string, ollamaModel?: string, dbPath?: string): Promise<void>;

	/**
	 * Index a file by parsing it with tree-sitter and sending chunks to the daemon
	 */
	indexFile(uri: URI): Promise<void>;

	/**
	 * Search the codebase using semantic similarity
	 */
	search(query: string, limit?: number): Promise<SearchResult>;
}

export const IVoidIndexService = createDecorator<IVoidIndexService>('VoidIndexService');

export class VoidIndexService extends Disposable implements IVoidIndexService {
	readonly _serviceBrand: undefined;

	private _initialized: boolean = false;
	private _onDidIndexFile: Emitter<URI> = this._register(new Emitter<URI>());
	public readonly onDidIndexFile: Event<URI> = this._onDidIndexFile.event;

	private readonly channel: IChannel;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
		@ITreeSitterParserService private readonly treeSitterService: ITreeSitterParserService,
		@ITreeSitterImporter private readonly treeSitterImporter: ITreeSitterImporter,
		@IModelService private readonly modelService: IModelService,
		@IMainProcessService private readonly mainProcessService: IMainProcessService,
	) {
		super();
		this.channel = this.mainProcessService.getChannel('void-channel-index');
	}

	async initialize(workspacePath: string, ollamaUrl?: string, ollamaModel?: string, dbPath?: string): Promise<void> {
		if (this._initialized) {
			return;
		}

		await this.channel.call('initialize', { workspacePath, ollamaUrl, ollamaModel, dbPath });
		this._initialized = true;
		this.logService.info('[VoidIndex] Service initialized');
	}

	async indexFile(uri: URI): Promise<void> {
		if (!this._initialized) {
			throw new Error('Index service not initialized');
		}

		try {
			// Get file content
			const fileContent = await this.fileService.readFile(uri);
			const content = fileContent.value.toString();

			// Get language ID
			const languageId = this.getLanguageId(uri);

			// Parse with tree-sitter
			const chunks = await this.parseWithTreeSitter(content, languageId, uri);

			if (chunks.length === 0) {
				this.logService.warn(`[VoidIndex] No chunks extracted from ${uri.toString()}`);
				return;
			}

			// Get relative path
			const workspaceFolder = this.workspaceContextService.getWorkspace().folders[0];
			const relativePath = workspaceFolder
				? uri.fsPath.replace(workspaceFolder.uri.fsPath, '').replace(/^[\/\\]/, '')
				: uri.path;

			// Send chunks to daemon
			await this.channel.call('indexChunks', { path: relativePath, chunks });

			this._onDidIndexFile.fire(uri);
			this.logService.info(`[VoidIndex] Indexed ${chunks.length} chunks from ${relativePath}`);
		} catch (error: any) {
			this.logService.error(`[VoidIndex] Error indexing file ${uri.toString()}:`, error);
			throw error;
		}
	}

	async search(query: string, limit: number = 10): Promise<SearchResult> {
		if (!this._initialized) {
			throw new Error('Index service not initialized');
		}

		return this.channel.call('search', { query, limit });
	}

	private getLanguageId(uri: URI): string {
		// Try to get language from model if it exists
		const model = this.modelService.getModel(uri);
		if (model) {
			return model.getLanguageId();
		}

		// Fallback to extension-based detection
		const ext = uri.path.split('.').pop()?.toLowerCase() || '';
		const languageMap: { [key: string]: string } = {
			'ts': 'typescript',
			'tsx': 'typescriptreact',
			'js': 'javascript',
			'jsx': 'javascriptreact',
			'py': 'python',
			'cpp': 'cpp',
			'cc': 'cpp',
			'cxx': 'cpp',
			'c': 'c',
			'h': 'c',
			'hpp': 'cpp',
			'm': 'objective-c', // Could be MATLAB or Objective-C
			'matlab': 'matlab',
		};

		return languageMap[ext] || ext;
	}

	private async parseWithTreeSitter(content: string, languageId: string, uri: URI): Promise<CodeChunk[]> {
		const chunks: CodeChunk[] = [];

		try {
			// Get tree-sitter tree
			const tree = this.treeSitterService.getTreeSync(content, languageId);
			if (!tree) {
				// Fallback to simple line-based chunking if tree-sitter not available
				return this.fallbackChunking(content, uri);
			}

			// Get language for queries
			const language = this.treeSitterService.getOrInitLanguage(languageId);
			if (!language) {
				return this.fallbackChunking(content, uri);
			}

			// Define queries for different languages
			const queries = this.getQueriesForLanguage(languageId);
			if (!queries) {
				return this.fallbackChunking(content, uri);
			}

			// Get Query class from tree-sitter importer
			const Query = await this.treeSitterImporter.getQueryClass();

			// Execute queries
			for (const queryStr of queries) {
				try {
					const query = new Query(language, queryStr);
					const matches = query.matches(tree.rootNode);

					for (const match of matches) {
						for (const capture of match.captures) {
							const node = capture.node;
							const startPosition = node.startPosition;
							const endPosition = node.endPosition;

							// Extract content from the node
							const nodeContent = content.substring(node.startIndex, node.endIndex);
							if (!nodeContent.trim()) {
								continue;
							}

							chunks.push({
								path: uri.fsPath,
								content: nodeContent,
								startLine: startPosition.row + 1, // Tree-sitter uses 0-based, we use 1-based
								endLine: endPosition.row + 1,
								chunkType: capture.name || 'code_block',
							});
						}
					}
				} catch (error: any) {
					this.logService.warn(`[VoidIndex] Query error for ${languageId}:`, error);
				}
			}

			// If no chunks found, fall back to simple chunking
			if (chunks.length === 0) {
				return this.fallbackChunking(content, uri);
			}

			return chunks;
		} catch (error: any) {
			this.logService.warn(`[VoidIndex] Tree-sitter parsing failed for ${languageId}, using fallback:`, error);
			return this.fallbackChunking(content, uri);
		}
	}

	private getQueriesForLanguage(languageId: string): string[] | null {
		// Tree-sitter queries to extract semantic chunks
		const queries: { [key: string]: string[] } = {
			typescript: [
				'(function_declaration name: (_) @name body: (_) @body) @function',
				'(method_definition name: (_) @name body: (_) @body) @method',
				'(class_declaration name: (_) @name body: (_) @body) @class',
				'(interface_declaration name: (_) @name body: (_) @body) @interface',
			],
			typescriptreact: [
				'(function_declaration name: (_) @name body: (_) @body) @function',
				'(method_definition name: (_) @name body: (_) @body) @method',
				'(class_declaration name: (_) @name body: (_) @body) @class',
			],
			javascript: [
				'(function_declaration name: (_) @name body: (_) @body) @function',
				'(method_definition name: (_) @name body: (_) @body) @method',
				'(class_declaration name: (_) @name body: (_) @body) @class',
			],
			python: [
				'(function_definition name: (_) @name body: (_) @body) @function',
				'(class_definition name: (_) @name body: (_) @body) @class',
			],
			cpp: [
				'(function_definition declarator: (function_declarator declarator: (_) @name) body: (_) @body) @function',
				'(class_specifier name: (_) @name body: (_) @body) @class',
			],
			c: [
				'(function_definition declarator: (function_declarator declarator: (_) @name) body: (_) @body) @function',
			],
		};

		return queries[languageId] || null;
	}

	private fallbackChunking(content: string, uri: URI): CodeChunk[] {
		// Simple fallback: chunk by functions/classes using regex
		const lines = content.split('\n');
		const chunks: CodeChunk[] = [];
		let currentChunk: { start: number; type: string; lines: string[] } | null = null;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const trimmed = line.trim();

			// Detect function/class starts
			let chunkType: string | null = null;
			if (trimmed.match(/^(pub\s+)?(async\s+)?fn\s+\w+/)) {
				chunkType = 'function'; // Rust
			} else if (trimmed.match(/^(export\s+)?(async\s+)?function\s+\w+/)) {
				chunkType = 'function'; // JavaScript/TypeScript
			} else if (trimmed.match(/^(export\s+)?class\s+\w+/)) {
				chunkType = 'class'; // JavaScript/TypeScript
			} else if (trimmed.match(/^def\s+\w+/)) {
				chunkType = 'function'; // Python
			} else if (trimmed.match(/^class\s+\w+/)) {
				chunkType = 'class'; // Python
			} else if (trimmed.match(/^\w+.*\(.*\)\s*\{/)) {
				chunkType = 'function'; // C/C++
			}

			if (chunkType) {
				// Save previous chunk
				if (currentChunk) {
					chunks.push({
						path: uri.fsPath,
						content: currentChunk.lines.join('\n'),
						startLine: currentChunk.start + 1,
						endLine: i + 1,
						chunkType: currentChunk.type,
					});
				}

				// Start new chunk
				currentChunk = {
					start: i,
					type: chunkType,
					lines: [line],
				};
			} else if (currentChunk) {
				currentChunk.lines.push(line);
			}
		}

		// Add final chunk
		if (currentChunk) {
			chunks.push({
				path: uri.fsPath,
				content: currentChunk.lines.join('\n'),
				startLine: currentChunk.start + 1,
				endLine: lines.length,
				chunkType: currentChunk.type,
			});
		}

		// If no structured chunks, create line-based chunks
		if (chunks.length === 0 && content.trim().length > 0) {
			const CHUNK_SIZE = 50;
			for (let i = 0; i < lines.length; i += CHUNK_SIZE) {
				const chunkLines = lines.slice(i, Math.min(i + CHUNK_SIZE, lines.length));
				chunks.push({
					path: uri.fsPath,
					content: chunkLines.join('\n'),
					startLine: i + 1,
					endLine: Math.min(i + CHUNK_SIZE, lines.length),
					chunkType: 'code_block',
				});
			}
		}

		return chunks;
	}
}

registerSingleton(IVoidIndexService, VoidIndexService, InstantiationType.Delayed);
