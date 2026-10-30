// Restauration d'une sauvegarde (.json.gz produite par l'ERP) dans une base PostgreSQL VIDE.
// Utilisation : node prisma/restore-backup.js /app/data/backups/ym-backup-2026-10-21-02-00.json.gz
// Sécurité : refuse si la base contient déjà des utilisateurs ; tout se fait dans une transaction,
// et le nombre de lignes de chaque table est vérifié avant validation.
import fs from "fs";
import zlib from "zlib";
import { PrismaClient, Prisma } from "@prisma/client";
import { insertionOrder, convert } from "./import-sqlite.js";

const CHUNK = 500;

export async function restoreBackup(file, { log = console.log } = {}) {
  const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString("utf-8"));
  if (data.format !== "ym-backup") throw new Error(`${file} n'est pas une sauvegarde YM-TRANSIT.`);
  const prisma = new PrismaClient();
  try {
    const users = await prisma.user.count();
    if (users > 0) throw new Error(`La base contient déjà ${users} utilisateur(s) : restauration annulée pour ne rien écraser. Restaurez dans une base vide.`);
    const deferred = []; // clés des cycles (ex. User.departement_id), remplies à la fin
    const models = insertionOrder(Prisma.dmmf.datamodel.models, deferred);
    let total = 0;
    await prisma.$transaction(async (tx) => {
      const pending = [];
      for (const m of models) {
        const later = new Set(deferred.filter((x) => x.model === m.name).flatMap((x) => x.fields));
        const rows = data.tables[m.name] || [];
        const scalars = m.fields.filter((f) => f.kind === "scalar" || f.kind === "enum");
        const d = tx[m.name.charAt(0).toLowerCase() + m.name.slice(1)];
        for (let i = 0; i < rows.length; i += CHUNK) {
          await d.createMany({ data: rows.slice(i, i + CHUNK).map((r) => Object.fromEntries(scalars.filter((f) => f.name in r).map((f) => [f.name, later.has(f.name) ? null : convert(f, r[f.name])]))) });
        }
        if (later.size && rows.length) pending.push({ m, d, later, rows });
        const idField = m.fields.find((f) => f.isId && f.type === "Int" && f.hasDefaultValue);
        const table = m.dbName || m.name;
        if (idField && rows.length) await tx.$executeRawUnsafe(`SELECT setval(pg_get_serial_sequence('"${table}"', '${idField.dbName || idField.name}'), (SELECT MAX("${idField.dbName || idField.name}") FROM "${table}"))`);
        const got = await d.count();
        if (got !== rows.length) throw new Error(`Contrôle échoué pour ${m.name} : ${rows.length} attendues, ${got} trouvées.`);
        total += rows.length;
      }
      for (const { m, d, later, rows } of pending) {
        const idField = m.fields.find((f) => f.isId);
        const fields = m.fields.filter((f) => later.has(f.name));
        for (const r of rows) {
          const v = Object.fromEntries(fields.filter((f) => r[f.name] != null).map((f) => [f.name, convert(f, r[f.name])]));
          if (Object.keys(v).length) await d.update({ where: { [idField.name]: convert(idField, r[idField.name]) }, data: v });
        }
      }
    }, { timeout: 30 * 60 * 1000, maxWait: 60 * 1000 });
    log(`✅ [RESTAURATION] ${total} lignes restaurées depuis ${file} (sauvegarde du ${data.created_at}), nombres de lignes vérifiés.`);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && process.argv[1].endsWith("restore-backup.js")) {
  if (!process.argv[2]) { console.error("Usage : node prisma/restore-backup.js <fichier .json.gz>"); process.exit(1); }
  restoreBackup(process.argv[2]).then(() => process.exit(0)).catch((e) => {
    console.error(`❌ [RESTAURATION] ${e.message}`);
    console.error("❌ [RESTAURATION] Rien n'a été écrit (transaction annulée).");
    process.exit(1);
  });
}
