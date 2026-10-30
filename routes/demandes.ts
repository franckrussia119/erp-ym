import { Router } from "express";
import path from "path";
import fs from "fs";
import multer from "multer";
import { requireAuth } from "./rbac";
import prisma from "../lib/prismaClient";
import { TYPES, INFORMES, CONGE_MOTIFS, APPROBATEURS, STATE, aValider, creerDemande, decider, peutDecider, etapeCourante, etapesPour, parseEtapes, approbateurIds } from "../lib/approbations";

// Demandes internes et leur circuit d'approbation (congés, achats, réparations, autres)
const router = Router();
const flash = (req: any, kind: "success_msg" | "error_msg", msg: string) => { req.session[kind] = msg; };
const VOIR_TOUT = ["super_admin", "pdg", "dg", "dga", "daf", "rh"];
const REGLER = ["super_admin", "pdg", "dg"];
const num = (v: any) => { const n = parseFloat(String(v ?? "").replace(/\s/g, "").replace(",", ".")); return isFinite(n) ? n : 0; };
const logActivity = async (userId: number, action: string, entityId: number) => {
  try { await prisma.activityLog.create({ data: { user_id: userId, action, entity: "Demande", entity_id: String(entityId) } }); } catch {}
};

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _f, cb) => { const d = path.join(process.cwd(), "uploads", "temp"); fs.mkdirSync(d, { recursive: true }); cb(null, d); },
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}-${file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, "_")}`),
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, /pdf|jpe?g|png|webp|heic/i.test(file.mimetype)),
}).array("pieces", 5);

// Jours ouvrés (lundi à vendredi) entre deux dates incluses
export function joursOuvres(du: Date, au: Date) {
  let n = 0;
  for (let d = new Date(du); d <= au; d.setDate(d.getDate() + 1)) if (d.getDay() !== 0 && d.getDay() !== 6) n++;
  return n;
}

const INCLUDE = {
  demandeur: { select: { id: true, nom: true, prenom: true, role: true } },
  departement: { select: { id: true, nom: true, couleur: true, icone: true } },
  etapes: { orderBy: { ordre: "asc" as const }, include: { decideur: { select: { nom: true, prenom: true } } } },
};

router.get("/demandes", requireAuth, async (req: any, res: any) => {
  const user = req.session.user;
  const voirTout = VOIR_TOUT.includes(user.role);
  const [aFaire, miennes] = await Promise.all([
    aValider(user),
    prisma.demande.findMany({ where: { demandeur_id: user.id }, include: INCLUDE, orderBy: { created_at: "desc" }, take: 100 }),
  ]);
  const onglet = ["a-valider", "mes-demandes", "toutes"].includes(req.query.vue) ? req.query.vue : aFaire.length ? "a-valider" : "mes-demandes";
  let toutes: any[] = [];
  const filtre = { type: TYPES[req.query.type] ? req.query.type : "", etat: STATE[req.query.etat] ? req.query.etat : "" };
  if (voirTout && onglet === "toutes") {
    toutes = await prisma.demande.findMany({
      where: { ...(filtre.type ? { type: filtre.type } : {}), ...(filtre.etat ? { etat: filtre.etat } : {}) },
      include: INCLUDE, orderBy: { created_at: "desc" }, take: 300,
    });
  }
  // Absents aujourd'hui et cette semaine (congés approuvés)
  const conges = voirTout ? await prisma.demande.findMany({ where: { type: "CONGE", etat: "APPROUVEE" }, include: { demandeur: { select: { nom: true, prenom: true } } }, orderBy: { created_at: "desc" }, take: 200 }) : [];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const absents = conges.map((c) => ({ c, d: JSON.parse(c.donnees_json || "{}") }))
    .filter(({ d }) => d.du && d.au && new Date(d.au + "T23:59:59") >= today && new Date(d.du + "T00:00:00") <= new Date(today.getTime() + 7 * 864e5))
    .map(({ c, d }) => ({ id: c.id, nom: [c.demandeur.prenom, c.demandeur.nom].filter(Boolean).join(" "), du: d.du, au: d.au, motif: d.motif }));
  res.render("demandes/index", { title: "Demandes", aFaire, miennes, toutes, onglet, voirTout, filtre, absents, TYPES, STATE, APPROBATEURS, etapeCourante });
});

router.get("/demandes/nouvelle/:type", requireAuth, async (req: any, res: any) => {
  const type = String(req.params.type).toUpperCase();
  if (!TYPES[type]) return res.redirect("/demandes");
  const user = req.session.user;
  const fresh = await prisma.user.findUnique({ where: { id: user.id }, select: { id: true, role: true, departement_id: true } });
  // Aperçu du circuit pour un petit et un gros montant
  const apercu = await etapesPour(fresh as any, type, 0);
  res.render("demandes/nouvelle", { title: TYPES[type].label, type, T: TYPES[type], CONGE_MOTIFS, apercu, APPROBATEURS });
});

// Aperçu du circuit pendant la saisie du montant
router.get("/demandes/circuit/:type", requireAuth, async (req: any, res: any) => {
  const type = String(req.params.type).toUpperCase();
  if (!TYPES[type]) return res.json({ etapes: [] });
  const fresh = await prisma.user.findUnique({ where: { id: req.session.userId }, select: { id: true, role: true, departement_id: true } });
  const etapes = await etapesPour(fresh as any, type, num(req.query.montant));
  res.json({ etapes: etapes.map((k) => APPROBATEURS[k] || k) });
});

router.post("/demandes/nouvelle/:type", requireAuth, (req: any, res: any) => {
  upload(req, res, async (err: any) => {
    const type = String(req.params.type).toUpperCase();
    const back = `/demandes/nouvelle/${type.toLowerCase()}`;
    if (!TYPES[type]) return res.redirect("/demandes");
    if (err) { flash(req, "error_msg", `Pièce refusée : ${err.message}`); return res.redirect(back); }
    const b = req.body;
    const user = await prisma.user.findUnique({ where: { id: req.session.userId } });
    if (!user) return res.redirect("/login");
    let titre = String(b.titre || "").trim().slice(0, 160);
    let montant: number | null = TYPES[type].montant === "non" ? null : num(b.montant) || null;
    const donnees: any = {};
    if (type === "CONGE") {
      const du = /^\d{4}-\d{2}-\d{2}$/.test(b.du || "") ? b.du : "", au = /^\d{4}-\d{2}-\d{2}$/.test(b.au || "") ? b.au : "";
      if (!du || !au || au < du) { flash(req, "error_msg", "Indiquez des dates de début et de fin valides."); return res.redirect(back); }
      donnees.du = du; donnees.au = au;
      donnees.motif = CONGE_MOTIFS.includes(b.motif) ? b.motif : "Autre";
      donnees.jours = joursOuvres(new Date(du + "T12:00:00"), new Date(au + "T12:00:00"));
      donnees.interim = String(b.interim || "").trim().slice(0, 120) || null;
      titre = titre || `${donnees.motif} · ${donnees.jours} jour${donnees.jours > 1 ? "s" : ""}`;
    } else {
      donnees.fournisseur = String(b.fournisseur || "").trim().slice(0, 120) || null;
      if (type === "REPARATION") donnees.bien = String(b.bien || "").trim().slice(0, 120) || null;
      donnees.urgence = b.urgence === "1";
      if (TYPES[type].montant === "oui" && !(montant && montant > 0)) { flash(req, "error_msg", "Indiquez le montant estimé."); return res.redirect(back); }
    }
    if (!titre) { flash(req, "error_msg", "Indiquez l'objet de la demande."); return res.redirect(back); }
    const files = (req.files as Express.Multer.File[]) || [];
    const d = await creerDemande(user, { type, titre, details: String(b.details || "").trim().slice(0, 4000) || null, montant, donnees, pieces: [] });
    if (files.length) {
      const dir = path.join(process.cwd(), "uploads", "demandes", String(d.id));
      fs.mkdirSync(dir, { recursive: true });
      const pieces = files.map((f) => { fs.renameSync(f.path, path.join(dir, f.filename)); return { filename: f.filename, original: f.originalname }; });
      await prisma.demande.update({ where: { id: d.id }, data: { pieces_json: JSON.stringify(pieces) } });
    }
    await logActivity(user.id, "DEMANDE_CREEE", d.id);
    flash(req, "success_msg", d.etat === "APPROUVEE" ? `Demande ${d.numero} enregistrée et approuvée d'office.` : `Demande ${d.numero} envoyée. Première validation : ${APPROBATEURS[d.etapes[0].approbateur]}.`);
    res.redirect(`/demandes/${d.id}`);
  });
});

