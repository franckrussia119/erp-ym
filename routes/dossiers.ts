import { banquesActives } from "../lib/banques";
import { attribuerOrdre, lireArticles, memoriserCodes, parseArticles } from "../lib/validation";
import { Router } from "express";
import { dossierRef, uniqueDossierRef } from "../lib/dossierName";
import multer from "multer";
import path from "path";
import fs from "fs" ;
import crypto from "crypto";
import { requireAuth, requireModule } from "./rbac";
import prisma from "../lib/prismaClient";
import { missingRequirements, requirementStatus, dossierFinance, hoursLate, stepOf, DOC_CATEGORIES, STAGE_ACTORS, PREVIOUS_STEP } from "../lib/pipeline";
import { generateRef } from "../lib/generateRef";
import { chatFeed, chatMembers, notifyChat, markChatSeen, attKind, parseJson } from "../lib/dossierChat";
import { liveEmit } from "../lib/live";
import { attribuerNumero } from "../lib/numeroDossier";

const router = Router();

// Protéger toutes les routes de ce fichier avec la restriction de module dossiers
router.use(requireAuth, requireModule("dossiers"));

// Config Multer pour gestion des pièces jointes dossiers
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const id = req.params.id;
    const dir = path.join(process.cwd(), "uploads", "dossiers", id);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename: function (req, file, cb) {
    // Nom propre sécurisé pour éviter tout conflit
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const cleanedName = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, "_");
    cb(null, `${uniqueSuffix}-${cleanedName}`);
  }
});

const upload = multer({
  storage: storage,
  fileFilter: (req: any, file: any, cb: any) => {
    // PDF, JPG, JPEG, PNG
    const filetypes = /pdf|jpg|jpeg|png/i;
    const mimetype = filetypes.test(file.mimetype);
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error("Seuls les formats PDF, JPG, JPEG et PNG sont acceptés !"));
  },
  limits: { fileSize: 20 * 1024 * 1024 } // 20MB
});

// Setup specialized Multer for initial 3-section creation document upload
const dossierTempDir = path.join(process.cwd(), "uploads", "dossiers", "temp");
if (!fs.existsSync(dossierTempDir)) {
  fs.mkdirSync(dossierTempDir, { recursive: true });
}

const dossierCreateUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, dossierTempDir);
    },
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
      const cleanedName = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, "_");
      cb(null, `${uniqueSuffix}-${cleanedName}`);
    }
  }),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req: any, file: any, cb: any) => {
    const filetypes = /pdf|jpg|jpeg|png/i;
    const mimetype = filetypes.test(file.mimetype);
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error("Seuls les formats PDF, JPG, JPEG et PNG sont acceptés !"));
  }
});

// Helper de log
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
    console.error("Erreur log dossiers route :", error);
  }
}

// GET /dossiers - Index (liste complète avec recherche Javascript client-side et dropdowns)
router.get("/dossiers", requireAuth, async (req: any, res: any) => {
  try {
    const { client_id, etat, pipeline_status } = req.query;
    const user = req.session.user;
    const userRole = (user?.role || "").trim().toLowerCase();

    const vue = req.query.vue === "board" ? "board" : req.query.vue === "liste" ? "liste" : "";

    // CHANGE 1 - If user is secretariat/secretaire, render their dedicated control panel
    if ((userRole === "secretariat" || userRole === "secretaire") && !vue && !client_id && !etat && !pipeline_status) {
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

      const [monthDossiersCount, dossiersCreeCount, totalClients, recentDossiers] = await Promise.all([
        prisma.dossier.count({
          where: {
            created_by: req.session.userId,
            created_at: { gte: startOfMonth },
            numero_ordre: { not: null }
          }
        }),
        prisma.dossier.count({
          where: {
            created_by: req.session.userId,
            pipeline_status: "CREE"
          }
        }),
        prisma.client.count(),
        prisma.dossier.findMany({
          where: {
            created_by: req.session.userId
          },
          include: {
            client: true,
            representant_obj: true,
            _count: { select: { files: true } }
          },
          orderBy: {
            created_at: "desc"
          },
          take: 5
        })
      ]);

      return res.render("dossiers/secretariat-workspace", {
        monthDossiersCount,
        dossiersCreeCount,
        totalClients,
        recentDossiers,
        user,
        title: "Espace Secrétariat — Bonjour " + user.nom
      });
    }

    const filterObj: any = {};
    if (client_id) {
      filterObj.client_id = parseInt(client_id);
    }
    if (etat) {
      filterObj.etat = etat;
    }
    if (pipeline_status) {
      filterObj.pipeline_status = String(pipeline_status);
    }

    const [dossiers, clients] = await Promise.all([
      prisma.dossier.findMany({
        where: filterObj,
        include: {
          client: {
            include: {
              client_representants: {
                include: {
                  representant: true
                }
              }
            }
          },
          representant_obj: true,
          taches: true,
          _count: { select: { files: true, conteneurs: true } }
        },
        orderBy: {
          created_at: "desc",
        },
        ...(vue === "board" && !pipeline_status ? { where: { ...filterObj, pipeline_status: { not: "ARCHIVE" } } } : {}),
      }),
      prisma.client.findMany({ orderBy: { nom: "asc" } }),
    ]);

    res.render("dossiers/index", {
      dossiers,
      clients,
      selectedClientId: client_id || "",
      selectedEtat: etat || "",
      selectedStage: pipeline_status || "",
      vue: vue || "liste",
      lateOf: (d: any) => hoursLate(d),
      title: "Gestion des Dossiers de Transit",
    });
  } catch (error) {
    console.error("Erreur listing dossiers :", error);
    res.status(500).send("Erreur lors de la récupération des dossiers.");
  }
});

// GET /dossiers/liste - Secretariat's complete list of dossiers (or all for other roles)
router.get("/dossiers/liste", requireAuth, async (req: any, res: any) => {
  try {
    const user = req.session.user;
    const userRole = (user?.role || "").trim().toLowerCase();

    const filterObj: any = {};
    if (userRole === "secretariat" || userRole === "secretaire") {
      filterObj.created_by = req.session.userId;
    }

    const [dossiers, clients] = await Promise.all([
      prisma.dossier.findMany({
        where: filterObj,
        include: {
          client: {
            include: {
              client_representants: {
                include: {
                  representant: true
                }
              }
            }
          },
          taches: true,
          _count: { select: { files: true } }
        },
        orderBy: {
          created_at: "desc",
        },
      }),
      prisma.client.findMany({ orderBy: { nom: "asc" } }),
    ]);

    res.render("dossiers/index", {
      dossiers,
      clients,
      selectedClientId: "",
      selectedEtat: "",
      title: "Mes Dossiers — Liste complète",
    });
  } catch (error) {
    console.error("Erreur GET /dossiers/liste :", error);
    res.status(500).send("Erreur lors de la récupération de la liste des dossiers.");
  }
});

// GET /archives & GET /dossiers/archives - Liste des dossiers archivés définitivement
const handleGetArchives = async (req: any, res: any) => {
  try {
    const dossiers = await prisma.dossier.findMany({
      where: {
        pipeline_status: "ARCHIVE"
      },
      include: {
        client: {
          include: {
            client_representants: {
              include: {
                representant: true
              }
            }
          }
        },
        representant_obj: true,
        taches: true
      },
      orderBy: {
        archived_at: "desc"
      }
    });

    res.render("dossiers/archives", {
      dossiers,
      title: "Archives des dossiers",
    });
  } catch (error) {
    console.error("Erreur listing archives :", error);
    res.status(500).send("Erreur lors de la récupération des archives d'expédition.");
  }
};

router.get("/archives", requireAuth, handleGetArchives);
router.get("/dossiers/archives", requireAuth, handleGetArchives);

// GET /dossiers/create - Formulaire de création de dossiers
router.get("/dossiers/create", requireAuth, async (req: any, res: any) => {
  try {
    const user = req.session.user;
    const userRole = (user?.role || "").trim().toLowerCase();
    if (userRole !== "secretariat" && userRole !== "secretaire" && userRole !== "super_admin") {
      req.session.error_msg = "Accès non autorisé : seul le secrétariat administratif (ou le Super Administrateur) peut ouvrir un nouveau dossier.";
      return res.redirect("/dossiers");
    }

    const clients = await prisma.client.findMany({ orderBy: { nom: "asc" } });
    res.render("dossiers/create", {
      clients,
      title: "Créer un Dossier de Transit",
    });
  } catch (error) {
    console.error("Erreur init formulaire dossier :", error);
    res.status(500).send("Erreur d'initialisation du formulaire.");
  }
});

// Conteneurs saisis dans le formulaire (JSON) : numéros normalisés, sans doublon
function parseConteneurs(body: any): { numero: string; type: string | null; scelle: string | null }[] {
  let list: any[] = [];
  try { list = JSON.parse(body.conteneurs_json || "[]"); } catch { list = []; }
  const seen = new Set<string>();
  const out: { numero: string; type: string | null; scelle: string | null }[] = [];
  for (const c of Array.isArray(list) ? list : []) {
    const numero = String(c?.numero || "").replace(/[\s-]/g, "").toUpperCase().slice(0, 20);
    if (!numero || seen.has(numero)) continue;
    seen.add(numero);
    out.push({ numero, type: c?.type ? String(c.type).slice(0, 20) : null, scelle: c?.scelle ? String(c.scelle).trim().slice(0, 40) || null : null });
  }
  return out;
}
function countContainers(list: { type: string | null }[]) {
  const is20 = (t: string | null) => /^(20|REEFER20)$/.test(t || "");
  return { conteneurs_20: list.filter((c) => is20(c.type)).length, conteneurs_40: list.filter((c) => !is20(c.type)).length };
}

