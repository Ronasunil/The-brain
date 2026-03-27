"use client";

import { useState } from "react";

interface Source {
  content: string;
  user_name: string;
  source: string;
  timestamp: string;
  similarity: number;
  file_path?: string;
}

interface BrainAnswer {
  answer: string;
  sources: Source[];
}

export default function BrainPage() {
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<BrainAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleAsk = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!question.trim()) return;

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const r = await fetch("/api/brain/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const j = await r.json();

      if (!r.ok) {
        setError(j.message || "Request failed");
        return;
      }

      setResult(j.data);
    } catch (e) {
      setError("Network error: " + String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <main style={{ maxWidth: 820, margin: "40px auto", padding: "0 24px" }}>
      <h2>Ask the Brain</h2>
      <p style={{ color: "#555", fontSize: 14 }}>
        Ask a question and get an answer backed by your team&apos;s conversations and
        code.
      </p>

      <form onSubmit={handleAsk} style={{ display: "flex", gap: 8 }}>
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="e.g. How do we deploy the API?"
          required
          style={{
            flex: 1,
            padding: 12,
            border: "1px solid #ccc",
            borderRadius: 10,
            fontSize: 15,
          }}
        />
        <button
          type="submit"
          disabled={loading}
          style={{
            padding: "12px 20px",
            border: 0,
            borderRadius: 10,
            background: "#111",
            color: "#fff",
            cursor: loading ? "not-allowed" : "pointer",
            opacity: loading ? 0.6 : 1,
            fontSize: 15,
            fontWeight: 600,
          }}
        >
          {loading ? "Thinking..." : "Ask"}
        </button>
      </form>

      {error && (
        <div
          style={{
            marginTop: 16,
            padding: 12,
            background: "#fef2f2",
            border: "1px solid #fecaca",
            borderRadius: 10,
            color: "#991b1b",
          }}
        >
          {error}
        </div>
      )}

      {result && (
        <div style={{ marginTop: 24 }}>
          <div
            style={{
              padding: 16,
              background: "#f8fafc",
              border: "1px solid #e2e8f0",
              borderRadius: 12,
              lineHeight: 1.6,
              whiteSpace: "pre-wrap",
            }}
          >
            {result.answer}
          </div>

          {result.sources.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <h4 style={{ marginBottom: 8 }}>Sources</h4>
              {result.sources.map((s, i) => (
                <div
                  key={i}
                  style={{
                    padding: "8px 12px",
                    marginBottom: 6,
                    background: "#fff",
                    border: "1px solid #e5e7eb",
                    borderRadius: 8,
                    fontSize: 13,
                  }}
                >
                  {s.file_path ? (
                    <span>
                      <b>{s.file_path}</b>
                      <span style={{ color: "#888", marginLeft: 8 }}>
                        ({(s.similarity * 100).toFixed(0)}% match)
                      </span>
                    </span>
                  ) : (
                    <span>
                      &ldquo;
                      {s.content.length > 120
                        ? s.content.slice(0, 120) + "..."
                        : s.content}
                      &rdquo; &mdash; <b>{s.user_name}</b> via {s.source}
                      <span style={{ color: "#888", marginLeft: 8 }}>
                        (
                        {new Date(s.timestamp).toLocaleDateString("en-US", {
                          year: "numeric",
                          month: "short",
                          day: "numeric",
                        })}
                        )
                      </span>
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </main>
  );
}
