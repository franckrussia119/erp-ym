import prisma, { basePrisma, notifyUsers } from "./prismaClient";
import { generateRef } from "./generateRef";

// Circuit d'approbation commun à toutes les demandes internes (congés, achats, réparations…).
// Chaque demande suit une liste d'étapes ; une étape est validée par le responsable du service
// du demandeur (RESPONSABLE) ou par un rôle (rh, daf, dg, pdg…). Les règles se règlent dans
// Administration › Circuits d'approbation, par type et par montant.

export const TYPES: Record<string, { label: string; icon: string; couleur: string; montant: "non" | "oui" | "option"; aide: string }> = {
  CONGE: { label: "Congé ou absence", icon: "bi-calendar2-week", couleur: "#0d9488", montant: "non", aide: "Congé annuel, maladie, permission, absence exceptionnelle." },
  ACHAT: { label: "Achat", icon: "bi-cart3", couleur: "#059669", montant: "oui", aide: "Matériel, fournitures, équipement, abonnement." },
  REPARATION: { label: "Réparation ou entretien", icon: "bi-tools", couleur: "#14b8a6", montant: "oui", aide: "Véhicule, camion, engin, bâtiment, informatique." },
  AUTRE: { label: "Autre demande", icon: "bi-card-checklist", couleur: "#0f766e", montant: "option", aide: "Avance sur salaire, formation, mission, toute autre demande." },
};

export const CONGE_MOTIFS = ["Congé annuel", "Maladie", "Permission", "Événement familial", "Maternité / paternité", "Autre"];

export const APPROBATEURS: Record<string, string> = {
  RESPONSABLE: "Responsable du service",
  rh: "Ressources humaines",
  daf: "DAF",
  dga: "DGA",
  dg: "DG",
  pdg: "PDG",
  comptable: "Comptabilité",
  magasinier: "Magasin",
};

export const DEFAULT_REGLES: { type: string; montant_min: number; etapes: string[] }[] = [
  { type: "CONGE", montant_min: 0, etapes: ["RESPONSABLE", "rh"] },
  { type: "ACHAT", montant_min: 0, etapes: ["RESPONSABLE", "daf"] },
  { type: "ACHAT", montant_min: 500000, etapes: ["RESPONSABLE", "daf", "dg"] },
  { type: "ACHAT", montant_min: 2000000, etapes: ["RESPONSABLE", "daf", "dg", "pdg"] },
  { type: "REPARATION", montant_min: 0, etapes: ["RESPONSABLE", "daf"] },
  { type: "REPARATION", montant_min: 500000, etapes: ["RESPONSABLE", "daf", "dg"] },
  { type: "AUTRE", montant_min: 0, etapes: ["daf", "pdg"] },
];

// Rôles informés de la décision finale (acceptée ou refusée, avec le motif), sans avoir à valider
export const INFORMES: Record<string, string[]> = { CONGE: ["dg", "pdg"], AUTRE: ["dg"] };

export const STATE: Record<string, { label: string; cls: string; icon: string }> = {
  EN_ATTENTE: { label: "En cours de validation", cls: "warning", icon: "bi-hourglass-split" },
  APPROUVEE: { label: "Approuvée", cls: "success", icon: "bi-check-circle-fill" },
  REFUSEE: { label: "Refusée", cls: "danger", icon: "bi-x-circle-fill" },
  ANNULEE: { label: "Annulée", cls: "secondary", icon: "bi-slash-circle" },
};

const full = (u: any) => (u ? [u.prenom, u.nom].filter(Boolean).join(" ") : "");

export async function ensureRegles() {
  // Avance sur salaire et autres demandes : DAF puis PDG (l'ancien circuit par défaut est remplacé une fois)
  await basePrisma.circuitRegle.updateMany({ where: { type: "AUTRE", montant_min: 0, etapes_json: JSON.stringify(["RESPONSABLE", "dg"]) }, data: { etapes_json: JSON.stringify(["daf", "pdg"]) } });
  if ((await basePrisma.circuitRegle.count()) > 0) return;
  await basePrisma.circuitRegle.createMany({ data: DEFAULT_REGLES.map((r) => ({ type: r.type, montant_min: r.montant_min, etapes_json: JSON.stringify(r.etapes) })) });
}

export const parseEtapes = (json: string): string[] => { try { const a = JSON.parse(json); return Array.isArray(a) ? a.filter((x) => APPROBATEURS[x]) : []; } catch { return []; } };

