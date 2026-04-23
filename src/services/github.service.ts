import * as fs from "node:fs";
import * as path from "node:path";
import simpleGit, { SimpleGit } from "simple-git";
import { env } from "../config/env";
import { CodeChunkRepository } from "../db/code-chunk.repository";
import { IntegrationRepository } from "../db/integration.repository";
import { CodeChunker } from "./code-chunker";
import { Integration, GitHubIntegrationConfig } from "../lib/types";
import { IntegrationService } from "./integration.service";
import { AppError } from "../lib/errors/app-error";

const BATCH_SIZE = 100;

function repoDir(integrationId: string): string {
  return path.join(env.GITHUB_REPOS_DIR, integrationId);
}

function buildCloneUrl(
  repoUrl: string,
  accessToken?: string,
): string {
  if (!accessToken) return repoUrl;

  const url = new URL(repoUrl);
  url.username = "x-access-token";
  url.password = accessToken;
  return url.toString();
}

function extractRepoName(repoUrl: string): string {
  try {
    const url = new URL(repoUrl);
    return url.pathname.replace(/^\//, "").replace(/\.git$/, "");
  } catch {
    return repoUrl.replace(/\.git$/, "").split("/").slice(-2).join("/");
  }
}

export const GitHubService = {
  async cloneAndIndex(integration: Integration): Promise<number> {
    const config = integration.config as unknown as GitHubIntegrationConfig;
    const dir = repoDir(integration.id);

    fs.mkdirSync(dir, { recursive: true });

    let accessToken: string | undefined;
    if (config.access_token_ciphertext) {
      accessToken = IntegrationService.getDecryptedGitHubToken(integration);
    }

    const cloneUrl = buildCloneUrl(config.repo_url, accessToken);
    const branch = config.branch || "main";
    const repoName = extractRepoName(config.repo_url);

    const git: SimpleGit = simpleGit();

    try {
      await git.clone(cloneUrl, dir, [
        "--branch",
        branch,
        "--single-branch",
        "--depth",
        "50",
      ]);
    } catch (err: any) {
      throw new AppError(
        `Failed to clone repository: ${err?.message ?? "unknown error"}`,
        400,
      );
    }

    const chunks = CodeChunker.chunkRepository(
      dir,
      integration.workspace_id,
      integration.id,
      repoName,
    );

    let totalInserted = 0;
    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);
      const inserted = await CodeChunkRepository.createBatch(batch);
      totalInserted += inserted;
    }

    const repoGit: SimpleGit = simpleGit(dir);
    const latestCommit = await this.getLatestCommit(repoGit);

    await IntegrationRepository.updateConfig(integration.id, {
      ...config,
      last_synced_at: new Date().toISOString(),
      chunk_count: totalInserted,
      last_commit_message: latestCommit.message,
      last_commit_sha: latestCommit.sha,
    });

    console.log(
      `✅ Indexed ${totalInserted} code chunks from ${repoName} (${integration.id})`,
    );

    return totalInserted;
  },

  async syncRepository(integration: Integration): Promise<number> {
    const config = integration.config as unknown as GitHubIntegrationConfig;
    const dir = repoDir(integration.id);

    if (!fs.existsSync(path.join(dir, ".git"))) {
      await CodeChunkRepository.deleteByIntegration(integration.id);
      return this.cloneAndIndex(integration);
    }

    let accessToken: string | undefined;
    if (config.access_token_ciphertext) {
      accessToken = IntegrationService.getDecryptedGitHubToken(integration);
    }

    const repoName = extractRepoName(config.repo_url);
    const git: SimpleGit = simpleGit(dir);

    if (accessToken) {
      const remoteUrl = buildCloneUrl(config.repo_url, accessToken);
      await git.remote(["set-url", "origin", remoteUrl]);
    }

    const oldHead = await git.revparse(["HEAD"]);

    try {
      await git.pull("origin", config.branch || "main");
    } catch (err: any) {
      console.error(
        `⚠️ Git pull failed for integration ${integration.id}: ${err?.message}`,
      );
      throw new AppError(`Git pull failed: ${err?.message}`, 500);
    }

    const newHead = await git.revparse(["HEAD"]);

    if (oldHead === newHead) {
      console.log(`ℹ️ No changes in ${repoName} (${integration.id})`);
      const latestCommit = await this.getLatestCommit(git);
      await IntegrationRepository.updateConfig(integration.id, {
        ...config,
        last_synced_at: new Date().toISOString(),
        last_commit_message: latestCommit.message,
        last_commit_sha: latestCommit.sha,
      });
      return 0;
    }

    let changedFiles: string[];
    try {
      const diff = await git.diff(["--name-only", oldHead, newHead]);
      changedFiles = diff
        .split("\n")
        .map((f) => f.trim())
        .filter(Boolean);
    } catch {
      changedFiles = [];
    }

    if (changedFiles.length === 0) {
      const latestCommit2 = await this.getLatestCommit(git);
      await IntegrationRepository.updateConfig(integration.id, {
        ...config,
        last_synced_at: new Date().toISOString(),
        last_commit_message: latestCommit2.message,
        last_commit_sha: latestCommit2.sha,
      });
      return 0;
    }

    await CodeChunkRepository.deleteByFilePaths(
      integration.id,
      changedFiles,
    );

    const newChunks = CodeChunker.chunkFiles(
      dir,
      changedFiles,
      integration.workspace_id,
      integration.id,
      repoName,
    );

    let totalInserted = 0;
    for (let i = 0; i < newChunks.length; i += BATCH_SIZE) {
      const batch = newChunks.slice(i, i + BATCH_SIZE);
      const inserted = await CodeChunkRepository.createBatch(batch);
      totalInserted += inserted;
    }

    const chunkCount = await CodeChunkRepository.countByIntegration(
      integration.id,
    );
    const latestCommit = await this.getLatestCommit(git);
    await IntegrationRepository.updateConfig(integration.id, {
      ...config,
      last_synced_at: new Date().toISOString(),
      chunk_count: chunkCount,
      last_commit_message: latestCommit.message,
      last_commit_sha: latestCommit.sha,
    });

    console.log(
      `🔄 Synced ${repoName}: ${changedFiles.length} files changed, ${totalInserted} chunks updated`,
    );

    return totalInserted;
  },

  async removeRepository(integrationId: string): Promise<void> {
    await CodeChunkRepository.deleteByIntegration(integrationId);

    const dir = repoDir(integrationId);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },

  async getLatestCommit(
    git: SimpleGit,
  ): Promise<{ message: string; sha: string }> {
    try {
      const log = await git.log({ maxCount: 1 });
      const latest = log.latest;
      return {
        message: latest?.message ?? "",
        sha: latest?.hash?.slice(0, 7) ?? "",
      };
    } catch {
      return { message: "", sha: "" };
    }
  },

  async validateRepoUrl(
    repoUrl: string,
    accessToken?: string,
  ): Promise<void> {
    const cloneUrl = buildCloneUrl(repoUrl, accessToken);

    const git: SimpleGit = simpleGit();
    try {
      await git.listRemote([cloneUrl]);
    } catch (err: any) {
      throw new AppError(
        `Cannot access repository: ${err?.message ?? "unknown error"}. Check the URL and access token.`,
        400,
      );
    }
  },
};
