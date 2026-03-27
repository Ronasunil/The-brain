import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "OrgBrain",
  description:
    "AI-powered organizational memory — your company's brain",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif",
          margin: 0,
          padding: 0,
          color: "#111",
          background: "#fafafa",
        }}
      >
        {children}
      </body>
    </html>
  );
}
