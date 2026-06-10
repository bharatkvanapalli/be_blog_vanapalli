import { handle } from "hono/aws-lambda";
import { app } from "../app.js";

// API Gateway v2 → Hono. Single event shape (no AppSync) so this is just
// the adapter — no event-type detection needed.
export const handler = handle(app);
