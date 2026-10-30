import { Router } from "express";
import { requireAuth } from "./rbac";
import prisma from "../lib/prismaClient";
import { clearDeptCache } from "../lib/departements";
import { getLiens, setLiens, urlValide, LIEN_ICONS } from "../lib/liens";
import { roleLabel } from "../lib/roles";

// Services de l'entreprise (centres de coût) et résultat par service
const router = Router();
const flash = (req: any, kind: "success_msg" | "error_msg", msg: string) => { req.session[kind] = msg; };
const MANAGE = ["super_admin", "pdg", "dg", "dga", "rh"];
const REPORT = ["super_admin", "pdg", "dg", "dga", "daf", "auditeur1", "auditeur2", "analyste", "comptable", "comptable_ops", "fiscalite", "finances"];
export const DEPT_ICONS = ["bi-building", "bi-box-seam", "bi-truck", "bi-calculator", "bi-people", "bi-megaphone", "bi-boxes", "bi-diagram-3", "bi-tools", "bi-shield-check", "bi-headset", "bi-globe2"];

router.get("/admin/services", requireAuth, async (req: any, res: any) => {
  if (!MANAGE.includes(req.session.user.role)) { flash(req, "error_msg", "Réservé à la direction et aux RH."); return res.redirect("/dashboard"); }
  const [services, users] = await Promise.all([
    prisma.departement.findMany({ orderBy: [{ actif: "desc" }, { ordre: "asc" }, { nom: "asc" }], include: { responsable: { select: { id: true, nom: true, prenom: true } }, membres: { where: { actif: true }, select: { id: true, nom: true, prenom: true, role: true }, orderBy: { nom: "asc" } } } }),
    prisma.user.findMany({ where: { actif: true }, select: { id: true, nom: true, prenom: true, role: true, departement_id: true }, orderBy: { nom: "asc" } }),
  ]);
  res.render("admin/services", { title: "Services", services, users, icons: DEPT_ICONS, sansService: users.filter((u) => !u.departement_id), roleLabel, isSuperAdmin: req.session.user.role === "super_admin" });
});

const clean = (b: any) => ({
  nom: String(b.nom || "").trim().slice(0, 80),
  couleur: /^#[0-9a-f]{6}$/i.test(b.couleur || "") ? b.couleur : "#059669",
  icone: DEPT_ICONS.includes(b.icone) ? b.icone : "bi-diagram-3",
  description: String(b.description || "").trim().slice(0, 240) || null,
  responsable_id: parseInt(b.responsable_id) || null,
});

router.post("/admin/services", requireAuth, async (req: any, res: any) => {
  if (!MANAGE.includes(req.session.user.role)) return res.redirect("/dashboard");
  const data = clean(req.body);
  if (!data.nom) { flash(req, "error_msg", "Donnez un nom au service."); return res.redirect("/admin/services"); }
  const base = data.nom.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 20) || "SERVICE";
  let code = base, i = 2;
  while (await prisma.departement.findUnique({ where: { code } })) code = `${base}_${i++}`;
  const max = await prisma.departement.aggregate({ _max: { ordre: true } });
  await prisma.departement.create({ data: { ...data, code, ordre: (max._max.ordre || 0) + 1 } });
  clearDeptCache();
  flash(req, "success_msg", `Service « ${data.nom} » créé.`);
  res.redirect("/admin/services");
});

router.post("/admin/services/:id", requireAuth, async (req: any, res: any) => {
  if (!MANAGE.includes(req.session.user.role)) return res.redirect("/dashboard");
  const id = parseInt(req.params.id);
  const data = clean(req.body);
  if (!data.nom) { flash(req, "error_msg", "Le nom ne peut pas être vide."); return res.redirect("/admin/services"); }
  await prisma.departement.update({ where: { id }, data: { ...data, actif: req.body.actif !== "0" } });
  // Membres : liste complète envoyée par le formulaire
  if (req.body.membres_sent) {
    const ids = ([] as any[]).concat(req.body.membres || []).map((x) => parseInt(x)).filter((x) => !isNaN(x));
    await prisma.user.updateMany({ where: { departement_id: id, id: { notIn: ids } }, data: { departement_id: null } });
    if (ids.length) await prisma.user.updateMany({ where: { id: { in: ids } }, data: { departement_id: id } });
    const sortis = await prisma.user.findMany({ where: { departement_id: null }, select: { id: true } });
    await prisma.employe.updateMany({ where: { user_id: { in: ids } }, data: { departement_id: id } });
    await prisma.employe.updateMany({ where: { departement_id: id, user_id: { in: sortis.map((x) => x.id) } }, data: { departement_id: null } });
  }
  clearDeptCache();
  flash(req, "success_msg", `Service « ${data.nom} » enregistré.`);
  res.redirect("/admin/services");
});

