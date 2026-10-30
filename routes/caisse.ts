import express from "express";
import path from "path";
import fs from "fs";
import multer from "multer";
import prisma, { notifyRoles, notifyUsers } from "../lib/prismaClient";
import { requireAuth } from "./rbac";
import { generateRef } from "../lib/generateRef";
import { postPaymentEcriture } from "../lib/accounting";
import { STEPS, hoursLate } from "../lib/pipeline";
import {
  CAISSE_ROLES, DEPENSE_CATEGORIES, INTERNAL_PDG_THRESHOLD, INTERNE_INFORMES, ROLES_BY_VISA, VISA_LABELS,
  initialTicks, requiredVisas, visaProgress, payable, categorieLabel,
} from "../lib/bons";
import { servicesActifs, pickDept, userDeptId } from "../lib/departements";
import { banquesActives } from "../lib/banques";
import { ORIGINES, origineDe, sousCategorie } from "../lib/recus";
import { regularisationsEnAttente, bonsPayesNonJustifies, regulariser, retourEnCaisse } from "../lib/reliquats";

// Caisse (journal, solde, encaissements, clôture du jour), dépenses internes des services
// et espace personnel de chaque utilisateur.
const router = express.Router();

const CAISSE_WRITE = [...CAISSE_ROLES, "super_admin"];
const CAISSE_READ = [...CAISSE_WRITE, "daf", "pdg", "dg", "dga", "comptable", "auditeur1", "auditeur2", "finances"];

// Formulaires de la caisse : les reliquats, compléments et mouvements de comptes ont leurs propres écrans
// (file « Reliquats », page Comptes), ils ne se saisissent plus ici.
export const ENTREE_CATEGORIES = [
  { key: "REGLEMENT_CLIENT", label: "Règlement d'un client" },
  { key: "APPROVISIONNEMENT", label: "Approvisionnement (retrait banque, apport)" },
  { key: "AUTRE_ENTREE", label: "Autre entrée" },
];
export const SORTIE_CATEGORIES = [
  { key: "VERSEMENT_BANQUE", label: "Versement à la banque" },
  { key: "AUTRE_SORTIE", label: "Autre sortie" },
];
// Catégories des mouvements créés ailleurs (libellés du journal et des relevés)
const AUTRES_LABELS: Record<string, string> = {
  DEPOT_COMPTE: "Dépôt sur un compte", RELIQUAT: "Reliquat rendu sur un bon (bon justifié)", RETOUR_BON: "Reliquat reçu d'un bon (retour en caisse)",
  REMBOURSEMENT: "Remboursement reçu", COMPLEMENT: "Complément payé sur un bon", PAIEMENT_COMPTE: "Paiement sur un compte",
};
// Catégories où l'on choisit une banque dans la liste (obligatoire pour un versement)
const CAT_BANQUE = ["VERSEMENT_BANQUE", "APPROVISIONNEMENT"];
const MODES = ["ESPECES", "CHEQUE", "VIREMENT", "MOBILE_MONEY"];

// Comptes de la caisse : représentants des clients et personnel. Valeur du formulaire « R:12 » ou « U:5 ».
export async function comptesListe() {
  const [reps, users] = await Promise.all([
    prisma.representant.findMany({ where: { actif: true }, select: { id: true, nom: true, prenom: true, client_representants: { select: { client: { select: { nom: true } } }, take: 2 } }, orderBy: { nom: "asc" } }),
    prisma.user.findMany({ where: { actif: true }, select: { id: true, nom: true, prenom: true, role: true }, orderBy: { nom: "asc" } }),
  ]);
  return { reps, users };
}
async function lireCompte(v: any) {
  const m = /^([RU]):(\d+)$/.exec(String(v || ""));
  if (!m) return null;
  const id = parseInt(m[2]);
  if (m[1] === "R") { const r = await prisma.representant.findUnique({ where: { id } }); return r ? { representant_id: r.id, nom: `${r.prenom || ""} ${r.nom}`.trim() } : null; }
  const u = await prisma.user.findUnique({ where: { id } });
  return u ? { personne_id: u.id, nom: `${u.prenom || ""} ${u.nom}`.trim() } : null;
}
export const LABELS: Record<string, string> = {
  BON_DOSSIER: "Bon de dossier", DEPENSE_DOSSIER: "Dépense sur un dossier", JUSTIFICATION: "Dépense justifiée (bon réel)", DEPOT_COMPTE: "Dépôt sur un compte", DROITS_DOUANE: "Droits de douane", COMPLEMENT: "Complément sur bon", PAIE: "Paie du personnel",
  ...AUTRES_LABELS,
  ...Object.fromEntries([...ENTREE_CATEGORIES, ...SORTIE_CATEGORIES].map((c) => [c.key, c.label])),
  ...Object.fromEntries(DEPENSE_CATEGORIES.map((c) => [c.key, c.label])),
};
const catLabel = (k: string) => LABELS[k] || k;

const num = (v: any) => { const n = parseFloat(String(v ?? "").replace(/\s/g, "").replace(",", ".")); return isNaN(n) ? 0 : n; };
const dayStart = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const flash = (req: any, kind: "success_msg" | "error_msg", msg: string) => { req.session[kind] = msg; };

async function logActivity(userId: number, action: string, entity: string, entityId?: number | string) {
  try { await prisma.activityLog.create({ data: { user_id: userId, action, entity, entity_id: entityId != null ? String(entityId) : null } }); } catch {}
}

async function solde(until?: Date) {
  const where: any = until ? { date: { lt: until } } : {};
  const g = await prisma.caisseMouvement.groupBy({ by: ["sens"], where, _sum: { montant: true } });
  const e = g.find((x) => x.sens === "ENTREE")?._sum.montant || 0;
  const s = g.find((x) => x.sens === "SORTIE")?._sum.montant || 0;
  return e - s;
}

