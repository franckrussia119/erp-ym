import { Router } from "express";
import multer from "multer";
import { attribuerRecu, enLettres, ORIGINES, origineDe, sousCategorie } from "../lib/recus";
import path from "path";
import fs from "fs";
import { requireAuth } from "./rbac";
import { notify, notifyUser } from "../lib/notify";
import { notifyRoles } from "../lib/prismaClient";
import { VISA_KEYS, VISA_LABELS, VISA_AVANT, INTERNE_INFORMES, type VisaKey, ROLES_BY_VISA, CAISSE_ROLES, ORDRE_ROLES, NON_REQUIS, initialTicks, allVisas, visaHolders, visaProgress, payable, bonTitle, categorieLabel, canRequestBon, justifyUrl } from "../lib/bons";
import PDFDocument from "pdfkit";
import prisma from "../lib/prismaClient";
import { missingRequirements } from "../lib/pipeline";
import { generateRef } from "../lib/generateRef";
import { pdfSafe } from "../lib/pdfSafe";
import { advanceIfJustified, regulariser, dejaRendu, creerBonSupplementaire, cloreSupplementPaye } from "../lib/reliquats";

const router = Router();

// Storage temporaire pour les Bons (qui sera déplacé vers uploads/dossiers/:id)
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const dir = path.join(process.cwd(), "uploads", "temp");
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const cleanedName = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, "_");
    cb(null, `${uniqueSuffix}-${cleanedName}`);
  }
});

const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    const filetypes = /pdf$/;
    const mimetype = filetypes.test(file.mimetype);
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error("Seuls les fichiers PDF sont acceptés !"));
  },
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

const uploadJustificatifs = multer({
  storage: storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req: any, file: any, cb: any) => {
    const ok = /pdf|jpg|jpeg|png/i.test(file.mimetype) || /pdf|jpg|jpeg|png/i.test(path.extname(file.originalname).toLowerCase());
    if (ok) {
      cb(null, true);
    } else {
      cb(new Error("Seuls les formats PDF, JPG, JPEG et PNG sont acceptés !"));
    }
  }
}).any();
// Champs de fichiers admis sur le bon réel : reçus par ligne (recu_p_<i>, recu_n_<k>) et reçus généraux
const RECU_FIELD = /^(fichiers_justificatifs|recu_p_\d+|recu_n_\d+)$/;

// Helper de log d'activité
async function logActivity(userId: number, action: string, entity: string, entityId?: number | string) {
  try {
    await prisma.activityLog.create({
      data: {
        user_id: userId,
        action,
        entity,
        entity_id: entityId !== undefined && entityId !== null ? String(entityId) : null,
      },
    });
  } catch (error) {
    console.error("Erreur de journalisation d'activité dans routing/bons :", error);
  }
}

// Helper pour créer automatiquement des tâches connectées au workflow
async function createAutoTask(dossierId: number, title: string, description: string, targetRole: string) {
  try {
    const targetUser = await prisma.user.findFirst({
      where: { role: targetRole, actif: true }
    });
    
    const duplicate = await prisma.tache.findFirst({
      where: { dossier_id: dossierId, titre: title, archive: false }
    });
    
    if (!duplicate) {
      await prisma.tache.create({
        data: {
          dossier_id: dossierId,
          titre: title,
          observations: description,
          intervenant_id: targetUser ? targetUser.id : null,
          etat: "EN_COURS",
          deadline: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000) // 2 jours
        }
      });
      console.log(`[AUTO-TASK] Created task "${title}" assigned to role "${targetRole}"`);
    }
  } catch (err) {
    console.error("[AUTO-TASK] Failed to create automatic task:", err);
  }
}

// POST /bons/provisoir - Créer un Bon Provisoir
router.post("/bons/provisoir", requireAuth, (req: any, res: any) => {
  upload.single("pdf_file")(req, res, async function (err: any) {
    try {
      const id = req.body.dossier_id;
      if (err) {
        req.session.error_msg = `Échec de l'import de pièces justificatives : ${err.message}`;
        return res.redirect(id ? `/dossiers/${id}` : "/dashboard");
      }

      const user = req.session.user;
      if (user.role === "lecture") {
        req.session.error_msg = "Accès refusé : compte en lecture seule.";
        return res.redirect(id ? `/dossiers/${id}` : "/dashboard");
      }

      const { dossier_id, objet, montant_demande, items_json } = req.body;
      const urgent = req.body.urgent === "1";
      const urg = urgent ? "🔴 URGENT · " : "";
      if (!dossier_id || !objet) {
        req.session.error_msg = "Veuillez remplir tous les champs obligatoires.";
        return res.redirect(dossier_id ? `/dossiers/${dossier_id}` : "/dossiers");
      }

      const dId = parseInt(dossier_id);
      const dossier = await prisma.dossier.findUnique({ where: { id: dId } });

      if (!dossier) {
        req.session.error_msg = "Dossier introuvable.";
        return res.redirect("/dossiers");
      }

      // Tout employé peut demander une avance pour un dossier, à n'importe quelle étape avant la clôture
      if (!canRequestBon(user.role, dossier.pipeline_status)) {
        req.session.error_msg = "Ce dossier est clôturé : on ne peut plus y demander de bon.";
        return res.redirect(`/dossiers/${dId}`);
      }

      // Auto-generate numero
      let numero = generateRef("BP");
      
      // Check for unique number
      let exists = await prisma.bonProvisoir.findUnique({ where: { numero } });
      while (exists) {
        numero = generateRef("BP");
        exists = await prisma.bonProvisoir.findUnique({ where: { numero } });
      }

      // Calcul automatique à partir de la liste des charges
      let finalItemsJson = "[]";
      let computedTotal = 0;

      if (items_json && items_json.trim() !== "" && items_json !== "[]") {
        try {
          finalItemsJson = items_json;
          const parsed = JSON.parse(items_json);
          if (Array.isArray(parsed)) {
            computedTotal = parsed.reduce((sum: number, it: any) => sum + parseFloat(it.montant || 0), 0);
          }
        } catch (e) {
          console.error("Erreur de parsing items_json :", e);
          computedTotal = parseFloat(montant_demande) || 0;
          finalItemsJson = JSON.stringify([{ designation: objet, montant: computedTotal }]);
        }
      } else {
        computedTotal = parseFloat(montant_demande) || 0;
        finalItemsJson = JSON.stringify([{ designation: objet, montant: computedTotal }]);
      }

      // Gérer l'upload de pièce jointe proforma / devis
      if (req.file) {
        const destDir = path.join(process.cwd(), "uploads", "dossiers", String(dId));
        if (!fs.existsSync(destDir)) {
          fs.mkdirSync(destDir, { recursive: true });
        }
        fs.renameSync(req.file.path, path.join(destDir, req.file.filename));
        
        await prisma.activityLog.create({
          data: {
            user_id: req.session.userId,
            action: 'fichier.uploaded',
            entity: 'dossier',
            entity_id: String(dId),
            meta: JSON.stringify({ filename: req.file.originalname })
          }
        });
      }

      const bon = await prisma.bonProvisoir.create({
        data: {
          numero,
          dossier_id: dId,
          service: user.role,
          demandeur_id: req.session.userId,
          objet,
          montant_demande: computedTotal,
          items_json: finalItemsJson,
          etat: "EN_ATTENTE",
          type: "DOSSIER",
          origine: req.body.origine === "DEBOURS" ? "DEBOURS" : null,
          urgent,
          ...initialTicks("DOSSIER", computedTotal)
        }
      });

      if (dossier.pipeline_status === "EN_TRAITEMENT") {
        await prisma.dossier.update({
          where: { id: dId },
          data: { pipeline_status: "BON_PROVISOIR" }
        });
      }

      await logActivity(req.session.userId, "BON_PROVISOIR_CREE", "BonProvisoir", bon.id);
      // Aucun utilisateur n'a le rôle "direction" : on notifie chaque signataire des 5 visas
      for (const role of ["pdg", "dg", "dga", "daf", "auditeur1", "auditeur2"]) {
        await notify(role, `${urg}Nouveau Bon Provisoir créé`, `Le bon provisoire ${numero} a été créé par ${user.nom} pour le dossier ${dossier.numero}. Votre visa est requis.`, `/bons/visas#bon-${bon.id}`);
      }
      // La caisse suit le bon dès sa création
      await notifyRoles(CAISSE_ROLES, `${urg || "🧾 "}Nouveau bon ${numero}`, `Dossier ${dossier.numero} · ${computedTotal.toLocaleString("fr-FR")} F · ${objet}. Visas en cours.`, `/bons/provisoir/pending#bon-${bon.id}`);

      // Gérer la tâche pour que la Direction puisse approuver/viser le bon
      await createAutoTask(dId, `✍️ Visa requis - Bon Provisoire ${numero}`, `Le bon provisoire ${numero} (${computedTotal.toLocaleString('fr-FR')} F) pour '${objet}' requiert vos visas de conformité directionnelle avant décaissement.`, "pdg");

      req.session.success_msg = `Bon Provisoire ${numero}${urgent ? " (URGENT)" : ""} émis avec succès (Total : ${computedTotal.toLocaleString('fr-FR')} F). Pièces justificatives liées au dossier.`;
      // Débours saisi depuis Dépenses internes : on montre le bon créé
      res.redirect(req.body.retour === "bon" ? `/bons/${bon.id}` : `/dossiers/${dId}`);
    } catch (error) {
      console.error("Erreur création bon provisoire :", error);
      res.status(500).render("errors/500", { error });
    }
  });
});

