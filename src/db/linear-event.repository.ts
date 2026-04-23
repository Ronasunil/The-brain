import { getSupabaseClient } from "./client";
import { AppError } from "../lib/errors/app-error";

export interface PersistedLinearEvent {
  id: string;
  integration_id: string;
  payload: Record<string, unknown>;
  received_at: Date;
  attempts: number;
}

function mapRow(row: any): PersistedLinearEvent {
  return {
    id: row.id,
    integration_id: row.integration_id,
    payload: row.payload ?? {},
    received_at: new Date(row.received_at),
    attempts: row.attempts ?? 0,
  };
}

export const LinearEventRepository = {
  async enqueue(
    integrationId: string,
    payload: Record<string, unknown>,
  ): Promise<PersistedLinearEvent> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from("linear_events")
      .insert({ integration_id: integrationId, payload })
      .select()
      .single();
    if (error) {
      throw new AppError(`Failed to enqueue Linear event: ${error.message}`, 500);
    }
    return mapRow(data);
  },

  async pendingBatch(limit: number = 25): Promise<PersistedLinearEvent[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from("linear_events")
      .select()
      .is("processed_at", null)
      .order("received_at", { ascending: true })
      .limit(limit);
    if (error) {
      throw new AppError(
        `Failed to fetch pending Linear events: ${error.message}`,
        500,
      );
    }
    return (data ?? []).map(mapRow);
  },

  async markProcessed(eventId: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from("linear_events")
      .update({ processed_at: new Date().toISOString() })
      .eq("id", eventId);
    if (error) {
      throw new AppError(
        `Failed to mark Linear event processed: ${error.message}`,
        500,
      );
    }
  },

  async markFailed(eventId: string, reason: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase.rpc("linear_event_record_failure", {
      event_id_in: eventId,
      reason_in: reason,
    });
    if (error) {
      // RPC is nice-to-have; fall back to direct UPDATE if it doesn't exist.
      const { error: fallback } = await supabase
        .from("linear_events")
        .update({ last_error: reason })
        .eq("id", eventId);
      if (fallback) {
        console.warn(
          `Failed to record failure on Linear event ${eventId}: ${fallback.message}`,
        );
      }
    }
  },

  async pendingCount(): Promise<number> {
    const supabase = getSupabaseClient();
    const { count, error } = await supabase
      .from("linear_events")
      .select("*", { count: "exact", head: true })
      .is("processed_at", null);
    if (error) return 0;
    return count ?? 0;
  },
};
