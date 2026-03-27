import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Use src/ directory for app router
  // Allow server-side Node.js APIs (fs, path, os, child_process, etc.)
  serverExternalPackages: [
    "node-telegram-bot-api",
    "stream-json",
    "cohere-ai",
  ],
};

export default nextConfig;