async function loadVisible(req: any) {
  const id = parseInt(req.params.id);
  const d: any = await prisma.demande.findUnique({ where: { id }, include: INCLUDE });
  if (!d) return null;
  const user = req.session.user;
  if (d.demandeur_id === user.id || VOIR_TOUT.includes(user.role)) return d;
  // Un approbateur du circuit (présent ou passé) voit la demande
  for (const e of d.etapes) {
    if (e.decideur_id === user.id) return d;
    if (e.approbateur === "RESPONSABLE" ? (await approbateurIds(d, "RESPONSABLE")).includes(user.id) : e.approbateur === user.role) return d;
  }
  return null;
}

router.get("/demandes/:id", requireAuth, async (req: any, res: any) => {
  const d = await loadVisible(req);
  if (!d) { flash(req, "error_msg", "Demande introuvable ou réservée."); return res.redirect("/demandes"); }
  const user = req.session.user;
  const ec = etapeCourante(d);
  const attendus = ec ? await prisma.user.findMany({ where: { id: { in: await approbateurIds(d, ec.approbateur) } }, select: { nom: true, prenom: true } }) : [];
  res.render("demandes/detail", {
    title: d.numero, d, T: TYPES[d.type] || TYPES.AUTRE, donnees: JSON.parse(d.donnees_json || "{}"), pieces: JSON.parse(d.pieces_json || "[]"),
    canDecide: await peutDecider(user, d), canCancel: d.demandeur_id === user.id && d.etat === "EN_ATTENTE",
    ec, attendus, STATE, APPROBATEURS, informes: INFORMES[d.type] || [],
  });
});