// =====================================================================
// Caisse
// =====================================================================
router.get("/caisse", requireAuth, async (req: any, res: any) => {
  const role = req.session.user?.role;
  if (!CAISSE_READ.includes(role)) {
    flash(req, "error_msg", "La caisse est réservée à la caisse, à la direction et à la comptabilité.");
    return res.redirect("/dashboard");
  }
  const q = req.query;
  const now = new Date();
  const from = q.du ? new Date(q.du) : new Date(now.getFullYear(), now.getMonth(), 1);
  const to = q.au ? new Date(new Date(q.au).getTime() + 864e5) : new Date(dayStart(now).getTime() + 864e5);
  const where: any = { date: { gte: from, lt: to } };
  if (q.sens === "ENTREE" || q.sens === "SORTIE") where.sens = q.sens;
  if (q.categorie) where.categorie = String(q.categorie);

  const [mouvements, soldeAvant, soldeActuel, todayG, bonsEnCours, regul, factures, lastCloture] = await Promise.all([
    prisma.caisseMouvement.findMany({ where, orderBy: [{ date: "asc" }, { id: "asc" }], include: { departement: { select: { nom: true, couleur: true } }, user: { select: { nom: true, prenom: true } }, dossier: { select: { id: true, numero: true } }, bon: { select: { id: true, numero: true } } } }),
    solde(from),
    solde(),
    prisma.caisseMouvement.groupBy({ by: ["sens"], where: { date: { gte: dayStart(now) } }, _sum: { montant: true } }),
    prisma.bonProvisoir.findMany({ where: { etat: "EN_ATTENTE" }, include: { dossier: { select: { id: true, numero: true } }, demandeur: { select: { nom: true, prenom: true } } }, orderBy: [{ urgent: "desc" }, { created_at: "asc" }] }),
    regularisationsEnAttente(),
    prisma.document.findMany({ where: { type: "FACTURE", etat: { not: "ANNULE" } }, include: { client: { select: { nom: true } }, payments: { select: { montant: true } } }, orderBy: { created_at: "desc" }, take: 200 }),
    prisma.caisseCloture.findFirst({ orderBy: { date: "desc" }, include: { user: { select: { nom: true } } } }),
  ]);
  const [services, retours, banques, comptes, demandesComptes] = await Promise.all([servicesActifs(), bonsPayesNonJustifies(), banquesActives(), comptesListe(), demandesEnAttente({})]);
  let running = soldeAvant;
  const lignes = mouvements.map((m) => { running += m.sens === "ENTREE" ? m.montant : -m.montant; return { ...m, solde: running, catLabel: catLabel(m.categorie) }; });
  const sumPeriode = (sens: string) => mouvements.filter((m) => m.sens === sens).reduce((t, m) => t + m.montant, 0);
  const impayees = factures
    .map((f) => ({ id: f.id, numero: f.numero, client: f.client?.nom || "", reste: Math.round(f.total_ttc - f.payments.reduce((t, p) => t + p.montant, 0)) }))
    .filter((f) => f.reste > 0);

  if (q.format === "csv") {
    const esc = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = [["Date", "Sens", "Catégorie", "Libellé", "Tiers", "Mode", "Banque", "Référence", "Entrée", "Sortie", "Solde"].join(";"),
      ...lignes.map((m) => [new Date(m.date).toLocaleString("fr-FR"), m.sens, m.catLabel, m.libelle, m.tiers || "", m.mode, m.banque || "", m.reference || "",
        m.sens === "ENTREE" ? m.montant : "", m.sens === "SORTIE" ? m.montant : "", m.solde].map(esc).join(";"))];
    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set("Content-Disposition", `attachment; filename="caisse-${from.toISOString().slice(0, 10)}.csv"`);
    return res.send("﻿" + rows.join("\r\n"));
  }

  res.render("caisse/index", {
    title: "Caisse",
    canWrite: CAISSE_WRITE.includes(role),
    lignes, soldeAvant, soldeActuel,
    entreesPeriode: sumPeriode("ENTREE"), sortiesPeriode: sumPeriode("SORTIE"),
    entreesJour: todayG.find((x) => x.sens === "ENTREE")?._sum.montant || 0,
    sortiesJour: todayG.find((x) => x.sens === "SORTIE")?._sum.montant || 0,
    aPayer: bonsEnCours.filter((b) => payable(b)), enVisa: bonsEnCours.filter((b) => !payable(b)),
    regul, retours, banques, comptes, demandesComptes, impayees, lastCloture, visaProgress,
    filtre: { du: from.toISOString().slice(0, 10), au: new Date(to.getTime() - 864e5).toISOString().slice(0, 10), sens: q.sens || "", categorie: q.categorie || "" },
    ENTREE_CATEGORIES, SORTIE_CATEGORIES, LABELS, services,
  });
});

// Entrée ou sortie saisie à la main par la caisse
router.post("/caisse/mouvement", requireAuth, async (req: any, res: any) => {
  const user = req.session.user;
  if (!CAISSE_WRITE.includes(user?.role)) { flash(req, "error_msg", "Seule la caisse enregistre des mouvements."); return res.redirect("/caisse"); }
  const b = req.body;
  const sens = b.sens === "SORTIE" ? "SORTIE" : "ENTREE";
  const montant = num(b.montant);
  const cats = sens === "ENTREE" ? ENTREE_CATEGORIES : SORTIE_CATEGORIES;
  const categorie = cats.some((c) => c.key === b.categorie) ? b.categorie : cats[cats.length - 1].key;
  const mode = MODES.includes(b.mode) ? b.mode : "ESPECES";
  const reference = String(b.reference || "").trim() || null;

  // Reliquat ou complément d'un bon justifié : la caisse solde la régularisation du bon choisi
  if (categorie === "RELIQUAT" || categorie === "COMPLEMENT") {
    if (!b.bon_reel_id) { flash(req, "error_msg", `Choisissez le bon dans la liste « ${catLabel(categorie)} ».`); return res.redirect("/caisse"); }
    const r = await regulariser(parseInt(b.bon_reel_id), req.session.userId, { mode, reference });
    if (r.ok) await logActivity(req.session.userId, "FONDS_DECAISSES", "BonReel", parseInt(b.bon_reel_id));
    flash(req, r.ok ? "success_msg" : "error_msg", r.ok ? `Bon ${r.bon!.numero} soldé. ${r.message}` : r.message);
    return res.redirect("/caisse");
  }
  if (!(montant > 0)) { flash(req, "error_msg", "Indiquez un montant."); return res.redirect("/caisse"); }
  // Argent d'un bon payé, rendu avant la justification
  if (categorie === "RETOUR_BON") {
    if (!b.bon_id) { flash(req, "error_msg", "Choisissez le bon dont l'argent revient en caisse."); return res.redirect("/caisse"); }
    const r = await retourEnCaisse(parseInt(b.bon_id), montant, req.session.userId, { mode, reference, date: b.date ? new Date(`${b.date}T${new Date().toTimeString().slice(0, 8)}`) : undefined });
    if (r.ok) await logActivity(req.session.userId, "CAISSE_RETOUR_BON", "BonProvisoir", parseInt(b.bon_id));
    flash(req, r.ok ? "success_msg" : "error_msg", r.message);
    return res.redirect("/caisse");
  }
  if (sens === "SORTIE" && montant > await solde()) { flash(req, "error_msg", "Sortie impossible : le solde de la caisse est insuffisant."); return res.redirect("/caisse"); }
  const banques = await banquesActives();
  const banque = banques.find((x) => x.nom === b.banque)?.nom || null;
  if (categorie === "VERSEMENT_BANQUE" && !banque) { flash(req, "error_msg", "Choisissez la banque du versement dans la liste."); return res.redirect("/caisse"); }
  // Seul un règlement client peut être rattaché à un compte (le représentant qui verse pour son client)
  const compte = sens === "ENTREE" && categorie === "REGLEMENT_CLIENT" ? await lireCompte(b.compte) : null;
  if (compte?.personne_id && compte.personne_id === req.session.userId) { flash(req, "error_msg", "Vous ne pouvez pas inscrire un mouvement sur votre propre compte : un autre agent de caisse doit le faire."); return res.redirect("/caisse"); }
  if ((categorie === "PAIEMENT_COMPTE" || categorie === "DEPOT_COMPTE") && !compte) { flash(req, "error_msg", "Choisissez le représentant ou l'employé payé."); return res.redirect("/caisse"); }

  let libelle = String(b.libelle || "").trim();
  let tiers = String(b.tiers || "").trim() || compte?.nom || (categorie === "VERSEMENT_BANQUE" ? banque : null);
  let dossierId: number | null = null;
  // Règlement d'une facture client : le paiement est aussi inscrit sur la facture et en comptabilité
  if (sens === "ENTREE" && categorie === "REGLEMENT_CLIENT" && b.document_id) {
    const doc = await prisma.document.findUnique({ where: { id: parseInt(b.document_id) }, include: { client: true, payments: true } });
    if (doc) {
      const reste = doc.total_ttc - doc.payments.reduce((t, p) => t + p.montant, 0);
      if (montant > reste + 1) { flash(req, "error_msg", `Le montant dépasse le reste à payer de la facture ${doc.numero} (${Math.round(reste).toLocaleString("fr-FR")} F).`); return res.redirect("/caisse"); }
      await prisma.$transaction(async (tx: any) => {
        await tx.payment.create({ data: { document_id: doc.id, montant, moyen: mode } });
        if (montant >= reste - 1) await tx.document.update({ where: { id: doc.id }, data: { etat: "PAYE" } });
        await postPaymentEcriture(tx, { userId: req.session.userId, societe: doc.societe, documentNumero: doc.numero, clientNom: doc.client.nom, montant, date: new Date(), moyen: mode });
      });
      libelle = libelle || `Règlement facture ${doc.numero}`;
      tiers = tiers || doc.client.nom;
      dossierId = doc.dossier_id;
    }
  }
  if (!libelle && categorie === "VERSEMENT_BANQUE") libelle = `Versement ${banque}`;
  if (!libelle && compte) libelle = `${catLabel(categorie)} · ${compte.nom}`;
  if (!libelle) { flash(req, "error_msg", "Indiquez un libellé."); return res.redirect("/caisse"); }
  const m = await prisma.caisseMouvement.create({
    data: { sens, montant, categorie, libelle, mode, reference, tiers, dossier_id: dossierId, user_id: req.session.userId, banque,
      representant_id: compte?.representant_id ?? null, personne_id: compte?.personne_id ?? null,
      departement_id: await pickDept(b.departement_id), // vide : service déduit automatiquement
      date: b.date ? new Date(`${b.date}T${new Date().toTimeString().slice(0, 8)}`) : new Date() },
  });
  await logActivity(req.session.userId, sens === "ENTREE" ? "CAISSE_ENTREE" : "CAISSE_SORTIE", "CaisseMouvement", m.id);
  flash(req, "success_msg", `${sens === "ENTREE" ? "Entrée" : "Sortie"} de ${montant.toLocaleString("fr-FR")} F enregistrée${compte ? ` sur le compte de ${compte.nom}` : ""}.`);
  res.redirect("/caisse");
});

