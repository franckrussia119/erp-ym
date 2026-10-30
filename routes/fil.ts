import { Router } from "express";
import path from "path";
import fs from "fs";
import multer from "multer";
import { requireAuth } from "./rbac";
import prisma, { notifyUsers } from "../lib/prismaClient";
import { liveEmit } from "../lib/live";
import { approbateurIds, etapeCourante } from "../lib/approbations";
import { RH_ROLES } from "../lib/rh";

// Discussion sur n'importe quelle fiche : demande, bon, client.
// Même principe que la discussion d'un dossier : texte, photos, vidéos, documents, mentions @.
const router = Router();
const VOIR_TOUT_DEMANDES = ["super_admin", "pdg", "dg", "dga", "daf", "rh"];
const full = (u: any) => (u ? [u.prenom, u.nom].filter(Boolean).join(" ") : "");

type Cible = { titre: string; lien: string; proprietaires: number[] };

// Chaque type de fiche : qui peut lire la discussion, son titre, son lien, qui prévenir par défaut
const CIBLES: Record<string, (id: number, user: any) => Promise<Cible | null>> = {
  async demande(id, user) {
    const d: any = await prisma.demande.findUnique({ where: { id }, include: { etapes: true } });
    if (!d) return null;
    const approbateurs = new Set<number>();
    for (const e of d.etapes) {
      if (e.decideur_id) approbateurs.add(e.decideur_id);
    }
    const ec = etapeCourante(d);
    if (ec) (await approbateurIds(d, ec.approbateur)).forEach((x) => approbateurs.add(x));
    let voit = d.demandeur_id === user.id || VOIR_TOUT_DEMANDES.includes(user.role) || approbateurs.has(user.id);
    if (!voit) for (const e of d.etapes) if (e.approbateur === user.role || (e.approbateur === "RESPONSABLE" && (await approbateurIds(d, "RESPONSABLE")).includes(user.id))) { voit = true; break; }
    if (!voit) return null;
    return { titre: `Demande ${d.numero}`, lien: `/demandes/${id}`, proprietaires: [d.demandeur_id, ...approbateurs] };
  },
  async bon(id) {
    const b = await prisma.bonProvisoir.findUnique({ where: { id }, select: { numero: true, demandeur_id: true, approved_by_id: true } });
    if (!b) return null;
    return { titre: `Bon ${b.numero}`, lien: `/bons/${id}`, proprietaires: [b.demandeur_id, b.approved_by_id].filter(Boolean) as number[] };
  },
  async employe(id, user) {
    if (!RH_ROLES.includes(user.role)) return null;
    const e = await prisma.employe.findUnique({ where: { id }, select: { nom: true, prenom: true } });
    if (!e) return null;
    return { titre: `Dossier RH de ${full(e)}`, lien: `/rh/employes/${id}`, proprietaires: [] };
  },
  async client(id) {
    const c = await prisma.client.findUnique({ where: { id }, select: { nom: true } });
    if (!c) return null;
    return { titre: `Client ${c.nom}`, lien: `/clients/${id}`, proprietaires: [] };
  },
};

async function cible(req: any) {
  const kind = String(req.params.cible);
  const id = parseInt(req.params.id);
  if (!CIBLES[kind] || !id) return null;
  const c = await CIBLES[kind](id, req.session.user);
  return c ? { kind, id, ...c } : null;
}

