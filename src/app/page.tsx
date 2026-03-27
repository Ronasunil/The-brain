import Link from "next/link";

export default function HomePage() {
  return (
    <main style={{ maxWidth: 720, margin: "60px auto", padding: "0 24px" }}>
      <h1>OrgBrain</h1>
      <p style={{ color: "#555" }}>
        AI-powered organizational memory. Ingest conversations and code,
        then ask questions backed by hybrid semantic search.
      </p>

      <nav
        style={{
          marginTop: 32,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <Link
          href="/brain"
          style={{
            display: "block",
            padding: "14px 18px",
            background: "#111",
            color: "#fff",
            borderRadius: 10,
            textDecoration: "none",
            fontWeight: 600,
          }}
        >
          Ask the Brain
        </Link>

        <Link
          href="/import/codebase"
          style={{
            display: "block",
            padding: "14px 18px",
            background: "#4f46e5",
            color: "#fff",
            borderRadius: 10,
            textDecoration: "none",
            fontWeight: 600,
          }}
        >
          Import Codebase
        </Link>
      </nav>
    </main>
  );
}
