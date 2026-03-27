import { Router, Request, Response } from "express";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { withErrorHandler } from "../lib/errors";
import { AppError } from "../lib/errors/app-error";
import { ImportService } from "../services/import.service";
import { CodebaseImportService } from "../services/codebase-import.service";
import { DEFAULT_WORKSPACE_ID } from "../lib/constants/app.constants";

const router = Router();

/**
 * POST /api/import/telegram
 * Import a Telegram Desktop export JSON file.
 *
 * Body:
 * {
 *   "file_path": "/absolute/path/to/result.json",
 *   "chat_id": "996657124",
 *   "chat_name": "Infra Team"
 *   "workspace_id": "default" (optional)
 * }
 *
 * Returns a job ID to track progress.
 */
router.post(
  "/telegram",
  withErrorHandler(async (req: Request, res: Response) => {
    const { file_path, chat_id, chat_name, workspace_id } = req.body;

    if (!file_path || !chat_id || !chat_name) {
      throw new AppError("file_path, chat_id, and chat_name are required", 400);
    }

    // Check file exists
    const fs = await import("fs");
    if (!fs.existsSync(file_path)) {
      throw new AppError(`File not found: ${file_path}`, 400);
    }

    // Start import (returns immediately with job ID)
    const jobId = await ImportService.importTelegramExport(
      file_path,
      chat_id,
      chat_name,
      workspace_id || DEFAULT_WORKSPACE_ID,
    );

    res.status(202).json({
      status: 202,
      data: { job_id: jobId },
      message:
        "Import started. Use GET /api/import/status/:jobId to track progress.",
    });
  }),
);

/**
 * POST /api/import/codebase
 * Import a local codebase directory for indexing.
 *
 * Body:
 * {
 *   "file_path": "/absolute/path/to/project",
 *   "workspace_id": "default" (optional),
 *   "repo_name": "my-app" (optional)
 * }
 *
 * Returns a job ID to track progress.
 */
router.post(
  "/codebase",
  withErrorHandler(async (req: Request, res: Response) => {
    const { file_path, workspace_id, repo_name } = req.body;

    if (!file_path) {
      throw new AppError("file_path is required", 400);
    }

    // Check directory exists
    const fs = await import("fs");
    if (!fs.existsSync(file_path)) {
      throw new AppError(`Directory not found: ${file_path}`, 400);
    }

    const stat = fs.statSync(file_path);
    if (!stat.isDirectory()) {
      throw new AppError(`Path is not a directory: ${file_path}`, 400);
    }

    const jobId = await CodebaseImportService.importCodebase(
      file_path,
      workspace_id || DEFAULT_WORKSPACE_ID,
      repo_name || "",
    );

    res.status(202).json({
      status: 202,
      data: { job_id: jobId },
      message:
        "Codebase import started. Use GET /api/import/status/:jobId to track progress.",
    });
  }),
);

/**
 * GET /api/import/status/:jobId
 * Check the status of an import job (telegram or codebase).
 */
router.get(
  "/status/:jobId",
  withErrorHandler(async (req: Request, res: Response) => {
    const jobId = req.params.jobId as string;

    // Check both import services
    const status =
      ImportService.getStatus(jobId) ||
      CodebaseImportService.getStatus(jobId);

    if (!status) {
      throw new AppError("Import job not found", 404);
    }

    res.json({
      status: 200,
      data: status,
      message: `Import ${status.status}`,
    });
  }),
);

/**
 * GET /api/import/codebase-ui
 * Minimal browser UI for starting a codebase indexing job.
 *
 * Note: This UI does NOT upload files. The backend indexes a server-local
 * absolute directory path provided by the user.
 */
