import { NextRequest } from "next/server";
import * as fs from "fs";
import { success, handleError } from "@/lib/api-utils";
import { AppError } from "@/lib/errors/app-error";
import { ImportService } from "@/services/import.service";
import { DEFAULT_WORKSPACE_ID } from "@/lib/constants/app.constants";

export async function POST(req: NextRequest) {
  try {
    const { file_path, chat_id, chat_name, workspace_id } = await req.json();

    if (!file_path || !chat_id || !chat_name) {
      throw new AppError(
        "file_path, chat_id, and chat_name are required",
        400,
      );
    }

    if (!fs.existsSync(file_path)) {
      throw new AppError(`File not found: ${file_path}`, 400);
    }

    const jobId = await ImportService.importTelegramExport(
      file_path,
      chat_id,
      chat_name,
      workspace_id || DEFAULT_WORKSPACE_ID,
    );

    return success(
      { job_id: jobId },
      "Import started. Use GET /api/import/status/:jobId to track progress.",
      202,
    );
  } catch (error) {
    return handleError(error);
  }
}
