import { env } from "../config/env";
import { IntegrationRepository } from "../db/integration.repository";
import { GitHubService } from "./github.service";

let workerInterval: ReturnType<typeof setInterval> | null = null;
let isProcessing = false;

export const GitHubSyncWorker = {
  start(): void {
    if (workerInterval) return;

    const intervalMs = parseInt(env.GITHUB_SYNC_INTERVAL_MS, 10);

    workerInterval = setInterval(async () => {
      if (isProcessing) return;
      isProcessing = true;

      try {
        await this.syncAll();
      } catch (error) {
        console.error("GitHub sync worker error:", error);
      } finally {
        isProcessing = false;
      }
    }, intervalMs);

    console.log(
      `🔄 GitHub sync worker started (every ${intervalMs / 1000}s)`,
    );
  },

  async syncAll(): Promise<void> {
    const integrations = await IntegrationRepository.findByWorkspace("", "github" as any);

    const allGitHub = (
      await Promise.all(
        // findByWorkspace requires a workspace ID — we need all GitHub integrations
        // across all workspaces. Query directly.
        [this.findAllActiveGitHub()],
      )
    ).flat();

    for (const integration of allGitHub) {
      try {
        await GitHubService.syncRepository(integration);
        if (integration.status !== "active") {
          await IntegrationRepository.updateStatus(
            integration.id,
            "active",
            null,
          );
        }
      } catch (err: any) {
        console.error(
          `GitHub sync failed for ${integration.id}: ${err?.message}`,
        );
        await IntegrationRepository.updateStatus(
          integration.id,
          "error",
          `Sync failed: ${err?.message ?? "unknown"}`,
        );
      }
    }
  },

  async findAllActiveGitHub() {
    const { getSupabaseClient } = await import("../db/client");
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from("integrations")
      .select()
      .eq("type", "github")
      .in("status", ["active", "error"])
      .order("created_at", { ascending: true });

    if (error) {
      console.error("Failed to fetch GitHub integrations:", error.message);
      return [];
    }

    return (data ?? []).map((row: any) => ({
      id: row.id,
      workspace_id: row.workspace_id,
      type: row.type,
      display_name: row.display_name,
      config: row.config ?? {},
      webhook_secret: row.webhook_secret,
      status: row.status,
      last_error: row.last_error,
      created_by: row.created_by,
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
    }));
  },

  stop(): void {
    if (workerInterval) {
      clearInterval(workerInterval);
      workerInterval = null;
      console.log("GitHub sync worker stopped");
    }
  },
};