// POST /dossiers/:id/conteneurs - Mise à jour de la liste des conteneurs
router.post("/dossiers/:id/conteneurs", requireAuth, async (req: any, res: any) => {
  const id = parseInt(req.params.id);
  if (![...STAGE_ACTORS.CREE, "guce", "validation", "acconage", "enlevement"].includes(req.session.user?.role)) {
    req.session.error_msg = "Rôle non autorisé pour modifier les conteneurs.";
    return res.redirect(`/dossiers/${id}`);
  }
  const list = parseConteneurs(req.body);
  await prisma.$transaction([
    prisma.conteneur.deleteMany({ where: { dossier_id: id } }),
    prisma.conteneur.createMany({ data: list.map((c) => ({ ...c, dossier_id: id })) }),
    prisma.dossier.update({ where: { id }, data: countContainers(list) }),
  ]);
  await logActivity(req.session.userId, "CONTENEURS_MAJ", "Dossier", `${id} - ${list.length} conteneur(s)`);
  req.session.success_msg = `${list.length} conteneur(s) enregistré(s).`;
  res.redirect(`/dossiers/${id}#conteneurs`);
});

// POST /dossiers/create - Enregistrement d'un dossier
router.post(
  "/dossiers/create",
  requireAuth,
  dossierCreateUpload.fields([
    { name: "fichier_bl",   maxCount: 1 },
    { name: "fichier_fac",  maxCount: 1 },
    { name: "fichier_sgs",  maxCount: 1 },
    { name: "fichier_di",   maxCount: 1 },
    { name: "fichier_besc", maxCount: 1 },
    { name: "fichier_anor", maxCount: 1 }
  ]),
  async (req: any, res: any) => {
    try {
      const user = req.session.user;
      const userRole = (user?.role || "").trim().toLowerCase();
      if (userRole !== "secretariat" && userRole !== "secretaire" && userRole !== "super_admin") {
        req.session.error_msg = "Accès non autorisé : seul le secrétariat administratif (ou le Super Administrateur) peut créer un nouveau dossier.";
        return res.redirect("/dossiers");
      }

      const {
        client_id, numero, port, nature, etat,
        bl, ref_bl,
        fac_numero, ref_fac,
        sgs_numero, ref_sgs,
        di_numero, ref_di,
        besc_numero, ref_besc,
        anor_numero, ref_anor,
        contenu, droits_douane, validation, valeur_douane, representant, representant_id,
        comment_client, comment_douane, comment_fisc,
        fournisseur_nom, fournisseur_pays, transporteur
      } = req.body;

      const normalized_bl = (bl || ref_bl || "").trim();
      const normalized_fac = (fac_numero || ref_fac || "").trim();
      const normalized_sgs = (sgs_numero || ref_sgs || "").trim();
      const normalized_di = (di_numero || ref_di || "").trim();
      const normalized_besc = (besc_numero || ref_besc || "").trim();
      const normalized_anor = (anor_numero || ref_anor || "").trim();

      if (!client_id || !port || !nature || !normalized_bl || !String(contenu || "").trim()) {
        req.session.error_msg = "Veuillez remplir tous les champs obligatoires (*) : client, BL et contenu.";
        return res.redirect("/dossiers/create");
      }
      const valeurCaf = parseFloat(String(valeur_douane ?? "").replace(/[\s\u00a0\u202f]/g, "").replace(",", "."));
      if (!(valeurCaf > 0)) {
        req.session.error_msg = "Indiquez la valeur CAF (coût, assurance, fret) en FCFA : elle est obligatoire.";
        return res.redirect("/dossiers/create");
      }

      const clientIdParsed = parseInt(client_id);
      const parsedRepId = representant_id ? parseInt(representant_id) : null;
      const client = await prisma.client.findUnique({ where: { id: clientIdParsed }, select: { nom: true } });
      if (!client) {
        req.session.error_msg = "Client introuvable.";
        return res.redirect("/dossiers/create");
      }

      // Référence du dossier : nom du client + BL (ex. SOFOMEUTEX-2548956656), une saisie manuelle reste possible
      const numeroFinal = await uniqueDossierRef(
        String(numero || "").trim() || dossierRef(client.nom, normalized_bl),
        async (ref) => !!(await prisma.dossier.findUnique({ where: { numero: ref }, select: { id: true } })),
      );

      const rawDroits = parseFloat(String(droits_douane ?? "").replace(/[\s\u00a0\u202f]/g, "").replace(",", "."));
      const rawValeur = valeurCaf;
      const parsedDroits = (droits_douane && !isNaN(rawDroits)) ? rawDroits : null;
      const parsedValeur = (valeur_douane && !isNaN(rawValeur)) ? rawValeur : null;
      const validationBool = (validation === 'true' || validation === true || validation === 'on');

      const newDossier = await prisma.dossier.create({
        data: {
          client_id: clientIdParsed,
          numero: numeroFinal,
          port: port,
          nature: nature,
          bl: normalized_bl,
          etat: etat || "OUVERT",
          contenu: String(contenu).trim(),
          droits_douane: parsedDroits,
          validation: validationBool,
          valeur_douane: parsedValeur,
          representant_id: parsedRepId,
          representant_libre: representant ? representant.trim() : null,
          fournisseur_nom: fournisseur_nom ? fournisseur_nom.trim() : null,
          fournisseur_pays: fournisseur_pays ? fournisseur_pays.trim() : null,
          transporteur: transporteur ? transporteur.trim() : null,
          pipeline_status: "CREE",
          created_by: req.session.userId,
        },
      });

      const dossierDir = path.join(process.cwd(), "uploads", "dossiers", String(newDossier.id));
      if (!fs.existsSync(dossierDir)) {
        fs.mkdirSync(dossierDir, { recursive: true });
      }

      // Conteneurs du BL
      const conteneurs = parseConteneurs(req.body);
      if (conteneurs.length) {
        await prisma.conteneur.createMany({ data: conteneurs.map((c) => ({ ...c, dossier_id: newDossier.id })) });
        await prisma.dossier.update({ where: { id: newDossier.id }, data: countContainers(conteneurs) });
      }

      const files = req.files as { [fieldname: string]: Express.Multer.File[] };
      const fileFields = [
        { name: "fichier_bl", category: "BL", ref: normalized_bl },
        { name: "fichier_fac", category: "FAC", ref: normalized_fac },
        { name: "fichier_sgs", category: "SGS", ref: normalized_sgs },
        { name: "fichier_di", category: "DI", ref: normalized_di },
        { name: "fichier_besc", category: "BESC", ref: normalized_besc },
        { name: "fichier_anor", category: "ANOR", ref: normalized_anor }
      ];

      for (const fField of fileFields) {
        const fileArr = files?.[fField.name];
        if (fileArr && fileArr.length > 0) {
          const file = fileArr[0];
          const destPath = path.join(dossierDir, file.filename);
          
          // Move
          fs.renameSync(file.path, destPath);

          // Save DossierFile
          await prisma.dossierFile.create({
            data: {
              dossier_id: newDossier.id,
              user_id: req.session.userId,
              filename: file.filename,
              original: file.originalname,
              stage: "CREE",
              category: fField.category,
              comment: fField.ref ? `Réf: ${fField.ref}` : `Document ${fField.category}`,
              path: `/uploads/dossiers/${newDossier.id}/${file.filename}`
            }
          });
        }
      }

      // CHANGE 4 - Save three section comments when form submits
      if (comment_client && comment_client.trim()) {
        await prisma.dossierComment.create({
          data: {
            dossier_id: newDossier.id,
            user_id: req.session.userId,
            contenu: `[INFO/CLIENT] ${comment_client.trim()}`,
            stage: "CREE"
          }
        }).catch(() => {});
      }

      if (comment_douane && comment_douane.trim()) {
        await prisma.dossierComment.create({
          data: {
            dossier_id: newDossier.id,
            user_id: req.session.userId,
            contenu: `[INFO/DOUANE] ${comment_douane.trim()}`,
            stage: "CREE"
          }
        }).catch(() => {});
      }

      if (comment_fisc && comment_fisc.trim()) {
        await prisma.dossierComment.create({
          data: {
            dossier_id: newDossier.id,
            user_id: req.session.userId,
            contenu: `[INFO/FISC] ${comment_fisc.trim()}`,
            stage: "CREE"
          }
        }).catch(() => {});
      }

      // Always add the opening summary comment
      await prisma.dossierComment.create({
        data: {
          dossier_id: newDossier.id,
          user_id: req.session.userId,
          contenu: `Dossier ouvert par ${req.session.user.nom}. BL: ${normalized_bl || 'N/A'}. Représentant: ${representant?.trim() || 'Non précisé'}.`,
          stage: "CREE"
        }
      }).catch(() => {});

      await logActivity(
        req.session.userId,
        "CREATION_DOSSIER",
        "Dossier",
        newDossier.id
      );

      req.session.success_msg = `Dossier ${newDossier.numero} créé${conteneurs.length ? ` avec ${conteneurs.length} conteneur(s)` : ""}.`;
      res.redirect(`/dossiers/${newDossier.id}`);
    } catch (error: any) {
      console.error("Erreur de création du dossier :", error);
      req.session.error_msg = "Une erreur est survenue lors de la création du dossier: " + (error.message || error);
      res.redirect("/dossiers/create");
    }
  }
);

router.post("/dossiers/new", requireAuth, async (req: any, res: any) => {
  res.redirect(307, "/dossiers/create");
});

