/**
 * Re-export shim. The ask pipeline lives in `./ask/`. Three importers
 * still reach `./brain.service` (controllers/brain.controller.ts,
 * services/chat.service.ts, services/telegram.service.ts) so this file
 * exists to keep their import paths stable.
 *
 * Open `./ask/index.ts` for the orchestrator.
 */
export { BrainService } from "./ask";
