/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

mod ollama_client;
mod vector_store;

use anyhow::{Context, Result};
use cli::json_rpc::{self, JsonRpcSerializer};
use cli::log;
use cli::rpc;
use cli::util::errors::AnyError;
use cli::util::sync::{Barrier, Receivable};
use opentelemetry::sdk::trace::TracerProvider as SdkTracerProvider;
use opentelemetry::trace::TracerProvider;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::io;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InitializeParams {
	workspace_path: String,
	ollama_url: Option<String>,
	ollama_model: Option<String>,
	db_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IndexChunksParams {
	path: String,
	chunks: Vec<CodeChunk>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InitializeResult {
	status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchParams {
	query: String,
	limit: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodeChunk {
	path: String,
	content: String,
	start_line: u32,
	end_line: u32,
	chunk_type: String, // function, class, method, etc.
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchResult {
	chunks: Vec<CodeChunk>,
	scores: Vec<f32>,
}

struct IndexingContext {
	workspace_path: PathBuf,
	vector_store: Arc<vector_store::VectorStore>,
	ollama_client: Arc<ollama_client::OllamaClient>,
	log: log::Logger,
}

#[tokio::main]
async fn main() -> Result<()> {
	let tracer = SdkTracerProvider::builder().build().tracer("void-index-daemon");
	let logger = log::Logger::new(tracer, log::Level::Info);
	log::install_global_logger(logger.clone());

	let stdin = io::stdin();
	let stdout = io::stdout();

	let mut builder = rpc::RpcBuilder::new(JsonRpcSerializer {});
	let (msg_tx, msg_rx) = mpsc::unbounded_channel();
	let (shutdown_tx, shutdown_rx) = mpsc::channel::<()>(1);

	let context = Arc::new(tokio::sync::Mutex::new(None::<IndexingContext>));

	// Clone for RPC methods
	let context_clone = context.clone();
	let mut methods = builder.methods(());
	methods.register_async("initialize", move |params: InitializeParams, _| {
		let context = context_clone.clone();
		async move {
			let workspace_path = PathBuf::from(&params.workspace_path);
			let ollama_url = params.ollama_url.unwrap_or_else(|| "http://localhost:11434".to_string());
			let ollama_model = params.ollama_model.unwrap_or_else(|| "nomic-embed-text".to_string());
			let db_path = params.db_path.unwrap_or_else(|| {
				workspace_path
					.join(".void")
					.join("index.lance")
					.to_string_lossy()
					.to_string()
			});

			info!(logger, "Initializing index daemon");
			info!(logger, "Workspace: {}", workspace_path.display());
			info!(logger, "Ollama URL: {}", ollama_url);
			info!(logger, "DB Path: {}", db_path);

			// Create .void directory if it doesn't exist
			if let Some(parent) = Path::new(&db_path).parent() {
				std::fs::create_dir_all(parent)
					.context("Failed to create .void directory")?;
			}

			// Initialize vector store
			let vector_store = Arc::new(
				vector_store::VectorStore::new(&db_path)
					.await
					.context("Failed to create vector store")?,
			);

			// Initialize Ollama client
			let ollama_client = Arc::new(
				ollama_client::OllamaClient::new(&ollama_url, &ollama_model)
					.context("Failed to create Ollama client")?,
			);

			// Store context
			*context.lock().await = Some(IndexingContext {
				workspace_path,
				vector_store: vector_store.clone(),
				ollama_client,
				log: logger.clone(),
			});

			Ok(InitializeResult {
				status: "initialized".to_string(),
			})
		}
	});

	let context_clone = context.clone();
	methods.register_async("indexChunks", move |params: IndexChunksParams, _| {
		let context = context_clone.clone();
		async move {
			let ctx = context.lock().await;
			let ctx = ctx.as_ref().ok_or_else(|| AnyError::from("Not initialized"))?;

			// Delete old entries for this file first
			ctx.vector_store
				.delete_by_path(&params.path)
				.await
				.context("Failed to delete old entries")?;

			// Process chunks in parallel (but limit concurrency)
			let semaphore = Arc::new(tokio::sync::Semaphore::new(10));
			let mut tasks = Vec::new();

			for chunk in &params.chunks {
				let sem = semaphore.clone();
				let chunk_content = chunk.content.clone();
				let ollama = ctx.ollama_client.clone();
				let store = ctx.vector_store.clone();
				let path = params.path.clone();
				let chunk_type = chunk.chunk_type.clone();
				let start_line = chunk.start_line;
				let end_line = chunk.end_line;

				tasks.push(tokio::spawn(async move {
					let _permit = sem.acquire().await.unwrap();

					// Generate embedding
					let embedding = match ollama.embed(&chunk_content).await {
						Ok(e) => e,
						Err(e) => {
							eprintln!("Failed to generate embedding: {}", e);
							return Err(e);
						}
					};

					// Store in vector database
					store
						.insert(&path, &chunk_content, start_line, end_line, &chunk_type, &embedding)
						.await
						.map_err(|e| anyhow::anyhow!("Failed to insert chunk: {}", e))
				}));
			}

			// Wait for all chunks to be processed
			for task in tasks {
				if let Err(e) = task.await? {
					use cli::log;
					log::warning!(ctx.log, "Error processing chunk: {}", e);
				}
			}

			info!(ctx.log, "Successfully indexed {} chunks from {}", params.chunks.len(), params.path);

			Ok(serde_json::json!({ "indexed": params.chunks.len() }))
		}
	});

	let context_clone = context.clone();
	methods.register_async("search", move |params: SearchParams, _| {
		let context = context_clone.clone();
		async move {
			let ctx = context.lock().await;
			let ctx = ctx.as_ref().ok_or_else(|| AnyError::from("Not initialized"))?;

			// Generate embedding for query
			let query_embedding = ctx
				.ollama_client
				.embed(&params.query)
				.await
				.context("Failed to generate query embedding")?;

			// Search in vector store
			let limit = params.limit.unwrap_or(10);
			let results = ctx
				.vector_store
				.search(&query_embedding, limit as usize)
				.await
				.context("Failed to search vector store")?;

			// Convert results to response format
			let chunks: Vec<CodeChunk> = results
				.iter()
				.map(|r| CodeChunk {
					path: r.path.clone(),
					content: r.content.clone(),
					start_line: r.start_line,
					end_line: r.end_line,
					chunk_type: r.chunk_type.clone(),
				})
				.collect();

			let scores: Vec<f32> = results.iter().map(|r| r.score).collect();

			Ok(SearchResult { chunks, scores })
		}
	});

	let dispatcher = methods.build();
	let shutdown_barrier = Barrier::new();
	let _ = shutdown_barrier.signal(shutdown_rx);

	json_rpc::start_json_rpc(
		dispatcher,
		stdin,
		stdout,
		msg_rx,
		shutdown_barrier,
	)
	.await?;

	Ok(())
}
