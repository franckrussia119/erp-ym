import prisma from "./prismaClient";
import { missingRequirements } from "./pipeline";
import { initialTicks, visaProgress, ROLES_BY_VISA, CAISSE_ROLES } from "./bons";
import { notifyRoles } from "./prismaClient";
import { generateRef } from "./generateRef";

// Reliquats des bons provisoires : ce que le porteur rend à la caisse ou ce que la caisse lui doit encore.
// Un porteur peut rendre de l'argent avant de justifier (« retour en caisse ») : ce montant est déduit
// au moment de régulariser son bon réel.

const nom = (u: { prenom?: string | null; nom: string } | null | undefined) => (u ? `${u.prenom || ""} ${u.nom}`.trim() : "");

// Un dossier au stade « Bon réel » passe en facturation quand tous ses bons payés sont justifiés,
// qu'aucun bon n'attend encore, et que le BAE (et la visite si circuit jaune/rouge) sont saisis.
export async function advanceIfJustified(dId: number): Promise<string[] | null> {
  const d = await prisma.dossier.findUnique({ where: { id: dId }, include: { files: true, documents: true, bons_provisoir: { include: { bon_reel: true } } } });
  if (!d || d.pipeline_status !== "BON_REEL") return null;
  const pending = d.bons_provisoir.filter((b) => b.etat === "EN_ATTENTE" || b.etat === "A_MODIFIER").length;
  const unjustified = d.bons_provisoir.filter((b) => b.etat === "APPROUVE" && !b.bon_reel).map((b) => `bon réel du ${b.numero}`);
  const missing = [...unjustified, ...(pending ? [`${pending} bon(s) encore en attente de paiement`] : []), ...missingRequirements(d, "BON_REEL")];
  if (missing.length) return missing;
  await prisma.dossier.update({ where: { id: dId }, data: { pipeline_status: "FACTURATION" } });
  return [];
}

// Argent déjà rendu à la caisse sur un bon avant sa justification
export async function dejaRendu(bonIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!bonIds.length) return out;
  const g = await prisma.caisseMouvement.groupBy({ by: ["bon_id"], where: { bon_id: { in: bonIds }, categorie: "RETOUR_BON" }, _sum: { montant: true } });
  for (const x of g) if (x.bon_id) out.set(x.bon_id, x._sum.montant || 0);
  return out;
}

// Bons justifiés dont la régularisation attend la caisse. du > 0 : à recevoir du porteur ; du < 0 : à lui payer.
export async function regularisationsEnAttente() {
  const list = await prisma.bonReel.findMany({
    where: { confirme_at: null },
    include: { bon_provisoir: { select: { id: true, numero: true, objet: true, demandeur_id: true, urgent: true, dossier: { select: { id: true, numero: true } } } }, soumis_par: { select: { id: true, nom: true, prenom: true } } },
    orderBy: { created_at: "asc" },
  });
  const rendu = await dejaRendu(list.map((r) => r.bon_provisoir_id));
  return list.map((r) => ({ ...r, rendu: rendu.get(r.bon_provisoir_id) || 0, du: Math.round(r.ecart - (rendu.get(r.bon_provisoir_id) || 0)), porteur: nom(r.soumis_par) }));
}

// Bons payés pas encore justifiés : le porteur peut rendre tout ou partie de l'argent (retour en caisse)
export async function bonsPayesNonJustifies() {
  const list = await prisma.bonProvisoir.findMany({
    where: { etat: "APPROUVE", bon_reel: null },
    include: { demandeur: { select: { id: true, nom: true, prenom: true } }, dossier: { select: { id: true, numero: true } } },
    orderBy: { paye_at: "asc" },
  });
  const rendu = await dejaRendu(list.map((b) => b.id));
  return list.map((b) => ({ ...b, rendu: rendu.get(b.id) || 0, reste: Math.round(b.montant_demande - (rendu.get(b.id) || 0)), porteur: nom(b.demandeur) }));
}

