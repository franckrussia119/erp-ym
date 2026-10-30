import { Router } from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import multer from "multer";
import bcryptjs from "bcryptjs";
import { requireAuth } from "./rbac";
import prisma, { notifyUsers, notifyRoles } from "../lib/prismaClient";
import { RH_ROLES, PAIE_VALIDE_ROLES, CONTRATS, SITUATIONS, MODES, nextMatricule, ecriturePaie, ecriturePaiementPaie } from "../lib/rh";
import { getBareme, setBareme, calculer, parsePrimes, soldeConges, periodeLabel, MOIS, BAREME_DEFAUT, Bareme, Prime } from "../lib/paie";

// Ressources humaines : dossiers du personnel, congés, paie
const router = Router();
const flash = (req: any, kind: "success_msg" | "error_msg", msg: string) => { req.session[kind] = msg; };
const num = (v: any) => { const n = parseFloat(String(v ?? "").replace(/\s/g, "").replace(",", ".")); return isFinite(n) ? n : 0; };
const date = (v: any) => (/^\d{4}-\d{2}-\d{2}$/.test(v || "") ? new Date(v + "T12:00:00") : null);
const str = (v: any, n = 120) => String(v ?? "").trim().slice(0, n) || null;
const full = (u: any) => (u ? [u.prenom, u.nom].filter(Boolean).join(" ") : "");
const isRH = (req: any) => RH_ROLES.includes(req.session.user?.role);
const log = async (userId: number, action: string, entity: string, id: number) => { try { await prisma.activityLog.create({ data: { user_id: userId, action, entity, entity_id: String(id) } }); } catch {} };
const guard = (req: any, res: any) => { if (isRH(req)) return true; flash(req, "error_msg", "Réservé aux ressources humaines et à la direction."); res.redirect("/dashboard"); return false; };

// Primes envoyées par un formulaire (listes parallèles prime_libelle[], prime_montant[], prime_imposable[])
function primesForm(b: any): Prime[] {
  const arr = (v: any) => ([] as any[]).concat(v ?? []);
  const lib = arr(b.prime_libelle), mt = arr(b.prime_montant), imp = arr(b.prime_imposable);
  return parsePrimes(JSON.stringify(lib.map((l, i) => ({ libelle: l, montant: num(mt[i]), imposable: imp[i] !== "0" }))));
}

// =====================================================================
// Tableau de bord RH
// =====================================================================
router.get("/rh", requireAuth, async (req: any, res: any) => {
  if (!guard(req, res)) return;
  const now = new Date(), dans30 = new Date(Date.now() + 30 * 864e5);
  const [employes, services, finContrat, derniere, enAttente, paieCourante] = await Promise.all([
    prisma.employe.findMany({ where: { actif: true }, select: { id: true, type_contrat: true, departement_id: true, sexe: true, salaire_base: true, cnps_numero: true, poste: true } }),
    prisma.departement.findMany({ where: { actif: true }, orderBy: { ordre: "asc" } }),
    prisma.employe.findMany({ where: { actif: true, date_fin_contrat: { gte: now, lte: dans30 } }, orderBy: { date_fin_contrat: "asc" } }),
    prisma.periodePaie.findFirst({ orderBy: [{ annee: "desc" }, { mois: "desc" }], include: { bulletins: { select: { net: true, cout_total: true, brut: true } } } }),
    prisma.demande.count({ where: { type: "CONGE", etat: "EN_ATTENTE" } }),
    prisma.periodePaie.findUnique({ where: { annee_mois: { annee: now.getFullYear(), mois: now.getMonth() + 1 } }, include: { _count: { select: { bulletins: true } } } }),
  ]);
  const parService = services.map((s) => ({ ...s, n: employes.filter((e) => e.departement_id === s.id).length })).filter((s) => s.n);
  const sansService = employes.filter((e) => !e.departement_id).length;
  const parContrat = Object.keys(CONTRATS).map((k) => [CONTRATS[k], employes.filter((e) => e.type_contrat === k).length] as [string, number]).filter((x) => x[1]);
  const sansSalaire = employes.filter((e) => !e.salaire_base).length;
  // Absents aujourd'hui et cette semaine
  const conges = await prisma.demande.findMany({ where: { type: "CONGE", etat: "APPROUVEE" }, include: { demandeur: { select: { nom: true, prenom: true } } }, orderBy: { created_at: "desc" }, take: 300 });
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const absents = conges.map((c) => ({ c, d: JSON.parse(c.donnees_json || "{}") }))
    .filter(({ d }) => d.du && d.au && new Date(d.au + "T23:59:59") >= today && new Date(d.du + "T00:00:00") <= new Date(today.getTime() + 7 * 864e5))
    .map(({ c, d }) => ({ id: c.id, nom: full(c.demandeur), du: d.du, au: d.au, motif: d.motif }));
  const incomplets = employes.filter((e) => !e.salaire_base || !e.poste || !e.cnps_numero).length;
  res.render("rh/index", { title: "Ressources humaines", rhTab: "accueil", paieCourante, incomplets, moisCourant: periodeLabel({ annee: now.getFullYear(), mois: now.getMonth() + 1 }), effectif: employes.length, parService, sansService, parContrat, finContrat, derniere, enAttente, absents, sansSalaire, CONTRATS, periodeLabel });
});