// GET /bons/provisoir/pending - Liste des Bons Provisoires en attente
router.get("/bons/provisoir/pending", requireAuth, async (req: any, res: any) => {
  try {
    const user = req.session.user;
    const allowedRoles = ["direction", "super_admin", "agent_payeur", "caisse", "pdg", "dg", "dga", "daf", "auditeur1", "auditeur2"];
    if (!allowedRoles.includes(user.role)) {
      req.session.error_msg = "Accès refusé.";
      return res.redirect("/dashboard");
    }

    // Tout le monde (caisse comprise) voit les bons dès leur création, avec l'avancement des visas
    const whereClause: any = { etat: "EN_ATTENTE" };

    const list = await prisma.bonProvisoir.findMany({
      where: whereClause,
      include: {
        dossier: { select: { numero: true, id: true, bl: true, contenu: true, client: { select: { nom: true } } } },
        demandeur: { select: { nom: true, prenom: true, role: true } }
      },
      orderBy: [{ urgent: "desc" }, { created_at: "asc" }]
    });

    res.render("bons/pending", {
      bons: list,
      isCaisse: CAISSE_ROLES.includes(user.role) || user.role === "super_admin",
      holders: await visaHolders(),
      canOrder: ORDRE_ROLES.includes(user.role) || user.role === "super_admin",
      visaProgress, payable, bonTitle, VISA_KEYS, VISA_LABELS,
      path: "/bons/provisoir/pending",
      title: "Bons Provisoires en attente",
      error_msg: req.session.error_msg || res.locals.error_msg || "",
      success_msg: req.session.success_msg || res.locals.success_msg || ""
    });
    // Nettoyer messages
    req.session.error_msg = null;
    req.session.success_msg = null;
  } catch (error) {
    console.error("Erreur liste bons provisoires :", error);
    res.status(500).render("errors/500", { error });
  }
});

// PATCH /bons/provisoir/:id/approuver - Décaissement par la caisse (après les visas requis, ou sur ordre du PDG/DG)
router.patch("/bons/provisoir/:id/approuver", requireAuth, async (req: any, res: any) => {
  try {
    const user = req.session.user;
    if (![...CAISSE_ROLES, "super_admin"].includes(user.role)) {
      return res.status(403).json({ ok: false, message: "Seule la caisse décaisse un bon. La direction donne son visa ou un ordre de paiement." });
    }

    const bonId = parseInt(req.params.id);
    const bon = await prisma.bonProvisoir.findUnique({
      where: { id: bonId },
      include: { demandeur: true, dossier: { select: { id: true, numero: true, pipeline_status: true } } }
    });

    if (!bon) {
      return res.status(404).json({ ok: false, message: "Bon provisoire introuvable." });
    }

    if (bon.etat !== "EN_ATTENTE") {
      return res.status(400).json({ ok: false, message: `Ce bon provisoire n'est plus en attente (état : ${bon.etat}).` });
    }

    if (!payable(bon)) {
      const p = visaProgress(bon);
      return res.status(403).json({ ok: false, message: `Paiement impossible : il manque le visa ${p.missing.map((k) => VISA_LABELS[k]).join(", ")} et aucun ordre de paiement du PDG ou du DG n'a été donné.` });
    }

    const payeur = `${user.prenom || ""} ${user.nom}`.trim();
    const mode = ["ESPECES", "CHEQUE", "VIREMENT", "MOBILE_MONEY"].includes(req.body?.mode) ? req.body.mode : "ESPECES";
    const recuPapier = String(req.body?.recu_papier || "").trim().slice(0, 60) || null;
    await prisma.$transaction([
      prisma.bonProvisoir.update({
        where: { id: bonId },
        data: {
          etat: "APPROUVE", approved_by_id: req.session.userId, approved_at: new Date(), paye_at: new Date(), paye_par: payeur,
          ...(recuPapier ? { recu_papier: recuPapier, recu_saisi_par: payeur, recu_saisi_at: new Date() } : {})
        }
      }),
      prisma.caisseMouvement.create({
        data: {
          sens: "SORTIE", montant: bon.montant_demande, categorie: bon.type === "INTERNE" ? (bon.categorie || "AUTRE") : "BON_DOSSIER",
          libelle: `Bon ${bon.numero} · ${bon.objet}`, mode, reference: (req.body?.reference || "").trim() || null,
          tiers: `${bon.demandeur.prenom || ""} ${bon.demandeur.nom}`.trim(), bon_id: bon.id, dossier_id: bon.dossier_id, user_id: req.session.userId, personne_id: bon.demandeur_id
        }
      })
    ]);

    const recu = await attribuerRecu(bonId);
    await cloreSupplementPaye(bonId);

    // Dossier : passe au bon réel quand plus aucun bon n'attend
    if (bon.dossier && bon.dossier.pipeline_status === "BON_PROVISOIR") {
      const stillPending = await prisma.bonProvisoir.count({ where: { dossier_id: bon.dossier.id, etat: { in: ["EN_ATTENTE", "A_MODIFIER"] } } });
      if (!stillPending) await prisma.dossier.update({ where: { id: bon.dossier.id }, data: { pipeline_status: "BON_REEL" } });
    }

    if (bon.dossier_id) {
      try {
        await prisma.tache.updateMany({
          where: { dossier_id: bon.dossier_id, titre: `💵 Décaissement - Bon Provisoire ${bon.numero}`, archive: false },
          data: { etat: "FAIT" }
        });
        await createAutoTask(
          bon.dossier_id,
          `🧾 Régularisation - Bon Provisoire ${bon.numero}`,
          `Le bon provisoire ${bon.numero} a été décaissé par la Caisse. Rassemblez vos reçus et saisissez le bon réel pour justifier la dépense.`,
          bon.service || "acconage"
        );
      } catch (tError) {
        console.error("Erreur mise à jour tâches lors du décaissement :", tError);
      }
    }

    await logActivity(req.session.userId, bon.ordre_paiement_by && !allVisas(bon) ? "BON_PAYE_SUR_ORDRE" : "BON_PROVISOIR_PAYE", "BonProvisoir", bonId);

    const lien = justifyUrl(bon);
    await notifyUser(bon.demandeur_id, `💵 Bon ${bon.numero} payé`, `La caisse a remis ${bon.montant_demande.toLocaleString("fr-FR")} F.${bon.bon_parent_id ? " Complément de votre dépense déjà justifiée : rien d'autre à faire." : " Pensez à justifier la dépense (bon réel)."}`, lien);

    res.json({ ok: true, recu: `/bons/${bonId}/recu`, message: `Bon ${bon.numero} payé (${bon.montant_demande.toLocaleString("fr-FR")} F). Reçu ${recu || ""} à faire signer.` });
  } catch (error) {
    console.error("Erreur décaissement bon provisoire :", error);
    res.status(500).json({ ok: false, message: "Erreur serveur." });
  }
});

