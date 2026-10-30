// Reprise des données : copie une ancienne base SQLite (prod.db) dans la base PostgreSQL.
//
// Règles de sécurité :
//  - le fichier SQLite est ouvert en LECTURE SEULE et n'est jamais modifié ni supprimé ;
//  - la copie ne se fait que si la base PostgreSQL est vide (aucun utilisateur) ;
//  - tout se fait dans une seule transaction : en cas d'erreur, PostgreSQL reste vide et rien n'est perdu ;
//  - à la fin, chaque table est recomptée : le nombre de lignes doit être identique des deux côtés.
//
// Utilisation manuelle : node prisma/import-sqlite.js /chemin/vers/prod.db
// (prisma-check.js l'appelle tout seul au premier démarrage sur PostgreSQL si /app/data/prod.db existe.)
import fs from "fs";
import { DatabaseSync } from "node:sqlite";
import { PrismaClient, Prisma } from "@prisma/client";

const CHUNK = 500;

// Ordre d'insertion : une table passe après les tables qu'elle référence (clés étrangères).
// Deux tables qui se référencent l'une l'autre (ex. User.departement_id et Departement.responsable_id)
// forment un cycle : on le casse sur une clé facultative, copiée vide puis remplie à la fin (deferred).
export function insertionOrder(models, deferred = []) {
  const edges = new Map(models.map((m) => [m.name, m.fields
    .filter((f) => f.kind === "object" && f.relationFromFields && f.relationFromFields.length && f.type !== m.name)
    .map((f) => ({ to: f.type, fields: f.relationFromFields, optional: !f.isRequired }))]));
  const done = [], seen = new Set();
  const visit = (name, path = []) => {
    if (seen.has(name)) return;
    if (path.includes(name)) {
      // le cycle passe par path[i] → … → name : on retire une relation facultative de ce cycle
      const cyc = [...path.slice(path.indexOf(name)), name];
      for (let i = 0; i < cyc.length - 1; i++) {
        const e = (edges.get(cyc[i]) || []).find((x) => x.to === cyc[i + 1] && x.optional);
        if (e) { edges.set(cyc[i], edges.get(cyc[i]).filter((x) => x !== e)); deferred.push({ model: cyc[i], fields: e.fields }); throw { restart: true }; }
      }
      throw new Error(`Cycle de clés étrangères obligatoires : ${cyc.join(" → ")}`);
    }
    for (const e of edges.get(name) || []) visit(e.to, [...path, name]);
    seen.add(name); done.push(name);
  };
  for (;;) {
    done.length = 0; seen.clear();
    try { models.forEach((m) => visit(m.name)); break; }
    catch (e) { if (!e || !e.restart) throw e; }
  }
  return done.map((n) => models.find((m) => m.name === n));
}

// SQLite (Prisma) range les dates en millisecondes et les booléens en 0/1
export function convert(field, v) {
  if (v === null || v === undefined) return null;
  switch (field.type) {
    case "DateTime": return new Date(typeof v === "number" || /^\d+$/.test(String(v)) ? Number(v) : v); // ms (SQLite) ou ISO (sauvegarde)
    case "Boolean": return v === 1 || v === true || v === "1" || v === "true";
    case "Int": return Number(v);
    case "Float": case "Decimal": return Number(v);
    case "BigInt": return BigInt(v);
    case "Json": return typeof v === "string" ? JSON.parse(v) : v;
    default: return typeof v === "string" ? v : String(v);
  }
}

