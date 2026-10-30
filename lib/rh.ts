import prisma, { basePrisma } from "./prismaClient";
import { postEcriture } from "./accounting";
import { periodeLabel } from "./paie";

// Qui voit les dossiers du personnel et les salaires
export const RH_ROLES = ["super_admin", "pdg", "dg", "dga", "daf", "rh"];
// Qui valide la paie (la RH la prépare, la direction financière la valide)
export const PAIE_VALIDE_ROLES = ["super_admin", "pdg", "dg", "daf"];

export const CONTRATS: Record<string, string> = { CDI: "CDI", CDD: "CDD", ESSAI: "Période d'essai", STAGE: "Stage", PRESTATAIRE: "Prestataire" };
export const SITUATIONS: Record<string, string> = { CELIBATAIRE: "Célibataire", MARIE: "Marié(e)", DIVORCE: "Divorcé(e)", VEUF: "Veuf / veuve" };
export const MODES: Record<string, string> = { VIREMENT: "Virement bancaire", ESPECES: "Espèces", MOBILE_MONEY: "Mobile Money" };

export async function nextMatricule() {
  const last = await prisma.employe.findMany({ select: { matricule: true } });
  const n = last.map((e) => parseInt(e.matricule.replace(/\D/g, "")) || 0).reduce((a, b) => Math.max(a, b), 0);
  return `EMP-${String(n + 1).padStart(4, "0")}`;
}

// Premier démarrage : un dossier employé pour chaque compte actif existant
export async function ensureEmployes() {
  if ((await basePrisma.employe.count()) > 0) return;
  const users = await basePrisma.user.findMany({ where: { actif: true, role: { not: "super_admin" } }, orderBy: { id: "asc" } });
  let n = 0;
  for (const u of users) {
    n++;
    await basePrisma.employe.create({
      data: { matricule: `EMP-${String(n).padStart(4, "0")}`, user_id: u.id, nom: u.nom, prenom: u.prenom, email: u.email, departement_id: u.departement_id, date_embauche: u.created_at },
    });
  }
  if (n) console.log(`[RH] ${n} dossiers employés créés à partir des comptes existants.`);
}

// Un nouveau compte créé par l'administration a aussi son dossier employé
export async function employePourUser(u: { id: number; nom: string; prenom: string | null; email: string; departement_id: number | null; role: string }) {
  if (u.role === "super_admin" || (await prisma.employe.findUnique({ where: { user_id: u.id } }))) return;
  await prisma.employe.create({ data: { matricule: await nextMatricule(), user_id: u.id, nom: u.nom, prenom: u.prenom, email: u.email, departement_id: u.departement_id, date_embauche: new Date() } });
}

async function compte(code: string, nom: string, type: string, sens: string, societe: string) {
  const c = await prisma.compteComptable.findUnique({ where: { code } });
  return c || prisma.compteComptable.create({ data: { code, nom, type, sens_normal: sens, societe, actif: true } });
}

// Écriture de paie (journal PAI) à la validation : charges, dettes sociales et fiscales, net dû au personnel
export async function ecriturePaie(tx: any, periode: { id: number; mois: number; annee: number }, bulletins: any[], userId: number, societe: string) {
  const tot = { brut: 0, cnps_sal: 0, cnps_pat: 0, impots_sal: 0, taxes_pat: 0, avance: 0, net: 0 };
  for (const b of bulletins) {
    const d = JSON.parse(b.detail_json);
    tot.brut += d.brut; tot.cnps_sal += d.cnps_salarie;
    tot.cnps_pat += d.employeur.pension + d.employeur.af + d.employeur.at;
    tot.impots_sal += d.irpp + d.cac + d.cfc + d.rav + d.tdl;
    tot.taxes_pat += d.employeur.cfc + d.employeur.fne;
    tot.avance += d.avance; tot.net += d.net;
  }
  const c661 = await compte("661", "Rémunérations directes du personnel", "CHARGE", "DEBIT", societe);
  const c664 = await compte("664", "Charges sociales patronales", "CHARGE", "DEBIT", societe);
  const c6412 = await compte("6412", "Taxes sur salaires (CFC, FNE)", "CHARGE", "DEBIT", societe);
  const c431 = await compte("431", "Sécurité sociale (CNPS)", "PASSIF", "CREDIT", societe);
  const c4472 = await compte("4472", "État, impôts retenus à la source", "PASSIF", "CREDIT", societe);
  const c421 = await compte("421", "Personnel, avances et acomptes", "ACTIF", "DEBIT", societe);
  const c422 = await compte("422", "Personnel, rémunérations dues", "PASSIF", "CREDIT", societe);
  const lignes = [
    { compte_id: c661.id, debit: tot.brut, credit: 0 },
    { compte_id: c664.id, debit: tot.cnps_pat, credit: 0 },
    { compte_id: c6412.id, debit: tot.taxes_pat, credit: 0 },
    { compte_id: c431.id, debit: 0, credit: tot.cnps_sal + tot.cnps_pat },
    { compte_id: c4472.id, debit: 0, credit: tot.impots_sal + tot.taxes_pat },
    { compte_id: c421.id, debit: 0, credit: tot.avance },
    { compte_id: c422.id, debit: 0, credit: tot.net },
  ].filter((l) => l.debit || l.credit);
  await postEcriture(tx, { journal: "PAI", piece_ref: `PAIE-${periode.annee}-${String(periode.mois).padStart(2, "0")}`, libelle: `Paie de ${periodeLabel(periode)}`, societe, created_by: userId, date: new Date(periode.annee, periode.mois, 0, 12), lignes });
  return tot;
}

// Paiement des salaires : le net dû au personnel est soldé par la banque ou la caisse
export async function ecriturePaiementPaie(tx: any, periode: { mois: number; annee: number }, net: number, mode: string, userId: number, societe: string) {
  const c422 = await compte("422", "Personnel, rémunérations dues", "PASSIF", "CREDIT", societe);
  const tresor = await compte(mode === "ESPECES" ? "571" : "512", mode === "ESPECES" ? "Caisse" : "Banque", "ACTIF", "DEBIT", societe);
  await postEcriture(tx, { journal: mode === "ESPECES" ? "CAI" : "BNQ", piece_ref: `PAIE-${periode.annee}-${String(periode.mois).padStart(2, "0")}`, libelle: `Paiement des salaires de ${periodeLabel(periode)}`, societe, created_by: userId, date: new Date(), lignes: [{ compte_id: c422.id, debit: net, credit: 0 }, { compte_id: tresor.id, debit: 0, credit: net }] });
}
