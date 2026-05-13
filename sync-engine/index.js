import "dotenv/config";
import { supabase } from "./supabase.js";

import { projectRefreshSeconds, syncIntervalSeconds } from "./config.js";
import { loadProjectsFromSupabase } from "./projects.js";
import { reconcileWatchers } from "./watcher.js";
import { startSyncLoop } from "./sync.js";

async function refresh() {
  const list = await loadProjectsFromSupabase();
  await reconcileWatchers(list);
}

console.log("[engine] starting sync engine");

await refresh();
console.log(
  `[engine] sync every ${syncIntervalSeconds}s, project list refresh every ${projectRefreshSeconds}s`,
);

setInterval(() => {
  refresh().catch((err) => {
    console.error("[engine] project refresh error:", err.message);
  });
}, projectRefreshSeconds * 1000);

startSyncLoop();