// POST /bons/provisoir/:id/ordre - Ordre de paiement du PDG ou du DG (la caisse peut payer avant la fin des visas)
router.post("/bons/provisoir/:id/ordre", requireAuth, async (req: any, res: any) => {
  try {
    const user = req.session.user;
    if (![...ORDRE_ROLES, "super_admin"].includes(user.role)) {
      return res.status(403).json({ ok: false, message: "Seuls le PDG et le DG peuvent donner un ordre de paiement." });
    }
    const bonId = parseInt(req.params.id);
    const bon = await prisma.bonProvisoir.findUnique({ where: { id: bonId } });
    if (!bon || bon.etat !== "EN_ATTENTE") return res.status(400).json({ ok: false, message: "Ce bon n'est plus en attente." });
    const cancel = req.body?.annuler === "1" || req.body?.annuler === true;
    const by = `${user.prenom || ""} ${user.nom}`.trim() + ` (${user.role.toUpperCase()})`;
    await prisma.bonProvisoir.update({
      where: { id: bonId },
      data: cancel ? { ordre_paiement_by: null, ordre_paiement_at: null } : { ordre_paiement_by: by, ordre_paiement_at: new Date() }
    });
    await logActivity(req.session.userId, cancel ? "ORDRE_PAIEMENT_ANNULE" : "ORDRE_PAIEMENT", "BonProvisoir", bonId);
    if (!cancel) {
      await notifyRoles(CAISSE_ROLES, `✅ Ordre de paiement : ${bon.numero}`, `${by} ordonne le paiement de ${bon.montant_demande.toLocaleString("fr-FR")} F sans attendre les autres visas.`, `/bons/provisoir/pending#bon-${bon.id}`);
    }
    res.json({ ok: true, message: cancel ? "Ordre de paiement annulé." : "Ordre de paiement transmis à la caisse." });
  } catch (error) {
    console.error("Erreur ordre de paiement :", error);
    res.status(500).json({ ok: false, message: "Erreur serveur." });
  }
});

// PATCH /bons/provisoir/:id/rejeter - Rejet par un titulaire de visa : pour modification (le bon revient au
// demandeur, qui corrige et renvoie ; les visas repartent de zéro) ou définitif (le bon est clos)
router.patch("/bons/provisoir/:id/rejeter", requireAuth, async (req: any, res: any) => {
  try {
    const user = req.session.user;
    const allowedRoles = ["direction", "super_admin", "pdg", "dg", "dga", "daf", "auditeur1", "auditeur2"];
    if (!allowedRoles.includes(user.role)) {
      return res.status(403).json({ ok: false, message: "Accès non autorisé." });
    }

    const bonId = parseInt(req.params.id);
    const { motif_rejet } = req.body;
    const rejetType = req.body.type === "MODIFICATION" ? "MODIFICATION" : "DEFINITIF";

    if (!motif_rejet || motif_rejet.trim() === "") {
      return res.status(400).json({ ok: false, message: "Le motif du rejet est obligatoire." });
    }

    const bon = await prisma.bonProvisoir.findUnique({
      where: { id: bonId },
      include: { demandeur: true }
    });

    if (!bon) {
      return res.status(404).json({ ok: false, message: "Bon provisoire introuvable." });
    }

    if (bon.etat !== "EN_ATTENTE") {
      return res.status(400).json({ ok: false, message: `Ce bon n'est plus en attente (état : ${bon.etat}).` });
    }

    const noVisas: any = {};
    for (const k of VISA_KEYS) if ((bon as any)[`tick_${k}_by`] !== NON_REQUIS) { noVisas[`tick_${k}`] = false; noVisas[`tick_${k}_by`] = null; }
    await prisma.bonProvisoir.update({
      where: { id: bonId },
      data: rejetType === "MODIFICATION"
        ? { etat: "A_MODIFIER", rejet_type: rejetType, motif_rejet, ordre_paiement_by: null, ordre_paiement_at: null, ...noVisas }
        : { etat: "REJETE", rejet_type: rejetType, motif_rejet }
    });

    // Rejet définitif : le dossier revient « en traitement » si ce bon était le seul en cours
    if (bon.dossier_id && rejetType === "DEFINITIF") {
      const d = await prisma.dossier.findUnique({ where: { id: bon.dossier_id }, select: { pipeline_status: true } });
      const others = await prisma.bonProvisoir.count({ where: { dossier_id: bon.dossier_id, etat: { in: ["EN_ATTENTE", "APPROUVE", "A_MODIFIER"] } } });
      if (d?.pipeline_status === "BON_PROVISOIR" && !others) {
        await prisma.dossier.update({ where: { id: bon.dossier_id }, data: { pipeline_status: "EN_TRAITEMENT" } });
      }
    }

    const qui = `${user.prenom || ""} ${user.nom}`.trim();
    if (rejetType === "MODIFICATION") {
      await logActivity(req.session.userId, "BON_REJETE_POUR_MODIFICATION", "BonProvisoir", bonId);
      await notifyUser(bon.demandeur_id, `✏️ Bon ${bon.numero} à modifier`, `${qui} demande une modification : ${motif_rejet}. Corrigez le bon puis renvoyez-le aux visas.`, `/bons/${bon.id}#modifier`);
      await notifyRoles(CAISSE_ROLES, `✏️ Bon ${bon.numero} renvoyé pour modification`, `Motif : ${motif_rejet}`, `/bons/${bon.id}`);
      return res.json({ ok: true, message: "Bon renvoyé au demandeur pour modification." });
    }
    await logActivity(req.session.userId, "BON_PROVISOIR_REJETE", "BonProvisoir", bonId);
    await notifyUser(bon.demandeur_id, "⛔ Bon rejeté définitivement", `Votre bon ${bon.numero} a été rejeté par ${qui}. Motif : ${motif_rejet}`, `/bons/${bon.id}`);
    await notifyRoles(CAISSE_ROLES, `⛔ Bon ${bon.numero} rejeté`, `Motif : ${motif_rejet}`, `/bons/${bon.id}`);

    res.json({ ok: true, message: "Bon rejeté définitivement." });
  } catch (error) {
    console.error("Erreur rejet bon provisoire :", error);
    res.status(500).json({ ok: false, message: "Erreur serveur." });
  }
});

