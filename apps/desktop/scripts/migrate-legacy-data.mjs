import { copyFile, cp, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

const [sourceDirectory, desktopDataDirectory] = process.argv.slice(2);

if (!sourceDirectory || !desktopDataDirectory) {
  throw new Error("Usage: node migrate-legacy-data.mjs <source-directory> <desktop-data-directory>");
}

const source = path.resolve(sourceDirectory);
const destination = path.resolve(desktopDataDirectory);
const sourceDatabase = path.join(source, "tk-automation.db");
const sourceCredentials = path.join(source, "credentials");
const targetDatabase = path.join(destination, "tk-automation.db");
const targetCredentials = path.join(destination, "credentials");
const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const backupDirectory = path.join(path.dirname(destination), "backups", `pre-v1.0.0-migration-${timestamp}`);
const snapshotDatabase = path.join(destination, `tk-automation.snapshot.${timestamp}.db`);

await stat(sourceDatabase);
await stat(sourceCredentials);
await mkdir(destination, { recursive: true });
await mkdir(backupDirectory, { recursive: true });

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

for (const name of ["tk-automation.db", "tk-automation.db-wal", "tk-automation.db-shm"]) {
  const current = path.join(destination, name);
  if (await exists(current)) {
    await copyFile(current, path.join(backupDirectory, name));
  }
}

if (await exists(targetCredentials)) {
  await cp(targetCredentials, path.join(backupDirectory, "credentials"), { recursive: true });
}

const database = new DatabaseSync(sourceDatabase);
const escapedSnapshotPath = snapshotDatabase.replaceAll("\\", "/").replaceAll("'", "''");
try {
  database.exec(`VACUUM INTO '${escapedSnapshotPath}'`);
} finally {
  database.close();
}

await copyFile(snapshotDatabase, targetDatabase);
await rm(snapshotDatabase);

for (const suffix of ["-wal", "-shm"]) {
  const sidecar = `${targetDatabase}${suffix}`;
  if (await exists(sidecar)) {
    await rename(sidecar, path.join(backupDirectory, path.basename(sidecar)));
  }
}

if (await exists(targetCredentials)) {
  await rename(targetCredentials, path.join(backupDirectory, "credentials-original"));
}
await cp(sourceCredentials, targetCredentials, { recursive: true });

console.log("Legacy desktop data migration completed.");
console.log(`Backup: ${backupDirectory}`);
console.log(`Destination: ${destination}`);