export async function importSqlite(sqlitePath, { log = console.log } = {}) {
  if (!fs.existsSync(sqlitePath)) throw new Error(`Fichier introuvable : ${sqlitePath}`);
  const head = Buffer.alloc(16); const fd = fs.openSync(sqlitePath, "r"); fs.readSync(fd, head, 0, 16, 0); fs.closeSync(fd);
  if (head.toString("utf-8", 0, 15) !== "SQLite format 3") throw new Error(`${sqlitePath} n'est pas une base SQLite.`);

  const src = new DatabaseSync(sqlitePath, { readOnly: true });
  const prisma = new PrismaClient();
  try {
    const users = await prisma.user.count();
    if (users > 0) throw new Error(`La base PostgreSQL contient déjà ${users} utilisateur(s) : reprise annulée pour ne rien écraser.`);

    const tables = new Set(src.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    const deferred = [];
    const models = insertionOrder(Prisma.dmmf.datamodel.models, deferred);
    const report = [];

    await prisma.$transaction(async (tx) => {
      const pending = [];
      for (const m of models) {
        const table = m.dbName || m.name;
        if (!tables.has(table)) { report.push([m.name, 0, "absente de l'ancienne base"]); continue; }
        const cols = new Set(src.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name));
        const scalars = m.fields.filter((f) => (f.kind === "scalar" || f.kind === "enum") && cols.has(f.dbName || f.name));
        const rows = src.prepare(`SELECT * FROM "${table}"`).all();
        const later = new Set(deferred.filter((d) => d.model === m.name).flatMap((d) => d.fields).filter((f) => cols.has(f)));
        const delegate = tx[m.name.charAt(0).toLowerCase() + m.name.slice(1)];
        for (let i = 0; i < rows.length; i += CHUNK) {
          const data = rows.slice(i, i + CHUNK).map((r) => Object.fromEntries(scalars.map((f) => [f.name, later.has(f.name) ? null : convert(f, r[f.dbName || f.name])])));
          await delegate.createMany({ data });
        }
        // Les identifiants auto-incrémentés repartent après le plus grand id copié
        const idField = m.fields.find((f) => f.isId && f.type === "Int" && f.hasDefaultValue);
        if (idField && rows.length) {
          await tx.$executeRawUnsafe(`SELECT setval(pg_get_serial_sequence('"${table}"', '${idField.dbName || idField.name}'), (SELECT MAX("${idField.dbName || idField.name}") FROM "${table}"))`);
        }
        report.push([m.name, rows.length, ""]);
        if (later.size) pending.push({ m, table, later, rows });
      }
      // Clés des cycles : remplies une fois toutes les tables copiées
      for (const { m, later, rows } of pending) {
        const idField = m.fields.find((f) => f.isId);
        const delegate = tx[m.name.charAt(0).toLowerCase() + m.name.slice(1)];
        const fields = m.fields.filter((f) => later.has(f.name));
        for (const r of rows) {
          const data = Object.fromEntries(fields.map((f) => [f.name, convert(f, r[f.dbName || f.name])]));
          if (Object.values(data).every((v) => v === null)) continue;
          await delegate.update({ where: { [idField.name]: convert(idField, r[idField.dbName || idField.name]) }, data });
        }
      }
      // Contrôle : mêmes nombres de lignes des deux côtés
      for (const [name, n, note] of report) {
        if (note) continue;
        const got = await tx[name.charAt(0).toLowerCase() + name.slice(1)].count();
        if (got !== n) throw new Error(`Contrôle échoué pour ${name} : ${n} lignes dans SQLite, ${got} dans PostgreSQL.`);
      }
    }, { timeout: 30 * 60 * 1000, maxWait: 60 * 1000 });

    const total = report.reduce((t, r) => t + r[1], 0);
    log(`✅ [IMPORT] ${total} lignes copiées depuis ${sqlitePath} (${report.filter((r) => r[1]).length} tables), nombres de lignes vérifiés.`);
    report.filter((r) => r[1]).forEach(([name, n]) => log(`   ${name.padEnd(22)} ${n}`));
    return report;
  } finally {
    src.close();
    await prisma.$disconnect();
  }
}

// Appel direct : node prisma/import-sqlite.js /app/data/prod.db
if (process.argv[1] && process.argv[1].endsWith("import-sqlite.js")) {
  importSqlite(process.argv[2] || "/app/data/prod.db").then(() => process.exit(0)).catch((e) => {
    console.error(`❌ [IMPORT] ${e.message}`);
    console.error("❌ [IMPORT] Rien n'a été écrit dans PostgreSQL. Le fichier SQLite n'a pas été modifié.");
    process.exit(1);
  });
}
