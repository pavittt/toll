import cors from "cors";
import express from "express";
import { DEFAULT_TASK, SAMPLE_TASKS, runAgent } from "./agent.ts";

/** Lets the dashboard start the agent and stream what it does (Server-Sent Events). */
const app = express();
app.use(cors());
app.use(express.json());

let running = false;

app.get("/run", async (req, res) => {
  if (running) {
    res.status(409).json({ error: "The agent is already running." });
    return;
  }
  running = true;
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (kind: string, text: string) => res.write(`data: ${JSON.stringify({ kind, text, ts: new Date().toISOString() })}\n\n`);
  const task = String(req.query.task ?? "").trim() || DEFAULT_TASK;
  send("task", task);
  try {
    const { receipts } = await runAgent(task, send);
    send("done", JSON.stringify(receipts));
  } catch (err) {
    send("error", err instanceof Error ? err.message : String(err));
  } finally {
    running = false;
    res.end();
  }
});

app.get("/tasks", (_req, res) => res.json({ tasks: SAMPLE_TASKS }));

const port = Number(process.env.AGENT_PORT ?? 4100);
app.listen(port, () => console.log(`[agent] ready on http://localhost:${port} (start a run from the dashboard)`));