// Règle applicable : la plus haute tranche atteinte par le montant
export async function regleFor(type: string, montant: number) {
  const regles = await prisma.circuitRegle.findMany({ where: { type, actif: true, montant_min: { lte: montant || 0 } }, orderBy: { montant_min: "desc" }, take: 1 });
  return regles[0] ? parseEtapes(regles[0].etapes_json) : ["RESPONSABLE"];
}

// Étapes réelles pour ce demandeur : on ne valide jamais sa propre demande.
// Sans responsable de service, la direction (DG) prend l'étape.
export async function etapesPour(demandeur: { id: number; role: string; departement_id: number | null }, type: string, montant: number) {
  const base = await regleFor(type, montant);
  const dept = demandeur.departement_id ? await prisma.departement.findUnique({ where: { id: demandeur.departement_id }, select: { responsable_id: true } }) : null;
  const out: string[] = [];
  for (let k of base) {
    if (k === "RESPONSABLE") {
      if (dept?.responsable_id === demandeur.id) continue; // le responsable demande pour lui-même
      // Sans responsable : la personne au-dessus (DG, ou PDG pour le DG ; le PDG n'a personne au-dessus)
      if (!dept?.responsable_id) { if (demandeur.role === "pdg") continue; k = demandeur.role === "dg" ? "pdg" : "dg"; }
    }
    // Rôle sans aucun compte actif (ex. pas encore de RH) : la direction prend l'étape pour ne pas bloquer
    if (k !== "RESPONSABLE" && !(await prisma.user.count({ where: { role: k, actif: true } }))) k = demandeur.role === "dg" ? "pdg" : "dg";
    if (k === demandeur.role) continue;
    if (k === "dg" && demandeur.role === "pdg") continue; // le DG ne valide pas une demande du PDG
    if (!out.includes(k)) out.push(k);
  }
  // Une demande du DG remonte au PDG ; celle du PDG est validée d'office
  if (!out.length && demandeur.role !== "pdg") out.push(demandeur.role === "dg" ? "pdg" : "dg");
  return out;
}

// Personnes qui peuvent décider une étape
export async function approbateurIds(demande: { demandeur_id: number; departement_id: number | null }, cle: string) {
  if (cle === "RESPONSABLE") {
    const d = demande.departement_id ? await prisma.departement.findUnique({ where: { id: demande.departement_id }, select: { responsable_id: true } }) : null;
    return d?.responsable_id && d.responsable_id !== demande.demandeur_id ? [d.responsable_id] : [];
  }
  const users = await prisma.user.findMany({ where: { role: cle, actif: true, id: { not: demande.demandeur_id } }, select: { id: true } });
  return users.map((u) => u.id);
}

export function etapeCourante(d: any) {
  return d.etat === "EN_ATTENTE" ? (d.etapes || []).find((e: any) => e.ordre === d.etape_courante) : null;
}

export async function peutDecider(user: { id: number; role: string }, d: any) {
  const e = etapeCourante(d);
  if (!e || d.demandeur_id === user.id) return false;
  if (e.approbateur === "RESPONSABLE") return (await approbateurIds(d, "RESPONSABLE")).includes(user.id);
  return user.role === e.approbateur;
}

// Demandes que cette personne doit valider maintenant
export async function aValider(user: { id: number; role: string }) {
  const dirige = await prisma.departement.findMany({ where: { responsable_id: user.id }, select: { id: true } });
  const deptIds = dirige.map((d) => d.id);
  const pending = await prisma.demande.findMany({
    where: { etat: "EN_ATTENTE", demandeur_id: { not: user.id } },
    include: { etapes: true, demandeur: { select: { nom: true, prenom: true } }, departement: { select: { nom: true, couleur: true } } },
    orderBy: { created_at: "asc" },
  });
  return pending.filter((d) => {
    const e = etapeCourante(d);
    if (!e) return false;
    if (e.approbateur === "RESPONSABLE") return d.departement_id != null && deptIds.includes(d.departement_id);
    return e.approbateur === user.role;
  });
}

export async function nbAValider(user: { id: number; role: string }) {
  return (await aValider(user)).length;
}

const lien = (id: number) => `/demandes/${id}`;
const resume = (d: any) => `${TYPES[d.type]?.label || d.type} · ${d.titre}${d.montant ? ` · ${Math.round(d.montant).toLocaleString("fr-FR")} F` : ""}`;

async function prevenirEtape(d: any, ordre: number) {
  const e = d.etapes.find((x: any) => x.ordre === ordre);
  if (!e) return;
  const ids = await approbateurIds(d, e.approbateur);
  await notifyUsers(ids, `✍️ Demande à valider : ${d.numero}`, `${full(d.demandeur)} · ${resume(d)}`, lien(d.id));
}

