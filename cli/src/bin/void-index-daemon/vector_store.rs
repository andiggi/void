/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

use anyhow::{Context, Result};
use arrow_array::{FixedSizeListArray, Float32Array, RecordBatch, RecordBatchIterator, StringArray, UInt32Array};
use arrow::datatypes::Float32Type;
use arrow_schema::{DataType, Field, Schema};
use futures::TryStreamExt;
use lancedb::connection::Connection;
use lancedb::Database;
use std::sync::Arc;

#[derive(Debug, Clone)]
pub struct SearchResult {
	pub path: String,
	pub content: String,
	pub start_line: u32,
	pub end_line: u32,
	pub chunk_type: String,
	pub score: f32,
}

pub struct VectorStore {
	db: Arc<Connection>,
	table_name: String,
}

impl VectorStore {
	pub async fn new(db_path: &str) -> Result<Self> {
		// Open or create database
		let db = Database::connect(db_path)
			.await
			.context("Failed to connect to LanceDB")?;

		let table_name = "code_chunks";

		// Check if table exists, if not create it
		match db.open_table(table_name).await {
			Ok(_) => {
				// Table exists
			}
			Err(_) => {
				// Create table with schema - will be created on first insert
				// LanceDB will infer schema from the first batch
			}
		}

		Ok(Self {
			db: Arc::new(db),
			table_name: table_name.to_string(),
		})
	}

	pub async fn insert(
		&self,
		path: &str,
		content: &str,
		start_line: u32,
		end_line: u32,
		chunk_type: &str,
		embedding: &[f32],
	) -> Result<()> {
		use uuid::Uuid;

		let id = Uuid::new_v4().to_string();

		// Define schema (vector dimension from embedding length)
		let schema = Arc::new(Schema::new(vec![
			Field::new("id", DataType::Utf8, false),
			Field::new("path", DataType::Utf8, false),
			Field::new("content", DataType::Utf8, false),
			Field::new("start_line", DataType::UInt32, false),
			Field::new("end_line", DataType::UInt32, false),
			Field::new("chunk_type", DataType::Utf8, false),
			Field::new(
				"vector",
				DataType::FixedSizeList(
					Arc::new(Field::new("item", DataType::Float32, true)),
					embedding.len(),
				),
				false,
			),
		]));

		let ids = StringArray::from(vec![id.clone()]);
		let paths = StringArray::from(vec![path]);
		let contents = StringArray::from(vec![content]);
		let start_lines = UInt32Array::from(vec![start_line]);
		let end_lines = UInt32Array::from(vec![end_line]);
		let chunk_types = StringArray::from(vec![chunk_type]);

		// Create vector array using FixedSizeListArray::from_iter_primitive
		let vector_values: Vec<Option<f32>> = embedding.iter().map(|&v| Some(v)).collect();
		let vector_array = FixedSizeListArray::from_iter_primitive::<Float32Type, _, _>(
			std::iter::once(Some(vector_values)),
			embedding.len(),
		);

		let batch = RecordBatch::try_new(
			schema.clone(),
			vec![
				Arc::new(ids),
				Arc::new(paths),
				Arc::new(contents),
				Arc::new(start_lines),
				Arc::new(end_lines),
				Arc::new(chunk_types),
				Arc::new(vector_array),
			],
		)
		.context("Failed to create record batch")?;

		// Check if table exists, if not create it
		match self.db.open_table(&self.table_name).await {
			Ok(table) => {
				// Table exists, add to it
				let batches = RecordBatchIterator::new(
					vec![batch],
					schema.clone(),
				);
				table
					.add(batches)
					.execute()
					.await
					.context("Failed to insert into table")?;
			}
			Err(_) => {
				// Create table with first batch
				let batches = RecordBatchIterator::new(
					vec![batch],
					schema.clone(),
				);
				self.db
					.create_table(&self.table_name, batches, None)
					.await
					.context("Failed to create table")?;
			}
		}

		Ok(())
	}

	pub async fn search(&self, query_embedding: &[f32], limit: usize) -> Result<Vec<SearchResult>> {
		use arrow_array::Array;

		let table = self
			.db
			.open_table(&self.table_name)
			.await
			.context("Failed to open table")?;

		// Perform vector search using nearest_to
		let query_vec: Vec<f32> = query_embedding.to_vec();
		let results = table
			.query()
			.nearest_to(&query_vec)
			.context("Failed to create query")?
			.limit(limit)
			.execute()
			.await
			.context("Failed to execute search")?;

		let batches: Vec<RecordBatch> = results
			.try_collect()
			.await
			.context("Failed to collect search results")?;

		let mut search_results = Vec::new();

		// Process results
		for batch in batches {
			let path_col = batch
				.column_by_name("path")
				.context("Path column not found")?;
			let content_col = batch
				.column_by_name("content")
				.context("Content column not found")?;
			let start_line_col = batch
				.column_by_name("start_line")
				.context("Start line column not found")?;
			let end_line_col = batch
				.column_by_name("end_line")
				.context("End line column not found")?;
			let chunk_type_col = batch
				.column_by_name("chunk_type")
				.context("Chunk type column not found")?;

			let path_array = path_col.as_any().downcast_ref::<StringArray>().unwrap();
			let content_array = content_col.as_any().downcast_ref::<StringArray>().unwrap();
			let start_line_array = start_line_col.as_any().downcast_ref::<UInt32Array>().unwrap();
			let end_line_array = end_line_col.as_any().downcast_ref::<UInt32Array>().unwrap();
			let chunk_type_array = chunk_type_col
				.as_any()
				.downcast_ref::<StringArray>()
				.unwrap();

			for i in 0..batch.num_rows() {
				search_results.push(SearchResult {
					path: path_array.value(i).to_string(),
					content: content_array.value(i).to_string(),
					start_line: start_line_array.value(i),
					end_line: end_line_array.value(i),
					chunk_type: chunk_type_array.value(i).to_string(),
					score: 0.0, // Distance/score would be available if distance column is selected
				});
			}
		}

		Ok(search_results)
	}

	pub async fn delete_by_path(&self, path: &str) -> Result<()> {
		let table = self
			.db
			.open_table(&self.table_name)
			.await
			.context("Failed to open table")?;

		// Delete rows where path matches
		// Note: LanceDB API for deletion may vary - this is a placeholder
		// In practice, you'd use a delete operation with a filter
		table
			.delete(format!("path = '{}'", path.replace('\'', "''")))
			.await
			.context("Failed to delete from table")?;

		Ok(())
	}
}
