"use client";

import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import Link from "next/link";
import type { AdminAnalyticsPayload } from "@/lib/types/analytics.types";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

function formatUsd(n: number | null): string {
  if (n == null) return "N/A";
  if (n < 0.01) return "< $0.01";
  return `$${n.toFixed(4)}`;
}

export default function AdminAnalyticsPage() {
  const [data, setData] = useState<AdminAnalyticsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/admin/analytics");
      const j = await r.json();
      if (!r.ok) {
        setError(j?.message || "Request failed");
        setData(null);
        return;
      }
      setData(j.data as AdminAnalyticsPayload);
    } catch (e) {
      setError(String(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main style={{ maxWidth: 1100, margin: "40px auto", padding: "0 24px" }}>
      <div style={{ marginBottom: 24 }}>
        <Link href="/" style={{ color: "#4f46e5", textDecoration: "none" }}>
          Home
        </Link>
        <span style={{ color: "#999", margin: "0 8px" }}>/</span>
        <span style={{ color: "#555" }}>Admin analytics</span>
      </div>

      <div style={styles.card}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            flexWrap: "wrap",
            gap: 12,
          }}
        >
          <div>
            <h1 style={{ margin: "0 0 8px", fontSize: 26 }}>Admin dashboard</h1>
            <p style={{ ...styles.muted, margin: 0, maxWidth: 720 }}>
              Indexed code repositories, chunk counts, rough storage footprint, and
              indicative embedding cost for indexing (based on your configured
              AI provider).
            </p>
          </div>
          <button type="button" onClick={() => void load()} style={styles.btn}>
            Refresh
          </button>
        </div>

        {loading && <p style={{ marginTop: 20 }}>Loading…</p>}
        {error && (
          <div style={styles.errorBox}>
            <b>Could not load analytics.</b> {error}
            <div style={{ marginTop: 8, fontSize: 13 }}>
              If the database function is missing, run{" "}
              <code style={styles.code}>src/db/migrations/003_admin_analytics.sql</code>{" "}
              in the Supabase SQL editor.
            </div>
          </div>
        )}

        {!loading && data && (
          <>
            <p style={{ ...styles.muted, marginTop: 16, fontSize: 12 }}>
              Snapshot: {data.generated_at} · Provider:{" "}
              <strong>{data.ai_provider}</strong> · Source:{" "}
              <strong>{data.source}</strong>
            </p>
            <p style={{ ...styles.muted, marginTop: 4, fontSize: 12 }}>
              {data.cost_disclaimer}
            </p>

            <h2 style={{ marginTop: 28, fontSize: 18 }}>Code index</h2>
            <div style={styles.kpiGrid}>
              <Kpi
                label="Total chunks"
                value={data.code_totals.chunk_count.toLocaleString()}
              />
              <Kpi
                label="Distinct files"
                value={data.code_totals.distinct_files.toLocaleString()}
              />
              <Kpi
                label="Embedded / pending"
                value={`${data.code_totals.embedded_chunks.toLocaleString()} / ${data.code_totals.pending_embedding.toLocaleString()}`}
              />
              <Kpi
                label="Raw content size"
                value={formatBytes(data.code_totals.content_bytes)}
              />
              <Kpi
                label="Est. storage (content + vectors + FTS)"
                value={formatBytes(data.code_totals.estimated_storage_bytes)}
              />
              <Kpi
                label="Est. indexing cost (embeds)"
                value={formatUsd(data.code_totals.estimated_indexing_cost_usd)}
              />
            </div>

            <h3 style={{ marginTop: 24, fontSize: 16 }}>Repositories</h3>
            <div style={{ overflowX: "auto" }}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>Workspace</th>
                    <th style={styles.th}>Repo</th>
                    <th style={styles.th}>Chunks</th>
                    <th style={styles.th}>Files</th>
                    <th style={styles.th}>Embedded</th>
                    <th style={styles.th}>Pending</th>
                    <th style={styles.th}>Content</th>
                    <th style={styles.th}>Est. storage</th>
                    <th style={styles.th}>Est. cost</th>
                  </tr>
                </thead>
                <tbody>
                  {data.code_repos.length === 0 ? (
                    <tr>
                      <td colSpan={9} style={styles.tdMuted}>
                        No code chunks indexed yet.
                      </td>
                    </tr>
                  ) : (
                    data.code_repos.map((row) => (
                      <tr key={`${row.workspace_id}::${row.repo_name}`}>
                        <td style={styles.td}>{row.workspace_id}</td>
                        <td style={styles.td}>{row.repo_name}</td>
                        <td style={styles.td}>{row.chunk_count}</td>
                        <td style={styles.td}>{row.file_count}</td>
                        <td style={styles.td}>{row.embedded_chunks}</td>
                        <td style={styles.td}>{row.pending_embedding}</td>
                        <td style={styles.td}>{formatBytes(row.content_bytes)}</td>
                        <td style={styles.td}>
                          {formatBytes(row.estimated_storage_bytes)}
                        </td>
                        <td style={styles.td}>
                          {formatUsd(row.estimated_indexing_cost_usd)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <h2 style={{ marginTop: 28, fontSize: 18 }}>Messages (Telegram)</h2>
            <div style={styles.kpiGrid}>
              <Kpi
                label="Total messages"
                value={data.messages_totals.message_count.toLocaleString()}
              />
              <Kpi
                label="Embedded / pending"
                value={`${data.messages_totals.embedded_messages.toLocaleString()} / ${data.messages_totals.pending_embedding.toLocaleString()}`}
              />
              <Kpi
                label="Raw content size"
                value={formatBytes(data.messages_totals.content_bytes)}
              />
              <Kpi
                label="Est. storage"
                value={formatBytes(data.messages_totals.estimated_storage_bytes)}
              />
              <Kpi
                label="Est. indexing cost (embeds)"
                value={formatUsd(data.messages_totals.estimated_indexing_cost_usd)}
              />
            </div>

            <p style={{ ...styles.muted, marginTop: 16, fontSize: 12 }}>
              Vector storage assumes 1024 dimensions × 4 bytes per embedded row
              (pgvector float32), plus ~25% rough overhead for full-text indexes.
              Indexing cost assumes one embedding pass over stored text; rerank and
              chat usage are not included.
            </p>
          </>
        )}
      </div>
    </main>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.kpi}>
      <div style={styles.kpiLabel}>{label}</div>
      <div style={styles.kpiValue}>{value}</div>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  card: {
    border: "1px solid #ddd",
    borderRadius: 12,
    padding: 24,
    background: "#fff",
  },
  muted: { color: "#555", fontSize: 14 },
  btn: {
    padding: "10px 16px",
    border: 0,
    borderRadius: 10,
    background: "#111",
    color: "#fff",
    cursor: "pointer",
    fontSize: 14,
    fontWeight: 600,
  },
  errorBox: {
    marginTop: 16,
    padding: 12,
    borderRadius: 10,
    background: "#fef2f2",
    border: "1px solid #fecaca",
    color: "#991b1b",
  },
  code: { fontFamily: "ui-monospace, monospace", fontSize: 12 },
  kpiGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
    gap: 12,
    marginTop: 12,
  },
  kpi: {
    border: "1px solid #e5e7eb",
    borderRadius: 10,
    padding: "12px 14px",
    background: "#f9fafb",
  },
  kpiLabel: { fontSize: 11, color: "#6b7280", textTransform: "uppercase" },
  kpiValue: { fontSize: 18, fontWeight: 700, marginTop: 4 },
  table: {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: 13,
    marginTop: 8,
  },
  th: {
    textAlign: "left",
    padding: "10px 8px",
    borderBottom: "2px solid #e5e7eb",
    color: "#374151",
    fontWeight: 600,
  },
  td: {
    padding: "10px 8px",
    borderBottom: "1px solid #f3f4f6",
    verticalAlign: "top",
  },
  tdMuted: {
    padding: "16px 8px",
    color: "#9ca3af",
    fontStyle: "italic",
  },
};