// POST /dossiers/:id/update-custom - Mettre à jour les détails de douane, marchandises, client et conteneur
router.post("/dossiers/:id/update-custom", requireAuth, async (req: any, res: any) => {
  try {
    const id = parseInt(req.params.id);
    const dossier = await prisma.dossier.findUnique({ where: { id } });
    
    if (!dossier) {
      req.session.error_msg = "Dossier introuvable.";
      return res.redirect("/dossiers");
    }

    const { client_id, bl, contenu, droits_douane, validation, valeur_douane, fournisseur_nom, fournisseur_pays, transporteur } = req.body;
    const data: any = {};

    // Groupe 1 : Informations d'origine/Création (client_id, bl, contenu)
    const wantsToChangeGroup1 = 
      (client_id !== undefined && parseInt(client_id) !== dossier.client_id) ||
      (bl !== undefined && bl.trim() !== (dossier.bl || "")) ||
      (contenu !== undefined && (contenu ? contenu.trim() : "") !== (dossier.contenu || "")) ||
      (fournisseur_nom !== undefined && (fournisseur_nom ? fournisseur_nom.trim() : "") !== (dossier.fournisseur_nom || "")) ||
      (fournisseur_pays !== undefined && (fournisseur_pays ? fournisseur_pays.trim() : "") !== (dossier.fournisseur_pays || "")) ||
      (transporteur !== undefined && (transporteur ? transporteur.trim() : "") !== (dossier.transporteur || ""));

    if (wantsToChangeGroup1) {
      const userObj = req.session.user;
      const userObjRole = (userObj?.role || "").trim().toLowerCase();
      if (userObjRole !== "secretariat" && userObjRole !== "secretaire" && userObjRole !== "super_admin") {
        req.session.error_msg = "Accès refusé : Seul le secrétariat administratif (ou le Super Administrateur) peut modifier les informations d'origine de ce dossier.";
        return res.redirect(`/dossiers/${id}`);
      }
      if (dossier.pipeline_status !== "CREE") {
        req.session.error_msg = "Modification refusée : Les champs initiaux (BL, Client, Contenu, Fournisseur, Transporteur) sont verrouillés. Veuillez soumettre une Demande de Correction (Retour arrière) pour les modifier.";
        return res.redirect(`/dossiers/${id}`);
      }
      if (client_id) {
        data.client_id = parseInt(client_id);
      }
      if (bl !== undefined) {
        data.bl = bl ? bl.trim() : "";
      }
      if (contenu !== undefined) {
        data.contenu = contenu ? contenu.trim() : null;
      }
      if (fournisseur_nom !== undefined) {
        data.fournisseur_nom = fournisseur_nom ? fournisseur_nom.trim() : null;
      }
      if (fournisseur_pays !== undefined) {
        data.fournisseur_pays = fournisseur_pays ? fournisseur_pays.trim() : null;
      }
      if (transporteur !== undefined) {
        data.transporteur = transporteur ? transporteur.trim() : null;
      }
    }

    // Groupe 2 : Informations de validation douanière (droits_douane, valeur_douane, validation)
    const parsedDroits = droits_douane !== undefined ? (droits_douane ? parseFloat(droits_douane) : null) : undefined;
    const parsedValeur = valeur_douane !== undefined ? (valeur_douane ? parseFloat(valeur_douane) : null) : undefined;
    const isValChecked = (validation === 'true' || validation === 'on' || validation === true);

    const wantsToChangeGroup2 =
      (parsedDroits !== undefined && parsedDroits !== dossier.droits_douane) ||
      (parsedValeur !== undefined && parsedValeur !== dossier.valeur_douane) ||
      (isValChecked !== dossier.validation);

    if (wantsToChangeGroup2) {
      const userObj = req.session.user;
      if (userObj.role !== "validation" && userObj.role !== "validation_role" && userObj.role !== "super_admin") {
        req.session.error_msg = "Accès refusé : Seul le pôle de Validation / Contrôle de Conformité (ou le Super Administrateur) peut modifier les détails douaniers.";
        return res.redirect(`/dossiers/${id}`);
      }
      if (dossier.pipeline_status !== "VALIDATION") {
        req.session.error_msg = "Modification refusée : Les informations douanières sont validées et verrouillées. Veuillez soumettre une Demande de Correction (Retour arrière) pour les modifier.";
        return res.redirect(`/dossiers/${id}`);
      }
      if (parsedDroits !== undefined) {
        data.droits_douane = parsedDroits;
      }
      if (parsedValeur !== undefined) {
        data.valeur_douane = parsedValeur;
      }
      data.validation = isValChecked;
    }

    if (Object.keys(data).length > 0) {
      await prisma.dossier.update({
        where: { id },
        data,
      });

      await logActivity(
        req.session.userId,
        "MISE_A_JOUR_DETAILED_DOUANE",
        "Dossier",
        id
      );
      req.session.success_msg = "Informations du dossier et de douane actualisées.";
    } else {
      req.session.error_msg = "Rien n'a été enregistré : aucun champ n'a changé, ou ces informations ne relèvent pas de votre rôle.";
    }

    res.redirect(`/dossiers/${id}`);
  } catch (error) {
    console.error("Erreur mise à jour infos douanières :", error);
    req.session.error_msg = "Erreur d'enregistrement des modifications.";
    res.redirect(`/dossiers/${req.params.id}`);
  }
});

// GET /dossiers/:id - Fiche détaillée (STAR)
router.get("/dossiers/:id", requireAuth, async (req: any, res: any) => {
  try {
    const folderId = parseInt(req.params.id);

    const dossier = await prisma.dossier.findUnique({
      where: { id: folderId },
      include: {
        client: true,
        representant_obj: true,
        taches: {
          include: {
            intervenant: true,
            subtasks: true,
            comments: {
              include: { user: true },
              orderBy: { created_at: "asc" }
            }
          },
          orderBy: {
            created_at: "asc",
          },
        },
        bons_provisoir: {
          include: {
            demandeur: { select: { nom: true, prenom: true, role: true } },
            approver: { select: { nom: true, prenom: true } },
            bon_reel: {
              include: {
                soumis_par: { select: { nom: true, prenom: true } },
                confirme_par: { select: { nom: true, prenom: true } }
              }
            }
          },
          orderBy: {
            created_at: "desc"
          }
        },
        bons_reel: true,
        conteneurs: { orderBy: { id: "asc" } },
        files: {
          include: {
            user: { select: { nom: true, role: true } }
          },
          orderBy: {
            created_at: "asc"
          }
        },
        comments: {
          include: {
            user: true
          },
          orderBy: {
            created_at: "asc"
          }
        }
      },
    });

    if (!dossier) {
      req.session.error_msg = "Dossier de transit introuvable.";
      return res.redirect("/dossiers");
    }

    // 1. Invoices (Documents) related checking
    // Match by client to speed up, then filter matching dossier number inside document.numero or line.description
    const allDocs = await prisma.document.findMany({
      where: {
        client_id: dossier.client_id,
      },
      include: {
        lines: true,
        payments: true,
      },
      orderBy: {
        created_at: "desc",
      }
    });

    const linkedInvoices = allDocs.filter(doc => {
      const matchInNum = doc.numero.toUpperCase().includes(dossier.numero.toUpperCase());
      const matchInLines = doc.lines.some(l => l.description.toUpperCase().includes(dossier.numero.toUpperCase()));
      return doc.dossier_id === dossier.id || (!doc.dossier_id && (matchInNum || matchInLines));
    });

    // 2. Attachments files reading
    const uploadDirPath = path.join(process.cwd(), "uploads", "dossiers", String(dossier.id));
    const attachments: Array<{ name: string; size: string; uploadedAt: string }> = [];

    if (fs.existsSync(uploadDirPath)) {
      const files = fs.readdirSync(uploadDirPath);
      files.forEach(f => {
        const stats = fs.statSync(path.join(uploadDirPath, f));
        attachments.push({
          name: f,
          size: `${(stats.size / (1024 * 1024)).toFixed(2)} MB`,
          uploadedAt: stats.mtime.toLocaleDateString("fr-FR"),
        });
      });
    }

    // 3. Activity timelines logs
    // Include logs specifically pointing to this dossier or to any of its tasks
    const taskIds = dossier.taches.map(t => t.id);
    const logs = await prisma.activityLog.findMany({
      where: {
        OR: [
          { entity: "Dossier", entity_id: String(dossier.id) },
          { entity: "Tache", entity_id: { in: taskIds.map(String) } },
        ],
      },
      include: {
        user: true,
      },
      orderBy: {
        created_at: "desc",
      },
    });

    const timeline = await prisma.activityLog.findMany({
      where: { entity: "dossier", entity_id: String(folderId) },
      include: { user: { select: { nom: true } } },
      orderBy: { created_at: "desc" },
      take: 40
    });

    // Envoi de tous les agents pour l'assignation de tâches rapides
    const [users, clients] = await Promise.all([
      prisma.user.findMany({
        where: { actif: true },
        orderBy: { nom: "asc" },
      }),
      prisma.client.findMany({
        orderBy: { nom: "asc" },
      })
    ]);

    res.render("dossiers/detail", {
      dossier,
      linkedInvoices,
      attachments,
      logs,
      timeline,
      users,
      clients,
      finance: dossierFinance({ ...dossier, documents: linkedInvoices }),
      reqStatus: requirementStatus({ ...dossier, documents: linkedInvoices }, dossier.pipeline_status),
      facture1: linkedInvoices.find((d: any) => d.phase === "DROITS") || null,
      factureFinale: linkedInvoices.find((d: any) => d.type === "FACTURE" && d.phase !== "DROITS") || null,
      billingMissing: dossier.pipeline_status === "BON_REEL" ? [
        ...dossier.bons_provisoir.filter((b) => b.etat === "APPROUVE" && !b.bon_reel).map((b) => `bon réel du ${b.numero}`),
        ...(dossier.bons_provisoir.some((b) => b.etat === "EN_ATTENTE") ? ["un bon attend encore son paiement"] : []),
        ...missingRequirements({ ...dossier, documents: linkedInvoices }, "BON_REEL"),
      ] : [],
      docCategories: DOC_CATEGORIES,
      banques: dossier.pipeline_status === "PAIEMENT_DROITS" ? await banquesActives() : [],
      chatItems: await chatFeed(dossier.id),
      chatMembersList: await chatMembers(dossier.id),
      lateHours: hoursLate(dossier as any),
      slaHours: stepOf(dossier.pipeline_status).slaHours,
      trackingUrl: dossier.tracking_token ? `${process.env.APP_URL || `${req.headers["x-forwarded-proto"] || req.protocol}://${req.get("host")}`}/suivi/${dossier.tracking_token}` : "",
      title: `Suivi Dossier - ${dossier.numero}`,
    });
  } catch (error: any) {
    console.error("Erreur chargement détail dossier :", error);
    res.status(500).render("errors/500", { error });
  }
});