// Solder un reliquat ou un complément en un clic depuis « À traiter »
router.post("/caisse/regulariser/:id", requireAuth, async (req: any, res: any) => {
  if (!CAISSE_WRITE.includes(req.session.user?.role)) { flash(req, "error_msg", "Seule la caisse solde les reliquats."); return res.redirect("/caisse"); }
  const id = parseInt(req.params.id);
  const r = await regulariser(id, req.session.userId, { mode: MODES.includes(req.body.mode) ? req.body.mode : "ESPECES" });
  if (r.ok) await logActivity(req.session.userId, "FONDS_DECAISSES", "BonReel", id);
  flash(req, r.ok ? "success_msg" : "error_msg", r.ok ? `Bon ${r.bon!.numero} soldé. ${r.message}` : r.message);
  res.redirect("/caisse#a-traiter");
});

// =====================================================================
// Comptes des représentants et du personnel : ce que chacun a versé à la caisse et ce qu'il en a reçu
// =====================================================================
const COMPTES_READ = [...CAISSE_READ, "rh"];
// Demandes de dépôt ou de retrait, avec le nom du compte et du demandeur
async function demandesEnAttente(where: any, toutes = false) {
  const list = await prisma.demandeCompte.findMany({ where: { ...where, ...(toutes ? {} : { etat: "EN_ATTENTE" }) }, orderBy: { created_at: "desc" }, take: toutes ? 30 : 200 });
  const uids = [...new Set(list.flatMap((d) => [d.demandeur_id, d.personne_id, d.traite_par_id].filter(Boolean) as number[]))];
  const rids = [...new Set(list.map((d) => d.representant_id).filter(Boolean) as number[])];
  const [us, rs] = await Promise.all([prisma.user.findMany({ where: { id: { in: uids } }, select: { id: true, nom: true, prenom: true } }), prisma.representant.findMany({ where: { id: { in: rids } }, select: { id: true, nom: true, prenom: true } })]);
  const n = (x: any) => (x ? `${x.prenom || ""} ${x.nom}`.trim() : "");
  return list.map((d) => ({ ...d, compteNom: d.representant_id ? n(rs.find((r) => r.id === d.representant_id)) : n(us.find((u) => u.id === d.personne_id)),
    compteLien: d.representant_id ? `/comptes/representant/${d.representant_id}` : `/comptes/personnel/${d.personne_id}`, demandeur: n(us.find((u) => u.id === d.demandeur_id)), traitePar: n(us.find((u) => u.id === d.traite_par_id)) }));
}
type Ligne = { id: number; date: Date; sens: string; montant: number; categorie: string; libelle: string; mode: string; banque: string | null; reference: string | null; bon: { id: number; numero: string } | null; dossier: { id: number; numero: string } | null };

// Sens du compte : ce que la caisse donne à la personne est un moins ; ce qu'elle rend, dépose ou justifie
// (dépense faite pour la société avec un bon) est un plus. Un bon payé puis justifié revient donc à zéro.
async function releve(where: any, personneId?: number, extra: Ligne[] = []) {
  const mvts: Ligne[] = await prisma.caisseMouvement.findMany({ where, orderBy: [{ date: "asc" }, { id: "asc" }], select: { id: true, date: true, sens: true, montant: true, categorie: true, libelle: true, mode: true, banque: true, reference: true, bon: { select: { id: true, numero: true } }, dossier: { select: { id: true, numero: true } } } });
  if (extra.length) { mvts.push(...extra); mvts.sort((a, b) => a.date.getTime() - b.date.getTime() || a.id - b.id); }
  if (personneId) {
    const justifs = await prisma.bonReel.findMany({ where: { bon_provisoir: { demandeur_id: personneId }, montant_reel: { gt: 0 } }, select: { id: true, created_at: true, montant_reel: true, bon_provisoir: { select: { id: true, numero: true, objet: true } }, dossier: { select: { id: true, numero: true } } } });
    for (const j of justifs) mvts.push({ id: -j.id, date: j.created_at, sens: "ENTREE", montant: j.montant_reel, categorie: "JUSTIFICATION", libelle: `Dépense justifiée · ${j.bon_provisoir.objet}`, mode: "JUSTIFICATIF", banque: null, reference: null, bon: { id: j.bon_provisoir.id, numero: j.bon_provisoir.numero }, dossier: j.dossier });
    mvts.sort((a, b) => a.date.getTime() - b.date.getTime() || a.id - b.id);
  }
  let cumul = 0;
  const lignes = mvts.map((m) => { cumul += m.sens === "ENTREE" ? m.montant : -m.montant; return { ...m, catLabel: catLabel(m.categorie), cumul }; });
  const verse = mvts.filter((m) => m.sens === "ENTREE").reduce((t, m) => t + m.montant, 0);
  const recu = mvts.filter((m) => m.sens === "SORTIE").reduce((t, m) => t + m.montant, 0);
  return { lignes, verse, recu, solde: verse - recu };
}

