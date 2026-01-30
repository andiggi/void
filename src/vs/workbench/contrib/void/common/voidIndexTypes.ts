/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

export interface CodeChunk {
	path: string;
	content: string;
	startLine: number;
	endLine: number;
	chunkType: string;
}

export interface SearchResult {
	chunks: CodeChunk[];
	scores: number[];
}