// =====================================================================
// Employés
// =====================================================================
router.get("/rh/employes", requireAuth, async (req: any, res: any) => {
  if (!guard(req, res)) return;
  const q = String(req.query.q || "").trim();
  const statut = req.query.statut === "sortis" ? "sortis" : "actifs";
  const service = parseInt(req.query.service) || null;
  const aCompleter = req.query.a_completer === "1";
  const employes = await prisma.employe.findMany({
    where: {
      actif: statut === "actifs",
      ...(aCompleter ? { OR: [{ salaire_base: 0 }, { poste: null }, { cnps_numero: null }] } : {}),
      ...(service ? { departement_id: service } : {}),
      ...(q ? { OR: [{ nom: { contains: q, mode: "insensitive" } }, { prenom: { contains: q, mode: "insensitive" } }, { matricule: { contains: q, mode: "insensitive" } }, { poste: { contains: q, mode: "insensitive" } }] } : {}),
    },
    include: { departement: { select: { nom: true, couleur: true } }, user: { select: { role: true, actif: true } } },
    orderBy: [{ nom: "asc" }],
  });
  const services = await prisma.departement.findMany({ where: { actif: true }, orderBy: { ordre: "asc" } });
  const masse = employes.reduce((t, e) => t + (e.salaire_base || 0), 0);
  res.render("rh/employes", { title: "Employés", rhTab: "employes", employes, services, masse, filtre: { q, statut, service, aCompleter }, CONTRATS });
});

const formData = async () => ({ services: await prisma.departement.findMany({ where: { actif: true }, orderBy: { ordre: "asc" } }), CONTRATS, SITUATIONS, MODES });

router.get("/rh/employes/nouveau", requireAuth, async (req: any, res: any) => {
  if (!guard(req, res)) return;
  res.render("rh/employe_form", { rhTab: "employes", title: "Nouvel employé", e: null, primes: [], ...(await formData()) });
});

function employeData(b: any) {
  return {
    nom: String(b.nom || "").trim().slice(0, 80), prenom: str(b.prenom, 80), sexe: ["M", "F"].includes(b.sexe) ? b.sexe : null,
    date_naissance: date(b.date_naissance), telephone: str(b.telephone, 40), email: str(b.email, 120), adresse: str(b.adresse, 200),
    situation: SITUATIONS[b.situation] ? b.situation : null, enfants: Math.max(0, Math.min(20, parseInt(b.enfants) || 0)),
    poste: str(b.poste, 80), departement_id: parseInt(b.departement_id) || null,
    type_contrat: CONTRATS[b.type_contrat] ? b.type_contrat : "CDI", date_embauche: date(b.date_embauche), date_fin_contrat: date(b.date_fin_contrat),
    categorie: str(b.categorie, 40), salaire_base: Math.max(0, Math.round(num(b.salaire_base))), primes_json: JSON.stringify(primesForm(b)),
    mode_paiement: MODES[b.mode_paiement] ? b.mode_paiement : "VIREMENT", banque: str(b.banque, 80), rib: str(b.rib, 60),
    cnps_numero: str(b.cnps_numero, 40), niu: str(b.niu, 40), conges_report: Math.max(0, num(b.conges_report)),
  };
}

router.post("/rh/employes", requireAuth, async (req: any, res: any) => {
  if (!guard(req, res)) return;
  const data = employeData(req.body);
  if (!data.nom) { flash(req, "error_msg", "Le nom est obligatoire."); return res.redirect("/rh/employes/nouveau"); }
  const e = await prisma.employe.create({ data: { ...data, matricule: await nextMatricule() } });
  await log(req.session.userId, "EMPLOYE_CREE", "Employe", e.id);
  flash(req, "success_msg", `Dossier ${e.matricule} créé pour ${full(e)}.`);
  res.redirect(`/rh/employes/${e.id}`);
});

