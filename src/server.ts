import { createYachtApplication } from "./app.js";

const PORT = 3000;
const application = createYachtApplication();

await application.listen(PORT, "0.0.0.0");
console.log(`Yacht Dice Online listening on port ${PORT}`);

let shuttingDown = false;

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const forceExitTimer = setTimeout(() => process.exit(1), 5_000);
  forceExitTimer.unref();
  await application.close();
  clearTimeout(forceExitTimer);
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