// Lignes du bon réel : les lignes du bon provisoire restent telles quelles (désignation et montant prévu),
// on saisit le montant réel en face ; les dépenses imprévues sont ajoutées en nouvelles lignes (prévu = 0).
export function buildReelItems(provItemsJson: string | null, objet: string, montantProv: number, body: any) {
  let prov: any[] = [];
  try { prov = provItemsJson ? JSON.parse(provItemsJson) : []; } catch { prov = []; }
  if (!prov.length) prov = [{ designation: objet, montant: montantProv }];
  const toNum = (v: any) => { const n = parseFloat(String(v ?? "").replace(/\s/g, "").replace(",", ".")); return isNaN(n) ? 0 : n; };
  const arr = (v: any) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
  const reels = arr(body.reel);
  const items: any[] = prov.map((it: any, i: number) => ({
    designation: String(it.designation || objet), prevu: toNum(it.montant), montant: toNum(reels[i]), source: "PROVISOIRE",
  }));
  const newDes = arr(body.new_designation), newMont = arr(body.new_montant), newKey = arr(body.new_key);
  newDes.forEach((d: any, i: number) => {
    const designation = String(d || "").trim();
    const montant = toNum(newMont[i]);
    if (designation && montant > 0) items.push({ designation, prevu: 0, montant, source: "NOUVEAU", key: newKey[i] });
  });
  // Ancien formulaire (items_json complet) : toujours accepté
  if (!reels.length && !newDes.length && body.items_json) {
    try {
      const parsed = JSON.parse(body.items_json);
      if (Array.isArray(parsed) && parsed.length) return parsed.map((it: any) => ({ designation: it.designation, montant: toNum(it.montant), prevu: toNum(it.prevu), source: it.source || "NOUVEAU" }));
    } catch {}
  }
  return items;
}

// Les titulaires des visas encore attendus sont prévenus (création, renvoi après modification, bon supplémentaire)
export async function prevenirVisas(b: any, titre: string, texte: string) {
  for (const k of visaProgress(b).missing) await notifyRoles(ROLES_BY_VISA[k], titre, texte, `/bons/visas#bon-${b.id}`);
}

// POST /bons/:id/modifier - Le demandeur corrige un bon rejeté pour modification et le renvoie aux visas
router.post("/bons/:id/modifier", requireAuth, async (req: any, res: any) => {
  const id = parseInt(req.params.id);
  const bon = await prisma.bonProvisoir.findUnique({ where: { id } });
  if (!bon || bon.etat !== "A_MODIFIER") { req.session.error_msg = "Ce bon n'est pas à modifier."; return res.redirect(`/bons/${id}`); }
  if (bon.demandeur_id !== req.session.userId && req.session.user.role !== "super_admin") { req.session.error_msg = "Seul le demandeur corrige son bon."; return res.redirect(`/bons/${id}`); }
  const des = [].concat(req.body.designation || []), mts = [].concat(req.body.montant || []);
  const toNum = (v: any) => parseFloat(String(v ?? "").replace(/[\s\u202f\u00a0]/g, "").replace(",", ".")) || 0;
  const items = des.map((d: any, i: number) => ({ designation: String(d || "").trim(), montant: toNum(mts[i]) })).filter((x) => x.designation && x.montant > 0);
  const total = items.reduce((t, x) => t + x.montant, 0);
  if (!items.length || !(total > 0)) { req.session.error_msg = "Indiquez au moins une ligne avec un montant."; return res.redirect(`/bons/${id}#modifier`); }
  const objet = String(req.body.objet || "").trim() || bon.objet;
  // Les visas repartent de zéro, selon le nouveau montant
  const ticks: any = {};
  for (const k of VISA_KEYS) { ticks[`tick_${k}`] = false; ticks[`tick_${k}_by`] = null; }
  const updated = await prisma.bonProvisoir.update({
    where: { id },
    data: { etat: "EN_ATTENTE", rejet_type: null, objet, montant_demande: total, items_json: JSON.stringify(items), ...ticks, ...initialTicks(bon.type, total) },
  });
  await logActivity(req.session.userId, "BON_MODIFIE_RENVOYE", "BonProvisoir", id);
  await prevenirVisas(updated, `✍️ Bon ${bon.numero} corrigé`, `${objet} · ${total.toLocaleString("fr-FR")} F. Votre visa est de nouveau requis.`);
  await notifyRoles(CAISSE_ROLES, `✏️ Bon ${bon.numero} corrigé`, `Nouveau montant : ${total.toLocaleString("fr-FR")} F. Visas en cours.`, `/bons/${id}`);
  req.session.success_msg = `Bon corrigé (${total.toLocaleString("fr-FR")} F) et renvoyé aux visas.`;
  res.redirect(`/bons/${id}`);
});