// Activité d'un représentant : ses dossiers, ce que la société y a dépensé et ce qui a été réglé.
// Dépenses d'un dossier = bons payés (montant réel une fois justifiés) + droits de douane avancés par la société.
async function activiteRepresentant(repId: number) {
  const dossiers = await prisma.dossier.findMany({
    where: { representant_id: repId },
    select: { id: true, numero: true, numero_ordre: true, bl: true, contenu: true, pipeline_status: true, created_at: true, droits_paye_montant: true, droits_frais: true, droits_paye_par: true, droits_paye_date: true,
      client: { select: { nom: true } },
      bons_provisoir: { where: { etat: "APPROUVE" }, select: { id: true, numero: true, objet: true, montant_demande: true, paye_at: true, created_at: true, bon_reel: { select: { montant_reel: true, created_at: true } } } } },
    orderBy: { created_at: "desc" },
  });
  // Règlements des factures de ses dossiers (sauf ceux déjà inscrits sur son compte par la caisse, même jour et même montant)
  const ids = dossiers.map((d) => d.id);
  const [payments, dejaCompte] = await Promise.all([
    prisma.payment.findMany({ where: { document: { dossier_id: { in: ids }, type: "FACTURE", etat: { not: "ANNULE" } } }, select: { id: true, montant: true, moyen: true, date_paiement: true, document: { select: { numero: true, dossier_id: true } } } }),
    prisma.caisseMouvement.findMany({ where: { dossier_id: { in: ids }, categorie: "REGLEMENT_CLIENT", representant_id: { not: null } }, select: { dossier_id: true, montant: true, date: true } }),
  ]);
  const jour = (d: Date) => d.toISOString().slice(0, 10);
  const reglements = payments.filter((p) => !dejaCompte.some((m) => m.dossier_id === p.document.dossier_id && Math.abs(m.montant - p.montant) < 1 && jour(m.date) === jour(p.date_paiement)))
    .map((p) => ({ id: p.id, date: p.date_paiement, montant: p.montant, libelle: `Règlement de la facture ${p.document.numero}`, mode: p.moyen, banque: null, reference: null, dossier_id: p.document.dossier_id }));
  const lignes: Ligne[] = [];
  const parDossier = dossiers.map((d) => {
    const ref = { id: d.id, numero: d.numero_ordre ? `N° ${d.numero_ordre}` : d.numero };
    let depenses = 0;
    for (const b of d.bons_provisoir) {
      const m = b.bon_reel ? b.bon_reel.montant_reel : b.montant_demande;
      if (!(m > 0)) continue;
      depenses += m;
      lignes.push({ id: -1e6 - b.id, date: b.paye_at || b.created_at, sens: "SORTIE", montant: m, categorie: "DEPENSE_DOSSIER", libelle: `${b.objet}${b.bon_reel ? "" : " (avance, pas encore justifiée)"}`, mode: b.bon_reel ? "JUSTIFICATIF" : "ESPECES", banque: null, reference: null, bon: { id: b.id, numero: b.numero }, dossier: ref });
    }
    if (d.droits_paye_par === "SOCIETE" && d.droits_paye_montant) {
      const m = d.droits_paye_montant + (d.droits_frais || 0);
      depenses += m;
      lignes.push({ id: -2e6 - d.id, date: d.droits_paye_date || d.created_at, sens: "SORTIE", montant: m, categorie: "DROITS_DOUANE", libelle: "Droits de douane avancés par la société", mode: "VIREMENT", banque: null, reference: null, bon: null, dossier: ref });
    }
    const regle = reglements.filter((r) => r.dossier_id === d.id).reduce((t, r) => t + r.montant, 0);
    for (const r of reglements.filter((x) => x.dossier_id === d.id)) lignes.push({ id: -3e6 - r.id, date: r.date, sens: "ENTREE", montant: r.montant, categorie: "REGLEMENT_CLIENT", libelle: r.libelle, mode: r.mode, banque: r.banque, reference: r.reference, bon: null, dossier: ref });
    return { ...d, depenses, regle, nbBons: d.bons_provisoir.length };
  });
  return { lignes, dossiers: parDossier };
}

router.get("/comptes", requireAuth, async (req: any, res: any) => {
  if (!COMPTES_READ.includes(req.session.user?.role)) return res.redirect(`/comptes/personnel/${req.session.userId}`);
  const [byRep, byUser, { reps, users }, aJustifier, justifies] = await Promise.all([
    prisma.caisseMouvement.groupBy({ by: ["representant_id", "sens"], where: { representant_id: { not: null } }, _sum: { montant: true }, _count: true }),
    prisma.caisseMouvement.groupBy({ by: ["personne_id", "sens"], where: { personne_id: { not: null } }, _sum: { montant: true }, _count: true }),
    comptesListe(),
    prisma.bonProvisoir.groupBy({ by: ["demandeur_id"], where: { etat: "APPROUVE", bon_reel: null }, _sum: { montant_demande: true } }),
    prisma.$queryRawUnsafe<{ uid: number; total: number }[]>(`SELECT b.demandeur_id AS uid, SUM(r.montant_reel)::float AS total FROM "BonReel" r JOIN "BonProvisoir" b ON b.id = r.bon_provisoir_id GROUP BY b.demandeur_id`),
  ]);
  const tot = (g: any[], key: string, id: number) => {
    const e = g.find((x) => x[key] === id && x.sens === "ENTREE"), s_ = g.find((x) => x[key] === id && x.sens === "SORTIE");
    return { verse: e?._sum.montant || 0, recu: s_?._sum.montant || 0, n: (e?._count || 0) + (s_?._count || 0) };
  };
  // Les dépenses et règlements de ses dossiers comptent sur le compte du représentant
  const acts = await Promise.all(reps.map((r) => activiteRepresentant(r.id)));
  const representants = reps.map((r, i) => {
    const t = tot(byRep, "representant_id", r.id), l = acts[i].lignes;
    const plus = l.filter((x) => x.sens === "ENTREE").reduce((a, x) => a + x.montant, 0), moins = l.filter((x) => x.sens === "SORTIE").reduce((a, x) => a + x.montant, 0);
    return { ...r, clients: r.client_representants.map((c) => c.client.nom), verse: t.verse + plus, recu: t.recu + moins, n: t.n + l.length, nbDossiers: acts[i].dossiers.length };
  });
  const personnel = users.map((u) => { const t = tot(byUser, "personne_id", u.id); const j = justifies.find((x) => Number(x.uid) === u.id)?.total || 0; return { ...u, ...t, verse: t.verse + j, aJustifier: aJustifier.find((a) => a.demandeur_id === u.id)?._sum.montant_demande || 0 }; });
  const q = String(req.query.q || "").trim().toUpperCase();
  const match = (x: any) => !q || `${x.prenom || ""} ${x.nom}`.toUpperCase().includes(q);
  res.render("caisse/comptes", { title: "Comptes", representants: representants.filter(match), personnel: personnel.filter(match), q, onglet: req.query.onglet === "personnel" ? "personnel" : "representants" });
});