router.get("/rh/employes/:id", requireAuth, async (req: any, res: any) => {
  if (!guard(req, res)) return;
  const e = await prisma.employe.findUnique({ where: { id: parseInt(req.params.id) }, include: { departement: true, user: { select: { id: true, email: true, role: true, actif: true, last_login: true } } } });
  if (!e) { flash(req, "error_msg", "Employé introuvable."); return res.redirect("/rh/employes"); }
  const [conges, bulletins, bareme] = await Promise.all([
    soldeConges(e),
    prisma.bulletinPaie.findMany({ where: { employe_id: e.id }, include: { periode: true }, orderBy: [{ periode: { annee: "desc" } }, { periode: { mois: "desc" } }], take: 24 }),
    getBareme(),
  ]);
  const primes = parsePrimes(e.primes_json);
  const simulation = calculer({ salaire_base: e.salaire_base, primes }, bareme);
  res.render("rh/employe", { rhTab: "employes", title: full(e), e, conges, bulletins, primes, simulation, pieces: JSON.parse(e.pieces_json || "[]"), periodeLabel, ...(await formData()) });
});

router.get("/rh/employes/:id/modifier", requireAuth, async (req: any, res: any) => {
  if (!guard(req, res)) return;
  const e = await prisma.employe.findUnique({ where: { id: parseInt(req.params.id) } });
  if (!e) return res.redirect("/rh/employes");
  res.render("rh/employe_form", { rhTab: "employes", title: `Modifier ${full(e)}`, e, primes: parsePrimes(e.primes_json), ...(await formData()) });
});

router.post("/rh/employes/:id", requireAuth, async (req: any, res: any) => {
  if (!guard(req, res)) return;
  const id = parseInt(req.params.id);
  const data = employeData(req.body);
  if (!data.nom) { flash(req, "error_msg", "Le nom est obligatoire."); return res.redirect(`/rh/employes/${id}/modifier`); }
  const e = await prisma.employe.update({ where: { id }, data });
  // Le service et le nom suivent sur le compte de connexion
  if (e.user_id) await prisma.user.update({ where: { id: e.user_id }, data: { departement_id: e.departement_id, nom: e.nom, prenom: e.prenom } });
  await log(req.session.userId, "EMPLOYE_MODIFIE", "Employe", id);
  flash(req, "success_msg", "Dossier enregistré.");
  res.redirect(`/rh/employes/${id}`);
});

// Compte de connexion pour l'employé (mot de passe provisoire à changer à la première connexion)
router.post("/rh/employes/:id/compte", requireAuth, async (req: any, res: any) => {
  if (!guard(req, res)) return;
  const id = parseInt(req.params.id);
  const e = await prisma.employe.findUnique({ where: { id } });
  if (!e) return res.redirect("/rh/employes");
  if (e.user_id) { flash(req, "error_msg", "Cet employé a déjà un compte."); return res.redirect(`/rh/employes/${id}`); }
  const email = String(req.body.email || e.email || "").trim().toLowerCase();
  const role = String(req.body.role || "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { flash(req, "error_msg", "Adresse e-mail invalide."); return res.redirect(`/rh/employes/${id}`); }
  if (!role || role === "super_admin") { flash(req, "error_msg", "Choisissez un rôle."); return res.redirect(`/rh/employes/${id}`); }
  if (await prisma.user.findUnique({ where: { email } })) { flash(req, "error_msg", "Cette adresse e-mail a déjà un compte."); return res.redirect(`/rh/employes/${id}`); }
  const temp = crypto.randomBytes(6).toString("base64url").slice(0, 8);
  const u = await prisma.user.create({ data: { nom: e.nom, prenom: e.prenom, email, password: await bcryptjs.hash(temp, 10), role, societe: "YM-TRANSIT", actif: true, force_pwd_change: true, created_by: req.session.userId, departement_id: e.departement_id } });
  await prisma.employe.update({ where: { id }, data: { user_id: u.id, email } });
  await log(req.session.userId, "CREATE_USER", "User", u.id);
  flash(req, "success_msg", `Compte créé : ${email}, mot de passe provisoire « ${temp} ». Transmettez-le à l'employé ; il devra le changer à sa première connexion.`);
  res.redirect(`/rh/employes/${id}`);
});

// Départ : le dossier est conservé, le compte de connexion est désactivé
router.post("/rh/employes/:id/sortie", requireAuth, async (req: any, res: any) => {
  if (!guard(req, res)) return;
  const id = parseInt(req.params.id);
  const e = await prisma.employe.update({ where: { id }, data: { actif: false, date_sortie: date(req.body.date_sortie) || new Date(), motif_sortie: str(req.body.motif_sortie, 200) } });
  if (e.user_id && e.user_id !== req.session.userId) await prisma.user.update({ where: { id: e.user_id }, data: { actif: false } });
  await log(req.session.userId, "EMPLOYE_SORTIE", "Employe", id);
  flash(req, "success_msg", `${full(e)} est sorti des effectifs${e.user_id ? " ; son compte de connexion est désactivé" : ""}.`);
  res.redirect(`/rh/employes/${id}`);
});

router.post("/rh/employes/:id/reintegrer", requireAuth, async (req: any, res: any) => {
  if (!guard(req, res)) return;
  const id = parseInt(req.params.id);
  const e = await prisma.employe.update({ where: { id }, data: { actif: true, date_sortie: null, motif_sortie: null } });
  if (e.user_id) await prisma.user.update({ where: { id: e.user_id }, data: { actif: true } });
  flash(req, "success_msg", `${full(e)} est de nouveau dans les effectifs.`);
  res.redirect(`/rh/employes/${id}`);
});

// Pièces du dossier (contrat, CNI, diplômes…)
const piecesUpload = multer({
  storage: multer.diskStorage({
    destination: (req: any, _f, cb) => { const d = path.join(process.cwd(), "uploads", "rh", String(parseInt(req.params.id) || 0)); fs.mkdirSync(d, { recursive: true }); cb(null, d); },
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}-${file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, "_")}`),
  }),
  limits: { fileSize: 20 * 1024 * 1024, files: 10 },
}).array("pieces", 10);

router.post("/rh/employes/:id/pieces", requireAuth, (req: any, res: any) => {
  if (!isRH(req)) return res.redirect("/dashboard");
  piecesUpload(req, res, async (err: any) => {
    const id = parseInt(req.params.id);
    const files = (req.files as Express.Multer.File[]) || [];
    if (err) { flash(req, "error_msg", `Pièce refusée : ${err.message}`); return res.redirect(`/rh/employes/${id}`); }
    const e = await prisma.employe.findUnique({ where: { id } });
    if (!e) { files.forEach((f) => fs.rm(f.path, () => {})); return res.redirect("/rh/employes"); }
    const nature = str(req.body.nature, 60) || "Document";
    const pieces = [...JSON.parse(e.pieces_json || "[]"), ...files.map((f) => ({ filename: f.filename, original: f.originalname, nature, at: new Date() }))];
    await prisma.employe.update({ where: { id }, data: { pieces_json: JSON.stringify(pieces) } });
    flash(req, "success_msg", `${files.length} pièce${files.length > 1 ? "s" : ""} ajoutée${files.length > 1 ? "s" : ""}.`);
    res.redirect(`/rh/employes/${id}#pieces`);
  });
});