// POST /dossiers/:id/comment - Ajouter un commentaire à la discussion globale du dossier
// Fil de discussion (rechargé en direct quand quelqu'un écrit)
router.get("/dossiers/:id/chat", requireAuth, async (req: any, res: any) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ ok: false });
  const [items, members] = await Promise.all([chatFeed(id), chatMembers(id)]);
  res.json({ ok: true, me: req.session.userId, items, members });
});

// Pièces jointes de la discussion : photos, vidéos, notes vocales, documents (rangées dans uploads/dossiers/:id/chat)
const chatDir = (id: number | string) => path.join(process.cwd(), "uploads", "dossiers", String(id), "chat");
const CHAT_MIME = /^(image\/|video\/|audio\/|application\/(pdf|msword|vnd\.openxmlformats|vnd\.ms-|zip)|text\/plain)/;
const chatUpload = multer({
  storage: multer.diskStorage({
    destination: (req: any, _file: any, cb: any) => { const dir = chatDir(parseInt(req.params.id)); fs.mkdirSync(dir, { recursive: true }); cb(null, dir); },
    filename: (_req: any, file: any, cb: any) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 8);
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${ext}`);
    },
  }),
  limits: { fileSize: 64 * 1024 * 1024, files: 10 },
  fileFilter: (_req: any, file: any, cb: any) => CHAT_MIME.test(file.mimetype) ? cb(null, true) : cb(new Error(`Format non accepté : ${file.originalname}`)),
}).array("fichiers", 10);

router.post("/dossiers/:id/comment", requireAuth, (req: any, res: any, next: any) => {
  // Message simple (JSON) ou avec pièces jointes (multipart)
  if (!req.is("multipart/form-data")) return next();
  chatUpload(req, res, (err: any) => {
    if (err) return res.status(400).json({ ok: false, error: err.code === "LIMIT_FILE_SIZE" ? "Fichier trop lourd (64 Mo au maximum)." : err.message });
    next();
  });
}, async (req: any, res: any) => {
  const files = (req.files as Express.Multer.File[] | undefined) || [];
  const cleanup = () => files.forEach((f) => fs.rmSync(f.path, { force: true }));
  try {
    const dossierId = parseInt(req.params.id);
    const texte = String(req.body.contenu || "").trim().slice(0, 2000);
    if (!texte && !files.length) { cleanup(); return res.status(400).json({ ok: false, error: "Écrivez un message ou joignez un fichier." }); }

    const dossier = await prisma.dossier.findUnique({ where: { id: dossierId } });
    if (!dossier) { cleanup(); return res.status(404).json({ ok: false, error: "Dossier introuvable." }); }
    if (dossier.pipeline_status === "ARCHIVE") { cleanup(); return res.status(400).json({ ok: false, error: "Le dossier est archivé : la discussion est fermée." }); }

    // Mentions : seulement des membres du groupe, et seulement s'ils sont bien cités dans le texte
    let wanted: number[] = [];
    try { wanted = (Array.isArray(req.body.mentions) ? req.body.mentions : JSON.parse(req.body.mentions || "[]")).map((x: any) => parseInt(x)).filter((x: number) => !isNaN(x)); } catch { wanted = []; }
    const members = wanted.length ? await chatMembers(dossierId) : [];
    const mentions = members.filter((m) => wanted.includes(m.id)).map((m) => ({ id: m.id, nom: [m.prenom, m.nom].filter(Boolean).join(" ") }))
      .filter((m) => texte.includes("@" + m.nom));

    let reply_to_id: number | null = parseInt(req.body.reply_to) || null;
    if (reply_to_id) {
      const r = await prisma.dossierComment.findUnique({ where: { id: reply_to_id }, select: { dossier_id: true } });
      if (!r || r.dossier_id !== dossierId) reply_to_id = null;
    }

    const att = files.map((f) => ({ name: f.filename, original: f.originalname.slice(0, 120), mime: f.mimetype, size: f.size, kind: attKind(f.mimetype) }));
    const comment = await prisma.dossierComment.create({
      data: {
        dossier_id: dossierId, user_id: req.session.userId, contenu: texte, stage: dossier.pipeline_status || "CREE",
        attachments_json: att.length ? JSON.stringify(att) : null,
        mentions_json: mentions.length ? JSON.stringify(mentions) : null,
        reply_to_id,
      },
      include: { user: { select: { id: true, nom: true, prenom: true, role: true } } },
    });
    const resume = texte || (att.length === 1 ? (att[0].kind === "image" ? "📷 Photo" : att[0].kind === "video" ? "🎬 Vidéo" : att[0].kind === "audio" ? "🎤 Audio" : `📎 ${att[0].original}`) : `📎 ${att.length} fichiers`);
    notifyChat(dossierId, req.session.userId, resume, mentions.map((m) => m.id)).catch((e) => console.error("[CHAT]", e));
    return res.json({ ok: true, comment });
  } catch (error: any) {
    cleanup();
    console.error("Erreur lors de l'ajout du commentaire au dossier :", error);
    return res.status(500).json({ ok: false, error: "Une erreur interne est survenue." });
  }
});

// POST /dossiers/:id/chat/seen - Accusés de lecture (appelé quand la discussion est à l'écran)
router.post("/dossiers/:id/chat/seen", requireAuth, async (req: any, res: any) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ ok: false });
  const n = await markChatSeen(id, req.session.userId);
  if (n) liveEmit({ t: "chat", d: id, by: req.session.userId });
  res.json({ ok: true, n });
});

// DELETE /dossiers/:id/chat/:cid - Supprimer son message pour tout le monde (le super admin peut tout supprimer)
router.delete("/dossiers/:id/chat/:cid", requireAuth, async (req: any, res: any) => {
  const id = parseInt(req.params.id), cid = parseInt(req.params.cid);
  const c = await prisma.dossierComment.findUnique({ where: { id: cid } });
  if (!c || c.dossier_id !== id) return res.status(404).json({ ok: false, error: "Message introuvable." });
  if (c.user_id !== req.session.userId && req.session.user?.role !== "super_admin") return res.status(403).json({ ok: false, error: "Vous ne pouvez supprimer que vos propres messages." });
  if (!c.deleted_at) await prisma.dossierComment.update({ where: { id: cid }, data: { deleted_at: new Date() } });
  res.json({ ok: true });
});

// GET /dossiers/:id/chat/file/:name - Pièce jointe de la discussion (affichée dans le fil ; vidéo lue en continu)
router.get("/dossiers/:id/chat/file/:name", requireAuth, async (req: any, res: any) => {
  const id = parseInt(req.params.id);
  const name = path.basename(String(req.params.name));
  const c = await prisma.dossierComment.findFirst({ where: { dossier_id: id, deleted_at: null, attachments_json: { contains: `"name":"${name}"` } }, select: { attachments_json: true } });
  const a = c ? parseJson<any[]>(c.attachments_json, []).find((x) => x.name === name) : null;
  const file = path.join(chatDir(id), name);
  if (!a || !fs.existsSync(file)) return res.status(404).send("Pièce introuvable.");
  res.setHeader("Content-Type", a.mime);
  res.setHeader("Content-Disposition", `${req.query.dl ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(a.original)}`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.sendFile(file, { headers: { "Cache-Control": "private, max-age=86400" } });
});

// POST /dossiers/:id/upload - Upload de pièce jointe
router.post("/dossiers/:id/upload", requireAuth, (req: any, res: any) => {
  const userRole = (req.session.user?.role || "").trim().toLowerCase();
  const allowedRoles = ["super_admin", "secretaire", "secretariat", "guce", "validation", "validation_role", "pdg", "dg", "dga", "daf", "acconage", "enlevement", "operationnel", "facturation", "comptable", "comptable_ops"];
  
  if (!allowedRoles.includes(userRole)) {
    req.session.error_msg = "Accès refusé : Vous n'avez pas l'autorisation d'importer des fichiers pour ce dossier.";
    return res.redirect(`/dossiers/${req.params.id}`);
  }

  upload.single("pdf_file")(req, res, async function (err: any) {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      req.session.error_msg = "ID de dossier invalide.";
      return res.redirect("/dossiers");
    }

    if (err) {
      req.session.error_msg = `Échec de l'import : ${err.message}`;
      return res.redirect(`/dossiers/${id}`);
    }

    if (!req.file) {
      req.session.error_msg = "Veuillez sélectionner un fichier valide à importer (PDF, JPG, PNG).";
      return res.redirect(`/dossiers/${id}`);
    }

    try {
      const dossier = await prisma.dossier.findUnique({
        where: { id: id }
      });

      if (!dossier) {
        req.session.error_msg = "Dossier introuvable.";
        return res.redirect("/dossiers");
      }

      const category = req.body.category || "AUTRE";
      const comment = req.body.comment || null;

      // Create DossierFile record in database
      await prisma.dossierFile.create({
        data: {
          dossier_id: id,
          user_id: req.session.userId,
          filename: req.file.filename,
          original: req.file.originalname,
          stage: dossier.pipeline_status || "CREE",
          category: category,
          comment: comment,
          path: req.file.path
        }
      });

      await prisma.activityLog.create({
        data: {
          user_id: req.session.userId,
          action: 'fichier.uploaded',
          entity: 'dossier',
          entity_id: String(id),
          meta: JSON.stringify({ filename: req.file.originalname })
        }
      });

      await logActivity(
        req.session.userId,
        `IMPORT_PIECE_JOINTE_${req.file.filename.split("-").slice(2).join("-")}`,
        "Dossier",
        id
      );

      req.session.success_msg = `✅ Fichier joint avec succès : ${req.file.originalname}`;
      res.redirect(`/dossiers/${id}`);
    } catch (uploadErr: any) {
      console.error("Erreur save dossier file :", uploadErr);
      req.session.error_msg = "Une erreur est survenue lors de l'enregistrement du fichier.";
      res.redirect(`/dossiers/${id}`);
    }
  });
});

