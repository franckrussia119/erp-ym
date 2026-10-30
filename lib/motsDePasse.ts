import fs from "fs";
import crypto from "crypto";
import { basePrisma } from "./prismaClient";

// À chaque nouvelle version déployée, tous les comptes actifs doivent choisir un nouveau mot de passe
// à leur prochaine connexion (ils se connectent avec l'ancien, puis le changent avant d'accéder à l'ERP).
// La version est APP_VERSION si elle est définie, sinon l'empreinte du serveur compilé : elle change à chaque mise à jour.
// PASSWORD_RENEW_ON_UPDATE=false coupe ce renouvellement.
const CLE = "version_mots_de_passe";

export function versionApp(): string {
  if (process.env.APP_VERSION) return process.env.APP_VERSION;
  try { return crypto.createHash("sha256").update(fs.readFileSync(process.argv[1] || "")).digest("hex").slice(0, 16); }
  catch { return ""; }
}

export async function renouvelerApresMiseAJour() {
  if (process.env.PASSWORD_RENEW_ON_UPDATE === "false") return;
  const version = versionApp();
  if (!version) return;
  const p = await basePrisma.parametre.findUnique({ where: { cle: CLE } });
  if (p?.valeur === version) return;
  const { count } = await basePrisma.user.updateMany({ where: { actif: true }, data: { force_pwd_change: true } });
  await basePrisma.parametre.upsert({ where: { cle: CLE }, create: { cle: CLE, valeur: version }, update: { valeur: version } });
  console.log(`[MOTS DE PASSE] Nouvelle version ${version} : ${count} compte(s) devront choisir un nouveau mot de passe.`);
}
