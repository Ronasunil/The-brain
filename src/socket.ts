import http from "node:http";
import { Server, Socket } from "socket.io";
import jwt from "jsonwebtoken";
import cookie from "cookie-parser";
import { env } from "./config/env";
import { COOKIE_NAME } from "./lib/constants/auth.constants";
import { JwtPayload, UserResponse } from "./lib/types/auth.types";
import { AuthRepository } from "./db/auth.repository";
import { UserRepository } from "./db/user.repository";
import { WorkspaceService } from "./services/workspace.service";
import { ChatService } from "./services/chat.service";
import { TicketCreationService } from "./services/ticket-creation.service";
import { TicketIntentService } from "./services/ticket-intent.service";
import { AppError } from "./lib/errors/app-error";
import { ChatMessageRepository } from "./db/chat-message.repository";

interface SocketData {
  user: UserResponse;
}

/**
 * Detects @brain as a standalone mention in normal chat text.
 * Supports start-of-line and whitespace-separated mentions.
 */
const BRAIN_TRIGGER = /(^|\s)@brain(?=\s|$|[.,!?;:])/i;

/** Explicit prefix trigger for ticket creation. */
const TICKET_TRIGGER = /^@ticket(?=\s|$)/i;

/** Matches a standalone cancel / /cancel reply that aborts an in-flight draft. */
const CANCEL_RE = /^\s*\/?cancel\s*$/i;

function extractBrainQuestion(content: string): string | null {
  if (!BRAIN_TRIGGER.test(content)) return null;
  return (
    content
      .replace(BRAIN_TRIGGER, " ")
      .replace(/\s+/g, " ")
      .trim() || null
  );
}

function extractTicketRequest(
  content: string,
): { title: string; description: string } | null {
  if (!TICKET_TRIGGER.test(content)) return null;
  const body = content.replace(TICKET_TRIGGER, "").trim();
  if (!body) return null;
  const firstLine = body.split(/\r?\n/)[0]?.trim() ?? body;
  return { title: firstLine, description: body };
}

/**
 * Parse the JWT cookie from the Socket.IO handshake and authenticate.
 */
async function authenticateSocket(
  socket: Socket,
): Promise<UserResponse | null> {
  const rawCookies = socket.handshake.headers.cookie;
  if (!rawCookies) return null;

  const cookies = parseCookies(rawCookies);
  const token = cookies[COOKIE_NAME];
  if (!token) return null;

  let decoded: JwtPayload;
  try {
    decoded = jwt.verify(token, env.JWT_SECRET) as JwtPayload;
  } catch {
    return null;
  }

  const auth = await AuthRepository.findByUserId(decoded.userId);
  if (!auth || !auth.is_valid) return null;

  if (auth.password_changed_at && decoded.iat) {
    const changedAt = Math.floor(
      new Date(auth.password_changed_at).getTime() / 1000,
    );
    if (changedAt > decoded.iat) return null;
  }

  const user = await UserRepository.findById(decoded.userId);
  if (!user) return null;

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    avatar_url: user.avatar_url,
    phone: user.phone,
    created_at: user.created_at,
  };
}

/**
 * Persist an error as a bot chat message and broadcast it. Converts AppError
 * messages (user-friendly) directly; anything else becomes a generic line so
 * we never leak stack traces into chat.
 */
async function emitBotError(
  io: Server,
  room: string,
  workspaceId: string,
  err: unknown,
): Promise<void> {
  const message =
    err instanceof AppError
      ? err.message
      : "Something went wrong processing that. Please try again.";
  if (!(err instanceof AppError)) {
    console.error("⚠️ ticket flow unexpected error:", err);
  }
  try {
    const bot = await ChatMessageRepository.create({
      workspace_id: workspaceId,
      user_id: null,
      user_name: "ticket-bot",
      role: "assistant",
      content: message,
      sources: null,
    });
    io.to(room).emit("chat:message", bot);
  } catch (persistErr) {
    console.error("⚠️ failed to persist bot error message:", persistErr);
  }
}

function parseCookies(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of raw.split(";")) {
    const idx = pair.indexOf("=");
    if (idx < 0) continue;
    const key = pair.slice(0, idx).trim();
    const val = decodeURIComponent(pair.slice(idx + 1).trim());
    result[key] = val;
  }
  return result;
}

