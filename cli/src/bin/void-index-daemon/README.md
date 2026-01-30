# Void Index Daemon

A Rust-based background daemon for semantic code indexing in the Void VS Code fork. This daemon provides real-time codebase indexing with semantic search capabilities in an air-gapped environment.

## Features

- **File Watcher**: Uses `notify` crate to watch workspace for file changes (Create/Update/Delete)
- **Semantic Chunking**: Parses code into logical blocks (functions, classes, methods) using regex patterns (tree-sitter integration ready)
- **Local Embedding Pipeline**: Sends chunks to a local Ollama instance via HTTP for embedding generation
- **Vector Storage**: Uses LanceDB (embedded mode) to store vectors locally on disk
- **IPC Bridge**: JSON-RPC over stdin/stdout for communication with the TypeScript frontend
- **Concurrency**: Uses tokio for async task management to ensure indexing doesn't block the file watcher

## Architecture

### Components

1. **main.rs**: Entry point, sets up JSON-RPC server over stdin/stdout
2. **file_watcher.rs**: Monitors workspace for file changes using `notify`
3. **chunker.rs**: Extracts semantic chunks from code files (currently regex-based, tree-sitter ready)
4. **ollama_client.rs**: HTTP client for local Ollama instance embedding API
5. **vector_store.rs**: LanceDB integration for vector storage and search

### Data Flow

1. File change detected → `file_watcher.rs`
2. File read and chunked → `chunker.rs`
3. Chunks sent to Ollama for embedding → `ollama_client.rs`
4. Vectors stored in LanceDB → `vector_store.rs`
5. Search queries → Embed query → Vector search → Return results

## Usage

### Starting the Daemon

The daemon communicates via JSON-RPC over stdin/stdout:

```bash
./void-index-daemon
```

### RPC Methods

#### `initialize`

Initialize the daemon with workspace configuration.

**Parameters:**
```json
{
  "workspacePath": "/path/to/workspace",
  "ollamaUrl": "http://localhost:11434",  // Optional, defaults to localhost:11434
  "ollamaModel": "nomic-embed-text",      // Optional, defaults to nomic-embed-text
  "dbPath": "/path/to/.void/index.lance"  // Optional, defaults to workspace/.void/index.lance
}
```

**Response:**
```json
{
  "status": "initialized"
}
```

#### `search`

Search the codebase using semantic similarity.

**Parameters:**
```json
{
  "query": "function that processes user authentication",
  "limit": 10  // Optional, defaults to 10
}
```

**Response:**
```json
{
  "chunks": [
    {
      "path": "src/auth.rs",
      "content": "pub fn authenticate_user(...) { ... }",
      "startLine": 42,
      "endLine": 65,
      "chunkType": "function"
    }
  ],
  "scores": [0.95, 0.89, 0.82]
}
```

## Dependencies

Key dependencies (already in Cargo.toml):
- `notify`: File system watching
- `tokio`: Async runtime
- `lancedb`: Vector database
- `reqwest`: HTTP client for Ollama
- `serde`/`serde_json`: JSON serialization
- `arrow`/`arrow-array`/`arrow-schema`: Arrow format for LanceDB

## Configuration

### Ollama Setup

1. Install Ollama: https://ollama.ai
2. Pull embedding model:
   ```bash
   ollama pull nomic-embed-text
   # or
   ollama pull all-minilm
   ```
3. Ensure Ollama is running on `localhost:11434` (or configure via `initialize`)

### Supported File Types

The daemon indexes files with the following extensions:
- Rust: `.rs`
- TypeScript/JavaScript: `.ts`, `.tsx`, `.js`, `.jsx`
- Python: `.py`
- Java: `.java`
- C/C++: `.c`, `.cpp`, `.h`, `.hpp`
- Go: `.go`
- Ruby: `.rb`
- PHP: `.php`
- Swift: `.swift`
- Kotlin: `.kt`
- Scala: `.scala`
- C#: `.cs`
- Dart: `.dart`
- Lua: `.lua`
- R: `.r`
- Shell: `.sh`, `.bash`, `.zsh`, `.fish`

## Future Enhancements

1. **Tree-sitter Integration**: Replace regex-based chunking with proper AST parsing using tree-sitter grammars
2. **Incremental Indexing**: Only re-index changed chunks instead of entire files
3. **Index Optimization**: Batch insertions, compaction, and index maintenance
4. **Multi-language Support**: Language-specific parsing rules and optimizations
5. **Distance Metrics**: Expose similarity scores in search results
6. **Index Statistics**: RPC methods for index health and statistics

## Building

```bash
cd cli
cargo build --release --bin void-index-daemon
```

The binary will be in `target/release/void-index-daemon`.

## Notes

- The vector database is stored in `.void/index.lance` within the workspace by default
- File watcher excludes common build/dependency directories (`.git`, `node_modules`, `target`, `dist`, `build`)
- Chunking uses regex patterns; tree-sitter grammars can be integrated for better accuracy
- Embedding dimension defaults to 384 (nomic-embed-text) but adapts to model output size
