import * as fs from "fs";
import * as path from "path";

const INCLUDE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "py", "go", "java", "cs", "rb", "php", "rs",
  "c", "cpp", "h", "hpp", "md", "yaml", "yml", "json", "txt", "toml",
  "cfg", "ini", "sh", "bash", "sql", "html", "css", "scss", "svelte", "vue",
]);

const EXCLUDE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", "coverage",
  "venv", "__pycache__", ".venv", ".tox", ".mypy_cache", ".pytest_cache",
  "target", "bin", "obj", ".idea", ".vscode", "vendor",
]);

const EXCLUDE_FILES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
]);

const MAX_FILE_SIZE_BYTES = 512 * 1024; // 512 KB

export interface WalkedFile {
  absolutePath: string;
  relativePath: string; // relative to root dir, always forward-slashed
  extension: string;
}

/**
 * Recursively walk a directory and return all indexable source files.
 * Skips excluded directories, excluded files, large files, and empty files.
 * Normalizes paths to forward slashes for consistent cross-platform storage.
 */
export function walkDirectory(rootDir: string): WalkedFile[] {
  const results: WalkedFile[] = [];

  function walk(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // skip unreadable directories
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!EXCLUDE_DIRS.has(entry.name)) {
          walk(fullPath);
        }
        continue;
      }

      if (!entry.isFile()) continue;

      if (EXCLUDE_FILES.has(entry.name)) continue;

      // Skip minified / bundled files by name pattern
      if (entry.name.endsWith(".min.js") || entry.name.endsWith(".min.css") ||
          entry.name.endsWith(".map") || entry.name.endsWith(".bundle.js")) {
        continue;
      }

      const ext = path.extname(entry.name).slice(1).toLowerCase();
      if (!INCLUDE_EXTENSIONS.has(ext)) continue;

      try {
        const stat = fs.statSync(fullPath);
        if (stat.size > MAX_FILE_SIZE_BYTES || stat.size === 0) continue;
      } catch {
        continue;
      }

      // Normalize to forward slashes for consistent storage
      const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, "/");

      results.push({ absolutePath: fullPath, relativePath, extension: ext });
    }
  }

  walk(rootDir);
  return results;
}