// La caisse solde la régularisation d'un bon réel : encaisse le reliquat ou paie le complément
export async function regulariser(bonReelId: number, userId: number, opts: { mode?: string; reference?: string | null } = {}) {
  const bonReel = await prisma.bonReel.findUnique({ where: { id: bonReelId }, include: { bon_provisoir: true, soumis_par: true } });
  if (!bonReel) return { ok: false, message: "Bon réel introuvable." };
  if (bonReel.confirme_at) return { ok: false, message: "Cette régularisation est déjà confirmée." };
  const bp = bonReel.bon_provisoir;
  const rendu = (await dejaRendu([bp.id])).get(bp.id) || 0;
  const du = Math.round(bonReel.ecart - rendu);
  const f = (n: number) => Math.round(n).toLocaleString("fr-FR");
  const base = { tiers: nom(bonReel.soumis_par), bon_id: bp.id, dossier_id: bonReel.dossier_id, user_id: userId, personne_id: bonReel.soumis_par_id, mode: opts.mode || "ESPECES", reference: opts.reference || null };
  // Dépense plus élevée que l'avance : le complément passe par un bon supplémentaire, visé comme tout bon
  if (du < 0) {
    const sup = await creerBonSupplementaire(bonReelId, -du, userId);
    return { ok: true, du, message: `Bon supplémentaire ${sup.numero} créé pour ${f(-du)} F : il suit les visas avant d'être payé par la caisse.`, bon: bp };
  }
  const ops: any[] = [prisma.bonReel.update({ where: { id: bonReelId }, data: { confirme_par_id: userId, confirme_at: new Date() } })];
  if (du > 0) ops.push(prisma.caisseMouvement.create({ data: { ...base, sens: "ENTREE", montant: du, categorie: "RELIQUAT", libelle: `Reliquat rendu · bon ${bp.numero}` } }));
  else if (du < 0) ops.push(prisma.caisseMouvement.create({ data: { ...base, sens: "SORTIE", montant: -du, categorie: "COMPLEMENT", libelle: `Complément payé · bon ${bp.numero}` } }));
  await prisma.$transaction(ops);
  const deja = rendu > 0 ? ` (${f(rendu)} F déjà rendus avant la justification)` : "";
  const message = du > 0 ? `Reliquat de ${f(du)} F encaissé${deja}.` : du < 0 ? `Complément de ${f(-du)} F payé${deja}.` : `Aucun écart à régler${deja}.`;
  return { ok: true, du, message, bon: bp };
}

// Retour en caisse avant justification. Si tout l'argent revient, le bon est clos (aucune dépense).
export async function retourEnCaisse(bonId: number, montant: number, userId: number, opts: { mode?: string; reference?: string | null; date?: Date } = {}) {
  const bp = await prisma.bonProvisoir.findUnique({ where: { id: bonId }, include: { bon_reel: true, demandeur: true } });
  if (!bp || bp.etat !== "APPROUVE" || bp.bon_reel) return { ok: false, message: "Ce bon n'est pas un bon payé en attente de justification." };
  const rendu = (await dejaRendu([bp.id])).get(bp.id) || 0;
  const reste = Math.round(bp.montant_demande - rendu);
  if (montant > reste + 0.5) return { ok: false, message: `Le porteur ne peut pas rendre plus que ce qui lui reste du bon ${bp.numero} (${reste.toLocaleString("fr-FR")} F).` };
  await prisma.caisseMouvement.create({
    data: { sens: "ENTREE", montant, categorie: "RETOUR_BON", libelle: `Retour en caisse · bon ${bp.numero}`, tiers: nom(bp.demandeur), bon_id: bp.id, dossier_id: bp.dossier_id,
      personne_id: bp.demandeur_id, user_id: userId, mode: opts.mode || "ESPECES", reference: opts.reference || null, date: opts.date || new Date() },
  });
  if (montant >= reste - 0.5) {
    await prisma.bonReel.create({
      data: { bon_provisoir_id: bp.id, dossier_id: bp.dossier_id, montant_provisoir: bp.montant_demande, montant_reel: 0, ecart: bp.montant_demande,
        observations: "Argent rendu en totalité à la caisse : aucune dépense.", items_json: "[]", soumis_par_id: bp.demandeur_id, confirme_par_id: userId, confirme_at: new Date() },
    });
    if (bp.dossier_id) await advanceIfJustified(bp.dossier_id);
    return { ok: true, clos: true, message: `${montant.toLocaleString("fr-FR")} F rendus : tout l'argent du bon ${bp.numero} est revenu, le bon est clos.` };
  }
  return { ok: true, clos: false, message: `${montant.toLocaleString("fr-FR")} F rendus sur le bon ${bp.numero}. Il reste ${(reste - montant).toLocaleString("fr-FR")} F à justifier ; ce retour sera déduit à la régularisation.` };
}

