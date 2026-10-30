import fs from "fs";
import path from "path";
import zlib from "zlib";
import { Prisma } from "@prisma/client";
import { basePrisma } from "./prismaClient";

// Sauvegarde automatique des données : un fichier .json.gz par jour, toutes les tables, rangé dans
// BACKUP_PATH (par défaut /app/data/backups, sur le volume persistant). Les 14 derniers sont gardés.
// Restauration dans une base vide : node prisma/restore-backup.js <fichier>
export const backupDir = () => process.env.BACKUP_PATH || path.join(process.env.DATA_PATH || "/app/data", "backups");
const KEEP = () => Math.max(3, parseInt(process.env.BACKUP_KEEP || "14", 10));
const PAGE = 2000;

export interface BackupFile { name: string; size: number; at: Date }

export function listBackups(): BackupFile[] {
  const dir = backupDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^ym-backup-.*\.json\.gz$/.test(f))
    .map((name) => { const st = fs.statSync(path.join(dir, name)); return { name, size: st.size, at: st.mtime }; })
    .sort((a, b) => b.at.getTime() - a.at.getTime());
}

const delegate = (name: string) => (basePrisma as any)[name.charAt(0).toLowerCase() + name.slice(1)];

export async function createBackup(reason = "auto"): Promise<BackupFile> {
  const dir = backupDir();
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const name = `ym-backup-${stamp}${reason === "manuel" ? "-manuel" : ""}.json.gz`;
  const tmp = path.join(dir, `.${name}.tmp`);
  const gz = zlib.createGzip({ level: 6 });
  const out = fs.createWriteStream(tmp);
  gz.pipe(out);
  const write = (s: string) => new Promise<void>((ok) => (gz.write(s) ? ok() : gz.once("drain", () => ok())));

  const models = Prisma.dmmf.datamodel.models;
  const counts: Record<string, number> = {};
  await write(`{"format":"ym-backup","version":1,"created_at":${JSON.stringify(new Date().toISOString())},"tables":{`);
  for (let i = 0; i < models.length; i++) {
    const m = models[i];
    const idField = m.fields.find((f) => f.isId);
    await write(`${i ? "," : ""}${JSON.stringify(m.name)}:[`);
    let n = 0, cursor: any = undefined;
    for (;;) {
      const rows: any[] = await delegate(m.name).findMany({
        take: PAGE, ...(idField ? { orderBy: { [idField.name]: "asc" } } : {}),
        ...(cursor !== undefined && idField ? { skip: 1, cursor: { [idField.name]: cursor } } : {}),
      });
      for (const r of rows) { await write((n ? "," : "") + JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v))); n++; }
      if (rows.length < PAGE || !idField) break;
      cursor = rows[rows.length - 1][idField.name];
    }
    counts[m.name] = n;
    await write("]");
  }
  await write(`},"counts":${JSON.stringify(counts)}}`);
  await new Promise<void>((ok, ko) => { out.on("finish", () => ok()); out.on("error", ko); gz.end(); });
  fs.renameSync(tmp, path.join(dir, name));

  // On garde les plus récentes
  listBackups().slice(KEEP()).forEach((b) => fs.rmSync(path.join(dir, b.name), { force: true }));
  const st = fs.statSync(path.join(dir, name));
  console.log(`[SAUVEGARDE] ${name} (${Math.round(st.size / 1024)} Ko, ${Object.values(counts).reduce((a, b) => a + b, 0)} lignes)`);
  return { name, size: st.size, at: st.mtime };
}

// Appelée par le planificateur : une sauvegarde par jour, à partir de 2 h du matin
let busy = false;
export async function dailyBackupIfDue() {
  if (busy || process.env.BACKUP_DISABLED === "true") return;
  const now = new Date();
  if (now.getHours() < 2) return;
  const today = now.toDateString();
  if (listBackups().some((b) => !b.name.includes("-manuel") && b.at.toDateString() === today)) return;
  busy = true;
  try { await createBackup("auto"); } catch (e) { console.error("[SAUVEGARDE] Échec :", e); } finally { busy = false; }
}
