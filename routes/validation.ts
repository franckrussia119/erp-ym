import { Router } from "express";
import { requireAuth } from "./rbac";
import prisma from "../lib/prismaClient";
import { BANQUES_ROLES } from "../lib/banques";
import { REGISTRE_ROLES, CODES_EDIT_ROLES, APRES_VALIDATION, normCode, parseArticles } from "../lib/validation";

// Registre des déclarations validées et dictionnaire des codes tarifaires
const router = Router();

const MOIS_FR = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const moisLabel = (cle: string) => { const [a, m] = cle.split("-"); return `${MOIS_FR[parseInt(m, 10) - 1]} ${a}`; };
const day = (s: any) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + "T00:00:00") : null);

function canRegistre(req: any, res: any) {
  if (REGISTRE_ROLES.includes(req.session.user?.role)) return true;
  res.status(403).render("errors/403", { message: "Le registre des validations est réservé au service validation, au GUCE et à la direction." });
  return false;
}

async function registreRows(q: any) {
  const where: any = { validation_ordre: { not: null } };
  if (q.mois && /^\d{4}-\d{2}$/.test(q.mois)) where.validation_ordre = { startsWith: q.mois + "-" };
  const du = day(q.du), au = day(q.au);
  if (du || au) where.validation_at = { ...(du ? { gte: du } : {}), ...(au ? { lt: new Date(au.getTime() + 86400000) } : {}) };
  if (q.client) where.client_id = parseInt(q.client) || -1;
  if (["VERT", "JAUNE", "ROUGE"].includes(q.circuit)) where.camcis_circuit = q.circuit;
  const s = String(q.q || "").trim();
  if (s) where.OR = ["numero", "bl", "camcis_numero", "gn_numero", "dau_numero", "validation_ordre", "contenu", "articles_json"].map((f) => ({ [f]: { contains: s, mode: "insensitive" } }));
  return prisma.dossier.findMany({
    where, orderBy: { validation_ordre: q.ordre === "asc" ? "asc" : "desc" },
    select: { id: true, numero: true, bl: true, contenu: true, validation_ordre: true, validation_at: true, camcis_numero: true, camcis_date: true,
      camcis_circuit: true, camcis_liquidation: true, gn_numero: true, dau_numero: true, articles_json: true, pipeline_status: true, client: { select: { id: true, nom: true } } },
    take: 2000,
  });
}

// GET /validation/registre : dossiers validés, classés par n° d'ordre et regroupés par mois
router.get("/validation/registre", requireAuth, async (req: any, res: any) => {
  if (!canRegistre(req, res)) return;
  const q = req.query;
  const rows = await registreRows(q);
  const groupes: { cle: string; label: string; rows: any[] }[] = [];
  for (const r of rows) {
    const cle = r.validation_ordre!.slice(0, 7);
    let g = groupes.find((x) => x.cle === cle);
    if (!g) { g = { cle, label: moisLabel(cle), rows: [] }; groupes.push(g); }
    g.rows.push({ ...r, articles: parseArticles(r.articles_json) });
  }
  // Compteur par mois sur tout le registre (pour la barre des mois), indépendant des filtres
  const tous = await prisma.dossier.findMany({ where: { validation_ordre: { not: null } }, select: { validation_ordre: true } });
  const parMois = new Map<string, number>();
  for (const t of tous) { const k = t.validation_ordre!.slice(0, 7); parMois.set(k, (parMois.get(k) || 0) + 1); }
  const mois = [...parMois.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([cle, n]) => ({ cle, label: moisLabel(cle), n }));
  const clients = await prisma.client.findMany({ where: { dossiers: { some: { validation_ordre: { not: null } } } }, select: { id: true, nom: true }, orderBy: { nom: "asc" } });
  const enAttente = await prisma.dossier.count({ where: { pipeline_status: "VALIDATION" } });
  res.render("validation/registre", { title: "Registre des validations", groupes, mois, clients, filtre: q, total: rows.length, enAttente });
});