// POST /bons/reel - Soumettre un Bon Réel (justification après dépense, dossier ou interne)
router.post("/bons/reel", requireAuth, (req: any, res: any) => {
  uploadJustificatifs(req, res, async function (err: any) {
    try {
      const { bon_provisoir_id, observations } = req.body;
      if (err) {
        req.session.error_msg = `Échec de l'import de pièces justificatives : ${err.message}`;
        return res.redirect("back");
      }
      if (!bon_provisoir_id) {
        req.session.error_msg = "Veuillez préciser le bon de référence.";
        return res.redirect("/dossiers");
      }

      const user = req.session.user;
      const bpId = parseInt(bon_provisoir_id);
      const bonProvisoir = await prisma.bonProvisoir.findUnique({ where: { id: bpId }, include: { bon_reel: true } });
      if (!bonProvisoir) {
        req.session.error_msg = "Bon provisoire introuvable.";
        return res.redirect("/dossiers");
      }
      const isInterne = bonProvisoir.type === "INTERNE" || !bonProvisoir.dossier_id;
      const back = justifyUrl(bonProvisoir);
      // Le demandeur justifie sa propre dépense ; pour un dossier, le terrain (acconage, enlèvement) aussi
      const allowed = user.role === "super_admin" || bonProvisoir.demandeur_id === req.session.userId
        || (!isInterne && ["acconage", "enlevement"].includes(user.role));
      if (!allowed) {
        req.session.error_msg = "Accès refusé : seul le demandeur du bon (ou le service terrain) peut le justifier.";
        return res.redirect(back);
      }
      if (bonProvisoir.etat !== "APPROUVE") {
        req.session.error_msg = "Le bon provisoire doit d'abord être payé par la caisse.";
        return res.redirect(back);
      }
      if (bonProvisoir.bon_reel) {
        req.session.error_msg = `Le bon réel de ${bonProvisoir.numero} a déjà été saisi.`;
        return res.redirect(back);
      }

      const dId = bonProvisoir.dossier_id;
      const montant_provisoir = bonProvisoir.montant_demande;
      const items = buildReelItems(bonProvisoir.items_json, bonProvisoir.objet, montant_provisoir, req.body);
      const computedTotalReel = items.reduce((sum, it) => sum + (it.montant || 0), 0);
      if (!(computedTotalReel > 0)) {
        req.session.error_msg = "Saisissez au moins un montant réel.";
        return res.redirect(back);
      }
      const ecart = montant_provisoir - computedTotalReel;

      // Pièces justificatives : dans le dossier, ou rangées avec le bon pour une dépense interne
      const allFiles = (req.files as Express.Multer.File[] | undefined) || [];
      const filesList = allFiles.filter((f) => RECU_FIELD.test(f.fieldname));
      allFiles.filter((f) => !RECU_FIELD.test(f.fieldname)).forEach((f) => fs.rmSync(f.path, { force: true }));
      if (!filesList.length) {
        req.session.error_msg = "Joignez au moins un reçu (photo ou PDF) pour justifier la dépense.";
        return res.redirect(back);
      }
      if (filesList.length > 20) {
        filesList.forEach((f) => fs.rmSync(f.path, { force: true }));
        req.session.error_msg = "20 reçus au maximum par bon réel.";
        return res.redirect(back);
      }
      // Reçu rattaché à sa ligne : recu_p_<i> pour la i-ème ligne prévue, recu_n_<k> pour une dépense imprévue
      const lineOf = (field: string): number => {
        const m = /^recu_([pn])_(\d+)$/.exec(field);
        if (!m) return -1;
        if (m[1] === "p") { const i = parseInt(m[2]); return items[i] && items[i].source === "PROVISOIRE" ? i : -1; }
        return items.findIndex((it) => it.source === "NOUVEAU" && String(it.key) === m[2]);
      };
      items.forEach((it) => { it.pieces = []; });
      const pieces: { filename: string; original: string; ligne?: string }[] = [];
      const destDir = dId ? path.join(process.cwd(), "uploads", "dossiers", String(dId)) : path.join(process.cwd(), "uploads", "bons", String(bpId));
      if (filesList.length) fs.mkdirSync(destDir, { recursive: true });
      for (const file of filesList) {
        const finalPath = path.join(destDir, file.filename);
        fs.renameSync(file.path, finalPath);
        const li = lineOf(file.fieldname);
        if (li >= 0) items[li].pieces.push(file.filename);
        pieces.push({ filename: file.filename, original: file.originalname, ...(li >= 0 ? { ligne: items[li].designation } : {}) });
        if (dId) {
          await prisma.dossierFile.create({
            data: { dossier_id: dId, user_id: req.session.userId, filename: file.filename, original: file.originalname,
              category: "RECU_PORT", stage: "BON_REEL", comment: `Reçu du bon ${bonProvisoir.numero}${li >= 0 ? " · " + items[li].designation : ""}`, path: finalPath }
          });
        }
      }

      const bonReel = await prisma.bonReel.create({
        data: {
          bon_provisoir_id: bpId,
          dossier_id: dId,
          montant_provisoir,
          montant_reel: computedTotalReel,
          ecart,
          items_json: JSON.stringify(items.map(({ key, ...it }) => it)),
          pieces_json: pieces.length ? JSON.stringify(pieces) : null,
          observations: observations || null,
          soumis_par_id: req.session.userId
        }
      });

      if (dId) {
        await prisma.tache.updateMany({
          where: { dossier_id: dId, titre: `🧾 Régularisation - Bon Provisoire ${bonProvisoir.numero}`, archive: false },
          data: { etat: "FAIT" }
        }).catch(() => {});
      }

      await logActivity(req.session.userId, "BON_REEL_SOUMIS", "BonReel", bonReel.id);
      const rendu = (await dejaRendu([bpId])).get(bpId) || 0;
      const du = Math.round(ecart - rendu);
      // Dépense au-delà de l'avance : un bon supplémentaire part aux visas avant la caisse
      const sup = du < 0 ? await creerBonSupplementaire(bonReel.id, -du, null) : null;
      const sens = (du > 0 ? `${du.toLocaleString("fr-FR")} F à rendre à la caisse` : sup ? `bon supplémentaire ${sup.numero} de ${(-du).toLocaleString("fr-FR")} F envoyé aux visas` : "aucun écart")
        + (rendu > 0 ? `, ${rendu.toLocaleString("fr-FR")} F déjà rendus` : "");
      await notifyRoles([...CAISSE_ROLES, "finances"], `🧾 Bon réel ${bonProvisoir.numero}`, `Dépense réelle ${computedTotalReel.toLocaleString("fr-FR")} F pour ${montant_provisoir.toLocaleString("fr-FR")} F avancés : ${sens}.`, `/bons/${bpId}`);

      const recap = `Bon réel enregistré : ${computedTotalReel.toLocaleString("fr-FR")} F dépensés pour ${montant_provisoir.toLocaleString("fr-FR")} F avancés (${sens}).`;
      if (!dId) {
        req.session.success_msg = recap;
        return res.redirect(`/bons/${bpId}`);
      }
      const missing = await advanceIfJustified(dId);
      if (missing && missing.length) {
        req.session.success_msg = `${recap} Le dossier passera en facturation dès que ces éléments seront là : ${missing.join(", ")}.`;
        return res.redirect(`/dossiers/${dId}#camcis`);
      }
      req.session.success_msg = missing ? `${recap} Le dossier passe en facturation.` : recap;
      res.redirect(`/dossiers/${dId}#finance`);
    } catch (error) {
      console.error("Erreur soumission bon réel :", error);
      res.status(500).render("errors/500", { error });
    }
  });
});

// PATCH /bons/reel/:id/confirmer - La caisse confirme la régularisation (reliquat rendu ou complément payé)
router.patch("/bons/reel/:id/confirmer", requireAuth, async (req: any, res: any) => {
  try {
    const user = req.session.user;
    if (![...CAISSE_ROLES, "super_admin"].includes(user.role)) {
      return res.status(403).json({ ok: false, message: "Accès non autorisé." });
    }

    const bonReelId = parseInt(req.params.id);
    if (!bonReelId) return res.status(404).json({ ok: false, message: "Bon réel introuvable." });
    const r = await regulariser(bonReelId, req.session.userId, { mode: req.body?.mode, reference: (req.body?.reference || "").trim() || null });
    if (!r.ok) return res.status(400).json(r);
    await logActivity(req.session.userId, "FONDS_DECAISSES", "BonReel", bonReelId);
    const msg = r.message;
    res.json({ ok: true, message: `Régularisation confirmée. ${msg}` });
  } catch (error) {
    console.error("Erreur régularisation bon réel :", error);
    res.status(500).json({ ok: false, message: "Erreur serveur de décaissement." });
  }
});

// GET /bons/:id/piece/:filename - Pièce jointe d'un bon interne (devis, reçus)
router.get("/bons/:id/piece/:filename", requireAuth, async (req: any, res: any) => {
  const id = parseInt(req.params.id);
  const name = path.basename(String(req.params.filename));
  const bon = await prisma.bonProvisoir.findUnique({ where: { id }, include: { bon_reel: true } });
  if (!bon) return res.status(404).send("Bon introuvable.");
  const listed = [bon.pieces_json, bon.bon_reel?.pieces_json].some((j) => {
    try { return (JSON.parse(j || "[]") as any[]).some((p) => p.filename === name); } catch { return false; }
  });
  // Rangée avec le bon (dépense interne) ou dans le dossier (bon de dossier)
  const file = [path.join(process.cwd(), "uploads", "bons", String(id), name), ...(bon.dossier_id ? [path.join(process.cwd(), "uploads", "dossiers", String(bon.dossier_id), name)] : [])].find((f) => fs.existsSync(f));
  if (!listed || !file) return res.status(404).send("Pièce introuvable.");
  res.sendFile(file);
});

