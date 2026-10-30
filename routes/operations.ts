import { lireArticles, memoriserCodes } from "../lib/validation";
import express from "express";
import path from "path";
import fs from "fs";
import multer from "multer";
import prisma, { basePrisma, notifyRoles, ensureTrackingToken, messageClient } from "../lib/prismaClient";
import { requireAuth, requireModule } from "./rbac";
import { vapidPublicKey, sendPushToUser } from "../lib/push";
import { STEPS, stepOf, missingRequirements, dossierFinance, hoursLate, STAGE_ACTORS } from "../lib/pipeline";
import { generateRef } from "../lib/generateRef";
import { visaHolders } from "../lib/bons";
import { liveBus, LiveEvent } from "../lib/live";
import { ensureDefaultAccounts, postEcriture } from "../lib/accounting";

// Fonctions ajoutées : PWA et notifications push, données CAMCIS, visite, BAE,
// lien de suivi client, facture automatique, visas mobiles et rapports de pilotage.
const router = express.Router();

const ADMIN_ROLES = ["super_admin", "pdg", "dg", "dga"];
const CAMCIS_ROLES = ["validation", "validation_role", "guce", ...ADMIN_ROLES, "auditeur1"];
const TERRAIN_ROLES = ["acconage", "enlevement", "operationnel", "validation", "validation_role", ...ADMIN_ROLES];
const FACTURATION_ROLES = ["facturation", "comptable", "comptable_ops", "finances", "commercial", ...ADMIN_ROLES, "daf"];

async function logActivity(userId: number, action: string, entity: string, entityId?: number | string, meta?: any) {
  try {
    await prisma.activityLog.create({
      data: { user_id: userId, action, entity, entity_id: entityId != null ? String(entityId) : null, meta: meta ? JSON.stringify(meta) : null },
    });
  } catch (e) { console.error("[LOG]", e); }
}

const num = (v: any) => {
  const n = parseFloat(String(v ?? "").replace(/\s/g, "").replace(",", "."));
  return isNaN(n) ? null : n;
};
const date = (v: any) => (v ? new Date(v) : null);
const flash = (req: any, kind: "success_msg" | "error_msg", msg: string) => { req.session[kind] = msg; };

