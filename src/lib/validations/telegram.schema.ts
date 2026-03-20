import { z } from "zod";

/**
 * Telegram webhook update schema.
 * We only care about text messages for V1.
 */
export const telegramUpdateSchema = z.object({
  update_id: z.number(),
  message: z
    .object({
      message_id: z.number(),
      from: z
        .object({
          id: z.number(),
          first_name: z.string().optional(),
          last_name: z.string().optional(),
          username: z.string().optional(),
        })
        .optional(),
      chat: z.object({
        id: z.number(),
        title: z.string().optional(),
        type: z.string(),
      }),
      date: z.number(),
      text: z.string().optional(),
    })
    .optional(),
});

export type TelegramUpdate = z.infer<typeof telegramUpdateSchema>;
