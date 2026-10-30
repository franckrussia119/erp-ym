import fs from "fs";
import path from "path";
import { execSync } from "child_process";

// Vérification de la base de données avant le démarrage du serveur.
//
// Règles de sécurité :
//  - la base est PostgreSQL (DATABASE_URL) ; il ne bascule JAMAIS silencieusement sur une autre base ;
//  - l'ancienne base SQLite (/app/data/prod.db) n'est jamais modifiée ni supprimée : elle est seulement
//    recopiée une fois dans PostgreSQL quand celui-ci est vide ;
//  - il n'utilise pas --accept-data-loss : une modification du schéma qui détruirait
//    des données fait échouer le démarrage au lieu d'effacer ces données.
// En cas de problème, le script s'arrête avec un code d'erreur et un message clair,
// et le serveur ne démarre pas sur une base vide ou incorrecte.

console.log("🚀 [PRISMA-CHECK] Vérification de la base de données...");

function fail(message) {
  console.error(`❌ [PRISMA-CHECK] ${message}`);
  console.error("❌ [PRISMA-CHECK] Démarrage interrompu. Aucune donnée n'a été supprimée.");
  process.exit(1);
}

// 1. DATABASE_URL : une base PostgreSQL est obligatoire
const dbUrl = process.env.DATABASE_URL || "";
if (!dbUrl) {
  fail("DATABASE_URL n'est pas défini. Indiquez l'URL de la base PostgreSQL (ex : postgresql://ym:motdepasse@postgres:5432/ymtransit).");
}
if (dbUrl.startsWith("file:")) {
  fail(
    "DATABASE_URL pointe encore vers un fichier SQLite. L'ERP utilise maintenant PostgreSQL : créez une base PostgreSQL " +
    "(dans Coolify : + New Resource > PostgreSQL), mettez son URL interne dans DATABASE_URL et gardez le volume /app/data. " +
    "Au premier démarrage, les données de /app/data/prod.db seront reprises automatiquement."
  );
}
if (!/^postgres(ql)?:\/\//.test(dbUrl)) fail("DATABASE_URL doit commencer par postgresql://");
console.log(`📍 [PRISMA-CHECK] Base PostgreSQL : ${dbUrl.replace(/\/\/([^:@/]+):[^@]*@/, "//$1:***@")}`);

// 2. Synchronisation du schéma, sans perte de données autorisée.
//    PostgreSQL peut démarrer après l'ERP (même déploiement Coolify) : on réessaie pendant une minute.
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let pushed = false;
for (let i = 1; i <= 12 && !pushed; i++) {
  try {
    console.log(`👉 [PRISMA-CHECK] npx prisma db push --skip-generate${i > 1 ? ` (essai ${i})` : ""}`);
    execSync("npx prisma db push --skip-generate", { stdio: "inherit" });
    pushed = true;
  } catch (error) {
    if (i === 12) {
      fail(
        "La synchronisation du schéma a échoué (base injoignable, ou modification qui détruirait des données). " +
        "Vérifiez DATABASE_URL et que PostgreSQL tourne. Si Prisma signale une perte de données, faites une sauvegarde puis appliquez la modification manuellement."
      );
    }
    sleep(5000);
  }
}

// 3. Reprise automatique de l'ancienne base SQLite, une seule fois, si PostgreSQL est encore vide
const legacy = process.env.SQLITE_IMPORT_PATH || "/app/data/prod.db";
if (fs.existsSync(legacy) && fs.statSync(legacy).isFile() && fs.statSync(legacy).size > 0) {
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  const users = await prisma.user.count();
  await prisma.$disconnect();
  if (users === 0) {
    console.log(`👉 [PRISMA-CHECK] Base PostgreSQL vide et ancienne base SQLite trouvée (${legacy}) : reprise des données.`);
    try {
      const { importSqlite } = await import("./prisma/import-sqlite.js");
      await importSqlite(legacy);
    } catch (error) {
      fail(`La reprise des données SQLite a échoué : ${error.message}. PostgreSQL est resté vide, le fichier SQLite est intact.`);
    }
  } else {
    console.log(`ℹ️ [PRISMA-CHECK] ${legacy} présent mais PostgreSQL contient déjà des données : pas de reprise (le fichier n'est pas touché).`);
  }
}

// 4. Données de démonstration : seed.cjs ne fait rien si la base contient déjà des données
const seedPath = path.resolve("dist", "seed.cjs");
if (fs.existsSync(seedPath)) {
  try {
    console.log("👉 [PRISMA-CHECK] node dist/seed.cjs");
    execSync(`node "${seedPath}"`, { stdio: "inherit" });
  } catch (error) {
    console.error("⚠️ [PRISMA-CHECK] Échec du seed (le serveur démarre quand même) :", error.message);
  }
}

console.log("✅ [PRISMA-CHECK] Base de données prête.");