// POST /dossiers/:id/delete-file/:fileId - Suppression d'un document du dossier
router.post("/dossiers/:id/delete-file/:fileId", requireAuth, async (req: any, res: any) => {
  const dossierId = parseInt(req.params.id);
  const fileId = parseInt(req.params.fileId);
  if (isNaN(dossierId) || isNaN(fileId)) {
    req.session.error_msg = "Identifiants invalides.";
    return res.redirect("/dossiers");
  }

  try {
    const file = await prisma.dossierFile.findUnique({
      where: { id: fileId }
    });

    if (!file || file.dossier_id !== dossierId) {
      req.session.error_msg = "Fichier introuvable.";
      return res.redirect(`/dossiers/${dossierId}`);
    }

    const currentUser = req.session.user;
    const isOwner = file.user_id === currentUser.id;
    const isSuperAdmin = currentUser.role === "super_admin";

    if (!isOwner && !isSuperAdmin) {
      req.session.error_msg = "Accès refusé : Vous ne pouvez pas supprimer un fichier importé par un autre utilisateur.";
      return res.redirect(`/dossiers/${dossierId}`);
    }

    // Supprimer le fichier du disque
    if (file.path && fs.existsSync(file.path)) {
      try {
        fs.unlinkSync(file.path);
      } catch (err) {
        console.error("Erreur suppression fichier physique :", err);
      }
    }

    // Supprimer de la base
    await prisma.dossierFile.delete({
      where: { id: fileId }
    });

    await prisma.activityLog.create({
      data: {
        user_id: req.session.userId,
        action: 'fichier.deleted',
        entity: 'dossier',
        entity_id: String(dossierId),
        meta: JSON.stringify({ filename: file.original })
      }
    });

    req.session.success_msg = `✅ Fichier supprimé avec succès : ${file.original}`;
    res.redirect(`/dossiers/${dossierId}`);
  } catch (err: any) {
    console.error("Erreur suppression dossier file :", err);
    req.session.error_msg = "Une erreur est survenue lors de la suppression du fichier.";
    res.redirect(`/dossiers/${dossierId}`);
  }
});

// GET /dossiers/:id/download/:filename - Téléchargement d'une pièce jointe
router.get("/dossiers/:id/download/:filename", requireAuth, (req: any, res: any) => {
  try {
    const id = req.params.id;
    const filename = req.params.filename;
    
    // Protection contre le path-traversal
    const safeFilename = path.basename(filename);
    const filePath = path.join(process.cwd(), "uploads", "dossiers", id, safeFilename);

    if (fs.existsSync(filePath)) {
      res.download(filePath, safeFilename);
    } else {
      res.status(404).send("Le fichier demandé n'existe pas ou a été retiré.");
    }
  } catch (error) {
    console.error("Erreur download :", error);
    res.status(500).send("Erreur interne du système lors du téléchargement.");
  }
});

// POST /dossiers/update-status/:id - Changement d'état d'un dossier
router.post("/dossiers/update-status/:id", requireAuth, async (req: any, res: any) => {
  try {
    const folderId = parseInt(req.params.id);
    const { etat } = req.body;

    if (!etat) {
      req.session.error_msg = "État invalide.";
      return res.redirect("/dossiers");
    }

    await prisma.dossier.update({
      where: { id: folderId },
      data: { etat },
    });

    await logActivity(
      req.session.userId,
      `STATUS_DOSSIER_MOD_TO_${etat}`,
      "Dossier",
      folderId
    );

    req.session.success_msg = `Statut du dossier actualisé à : "${etat}"`;
    res.redirect(`/dossiers/${folderId}`);
  } catch (error) {
    console.error("Erreur statut dossier :", error);
    res.status(500).send("Erreur de traitement.");
  }
});

// POST /dossiers/delete/:id - Suppression d'un dossier
router.post("/dossiers/delete/:id", requireAuth, async (req: any, res: any) => {
  try {
    const folderId = parseInt(req.params.id);
    const user = req.session.user;

    if (user.role !== "super_admin") {
      req.session.error_msg = "Accès refusé : Seul le Super Administrateur peut supprimer définitivement un dossier.";
      return res.redirect(`/dossiers/${folderId}`);
    }

    const ds = await prisma.dossier.findUnique({ where: { id: folderId } });
    if (!ds) {
      req.session.error_msg = "Dossier introuvable.";
      return res.redirect("/dossiers");
    }

    await prisma.dossier.delete({
      where: { id: folderId },
    });

    await logActivity(
      req.session.userId,
      `SUPPRESSION_DOSSIER_${ds.numero}`,
      "Dossier",
      folderId
    );

    // Supprimer aussi le dossier d'uploads correspondant physique
    const uploadDirPath = path.join(process.cwd(), "uploads", "dossiers", String(folderId));
    if (fs.existsSync(uploadDirPath)) {
      fs.rmSync(uploadDirPath, { recursive: true, force: true });
    }

    req.session.success_msg = `Dossier ${ds.numero} supprimé.`;
    res.redirect("/dossiers");
  } catch (error) {
    console.error("Erreur suppression dossier :", error);
    res.status(500).send("Erreur de suppression.");
  }
});

// POST /dossiers/:id/taches/new - Ajouter un jalon d'étape rapide
router.post("/dossiers/:id/taches/new", requireAuth, async (req: any, res: any) => {
  const dossierId = parseInt(req.params.id);
  try {
    const { titre, intervenant_id, deadline, observations } = req.body;

    if (!titre) {
      req.session.error_msg = "Le titre de la tâche est obligatoire.";
      return res.redirect(`/dossiers/${dossierId}`);
    }

    const assignedAgentId = intervenant_id ? parseInt(intervenant_id) : null;
    const limitDate = deadline ? new Date(deadline) : null;

    const tache = await prisma.tache.create({
      data: {
        dossier_id: dossierId,
        titre: titre.trim(),
        intervenant_id: assignedAgentId,
        etat: "EN_COURS",
        observations: observations ? observations.trim() : "",
        deadline: limitDate,
      },
    });

    await logActivity(
      req.session.userId,
      "CREATION_TACHE_RAPIDE",
      "Tache",
      tache.id
    );

    req.session.success_msg = `Tâche "${titre}" ajoutée pour ce dossier.`;
    res.redirect(`/dossiers/${dossierId}`);
  } catch (error) {
    console.error("Erreur tâche rapide :", error);
    req.session.error_msg = "Une erreur est survenue lors de la création.";
    res.redirect(`/dossiers/${dossierId}`);
  }
});

// POST /dossiers/:id/taches/:tacheId/modifier - Mettre à jour une tâche depuis le dossier
router.post("/dossiers/:id/taches/:tacheId/modifier", requireAuth, async (req: any, res: any) => {
  try {
    const dossierId = parseInt(req.params.id);
    const tacheId = parseInt(req.params.tacheId);
    const { delete_task, etat, titre, observations, intervenant_id } = req.body;

    const previousTask = await prisma.tache.findUnique({ where: { id: tacheId } });
    if (!previousTask) {
      return res.status(404).send("Tâche introuvable.");
    }

    // Suppression demandée
    if (delete_task === "yes") {
      await prisma.tache.delete({ where: { id: tacheId } });
      await logActivity(req.session.userId, "SUPPRESSION_TACHE", "Tache", tacheId);
      req.session.success_msg = "Tâche retirée du dossier.";
      return res.redirect(`/dossiers/${dossierId}`);
    }

    const updateData: any = {};
    if (etat) updateData.etat = etat;
    if (titre) updateData.titre = titre;
    if (observations !== undefined) updateData.observations = observations;
    if (intervenant_id !== undefined) {
      updateData.intervenant_id = intervenant_id ? parseInt(intervenant_id) : null;
    }

    await prisma.tache.update({
      where: { id: tacheId },
      data: updateData,
    });

    if (etat && previousTask.etat !== etat) {
      await prisma.activityLog.create({
        data: {
          user_id: req.session.userId,
          action: 'tache.status',
          entity: 'dossier',
          entity_id: String(dossierId),
          meta: JSON.stringify({
            titre: previousTask.titre,
            from: previousTask.etat,
            to: etat
          })
        }
      });
    }

    await logActivity(
      req.session.userId,
      `MODIFICATION_TACHE_${tacheId}`,
      "Tache",
      tacheId
    );

    req.session.success_msg = "Tâche d'expédition actualisée.";
    res.redirect(`/dossiers/${dossierId}`);
  } catch (error) {
    console.error("Erreur modif tâche dossier :", error);
    res.status(500).send("Erreur de traitement.");
  }
});

// Pièces obligatoires : renvoie un message d'erreur si le dossier ne peut pas quitter l'étape
// Montant lisible : 1 250 000
const fcfa = (v: any) => (Math.round(Number(String(v ?? 0).replace(/[\s\u00a0\u202f]/g, "").replace(",", ".")) || 0)).toLocaleString("fr-FR");