router.get(
  "/codebase-ui",
  withErrorHandler(async (_req: Request, res: Response) => {
    res.type("html").send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>OrgBrain - Codebase Import</title>
    <style>
      body {
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial;
        margin: 24px;
      }
      .card {
        max-width: 820px;
        border: 1px solid #ddd;
        border-radius: 12px;
        padding: 16px;
      }
      label {
        display: block;
        margin-top: 10px;
        font-weight: 600;
      }
      input {
        width: 100%;
        padding: 10px;
        margin-top: 6px;
        border: 1px solid #ccc;
        border-radius: 8px;
        box-sizing: border-box;
      }
      button {
        margin-top: 14px;
        padding: 10px 14px;
        border: 0;
        border-radius: 10px;
        background: #111;
        color: #fff;
        cursor: pointer;
      }
      button:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }
      pre {
        background: #0b1020;
        color: #e5e7eb;
        padding: 12px;
        border-radius: 10px;
        overflow: auto;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .muted {
        color: #555;
        font-size: 13px;
      }
      .row {
        display: flex;
        gap: 12px;
        align-items: flex-end;
        flex-wrap: wrap;
      }
      .row > div {
        flex: 1;
        min-width: 220px;
      }
      .status {
        margin-top: 14px;
        padding: 12px;
        border-radius: 10px;
        background: #f6f7fb;
        border: 1px solid #e7e7ef;
      }
      .path-row {
        display: flex;
        gap: 8px;
        align-items: flex-end;
        margin-top: 6px;
      }
      .path-row input {
        margin-top: 0;
        flex: 1;
      }
      .browse-btn {
        margin-top: 0;
        padding: 10px 14px;
        white-space: nowrap;
        background: #4f46e5;
        flex-shrink: 0;
      }
      /* Modal */
      .modal-overlay {
        display: none;
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.45);
        z-index: 100;
        align-items: center;
        justify-content: center;
      }
      .modal-overlay.open { display: flex; }
      .modal {
        background: #fff;
        border-radius: 14px;
        padding: 20px;
        width: 560px;
        max-width: 95vw;
        max-height: 80vh;
        display: flex;
        flex-direction: column;
        box-shadow: 0 8px 32px rgba(0,0,0,0.2);
      }
      .modal-header {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 10px;
      }
      .modal-header h3 { margin: 0; flex: 1; font-size: 16px; }
      .modal-close {
        margin-top: 0;
        background: transparent;
        color: #555;
        font-size: 20px;
        padding: 4px 8px;
        border: 1px solid #ddd;
        border-radius: 6px;
      }
      .breadcrumb {
        font-size: 12px;
        color: #555;
        background: #f5f5f5;
        border-radius: 6px;
        padding: 6px 10px;
        margin-bottom: 8px;
        word-break: break-all;
      }
      .dir-list {
        overflow-y: auto;
        flex: 1;
        border: 1px solid #e5e5e5;
        border-radius: 8px;
      }
      .dir-entry {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        cursor: pointer;
        border-bottom: 1px solid #f0f0f0;
        font-size: 14px;
        user-select: none;
      }
      .dir-entry:last-child { border-bottom: none; }
      .dir-entry:hover { background: #f0f0ff; }
      .dir-entry.is-file { color: #888; cursor: default; }
      .dir-entry.is-file:hover { background: transparent; }
      .icon { font-size: 16px; }
      .modal-footer {
        margin-top: 12px;
        display: flex;
        gap: 8px;
        justify-content: flex-end;
      }
      .modal-footer button { margin-top: 0; }
      .select-btn { background: #111; }
      .cancel-btn { background: #888; }
      .up-btn {
        margin-top: 0;
        background: #f3f4f6;
        color: #111;
        border: 1px solid #ddd;
        font-size: 13px;
        padding: 6px 10px;
      }
    </style>
  </head>
  <body>
    <div class="card">
      <h2>Codebase Import (Indexing)</h2>
      <p class="muted">
        Type a <b>server-local absolute directory path</b> or click <b>Browse…</b>
        to navigate the server filesystem and pick a folder.
      </p>

      <form id="form">
        <label>file_path (server absolute directory)</label>
        <div class="path-row">
          <input id="file_path" placeholder="e.g. C:/Users/adars/Documents/my-repo" required />
          <button type="button" class="browse-btn" id="browseBtn">Browse…</button>
        </div>

        <div class="row">
          <div>
            <label>workspace_id</label>
            <input id="workspace_id" value="default" />
          </div>
          <div>
            <label>repo_name (optional)</label>
            <input id="repo_name" value="" />
          </div>
        </div>

        <button id="btn" type="submit">Start import</button>
      </form>

      <div class="status" id="status" style="display: none;">
        <div><b>job_id:</b> <span id="jobId"></span></div>
        <div style="margin-top: 8px;" class="muted" id="pollingText">Polling status...</div>
        <pre id="jobStatus"></pre>
        <div style="margin-top: 10px;">
          <button id="stopBtn" type="button" style="background: #444;">Stop polling</button>
        </div>
      </div>
    </div>

    <!-- Folder picker modal -->
    <div class="modal-overlay" id="modalOverlay">
      <div class="modal">
        <div class="modal-header">
          <h3>Browse for folder</h3>
          <button class="modal-close" id="modalClose" type="button">✕</button>
        </div>
        <div class="breadcrumb" id="breadcrumb">Loading…</div>
        <div class="dir-list" id="dirList">
          <div class="dir-entry muted">Loading…</div>
        </div>
        <div class="modal-footer">
          <button type="button" class="cancel-btn" id="cancelBtn">Cancel</button>
          <button type="button" class="select-btn" id="selectBtn">Select this folder</button>
        </div>
      </div>
    </div>

    <script>
      const form = document.getElementById("form");
      const btn = document.getElementById("btn");
      const statusBox = document.getElementById("status");
      const jobIdEl = document.getElementById("jobId");
      const jobStatusPre = document.getElementById("jobStatus");
      const pollingText = document.getElementById("pollingText");
      const stopBtn = document.getElementById("stopBtn");
      const browseBtn = document.getElementById("browseBtn");
      const modalOverlay = document.getElementById("modalOverlay");
      const modalClose = document.getElementById("modalClose");
      const cancelBtn = document.getElementById("cancelBtn");
      const selectBtn = document.getElementById("selectBtn");
      const breadcrumb = document.getElementById("breadcrumb");
      const dirList = document.getElementById("dirList");

      let pollTimer = null;
      let currentBrowsePath = null;

      /* ── Folder browser ── */
      async function loadDir(dirPath) {
        breadcrumb.textContent = "Loading…";
        dirList.innerHTML = '<div class="dir-entry muted">Loading…</div>';
        const url = "/api/import/browse" + (dirPath ? "?path=" + encodeURIComponent(dirPath) : "");
        try {
          const r = await fetch(url);
          const j = await r.json();
          if (!r.ok) { breadcrumb.textContent = j.message || "Error"; return; }
          const { current, parent, entries } = j.data;
          currentBrowsePath = current;
          breadcrumb.textContent = current;
          selectBtn.dataset.path = current;

          const items = [];
          if (parent) {
            items.push({ name: ".. (up)", type: "up", path: parent });
          }
          items.push(...entries);

          dirList.innerHTML = "";
          if (items.length === 0) {
            dirList.innerHTML = '<div class="dir-entry muted" style="pointer-events:none">Empty folder</div>';
            return;
          }
          for (const entry of items) {
            const el = document.createElement("div");
            el.className = "dir-entry" + (entry.type === "file" ? " is-file" : "");
            const icon = entry.type === "up" ? "⬆️" : entry.type === "dir" ? "📁" : "📄";
            el.innerHTML = '<span class="icon">' + icon + '</span><span>' + entry.name + '</span>';
            if (entry.type !== "file") {
              el.addEventListener("click", () => loadDir(entry.path));
            }
            dirList.appendChild(el);
          }
        } catch (e) {
          breadcrumb.textContent = "Error: " + String(e);
        }
      }

      browseBtn.addEventListener("click", () => {
        modalOverlay.classList.add("open");
        const existing = document.getElementById("file_path").value.trim();
        loadDir(existing || null);
      });

      [modalClose, cancelBtn].forEach(el =>
        el.addEventListener("click", () => modalOverlay.classList.remove("open"))
      );
      modalOverlay.addEventListener("click", (e) => {
        if (e.target === modalOverlay) modalOverlay.classList.remove("open");
      });

      selectBtn.addEventListener("click", () => {
        if (currentBrowsePath) {
          document.getElementById("file_path").value = currentBrowsePath;
          // Auto-fill repo_name from the last folder segment if empty
          const repoInput = document.getElementById("repo_name");
          if (!repoInput.value) {
            repoInput.value = currentBrowsePath.split("/").filter(Boolean).pop() || "";
          }
        }
        modalOverlay.classList.remove("open");
      });

      /* ── Import form ── */
      function render(obj) {
        jobStatusPre.textContent = JSON.stringify(obj, null, 2);
      }

      async function poll(jobId) {
        pollTimer = setInterval(async () => {
          try {
            const r = await fetch("/api/import/status/" + encodeURIComponent(jobId));
            const j = await r.json();
            render(j);

            const s = j && j.data && j.data.status;
            if (s === "completed" || s === "failed") {
              pollingText.textContent =
                s === "completed"
                  ? "Import completed. Embeddings may still be processing."
                  : "Import failed. See details above.";
              clearInterval(pollTimer);
              pollTimer = null;
              btn.disabled = false;
            }
          } catch (e) {
            pollingText.textContent = "Polling error: " + String(e);
          }
        }, 2000);
      }

      stopBtn.addEventListener("click", () => {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
        pollingText.textContent = "Stopped polling.";
        btn.disabled = false;
      });

      form.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        btn.disabled = true;

        const payload = {
          file_path: document.getElementById("file_path").value,
          workspace_id: document.getElementById("workspace_id").value || "default",
          repo_name: document.getElementById("repo_name").value || ""
        };

        const r = await fetch("/api/import/codebase", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });

        const j = await r.json();
        const jobId = j && j.data && j.data.job_id;

        if (!jobId) {
          btn.disabled = false;
          alert("Import did not return job_id. Response: " + JSON.stringify(j));
          return;
        }

        statusBox.style.display = "block";
        jobIdEl.textContent = jobId;
        render(j);
        pollingText.textContent = "Polling status...";
        await poll(jobId);
      });
    </script>
  </body>
</html>`);
  }),
);

/**
 * GET /api/import/browse?path=<dir>
 * List the contents of a server-side directory for the folder-picker UI.
 * Returns parent path + array of entries (name, type, path).
 */
router.get(
  "/browse",
  withErrorHandler(async (req: Request, res: Response) => {
    const rawPath = (req.query.path as string | undefined) || os.homedir();
    const dirPath = path.resolve(rawPath);

    if (!fs.existsSync(dirPath)) {
      throw new AppError(`Directory not found: ${dirPath}`, 404);
    }
    const stat = fs.statSync(dirPath);
    if (!stat.isDirectory()) {
      throw new AppError(`Not a directory: ${dirPath}`, 400);
    }

    let entries: { name: string; type: "dir" | "file"; path: string }[] = [];
    try {
      entries = fs
        .readdirSync(dirPath, { withFileTypes: true })
        .filter((d) => !d.name.startsWith("."))
        .map((d) => ({
          name: d.name,
          type: d.isDirectory() ? "dir" : "file",
          path: path.join(dirPath, d.name).replace(/\\/g, "/"),
        }))
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
    } catch {
      // permission denied or similar — return empty list
    }

    const parent = path.dirname(dirPath).replace(/\\/g, "/");
    res.json({
      status: 200,
      data: {
        current: dirPath.replace(/\\/g, "/"),
        parent: parent !== dirPath.replace(/\\/g, "/") ? parent : null,
        entries,
      },
    });
  }),
);

export { router as importRouter };