router.get("/rh/employes/:id/pieces/:name", requireAuth, async (req: any, res: any) => {
  if (!isRH(req)) return res.status(403).send("Accès refusé");
  const e = await prisma.employe.findUnique({ where: { id: parseInt(req.params.id) } });
  const name = path.basename(String(req.params.name));
  const p = e && JSON.parse(e.pieces_json || "[]").find((x: any) => x.filename === name);
  const file = p && path.join(process.cwd(), "uploads", "rh", String(e!.id), name);
  if (!file || !fs.existsSync(file)) return res.status(404).send("Pièce introuvable");
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(p.original)}`);
  res.sendFile(file);
});

// =====================================================================
// Paie
// =====================================================================
router.get("/rh/paie", requireAuth, async (req: any, res: any) => {
  if (!guard(req, res)) return;
  const periodes = await prisma.periodePaie.findMany({ orderBy: [{ annee: "desc" }, { mois: "desc" }], include: { bulletins: { select: { brut: true, net: true, cout_total: true } } } });
  const now = new Date();
  // Mois proposé : le mois en cours s'il n'existe pas encore, sinon le suivant
  let next = { annee: now.getFullYear(), mois: now.getMonth() + 1 };
  while (periodes.some((p) => p.annee === next.annee && p.mois === next.mois)) next = next.mois === 12 ? { annee: next.annee + 1, mois: 1 } : { annee: next.annee, mois: next.mois + 1 };
  res.render("rh/paie", { rhTab: "paie", title: "Paie", periodes, next, MOIS, periodeLabel, canValidate: PAIE_VALIDE_ROLES.includes(req.session.user.role) });
});

async function bulletinPour(e: any, bareme: Bareme, variables?: { jours_absence: number; avance: number; primes: Prime[] }) {
  const primes = variables ? variables.primes : parsePrimes(e.primes_json);
  const c = calculer({ salaire_base: e.salaire_base, primes, jours_absence: variables?.jours_absence || 0, avance: variables?.avance || 0 }, bareme);
  return { salaire_base: e.salaire_base, departement_id: e.departement_id, jours_absence: variables?.jours_absence || 0, avance: c.avance, primes_json: JSON.stringify(primes), detail_json: JSON.stringify(c), brut: c.brut, net: c.net, cout_total: c.cout_total };
}

router.post("/rh/paie", requireAuth, async (req: any, res: any) => {
  if (!guard(req, res)) return;
  const annee = parseInt(req.body.annee), mois = parseInt(req.body.mois);
  if (!(annee >= 2000 && annee <= 2100 && mois >= 1 && mois <= 12)) { flash(req, "error_msg", "Mois invalide."); return res.redirect("/rh/paie"); }
  if (await prisma.periodePaie.findUnique({ where: { annee_mois: { annee, mois } } })) { flash(req, "error_msg", `La paie de ${periodeLabel({ annee, mois })} existe déjà.`); return res.redirect("/rh/paie"); }
  const fin = new Date(annee, mois, 0, 23, 59);
  const employes = await prisma.employe.findMany({ where: { actif: true, salaire_base: { gt: 0 }, OR: [{ date_embauche: null }, { date_embauche: { lte: fin } }] } });
  if (!employes.length) { flash(req, "error_msg", "Aucun employé actif avec un salaire de base : complétez d'abord les dossiers."); return res.redirect("/rh/paie"); }
  const bareme = await getBareme();
  const p = await prisma.periodePaie.create({ data: { annee, mois } });
  for (const e of employes) await prisma.bulletinPaie.create({ data: { periode_id: p.id, employe_id: e.id, ...(await bulletinPour(e, bareme)) } });
  await log(req.session.userId, "PAIE_PREPAREE", "PeriodePaie", p.id);
  flash(req, "success_msg", `Paie de ${periodeLabel(p)} préparée : ${employes.length} bulletins. Saisissez les primes, absences et avances du mois, puis faites-la valider.`);
  res.redirect(`/rh/paie/${p.id}`);
});

router.get("/rh/paie/:id", requireAuth, async (req: any, res: any) => {
  if (!guard(req, res)) return;
  const p = await prisma.periodePaie.findUnique({ where: { id: parseInt(req.params.id) }, include: { bulletins: { include: { employe: { include: { departement: { select: { nom: true, couleur: true } } } } }, orderBy: { employe: { nom: "asc" } } } } });
  if (!p) return res.redirect("/rh/paie");
  const lignes = p.bulletins.map((b) => ({ ...b, d: JSON.parse(b.detail_json), primes: parsePrimes(b.primes_json) }));
  const t = lignes.reduce((a, l) => ({ brut: a.brut + l.d.brut, cnps: a.cnps + l.d.cnps_salarie, impots: a.impots + l.d.irpp + l.d.cac + l.d.cfc + l.d.rav + l.d.tdl, avance: a.avance + l.d.avance, net: a.net + l.d.net, patronal: a.patronal + l.d.employeur.total, cout: a.cout + l.d.cout_total }), { brut: 0, cnps: 0, impots: 0, avance: 0, net: 0, patronal: 0, cout: 0 });
  const validePar = p.valide_par ? await prisma.user.findUnique({ where: { id: p.valide_par }, select: { nom: true, prenom: true } }) : null;
  res.render("rh/paie_periode", { rhTab: "paie", title: `Paie de ${periodeLabel(p)}`, p, lignes, t, validePar, periodeLabel, MODES, canValidate: PAIE_VALIDE_ROLES.includes(req.session.user.role) });
});

// Variables du mois sur un bulletin (paie non validée)
router.post("/rh/paie/:id/bulletins/:bid", requireAuth, async (req: any, res: any) => {
  if (!guard(req, res)) return;
  const pid = parseInt(req.params.id);
  const b = await prisma.bulletinPaie.findFirst({ where: { id: parseInt(req.params.bid), periode_id: pid }, include: { periode: true, employe: true } });
  if (!b || b.periode.statut !== "BROUILLON") { flash(req, "error_msg", "Cette paie est validée : les bulletins ne se modifient plus."); return res.redirect(`/rh/paie/${pid}`); }
  const data = await bulletinPour({ ...b.employe, salaire_base: Math.max(0, Math.round(num(req.body.salaire_base ?? b.salaire_base))) }, await getBareme(), { jours_absence: Math.max(0, Math.min(31, num(req.body.jours_absence))), avance: Math.max(0, num(req.body.avance)), primes: primesForm(req.body) });
  await prisma.bulletinPaie.update({ where: { id: b.id }, data });
  flash(req, "success_msg", `Bulletin de ${full(b.employe)} recalculé : net ${Math.round(data.net).toLocaleString("fr-FR")} F.`);
  res.redirect(`/rh/paie/${pid}#b${b.id}`);
});