async function blockIfMissing(req: any, id: number, stage: string, action: string): Promise<boolean> {
  const d = await prisma.dossier.findUnique({ where: { id }, include: { files: true, documents: true } });
  const missing = d ? missingRequirements(d, stage) : ["dossier introuvable"];
  if (missing.length) {
    req.session.error_msg = `Impossible de ${action} : il manque ${missing.join(", ")}.`;
    return true;
  }
  return false;
}

// Une transition ne peut partir que de l'étape attendue (évite les sauts d'étape et les doubles clics)
async function wrongStage(req: any, id: number, expected: string): Promise<boolean> {
  const d = await prisma.dossier.findUnique({ where: { id }, select: { pipeline_status: true } });
  if (!d) { req.session.error_msg = "Dossier introuvable."; return true; }
  if (d.pipeline_status !== expected) {
    req.session.error_msg = `Action impossible : le dossier est à l'étape « ${stepOf(d.pipeline_status).label} », pas « ${stepOf(expected).label} ».`;
    return true;
  }
  return false;
}

// Helper pour créer automatiquement une tâche Kanban lors d'un transition de flux
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

  // POST /dossiers/:id/pipeline/soumettre-guce - Soumettre au GUCE (Secrétariat, Super Admin)
// POST /dossiers/:id/pipeline/rejet-secretariat - Le secrétariat rejette le dossier avec un motif (ex. client pas prêt à valider).
// Le dossier reste à l'étape « Créé », sans numéro ; il peut être transmis plus tard, ce qui lève le rejet.
router.post("/dossiers/:id/pipeline/rejet-secretariat", requireAuth, async (req: any, res: any) => {
  const id = parseInt(req.params.id);
  const role = (req.session.user?.role || "").trim().toLowerCase();
  if (!STAGE_ACTORS.CREE.includes(role)) { req.session.error_msg = "Seul le secrétariat peut rejeter un dossier avant le GUCE."; return res.redirect(`/dossiers/${id}`); }
  if (await wrongStage(req, id, "CREE")) return res.redirect(`/dossiers/${id}`);
  const lever = req.body.lever === "1";
  const motif = String(req.body.motif || "").trim();
  if (!lever && !motif) { req.session.error_msg = "Indiquez le motif du rejet."; return res.redirect(`/dossiers/${id}`); }
  const u = req.session.user;
  await prisma.dossier.update({ where: { id }, data: lever ? { rejet_motif: null, rejet_at: null, rejet_par: null } : { rejet_motif: motif.slice(0, 500), rejet_at: new Date(), rejet_par: `${u.prenom || ""} ${u.nom}`.trim() } });
  await logActivity(req.session.userId, lever ? "DOSSIER_REJET_LEVE" : "DOSSIER_REJETE_SECRETARIAT", "Dossier", lever ? id : `${id} - Motif : ${motif}`);
  req.session.success_msg = lever ? "Rejet levé : le dossier peut être transmis au GUCE." : "Dossier rejeté. Il reste au secrétariat avec son motif ; vous pourrez le transmettre au GUCE plus tard.";
  res.redirect(`/dossiers/${id}`);
});

router.post("/dossiers/:id/pipeline/soumettre-guce", requireAuth, async (req: any, res: any) => {
  try {
    const id = parseInt(req.params.id);
    const user = req.session.user;
    const userRole = (user?.role || "").trim().toLowerCase();
    if (!STAGE_ACTORS.CREE.includes(userRole)) {
      req.session.error_msg = "Seul le secrétariat, l'administration ou un administrateur peut soumettre au GUCE.";
      return res.redirect(`/dossiers/${id}`);
    }
    if (await wrongStage(req, id, "CREE")) return res.redirect(`/dossiers/${id}`);

    if (await blockIfMissing(req, id, "CREE", "transmettre au GUCE")) return res.redirect(`/dossiers/${id}#pieces`);

    // Transmettre lève un éventuel rejet du secrétariat ; le dossier reçoit son numéro et commence à compter
    const dossier = await prisma.dossier.update({
      where: { id },
      data: { pipeline_status: "GUCE", rejet_motif: null, rejet_at: null, rejet_par: null }
    });
    const numeroOrdre = await attribuerNumero(id);

    await logActivity(req.session.userId, "DOSSIER_SOUMIS_GUCE", "Dossier", id);
    
    // Création d'une tâche pour le GUCE
    await createAutoTask(id, `🇬🇺 Formalités GUCE - Dossier ${dossier.numero}`, `Paiement des frais Assurance, BESC, RVC et attachement des quittances pour manifestation.`, "guce");

    req.session.success_msg = `Dossier transmis au GUCE${numeroOrdre ? ` : N° de dossier ${numeroOrdre}` : ""}.`;
    res.redirect(`/dossiers/${id}`);
  } catch (error) {
    console.error("Erreur soumission GUCE pipeline status :", error);
    res.status(500).send("Erreur serveur.");
  }
});

const uploadGUCE = multer({
  storage: storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req: any, file: any, cb: any) => {
    const ok = /pdf|jpg|jpeg|png/i.test(file.mimetype);
    if (ok) {
      cb(null, true);
    } else {
      cb(new Error("Format non supporté"));
    }
  }
}).fields([
  { name: "fichier_assurance", maxCount: 1 },
  { name: "fichier_besc", maxCount: 1 },
  { name: "fichier_rvc", maxCount: 1 }
]);

// POST /dossiers/:id/pipeline/valider-guce - Valider GUCE et soumettre pour Validation CAMCIS (GUCE, Super Admin)
router.post("/dossiers/:id/pipeline/valider-guce", requireAuth, (req: any, res: any, next: any) => {
  uploadGUCE(req, res, (err: any) => {
    if (err) {
      req.session.error_msg = "Erreur upload: " + err.message;
      return res.redirect(`/dossiers/${req.params.id}`);
    }
    next();
  });
}, async (req: any, res: any) => {
  try {
    const id = parseInt(req.params.id);
    const user = req.session.user;
    if (!STAGE_ACTORS.GUCE.includes(user.role)) {
      req.session.error_msg = "Seul le pôle GUCE, l'administration ou un administrateur peut valider cette étape.";
      return res.redirect(`/dossiers/${id}`);
    }
    if (await wrongStage(req, id, "GUCE")) return res.redirect(`/dossiers/${id}`);

    const { assurance_montant, besc_montant, rvc_montant, manifeste_checked } = req.body;
    const notesLog = `Assurance: ${fcfa(assurance_montant)} FCFA | BESC: ${fcfa(besc_montant)} FCFA | RVC: ${fcfa(rvc_montant)} FCFA | Manifesté: ${manifeste_checked === 'on' || manifeste_checked === true ? "OUI" : "NON"}`;

    // Sauvegarde en DB des fichiers joints
    const filesObj = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
    const fileAssurance = filesObj?.["fichier_assurance"]?.[0];
    const fileBesc = filesObj?.["fichier_besc"]?.[0];
    const fileRvc = filesObj?.["fichier_rvc"]?.[0];

    if (fileAssurance) {
      await prisma.dossierFile.create({
        data: {
          dossier_id: id,
          user_id: req.session.userId,
          filename: fileAssurance.filename,
          original: fileAssurance.originalname,
          stage: "GUCE",
          category: "ASSURANCE",
          comment: `Quittance Assurance — ${fcfa(assurance_montant)} FCFA`,
          path: fileAssurance.path
        }
      });
    }

    if (fileBesc) {
      await prisma.dossierFile.create({
        data: {
          dossier_id: id,
          user_id: req.session.userId,
          filename: fileBesc.filename,
          original: fileBesc.originalname,
          stage: "GUCE",
          category: "BESC",
          comment: `Quittance BESC — ${fcfa(besc_montant)} FCFA`,
          path: fileBesc.path
        }
      });
    }

    if (fileRvc) {
      await prisma.dossierFile.create({
        data: {
          dossier_id: id,
          user_id: req.session.userId,
          filename: fileRvc.filename,
          original: fileRvc.originalname,
          stage: "GUCE",
          category: "RVC",
          comment: `Quittance RVC — ${fcfa(rvc_montant)} FCFA`,
          path: fileRvc.path
        }
      });
    }

    if (await blockIfMissing(req, id, "GUCE", "transmettre à la validation CAMCIS")) return res.redirect(`/dossiers/${id}`);

    const dossier = await prisma.dossier.update({
      where: { id },
      data: { pipeline_status: "VALIDATION" }
    });

    await logActivity(req.session.userId, "DOSSIER_VALIDE_GUCE", "Dossier", `${id} - Détails: ${notesLog}`);
    
    // Création d'une tâche de validation pour le pôle conformité / validation
    await createAutoTask(id, `📁 Contrôle de Conformité - Dossier ${dossier.numero}`, `Le dossier ${dossier.numero} est prêt pour votre visa de validation réglementaire CAMCIS.`, "validation");

    req.session.success_msg = "✅ Formalités GUCE enregistrées avec succès.";
    res.redirect(`/dossiers/${id}`);
  } catch (error) {
    console.error("Erreur validation GUCE pipeline status :", error);
    res.status(500).send("Erreur serveur.");
  }
});

