/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

use anyhow::{Context, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone)]
pub struct OllamaClient {
	client: Client,
	base_url: String,
	model: String,
}

#[derive(Debug, Serialize)]
struct EmbedRequest {
	prompt: String,
	model: String,
}

#[derive(Debug, Deserialize)]
struct EmbedResponse {
	embedding: Vec<f32>,
}

impl OllamaClient {
	pub fn new(base_url: &str, model: &str) -> Result<Self> {
		let client = Client::builder()
			.timeout(std::time::Duration::from_secs(60))
			.build()
			.context("Failed to create HTTP client")?;

		Ok(Self {
			client,
			base_url: base_url.trim_end_matches('/').to_string(),
			model: model.to_string(),
		})
	}

	pub async fn embed(&self, text: &str) -> Result<Vec<f32>> {
		let url = format!("{}/api/embeddings", self.base_url);
		let request = EmbedRequest {
			prompt: text.to_string(),
			model: self.model.clone(),
		};

		let response = self
			.client
			.post(&url)
			.json(&request)
			.send()
			.await
			.context("Failed to send embedding request to Ollama")?;

		if !response.status().is_success() {
			let status = response.status();
			let body = response.text().await.unwrap_or_default();
			return Err(anyhow::anyhow!(
				"Ollama API returned error {}: {}",
				status,
				body
			));
		}

		let embed_response: EmbedResponse = response
			.json()
			.await
			.context("Failed to parse embedding response")?;

		Ok(embed_response.embedding)
	}

	pub async fn health_check(&self) -> Result<()> {
		let url = format!("{}/api/tags", self.base_url);
		self.client
			.get(&url)
			.send()
			.await
			.context("Failed to connect to Ollama")?;
		Ok(())
	}
}
