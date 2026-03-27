import { NextRequest } from "next/server";
import { success, handleError } from "@/lib/api-utils";
import { AppError } from "@/lib/errors/app-error";
import { ImportService } from "@/services/import.service";
import { CodebaseImportService } from "@/services/codebase-import.service";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  try {
    const { jobId } = await params;

    const status =
      ImportService.getStatus(jobId) ||
      CodebaseImportService.getStatus(jobId);

    if (!status) {
      throw new AppError("Import job not found", 404);
    }

    return success(status, `Import ${status.status}`);
  } catch (error) {
    return handleError(error);
  }
}
