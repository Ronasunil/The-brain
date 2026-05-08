import { z } from "zod";
import {
  OPERATIONAL_MEMORY_KINDS,
  OPERATIONAL_MEMORY_STATUSES,
} from "../types";

export const updateOperationalMemorySchema = z
  .object({
    title: z.string().min(1).max(180).optional(),
    summary: z.string().max(1000).optional(),
    body: z.string().max(12000).optional(),
    status: z.enum(OPERATIONAL_MEMORY_STATUSES).optional(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required",
  });

export const listOperationalMemoryQuerySchema = z.object({
  status: z.enum(OPERATIONAL_MEMORY_STATUSES).optional(),
  kind: z.enum(OPERATIONAL_MEMORY_KINDS).optional(),
});

export type UpdateOperationalMemoryPayload = z.infer<
  typeof updateOperationalMemorySchema
>;