export function initSocketIO(httpServer: http.Server): Server {
  const io = new Server<Record<string, never>, Record<string, never>, Record<string, never>, SocketData>(httpServer, {
    cors: {
      origin: env.CLIENT_ORIGIN,
      credentials: true,
    },
  });

  // ─── Auth middleware ────────────────────────
  io.use(async (socket, next) => {
    try {
      const user = await authenticateSocket(socket);
      if (!user) {
        return next(new Error("Authentication required"));
      }
      socket.data.user = user;
      next();
    } catch {
      next(new Error("Authentication failed"));
    }
  });

  // ─── Connection handler ─────────────────────
  io.on("connection", (socket) => {
    const user = socket.data.user!;
    console.log(`🔌 Socket connected: ${user.name} (${user.id})`);

    // ── Join workspace room ──
    socket.on("chat:join", async (payload, callback) => {
      try {
        const { workspaceId } = payload;
        if (!workspaceId) {
          callback?.({ error: "workspaceId is required" });
          return;
        }

        await WorkspaceService.assertOwnership(user.id, workspaceId);
        const room = `workspace:${workspaceId}`;
        socket.join(room);
        callback?.({ ok: true });
      } catch (err: any) {
        callback?.({ error: err.message ?? "Access denied" });
      }
    });

    // ── Send a message ──
    socket.on("chat:send", async (payload) => {
      try {
        const { content, workspaceId } = payload;
        if (!content || !workspaceId) return;

        const room = `workspace:${workspaceId}`;
        if (!socket.rooms.has(room)) return;

        const chatMsg = await ChatService.sendMessage(
          workspaceId,
          user.id,
          user.name,
          content,
        );

        io.to(room).emit("chat:message", chatMsg);

        // 1. Cancel command short-circuits everything.
        if (CANCEL_RE.test(content)) {
          const bot = await TicketCreationService.cancelDraft(
            workspaceId,
            user.id,
          );
          if (bot) io.to(room).emit("chat:message", bot);
          return;
        }

        // 2. Active draft? Route this message as a stage response.
        if (TicketCreationService.hasDraft(workspaceId, user.id)) {
          try {
            const bot = await TicketCreationService.handleResponse({
              workspaceId,
              userId: user.id,
              userName: user.name,
              content,
            });
            io.to(room).emit("chat:message", bot);
          } catch (err) {
            await emitBotError(io, room, workspaceId, err);
          }
          return;
        }

        // 3. Explicit @ticket trigger.
        const ticket = extractTicketRequest(content);
        if (ticket) {
          try {
            const bot = await TicketCreationService.startDraft({
              workspaceId,
              userId: user.id,
              userName: user.name,
              userEmail: user.email ?? null,
              title: ticket.title,
              description: ticket.description,
            });
            io.to(room).emit("chat:message", bot);
          } catch (err) {
            await emitBotError(io, room, workspaceId, err);
          }
          return;
        }

        // 4. @brain trigger — classify in parallel for ticket-creation intent
        //    alongside the existing Q&A path.
        const question = extractBrainQuestion(content);
        if (question) {
          io.to(room).emit("chat:brain-thinking", { workspaceId });

          try {
            const intent = await TicketIntentService.classify(question);
            if (intent.intent === "create_ticket") {
              const bot = await TicketCreationService.startDraft({
                workspaceId,
                userId: user.id,
                userName: user.name,
                userEmail: user.email ?? null,
                title: intent.title,
                description: intent.description ?? question,
              });
              io.to(room).emit("chat:message", bot);
              return;
            }

            const assistantMsg = await ChatService.askBrain(
              workspaceId,
              question,
            );
            io.to(room).emit("chat:message", assistantMsg);
          } catch (err) {
            if (err instanceof AppError) {
              await emitBotError(io, room, workspaceId, err);
            } else {
              console.error("⚠️ @brain query failed:", err);
              io.to(room).emit("chat:brain-error", {
                workspaceId,
                error: "Brain failed to process the query. Please try again.",
              });
            }
          }
        }
      } catch (err) {
        console.error("⚠️ chat:send error:", err);
      }
    });

    // ── Typing indicator ──
    socket.on("chat:typing", (payload) => {
      const { workspaceId } = payload;
      if (!workspaceId) return;

      const room = `workspace:${workspaceId}`;
      if (!socket.rooms.has(room)) return;

      socket.to(room).emit("chat:user-typing", {
        userId: user.id,
        userName: user.name,
      });
    });

    // ── Load history ──
    socket.on("chat:history", async (payload, callback) => {
      try {
        const { workspaceId, before, limit } = payload;
        if (!workspaceId) {
          callback?.({ error: "workspaceId is required" });
          return;
        }

        const room = `workspace:${workspaceId}`;
        if (!socket.rooms.has(room)) {
          callback?.({ error: "Join the workspace first" });
          return;
        }

        const result = await ChatService.getHistory(workspaceId, before, limit);
        callback?.(result);
      } catch (err: any) {
        callback?.({ error: err.message ?? "Failed to load history" });
      }
    });

    socket.on("disconnect", () => {
      console.log(`🔌 Socket disconnected: ${user.name} (${user.id})`);
    });
  });

  return io;
}
