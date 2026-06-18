import { Hono } from "hono";
import { copilotToOpenAIHandler } from "./copilot-to-openai";

const app = new Hono();
copilotToOpenAIHandler("/", app);

export default {
  port: 8318,
  fetch: app.fetch,
  idleTimeout: 255,
};
