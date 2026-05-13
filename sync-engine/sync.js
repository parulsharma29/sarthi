import fs from "fs/promises";
import path from "path";
import { syncIntervalSeconds } from "./config.js";
import { addChange, getChanges, clearChanges } from "./memory.js";
import { supabase } from "./supabase.js";
import { getWatchedProjects } from "./projects.js";
import {
  bufferToDbContent,
  removeProjectFileObject,
  uploadProjectFileObject,
} from "./storage.js";

function toPosix(rel) {
  return rel.split(path.sep).join("/");
}

/**
 * @param {string} projectId
 * @param {string} rootAbs
 * @param {{ file_name: string, change_type: string, timestamp: string }[]} batch
 */
async function applyProjectFiles(userId, projectId, rootAbs, batch) {
  for (const c of batch) {
    const filePath = toPosix(c.file_name);
    if (c.change_type === "delete") {
      await removeProjectFileObject(userId, projectId, filePath);
      const { error } = await supabase
        .from("project_files")
        .delete()
        .eq("project_id", projectId)
        .eq("path", filePath);
      if (error) throw new Error(`delete ${filePath}: ${error.message}`);
      continue;
    }

    const abs = path.join(rootAbs, ...filePath.split("/"));
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    let buffer;
    try {
      buffer = await fs.readFile(abs);
    } catch {
      const content = "[unreadable or binary file]";
      const { error } = await supabase.from("project_files").upsert(
        {
          project_id: projectId,
          path: filePath,
          content,
          storage_path: null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "project_id,path" },
      );
      if (error) throw new Error(`upsert ${filePath}: ${error.message}`);
      continue;
    }

    const { content } = bufferToDbContent(buffer);
    const storagePath = await uploadProjectFileObject({
      userId,
      projectId,
      filePath,
      buffer,
    });

    const { error } = await supabase.from("project_files").upsert(
      {
        project_id: projectId,
        path: filePath,
        content,
        storage_path: storagePath,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "project_id,path" },
    );
    if (error) throw new Error(`upsert ${filePath}: ${error.message}`);
  }
}

/**
 * @param {string} projectId
 * @param {string} rootAbs
 */
async function syncProject(projectId, rootAbs) {
  const batch = getChanges(projectId);
  if (batch.length === 0) return;

  const userId = process.env.SYNC_USER_ID?.trim();
  if (!userId) return;

  clearChanges(projectId);

  try {
    await applyProjectFiles(userId, projectId, rootAbs, batch);
  } catch (err) {
    console.error(err.message);
    return;
  }

  // 👇 THIS MUST BE AFTER applyProjectFiles
  const rows = batch.map((c) => ({
    project_id: projectId,
    file_path: toPosix(c.file_name),
    file_name: toPosix(c.file_name),
    change_type: c.change_type,
  }));

  const { error } = await supabase.from("changes").insert(rows);

  if (error) {
    console.error("[sync] changes insert failed:", error.message);
    return;
  }

  console.log(`[sync] completed for "${projectId}"`);
}

async function runSyncTick() {
  const projects = getWatchedProjects();
  const hasWork = projects.some((p) => getChanges(p.id).length > 0);
  if (!hasWork) {
    console.log("[sync] no changes found");
    return;
  }

  console.log("[sync] starting batch…");
  for (const p of projects) {
    await syncProject(p.id, p.root);
  }
  console.log("[sync] batch finished");
}

export function startSyncLoop() {
  const ms = syncIntervalSeconds * 1000;
  const tick = () => {
    runSyncTick().catch((err) => {
      console.error("[sync] tick error:", err.message);
    });
  };
  tick();
  setInterval(tick, ms);
}