// Recalcul de toute la paie depuis les dossiers (salaire, primes fixes, service) et le barème du moment
router.post("/rh/paie/:id/actualiser", requireAuth, async (req: any, res: any) => {
  if (!guard(req, res)) return;
  const p = await prisma.periodePaie.findUnique({ where: { id: parseInt(req.params.id) }, include: { bulletins: { include: { employe: true } } } });
  if (!p || p.statut !== "BROUILLON") return res.redirect("/rh/paie");
  const bareme = await getBareme();
  for (const b of p.bulletins) {
    // Les variables du mois (absences, avance, primes saisies) sont conservées ; le reste suit le dossier
    const fixes = parsePrimes(b.employe.primes_json), mois = parsePrimes(b.primes_json);
    const primes = [...fixes, ...mois.filter((m) => !fixes.some((f) => f.libelle === m.libelle))];
    await prisma.bulletinPaie.update({ where: { id: b.id }, data: await bulletinPour(b.employe, bareme, { jours_absence: b.jours_absence, avance: b.avance, primes }) });
  }
  // Employés arrivés depuis la préparation
  const fin = new Date(p.annee, p.mois, 0, 23, 59);
  const manquants = await prisma.employe.findMany({ where: { actif: true, salaire_base: { gt: 0 }, id: { notIn: p.bulletins.map((b) => b.employe_id) }, OR: [{ date_embauche: null }, { date_embauche: { lte: fin } }] } });
  for (const e of manquants) await prisma.bulletinPaie.create({ data: { periode_id: p.id, employe_id: e.id, ...(await bulletinPour(e, bareme)) } });
  flash(req, "success_msg", `Paie recalculée${manquants.length ? ` (${manquants.length} employé${manquants.length > 1 ? "s" : ""} ajouté${manquants.length > 1 ? "s" : ""})` : ""}.`);
  res.redirect(`/rh/paie/${p.id}`);
});

