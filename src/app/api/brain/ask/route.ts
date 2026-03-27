import { NextRequest } from "next/server";
import { success, handleError } from "@/lib/api-utils";
import { askQuestionSchema } from "@/lib/validations/brain.schema";
import { QueryService } from "@/services/query.service";
import { DEFAULT_WORKSPACE_ID } from "@/lib/constants/app.constants";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { question, workspace_id } = askQuestionSchema.parse(body);

    const result = await QueryService.ask(
      question,
      workspace_id || DEFAULT_WORKSPACE_ID,
    );

    return success(result, "Answer generated successfully");
  } catch (error) {
    return handleError(error);
  }
}