// POST /dossiers/:id/pipeline/valider - Soumettre pour Validation (Ancien flux direct, conservé pour compatibilité)
router.post("/dossiers/:id/pipeline/valider", requireAuth, async (req: any, res: any) => {
  try {
    const id = parseInt(req.params.id);
    if (!STAGE_ACTORS.GUCE.includes(req.session.user?.role)) {
      req.session.error_msg = "Accès refusé : rôle non autorisé.";
      return res.redirect(`/dossiers/${id}`);
    }
    if (await wrongStage(req, id, "GUCE")) return res.redirect(`/dossiers/${id}`);
    if (await blockIfMissing(req, id, "GUCE", "transmettre à la validation CAMCIS")) return res.redirect(`/dossiers/${id}`);
    const dossier = await prisma.dossier.update({
      where: { id },
      data: { pipeline_status: "VALIDATION" }
    });

    await logActivity(req.session.userId, "DOSSIER_SOUMIS_VALIDATION", "Dossier", id);
    await createAutoTask(id, `📁 Contrôle de Conformité - Dossier ${dossier.numero}`, `Le dossier ${dossier.numero} est prêt pour votre visa de validation réglementaire.`, "validation");

    req.session.success_msg = "Dossier soumis pour validation avec succès.";
    res.redirect(`/dossiers/${id}`);
  } catch (error) {
    console.error("Erreur validation pipeline status :", error);
    res.status(500).send("Erreur serveur.");
  }
});

const uploadCAMCIS = multer({
  storage: storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req: any, file: any, cb: any) => {
    const ok = /pdf|jpg|jpeg|png/i.test(file.mimetype);
    if (ok) {
      cb(null, true);
    } else {
      cb(new Error("Format non supporté"));
    }
  }
}).array("fichiers_camcis", 10);

// POST /dossiers/:id/pipeline/approuver - Approuver Validation (Validation, Super Admin)
router.post("/dossiers/:id/pipeline/approuver", requireAuth, (req: any, res: any, next: any) => {
  uploadCAMCIS(req, res, (err: any) => {
    if (err) {
      req.session.error_msg = "Erreur upload: " + err.message;
      return res.redirect(`/dossiers/${req.params.id}`);
    }
    next();
  });
}, async (req: any, res: any) => {
  try {
    const id = parseInt(req.params.id);
    const user = req.session.user;
    if (!STAGE_ACTORS.VALIDATION.includes(user.role)) {
      req.session.error_msg = "Accès refusé : rôle non autorisé pour valider.";
      return res.redirect(`/dossiers/${id}`);
    }
    if (await wrongStage(req, id, "VALIDATION")) return res.redirect(`/dossiers/${id}`);

    // Données de la déclaration CAMCIS saisies dans le formulaire de validation
    const b = req.body || {};
    const toNum = (v: any) => { const n = parseFloat(String(v ?? "").replace(/\s/g, "").replace(",", ".")); return isNaN(n) ? null : n; };
    const camcisData: any = {};
    if (b.camcis_numero !== undefined) camcisData.camcis_numero = String(b.camcis_numero).trim() || null;
    if (b.camcis_date) camcisData.camcis_date = new Date(b.camcis_date);
    if (b.camcis_liquidation !== undefined && b.camcis_liquidation !== "") { camcisData.camcis_liquidation = toNum(b.camcis_liquidation); camcisData.droits_douane = toNum(b.camcis_liquidation); }
    if (["VERT", "JAUNE", "ROUGE"].includes(b.camcis_circuit)) camcisData.camcis_circuit = b.camcis_circuit;
    if (b.gn_numero !== undefined) camcisData.gn_numero = String(b.gn_numero).trim().toUpperCase() || null;
    if (b.dau_numero !== undefined) camcisData.dau_numero = String(b.dau_numero).trim().toUpperCase() || null;
    const articles = lireArticles(b);
    if (b.art_designation !== undefined || b.art_code !== undefined) camcisData.articles_json = JSON.stringify(articles);
    if (Object.keys(camcisData).length) await prisma.dossier.update({ where: { id }, data: camcisData });
    await memoriserCodes(articles);

    // Save each uploaded file to database
    const filesList = req.files as Express.Multer.File[] | undefined;
    if (filesList && filesList.length > 0) {
      for (const file of filesList) {
        await prisma.dossierFile.create({
          data: {
            dossier_id: id,
            user_id: req.session.userId,
            filename: file.filename,
            original: file.originalname,
            stage: "VALIDATION",
            category: "CAMCIS",
            comment: "Document CAMCIS validé",
            path: file.path
          }
        });
      }
    }

    if (await blockIfMissing(req, id, "VALIDATION", "valider la déclaration CAMCIS")) return res.redirect(`/dossiers/${id}#camcis`);

    const dossier = await prisma.dossier.update({
      where: { id },
      data: { pipeline_status: "PAIEMENT_DROITS" }
    });
    const ordre = await attribuerOrdre(id);

    if (dossier.camcis_circuit && dossier.camcis_circuit !== "VERT") {
      await createAutoTask(id, `🔎 Visite douanière - Dossier ${dossier.numero}`, `Circuit ${dossier.camcis_circuit.toLowerCase()} sur CAMCIS : organisez la visite de la marchandise et saisissez son résultat dans le dossier.`, "acconage");
    }

    await logActivity(req.session.userId, "DOSSIER_VALIDATION_APPROUVEE", "Dossier", id);
    
    // Facture 1 (droits) puis paiement à la banque
    await createAutoTask(id, `🏦 Facture 1 et paiement des droits - Dossier ${dossier.numero}`, `Déclaration CAMCIS validée. Émettez la facture 1 des droits au client, payez les droits à la banque et saisissez la quittance.`, "facturation");

    req.session.success_msg = `Déclaration CAMCIS validée, n° d'ordre ${ordre}. Le dossier passe à « Facture 1 et paiement banque ».`;
    res.redirect(`/dossiers/${id}`);
  } catch (error) {
    console.error("Erreur approuver pipeline status :", error);
    res.status(500).send("Erreur serveur.");
  }
});

// POST /dossiers/:id/pipeline/rejeter - Rejeter Validation (Validation, Super Admin)
router.post("/dossiers/:id/pipeline/rejeter", requireAuth, async (req: any, res: any) => {
  try {
    const id = parseInt(req.params.id);
    const user = req.session.user;
    if (!STAGE_ACTORS.VALIDATION.includes(user.role)) {
      req.session.error_msg = "Accès refusé : rôle non autorisé.";
      return res.redirect(`/dossiers/${id}`);
    }
    if (await wrongStage(req, id, "VALIDATION")) return res.redirect(`/dossiers/${id}`);

    await prisma.dossier.update({
      where: { id },
      data: { pipeline_status: "GUCE" } // Retours arrière vont maintenant au GUCE
    });

    await logActivity(req.session.userId, "DOSSIER_VALIDATION_REJETEE", "Dossier", id);
    req.session.success_msg = "Validation rejetée. Le dossier retourne à l'étape GUCE pour corrections.";
    res.redirect(`/dossiers/${id}`);
  } catch (error) {
    console.error("Erreur rejeter pipeline status :", error);
    res.status(500).send("Erreur serveur.");
  }
});

// POST /dossiers/:id/pipeline/facturer - Facturer (Comptable, Commercial, Super Admin)
router.post("/dossiers/:id/pipeline/facturer", requireAuth, async (req: any, res: any) => {
  try {
    const id = parseInt(req.params.id);
    const user = req.session.user;
    if (!STAGE_ACTORS.FACTURATION.includes(user.role)) {
      req.session.error_msg = "Accès non autorisé : seuls la facturation, la comptabilité et la direction peuvent marquer un dossier facturé.";
      return res.redirect(`/dossiers/${id}`);
    }
    if (await wrongStage(req, id, "FACTURATION")) return res.redirect(`/dossiers/${id}`);

    // La facture 1 (droits) ne suffit pas : il faut la facture finale (débours + honoraires)
    const nbFactures = await prisma.document.count({ where: { dossier_id: id, type: "FACTURE", OR: [{ phase: null }, { phase: { not: "DROITS" } }] } });
    if (!nbFactures) {
      req.session.error_msg = "Générez d'abord la facture finale du dossier avant de la marquer envoyée.";
      return res.redirect(`/dossiers/${id}#finance`);
    }

    const dossier = await prisma.dossier.update({
      where: { id },
      data: { pipeline_status: "CLOTURE" }
    });

    await logActivity(req.session.userId, "DOSSIER_FACTURATION_TERMINEE", "Dossier", id);
    
    // Création d'une tâche de clôture financière
    await createAutoTask(id, `💰 Clôture financière - Dossier ${dossier.numero}`, `Le dossier est marqué comme facturé. Veuillez procéder aux vérifications comptables et à sa clôture d'archive définitive.`, "comptable_ops");

    req.session.success_msg = "Dossier marqué comme facturé. En attente de clôture définitive.";
    res.redirect(`/dossiers/${id}`);
  } catch (error) {
    console.error("Erreur facturer pipeline status :", error);
    res.status(500).send("Erreur serveur.");
  }
});

// POST /dossiers/:id/pipeline/cloturer - Clôturer et Archiver (Comptable_ops, Super Admin)
router.post("/dossiers/:id/pipeline/cloturer", requireAuth, async (req: any, res: any) => {
  try {
    const id = parseInt(req.params.id);
    const user = req.session.user;
    if (!STAGE_ACTORS.CLOTURE.includes(user.role)) {
      req.session.error_msg = "Seule la comptabilité, la direction ou un administrateur peut clôturer définitivement et archiver.";
      return res.redirect(`/dossiers/${id}`);
    }
    if (await wrongStage(req, id, "CLOTURE")) return res.redirect(`/dossiers/${id}`);

    await prisma.dossier.update({
      where: { id },
      data: {
        pipeline_status: "ARCHIVE",
        archived_at: new Date()
      }
    });

    await logActivity(req.session.userId, "DOSSIER_CLOTURE_ARCHIVE", "Dossier", id);
    req.session.success_msg = "Le dossier a été clôturé définitivement et archivé avec succès.";
    res.redirect(`/dossiers/${id}`);
  } catch (error: any) {
    console.error("Erreur clôturer pipeline status :", error);
    req.session.error_msg = "Erreur lors de la clôture / archivage du dossier: " + (error.message || error);
    res.redirect(`/dossiers/${req.params.id}`);
  }
});

