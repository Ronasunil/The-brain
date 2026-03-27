import { NextRequest } from "next/server";
import * as fs from "fs";
import { success, handleError } from "@/lib/api-utils";
import { AppError } from "@/lib/errors/app-error";
import { CodebaseImportService } from "@/services/codebase-import.service";
import { DEFAULT_WORKSPACE_ID } from "@/lib/constants/app.constants";

export async function POST(req: NextRequest) {
  try {
    const { file_path, workspace_id, repo_name } = await req.json();

    if (!file_path) {
      throw new AppError("file_path is required", 400);
    }

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

    return success(
      { job_id: jobId },
      "Codebase import started. Use GET /api/import/status/:jobId to track progress.",
      202,
    );
  } catch (error) {
    return handleError(error);
  }
}
