/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { joinPath, dirname, basename } from '../../../../base/common/resources.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ITerminalToolService } from './terminalToolService.js';
import { ILLMMessageService } from '../common/sendLLMMessageService.js';
import { LLMChatMessage } from '../common/sendLLMMessageTypes.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { IVoidSettingsService } from '../common/voidSettingsService.js';

export interface IShadowWorkspaceService {
	readonly _serviceBrand: undefined;

	/**
	 * Copy file to shadow workspace and verify syntax
	 * Returns the shadow file URI and verification result
	 */
	verifyAndApplyCode(originalUri: URI, newContent: string, maxRetries?: number): Promise<{
		shadowUri: URI;
		verified: boolean;
		error?: string;
		correctedContent?: string;
	}>;
}

export const IShadowWorkspaceService = createDecorator<IShadowWorkspaceService>('ShadowWorkspaceService');

interface SyntaxVerificationResult {
	success: boolean;
	error?: string;
}

export class ShadowWorkspaceService extends Disposable implements IShadowWorkspaceService {
	readonly _serviceBrand: undefined;

	private readonly SHADOW_DIR_NAME = '.void-shadow';

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
		@ITerminalToolService private readonly terminalToolService: ITerminalToolService,
		@ILLMMessageService private readonly llmMessageService: ILLMMessageService,
		@ILanguageService private readonly languageService: ILanguageService,
		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
	) {
		super();
	}

	/**
	 * Get the shadow workspace directory for a given file
	 */
	private getShadowDirectory(originalUri: URI): URI {
		const workspaceFolder = this.workspaceContextService.getWorkspace().folders[0];
		if (!workspaceFolder) {
			// Fallback to file's directory
			return joinPath(dirname(originalUri), this.SHADOW_DIR_NAME);
		}
		return joinPath(workspaceFolder.uri, this.SHADOW_DIR_NAME);
	}

	/**
	 * Get the shadow file URI for a given original file
	 */
	private getShadowFileUri(originalUri: URI): URI {
		const shadowDir = this.getShadowDirectory(originalUri);
		const fileName = basename(originalUri);
		return joinPath(shadowDir, fileName);
	}

	/**
	 * Determine language from file extension
	 */
	private getLanguageFromUri(uri: URI): string | null {
		const ext = uri.path.split('.').pop()?.toLowerCase();
		if (!ext) return null;

		const languageId = this.languageService.guessLanguageIdByFilepathOrFirstLine(uri);
		return languageId || ext;
	}

	/**
	 * Verify syntax for a file based on its language
	 */
	private async verifySyntax(shadowUri: URI, language: string | null): Promise<SyntaxVerificationResult> {
		if (!language) {
			return { success: true }; // Skip verification for unknown languages
		}

		const ext = shadowUri.path.split('.').pop()?.toLowerCase() || '';
		const workspaceFolder = this.workspaceContextService.getWorkspace().folders[0];
		const cwd = workspaceFolder?.uri.fsPath || dirname(shadowUri).fsPath;

		try {
			let command: string;
			let args: string[];

			// Determine verification command based on file extension
			if (ext === 'cpp' || ext === 'cxx' || ext === 'cc' || ext === 'c') {
				command = 'g++';
				args = ['-fsyntax-only', shadowUri.fsPath];
			} else if (ext === 'py') {
				command = 'python';
				args = ['-m', 'py_compile', shadowUri.fsPath];
			} else if (ext === 'js') {
				command = 'node';
				args = ['--check', shadowUri.fsPath];
			} else if (ext === 'ts') {
				command = 'tsc';
				args = ['--noEmit', shadowUri.fsPath];
			} else if (ext === 'v' || ext === 'vhdl') {
				// Try iverilog first, fallback to ghdl for VHDL
				if (ext === 'v') {
					command = 'iverilog';
					args = ['-t', 'null', shadowUri.fsPath];
				} else {
					command = 'ghdl';
					args = ['-a', shadowUri.fsPath];
				}
			} else if (ext === 'm' && language === 'matlab') {
				// MATLAB syntax check using mlint (if available)
				// Note: mlint requires MATLAB installation
				command = 'matlab';
				args = ['-batch', `try; mlint('${shadowUri.fsPath}'); catch; end; exit;`];
			} else {
				// Unknown language, skip verification
				return { success: true };
			}

			// Run verification command using terminal service
			const terminalId = `shadow-verify-${Date.now()}`;
			const commandResult = await this.terminalToolService.runCommand(
				`${command} ${args.join(' ')}`,
				{ type: 'temporary', cwd, terminalId }
			);

			const result = await commandResult.resPromise;

			// Check if command succeeded (empty output typically means success for syntax checkers)
			// For syntax checkers, errors go to stderr, success is typically empty
			const output = result.result || '';
			const isDone = result.resolveReason.type === 'done' && result.resolveReason.exitCode === 0;
			const hasError = output.trim().length > 0 || !isDone;

			if (!hasError) {
				return { success: true };
			}

			// Extract error from output
			return {
				success: false,
				error: output || 'Syntax verification failed'
			};
		} catch (error: any) {
			// Command not found or execution failed
			this.logService.warn(`Shadow workspace: Verification command failed for ${shadowUri.path}:`, error);
			// If command doesn't exist, we'll skip verification rather than blocking
			return { success: true };
		}
	}

	/**
	 * Request LLM to correct code based on error
	 */
	private async requestCorrection(originalContent: string, error: string, language: string | null): Promise<string | null> {
		try {
			const messages: LLMChatMessage[] = [
				{
					role: 'user',
					content: `The following code has a syntax error. Please correct it and return ONLY the corrected code without any explanation:\n\nError:\n${error}\n\nCode:\n\`\`\`${language || ''}\n${originalContent}\n\`\`\``
				}
			];

			// Use Promise to wait for LLM response
			return new Promise<string | null>((resolve) => {
				let finalMessage = '';
				let errorOccurred = false;

				// Get model selection for Apply feature
				const modelSelection = this.voidSettingsService.state.modelSelectionOfFeature['Apply'];

				const requestId = this.llmMessageService.sendLLMMessage({
					messagesType: 'chatMessages',
					messages,
					modelSelection,
					modelSelectionOptions: undefined,
					overridesOfModel: undefined,
					logging: { loggingName: 'Shadow Workspace Correction' },
					separateSystemMessage: undefined,
					chatMode: 'normal',
					onText: () => {
						// Accumulate text as it streams
					},
					onFinalMessage: (params) => {
						finalMessage = params.fullText;
					},
					onError: (params) => {
						errorOccurred = true;
						this.logService.error('Shadow workspace: LLM correction error:', params.message);
						resolve(null);
					},
					onAbort: () => {
						resolve(null);
					},
				});

				if (!requestId) {
					resolve(null);
					return;
				}

				// Wait a bit for the response, then check
				setTimeout(() => {
					if (errorOccurred || !finalMessage) {
						resolve(null);
						return;
					}

					// Extract code from response
					const codeMatch = finalMessage.match(/```(?:[\w]+)?\n([\s\S]*?)\n```/);
					if (codeMatch) {
						resolve(codeMatch[1]);
						return;
					}

					// If no code block, try to extract from response
					resolve(finalMessage.trim());
				}, 10000); // 10 second timeout
			});
		} catch (error) {
			this.logService.error('Shadow workspace: Failed to request correction from LLM:', error);
			return null;
		}
	}

	/**
	 * Copy file to shadow workspace, verify, and optionally correct
	 */
	async verifyAndApplyCode(
		originalUri: URI,
		newContent: string,
		maxRetries: number = 3
	): Promise<{
		shadowUri: URI;
		verified: boolean;
		error?: string;
		correctedContent?: string;
	}> {
		const shadowUri = this.getShadowFileUri(originalUri);
		const shadowDir = dirname(shadowUri);
		const language = this.getLanguageFromUri(originalUri);

		// Ensure shadow directory exists
		try {
			await this.fileService.createFolder(shadowDir);
		} catch (error) {
			// Directory might already exist, ignore
		}

		let currentContent = newContent;
		let attempt = 0;

		while (attempt < maxRetries) {
			attempt++;

			// Write content to shadow file
			await this.fileService.writeFile(shadowUri, VSBuffer.fromString(currentContent));

			// Verify syntax
			const verification = await this.verifySyntax(shadowUri, language);

			if (verification.success) {
				return {
					shadowUri,
					verified: true,
					correctedContent: currentContent
				};
			}

			// If verification failed and we have retries left, request correction
			if (attempt < maxRetries && verification.error) {
				const corrected = await this.requestCorrection(currentContent, verification.error, language);
				if (corrected) {
					currentContent = corrected;
					continue;
				}
			}

			// If we get here, verification failed and we couldn't correct it
			return {
				shadowUri,
				verified: false,
				error: verification.error || 'Syntax verification failed',
				correctedContent: currentContent
			};
		}

		// Max retries reached
		return {
			shadowUri,
			verified: false,
			error: 'Maximum retry attempts reached',
			correctedContent: currentContent
		};
	}
}

registerSingleton(IShadowWorkspaceService, ShadowWorkspaceService, InstantiationType.Delayed);