const dir = (kind: string, id: number) => path.join(process.cwd(), "uploads", "fil", kind, String(id));
const upload = multer({
  storage: multer.diskStorage({
    destination: (req: any, _f, cb) => { const d = dir(String(req.params.cible).replace(/[^a-z]/g, ""), parseInt(req.params.id) || 0); fs.mkdirSync(d, { recursive: true }); cb(null, d); },
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}-${file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, "_")}`),
  }),
  limits: { fileSize: 64 * 1024 * 1024, files: 10 },
}).array("fichiers", 10);

const kindOf = (mime: string, name: string) =>
  /^image\//.test(mime) ? "image" : /^video\//.test(mime) ? "video" : /^audio\//.test(mime) ? "audio" : /\.pdf$/i.test(name) ? "pdf" : "file";
const parse = (s: string | null) => { try { return s ? JSON.parse(s) : []; } catch { return []; } };

function feedItem(m: any, me: number, noms: Map<number, string> = new Map()) {
  const del = !!m.deleted_at;
  return {
    id: m.id, mine: m.user_id === me, auteur: full(m.user), initiales: ((m.user?.prenom || "")[0] || "") + (m.user?.nom || "?")[0],
    texte: del ? "" : m.texte, deleted: del, at: m.created_at,
    mentions: del ? [] : parse(m.mentions_json).map((id: number) => noms.get(id)).filter(Boolean),
    att: del ? [] : parse(m.attachments_json).map((a: any) => ({ ...a, url: `/fil/${m.cible}/${m.cible_id}/fichier/${encodeURIComponent(a.filename)}` })),
  };
}

router.get("/fil/:cible/:id", requireAuth, async (req: any, res: any) => {
  const c = await cible(req);
  if (!c) return res.status(404).json({ error: "Discussion introuvable" });
  const msgs = await prisma.filMessage.findMany({ where: { cible: c.kind, cible_id: c.id }, include: { user: { select: { nom: true, prenom: true } } }, orderBy: { id: "asc" }, take: 500 });
  const mids = [...new Set(msgs.flatMap((m) => parse(m.mentions_json) as number[]))];
  const noms = new Map((mids.length ? await prisma.user.findMany({ where: { id: { in: mids } }, select: { id: true, nom: true, prenom: true } }) : []).map((u) => [u.id, full(u)] as [number, string]));
  res.json({ messages: msgs.map((m) => feedItem(m, req.session.userId, noms)), canWrite: req.session.user.role !== "lecture" });
});

router.post("/fil/:cible/:id", requireAuth, (req: any, res: any) => {
  upload(req, res, async (err: any) => {
    const files = (req.files as Express.Multer.File[]) || [];
    const drop = () => files.forEach((f) => fs.rm(f.path, () => {}));
    if (err) { drop(); return res.status(400).json({ error: err.code === "LIMIT_FILE_SIZE" ? "Fichier trop lourd (64 Mo au plus)." : err.message }); }
    const c = await cible(req);
    if (!c) { drop(); return res.status(404).json({ error: "Discussion introuvable" }); }
    if (req.session.user.role === "lecture") { drop(); return res.status(403).json({ error: "Compte en lecture seule." }); }
    const texte = String(req.body.texte || "").trim().slice(0, 4000);
    if (!texte && !files.length) return res.status(400).json({ error: "Message vide." });
    let mentions: number[] = [];
    try { mentions = (JSON.parse(req.body.mentions || "[]") as any[]).map(Number).filter((x) => x > 0).slice(0, 20); } catch {}
    const att = files.map((f) => ({ filename: f.filename, name: f.originalname, size: f.size, kind: kindOf(f.mimetype, f.originalname) }));
    const m = await prisma.filMessage.create({
      data: { cible: c.kind, cible_id: c.id, user_id: req.session.userId, texte, attachments_json: att.length ? JSON.stringify(att) : null, mentions_json: mentions.length ? JSON.stringify(mentions) : null },
      include: { user: { select: { nom: true, prenom: true } } },
    });
    liveEmit({ t: "fil", k: `${c.kind}:${c.id}`, id: m.id, by: req.session.userId });
    // Prévenir : les personnes mentionnées, puis les participants et les personnes liées à la fiche
    const me = req.session.userId;
    const auteurs = await prisma.filMessage.findMany({ where: { cible: c.kind, cible_id: c.id }, select: { user_id: true }, distinct: ["user_id"] });
    const valid = mentions.length ? (await prisma.user.findMany({ where: { id: { in: mentions }, actif: true }, select: { id: true } })).map((u) => u.id) : [];
    const tagged = valid.filter((x) => x !== me);
    const autres = [...new Set([...c.proprietaires, ...auteurs.map((a) => a.user_id)])].filter((x) => x !== me && !tagged.includes(x));
    const extrait = texte ? texte.slice(0, 120) : `${att.length} pièce${att.length > 1 ? "s" : ""} jointe${att.length > 1 ? "s" : ""}`;
    const qui = full(req.session.user) || req.session.user.nom;
    if (tagged.length) await notifyUsers(tagged, `🔔 ${qui} vous a mentionné`, `${c.titre} : ${extrait}`, `${c.lien}#fil`);
    if (autres.length) await notifyUsers(autres, `💬 ${c.titre}`, `${qui} : ${extrait}`, `${c.lien}#fil`);
    res.json({ ok: true, message: feedItem(m, me) });
  });
});

router.delete("/fil/:cible/:id/:mid", requireAuth, async (req: any, res: any) => {
  const c = await cible(req);
  if (!c) return res.status(404).json({ error: "Discussion introuvable" });
  const m = await prisma.filMessage.findFirst({ where: { id: parseInt(req.params.mid), cible: c.kind, cible_id: c.id } });
  if (!m || m.deleted_at) return res.status(404).json({ error: "Message introuvable" });
  if (m.user_id !== req.session.userId && req.session.user.role !== "super_admin") return res.status(403).json({ error: "Seul l'auteur peut supprimer ce message." });
  await prisma.filMessage.update({ where: { id: m.id }, data: { deleted_at: new Date() } });
  for (const a of parse(m.attachments_json)) fs.rm(path.join(dir(c.kind, c.id), path.basename(a.filename)), () => {});
  liveEmit({ t: "fil", k: `${c.kind}:${c.id}`, id: m.id, by: req.session.userId });
  res.json({ ok: true });
});

router.get("/fil/:cible/:id/fichier/:name", requireAuth, async (req: any, res: any) => {
  const c = await cible(req);
  const name = path.basename(String(req.params.name));
  if (!c) return res.status(404).send("Introuvable");
  // Le fichier doit appartenir à un message non supprimé de cette discussion
  const msgs = await prisma.filMessage.findMany({ where: { cible: c.kind, cible_id: c.id, deleted_at: null, attachments_json: { contains: name } }, select: { attachments_json: true } });
  const a = msgs.flatMap((m) => parse(m.attachments_json)).find((x: any) => x.filename === name);
  const file = path.join(dir(c.kind, c.id), name);
  if (!a || !fs.existsSync(file)) return res.status(404).send("Fichier introuvable");
  res.setHeader("Content-Disposition", `${a.kind === "file" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(a.name)}`);
  res.sendFile(file); // sendFile gère les requêtes partielles (lecture des vidéos)
});

// Personnes qu'on peut mentionner
router.get("/fil-membres", requireAuth, async (_req: any, res: any) => {
  const users = await prisma.user.findMany({ where: { actif: true }, select: { id: true, nom: true, prenom: true, role: true }, orderBy: { nom: "asc" } });
  res.json(users.map((u) => ({ id: u.id, nom: full(u), role: u.role })));
});

export default router;
