"use client";

import { useState, useEffect, useCallback } from "react";

interface DirEntry {
  name: string;
  type: "dir" | "file";
  path: string;
}

interface BrowseData {
  current: string;
  parent: string | null;
  entries: DirEntry[];
}

export default function CodebaseImportPage() {
  const [filePath, setFilePath] = useState("");
  const [workspaceId, setWorkspaceId] = useState("default");
  const [repoName, setRepoName] = useState("");
  const [importing, setImporting] = useState(false);

  // Job status
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<Record<string, unknown> | null>(
    null,
  );
  const [polling, setPolling] = useState(false);
  const [statusText, setStatusText] = useState("");

  // Browse modal
  const [showBrowse, setShowBrowse] = useState(false);
  const [browseData, setBrowseData] = useState<BrowseData | null>(null);
  const [browseLoading, setBrowseLoading] = useState(false);

  /* ── Browse directory ── */
  const loadDir = useCallback(async (dirPath?: string) => {
    setBrowseLoading(true);
    const url =
      "/api/import/browse" +
      (dirPath ? "?path=" + encodeURIComponent(dirPath) : "");
    try {
      const r = await fetch(url);
      const j = await r.json();
      if (r.ok) {
        setBrowseData(j.data);
      }
    } catch (e) {
      console.error("Browse error:", e);
    } finally {
      setBrowseLoading(false);
    }
  }, []);

  const openBrowse = () => {
    setShowBrowse(true);
    loadDir(filePath || undefined);
  };

  const selectFolder = () => {
    if (browseData) {
      setFilePath(browseData.current);
      if (!repoName) {
        setRepoName(
          browseData.current.split("/").filter(Boolean).pop() || "",
        );
      }
    }
    setShowBrowse(false);
  };

  /* ── Poll status ── */
  useEffect(() => {
    if (!polling || !jobId) return;
    const timer = setInterval(async () => {
      try {
        const r = await fetch(
          "/api/import/status/" + encodeURIComponent(jobId),
        );
        const j = await r.json();
        setJobStatus(j);
        const s = j?.data?.status;
        if (s === "completed" || s === "failed") {
          setStatusText(
            s === "completed"
              ? "Import completed. Embeddings may still be processing."
              : "Import failed. See details above.",
          );
          setPolling(false);
          setImporting(false);
        }
      } catch (e) {
        setStatusText("Polling error: " + String(e));
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [polling, jobId]);

  /* ── Submit ── */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setImporting(true);
    setStatusText("Polling status...");

    const r = await fetch("/api/import/codebase", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file_path: filePath,
        workspace_id: workspaceId || "default",
        repo_name: repoName || "",
      }),
    });

    const j = await r.json();
    const id = j?.data?.job_id;
    if (!id) {
      setImporting(false);
      alert("Import did not return job_id: " + JSON.stringify(j));
      return;
    }

    setJobId(id);
    setJobStatus(j);
    setPolling(true);
  };

  return (
    <main style={{ maxWidth: 820, margin: "40px auto", padding: "0 24px" }}>
      <div style={styles.card}>
        <h2>Codebase Import (Indexing)</h2>
        <p style={styles.muted}>
          Type a <b>server-local absolute directory path</b> or click{" "}
          <b>Browse...</b> to navigate the server filesystem and pick a folder.
        </p>

        <form onSubmit={handleSubmit}>
          <label style={styles.label}>
            file_path (server absolute directory)
          </label>
          <div style={styles.pathRow}>
            <input
              style={{ ...styles.input, flex: 1 }}
              value={filePath}
              onChange={(e) => setFilePath(e.target.value)}
              placeholder="e.g. C:/Users/adars/Documents/my-repo"
              required
            />
            <button
              type="button"
              style={styles.browseBtn}
              onClick={openBrowse}
            >
              Browse...
            </button>
          </div>

          <div style={styles.row}>
            <div style={{ flex: 1, minWidth: 220 }}>
              <label style={styles.label}>workspace_id</label>
              <input
                style={styles.input}
                value={workspaceId}
                onChange={(e) => setWorkspaceId(e.target.value)}
              />
            </div>
            <div style={{ flex: 1, minWidth: 220 }}>
              <label style={styles.label}>repo_name (optional)</label>
              <input
                style={styles.input}
                value={repoName}
                onChange={(e) => setRepoName(e.target.value)}
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={importing}
            style={{
              ...styles.btn,
              opacity: importing ? 0.6 : 1,
              cursor: importing ? "not-allowed" : "pointer",
            }}
          >
            Start import
          </button>
        </form>

        {/* Status panel */}
        {jobId && (
          <div style={styles.statusBox}>
            <div>
              <b>job_id:</b> {jobId}
            </div>
            <div style={{ marginTop: 8, ...styles.muted }}>{statusText}</div>
            <pre style={styles.pre}>
              {JSON.stringify(jobStatus, null, 2)}
            </pre>
            {polling && (
              <button
                type="button"
                onClick={() => {
                  setPolling(false);
                  setImporting(false);
                  setStatusText("Stopped polling.");
                }}
                style={{ ...styles.btn, background: "#444", marginTop: 10 }}
              >
                Stop polling
              </button>
            )}
          </div>
        )}
      </div>

      {/* Browse modal */}
      {showBrowse && (
        <div style={styles.overlay} onClick={() => setShowBrowse(false)}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <h3 style={{ margin: 0, flex: 1, fontSize: 16 }}>
                Browse for folder
              </h3>
              <button
                style={styles.closeBtn}
                onClick={() => setShowBrowse(false)}
              >
                x
              </button>
            </div>

            <div style={styles.breadcrumb}>
              {browseLoading
                ? "Loading..."
                : browseData?.current || "Loading..."}
            </div>

            <div style={styles.dirList}>
              {browseLoading && (
                <div style={{ ...styles.dirEntry, color: "#888" }}>
                  Loading...
                </div>
              )}

              {!browseLoading && browseData?.parent && (
                <div
                  style={styles.dirEntry}
                  onClick={() => loadDir(browseData.parent!)}
                >
                  <span>&#11014;&#65039;</span>
                  <span>.. (up)</span>
                </div>
              )}

              {!browseLoading &&
                browseData?.entries.map((entry) => (
                  <div
                    key={entry.path}
                    style={{
                      ...styles.dirEntry,
                      ...(entry.type === "file"
                        ? { color: "#888", cursor: "default" }
                        : {}),
                    }}
                    onClick={
                      entry.type === "dir"
                        ? () => loadDir(entry.path)
                        : undefined
                    }
                  >
                    <span>{entry.type === "dir" ? "\uD83D\uDCC1" : "\uD83D\uDCC4"}</span>
                    <span>{entry.name}</span>
                  </div>
                ))}

              {!browseLoading &&
                browseData?.entries.length === 0 &&
                !browseData?.parent && (
                  <div
                    style={{ ...styles.dirEntry, color: "#888", cursor: "default" }}
                  >
                    Empty folder
                  </div>
                )}
            </div>

            <div style={styles.modalFooter}>
              <button
                style={{ ...styles.btn, background: "#888" }}
                onClick={() => setShowBrowse(false)}
              >
                Cancel
              </button>
              <button style={styles.btn} onClick={selectFolder}>
                Select this folder
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

/* ── Inline styles ── */
const styles: Record<string, React.CSSProperties> = {
  card: {
    border: "1px solid #ddd",
    borderRadius: 12,
    padding: 16,
  },
  muted: { color: "#555", fontSize: 13 },
  label: { display: "block", marginTop: 10, fontWeight: 600 },
  input: {
    width: "100%",
    padding: 10,
    marginTop: 6,
    border: "1px solid #ccc",
    borderRadius: 8,
    boxSizing: "border-box",
    fontSize: 14,
  },
  pathRow: { display: "flex", gap: 8, alignItems: "flex-end", marginTop: 6 },
  row: {
    display: "flex",
    gap: 12,
    alignItems: "flex-end",
    flexWrap: "wrap",
  },
  btn: {
    marginTop: 14,
    padding: "10px 14px",
    border: 0,
    borderRadius: 10,
    background: "#111",
    color: "#fff",
    cursor: "pointer",
    fontSize: 14,
  },
  browseBtn: {
    padding: "10px 14px",
    border: 0,
    borderRadius: 10,
    background: "#4f46e5",
    color: "#fff",
    cursor: "pointer",
    whiteSpace: "nowrap",
    flexShrink: 0,
    fontSize: 14,
  },
  statusBox: {
    marginTop: 14,
    padding: 12,
    borderRadius: 10,
    background: "#f6f7fb",
    border: "1px solid #e7e7ef",
  },
  pre: {
    background: "#0b1020",
    color: "#e5e7eb",
    padding: 12,
    borderRadius: 10,
    overflow: "auto",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    fontSize: 13,
  },
  /* Modal */
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.45)",
    zIndex: 100,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  modal: {
    background: "#fff",
    borderRadius: 14,
    padding: 20,
    width: 560,
    maxWidth: "95vw",
    maxHeight: "80vh",
    display: "flex",
    flexDirection: "column",
    boxShadow: "0 8px 32px rgba(0,0,0,0.2)",
  },
  modalHeader: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 10,
  },
  closeBtn: {
    background: "transparent",
    color: "#555",
    fontSize: 20,
    padding: "4px 8px",
    border: "1px solid #ddd",
    borderRadius: 6,
    cursor: "pointer",
  },
  breadcrumb: {
    fontSize: 12,
    color: "#555",
    background: "#f5f5f5",
    borderRadius: 6,
    padding: "6px 10px",
    marginBottom: 8,
    wordBreak: "break-all",
  },
  dirList: {
    overflowY: "auto",
    flex: 1,
    border: "1px solid #e5e5e5",
    borderRadius: 8,
  },
  dirEntry: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 12px",
    cursor: "pointer",
    borderBottom: "1px solid #f0f0f0",
    fontSize: 14,
    userSelect: "none",
  },
  modalFooter: {
    marginTop: 12,
    display: "flex",
    gap: 8,
    justifyContent: "flex-end",
  },
};