// Reçu de caisse : visible par la caisse, la direction, la comptabilité, l'audit et le bénéficiaire
const RECU_READ = [...CAISSE_ROLES, "super_admin", "daf", "pdg", "dg", "dga", "comptable", "comptable_ops", "auditeur1", "auditeur2", "finances"];
const uploadRecu = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req: any, file: any, cb: any) => (/pdf|jpe?g|png/i.test(path.extname(file.originalname)) ? cb(null, true) : cb(new Error("Photo (JPG, PNG) ou PDF uniquement."))),
}).single("recu_scan");

// GET /bons/:id/recu - Reçu de caisse imprimable (deux exemplaires : bénéficiaire et souche de la caisse)
router.get("/bons/:id/recu", requireAuth, async (req: any, res: any) => {
  const id = parseInt(req.params.id);
  const u = req.session.user;
  const bon = await prisma.bonProvisoir.findUnique({
    where: { id },
    include: { demandeur: true, dossier: { select: { id: true, numero: true, numero_ordre: true, client: { select: { nom: true } } } }, mouvements: { where: { sens: "SORTIE" }, orderBy: { id: "asc" }, take: 1 } },
  });
  if (!bon || bon.etat !== "APPROUVE") return res.status(404).send("Ce bon n'est pas encore payé : pas de reçu.");
  if (!RECU_READ.includes(u.role) && bon.demandeur_id !== u.id) return res.status(403).send("Accès refusé.");
  const numero = bon.recu_numero || (await attribuerRecu(bon.id, bon.paye_at || undefined));
  res.render("bons/recu", { bon, numero, enLettres, origine: ORIGINES.find((o) => o.key === origineDe(bon)), sousCat: sousCategorie(bon), canWrite: [...CAISSE_ROLES, "super_admin"].includes(u.role), print: req.query.print === "1", saved: req.query.ok === "1", erreur: res.locals.error_msg || "" });
});

// POST /bons/:id/recu - La caisse saisit le n° du reçu papier signé, et peut joindre sa photo
router.post("/bons/:id/recu", requireAuth, (req: any, res: any) => {
  uploadRecu(req, res, async (err: any) => {
    const id = parseInt(req.params.id);
    const back = String(req.body?.back || "").startsWith("/") ? String(req.body.back) : `/bons/${id}/recu`;
    const u = req.session.user;
    const fail = (msg: string) => { if (req.file) fs.rmSync(req.file.path, { force: true }); req.session.error_msg = msg; res.redirect(back); };
    if (err) return fail(err.message);
    if (![...CAISSE_ROLES, "super_admin"].includes(u.role)) return fail("Seule la caisse enregistre le reçu signé.");
    const bon = await prisma.bonProvisoir.findUnique({ where: { id }, select: { id: true, etat: true, recu_scan: true } });
    if (!bon || bon.etat !== "APPROUVE") return fail("Ce bon n'est pas payé.");
    const papier = String(req.body?.recu_papier || "").trim().slice(0, 60);
    if (!papier && !req.file) return fail("Saisissez le n° du reçu signé.");
    const data: any = { recu_saisi_par: `${u.prenom || ""} ${u.nom}`.trim(), recu_saisi_at: new Date() };
    if (papier) data.recu_papier = papier;
    if (req.file) {
      const dir = path.join(process.cwd(), "uploads", "bons", String(id));
      fs.mkdirSync(dir, { recursive: true });
      const name = `recu-signe-${Date.now()}${path.extname(req.file.originalname).toLowerCase()}`;
      fs.renameSync(req.file.path, path.join(dir, name));
      data.recu_scan = name;
    }
    await prisma.bonProvisoir.update({ where: { id }, data });
    await logActivity(req.session.userId, "RECU_SIGNE_SAISI", "BonProvisoir", id);
    req.session.success_msg = "Reçu signé enregistré.";
    res.redirect(back === `/bons/${id}/recu` ? back + "?ok=1" : back);
  });
});

// GET /bons/:id/recu/scan - Photo du reçu signé
router.get("/bons/:id/recu/scan", requireAuth, async (req: any, res: any) => {
  const id = parseInt(req.params.id);
  const u = req.session.user;
  const bon = await prisma.bonProvisoir.findUnique({ where: { id }, select: { recu_scan: true, demandeur_id: true } });
  if (!bon?.recu_scan || (!RECU_READ.includes(u.role) && bon.demandeur_id !== u.id)) return res.status(404).send("Reçu introuvable.");
  const file = path.join(process.cwd(), "uploads", "bons", String(id), path.basename(bon.recu_scan));
  if (!fs.existsSync(file)) return res.status(404).send("Fichier introuvable.");
  res.sendFile(file);
});

// GET /bons/:id - Detail d'un bon d'opération
router.get("/bons/:id", requireAuth, async (req: any, res: any) => {
  try {
    const id = parseInt(req.params.id);
    const bon = await prisma.bonProvisoir.findUnique({
      where: { id },
      include: {
        dossier: { include: { client: { select: { nom: true } } } },
        demandeur: true,
        mouvements: { orderBy: { date: "asc" } },
        approver: true,
        bon_reel: {
          include: {
            soumis_par: true,
            confirme_par: true
          }
        }
      }
    });

    if (!bon) {
      req.session.error_msg = "Bon d'opération introuvable.";
      return res.redirect("/dashboard");
    }

    const u = req.session.user;
    const supplement = await prisma.bonProvisoir.findFirst({ where: { bon_parent_id: bon.id }, select: { id: true, numero: true, montant_demande: true }, orderBy: { id: "desc" } });
    res.render("bons/detail", {
      bon, supplement,
      isCaisse: [...CAISSE_ROLES, "super_admin"].includes(u.role),
      canOrder: [...ORDRE_ROLES, "super_admin"].includes(u.role),
      visaProgress, payable, bonTitle, categorieLabel, VISA_KEYS, VISA_LABELS, holders: await visaHolders(),
      title: `Détail du Bon ${bon.numero}`,
      path: "/bons",
      error_msg: req.session.error_msg || res.locals.error_msg || "",
      success_msg: req.session.success_msg || res.locals.success_msg || ""
    });
    req.session.error_msg = null;
    req.session.success_msg = null;
  } catch (error) {
    console.error("Erreur detail bon :", error);
    res.status(500).render("errors/500", { error });
  }
});