router.post("/rh/paie/:id/retirer/:bid", requireAuth, async (req: any, res: any) => {
  if (!guard(req, res)) return;
  const pid = parseInt(req.params.id);
  const r = await prisma.bulletinPaie.deleteMany({ where: { id: parseInt(req.params.bid), periode_id: pid, periode: { statut: "BROUILLON" } } });
  flash(req, r.count ? "success_msg" : "error_msg", r.count ? "Bulletin retiré de cette paie." : "Impossible : paie déjà validée.");
  res.redirect(`/rh/paie/${pid}`);
});

router.post("/rh/paie/:id/valider", requireAuth, async (req: any, res: any) => {
  const pid = parseInt(req.params.id);
  if (!PAIE_VALIDE_ROLES.includes(req.session.user.role)) { flash(req, "error_msg", "La paie est validée par le DAF, le DG ou le PDG."); return res.redirect(`/rh/paie/${pid}`); }
  const p = await prisma.periodePaie.findUnique({ where: { id: pid }, include: { bulletins: { include: { employe: { select: { user_id: true } } } } } });
  if (!p || p.statut !== "BROUILLON") return res.redirect("/rh/paie");
  if (!p.bulletins.length) { flash(req, "error_msg", "Aucun bulletin dans cette paie."); return res.redirect(`/rh/paie/${pid}`); }
  try {
    await prisma.$transaction(async (tx: any) => {
      const claimed = await tx.periodePaie.updateMany({ where: { id: pid, statut: "BROUILLON" }, data: { statut: "VALIDEE", valide_par: req.session.userId, valide_at: new Date() } });
      if (!claimed.count) throw new Error("Paie déjà validée.");
      await ecriturePaie(tx, p, p.bulletins, req.session.userId, req.session.user.societe || "YM-TRANSIT");
    });
  } catch (e: any) {
    flash(req, "error_msg", `Validation impossible : ${e.message}`);
    return res.redirect(`/rh/paie/${pid}`);
  }
  await log(req.session.userId, "PAIE_VALIDEE", "PeriodePaie", pid);
  const ids = p.bulletins.map((b) => b.employe.user_id).filter(Boolean) as number[];
  await notifyUsers(ids, `🧾 Bulletin de paie de ${periodeLabel(p)}`, "Votre bulletin est disponible dans Mes bulletins.", "/rh/mes-bulletins");
  await notifyRoles(["rh"], `✅ Paie de ${periodeLabel(p)} validée`, "L'écriture de paie est passée en comptabilité. Elle peut être payée.", `/rh/paie/${pid}`);
  flash(req, "success_msg", `Paie de ${periodeLabel(p)} validée. L'écriture est passée au journal de paie et les employés ont leur bulletin.`);
  res.redirect(`/rh/paie/${pid}`);
});