// POST /dossiers/:id/pipeline/retour-arriere - Demander une correction (retour à l'étape précédente)
router.post("/dossiers/:id/pipeline/retour-arriere", requireAuth, async (req: any, res: any) => {
  try {
    const id = parseInt(req.params.id);
    const { motif } = req.body;
    if (!motif || motif.trim() === "") {
      req.session.error_msg = "Veuillez fournir un motif / justification pour le retour en arrière.";
      return res.redirect(`/dossiers/${id}`);
    }

    const dossier = await prisma.dossier.findUnique({ where: { id } });
    if (!dossier) {
      req.session.error_msg = "Dossier introuvable.";
      return res.redirect("/dossiers");
    }

    const currentStatus = dossier.pipeline_status;
    const previousStatusMap: Record<string, string> = PREVIOUS_STEP;

    const prevStatus = previousStatusMap[currentStatus];
    if (!prevStatus) {
      req.session.error_msg = `Impossible de reculer depuis le statut de création actuel (${currentStatus}).`;
      return res.redirect(`/dossiers/${id}`);
    }

    // Move status back
    await prisma.dossier.update({
      where: { id },
      data: { pipeline_status: prevStatus }
    });

    // Si on recule depuis BON_PROVISOIR, rejeter le bon provisoire en attente
    if (currentStatus === "BON_PROVISOIR") {
      await prisma.bonProvisoir.updateMany({
        where: { dossier_id: id, etat: "EN_ATTENTE" },
        data: { etat: "REJETE", motif_rejet: motif }
      });
    }

    // Record activity with the custom motif
    await logActivity(
      req.session.userId,
      `RETOUR_ETAPE_${prevStatus}_MOTIF`,
      "Dossier",
      `${id} - Motif: ${motif.trim()}`
    );

    // Mappage pour affecter automatiquement la tâche à l'acteur de l'étape précédente
    const statusToRoleMap: Record<string, string> = {
      "CREE": "secretariat",
      "GUCE": "guce",
      "VALIDATION": "validation",
      "PAIEMENT_DROITS": "facturation",
      "EN_TRAITEMENT": "acconage",
      "BON_PROVISOIR": "acconage",
      "BON_REEL": "acconage",
      "FACTURATION": "facturation",
      "CLOTURE": "comptable_ops"
    };
    
    const prevRole = statusToRoleMap[prevStatus];
    let prevUser = null;
    if (prevRole) {
      prevUser = await prisma.user.findFirst({
        where: { role: prevRole, actif: true }
      });
    }

    // Créer une tâche automatique de correction
    await prisma.tache.create({
      data: {
        dossier_id: id,
        titre: `[Demande de modification] Retour à ${prevStatus} : ${motif.trim()}`,
        intervenant_id: prevUser ? prevUser.id : null,
        etat: "A_FAIRE"
      }
    });

    req.session.success_msg = `Dossier renvoyé à l'étape précédente (${prevStatus}) pour modifications.`;
    res.redirect(`/dossiers/${id}`);
  } catch (error) {
    console.error("Erreur de retour arrière pipeline :", error);
    req.session.error_msg = "Erreur serveur lors de la demande de modification.";
    res.redirect(`/dossiers/${req.params.id}`);
  }
});

// GET /dossiers/:id/print - Printable view
router.get("/dossiers/:id/print", requireAuth, async (req: any, res: any) => {
  try {
    const id = parseInt(req.params.id);
    const dossier = await prisma.dossier.findUnique({
      where: { id },
      include: {
        client: true,
        files: { include: { user: true } },
        taches: true,
        comments: { include: { user: true } }
      }
    });

    if (!dossier) {
      req.session.error_msg = "Dossier introuvable.";
      return res.redirect("/dossiers");
    }

    res.render("dossiers/print", { dossier });
  } catch (error) {
    console.error("Erreur Impression dossier :", error);
    res.status(500).send("Erreur lors de la préparation de l'impression.");
  }
});

// GET /dossiers/:id/edit - Edit form view
router.get("/dossiers/:id/edit", requireAuth, async (req: any, res: any) => {
  try {
    const id = parseInt(req.params.id);
    const dossier = await prisma.dossier.findUnique({
      where: { id },
      include: {
        client: true,
        files: true
      }
    });

    if (!dossier) {
      req.session.error_msg = "Dossier introuvable.";
      return res.redirect("/dossiers");
    }

    const clients = await prisma.client.findMany({ orderBy: { nom: "asc" } });

    res.render("dossiers/edit", { dossier, clients });
  } catch (error) {
    console.error("Erreur GET edit dossier :", error);
    res.status(500).send("Erreur lors du chargement de la page d'édition.");
  }
});

// POST /dossiers/:id/edit - Perform edit and handle file updates
router.post(
  "/dossiers/:id/edit",
  requireAuth,
  dossierCreateUpload.fields([
    { name: "fichier_bl",   maxCount: 1 },
    { name: "fichier_fac",  maxCount: 1 },
    { name: "fichier_sgs",  maxCount: 1 },
    { name: "fichier_di",   maxCount: 1 },
    { name: "fichier_besc", maxCount: 1 },
    { name: "fichier_anor", maxCount: 1 }
  ]),
  async (req: any, res: any) => {
    try {
      const id = parseInt(req.params.id);
      const dossier = await prisma.dossier.findUnique({ where: { id } });
      if (!dossier) {
        req.session.error_msg = "Dossier introuvable.";
        return res.redirect("/dossiers");
      }

      const {
        client_id, numero, port, nature, etat,
        ref_bl, ref_fac, ref_sgs, ref_di, ref_besc, ref_anor,
        contenu, droits_douane, validation, valeur_douane, representant, representant_id,
        fournisseur_nom, fournisseur_pays, transporteur
      } = req.body;

      if (!client_id || !numero || !port || !nature || !ref_bl) {
        req.session.error_msg = "Veuillez remplir correctement tous les champs obligatoires (*).";
        return res.redirect(`/dossiers/${id}/edit`);
      }

      // Check uniqueness of numero (excluding current dossier)
      const existing = await prisma.dossier.findFirst({
        where: {
          numero: numero.trim(),
          NOT: { id }
        }
      });

      if (existing) {
        req.session.error_msg = `Le numéro de dossier ${numero} est déjà utilisé.`;
        return res.redirect(`/dossiers/${id}/edit`);
      }

      const rawDroits = parseFloat(droits_douane);
      const rawValeur = parseFloat(valeur_douane);
      const parsedDroits = (droits_douane && !isNaN(rawDroits)) ? rawDroits : null;
      const parsedValeur = (valeur_douane && !isNaN(rawValeur)) ? rawValeur : null;
      const validationBool = (validation === 'true' || validation === true || validation === 'on');

      const parsedRepId = representant_id ? parseInt(representant_id) : null;
      const repLibreVal = parsedRepId ? null : (representant ? representant.trim() : null);

      await prisma.dossier.update({
        where: { id },
        data: {
          client_id: parseInt(client_id),
          numero: numero.trim(),
          port,
          nature,
          bl: ref_bl.trim(),
          etat: etat || dossier.etat,
          contenu: contenu || null,
          droits_douane: parsedDroits,
          valeur_douane: parsedValeur,
          representant_id: parsedRepId,
          representant_libre: repLibreVal,
          fournisseur_nom: fournisseur_nom ? fournisseur_nom.trim() : null,
          fournisseur_pays: fournisseur_pays ? fournisseur_pays.trim() : null,
          transporteur: transporteur ? transporteur.trim() : null,
          validation: validationBool
        }
      });

      // Handle new file uploads if present
      const dossierDir = path.join(process.cwd(), "uploads", "dossiers", String(id));
      if (!fs.existsSync(dossierDir)) {
        fs.mkdirSync(dossierDir, { recursive: true });
      }

      const files = req.files as { [fieldname: string]: Express.Multer.File[] };
      const fileFields = [
        { name: "fichier_bl", category: "BL", ref: ref_bl },
        { name: "fichier_fac", category: "FAC", ref: ref_fac },
        { name: "fichier_sgs", category: "SGS", ref: ref_sgs },
        { name: "fichier_di", category: "DI", ref: ref_di },
        { name: "fichier_besc", category: "BESC", ref: ref_besc },
        { name: "fichier_anor", category: "ANOR", ref: ref_anor }
      ];

      for (const fField of fileFields) {
        const fileArr = files?.[fField.name];
        if (fileArr && fileArr.length > 0) {
          const file = fileArr[0];
          const destPath = path.join(dossierDir, file.filename);
          
          // Move
          fs.renameSync(file.path, destPath);

          // Delete existing file of same category for this dossier in DB if you want to replace it
          await prisma.dossierFile.deleteMany({
            where: {
              dossier_id: id,
              category: fField.category
            }
          });

          // Save DossierFile
          await prisma.dossierFile.create({
            data: {
              dossier_id: id,
              user_id: req.session.userId,
              filename: file.filename,
              original: file.originalname,
              stage: "CREE",
              category: fField.category,
              comment: fField.ref ? `Réf: ${fField.ref}` : `Document ${fField.category}`,
              path: `/uploads/dossiers/${id}/${file.filename}`
            }
          });
        }
      }

      await logActivity(req.session.userId, "EDITION_DOSSIER_CREATION", "Dossier", id);
      req.session.success_msg = "Le dossier a été mis à jour avec succès !";
      res.redirect("/dossiers");
    } catch (error: any) {
      console.error("Erreur modification dossier :", error);
      req.session.error_msg = "Erreur serveur : " + (error.message || error);
      res.redirect(`/dossiers/${req.params.id}/edit`);
    }
  }
);

export default router;