// POST /bons/provisoir/:id/tick - Cocher/Décocher un visa du top management
router.post("/bons/provisoir/:id/tick", requireAuth, async (req: any, res: any) => {
  try {
    const user = req.session.user;
    const allowedRoles = ["direction", "super_admin", "pdg", "dg", "dga", "daf", "auditeur1", "auditeur2"];
    if (!allowedRoles.includes(user.role)) {
      return res.status(403).json({ ok: false, message: "Accès refusé. Réservé à la Direction." });
    }

    const bonId = parseInt(req.params.id);
    const tick = req.body.tick || req.body.tick_key; // Support both format variants
    if (!["pdg", "dg", "dga", "daf", "audit"].includes(tick)) {
      return res.status(400).json({ ok: false, message: `Type de visa invalide ou absent (${tick}).` });
    }

    // Role-specific check: Standard user can only toggle their own visa
    if (user.role !== "super_admin") {
      const isPDGAllowed = (tick === "pdg" && user.role === "pdg");
      const isDGAllowed = (tick === "dg" && user.role === "dg");
      const isDGAAllowed = (tick === "dga" && user.role === "dga");
      const isDAFAllowed = (tick === "daf" && user.role === "daf");
      const isAuditAllowed = (tick === "audit" && (user.role === "auditeur1" || user.role === "auditeur2"));

      if (!isPDGAllowed && !isDGAllowed && !isDGAAllowed && !isDAFAllowed && !isAuditAllowed) {
        return res.status(403).json({
          ok: false,
          message: `Vous n'êtes pas autorisé à signer le ${tick.toUpperCase()}. Seul le titulaire désigné de cette fonction ou un Super Administrateur peut le faire.`
        });
      }
    }

    const bon = await prisma.bonProvisoir.findUnique({
      where: { id: bonId },
      include: { demandeur: true, dossier: { select: { numero: true } } }
    });
    if (!bon) {
      return res.status(404).json({ ok: false, message: "Bon provisoire introuvable." });
    }
    if (bon.etat !== "EN_ATTENTE") {
      return res.status(400).json({ ok: false, message: `Ce bon n'est plus en attente (état : ${bon.etat}).` });
    }
    if ((bon as any)[`tick_${tick}_by`] === NON_REQUIS) {
      return res.status(400).json({ ok: false, message: `Le visa ${tick.toUpperCase()} n'est pas requis pour ce bon.` });
    }

    // Bon interne : le PDG vise après le DAF
    const avant = VISA_AVANT[tick as VisaKey];
    if (bon.type === "INTERNE" && avant && !(bon as any)[`tick_${tick}`] && !(bon as any)[`tick_${avant}`]) {
      return res.status(400).json({ ok: false, message: `Le ${VISA_LABELS[avant]} vise d'abord cette dépense interne.` });
    }

    const field = `tick_${tick}`;
    const byField = `tick_${tick}_by`;
    const currentValue = (bon as any)[field];
    const newValue = !currentValue;

    const updateData: any = {};
    updateData[field] = newValue;
    updateData[byField] = newValue ? `${user.nom} ${user.prenom || ""}` : null;

    const updatedBon = await prisma.bonProvisoir.update({
      where: { id: bonId },
      data: updateData
    });

    const allApproved = allVisas(updatedBon);

    // La caisse et le demandeur suivent chaque visa en direct
    const prog = visaProgress(updatedBon);
    const qui = `${user.prenom || ""} ${user.nom}`.trim();
    const reste = prog.missing.length ? `Reste : ${prog.missing.map((k) => VISA_LABELS[k]).join(", ")}.` : "Tous les visas sont là : prêt à payer.";
    const titre = newValue ? `✍️ Visa ${VISA_LABELS[tick as keyof typeof VISA_LABELS]} sur ${updatedBon.numero}` : `↩️ Visa ${VISA_LABELS[tick as keyof typeof VISA_LABELS]} retiré sur ${updatedBon.numero}`;
    const contenu = `${qui} · ${bonTitle(bon)} · ${prog.count}/${prog.total} visas. ${reste}`;
    await notifyRoles(CAISSE_ROLES, allApproved ? `💵 Bon ${updatedBon.numero} prêt à payer` : titre, contenu, `/bons/provisoir/pending#bon-${bonId}`);
    if (bon.demandeur_id !== req.session.userId) await notifyUser(bon.demandeur_id, titre, contenu, `/bons/${bonId}`);
    // Après le DAF, le PDG est appelé ; une dépense interne validée est signalée au DG
    if (newValue && bon.type === "INTERNE" && tick === "daf" && !updatedBon.tick_pdg) await notifyRoles(ROLES_BY_VISA.pdg, `✍️ Dépense interne à viser : ${updatedBon.numero}`, `Le DAF a visé. ${bonTitle(bon)} · ${updatedBon.montant_demande.toLocaleString("fr-FR")} F.`, `/bons/visas#bon-${bonId}`);
    if (allApproved && bon.type === "INTERNE") await notifyRoles(INTERNE_INFORMES, `ℹ️ Dépense interne validée : ${updatedBon.numero}`, `${bon.demandeur.prenom || ""} ${bon.demandeur.nom} · ${updatedBon.objet} · ${updatedBon.montant_demande.toLocaleString("fr-FR")} F. Visée par le DAF, le PDG et l'audit.`, `/bons/${bonId}`);

    if (allApproved && updatedBon.dossier_id) {
      try {
        // Complete current direction visa task
        await prisma.tache.updateMany({
          where: { dossier_id: updatedBon.dossier_id!, titre: `✍️ Visa requis - Bon Provisoire ${updatedBon.numero}`, archive: false },
          data: { etat: "FAIT" }
        });
        
        // Create new cashier decaissement task
        await createAutoTask(updatedBon.dossier_id!, `💵 Décaissement - Bon Provisoire ${updatedBon.numero}`, `Tous les visas obligatoires de Direction ont été obtenus. Ce bon est désormais prêt pour décaissement de fonds physiques à la Caisse.`, "agent_payeur");
      } catch (tError) {
        console.error("Erreur mise à jour tâches lors de l'approbation globale :", tError);
      }
    }

    await logActivity(
      req.session.userId, 
      `VISA_${tick.toUpperCase()}_${newValue ? "APPLIQUE" : "RETIRE"}`, 
      "BonProvisoir", 
      bonId
    );

    res.json({ 
      ok: true, 
      allApproved, 
      bon: updatedBon,
      message: `Visa ${tick.toUpperCase()} mis à jour.` 
    });
  } catch (error) {
    console.error("Erreur visa top management :", error);
    res.status(500).json({ ok: false, message: "Erreur de mise à jour du visa." });
  }
});