router.post("/rh/paie/:id/payer", requireAuth, async (req: any, res: any) => {
  const pid = parseInt(req.params.id);
  if (!PAIE_VALIDE_ROLES.includes(req.session.user.role)) { flash(req, "error_msg", "Réservé au DAF, au DG et au PDG."); return res.redirect(`/rh/paie/${pid}`); }
  const p = await prisma.periodePaie.findUnique({ where: { id: pid }, include: { bulletins: true } });
  if (!p || p.statut !== "VALIDEE") { flash(req, "error_msg", "La paie doit être validée avant d'être payée."); return res.redirect(`/rh/paie/${pid}`); }
  const mode = req.body.mode === "ESPECES" ? "ESPECES" : "VIREMENT";
  const net = p.bulletins.reduce((t, b) => t + b.net, 0);
  try {
    await prisma.$transaction(async (tx: any) => {
      const claimed = await tx.periodePaie.updateMany({ where: { id: pid, statut: "VALIDEE" }, data: { statut: "PAYEE", paye_at: new Date(), mode } });
      if (!claimed.count) throw new Error("Paie déjà payée.");
      await ecriturePaiementPaie(tx, p, net, mode, req.session.userId, req.session.user.societe || "YM-TRANSIT");
      if (mode === "ESPECES") {
        const g = await tx.caisseMouvement.groupBy({ by: ["sens"], _sum: { montant: true } });
        const solde = (g.find((x: any) => x.sens === "ENTREE")?._sum.montant || 0) - (g.find((x: any) => x.sens === "SORTIE")?._sum.montant || 0);
        if (net > solde) throw new Error(`solde de caisse insuffisant (${Math.round(solde).toLocaleString("fr-FR")} F pour ${Math.round(net).toLocaleString("fr-FR")} F)`);
        await tx.caisseMouvement.create({ data: { sens: "SORTIE", montant: net, categorie: "PAIE", libelle: `Salaires de ${periodeLabel(p)}`, mode: "ESPECES", user_id: req.session.userId, date: new Date() } });
      }
    });
  } catch (e: any) {
    flash(req, "error_msg", `Paiement impossible : ${e.message}.`);
    return res.redirect(`/rh/paie/${pid}`);
  }
  await log(req.session.userId, "PAIE_PAYEE", "PeriodePaie", pid);
  flash(req, "success_msg", `Paie de ${periodeLabel(p)} marquée payée (${MODES[mode].toLowerCase()}, ${Math.round(net).toLocaleString("fr-FR")} F).`);
  res.redirect(`/rh/paie/${pid}`);
});

router.post("/rh/paie/:id/supprimer", requireAuth, async (req: any, res: any) => {
  if (!guard(req, res)) return;
  const r = await prisma.periodePaie.deleteMany({ where: { id: parseInt(req.params.id), statut: "BROUILLON" } });
  flash(req, r.count ? "success_msg" : "error_msg", r.count ? "Paie en préparation supprimée." : "Une paie validée ne se supprime pas.");
  res.redirect("/rh/paie");
});

// Exports : livre de paie et ordre de virement (CSV pour Excel)
router.get("/rh/paie/:id/export", requireAuth, async (req: any, res: any) => {
  if (!guard(req, res)) return;
  const p = await prisma.periodePaie.findUnique({ where: { id: parseInt(req.params.id) }, include: { bulletins: { include: { employe: true }, orderBy: { employe: { nom: "asc" } } } } });
  if (!p) return res.redirect("/rh/paie");
  const esc = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const tag = `${p.annee}-${String(p.mois).padStart(2, "0")}`;
  let rows: any[][];
  if (req.query.type === "virements") {
    rows = [["Matricule", "Nom", "Banque", "RIB / compte", "Mode", "Net à payer"],
      ...p.bulletins.map((b) => [b.employe.matricule, full(b.employe), b.employe.banque, b.employe.rib, MODES[b.employe.mode_paiement] || b.employe.mode_paiement, Math.round(b.net)])];
  } else {
    rows = [["Matricule", "Nom", "Poste", "N° CNPS", "Salaire de base", "Absences (j)", "Brut", "Brut imposable", "CNPS salarié", "IRPP", "CAC", "CFC", "RAV", "TDL", "Avance", "Net à payer", "CNPS patronal", "CFC patronal", "FNE", "Coût total"],
      ...p.bulletins.map((b) => { const d = JSON.parse(b.detail_json); return [b.employe.matricule, full(b.employe), b.employe.poste, b.employe.cnps_numero, d.base, b.jours_absence, d.brut, d.brut_imposable, d.cnps_salarie, d.irpp, d.cac, d.cfc, d.rav, d.tdl, d.avance, d.net, d.employeur.pension + d.employeur.af + d.employeur.at, d.employeur.cfc, d.employeur.fne, d.cout_total]; })];
  }
  res.set("Content-Type", "text/csv; charset=utf-8");
  res.set("Content-Disposition", `attachment; filename="${req.query.type === "virements" ? "virements" : "livre-de-paie"}-${tag}.csv"`);
  res.send("﻿" + rows.map((r) => r.map(esc).join(";")).join("\r\n"));
});