router.get("/comptes/representant/:id", requireAuth, async (req: any, res: any) => {
  if (!COMPTES_READ.includes(req.session.user?.role)) { flash(req, "error_msg", "Les comptes des représentants sont réservés à la caisse, à la direction et à la comptabilité."); return res.redirect("/dashboard"); }
  const rep = await prisma.representant.findUnique({ where: { id: parseInt(req.params.id) }, include: { client_representants: { include: { client: { select: { id: true, nom: true } } } } } });
  if (!rep) return res.redirect("/comptes");
  const act = await activiteRepresentant(rep.id);
  const r = await releve({ representant_id: rep.id }, undefined, act.lignes);
  res.render("caisse/releve", { dossiersRep: act.dossiers, canWrite: CAISSE_WRITE.includes(req.session.user?.role), banques: await banquesActives(), demandes: await demandesEnAttente({ representant_id: rep.id }, true), title: `Compte de ${rep.prenom || ""} ${rep.nom}`.trim(), titulaire: { nom: `${rep.prenom || ""} ${rep.nom}`.trim(), sous: "Représentant · " + (rep.client_representants.map((c) => c.client.nom).join(", ") || "aucun client"), type: "representant", id: rep.id, tel: rep.tel }, ...r, aJustifier: [] });
});

router.get("/comptes/personnel/:id", requireAuth, async (req: any, res: any) => {
  const id = parseInt(req.params.id);
  const soi = id === req.session.userId;
  if (!soi && !COMPTES_READ.includes(req.session.user?.role)) { flash(req, "error_msg", "Vous ne pouvez consulter que votre propre compte."); return res.redirect(`/comptes/personnel/${req.session.userId}`); }
  const u = await prisma.user.findUnique({ where: { id }, select: { id: true, nom: true, prenom: true, role: true } });
  if (!u) return res.redirect("/comptes");
  const [r, aJustifier] = await Promise.all([
    releve({ personne_id: u.id }, u.id),
    prisma.bonProvisoir.findMany({ where: { demandeur_id: u.id, etat: "APPROUVE", bon_reel: null }, select: { id: true, numero: true, objet: true, montant_demande: true, paye_at: true }, orderBy: { paye_at: "asc" } }),
  ]);
  res.render("caisse/releve", { canWrite: CAISSE_WRITE.includes(req.session.user?.role), banques: await banquesActives(), demandes: await demandesEnAttente({ personne_id: u.id }, true), title: soi ? "Mon compte" : `Compte de ${u.prenom || ""} ${u.nom}`.trim(), titulaire: { nom: `${u.prenom || ""} ${u.nom}`.trim(), sous: "Personnel · " + u.role, type: "personnel", id: u.id }, ...r, aJustifier, soi });
});

// Mouvement sur un compte, saisi par la caisse ou confirmé par elle à partir d'une demande
async function lireSaisieCompte(b: any) {
  const sens = b.sens === "SORTIE" ? "SORTIE" : "ENTREE";
  const montant = num(b.montant);
  const mode = MODES.includes(b.mode) ? b.mode : "ESPECES";
  const banque = (await banquesActives()).find((x) => x.nom === b.banque)?.nom || null;
  const err = !(montant > 0) ? "Indiquez un montant." : (mode === "CHEQUE" || mode === "VIREMENT") && !banque ? "Choisissez la banque du chèque ou du virement." : null;
  return { sens, montant, mode, banque, motif: String(b.libelle || b.motif || "").trim() || null, reference: String(b.reference || "").trim() || null, err };
}
async function mouvementCompte(compte: { representant_id?: number; personne_id?: number; nom: string }, x: { sens: string; montant: number; mode: string; banque: string | null; motif: string | null; reference: string | null }, userId: number) {
  if (x.sens === "SORTIE" && x.montant > await solde()) return { ok: false as const, message: "Sortie impossible : le solde de la caisse est insuffisant." };
  const m = await prisma.caisseMouvement.create({
    data: { sens: x.sens, montant: x.montant, categorie: x.sens === "ENTREE" ? "DEPOT_COMPTE" : "PAIEMENT_COMPTE", mode: x.mode, banque: x.banque, reference: x.reference, tiers: compte.nom, user_id: userId,
      libelle: x.motif || `${x.sens === "ENTREE" ? "Dépôt de" : "Paiement à"} ${compte.nom}`,
      representant_id: compte.representant_id ?? null, personne_id: compte.personne_id ?? null },
  });
  await logActivity(userId, x.sens === "ENTREE" ? "CAISSE_ENTREE" : "CAISSE_SORTIE", "CaisseMouvement", m.id);
  const f = x.montant.toLocaleString("fr-FR");
  return { ok: true as const, m, message: x.sens === "ENTREE" ? `Compte de ${compte.nom} crédité de ${f} F : entrée de caisse enregistrée.` : `Compte de ${compte.nom} débité de ${f} F : sortie de caisse enregistrée.` };
}
const compteDe = (type: string, id: number) => lireCompte(`${type === "representant" ? "R" : "U"}:${id}`);

// La caisse crédite ou débite directement (jamais son propre compte)
router.post("/comptes/:type/:id/mouvement", requireAuth, async (req: any, res: any) => {
  const type = req.params.type === "representant" ? "representant" : "personnel";
  const id = parseInt(req.params.id);
  const back = `/comptes/${type}/${id}`;
  if (!CAISSE_WRITE.includes(req.session.user?.role)) { flash(req, "error_msg", "Seule la caisse crédite ou débite un compte. Faites une demande : la caisse la confirmera."); return res.redirect(back); }
  const compte = await compteDe(type, id);
  if (!compte) return res.redirect("/comptes");
  if (compte.personne_id === req.session.userId) { flash(req, "error_msg", "Vous ne pouvez pas créditer ou débiter votre propre compte : faites une demande, un autre agent de caisse la confirmera."); return res.redirect(back); }
  const x = await lireSaisieCompte(req.body);
  if (x.err) { flash(req, "error_msg", x.err); return res.redirect(back); }
  const r = await mouvementCompte(compte, x, req.session.userId);
  flash(req, r.ok ? "success_msg" : "error_msg", r.message);
  res.redirect(back);
});