const upload = multer({
  storage: multer.diskStorage({
    // même dossier que les autres pièces : uploads/dossiers/:id (lu par /dossiers/:id/download)
    destination: (req: any, _file, cb) => {
      const dir = path.join(process.cwd(), "uploads", "dossiers", String(parseInt(req.params.id) || 0));
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}-${file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, "_")}`),
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, /pdf|jpe?g|png/i.test(file.mimetype)),
});

async function saveFile(req: any, dossierId: number, file: Express.Multer.File | undefined, stage: string, category: string, comment: string) {
  if (!file) return;
  await prisma.dossierFile.create({
    data: { dossier_id: dossierId, user_id: req.session.userId, filename: file.filename, original: file.originalname, stage, category, comment, path: file.path },
  });
}

// =====================================================================
// PWA : manifeste, service worker, page hors ligne
// =====================================================================
router.get("/manifest.webmanifest", (_req, res) => {
  res.type("application/manifest+json").send(JSON.stringify({
    name: "YM-TRANSIT ERP",
    short_name: "YM-TRANSIT",
    description: "Dossiers de transit, visas, facturation et suivi en temps réel.",
    lang: "fr",
    start_url: "/dashboard?source=pwa",
    scope: "/",
    display: "standalone",
    orientation: "portrait-primary",
    background_color: "#0d1424",
    theme_color: "#059669",
    icons: [
      { src: "/assets/pwa/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/assets/pwa/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/assets/pwa/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Mes tâches", url: "/taches?mine=1", icons: [{ src: "/assets/pwa/icon-192.png", sizes: "192x192" }] },
      { name: "Visas en attente", url: "/bons/visas", icons: [{ src: "/assets/pwa/icon-192.png", sizes: "192x192" }] },
      { name: "Dossiers", url: "/dossiers", icons: [{ src: "/assets/pwa/icon-192.png", sizes: "192x192" }] },
    ],
  }));
});

router.get("/sw.js", (_req, res) => {
  res.set({ "Service-Worker-Allowed": "/", "Cache-Control": "no-cache" });
  res.sendFile(path.join(process.cwd(), "assets", "pwa", "sw.js"));
});

router.get("/offline", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "assets", "pwa", "offline.html"));
});

// =====================================================================
// Notifications push
// =====================================================================
router.get("/api/push/key", requireAuth, (_req, res) => {
  res.json({ ok: true, key: vapidPublicKey() });
});

router.post("/api/push/subscribe", requireAuth, async (req: any, res: any) => {
  const sub = req.body?.subscription;
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return res.status(400).json({ ok: false });
  const existing = await basePrisma.pushSubscription.findFirst({ where: { endpoint: sub.endpoint } });
  if (existing) {
    await basePrisma.pushSubscription.update({ where: { id: existing.id }, data: { user_id: req.session.userId, p256dh: sub.keys.p256dh, auth: sub.keys.auth } });
  } else {
    await basePrisma.pushSubscription.create({
      data: { user_id: req.session.userId, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, user_agent: String(req.get("user-agent") || "").slice(0, 250) },
    });
  }
  res.json({ ok: true });
});

router.post("/api/push/unsubscribe", requireAuth, async (req: any, res: any) => {
  const endpoint = req.body?.endpoint;
  if (endpoint) await basePrisma.pushSubscription.deleteMany({ where: { endpoint, user_id: req.session.userId } });
  res.json({ ok: true });
});

router.post("/api/push/test", requireAuth, async (req: any, res: any) => {
  const count = await basePrisma.pushSubscription.count({ where: { user_id: req.session.userId } });
  await sendPushToUser(basePrisma, req.session.userId, {
    title: "YM-TRANSIT", body: "Les notifications sont actives sur cet appareil.", url: "/dashboard", tag: "test",
  });
  res.json({ ok: true, devices: count });
});

// =====================================================================
// Mises à jour en direct (Server-Sent Events)
// =====================================================================
router.get("/api/live", requireAuth, (req: any, res: any) => {
  const uid = req.session.userId;
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders?.();
  res.write("retry: 3000\n\n");
  const on = (ev: LiveEvent) => {
    if (ev.u != null && ev.u !== uid) return; // notification destinée à quelqu'un d'autre
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  };
  liveBus.on("ev", on);
  const keepAlive = setInterval(() => res.write(": ka\n\n"), 25000);
  req.on("close", () => { clearInterval(keepAlive); liveBus.off("ev", on); });
});

// =====================================================================
// CAMCIS : enregistrement de la déclaration (sans changer d'étape)
// =====================================================================
router.post("/dossiers/:id/camcis", requireAuth, upload.single("fichier_camcis"), async (req: any, res: any) => {
  const id = parseInt(req.params.id);
  if (!CAMCIS_ROLES.includes(req.session.user?.role)) {
    flash(req, "error_msg", "Seuls le service validation, le GUCE ou la direction peuvent saisir la déclaration CAMCIS.");
    return res.redirect(`/dossiers/${id}`);
  }
  const b = req.body;
  const circuit = ["VERT", "JAUNE", "ROUGE"].includes(b.camcis_circuit) ? b.camcis_circuit : null;
  const before = await prisma.dossier.findUnique({ where: { id } });
  if (!before) return res.redirect("/dossiers");
  await prisma.dossier.update({
    where: { id },
    data: {
      camcis_numero: (b.camcis_numero || "").trim() || null,
      camcis_date: date(b.camcis_date),
      camcis_liquidation: num(b.camcis_liquidation),
      camcis_circuit: circuit,
      droits_douane: num(b.camcis_liquidation) ?? before.droits_douane,
      ...(b.gn_numero !== undefined ? { gn_numero: String(b.gn_numero).trim().toUpperCase() || null } : {}),
      ...(b.dau_numero !== undefined ? { dau_numero: String(b.dau_numero).trim().toUpperCase() || null } : {}),
      ...(b.art_designation !== undefined ? { articles_json: JSON.stringify(lireArticles(b)) } : {}),
    },
  });
  if (b.art_designation !== undefined) await memoriserCodes(lireArticles(b));
  await saveFile(req, id, req.file, before.pipeline_status, "CAMCIS", `Déclaration CAMCIS ${b.camcis_numero || ""}`.trim());
  await logActivity(req.session.userId, "CAMCIS_SAISI", "Dossier", id, { numero: b.camcis_numero, circuit });

  // Circuit jaune ou rouge : visite douanière à organiser
  if (circuit && circuit !== "VERT" && before.camcis_circuit !== circuit) {
    await notifyRoles(["acconage", "enlevement"], `🔎 Visite douanière : ${before.numero}`,
      `Circuit ${circuit.toLowerCase()} sur CAMCIS. Organisez la visite de la marchandise.`, `/dossiers/${id}`);
  }
  flash(req, "success_msg", "Déclaration CAMCIS enregistrée.");
  res.redirect(`/dossiers/${id}#camcis`);
});

// Un dossier au stade « Bon réel » dont tous les bons sont justifiés passe en facturation
// dès que le BAE (et la visite si circuit jaune/rouge) sont enregistrés.
async function tryAdvanceToBilling(id: number): Promise<boolean> {
  const d = await prisma.dossier.findUnique({ where: { id }, include: { files: true, bons_provisoir: { include: { bon_reel: true } } } });
  if (!d || d.pipeline_status !== "BON_REEL") return false;
  const approved = d.bons_provisoir.filter((b) => b.etat === "APPROUVE");
  const allJustified = approved.length > 0 && approved.every((b) => b.bon_reel);
  const pending = d.bons_provisoir.some((b) => b.etat === "EN_ATTENTE");
  if (!allJustified || pending || missingRequirements(d, "BON_REEL").length) return false;
  await prisma.dossier.update({ where: { id }, data: { pipeline_status: "FACTURATION" } });
  return true;
}

// Visite douanière (circuit jaune ou rouge)
router.post("/dossiers/:id/visite", requireAuth, upload.single("fichier_visite"), async (req: any, res: any) => {
  const id = parseInt(req.params.id);
  if (!TERRAIN_ROLES.includes(req.session.user?.role)) {
    flash(req, "error_msg", "Rôle non autorisé pour la visite douanière.");
    return res.redirect(`/dossiers/${id}`);
  }
  const d = await prisma.dossier.findUnique({ where: { id } });
  if (!d) return res.redirect("/dossiers");
  const terminee = req.body.visite_terminee === "on" || req.body.visite_terminee === "1";
  await prisma.dossier.update({
    where: { id },
    data: { visite_date: date(req.body.visite_date), visite_resultat: (req.body.visite_resultat || "").trim() || null, visite_terminee: terminee },
  });
  await saveFile(req, id, req.file, d.pipeline_status, "AUTRE", "Procès-verbal de visite douanière");
  await logActivity(req.session.userId, terminee ? "VISITE_TERMINEE" : "VISITE_MAJ", "Dossier", id);
  if (terminee && await tryAdvanceToBilling(id)) {
    flash(req, "success_msg", "Visite terminée. Toutes les pièces sont là : le dossier passe en facturation.");
    return res.redirect(`/dossiers/${id}`);
  }
  flash(req, "success_msg", terminee ? "Visite douanière terminée." : "Visite douanière mise à jour.");
  res.redirect(`/dossiers/${id}#camcis`);
});

// Passage manuel en facturation quand tout est prêt (ex. dossier qui n'attendait plus que le BAE, devenu facultatif)
router.post("/dossiers/:id/passer-facturation", requireAuth, async (req: any, res: any) => {
  const id = parseInt(req.params.id);
  if (!TERRAIN_ROLES.includes(req.session.user?.role) && !CAMCIS_ROLES.includes(req.session.user?.role)) {
    flash(req, "error_msg", "Rôle non autorisé pour passer le dossier en facturation.");
    return res.redirect(`/dossiers/${id}`);
  }
  if (await tryAdvanceToBilling(id)) {
    await logActivity(req.session.userId, "DOSSIER_FACTURATION", "Dossier", id);
    flash(req, "success_msg", "Le dossier passe en facturation.");
  } else flash(req, "error_msg", "Le dossier ne peut pas encore passer en facturation : un bon réel ou un paiement de bon est encore attendu.");
  res.redirect(`/dossiers/${id}`);
});

// Bon à enlever (BAE)
router.post("/dossiers/:id/bae", requireAuth, upload.single("fichier_bae"), async (req: any, res: any) => {
  const id = parseInt(req.params.id);
  if (!TERRAIN_ROLES.includes(req.session.user?.role) && !CAMCIS_ROLES.includes(req.session.user?.role)) {
    flash(req, "error_msg", "Rôle non autorisé pour saisir le BAE.");
    return res.redirect(`/dossiers/${id}`);
  }
  const d = await prisma.dossier.findUnique({ where: { id } });
  if (!d) return res.redirect("/dossiers");
  const bae = (req.body.bae_numero || "").trim() || null;
  await prisma.dossier.update({
    where: { id },
    data: {
      bae_numero: bae,
      bae_date: date(req.body.bae_date) || (bae ? new Date() : null),
    },
  });
  await saveFile(req, id, req.file, d.pipeline_status, "BAE", `Bon à enlever ${bae || ""}`.trim());
  await logActivity(req.session.userId, "BAE_SAISI", "Dossier", id, { bae });

  if (bae && !d.bae_numero) {
    messageClient(id, "Marchandise libérée", [`Votre marchandise a reçu son bon à enlever (BAE n° ${bae}). L'enlèvement est en cours d'organisation.`]).catch(() => {});
  }

  if (await tryAdvanceToBilling(id)) {
    flash(req, "success_msg", "BAE enregistré. Toutes les pièces sont là : le dossier passe en facturation.");
    return res.redirect(`/dossiers/${id}`);
  }
  flash(req, "success_msg", "Bon à enlever enregistré.");
  res.redirect(`/dossiers/${id}#camcis`);
});

// =====================================================================
// Lien de suivi client
// =====================================================================
router.post("/dossiers/:id/suivi-lien", requireAuth, async (req: any, res: any) => {
  const id = parseInt(req.params.id);
  const reset = req.body.reset === "1";
  if (reset) await basePrisma.dossier.update({ where: { id }, data: { tracking_token: null } });
  await ensureTrackingToken(id);
  await logActivity(req.session.userId, reset ? "LIEN_SUIVI_RENOUVELE" : "LIEN_SUIVI_CREE", "Dossier", id);
  flash(req, "success_msg", reset ? "Nouveau lien de suivi créé. L'ancien ne fonctionne plus." : "Lien de suivi client créé.");
  res.redirect(`/dossiers/${id}#suivi-client`);
});

router.get("/suivi/:token", async (req: any, res: any) => {
  const token = String(req.params.token || "");
  if (token.length < 16) return res.status(404).render("suivi/introuvable");
  const d = await prisma.dossier.findFirst({
    where: { tracking_token: token },
    include: { client: { select: { nom: true } }, stage_logs: { orderBy: { created_at: "asc" } } },
  });
  if (!d) return res.status(404).render("suivi/introuvable");
  // Étapes vues par le client (regroupées, sans les détails internes de caisse)
  const clientSteps = [
    { label: "Dossier ouvert", keys: ["CREE"] },
    { label: "Formalités GUCE", keys: ["GUCE"] },
    { label: "Déclaration en douane (CAMCIS)", keys: ["VALIDATION"] },
    { label: "Paiement des droits de douane", keys: ["PAIEMENT_DROITS"] },
    { label: "Opérations portuaires", keys: ["EN_TRAITEMENT", "BON_PROVISOIR"] },
    { label: "Enlèvement et livraison", keys: ["BON_REEL"] },
    { label: "Facturation", keys: ["FACTURATION"] },
    { label: "Dossier terminé", keys: ["CLOTURE", "ARCHIVE"] },
  ];
  const cur = clientSteps.findIndex((s) => s.keys.includes(d.pipeline_status));
  const reached = (keys: string[]) => {
    const log = d.stage_logs.find((l) => keys.includes(l.to_stage));
    return log ? log.created_at : null;
  };
  res.set("X-Robots-Tag", "noindex");
  res.render("suivi/index", { d, clientSteps, cur: Math.max(0, cur), reached });
});

// =====================================================================
// Facture générée à partir des bons réels + honoraires
// =====================================================================
router.post("/dossiers/:id/facture-auto", requireAuth, async (req: any, res: any) => {
  const id = parseInt(req.params.id);
  const user = req.session.user;
  if (!FACTURATION_ROLES.includes(user?.role)) {
    flash(req, "error_msg", "Rôle non autorisé pour facturer.");
    return res.redirect(`/dossiers/${id}`);
  }
  const d = await prisma.dossier.findUnique({
    where: { id },
    include: { client: true, bons_provisoir: { include: { bon_reel: true } }, documents: true },
  });
  if (!d) return res.redirect("/dossiers");

  const lines: { description: string; quantite: number; prix_unitaire: number; taxe_id: string; total: number }[] = [];
  // Lignes choisies par la facturation (toutes les dépenses proposées, certaines décochées ou corrigées)
  if (req.body.l_mode) {
    const desc = [].concat(req.body.l_desc || []), mts = [].concat(req.body.l_mt || []);
    const on = new Set([].concat(req.body.l_on || []).map((x: any) => parseInt(x)));
    desc.forEach((dd: any, i: number) => {
      const m = num(mts[i]) || 0;
      if (on.has(i) && m > 0) lines.push({ description: String(dd || "Débours").trim() || "Débours", quantite: 1, prix_unitaire: m, taxe_id: "EXONERE", total: m });
    });
  } else for (const bp of d.bons_provisoir) {
    if (!bp.bon_reel) continue;
    let items: any[] = [];
    try { items = bp.bon_reel.items_json ? JSON.parse(bp.bon_reel.items_json) : []; } catch { items = []; }
    if (items.length) {
      for (const it of items) {
        const m = num(it.montant) || 0;
        if (m > 0) lines.push({ description: `Débours : ${it.designation || it.description || bp.objet}`, quantite: 1, prix_unitaire: m, taxe_id: "EXONERE", total: m });
      }
    } else if (bp.bon_reel.montant_reel > 0) {
      lines.push({ description: `Débours : ${bp.objet} (bon ${bp.numero})`, quantite: 1, prix_unitaire: bp.bon_reel.montant_reel, taxe_id: "EXONERE", total: bp.bon_reel.montant_reel });
    }
  }
  const honoraires = num(req.body.honoraires) || 0;
  const tva = req.body.tva_honoraires !== "0";
  if (honoraires > 0) {
    lines.push({ description: `Honoraires de transit · dossier ${d.numero}`, quantite: 1, prix_unitaire: honoraires, taxe_id: tva ? "TVA_19_25" : "EXONERE", total: honoraires });
  }
  if (!lines.length) {
    flash(req, "error_msg", "Rien à facturer : aucun bon réel justifié et pas d'honoraires saisis.");
    return res.redirect(`/dossiers/${id}#finance`);
  }
  const totalHT = lines.reduce((s, l) => s + l.total, 0);
  const totalTTC = Math.round(lines.reduce((s, l) => s + (l.taxe_id === "TVA_19_25" ? l.total * 1.1925 : l.total), 0));
  const societe = user.societe || "YM-TRANSIT";

  const doc = await prisma.$transaction(async (tx: any) => {
    const created = await tx.document.create({
      data: {
        type: "FACTURE", numero: generateRef("FAC"), client_id: d.client_id, dossier_id: d.id, societe, phase: "FINALE",
        total_ht: totalHT, total_ttc: totalTTC, etat: "EMIS", lines: { create: lines },
      },
    });
    await ensureDefaultAccounts(tx, societe);
    const comptes = await tx.compteComptable.findMany() // codes uniques pour toutes les sociétés;
    const c411 = comptes.find((c: any) => c.code === "411");
    const c706 = comptes.find((c: any) => c.code === "706");
    const c445 = comptes.find((c: any) => c.code === "445");
    if (c411 && c706 && c445) {
      await postEcriture(tx, {
        journal: "VTE", piece_ref: created.numero, libelle: `Facture ${created.numero} — ${d.client.nom}`, societe,
        created_by: req.session.userId, date: created.created_at,
        lignes: [
          { compte_id: c411.id, debit: totalTTC, credit: 0 },
          { compte_id: c706.id, debit: 0, credit: totalHT },
          { compte_id: c445.id, debit: 0, credit: totalTTC - totalHT },
        ],
      });
    }
    return created;
  });
  await logActivity(req.session.userId, "FACTURE_AUTO", "Document", doc.id, { dossier: d.numero, total: totalTTC });
  messageClient(id, "Votre facture", [`La facture ${doc.numero} de ${totalTTC.toLocaleString("fr-FR")} FCFA a été émise pour votre dossier.`]).catch(() => {});
  flash(req, "success_msg", `Facture ${doc.numero} générée (${totalTTC.toLocaleString("fr-FR")} F TTC) à partir des bons réels.`);
  res.redirect(`/facturation/${doc.id}`);
});


// =====================================================================
// Étape « Facture 1 et paiement à la banque » (après la validation CAMCIS)
// =====================================================================
const DROITS_ROLES = STAGE_ACTORS.PAIEMENT_DROITS;

// Facture 1 : droits liquidés sur CAMCIS + frais bancaires, facturés au client (écriture 411 / 706)
async function creerFacture1(req: any, d: any, montant: number, frais: number) {
  const user = req.session.user;
  const lines = [{ description: `Droits et taxes de douane · déclaration CAMCIS ${d.camcis_numero || ""}`.trim(), quantite: 1, prix_unitaire: montant, taxe_id: "EXONERE", total: montant }];
  if (frais > 0) lines.push({ description: "Frais bancaires de paiement des droits", quantite: 1, prix_unitaire: frais, taxe_id: "EXONERE", total: frais });
  const total = montant + frais;
  const societe = user.societe || "YM-TRANSIT";
  const doc = await prisma.$transaction(async (tx: any) => {
    const created = await tx.document.create({
      data: { type: "FACTURE", phase: "DROITS", numero: generateRef("FAC"), client_id: d.client_id, dossier_id: d.id, societe,
        total_ht: total, total_ttc: total, etat: "EMIS", lines: { create: lines } },
    });
    await ensureDefaultAccounts(tx, societe);
    const comptes = await tx.compteComptable.findMany(); // codes uniques pour toutes les sociétés
    const c411 = comptes.find((c: any) => c.code === "411");
    const c706 = comptes.find((c: any) => c.code === "706");
    if (c411 && c706) {
      await postEcriture(tx, {
        journal: "VTE", piece_ref: created.numero, libelle: `Facture 1 (droits) ${created.numero} — ${d.client.nom}`, societe,
        created_by: req.session.userId, date: created.created_at,
        lignes: [{ compte_id: c411.id, debit: total, credit: 0 }, { compte_id: c706.id, debit: 0, credit: total }],
      });
    }
    return created;
  });
  await logActivity(req.session.userId, "FACTURE_DROITS", "Document", doc.id, { dossier: d.numero, total });
  messageClient(d.id, "Facture des droits de douane", [`La facture ${doc.numero} de ${total.toLocaleString("fr-FR")} FCFA couvre les droits et taxes de douane liquidés pour votre dossier${frais > 0 ? ", frais bancaires compris" : ""}.`]).catch(() => {});
  return doc;
}

// Ancien bouton « Émettre la facture 1 » seul : toujours accepté
router.post("/dossiers/:id/facture-droits", requireAuth, async (req: any, res: any) => {
  const id = parseInt(req.params.id);
  if (!DROITS_ROLES.includes(req.session.user?.role)) {
    flash(req, "error_msg", "Rôle non autorisé pour émettre la facture 1.");
    return res.redirect(`/dossiers/${id}`);
  }
  const d = await prisma.dossier.findUnique({ where: { id }, include: { client: true, documents: true } });
  if (!d) return res.redirect("/dossiers");
  if (d.pipeline_status !== "PAIEMENT_DROITS") { flash(req, "error_msg", "La facture 1 se fait à l'étape « Facture 1 et paiement banque »."); return res.redirect(`/dossiers/${id}`); }
  if (d.documents.some((x: any) => x.phase === "DROITS")) { flash(req, "error_msg", "La facture 1 de ce dossier existe déjà."); return res.redirect(`/dossiers/${id}#droits`); }
  const montant = num(req.body.montant) ?? d.camcis_liquidation ?? 0;
  if (!(montant > 0)) { flash(req, "error_msg", "Indiquez le montant des droits liquidés sur CAMCIS."); return res.redirect(`/dossiers/${id}#droits`); }
  const frais = num(req.body.frais) || 0;
  const doc = await creerFacture1(req, d, montant, frais);
  await prisma.dossier.update({ where: { id }, data: { droits_frais: frais || null } });
  flash(req, "success_msg", `Facture 1 ${doc.numero} émise (${(montant + frais).toLocaleString("fr-FR")} F).`);
  res.redirect(`/dossiers/${id}#droits`);
});

// Facture 1 et paiement des droits en une seule fois : quand tout est rempli, la facture 1 est émise
// automatiquement (droits + frais bancaires), le paiement est enregistré et le dossier passe en traitement.
router.post("/dossiers/:id/paiement-droits", requireAuth, upload.single("fichier_quittance"), async (req: any, res: any) => {
  const id = parseInt(req.params.id);
  const user = req.session.user;
  if (!DROITS_ROLES.includes(user?.role)) {
    flash(req, "error_msg", "Rôle non autorisé pour saisir le paiement des droits.");
    return res.redirect(`/dossiers/${id}`);
  }
  const d = await prisma.dossier.findUnique({ where: { id }, include: { client: true, documents: true, files: true } });
  if (!d) return res.redirect("/dossiers");
  if (d.pipeline_status !== "PAIEMENT_DROITS") {
    flash(req, "error_msg", "Ce dossier n'est pas à l'étape « Facture 1 et paiement banque ».");
    return res.redirect(`/dossiers/${id}`);
  }
  const b = req.body;
  // Ancien champ « Argent versé par » : CAISSE, BANQUE (la société) ou CLIENT
  const legacy = b.source_fonds;
  const payePar = ["CLIENT", "SOCIETE"].includes(b.paye_par) ? b.paye_par : legacy === "CLIENT" ? "CLIENT" : legacy ? "SOCIETE" : d.droits_paye_par;
  const mode = ["BANQUE", "CAISSE"].includes(b.mode_paiement) ? b.mode_paiement : legacy === "CAISSE" ? "CAISSE" : legacy ? "BANQUE" : d.droits_mode;
  const droits = num(b.droits_montant) ?? num(b.droits_paye_montant) ?? d.droits_paye_montant ?? d.camcis_liquidation;
  const frais = num(b.droits_frais) ?? d.droits_frais ?? 0;
  const banque = String(b.droits_banque || "").trim().toUpperCase() || d.droits_banque;
  const quittance = String(b.camcis_quittance || "").trim().toUpperCase() || d.camcis_quittance;
  await prisma.dossier.update({
    where: { id },
    data: { camcis_quittance: quittance, droits_paye_montant: droits, droits_frais: frais || null, droits_banque: banque, droits_paye_par: payePar, droits_mode: mode,
      droits_paye_date: date(b.droits_paye_date) || d.droits_paye_date || new Date() },
  });
  await saveFile(req, id, req.file, "PAIEMENT_DROITS", "QUITTANCE_DOUANE", `Quittance bancaire ${quittance || ""}`.trim());

  const hasQuittanceFile = !!req.file || d.files.some((f: any) => f.category === "QUITTANCE_DOUANE");
  const manque = [
    !(droits && droits > 0) && "le montant des droits",
    !banque && "la banque",
    !payePar && "qui paie (client ou société)",
    !mode && "le mode de paiement (banque ou caisse)",
    !quittance && "le n° de quittance",
    !hasQuittanceFile && "la quittance (PDF ou photo)",
  ].filter(Boolean);
  if (manque.length) {
    flash(req, "error_msg", `Rien n'est encore émis : il manque ${manque.join(", ")}. Ce qui est déjà saisi est gardé.`);
    return res.redirect(`/dossiers/${id}#droits`);
  }

  // Facture 1 émise automatiquement (une seule fois)
  let facture = d.documents.find((x: any) => x.phase === "DROITS");
  if (!facture) facture = await creerFacture1(req, d, droits!, frais);
  const total = droits! + frais;

  // Payé par la société en espèces : la sortie (droits + frais bancaires) est inscrite dans le journal de caisse
  if (payePar === "SOCIETE" && mode === "CAISSE") {
    const already = await prisma.caisseMouvement.findFirst({ where: { dossier_id: id, categorie: "DROITS_DOUANE" } });
    if (!already) {
      await prisma.caisseMouvement.create({
        data: { sens: "SORTIE", montant: total, categorie: "DROITS_DOUANE", libelle: `Droits de douane ${d.numero} (quittance ${quittance})${frais ? `, frais bancaires compris` : ""}`,
          mode: "ESPECES", reference: quittance, tiers: banque, dossier_id: id, user_id: req.session.userId },
      });
    }
  }
  await logActivity(req.session.userId, "DROITS_PAYES", "Dossier", id, { quittance, droits, frais, payePar, mode, banque });

  const full = await prisma.dossier.findUnique({ where: { id }, include: { files: true, documents: true } });
  const missing = full ? missingRequirements(full, "PAIEMENT_DROITS") : [];
  if (missing.length) {
    flash(req, "error_msg", `Paiement enregistré, mais il manque encore : ${missing.join(", ")}.`);
    return res.redirect(`/dossiers/${id}#droits`);
  }
  await prisma.dossier.update({ where: { id }, data: { pipeline_status: "EN_TRAITEMENT" } });
  flash(req, "success_msg", `Facture 1 ${facture.numero} (${total.toLocaleString("fr-FR")} F) et paiement enregistrés. Le dossier passe en traitement.`);
  res.redirect(`/dossiers/${id}`);
});

// =====================================================================
// Visas en un geste (mobile) pour la direction
// =====================================================================
const VISA_KEY_BY_ROLE: Record<string, string> = { pdg: "pdg", dg: "dg", dga: "dga", daf: "daf", auditeur1: "audit", auditeur2: "audit" };

router.get("/bons/visas", requireAuth, async (req: any, res: any) => {
  const role = req.session.user?.role;
  const myKey = VISA_KEY_BY_ROLE[role] || (role === "super_admin" ? "*" : null);
  const isCaisse = ["agent_payeur", "caisse"].includes(role);
  if (!myKey && !isCaisse) {
    flash(req, "error_msg", "Cette page est réservée à la direction et à la caisse.");
    return res.redirect("/dashboard");
  }
  // La caisse voit tous les bons dès leur création, avec les visas en direct
  const bons = await prisma.bonProvisoir.findMany({
    where: { etat: "EN_ATTENTE" },
    include: { dossier: { select: { id: true, numero: true, bl: true, contenu: true, client: { select: { nom: true } } } }, demandeur: { select: { nom: true, prenom: true } } },
    orderBy: [{ urgent: "desc" }, { created_at: "asc" }],
  });
  res.render("bons/visas", { bons, myKey, isCaisse: isCaisse || role === "super_admin", canOrder: ["pdg", "dg", "super_admin"].includes(role), holders: await visaHolders(), title: "Visas en attente" });
});

// =====================================================================
// Rapports de pilotage
// =====================================================================
router.get("/rapports", requireAuth, requireModule("analytics"), async (req: any, res: any) => {
  const dossiers = await prisma.dossier.findMany({
    include: {
      client: { select: { id: true, nom: true } },
      bons_provisoir: { select: { etat: true, montant_demande: true, approved_at: true, numero: true, bon_reel: { select: { id: true } } } },
      bons_reel: { select: { montant_reel: true, items_json: true } },
      documents: { select: { type: true, total_ht: true, total_ttc: true, payments: { select: { montant: true } } } },
      stage_logs: { orderBy: { created_at: "asc" } },
    },
    orderBy: { created_at: "desc" },
  });

  // 1. Durée moyenne passée à chaque étape (d'après l'historique des changements d'étape)
  const durations: Record<string, number[]> = {};
  for (const d of dossiers) {
    const logs = d.stage_logs;
    for (let i = 0; i < logs.length; i++) {
      const end = logs[i + 1] ? logs[i + 1].created_at.getTime() : (logs[i].to_stage === "ARCHIVE" ? null : Date.now());
      if (end == null) continue;
      (durations[logs[i].to_stage] ||= []).push((end - logs[i].created_at.getTime()) / 36e5);
    }
  }
  const stepStats = STEPS.filter((s) => s.key !== "ARCHIVE").map((s) => {
    const arr = durations[s.key] || [];
    const avg = arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
    return { ...s, avg, samples: arr.length, count: dossiers.filter((d) => d.pipeline_status === s.key).length,
      late: dossiers.filter((d) => d.pipeline_status === s.key && hoursLate(d as any) > 0).length };
  });

  // 2. Rentabilité par dossier et alertes
  const finance = dossiers.map((d) => ({ d, f: dossierFinance(d), late: hoursLate(d as any) }));
  const totals = finance.reduce((t, x) => {
    for (const k of Object.keys(x.f) as (keyof typeof x.f)[]) t[k] = (t[k] || 0) + x.f[k];
    return t;
  }, {} as Record<string, number>);
  const closedStages = ["FACTURATION", "CLOTURE", "ARCHIVE"];
  const alerts = {
    nonFactures: finance.filter((x) => closedStages.includes(x.d.pipeline_status) && x.f.nonFacture > 0),
    nonJustifies: finance.filter((x) => x.f.nonJustifie > 0),
    enRetard: finance.filter((x) => x.late > 0).sort((a, b) => b.late - a.late),
  };

  // 3. Activité par client et par port
  const byClient: Record<string, { nom: string; n: number; facture: number; aRecouvrer: number }> = {};
  const byPort: Record<string, number> = {};
  for (const x of finance) {
    const k = String(x.d.client?.id ?? "?");
    byClient[k] ||= { nom: x.d.client?.nom || "—", n: 0, facture: 0, aRecouvrer: 0 };
    byClient[k].n++; byClient[k].facture += x.f.facture; byClient[k].aRecouvrer += x.f.aRecouvrer;
    byPort[x.d.port || "—"] = (byPort[x.d.port || "—"] || 0) + 1;
  }

  // 4. Dépenses par nature (lignes des bons réels)
  const byExpense: Record<string, number> = {};
  for (const d of dossiers) {
    for (const br of d.bons_reel) {
      let items: any[] = [];
      try { items = br.items_json ? JSON.parse(br.items_json) : []; } catch { items = []; }
      if (!items.length) { byExpense["Non détaillé"] = (byExpense["Non détaillé"] || 0) + (br.montant_reel || 0); continue; }
      for (const it of items) {
        const label = String(it.designation || it.description || "Autre").trim().replace(/\s+/g, " ");
        const key = label.charAt(0).toUpperCase() + label.slice(1).toLowerCase();
        byExpense[key] = (byExpense[key] || 0) + (num(it.montant) || 0);
      }
    }
  }

  res.render("rapports/index", {
    title: "Pilotage", stepStats, finance, totals, alerts,
    byClient: Object.values(byClient).sort((a, b) => b.n - a.n),
    byPort: Object.entries(byPort).sort((a, b) => b[1] - a[1]),
    byExpense: Object.entries(byExpense).sort((a, b) => b[1] - a[1]).slice(0, 12),
  });
});

export default router;