// Bulletin imprimable : la RH, ou l'employé lui-même une fois la paie validée
router.get("/rh/bulletins/:id", requireAuth, async (req: any, res: any) => {
  const b = await prisma.bulletinPaie.findUnique({ where: { id: parseInt(req.params.id) }, include: { periode: true, employe: { include: { departement: true } } } });
  const mien = b && b.employe.user_id === req.session.userId && b.periode.statut !== "BROUILLON";
  if (!b || !(isRH(req) || mien)) { flash(req, "error_msg", "Bulletin introuvable."); return res.redirect("/dashboard"); }
  const conges = await soldeConges(b.employe);
  res.render("rh/bulletin", { title: `Bulletin ${periodeLabel(b.periode)}`, b, d: JSON.parse(b.detail_json), conges, periodeLabel, CONTRATS, MODES });
});

router.get("/rh/mes-bulletins", requireAuth, async (req: any, res: any) => {
  const e = await prisma.employe.findUnique({ where: { user_id: req.session.userId } });
  const bulletins = e ? await prisma.bulletinPaie.findMany({ where: { employe_id: e.id, periode: { statut: { not: "BROUILLON" } } }, include: { periode: true }, orderBy: [{ periode: { annee: "desc" } }, { periode: { mois: "desc" } }] }) : [];
  const conges = e ? await soldeConges(e) : null;
  res.render("rh/mes_bulletins", { title: "Mes bulletins", e, bulletins, conges, periodeLabel });
});

// =====================================================================
// Barème de paie
// =====================================================================
router.get("/rh/bareme", requireAuth, async (req: any, res: any) => {
  if (!guard(req, res)) return;
  const b = await getBareme();
  const exemples = [75000, 150000, 250000, 500000, 1000000].map((s) => ({ s, c: calculer({ salaire_base: s }, b) }));
  res.render("rh/bareme", { rhTab: "bareme", title: "Barème de paie", b, exemples, defaut: BAREME_DEFAUT, canEdit: ["super_admin", "daf", "rh"].includes(req.session.user.role) });
});

router.post("/rh/bareme", requireAuth, async (req: any, res: any) => {
  if (!["super_admin", "daf", "rh"].includes(req.session.user.role)) return res.redirect("/rh/bareme");
  if (req.body.reset === "1") { await setBareme(BAREME_DEFAUT); flash(req, "success_msg", "Barème remis aux valeurs de départ."); return res.redirect("/rh/bareme"); }
  const b = req.body;
  const tranches = (prefix: string) => {
    const arr = (v: any) => ([] as any[]).concat(v ?? []);
    const j = arr(b[`${prefix}_jusqua`]), v = arr(b[`${prefix}_valeur`]);
    return v.map((x, i) => ({ jusqua: String(j[i] ?? "").trim() === "" ? null : Math.round(num(j[i])), valeur: num(x) }))
      .sort((a, c) => (a.jusqua ?? Infinity) - (c.jusqua ?? Infinity));
  };
  const nb: Bareme = {
    cnps_plafond: Math.round(num(b.cnps_plafond)), cnps_salarie: num(b.cnps_salarie), cnps_pension_employeur: num(b.cnps_pension_employeur),
    cnps_af_employeur: num(b.cnps_af_employeur), cnps_at_employeur: num(b.cnps_at_employeur), irpp_abattement_frais: num(b.irpp_abattement_frais),
    irpp_abattement_annuel: Math.round(num(b.irpp_abattement_annuel)), irpp_seuil_mensuel: Math.round(num(b.irpp_seuil_mensuel)),
    irpp_tranches: tranches("irpp"), cac: num(b.cac), cfc_salarie: num(b.cfc_salarie), cfc_employeur: num(b.cfc_employeur), fne_employeur: num(b.fne_employeur),
    rav: tranches("rav"), tdl: tranches("tdl"), jours_mois: Math.max(1, Math.round(num(b.jours_mois)) || 30),
  };
  for (const k of ["irpp_tranches", "rav", "tdl"] as const) {
    if (!nb[k].length || nb[k][nb[k].length - 1].jusqua !== null) { flash(req, "error_msg", "Chaque barème doit finir par une tranche « au-delà » (borne vide)."); return res.redirect("/rh/bareme"); }
  }
  await setBareme(nb);
  await log(req.session.userId, "BAREME_PAIE_MODIFIE", "Parametre", 0);
  flash(req, "success_msg", "Barème enregistré. Il s'applique aux paies préparées ou recalculées à partir de maintenant.");
  res.redirect("/rh/bareme");
});

export default router;