// Demande de dépôt ou de retrait : rien ne bouge tant que la caisse n'a pas confirmé
router.post("/comptes/:type/:id/demande", requireAuth, async (req: any, res: any) => {
  const type = req.params.type === "representant" ? "representant" : "personnel";
  const id = parseInt(req.params.id);
  const back = `/comptes/${type}/${id}`;
  const soi = type === "personnel" && id === req.session.userId;
  if (!soi && !COMPTES_READ.includes(req.session.user?.role)) { flash(req, "error_msg", "Vous ne pouvez faire une demande que sur votre propre compte."); return res.redirect(`/comptes/personnel/${req.session.userId}`); }
  const compte = await compteDe(type, id);
  if (!compte) return res.redirect("/comptes");
  const x = await lireSaisieCompte(req.body);
  if (x.err) { flash(req, "error_msg", x.err); return res.redirect(back); }
  const d = await prisma.demandeCompte.create({
    data: { representant_id: compte.representant_id ?? null, personne_id: compte.personne_id ?? null, sens: x.sens, montant: x.montant, mode: x.mode, banque: x.banque, motif: x.motif, reference: x.reference, demandeur_id: req.session.userId },
  });
  await logActivity(req.session.userId, "DEMANDE_COMPTE", "DemandeCompte", d.id);
  await notifyRoles(CAISSE_ROLES, `🧾 Demande ${x.sens === "ENTREE" ? "de dépôt" : "de retrait"} · ${compte.nom}`, `${x.montant.toLocaleString("fr-FR")} F${x.motif ? " · " + x.motif : ""}. À confirmer par la caisse.`, `/caisse#q-comptes`);
  flash(req, "success_msg", `Demande ${x.sens === "ENTREE" ? "de dépôt" : "de retrait"} de ${x.montant.toLocaleString("fr-FR")} F envoyée. Le compte et la caisse ne bougent qu'après confirmation par la caisse.`);
  res.redirect(back);
});

// La caisse confirme (le mouvement est enregistré) ou refuse une demande
router.post("/comptes/demandes/:id/:decision", requireAuth, async (req: any, res: any) => {
  const back = String(req.body.back || "").startsWith("/") ? String(req.body.back) : "/caisse#q-comptes";
  if (!CAISSE_WRITE.includes(req.session.user?.role)) { flash(req, "error_msg", "Seule la caisse confirme les demandes."); return res.redirect(back); }
  const d = await prisma.demandeCompte.findUnique({ where: { id: parseInt(req.params.id) } });
  if (!d || d.etat !== "EN_ATTENTE") { flash(req, "error_msg", "Cette demande a déjà été traitée."); return res.redirect(back); }
  const compte = await lireCompte(d.representant_id ? `R:${d.representant_id}` : `U:${d.personne_id}`);
  if (!compte) return res.redirect(back);
  if (d.demandeur_id === req.session.userId || compte.personne_id === req.session.userId) { flash(req, "error_msg", "Vous ne pouvez pas confirmer votre propre demande ni une demande sur votre compte : un autre agent de caisse doit le faire."); return res.redirect(back); }
  if (req.params.decision === "refuser") {
    const motif = String(req.body.motif || req.body.motif_refus || "").trim() || null;
    await prisma.demandeCompte.update({ where: { id: d.id }, data: { etat: "REFUSEE", traite_par_id: req.session.userId, traite_at: new Date(), motif_refus: motif } });
    await notifyUsers([d.demandeur_id], "Demande refusée par la caisse", `${d.montant.toLocaleString("fr-FR")} F · ${compte.nom}${motif ? " · " + motif : ""}`, d.personne_id ? `/comptes/personnel/${d.personne_id}` : `/comptes/representant/${d.representant_id}`);
    flash(req, "success_msg", "Demande refusée : rien n'a bougé.");
    return res.redirect(back);
  }
  const r = await mouvementCompte(compte, { sens: d.sens, montant: d.montant, mode: d.mode, banque: d.banque, motif: d.motif, reference: d.reference }, req.session.userId);
  if (!r.ok) { flash(req, "error_msg", r.message); return res.redirect(back); }
  await prisma.demandeCompte.update({ where: { id: d.id }, data: { etat: "CONFIRMEE", traite_par_id: req.session.userId, traite_at: new Date(), mouvement_id: r.m.id } });
  await notifyUsers([d.demandeur_id], "Demande confirmée par la caisse", r.message, d.personne_id ? `/comptes/personnel/${d.personne_id}` : `/comptes/representant/${d.representant_id}`);
  flash(req, "success_msg", `Demande confirmée. ${r.message}`);
  res.redirect(back);
});

// Clôture du jour : solde compté contre solde théorique
router.post("/caisse/cloture", requireAuth, async (req: any, res: any) => {
  const user = req.session.user;
  if (!CAISSE_WRITE.includes(user?.role)) { flash(req, "error_msg", "Seule la caisse clôture la journée."); return res.redirect("/caisse"); }
  const theorique = await solde();
  const compte = num(req.body.solde_compte);
  const ecart = compte - theorique;
  await prisma.caisseCloture.create({ data: { date: new Date(), solde_theorique: theorique, solde_compte: compte, ecart, observations: String(req.body.observations || "").trim() || null, user_id: req.session.userId } });
  await logActivity(req.session.userId, "CAISSE_CLOTURE", "CaisseCloture", Math.round(ecart));
  if (Math.abs(ecart) >= 1) {
    await notifyRoles(["daf"], `⚖️ Écart de caisse : ${Math.round(ecart).toLocaleString("fr-FR")} F`, `Clôture du ${new Date().toLocaleDateString("fr-FR")} : compté ${Math.round(compte).toLocaleString("fr-FR")} F pour ${Math.round(theorique).toLocaleString("fr-FR")} F attendus.`, "/caisse");
  }
  flash(req, "success_msg", Math.abs(ecart) < 1 ? "Journée clôturée : la caisse est juste." : `Journée clôturée avec un écart de ${Math.round(ecart).toLocaleString("fr-FR")} F (le DAF est prévenu).`);
  res.redirect("/caisse");
});