// Ranger un employé existant dans un service, ou le nommer responsable. Les comptes se créent dans Administration › Utilisateurs.
router.post("/admin/services/:id/membres", requireAuth, async (req: any, res: any) => {
  if (!MANAGE.includes(req.session.user.role)) return res.redirect("/dashboard");
  const svc = await prisma.departement.findUnique({ where: { id: parseInt(req.params.id) } });
  if (!svc) return res.redirect("/admin/services");
  const back = `/admin/services#svc-card-${svc.id}`;
  const [action, uid] = String(req.body.pick || "").split(":");
  const u = await prisma.user.findFirst({ where: { id: parseInt(uid) || -1, actif: true }, include: { departement: { select: { nom: true } } } });
  if (!u || !["membre", "responsable", "retirer"].includes(action)) { flash(req, "error_msg", "Choisissez un employé dans la liste."); return res.redirect(back); }
  const qui = [u.prenom, u.nom].filter(Boolean).join(" ");
  const ranger = async (depId: number | null) => {
    await prisma.user.update({ where: { id: u.id }, data: { departement_id: depId } });
    await prisma.employe.updateMany({ where: { user_id: u.id }, data: { departement_id: depId } });
  };
  let msg: string;
  if (action === "retirer") {
    if (u.departement_id === svc.id) await ranger(null);
    if (svc.responsable_id === u.id) await prisma.departement.update({ where: { id: svc.id }, data: { responsable_id: null } });
    msg = `${qui} retiré du service ${svc.nom}.`;
  } else if (action === "responsable") {
    await prisma.departement.update({ where: { id: svc.id }, data: { responsable_id: u.id } });
    // Sans service, il rejoint celui qu'il dirige ; s'il est déjà ailleurs, on ne le déplace pas
    if (!u.departement_id) await ranger(svc.id);
    msg = `${qui} est maintenant responsable du service ${svc.nom}.` + (u.departement_id && u.departement_id !== svc.id ? ` Il reste membre de ${u.departement?.nom}.` : "");
  } else {
    await ranger(svc.id);
    msg = `${qui} ajouté au service ${svc.nom}` + (u.departement_id && u.departement_id !== svc.id ? ` (retiré de ${u.departement?.nom}).` : ".");
  }
  await prisma.activityLog.create({ data: { user_id: req.session.userId, action: "SERVICE_" + action.toUpperCase(), entity: "Departement", entity_id: String(svc.id) } }).catch(() => null);
  clearDeptCache();
  flash(req, "success_msg", msg);
  res.redirect(back);
});