// Au démarrage : les mouvements déjà liés à un bon sont rangés sur le compte de son porteur
export async function ensureComptesPersonnes() {
  const n = await prisma.$executeRawUnsafe(
    `UPDATE "CaisseMouvement" m SET personne_id = b.demandeur_id FROM "BonProvisoir" b WHERE m.bon_id = b.id AND m.personne_id IS NULL`,
  );
  if (n) console.log(`[CAISSE] ${n} mouvement(s) rangé(s) sur le compte de leur porteur.`);
}

// Bon supplémentaire : quand la dépense réelle dépasse l'avance, le complément devient un nouveau bon
// (même dossier, même porteur) qui suit les visas avant la caisse. La régularisation du bon d'origine est close :
// sa dépense réelle couvre déjà le tout, le bon supplémentaire n'a donc pas à être justifié à son tour.
export async function creerBonSupplementaire(bonReelId: number, montant: number, userId: number | null) {
  const br = await prisma.bonReel.findUnique({ where: { id: bonReelId }, include: { bon_provisoir: { include: { dossier: { select: { numero: true } } } } } });
  if (!br) throw new Error("Bon réel introuvable");
  const bp = br.bon_provisoir;
  const deja = await prisma.bonProvisoir.findFirst({ where: { bon_parent_id: bp.id, etat: { not: "REJETE" } } });
  if (deja) return deja;
  let numero = `${bp.numero}-S`;
  if (await prisma.bonProvisoir.findUnique({ where: { numero } })) numero = generateRef("BP");
  const sup = await prisma.bonProvisoir.create({
    data: { numero, type: bp.type, categorie: bp.categorie, urgent: bp.urgent, dossier_id: bp.dossier_id, departement_id: bp.departement_id, service: bp.service, demandeur_id: bp.demandeur_id,
      objet: `Bon supplémentaire · ${bp.objet}`, montant_demande: montant, items_json: JSON.stringify([{ designation: `Complément du bon ${bp.numero} (dépense réelle au-delà de l'avance)`, montant }]),
      etat: "EN_ATTENTE", bon_parent_id: bp.id, ...initialTicks(bp.type, montant) },
  });
  await prisma.bonReel.update({ where: { id: bonReelId }, data: { confirme_at: new Date(), confirme_par_id: userId, observations: [br.observations, `Complément de ${Math.round(montant).toLocaleString("fr-FR")} F demandé par le bon supplémentaire ${numero}.`].filter(Boolean).join(" ") } });
  const quoi = `${bp.dossier ? "Dossier " + bp.dossier.numero : "Dépense interne"} · ${Math.round(montant).toLocaleString("fr-FR")} F · complément du bon ${bp.numero}`;
  const req = visaProgress(sup).missing.filter((k) => !(sup.type === "INTERNE" && k === "pdg"));
  await notifyRoles(req.flatMap((k) => ROLES_BY_VISA[k]), `✍️ Bon supplémentaire à viser : ${numero}`, quoi, `/bons/visas#bon-${sup.id}`);
  await notifyRoles(CAISSE_ROLES, `🧾 Bon supplémentaire ${numero}`, `${quoi}. Visas en cours.`, `/bons/${sup.id}`);
  return sup;
}

// Paiement d'un bon supplémentaire : rien à justifier, la dépense est dans le bon réel du bon d'origine
export async function cloreSupplementPaye(bonId: number) {
  const b = await prisma.bonProvisoir.findUnique({ where: { id: bonId }, include: { bon_reel: true } });
  if (!b?.bon_parent_id || b.bon_reel) return;
  await prisma.bonReel.create({ data: { bon_provisoir_id: b.id, dossier_id: b.dossier_id, montant_provisoir: b.montant_demande, montant_reel: 0, ecart: 0, items_json: "[]",
    observations: "Bon supplémentaire : la dépense est justifiée par le bon réel du bon d'origine.", soumis_par_id: b.demandeur_id, confirme_at: new Date() } });
  if (b.dossier_id) await advanceIfJustified(b.dossier_id);
}
