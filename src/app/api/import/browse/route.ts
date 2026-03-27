import { NextRequest } from "next/server";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { success, handleError } from "@/lib/api-utils";
import { AppError } from "@/lib/errors/app-error";

export async function GET(req: NextRequest) {
  try {
    const rawPath = req.nextUrl.searchParams.get("path") || os.homedir();
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
          type: (d.isDirectory() ? "dir" : "file") as "dir" | "file",
          path: path.join(dirPath, d.name).replace(/\\/g, "/"),
        }))
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
    } catch {
      // permission denied — return empty list
    }

    const parent = path.dirname(dirPath).replace(/\\/g, "/");
    return success(
      {
        current: dirPath.replace(/\\/g, "/"),
        parent: parent !== dirPath.replace(/\\/g, "/") ? parent : null,
        entries,
      },
      "Directory listing",
    );
  } catch (error) {
    return handleError(error);
  }
}