export async function creerDemande(demandeur: any, input: { type: string; titre: string; details?: string | null; montant?: number | null; donnees?: any; pieces?: any[] }) {
  const etapes = await etapesPour(demandeur, input.type, input.montant || 0);
  let numero = generateRef("DM");
  while (await prisma.demande.findUnique({ where: { numero } })) numero = generateRef("DM");
  const d = await prisma.demande.create({
    data: {
      numero, type: input.type, titre: input.titre, details: input.details || null, montant: input.montant ?? null,
      donnees_json: input.donnees ? JSON.stringify(input.donnees) : null,
      pieces_json: input.pieces?.length ? JSON.stringify(input.pieces) : null,
      demandeur_id: demandeur.id,
      etat: etapes.length ? "EN_ATTENTE" : "APPROUVEE",
      decided_at: etapes.length ? null : new Date(),
      etapes: { create: etapes.map((a, i) => ({ ordre: i, approbateur: a })) },
    },
    include: { etapes: { orderBy: { ordre: "asc" } }, demandeur: true },
  });
  if (etapes.length) await prevenirEtape(d, 0);
  return d;
}

// DG, PDG… prévenus du résultat final (pas le demandeur ni celui qui vient de décider)
async function informer(d: any, deciderId: number, titre: string, texte: string) {
  const roles = INFORMES[d.type] || [];
  if (!roles.length) return;
  const us = await prisma.user.findMany({ where: { role: { in: roles }, actif: true, id: { notIn: [d.demandeur_id, deciderId] } }, select: { id: true } });
  await notifyUsers(us.map((u) => u.id), titre, texte, lien(d.id));
}

export async function decider(user: any, id: number, decision: "APPROUVE" | "REFUSE", commentaire: string | null) {
  const d: any = await prisma.demande.findUnique({ where: { id }, include: { etapes: { orderBy: { ordre: "asc" } }, demandeur: true } });
  if (!d) return { ok: false, msg: "Demande introuvable." };
  if (d.etat !== "EN_ATTENTE") return { ok: false, msg: "Cette demande est déjà traitée." };
  if (!(await peutDecider(user, d))) return { ok: false, msg: "Ce n'est pas à vous de valider cette étape." };
  if (decision === "REFUSE" && !commentaire) return { ok: false, msg: "Indiquez le motif du refus." };
  const e = etapeCourante(d);
  const now = new Date();
  // Mise à jour conditionnelle : deux validations simultanées ne peuvent pas passer toutes les deux
  const claimed = await prisma.demandeEtape.updateMany({ where: { id: e.id, decision: null }, data: { decision, commentaire, decideur_id: user.id, decided_at: now } });
  if (!claimed.count) return { ok: false, msg: "Cette étape vient d'être traitée par quelqu'un d'autre." };
  const qui = full(user) || user.nom;
  if (decision === "REFUSE") {
    await prisma.demande.update({ where: { id }, data: { etat: "REFUSEE", decided_at: now } });
    await notifyUsers([d.demandeur_id], `❌ Demande refusée : ${d.numero}`, `${qui} (${APPROBATEURS[e.approbateur]}) : ${commentaire}`, lien(id));
    await informer(d, user.id, `❌ ${TYPES[d.type]?.label || "Demande"} refusée : ${full(d.demandeur)}`, `${resume(d)} · refusée par ${qui} (${APPROBATEURS[e.approbateur]}). Motif : ${commentaire}`);
    return { ok: true, msg: "Demande refusée. Le demandeur est prévenu." };
  }
  const next = d.etapes.find((x: any) => x.ordre === e.ordre + 1);
  if (next) {
    await prisma.demande.update({ where: { id }, data: { etape_courante: next.ordre } });
    await prevenirEtape(d, next.ordre);
    await notifyUsers([d.demandeur_id], `👍 ${d.numero} : étape validée`, `${qui} a validé. Prochaine étape : ${APPROBATEURS[next.approbateur]}.`, lien(id));
    return { ok: true, msg: `Validé. La demande passe à : ${APPROBATEURS[next.approbateur]}.` };
  }
  await prisma.demande.update({ where: { id }, data: { etat: "APPROUVEE", decided_at: now } });
  await notifyUsers([d.demandeur_id], `✅ Demande approuvée : ${d.numero}`, resume(d), lien(id));
  await informer(d, user.id, `✅ ${TYPES[d.type]?.label || "Demande"} acceptée : ${full(d.demandeur)}`, `${resume(d)} · acceptée par ${qui} (${APPROBATEURS[e.approbateur]})${commentaire ? ". " + commentaire : ""}.`);
  return { ok: true, msg: "Demande approuvée. Le demandeur est prévenu." };
}