// =====================================================================
// Dépenses internes (bons provisoires sans dossier)
// =====================================================================
const piecesUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _f, cb) => { const d = path.join(process.cwd(), "uploads", "temp"); fs.mkdirSync(d, { recursive: true }); cb(null, d); },
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}-${file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, "_")}`),
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, /pdf|jpe?g|png/i.test(file.mimetype)),
}).array("pieces", 5);

// Registre des bons payés : chaque jour, classés selon la façon dont ils ont été émis, avec leur reçu
const REGISTRE_READ = [...CAISSE_READ, "comptable_ops"];
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parseDay = (v: any) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || "")); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };

router.get("/caisse/bons-payes", requireAuth, async (req: any, res: any) => {
  const role = req.session.user?.role;
  if (!REGISTRE_READ.includes(role)) {
    flash(req, "error_msg", "Le registre des bons payés est réservé à la caisse, à la direction, à la comptabilité et à l'audit.");
    return res.redirect("/dashboard");
  }
  const q = req.query;
  const du = parseDay(q.du) || dayStart();
  let au = parseDay(q.au) || du;
  if (au < du) au = du;
  const fin = new Date(au.getTime() + 864e5);
  const recherche = String(q.q || "").trim();
  const manque = q.manque === "1";
  const bons = await prisma.bonProvisoir.findMany({
    where: {
      etat: "APPROUVE",
      OR: [{ paye_at: { gte: du, lt: fin } }, { paye_at: null, approved_at: { gte: du, lt: fin } }],
      ...(manque ? { recu_papier: null, recu_scan: null } : {}),
      ...(recherche ? { AND: [{ OR: [
        { numero: { contains: recherche, mode: "insensitive" } }, { objet: { contains: recherche, mode: "insensitive" } },
        { recu_numero: { contains: recherche, mode: "insensitive" } }, { recu_papier: { contains: recherche, mode: "insensitive" } },
        { demandeur: { nom: { contains: recherche, mode: "insensitive" } } }, { dossier: { numero: { contains: recherche, mode: "insensitive" } } },
      ] }] } : {}),
    },
    include: {
      demandeur: { select: { nom: true, prenom: true, role: true } },
      dossier: { select: { id: true, numero: true, numero_ordre: true, client: { select: { nom: true } } } },
      mouvements: { where: { sens: "SORTIE" }, orderBy: { id: "asc" }, take: 1, select: { mode: true, reference: true } },
      bon_reel: { select: { montant_reel: true, confirme_at: true } },
    },
    orderBy: [{ paye_at: "asc" }, { id: "asc" }],
  });
  const lignes = bons.map((b) => ({ ...b, origine: origineDe(b), sousCat: sousCategorie(b), date: b.paye_at || b.approved_at || b.created_at, mode: b.mouvements[0]?.mode || "ESPECES", reference: b.mouvements[0]?.reference || null, signe: !!(b.recu_papier || b.recu_scan) }));
  const groupes = ORIGINES.map((o) => {
    const rows = lignes.filter((l) => l.origine === o.key);
    const sous = o.key === "INTERNE" ? Object.entries(rows.reduce((m: any, r) => { m[r.sousCat || "Autre"] = (m[r.sousCat || "Autre"] || 0) + r.montant_demande; return m; }, {})) : [];
    return { ...o, rows, total: rows.reduce((t, r) => t + r.montant_demande, 0), sous };
  });
  const total = lignes.reduce((t, r) => t + r.montant_demande, 0);
  const aSaisir = lignes.filter((l) => !l.signe).length;

  if (q.format === "csv") {
    const esc = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lab = Object.fromEntries(ORIGINES.map((o) => [o.key, o.label]));
    const rows = [["Date", "Catégorie d'émission", "Sous-catégorie", "N° bon", "Reçu de caisse", "N° reçu papier", "Bénéficiaire", "Service", "Objet", "Dossier", "Client", "Mode", "Référence", "Montant payé", "Dépense justifiée", "Payé par"].join(";"),
      ...groupes.flatMap((g) => g.rows).map((l) => [new Date(l.date).toLocaleString("fr-FR"), lab[l.origine], l.sousCat || "", l.numero, l.recu_numero || "", l.recu_papier || "",
        `${l.demandeur.prenom || ""} ${l.demandeur.nom}`.trim(), l.service, l.objet, l.dossier ? (l.dossier.numero_ordre || l.dossier.numero) : "", l.dossier?.client?.nom || "",
        l.mode, l.reference || "", Math.round(l.montant_demande), l.bon_reel ? Math.round(l.bon_reel.montant_reel) : "", l.paye_par || ""].map(esc).join(";"))];
    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set("Content-Disposition", `attachment; filename="bons-payes-${ymd(du)}${+au !== +du ? "_" + ymd(au) : ""}.csv"`);
    return res.send("\ufeff" + rows.join("\r\n"));
  }

  const jour = +au === +du;
  res.render("caisse/bons-payes", {
    title: "Bons payés", path: "/caisse/bons-payes",
    groupes, total, aSaisir, nb: lignes.length, canWrite: CAISSE_WRITE.includes(role),
    du: ymd(du), au: ymd(au), jour, recherche, manque,
    veille: ymd(new Date(du.getTime() - 864e5)), lendemain: ymd(new Date(du.getTime() + 864e5)), aujourdhui: ymd(dayStart()),
    debutMois: ymd(new Date(du.getFullYear(), du.getMonth(), 1)),
  });
});

router.get("/depenses", requireAuth, async (req: any, res: any) => {
  const user = req.session.user;
  const seeAll = [...CAISSE_READ].includes(user.role);
  const tous = seeAll && req.query.tous === "1";
  const bons = await prisma.bonProvisoir.findMany({
    where: { type: "INTERNE", ...(tous ? {} : { demandeur_id: req.session.userId }) },
    include: { demandeur: { select: { nom: true, prenom: true } }, bon_reel: { select: { id: true, montant_reel: true, ecart: true, confirme_at: true } } },
    orderBy: { created_at: "desc" },
    take: 200,
  });
  const [services, monService] = await Promise.all([servicesActifs(), userDeptId(req.session.userId)]);
  // Depuis une demande d'achat ou de réparation approuvée : formulaire pré-rempli
  let prefill: any = null;
  const dm = parseInt(req.query.demande);
  if (dm) {
    const d = await prisma.demande.findFirst({ where: { id: dm, demandeur_id: req.session.userId, etat: "APPROUVEE", type: { in: ["ACHAT", "REPARATION"] } } });
    if (d) prefill = { objet: `${d.titre} (demande ${d.numero} approuvée)`, montant: d.montant || "", categorie: d.type === "REPARATION" ? "ENTRETIEN" : "INFORMATIQUE", designation: d.titre, departement_id: d.departement_id };
  }
  // Débours : les dossiers ouverts, les plus récents d'abord, pour émettre un bon de dossier depuis cette page
  const dossiersOuverts = await prisma.dossier.findMany({ where: { pipeline_status: { notIn: ["CLOTURE", "ARCHIVE"] } }, select: { id: true, numero: true, numero_ordre: true, bl: true, contenu: true, pipeline_status: true, created_at: true, client: { select: { nom: true } } }, orderBy: { created_at: "desc" }, take: 300 });
  res.render("depenses/index", { title: "Dépenses internes", services, monService, prefill, bons, tous, seeAll, dossiersOuverts, STEP_LABELS: Object.fromEntries(STEPS.map((x) => [x.key, x.label])), DEPENSE_CATEGORIES, categorieLabel, visaProgress, threshold: INTERNAL_PDG_THRESHOLD, VISA_LABELS });
});

router.post("/depenses", requireAuth, (req: any, res: any) => {
  piecesUpload(req, res, async (err: any) => {
    if (err) { flash(req, "error_msg", `Pièce refusée : ${err.message}`); return res.redirect("/depenses"); }
    const user = req.session.user;
    const b = req.body;
    let items: any[] = [];
    try { items = JSON.parse(b.items_json || "[]"); } catch { items = []; }
    items = items.map((it) => ({ designation: String(it.designation || "").trim(), montant: num(it.montant) })).filter((it) => it.designation && it.montant > 0);
    const total = items.reduce((t, it) => t + it.montant, 0);
    const objet = String(b.objet || "").trim();
    const categorie = DEPENSE_CATEGORIES.some((c) => c.key === b.categorie) ? b.categorie : "AUTRE";
    if (!objet || !(total > 0)) { flash(req, "error_msg", "Indiquez l'objet et au moins une ligne avec un montant."); return res.redirect("/depenses"); }

    let numero = generateRef("BP");
    while (await prisma.bonProvisoir.findUnique({ where: { numero } })) numero = generateRef("BP");
    const bon = await prisma.bonProvisoir.create({
      data: { numero, type: "INTERNE", categorie, urgent: b.urgent === "1", dossier_id: null, service: user.role, demandeur_id: req.session.userId, objet, montant_demande: total,
        items_json: JSON.stringify(items), etat: "EN_ATTENTE", ...initialTicks("INTERNE", total), departement_id: await pickDept(b.departement_id) },
    });
    const files = (req.files as Express.Multer.File[]) || [];
    if (files.length) {
      const dir = path.join(process.cwd(), "uploads", "bons", String(bon.id));
      fs.mkdirSync(dir, { recursive: true });
      const pieces = files.map((f) => { fs.renameSync(f.path, path.join(dir, f.filename)); return { filename: f.filename, original: f.originalname }; });
      await prisma.bonProvisoir.update({ where: { id: bon.id }, data: { pieces_json: JSON.stringify(pieces) } });
    }
    await logActivity(req.session.userId, "DEPENSE_INTERNE_CREEE", "BonProvisoir", bon.id);
    const req_ = requiredVisas("INTERNE", total);
    const qui = `${user.prenom || ""} ${user.nom}`.trim();
    // Le PDG est appelé après le visa du DAF ; le DG est informé
    await notifyRoles(INTERNE_INFORMES, `ℹ️ Nouvelle dépense interne ${numero}`, `${qui} · ${categorieLabel(categorie)} · ${total.toLocaleString("fr-FR")} F · ${objet}. Pour information.`, `/bons/${bon.id}`);
    await notifyRoles(req_.filter((k) => k !== "pdg").flatMap((k) => ROLES_BY_VISA[k]), `${b.urgent === "1" ? "🔴 URGENT · " : "✍️ "}Dépense interne à viser : ${numero}`, `${qui} · ${categorieLabel(categorie)} · ${total.toLocaleString("fr-FR")} F · ${objet}`, `/bons/visas#bon-${bon.id}`);
    await notifyRoles(CAISSE_ROLES, `${b.urgent === "1" ? "🔴 URGENT · " : "🧾 "}Nouvelle dépense interne ${numero}`, `${qui} · ${total.toLocaleString("fr-FR")} F · visas : ${req_.map((k) => VISA_LABELS[k]).join(", ")}.`, `/bons/provisoir/pending#bon-${bon.id}`);
    flash(req, "success_msg", `Demande ${numero}${b.urgent === "1" ? " (URGENT)" : ""} envoyée (${total.toLocaleString("fr-FR")} F). Visas requis : ${req_.map((k) => VISA_LABELS[k]).join(", ")}.`);
    res.redirect(`/bons/${bon.id}`);
  });
});

