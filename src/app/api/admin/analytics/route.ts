import { success, handleError } from "@/lib/api-utils";
import { AnalyticsService } from "@/services/analytics.service";

export async function GET() {
  try {
    const data = await AnalyticsService.getAdminSnapshot();
    return success(data, "Analytics loaded");
  } catch (error) {
    return handleError(error);
  }
}