// GET /bons/:id/pdf - Télécharger/consulter le PDF du bon de décaissement
router.get("/bons/:id/pdf", requireAuth, async (req: any, res: any) => {
  try {
    const id = parseInt(req.params.id);
    const bon = await prisma.bonProvisoir.findUnique({
      where: { id },
      include: {
        dossier: {
          include: { client: true }
        },
        demandeur: true,
        approver: true,
        bon_reel: {
          include: {
            soumis_par: true,
            confirme_par: true
          }
        }
      }
    });

    if (!bon) {
      req.session.error_msg = "Bon d'opération introuvable.";
      return res.redirect("/dashboard");
    }

    // Chercher le responsable du service correspondant (par son rôle)
    let serviceLabel = "Département Opérations";
    let responsableNom = "Yannick Abega (Admin)";

    if (bon.service === "acconage") {
      serviceLabel = "Service d'Acconage & Manutention";
      const resp = await prisma.user.findFirst({ where: { role: "acconage" } });
      if (resp) {
        responsableNom = `${resp.prenom || ""} ${resp.nom}`.trim();
      } else {
        responsableNom = "Responsable Acconage";
      }
    } else if (bon.service === "enlevement") {
      serviceLabel = "Service d'Enlèvement & Livraison";
      const resp = await prisma.user.findFirst({ where: { role: "enlevement" } });
      if (resp) {
        responsableNom = `${resp.prenom || ""} ${resp.nom}`.trim();
      } else {
        responsableNom = "Responsable Enlèvement";
      }
    } else if (bon.service === "super_admin" || bon.service === "admin") {
      serviceLabel = "Direction des Opérations";
      responsableNom = "Yannick Abega (Directeur Général)";
    }

    // Set content attachment header
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="BON-${bon.numero}.pdf"`);

    const doc = pdfSafe(new PDFDocument({ margin: 50, size: "A4" }));
    doc.pipe(res);

    // Header
    doc.fillColor("#0F172A").fontSize(18).text("YM-TRANSIT ERP", { align: "center" });
    doc.fontSize(10).fillColor("#475569").text("Transit & Douane • Cameroun Port Autonome de Douala", { align: "center" });
    doc.moveDown(1.5);

    // Line separator
    doc.strokeColor("#E2E8F0").lineWidth(1).moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(1.5);

    // Title Block
    doc.fillColor("#065f46").fontSize(14).text(`BON PROVISOIRE DE DECAISSEMENT : ${bon.numero}`, { align: "center", underline: true });
    if (bon.urgent) { doc.moveDown(0.3); doc.fillColor("#DC2626").fontSize(12).text("URGENT", { align: "center" }); }
    doc.moveDown(1);

    // Metadata section (Grid layout via coordinates)
    const startY = doc.y;
    doc.fillColor("#334155").fontSize(10);
    
    doc.text(bon.dossier ? `Dossier N°:` : `Type :`, 50, startY);
    doc.fillColor("#0F172A").text(bon.dossier ? `${bon.dossier.numero}` : "Dépense interne", 160, startY);

    doc.fillColor("#334155").text(bon.dossier ? `Client :` : `Catégorie :`, 50, startY + 15);
    doc.fillColor("#0F172A").text(bon.dossier ? `${bon.dossier.client.nom}` : categorieLabel(bon.categorie), 160, startY + 15);

    doc.fillColor("#334155").text(`Émetteur :`, 50, startY + 30);
    doc.fillColor("#0F172A").text(`${bon.demandeur.prenom || ""} ${bon.demandeur.nom}`, 160, startY + 30);

    doc.fillColor("#334155").text(`Service Émetteur :`, 50, startY + 45);
    doc.fillColor("#0F172A").text(`${serviceLabel}`, 160, startY + 45);

    doc.fillColor("#334155").text(`Responsable Service :`, 50, startY + 60);
    doc.fillColor("#0F172A").text(`${responsableNom}`, 160, startY + 60);

    doc.fillColor("#334155").text(bon.dossier ? `Objet :` : `Raison du bon :`, 50, startY + 75);
    doc.fillColor("#0F172A").text(`${bon.objet}`, 160, startY + 75, { width: 175 });

    doc.fillColor("#334155").text(`Date Émission :`, 340, startY);
    doc.fillColor("#0F172A").text(`${new Date(bon.created_at).toLocaleDateString("fr-FR")}`, 445, startY);

    doc.fillColor("#334155").text(`État Actuel :`, 340, startY + 15);
    doc.fillColor("#065f46").text(`${bon.etat}`, 445, startY + 15);

    doc.fillColor("#334155").text(`Total Demandé :`, 340, startY + 30);
    doc.fillColor("#065f46").text(`${bon.montant_demande.toLocaleString("fr-FR")} F CFA`, 445, startY + 30);

    if (bon.dossier) {
      doc.fillColor("#334155").text(`BL :`, 340, startY + 45);
      doc.fillColor("#0F172A").text(`${bon.dossier.bl || "—"}`, 445, startY + 45, { width: 100 });
      doc.fillColor("#334155").text(`Marchandise :`, 340, startY + 60);
      doc.fillColor("#0F172A").text(`${bon.dossier.contenu || "—"}`, 445, startY + 60, { width: 100, height: 14, ellipsis: true });
    }
    doc.fillColor("#334155").text(`Urgence :`, 340, bon.dossier ? startY + 75 : startY + 45);
    doc.fillColor(bon.urgent ? "#DC2626" : "#0F172A").text(bon.urgent ? "URGENT" : "Non urgent", 445, bon.dossier ? startY + 75 : startY + 45);

    doc.moveDown(6.5);

    // Itemized Details Table
    doc.fillColor("#0F172A").fontSize(12).text("Détails des imputations et charges demandées", 50, doc.y, { underline: true });
    doc.moveDown(0.5);

    // Table Header
    let currentY = doc.y;
    doc.rect(50, currentY, 495, 20).fill("#F1F5F9");
    doc.fillColor("#334155").fontSize(9);
    doc.text("Désignation des dépenses", 60, currentY + 6);
    doc.text("Montant demandé", 430, currentY + 6, { width: 100, align: "right" });
    doc.moveDown(1.5);

    // Table Rows
    let itemsList = [];
    if (bon.items_json) {
      try {
        itemsList = JSON.parse(bon.items_json);
      } catch (err) {}
    } else {
      itemsList = [{ designation: bon.objet, montant: bon.montant_demande }];
    }

    currentY = doc.y;
    itemsList.forEach((it: any) => {
      doc.text(it.designation, 60, currentY + 6);
      doc.text(`${(it.montant || 0).toLocaleString("fr-FR")} F CFA`, 430, currentY + 6, { width: 100, align: "right" });
      currentY += 20;
    });

    // Total Row
    doc.rect(50, currentY, 495, 20).fill("#E2E8F0");
    doc.fillColor("#0F172A").fontSize(10);
    doc.text("TOTAL GENERAL", 60, currentY + 5);
    doc.text(`${bon.montant_demande.toLocaleString("fr-FR")} F CFA`, 430, currentY + 5, { width: 100, align: "right" });

    doc.moveDown(3);

    // Signature control checklist box (Top management controls)
    doc.fontSize(11).text("Contrôles réglementaires et Visas du Top Management", 50, doc.y, { underline: true });
    doc.moveDown(0.5);

    currentY = doc.y;
    // We draw a compact block with the ticks status
    doc.rect(50, currentY, 495, 75).strokeColor("#CBD5E1").lineWidth(1).stroke();

    doc.fontSize(9).fillColor("#334155");
    
    // Ticks drawing
    const drawTick = (label: string, isChecked: boolean, by: string | null, x: number, y: number) => {
      doc.rect(x, y, 10, 10).strokeColor("#334155").lineWidth(1).stroke();
      if (isChecked) {
        doc.fillColor("#10B981").text("X", x + 2, y + 1);
      }
      doc.fillColor("#334155").text(label, x + 15, y + 1);
      if (by) {
        doc.fillColor("#64748B").fontSize(7).text(`Par: ${by}`, x + 15, y + 12);
        doc.fontSize(9);
      }
    };

    if (bon.ordre_paiement_by) {
      doc.fillColor("#b45309").fontSize(8).text(`Ordre de paiement : ${bon.ordre_paiement_by}${bon.ordre_paiement_at ? " le " + new Date(bon.ordre_paiement_at).toLocaleDateString("fr-FR") : ""}`, 65, currentY + 64);
      doc.fontSize(9);
    }
    drawTick("Visa PDG (Président DG)", bon.tick_pdg, bon.tick_pdg_by, 65, currentY + 15);
    drawTick("Visa DG (Directeur Gén.)", bon.tick_dg, bon.tick_dg_by, 220, currentY + 15);
    drawTick("Visa DGA (Directeur GA)", bon.tick_dga, bon.tick_dga_by, 380, currentY + 15);
    drawTick("Visa DAF (Finances)", bon.tick_daf, bon.tick_daf_by, 140, currentY + 45);
    drawTick("Visa Audit Interne", bon.tick_audit, bon.tick_audit_by, 300, currentY + 45);

    doc.moveDown(5);

    // Footer signature spaces
    currentY = doc.y;
    if (currentY > 700) {
      doc.addPage();
      currentY = 50;
    }
    doc.fontSize(10).fillColor("#475569");
    doc.text("Signature du demandeur", 50, currentY, { align: "left" });
    doc.text("Signature de l'Ordonnateur", 350, currentY, { align: "right" });

    // End stream
    doc.end();
  } catch (error) {
    console.error("Erreur génération PDF bon :", error);
    res.status(500).send("Erreur de génération de l'imprimé PDF.");
  }
});

export default router;