// GET /validation/registre/export : même liste en CSV (Excel)
router.get("/validation/registre/export", requireAuth, async (req: any, res: any) => {
  if (!canRegistre(req, res)) return;
  const rows = await registreRows(req.query);
  const cell = (v: any) => { const s = v == null ? "" : String(v); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const d = (x: any) => (x ? new Date(x).toLocaleDateString("fr-FR") : "");
  const lines = [["N° d'ordre", "Date de validation", "Dossier", "Client", "BL", "N° CAMCIS", "N° GN", "N° DAU", "Circuit", "Droits liquidés", "Articles et codes"].join(";")];
  for (const r of rows) {
    lines.push([r.validation_ordre, d(r.validation_at), r.numero, r.client?.nom, r.bl, r.camcis_numero, r.gn_numero, r.dau_numero, r.camcis_circuit, r.camcis_liquidation ?? "",
      parseArticles(r.articles_json).map((a) => `${a.code} ${a.designation}`.trim()).join(" | ")].map(cell).join(";"));
  }
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="registre-validations${req.query.mois ? "-" + req.query.mois : ""}.csv"`);
  res.send("﻿" + lines.join("\r\n"));
});

// GET /api/codes-tarifaires?q= : propositions pendant la saisie (code ou désignation)
router.get("/api/codes-tarifaires", requireAuth, async (req: any, res: any) => {
  const q = String(req.query.q || "").trim();
  if (q.length < 2) return res.json([]);
  const code = normCode(q);
  const list = await prisma.codeTarifaire.findMany({
    where: { OR: [...(code ? [{ code: { startsWith: code } }] : []), { designation: { contains: q, mode: "insensitive" } }] },
    orderBy: [{ usages: "desc" }, { code: "asc" }], take: 12, select: { code: true, designation: true, usages: true },
  });
  res.json(list);
});

// GET /codes-tarifaires : le dictionnaire, consultable par tous, modifiable par la validation, le GUCE et la direction
router.get("/codes-tarifaires", requireAuth, async (req: any, res: any) => {
  const q = String(req.query.q || "").trim();
  const code = normCode(q);
  const where: any = q ? { OR: [...(code ? [{ code: { contains: code } }] : []), { designation: { contains: q, mode: "insensitive" } }, { notes: { contains: q, mode: "insensitive" } }] } : {};
  const codes = await prisma.codeTarifaire.findMany({ where, orderBy: { code: "asc" }, take: 500 });
  const total = await prisma.codeTarifaire.count();
  res.render("validation/codes", { title: "Codes tarifaires", codes, total, q, canEdit: CODES_EDIT_ROLES.includes(req.session.user?.role) });
});

function canEditCodes(req: any) {
  if (CODES_EDIT_ROLES.includes(req.session.user?.role)) return true;
  req.session.error_msg = "Seuls la validation, le GUCE et la direction modifient le dictionnaire des codes.";
  return false;
}

// POST /codes-tarifaires : ajouter un code, ou plusieurs collés d'un coup (une ligne par code : « code ; désignation »)
router.post("/codes-tarifaires", requireAuth, async (req: any, res: any) => {
  if (!canEditCodes(req)) return res.redirect("/codes-tarifaires");
  const lignes: { code: string; designation: string; notes?: string }[] = [];
  if (req.body.code) lignes.push({ code: normCode(req.body.code), designation: String(req.body.designation || "").trim().toUpperCase(), notes: String(req.body.notes || "").trim() || undefined });
  for (const l of String(req.body.liste || "").split(/\r?\n/)) {
    const m = l.trim().match(/^([\d.\sA-Za-z]+?)\s*[;\t,|]\s*(.+)$/);
    if (m) lignes.push({ code: normCode(m[1]), designation: m[2].trim().toUpperCase() });
  }
  const valides = lignes.filter((l) => l.code && l.designation);
  if (!valides.length) { req.session.error_msg = "Indiquez au moins un code et sa désignation."; return res.redirect("/codes-tarifaires"); }
  let crees = 0, maj = 0;
  for (const l of valides) {
    const exists = await prisma.codeTarifaire.findUnique({ where: { code: l.code } });
    if (exists) { await prisma.codeTarifaire.update({ where: { code: l.code }, data: { designation: l.designation, ...(l.notes ? { notes: l.notes } : {}) } }); maj++; }
    else { await prisma.codeTarifaire.create({ data: { code: l.code, designation: l.designation, notes: l.notes || null } }); crees++; }
  }
  req.session.success_msg = `${crees} code(s) ajouté(s)${maj ? `, ${maj} mis à jour` : ""}.`;
  res.redirect("/codes-tarifaires");
});

router.post("/codes-tarifaires/:id", requireAuth, async (req: any, res: any) => {
  if (!canEditCodes(req)) return res.redirect("/codes-tarifaires");
  const id = parseInt(req.params.id);
  const designation = String(req.body.designation || "").trim().toUpperCase();
  if (!designation) { req.session.error_msg = "La désignation ne peut pas être vide."; return res.redirect("/codes-tarifaires"); }
  await prisma.codeTarifaire.update({ where: { id }, data: { designation, notes: String(req.body.notes || "").trim() || null } }).catch(() => null);
  req.session.success_msg = "Code mis à jour.";
  res.redirect("/codes-tarifaires" + (req.body.q ? "?q=" + encodeURIComponent(req.body.q) : ""));
});

router.post("/codes-tarifaires/:id/supprimer", requireAuth, async (req: any, res: any) => {
  if (!canEditCodes(req)) return res.redirect("/codes-tarifaires");
  await prisma.codeTarifaire.delete({ where: { id: parseInt(req.params.id) } }).catch(() => null);
  req.session.success_msg = "Code retiré du dictionnaire (les dossiers qui l'utilisent le gardent).";
  res.redirect("/codes-tarifaires");
});

// ===== Banques (Administration › Banques) =====
function canBanques(req: any, res: any) {
  if (BANQUES_ROLES.includes(req.session.user?.role)) return true;
  res.status(403).render("errors/403", { message: "La liste des banques est gérée par la direction, le DAF et la comptabilité." });
  return false;
}
router.get("/admin/banques", requireAuth, async (req: any, res: any) => {
  if (!canBanques(req, res)) return;
  res.render("admin/banques", { title: "Banques", banques: await prisma.banque.findMany({ orderBy: [{ actif: "desc" }, { ordre: "asc" }, { nom: "asc" }] }) });
});
router.post("/admin/banques", requireAuth, async (req: any, res: any) => {
  if (!canBanques(req, res)) return;
  const nom = String(req.body.nom || "").trim().toUpperCase();
  if (!nom) { req.session.error_msg = "Indiquez le nom de la banque."; return res.redirect("/admin/banques"); }
  if (await prisma.banque.findUnique({ where: { nom } })) { req.session.error_msg = `La banque ${nom} est déjà dans la liste.`; return res.redirect("/admin/banques"); }
  await prisma.banque.create({ data: { nom, numero_compte: String(req.body.numero_compte || "").trim() || null, agence: String(req.body.agence || "").trim().toUpperCase() || null, ordre: await prisma.banque.count() } });
  req.session.success_msg = `Banque ${nom} ajoutée.`;
  res.redirect("/admin/banques");
});
router.post("/admin/banques/:id", requireAuth, async (req: any, res: any) => {
  if (!canBanques(req, res)) return;
  const nom = String(req.body.nom || "").trim().toUpperCase();
  const data: any = { numero_compte: String(req.body.numero_compte || "").trim() || null, agence: String(req.body.agence || "").trim().toUpperCase() || null };
  if (nom) data.nom = nom;
  if (req.body.actif === "0" || req.body.actif === "1") data.actif = req.body.actif === "1";
  try { await prisma.banque.update({ where: { id: parseInt(req.params.id) }, data }); req.session.success_msg = "Banque mise à jour."; }
  catch { req.session.error_msg = "Une autre banque porte déjà ce nom."; }
  res.redirect("/admin/banques");
});

export { APRES_VALIDATION };
export default router;
