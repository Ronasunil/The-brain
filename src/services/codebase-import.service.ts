import * as fs from "fs";
import { CodebaseRepository } from "../db/codebase.repository";
import { CreateCodeChunkInput } from "../lib/types";
import { walkDirectory } from "../lib/utils/file-walker";
import { chunkFileContent } from "../lib/utils/chunker";
import { DEFAULT_WORKSPACE_ID } from "../lib/constants/app.constants";
import {
  IMPORT_BATCH_SIZE,
  CODEBASE_CHUNK_MAX_CHARS,
  CODEBASE_CHUNK_OVERLAP,
} from "../lib/constants/import.constants";

interface CodebaseImportStatus {
  status: "processing" | "completed" | "failed";
  total_files: number;
  total_chunks: number;
  total_stored: number;
  total_skipped: number;
  started_at: Date;
  completed_at: Date | null;
  error: string | null;
}

declare global {
  // eslint-disable-next-line no-var
  var __orgbrainCodebaseImportJobs:
    | Map<string, CodebaseImportStatus>
    | undefined;
}

// Track import jobs in global process state so dev HMR/recompile doesn't reset them.
const importJobs =
  globalThis.__orgbrainCodebaseImportJobs ??
  (globalThis.__orgbrainCodebaseImportJobs = new Map<
    string,
    CodebaseImportStatus
  >());

/**
 * Codebase Import Service — indexes a local directory into code_chunks.
 *
 * Flow:
 * 1. Walk the directory recursively (filtered by extension, size, excludes)
 * 2. Read each file and chunk its content with overlap
 * 3. Batch insert chunks into code_chunks (UPSERT, skip duplicates)
 * 4. Embeddings are handled separately by EmbeddingWorker
 */
export const CodebaseImportService = {
  /**
   * Start a codebase import job. Returns immediately with a job ID.
   */
  async importCodebase(
    dirPath: string,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
    repoName: string = "",
  ): Promise<string> {
    const jobId = `codebase_${Date.now()}`;

    const status: CodebaseImportStatus = {
      status: "processing",
      total_files: 0,
      total_chunks: 0,
      total_stored: 0,
      total_skipped: 0,
      started_at: new Date(),
      completed_at: null,
      error: null,
    };

    importJobs.set(jobId, status);

    // Process in background — don't await, return job ID immediately
    this.processDirectory(dirPath, workspaceId, repoName, status)
      .then(() => {
        status.status = "completed";
        status.completed_at = new Date();
        console.log(
          `✅ Codebase import ${jobId} completed: ${status.total_files} files, ${status.total_stored} chunks stored, ${status.total_skipped} skipped`,
        );
      })
      .catch((error) => {
        status.status = "failed";
        status.completed_at = new Date();
        status.error = error.message;
        console.error(`❌ Codebase import ${jobId} failed:`, error.message);
      });

    return jobId;
  },

  /**
   * Walk directory, chunk files, and batch-insert into code_chunks.
   */
  async processDirectory(
    dirPath: string,
    workspaceId: string,
    repoName: string,
    status: CodebaseImportStatus,
  ): Promise<void> {
    const files = walkDirectory(dirPath);
    status.total_files = files.length;

    console.log(`📂 Found ${files.length} indexable files in ${dirPath}`);

    let batch: CreateCodeChunkInput[] = [];

    for (const file of files) {
      let rawContent: string;
      try {
        rawContent = fs.readFileSync(file.absolutePath, "utf-8");
      } catch {
        status.total_skipped++;
        continue;
      }

      const chunks = chunkFileContent(
        file.relativePath,
        rawContent,
        CODEBASE_CHUNK_MAX_CHARS,
        CODEBASE_CHUNK_OVERLAP,
      );

      for (const chunk of chunks) {
        status.total_chunks++;

        batch.push({
          workspace_id: workspaceId,
          source_chunk_id: chunk.sourceChunkId,
          file_path: chunk.filePath,
          repo_name: repoName,
          language: file.extension,
          chunk_index: chunk.chunkIndex,
          content: chunk.content,
        });

        // Flush batch when full
        if (batch.length >= IMPORT_BATCH_SIZE) {
          try {
            const stored = await CodebaseRepository.createBatch(batch);
            status.total_stored += stored;
          } catch (error) {
            console.error("Code chunk batch insert error:", error);
          }
          batch = [];
        }
      }
    }

    // Flush remaining batch
    if (batch.length > 0) {
      try {
        const stored = await CodebaseRepository.createBatch(batch);
        status.total_stored += stored;
      } catch (error) {
        console.error("Code chunk final batch insert error:", error);
      }
    }
  },

  /**
   * Get the status of a codebase import job.
   */
  getStatus(jobId: string): CodebaseImportStatus | null {
    return importJobs.get(jobId) || null;
  },
};
