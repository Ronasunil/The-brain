import * as fs from "node:fs";
import * as path from "node:path";
import { CreateCodeChunkInput } from "../lib/types";

const MAX_CHUNK_CHARS = 4000;
const OVERLAP_CHARS = 200;

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "__pycache__",
  ".venv",
  "vendor",
  ".idea",
  ".vscode",
  "coverage",
  ".cache",
  ".turbo",
  ".output",
  ".nuxt",
  ".svelte-kit",
]);

const SKIP_EXTENSIONS = new Set([
  ".lock",
  ".min.js",
  ".min.css",
  ".map",
  ".wasm",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".svg",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".bz2",
  ".7z",
  ".rar",
  ".mp3",
  ".mp4",
  ".avi",
  ".mov",
  ".webm",
  ".webp",
  ".DS_Store",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".o",
  ".obj",
  ".pyc",
  ".class",
]);

const SKIP_FILENAMES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "Cargo.lock",
  "Gemfile.lock",
  "poetry.lock",
  "composer.lock",
]);

const EXT_TO_LANGUAGE: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".rb": "ruby",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".swift": "swift",
  ".cs": "csharp",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".c": "c",
  ".h": "c",
  ".hpp": "cpp",
  ".php": "php",
  ".lua": "lua",
  ".r": "r",
  ".R": "r",
  ".scala": "scala",
  ".dart": "dart",
  ".ex": "elixir",
  ".exs": "elixir",
  ".erl": "erlang",
  ".hs": "haskell",
  ".ml": "ocaml",
  ".clj": "clojure",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".sql": "sql",
  ".html": "html",
  ".css": "css",
  ".scss": "scss",
  ".less": "less",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".json": "json",
  ".xml": "xml",
  ".md": "markdown",
  ".vue": "vue",
  ".svelte": "svelte",
  ".zig": "zig",
  ".nim": "nim",
  ".tf": "terraform",
  ".proto": "protobuf",
  ".graphql": "graphql",
  ".gql": "graphql",
};

function shouldSkipFile(filePath: string): boolean {
  const basename = path.basename(filePath);
  if (SKIP_FILENAMES.has(basename)) return true;
  if (basename.startsWith(".")) return true;

  const ext = path.extname(filePath).toLowerCase();
  if (SKIP_EXTENSIONS.has(ext)) return true;

  return false;
}

function detectLanguage(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase();
  return EXT_TO_LANGUAGE[ext];
}

function splitIntoChunks(
  content: string,
  filePath: string,
): Array<{ content: string; lineStart: number; lineEnd: number }> {
  const header = `// File: ${filePath}\n`;

  if (header.length + content.length <= MAX_CHUNK_CHARS) {
    const lineCount = content.split("\n").length;
    return [{ content: header + content, lineStart: 1, lineEnd: lineCount }];
  }

  const lines = content.split("\n");
  const chunks: Array<{ content: string; lineStart: number; lineEnd: number }> =
    [];
  let currentLines: string[] = [];
  let currentChars = header.length;
  let chunkStartLine = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineLen = line.length + 1; // +1 for newline

    if (
      currentChars + lineLen > MAX_CHUNK_CHARS &&
      currentLines.length > 0
    ) {
      chunks.push({
        content: header + currentLines.join("\n"),
        lineStart: chunkStartLine,
        lineEnd: chunkStartLine + currentLines.length - 1,
      });

      // Overlap: keep last few lines from previous chunk
      const overlapLines: string[] = [];
      let overlapChars = 0;
      for (let j = currentLines.length - 1; j >= 0; j--) {
        if (overlapChars + currentLines[j].length + 1 > OVERLAP_CHARS) break;
        overlapLines.unshift(currentLines[j]);
        overlapChars += currentLines[j].length + 1;
      }

      chunkStartLine =
        chunkStartLine + currentLines.length - overlapLines.length;
      currentLines = [...overlapLines];
      currentChars = header.length + overlapChars;
    }

    currentLines.push(line);
    currentChars += lineLen;
  }

  if (currentLines.length > 0) {
    chunks.push({
      content: header + currentLines.join("\n"),
      lineStart: chunkStartLine,
      lineEnd: chunkStartLine + currentLines.length - 1,
    });
  }

  return chunks;
}

function walkDir(dir: string): string[] {
  const results: string[] = [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      results.push(...walkDir(fullPath));
    } else if (entry.isFile()) {
      if (!shouldSkipFile(fullPath)) {
        results.push(fullPath);
      }
    }
  }

  return results;
}

function isBinaryContent(content: string): boolean {
  const sample = content.slice(0, 1024);
  let nullCount = 0;
  for (let i = 0; i < sample.length; i++) {
    if (sample.charCodeAt(i) === 0) nullCount++;
  }
  return nullCount > 2;
}

export const CodeChunker = {
  chunkRepository(
    repoDir: string,
    workspaceId: string,
    integrationId: string,
    repoName: string,
  ): CreateCodeChunkInput[] {
    const files = walkDir(repoDir);
    const chunks: CreateCodeChunkInput[] = [];

    for (const filePath of files) {
      try {
        const content = fs.readFileSync(filePath, "utf-8");

        if (!content.trim() || content.length < 10) continue;
        if (isBinaryContent(content)) continue;

        const relativePath = path.relative(repoDir, filePath).replace(/\\/g, "/");
        const language = detectLanguage(filePath);
        const fileChunks = splitIntoChunks(content, relativePath);

        for (const chunk of fileChunks) {
          chunks.push({
            workspace_id: workspaceId,
            integration_id: integrationId,
            file_path: relativePath,
            repo_name: repoName,
            language,
            chunk_type: fileChunks.length === 1 ? "file" : "segment",
            line_start: chunk.lineStart,
            line_end: chunk.lineEnd,
            content: chunk.content,
          });
        }
      } catch {
        // Skip files that can't be read (permissions, encoding issues)
      }
    }

    return chunks;
  },

  chunkFiles(
    repoDir: string,
    filePaths: string[],
    workspaceId: string,
    integrationId: string,
    repoName: string,
  ): CreateCodeChunkInput[] {
    const chunks: CreateCodeChunkInput[] = [];

    for (const relativePath of filePaths) {
      const fullPath = path.join(repoDir, relativePath);

      if (shouldSkipFile(fullPath)) continue;

      try {
        if (!fs.existsSync(fullPath)) continue;

        const content = fs.readFileSync(fullPath, "utf-8");
        if (!content.trim() || content.length < 10) continue;
        if (isBinaryContent(content)) continue;

        const normalizedPath = relativePath.replace(/\\/g, "/");
        const language = detectLanguage(fullPath);
        const fileChunks = splitIntoChunks(content, normalizedPath);

        for (const chunk of fileChunks) {
          chunks.push({
            workspace_id: workspaceId,
            integration_id: integrationId,
            file_path: normalizedPath,
            repo_name: repoName,
            language,
            chunk_type: fileChunks.length === 1 ? "file" : "segment",
            line_start: chunk.lineStart,
            line_end: chunk.lineEnd,
            content: chunk.content,
          });
        }
      } catch {
        // Skip unreadable files
      }
    }

    return chunks;
  },
};