router.post("/demandes/:id/decision", requireAuth, async (req: any, res: any) => {
  const id = parseInt(req.params.id);
  const decision = req.body.decision === "REFUSE" ? "REFUSE" : "APPROUVE";
  const r = await decider(req.session.user, id, decision, String(req.body.commentaire || "").trim().slice(0, 1000) || null);
  if (r.ok) await logActivity(req.session.userId, decision === "REFUSE" ? "DEMANDE_REFUSEE" : "DEMANDE_VALIDEE", id);
  flash(req, r.ok ? "success_msg" : "error_msg", r.msg);
  res.redirect(r.ok && req.body.retour === "liste" ? "/demandes" : `/demandes/${id}`);
});

router.post("/demandes/:id/annuler", requireAuth, async (req: any, res: any) => {
  const id = parseInt(req.params.id);
  const r = await prisma.demande.updateMany({ where: { id, demandeur_id: req.session.userId, etat: "EN_ATTENTE" }, data: { etat: "ANNULEE", decided_at: new Date() } });
  flash(req, r.count ? "success_msg" : "error_msg", r.count ? "Demande annulée." : "Cette demande ne peut plus être annulée.");
  res.redirect(`/demandes/${id}`);
});

router.get("/demandes/:id/piece/:name", requireAuth, async (req: any, res: any) => {
  const d = await loadVisible(req);
  const name = path.basename(String(req.params.name));
  const pieces = d ? JSON.parse(d.pieces_json || "[]") : [];
  const p = pieces.find((x: any) => x.filename === name);
  const file = p && path.join(process.cwd(), "uploads", "demandes", String(d.id), name);
  if (!file || !fs.existsSync(file)) return res.status(404).send("Pièce introuvable");
  res.download(file, p.original, { headers: { "Content-Disposition": `inline; filename="${encodeURIComponent(p.original)}"` } } as any);
});

// =====================================================================
// Règles du circuit
// =====================================================================
router.get("/admin/circuits", requireAuth, async (req: any, res: any) => {
  if (!REGLER.includes(req.session.user.role)) { flash(req, "error_msg", "Réservé à la direction."); return res.redirect("/dashboard"); }
  const regles = await prisma.circuitRegle.findMany({ orderBy: [{ type: "asc" }, { montant_min: "asc" }] });
  res.render("admin/circuits", { title: "Circuits d'approbation", regles: regles.map((r) => ({ ...r, etapes: parseEtapes(r.etapes_json) })), TYPES, APPROBATEURS });
});

router.post("/admin/circuits", requireAuth, async (req: any, res: any) => {
  if (!REGLER.includes(req.session.user.role)) return res.redirect("/dashboard");
  let rows: any[] = [];
  try { rows = JSON.parse(req.body.regles_json || "[]"); } catch { rows = []; }
  const clean = rows
    .filter((r) => TYPES[r.type])
    .map((r) => ({ type: r.type, montant_min: Math.max(0, Math.round(num(r.montant_min))), etapes: (Array.isArray(r.etapes) ? r.etapes : []).filter((k: string) => APPROBATEURS[k]) }))
    .filter((r) => r.etapes.length);
  const seen = new Set<string>();
  const uniq = clean.filter((r) => { const k = `${r.type}:${r.montant_min}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const manque = Object.keys(TYPES).filter((t) => !uniq.some((r) => r.type === t && r.montant_min === 0));
  if (manque.length) { flash(req, "error_msg", `Chaque type doit avoir une règle à partir de 0 F (manque : ${manque.map((t) => TYPES[t].label).join(", ")}).`); return res.redirect("/admin/circuits"); }
  await prisma.$transaction([
    prisma.circuitRegle.deleteMany({}),
    prisma.circuitRegle.createMany({ data: uniq.map((r) => ({ type: r.type, montant_min: r.montant_min, etapes_json: JSON.stringify(r.etapes) })) }),
  ]);
  await logActivity(req.session.userId, "CIRCUITS_MODIFIES", uniq.length);
  flash(req, "success_msg", "Circuits enregistrés. Ils s'appliquent aux nouvelles demandes.");
  res.redirect("/admin/circuits");
});

export default router;
