import { success, handleError } from "@/lib/api-utils";
import { MessageService } from "@/services/message.service";
import { DEFAULT_WORKSPACE_ID } from "@/lib/constants/app.constants";

export async function GET() {
  try {
    const messageCount = await MessageService.getCount(DEFAULT_WORKSPACE_ID);

    return success(
      {
        service: "orgbrain",
        version: "0.2.0",
        uptime: process.uptime(),
        messages_stored: messageCount,
      },
      "OrgBrain is running",
    );
  } catch (error) {
    return handleError(error);
  }
}