// Résultat par service : facturé, encaissé, dépensé, sur une période
router.get("/rapports/services", requireAuth, async (req: any, res: any) => {
  if (!REPORT.includes(req.session.user.role)) { flash(req, "error_msg", "Réservé à la direction et à la finance."); return res.redirect("/dashboard"); }
  const now = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const du = /^\d{4}-\d{2}-\d{2}$/.test(req.query.du || "") ? req.query.du : iso(new Date(now.getFullYear(), now.getMonth(), 1));
  const au = /^\d{4}-\d{2}-\d{2}$/.test(req.query.au || "") ? req.query.au : iso(now);
  const range = { gte: new Date(du + "T00:00:00"), lte: new Date(au + "T23:59:59.999") };

  // Paies validées dont le mois tombe dans la période
  const d0 = new Date(du + "T00:00:00"), d1 = new Date(au + "T00:00:00");
  const moisDans = (p: { annee: number; mois: number }) => { const k = p.annee * 12 + p.mois - 1; return k >= d0.getFullYear() * 12 + d0.getMonth() && k <= d1.getFullYear() * 12 + d1.getMonth(); };
  const periodes = (await prisma.periodePaie.findMany({ where: { statut: { not: "BROUILLON" } } })).filter(moisDans);
  const salaires = periodes.length ? await prisma.bulletinPaie.groupBy({ by: ["departement_id"], where: { periode_id: { in: periodes.map((p) => p.id) } }, _sum: { cout_total: true } }) : [];
  const [services, factures, caisse, fournisseurs] = await Promise.all([
    prisma.departement.findMany({ orderBy: { ordre: "asc" } }),
    prisma.document.groupBy({ by: ["departement_id"], where: { type: "FACTURE", etat: { notIn: ["BROUILLON", "ANNULE", "ANNULEE"] }, created_at: range }, _sum: { total_ht: true }, _count: true }),
    prisma.caisseMouvement.groupBy({ by: ["departement_id", "sens", "categorie"], where: { date: range }, _sum: { montant: true } }),
    prisma.factureFournisseur.groupBy({ by: ["departement_id"], where: { date: range }, _sum: { montant_ht: true } }),
  ]);
  // Mouvements de trésorerie qui ne sont ni une recette ni une dépense
  const NEUTRES = new Set(["APPROVISIONNEMENT", "VERSEMENT_BANQUE", "PAIE"]); // la paie est comptée à part (salaires)
  type Row = { id: number | null; nom: string; couleur: string; icone: string; facture: number; nbFactures: number; encaisse: number; depenses: number; fournisseurs: number; salaires: number; resultat: number; cats: Record<string, number> };
  const rows = new Map<number | null, Row>();
  const row = (id: number | null) => {
    if (!rows.has(id)) {
      const s = services.find((x) => x.id === id);
      rows.set(id, { id, nom: s ? s.nom : "Non affecté", couleur: s ? s.couleur : "#94a3b8", icone: s ? s.icone : "bi-question-circle", facture: 0, nbFactures: 0, encaisse: 0, depenses: 0, fournisseurs: 0, salaires: 0, resultat: 0, cats: {} });
    }
    return rows.get(id)!;
  };
  services.filter((s) => s.actif).forEach((s) => row(s.id));
  factures.forEach((f) => { const r = row(f.departement_id); r.facture += f._sum.total_ht || 0; r.nbFactures += f._count; });
  caisse.forEach((c) => {
    if (NEUTRES.has(c.categorie)) return;
    const r = row(c.departement_id), m = c._sum.montant || 0;
    if (c.sens === "ENTREE" && c.categorie === "REGLEMENT_CLIENT") r.encaisse += m;
    else if (c.sens === "SORTIE") { r.depenses += m; r.cats[c.categorie] = (r.cats[c.categorie] || 0) + m; }
    else if (c.sens === "ENTREE") { r.depenses -= m; r.cats[c.categorie] = (r.cats[c.categorie] || 0) - m; } // reliquat rendu : réduit la dépense
  });
  fournisseurs.forEach((f) => { const r = row(f.departement_id); r.fournisseurs += f._sum.montant_ht || 0; });
  salaires.forEach((x) => { const r = row(x.departement_id); r.salaires += x._sum.cout_total || 0; });
  const list = [...rows.values()].map((r) => ({ ...r, resultat: r.facture - r.depenses - r.fournisseurs - r.salaires }))
    .filter((r) => r.id !== null || r.facture || r.depenses || r.fournisseurs || r.encaisse || r.salaires);
  const total = list.reduce((t, r) => ({ facture: t.facture + r.facture, encaisse: t.encaisse + r.encaisse, depenses: t.depenses + r.depenses, fournisseurs: t.fournisseurs + r.fournisseurs, salaires: t.salaires + r.salaires, resultat: t.resultat + r.resultat }), { facture: 0, encaisse: 0, depenses: 0, fournisseurs: 0, salaires: 0, resultat: 0 });
  const { LABELS } = await import("./caisse");
  res.render("rapports/services", { title: "Résultat par service", list, total, du, au, LABELS });
});

// Plateformes externes (liens dans le menu)
const LIENS = ["super_admin", "pdg", "dg"];
router.get("/admin/liens", requireAuth, async (req: any, res: any) => {
  if (!LIENS.includes(req.session.user.role)) { flash(req, "error_msg", "Réservé à la direction."); return res.redirect("/dashboard"); }
  res.render("admin/liens", { title: "Plateformes externes", liens: await getLiens(), icons: LIEN_ICONS });
});
router.post("/admin/liens", requireAuth, async (req: any, res: any) => {
  if (!LIENS.includes(req.session.user.role)) return res.redirect("/dashboard");
  const arr = (v: any) => ([] as any[]).concat(v ?? []).map((x) => String(x).trim());
  const noms = arr(req.body.nom), urls = arr(req.body.url), icones = arr(req.body.icone);
  const liens = urls.map((url, i) => ({ nom: (noms[i] || "Plateforme").slice(0, 40), url, icone: LIEN_ICONS.includes(icones[i]) ? icones[i] : "bi-box-arrow-up-right" })).filter((l) => l.url);
  const bad = liens.find((l) => !urlValide(l.url));
  if (bad) { flash(req, "error_msg", `Adresse invalide : « ${bad.url} » (elle doit commencer par https://).`); return res.redirect("/admin/liens"); }
  await setLiens(liens.slice(0, 12));
  flash(req, "success_msg", liens.length ? "Liens enregistrés. Ils apparaissent dans le menu." : "Tous les liens ont été retirés du menu.");
  res.redirect("/admin/liens");
});

export default router;