router.get("/depenses/:id/justifier", requireAuth, async (req: any, res: any) => {
  const bp = await prisma.bonProvisoir.findUnique({ where: { id: parseInt(req.params.id) }, include: { bon_reel: true, dossier: { select: { id: true, numero: true, client: { select: { nom: true } } } } } });
  if (!bp) return res.redirect("/depenses");
  if (bp.bon_reel) return res.redirect(`/bons/${bp.id}`);
  if (bp.etat !== "APPROUVE") { flash(req, "error_msg", "Ce bon n'a pas encore été payé par la caisse."); return res.redirect(`/bons/${bp.id}`); }
  // Le demandeur justifie sa dépense ; pour un bon de dossier, le service terrain peut aussi le faire
  const terrain = !!bp.dossier_id && ["acconage", "enlevement"].includes(req.session.user.role);
  if (bp.demandeur_id !== req.session.userId && req.session.user.role !== "super_admin" && !terrain) { flash(req, "error_msg", "Seul le demandeur justifie sa dépense."); return res.redirect(`/bons/${bp.id}`); }
  let items: any[] = [];
  try { items = bp.items_json ? JSON.parse(bp.items_json) : []; } catch { items = []; }
  if (!items.length) items = [{ designation: bp.objet, montant: bp.montant_demande }];
  res.render("depenses/justifier", { title: `Justifier ${bp.numero}`, bp, items, categorieLabel });
});

// =====================================================================
// Mon espace : ce qui attend l'utilisateur, ses demandes, ses dépenses du mois
// =====================================================================
router.get("/mon-espace", requireAuth, async (req: any, res: any) => {
  const user = req.session.user;
  const uid = req.session.userId;
  const myStages = STEPS.filter((s) => s.owners.includes(user.role)).map((s) => s.key);
  const month = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const [dossiers, taches, mesBons, aJustifier] = await Promise.all([
    myStages.length ? prisma.dossier.findMany({ where: { pipeline_status: { in: myStages } }, include: { client: { select: { nom: true } } }, orderBy: { stage_entered_at: "asc" }, take: 50 }) : Promise.resolve([]),
    prisma.tache.findMany({ where: { intervenant_id: uid, archive: false, etat: { notIn: ["FAIT", "TERMINE"] } }, include: { dossier: { select: { id: true, numero: true } } }, orderBy: { deadline: "asc" }, take: 20 }),
    prisma.bonProvisoir.findMany({ where: { demandeur_id: uid }, include: { dossier: { select: { id: true, numero: true } }, bon_reel: { select: { montant_reel: true, confirme_at: true } } }, orderBy: { created_at: "desc" }, take: 30 }),
    prisma.bonProvisoir.findMany({ where: { demandeur_id: uid, etat: "APPROUVE", bon_reel: null }, select: { id: true, numero: true, type: true, dossier_id: true, montant_demande: true, objet: true } }),
  ]);
  const duMois = mesBons.filter((b) => b.created_at >= month);
  const stats = {
    demande: duMois.reduce((t, b) => t + b.montant_demande, 0),
    paye: duMois.filter((b) => b.etat === "APPROUVE").reduce((t, b) => t + b.montant_demande, 0),
    depense: duMois.reduce((t, b) => t + (b.bon_reel?.montant_reel || 0), 0),
    enAttente: mesBons.filter((b) => b.etat === "EN_ATTENTE").length,
  };
  res.render("espace/index", { title: "Mon espace", dossiers, taches, mesBons, aJustifier, stats, myStages, hoursLate, visaProgress, categorieLabel });
});

export default router;
