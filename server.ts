import "dotenv/config";
import { dossierTitle, dossierSub } from "./lib/dossierName";
import "./lib/asyncErrors";
import express from "express";
import path from "path";
import session from "express-session";
import prisma from "./lib/prismaClient";
import bcryptjs from "bcryptjs";
import multer from "multer";
import PDFDocument from "pdfkit";
import authRoutes from "./routes/auth";
import dashboardRoutes from "./routes/dashboard";
import documentsRoutes from "./routes/documents";
import tachesRoutes from "./routes/taches";
import dossiersRoutes from "./routes/dossiers";
import analyticsRoutes from "./routes/analytics";
import accountingRoutes from "./routes/accounting";
import clientsRoutes from "./routes/clients";
import representantsRoutes from "./routes/representants";
import { postPaymentEcriture } from "./lib/accounting";
import adminRoutes from "./routes/admin";
import servicesRoutes from "./routes/services";
import demandesRoutes from "./routes/demandes";
import filRoutes from "./routes/fil";
import rhRoutes from "./routes/rh";
import validationRoutes from "./routes/validation";
import { ensureOrdresValidation } from "./lib/validation";
import { ensureBanques } from "./lib/banques";
import { ensureComptesPersonnes } from "./lib/reliquats";
import { ensureNumerosDossier } from "./lib/numeroDossier";
import { ensureRecus } from "./lib/recus";
import { ensureEmployes } from "./lib/rh";
import { renouvelerApresMiseAJour } from "./lib/motsDePasse";
import { ensureRegles, nbAValider } from "./lib/approbations";
import { getLiens } from "./lib/liens";
import { generateRef } from "./lib/generateRef";
import profilRoutes from "./routes/profil";
import bonsRoutes from "./routes/bons";
import operationsRoutes from "./routes/operations";
import caisseRoutes from "./routes/caisse";
import { requestContext } from "./lib/context";
import { startScheduler } from "./lib/scheduler";
import { ensureDepartements } from "./lib/departements";
import { initPush } from "./lib/push";
import { STEPS, stepOf, STAGE_ACTORS } from "./lib/pipeline";
import { requireAuth, requireModule, requireSuperAdmin } from "./routes/rbac";

// Using singleton Prisma imported from ./lib/prismaClient

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

// Configuration d'upload avec Multer (Fichiers transit)
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, process.env.UPLOADS_PATH || "/app/uploads/");
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  },
});
// Création du dossier uploads s'il n'existe pas
import fs from "fs";
import crypto from "crypto";
import { pdfSafe } from "./lib/pdfSafe";
const uploadsDir = process.env.UPLOADS_PATH || "/app/uploads";
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
const upload = multer({ storage });

// Session d'authentification et gestion de l'Iframe
app.set("trust proxy", 1);
let sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret || sessionSecret.startsWith("changez-ceci")) {
  // Pas de secret par défaut codé en dur : un secret aléatoire est généré à chaque démarrage
  // (les sessions sont alors perdues au redémarrage). Définissez SESSION_SECRET en production.
  console.warn("[SECURITE] SESSION_SECRET absent ou par défaut : secret aléatoire temporaire utilisé. Définissez SESSION_SECRET !");
  sessionSecret = crypto.randomBytes(32).toString("hex");
}

app.use(
  session({
    name: "ym_transit_session",
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 24 * 60 * 60 * 1000, // 1 jour
      sameSite: "lax",
      httpOnly: true,
      // "auto" : cookie sécurisé quand la requête arrive en HTTPS (via le proxy Coolify)
      secure: "auto"
    },
  })
);

// Contexte de requête (utilisateur courant) pour les hooks Prisma : notifications, historique des étapes
app.use((req: any, _res: any, next: any) => requestContext.run({ req }, next));

// Body Parser
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use("/assets", express.static(path.join(process.cwd(), "assets"), { maxAge: "1h" }));
// Bibliothèques d'interface servies localement (plus de dépendance aux CDN externes)
const vendorStatic = (dir: string) =>
  express.static(path.join(process.cwd(), "node_modules", dir), { maxAge: "7d", immutable: true });
app.use("/vendor/bootstrap", vendorStatic("bootstrap/dist"));
app.use("/vendor/bootstrap-icons", vendorStatic("bootstrap-icons/font"));
app.use("/vendor/chart.js", vendorStatic("chart.js/dist"));
app.use("/vendor/inter", vendorStatic("@fontsource-variable/inter"));
app.use("/vendor/instrument-sans", vendorStatic("@fontsource-variable/instrument-sans"));
// Les fichiers uploadés (CNI, procurations, reçus...) ne sont accessibles qu'aux utilisateurs connectés
app.use("/uploads", requireAuth, express.static(path.join(process.cwd(), "uploads")));

// Configuration du moteur EJS
app.set("view engine", "ejs");
app.set("views", path.join(process.cwd(), "views"));

// Formateur de date relative pour les discussions
app.locals.timeAgo = (date: any): string => {
  const diff = (Date.now() - new Date(date).getTime()) / 1000;
  if(diff < 60) return "à l'instant";
  if(diff < 3600) return `il y a ${Math.round(diff/60)} min`;
  if(diff < 86400) return `il y a ${Math.round(diff/3600)}h`;
  if(diff < 604800) return `il y a ${Math.round(diff/86400)}j`;
  return new Date(date).toLocaleDateString('fr-FR');
};

// Référentiel des étapes, disponible dans toutes les vues
app.locals.STEPS = STEPS;
app.locals.stepOf = stepOf;
app.locals.dossierTitle = dossierTitle;
app.locals.dossierSub = dossierSub;
app.locals.STAGE_ACTORS = STAGE_ACTORS;

// Middleware global pour injecter les variables de session et messages flash dans EJS
app.use(async (req: any, res: any, next: any) => {
  res.locals.success_msg = req.session.success_msg || "";
  res.locals.error_msg = req.session.error_msg || "";
  req.session.success_msg = "";
  req.session.error_msg = "";

  res.locals.path = req.path;

  if (req.session && req.session.userId) {
    try {
      const u = await prisma.user.findUnique({
        where: { id: req.session.userId },
      });
      res.locals.user = u || undefined;
      
      const count = await prisma.bonProvisoir.count({
        where: { etat: "EN_ATTENTE" }
      });
      res.locals.pendingBonsCount = count;
      res.locals.demandesAValider = u && req.method === "GET" ? await nbAValider(u) : 0;
      // Caisse : bons payés ces 30 derniers jours dont le n° du reçu papier signé n'est pas encore saisi
      res.locals.recusASaisir = u && req.method === "GET" && ["caisse", "agent_payeur"].includes(u.role)
        ? await prisma.bonProvisoir.count({ where: { etat: "APPROUVE", recu_papier: null, recu_scan: null, paye_at: { gte: new Date(Date.now() - 30 * 864e5) } } })
        : 0;
      res.locals.liensExternes = req.method === "GET" ? await getLiens() : [];
    } catch (err) {
      res.locals.user = undefined;
      res.locals.pendingBonsCount = 0;
    }
  } else {
    res.locals.user = undefined;
    res.locals.pendingBonsCount = 0;
  }
  next();
});

// Helper pour enregistrer dans le journal d'activité
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
    console.error("Erreur de journalisation d'activité :", error);
  }
}

// ==================== 1. ROUTES D'AUTHENTIFICATION ====================

app.use(operationsRoutes);
app.use(authRoutes);

// Endpoint de diagnostic pour s'assurer de la synchronisation de Prisma sur Coolify et en production
app.get("/api/debug-prisma", requireAuth, requireSuperAdmin, async (req: any, res: any) => {
  try {
    const fs = await import("fs");
    const path = await import("path");
    const schemaPath = path.resolve("prisma/schema.prisma");
    const schemaContent = fs.existsSync(schemaPath) ? fs.readFileSync(schemaPath, "utf-8") : "Fichier de schéma non trouvé";
    
    const hasRepresentantInSchemaFile = schemaContent.includes("representant");

    // Introspection dynamique des propriétés du modèle Dossier
    let dmmfFields: string[] = [];
    try {
      const keys = Object.keys((prisma as any)._dmmf?.modelMap?.Dossier?.fields || {});
      if (keys.length > 0) {
        dmmfFields = keys;
      }
    } catch (e: any) {
      dmmfFields = ["Impossible de lire dmmf: " + e.message];
    }

    const packageJsonPath = path.resolve("package.json");
    const packageJson = fs.existsSync(packageJsonPath) ? JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) : {};

    // Vérifier si we can query normally
    let dbStatus = "UNKNOWN";
    let dbDossierFields: string[] = [];
    try {
      const firstDossier = await prisma.dossier.findFirst();
      dbStatus = "CONNECTED_OK";
      if (firstDossier) {
        dbDossierFields = Object.keys(firstDossier);
      } else {
        dbDossierFields = ["No dossier found in DB yet"];
      }
    } catch (e: any) {
      dbStatus = "ERROR: " + e.message;
    }

    res.json({
      meta: {
        serverTime: new Date().toISOString(),
        version: packageJson.version,
        environment: process.env.NODE_ENV,
        nodeVersion: process.version,
      },
      fileChecks: {
        schemaFileExists: fs.existsSync(schemaPath),
        hasRepresentantInSchemaFile,
      },
      prismaClient: {
        dmmfFields,
      },
      database: {
        status: dbStatus,
        sampleDossierFields: dbDossierFields,
        urlType: process.env.DATABASE_URL ? (process.env.DATABASE_URL.startsWith("file:") ? "SQLite (Local File)" : "PostgreSQL") : "No URL"
      }
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/", (req: any, res: any) => {
  if (req.session && req.session.userId) {
    res.redirect("/dashboard");
  } else {
    res.render("welcome", { session: req.session });
  }
});

app.use(profilRoutes);
app.use(servicesRoutes);
app.use(demandesRoutes);
app.use(filRoutes);
app.use(rhRoutes);
app.use(validationRoutes);
app.use(adminRoutes);
app.use(bonsRoutes);
app.use(caisseRoutes);

// ==================== NOTIFICATIONS API ROUTES ====================

app.get("/api/notifications/poll", requireAuth, async (req: any, res: any) => {
  try {
    const userId = req.session.userId;
    if (!userId) return res.json({ ok: false, notifications: [] });

    // Only return notifications NOT yet shown in browser
    // AND created in the last 24 hours maximum
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    const newNotifs = await prisma.notification.findMany({
      where: {
        user_id: userId,
        browser_shown: false,
        created_at: { gte: since }
      },
      orderBy: { created_at: "desc" },
      take: 10
    });

    // Mark them as browser_shown immediately so they NEVER fire again
    if (newNotifs.length > 0) {
      await prisma.notification.updateMany({
        where: { id: { in: newNotifs.map(n => n.id) } },
        data: { browser_shown: true }
      });
    }

    // Also return unread count for the bell icon
    const unreadCount = await prisma.notification.count({
      where: { user_id: userId, lu: false }
    });

    const returnedNotifs = newNotifs.map(n => ({
      ...n,
      title: n.titre,
      content: n.contenu,
      url: n.lien
    }));

    res.json({ 
      ok: true, 
      notifications: returnedNotifs,
      unreadCount 
    });
  } catch (e: any) {
    res.json({ ok: false, notifications: [], unreadCount: 0 });
  }
});

// Fetch dropdown list
app.get("/api/notifications/list", requireAuth, async (req: any, res: any) => {
  try {
    const notifs = await prisma.notification.findMany({
      where: { user_id: req.session.userId },
      orderBy: [{ lu: "asc" }, { created_at: "desc" }],
      take: 15
    });
    res.json({ ok: true, notifications: notifs });
  } catch (e: any) {
    res.json({ ok: false, notifications: [] });
  }
});

// Mark notification as read
app.patch("/api/notifications/:id/read", requireAuth, async (req: any, res: any) => {
  try {
    await prisma.notification.update({
      where: { id: parseInt(req.params.id) },
      data: { lu: true }
    });
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false });
  }
});

// Mark ALL as read
app.patch("/api/notifications/read-all", requireAuth, async (req: any, res: any) => {
  try {
    await prisma.notification.updateMany({
      where: { user_id: req.session.userId, lu: false },
      data: { lu: true }
    });
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false });
  }
});

// Recherche globale (barre de recherche du bandeau supérieur)
app.get("/api/search", requireAuth, async (req: any, res: any) => {
  try {
    const q = String(req.query.q || "").trim();
    if (q.length < 2) return res.json({ ok: true, results: [] });

    const [dossiers, clients, documents] = await Promise.all([
      prisma.dossier.findMany({
        where: { OR: [{ numero: { contains: q, mode: "insensitive" } }, { client: { nom: { contains: q, mode: "insensitive" } } }, { bl: { contains: q, mode: "insensitive" } }, { conteneurs: { some: { numero: { contains: q.replace(/[\s-]/g, "").toUpperCase(), mode: "insensitive" } } } }] },
        include: { client: { select: { nom: true } }, conteneurs: { select: { numero: true } } },
        orderBy: { id: "desc" },
        take: 6,
      }),
      prisma.client.findMany({
        where: { OR: [{ nom: { contains: q, mode: "insensitive" } }, { niu: { contains: q, mode: "insensitive" } }] },
        orderBy: { nom: "asc" },
        take: 5,
      }),
      prisma.document.findMany({
        where: { OR: [{ numero: { contains: q, mode: "insensitive" } }, { client: { nom: { contains: q, mode: "insensitive" } } }] },
        include: { client: { select: { nom: true } } },
        orderBy: { id: "desc" },
        take: 5,
      }),
    ]);

    const results = [
      ...dossiers.map((d) => {
        const ctn = d.conteneurs.find((c) => c.numero.includes(q.replace(/[\s-]/g, "").toUpperCase()));
        return { type: "dossier", label: d.numero, sub: [d.client?.nom || "", ctn ? `conteneur ${ctn.numero}` : ""].filter(Boolean).join(" · "), url: `/dossiers/${d.id}` };
      }),
      ...clients.map((c) => ({ type: "client", label: c.nom, sub: c.niu ? `NIU ${c.niu}` : "Client", url: `/clients/${c.id}` })),
      ...documents.map((doc) => ({ type: "document", label: doc.numero, sub: `${doc.type} · ${doc.client?.nom || ""}`, url: `/facturation/${doc.id}` })),
    ];
    res.json({ ok: true, results });
  } catch (error: any) {
    console.error("Erreur recherche globale :", error);
    res.status(500).json({ ok: false, results: [] });
  }
});

app.get("/api/generate-ref", requireAuth, (req: any, res: any) => {
  try {
    const prefix = (req.query.prefix as string || "REF").toUpperCase();
    const ref = generateRef(prefix);
    res.json({ ref });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== 2. TABLEAU DE BORD (DASHBOARD) ====================

app.use(dashboardRoutes);
app.use(documentsRoutes);
app.use(tachesRoutes);
app.use(analyticsRoutes);
app.use(accountingRoutes);
// Fournisseurs, bons de commande et factures fournisseurs retirés (27 octobre) : les anciens liens renvoient au tableau de bord
app.all(["/fournisseurs", "/fournisseurs/*", "/commandes", "/commandes/*", "/factures-fournisseur", "/factures-fournisseur/*"], requireAuth, (req: any, res: any) => res.redirect("/"));

// ==================== 3. OPERATIONS CLIENTS ====================

app.get("/api/clients/:id", requireAuth, async (req: any, res: any) => {
  try {
    const clId = parseInt(req.params.id);
    if (isNaN(clId)) {
      return res.status(400).json({ error: "Identifiant de client invalide" });
    }

    const client = await prisma.client.findUnique({
      where: { id: clId },
      include: {
        client_documents: true
      }
    });

    if (!client) {
      return res.status(404).json({ error: "Client non trouvé" });
    }

    const has_cni = client.client_documents.some(doc => doc.category === "CNI");
    const has_procu = client.client_documents.some(doc => doc.category === "PROCU");

    return res.json({
      id: client.id,
      nom: client.nom,
      representant: client.representant || "",
      niu: client.niu || "",
      rccm: client.rccm || "",
      acf: client.acf || "",
      statut_initial: client.statut_initial || "IMPORTATEUR",
      has_cni,
      has_procu
    });
  } catch (error: any) {
    console.error("Erreur API client detail:", error);
    return res.status(500).json({ error: error.message });
  }
});

app.use(clientsRoutes);
app.use(representantsRoutes);

// ==================== 4. OPERATIONS DOSSIERS DE TRANSIT ====================

app.use(dossiersRoutes);

// ==================== 6. GESTION COMPTABLE (FACTURES / RECETTE / PDFKIT) ====================

app.get("/facturation", requireAuth, requireModule("facturation"), async (req: any, res: any) => {
  try {
    const action = req.query.action;
    const preclId = req.query.client_id;

    const invoicesList = await prisma.document.findMany({
      include: {
        client: true,
        payments: true,
      },
      orderBy: { created_at: "desc" },
    });

    const clientsList = await prisma.client.findMany({
      orderBy: { nom: "asc" },
    });

    // Calculer les données agrégées réelles cumulées
    let totInvoiced = 0;
    let totPaid = 0;
    let totUnpaid = 0;

    invoicesList.forEach((inv) => {
      if (inv.etat !== "ANNULE") {
        totInvoiced += inv.total_ttc;
        const paid = inv.payments ? inv.payments.reduce((sum, p) => sum + p.montant, 0) : 0;
        totPaid += paid;
      }
    });
    totUnpaid = totInvoiced - totPaid;

    // Vue par représentant : ses dossiers, leurs dépenses justifiées, facturé et encaissé
    const vue = req.query.vue === "pieces" ? "pieces" : "representants";
    let groupes: any[] = [];
    if (vue === "representants") {
      const dossiers = await prisma.dossier.findMany({
        where: { numero_ordre: { not: null } },
        select: { id: true, numero: true, numero_ordre: true, bl: true, contenu: true, pipeline_status: true, representant_id: true, client: { select: { nom: true } },
          representant_obj: { select: { id: true, nom: true, prenom: true, tel: true } },
          bons_provisoir: { where: { etat: "APPROUVE" }, select: { montant_demande: true, bon_reel: { select: { montant_reel: true } } } } },
        orderBy: { created_at: "desc" },
      });
      const docsBy = new Map<number, any[]>();
      for (const d of invoicesList) if (d.dossier_id && d.etat !== "ANNULE" && d.type === "FACTURE") docsBy.set(d.dossier_id, [...(docsBy.get(d.dossier_id) || []), d]);
      const map = new Map<string, any>();
      for (const d of dossiers) {
        const key = d.representant_obj ? `R${d.representant_obj.id}` : "SANS";
        if (!map.has(key)) map.set(key, { key, rep: d.representant_obj, dossiers: [], depenses: 0, facture: 0, encaisse: 0 });
        const g = map.get(key);
        const docs = docsBy.get(d.id) || [];
        const depenses = d.bons_provisoir.reduce((t, b) => t + (b.bon_reel ? b.bon_reel.montant_reel : b.montant_demande), 0);
        const facture = docs.reduce((t, x) => t + x.total_ttc, 0);
        const encaisse = docs.reduce((t, x) => t + x.payments.reduce((a: number, p: any) => a + p.montant, 0), 0);
        g.dossiers.push({ ...d, docs, depenses, facture, encaisse });
        g.depenses += depenses; g.facture += facture; g.encaisse += encaisse;
      }
      groupes = [...map.values()].sort((a, b) => (a.key === "SANS" ? 1 : b.key === "SANS" ? -1 : b.facture - a.facture));
    }

    res.render("facturation/index", {
      vue, groupes,
      documents: invoicesList,
      clients: clientsList,
      preselectedClientId: preclId || "",
      stats: {
        totalInvoiced: totInvoiced,
        totalPaid: totPaid,
        totalUnpaid: totUnpaid,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).send("Erreur d'accès à l'administration des comptes.");
  }
});

app.get("/facturation/new", requireAuth, requireModule("facturation"), async (req: any, res: any) => {
  try {
    const { dossier_id, bon_reel_id } = req.query;
    const clients = await prisma.client.findMany({ orderBy: { nom: "asc" } });

    let prefill = null;
    if (dossier_id) {
      const dossier = await prisma.dossier.findUnique({
        where: { id: parseInt(dossier_id as string) },
        include: { client: true }
      });
      if (dossier) {
        const bonReel = bon_reel_id
          ? await prisma.bonReel.findUnique({ where: { id: parseInt(bon_reel_id as string) } })
          : null;

        const autoNumero = generateRef("FAC");

        prefill = {
          dossier_id: dossier.id,
          dossier_numero: dossier.numero,
          client_id: dossier.client_id,
          client_nom: dossier.client.nom,
          montant_acconage: bonReel?.montant_reel || 0,
          ecart: bonReel?.ecart || 0,
          autoNumero
        };
      }
    }
    res.render("facturation/new", { clients, prefill, title: "Nouvelle Facture" });
  } catch (error: any) {
    console.error("Erreur GET /facturation/new :", error);
    res.status(500).send("Erreur de chargement du formulaire de facturation.");
  }
});

app.get("/facturation/:id", requireAuth, requireModule("facturation"), async (req: any, res: any) => {
  try {
    const docId = parseInt(req.params.id);
    const documentItem = await prisma.document.findUnique({
      where: { id: docId },
      include: {
        client: true,
        lines: true,
        payments: true,
      },
    });

    if (!documentItem) {
      req.session.error_msg = "Document comptable égaré.";
      return res.redirect("/facturation");
    }

    res.render("facturation/detail", {
      document: documentItem,
    });
  } catch (error) {
    console.error(error);
    res.status(500).send("Erreur de chargement du document comptable.");
  }
});

app.post("/facturation/new", requireAuth, requireModule("facturation"), async (req: any, res: any) => {
  try {
    const { client_id, type, numero, societe, etat, dossier_id } = req.body;
    if (!client_id || !type || !numero || !societe) {
      req.session.error_msg = "Veuillez configurer correctement l'en-tête de facturation.";
      return res.redirect("/facturation");
    }

    const existing = await prisma.document.findUnique({ where: { numero } });
    if (existing) {
      req.session.error_msg = `La pièce comptable ${numero} est déjà existante.`;
      return res.redirect("/facturation");
    }

    let totalHT = 0;
    let totalTTC = 0;

    let descriptions = req.body.line_descriptions || [];
    let prices = req.body.line_prices || [];
    let quantities = req.body.line_quantities || [];
    let taxes = req.body.line_taxes || [];

    if (!Array.isArray(descriptions)) {
      descriptions = descriptions ? [descriptions] : [];
    }
    if (!Array.isArray(prices)) {
      prices = prices ? [prices] : [];
    }
    if (!Array.isArray(quantities)) {
      quantities = quantities ? [quantities] : [];
    }
    if (!Array.isArray(taxes)) {
      taxes = taxes ? [taxes] : [];
    }

    const linesToCreate = [];
    for (let i = 0; i < descriptions.length; i++) {
      if (!descriptions[i] || !descriptions[i].trim()) continue;
      const pu = parseFloat(prices[i]) || 0;
      const qty = parseInt(quantities[i]) || 1;
      const tot = pu * qty;
      const tax = taxes[i] || "EXONERE";
      
      linesToCreate.push({
        description: descriptions[i].trim(),
        prix_unitaire: pu,
        quantite: qty,
        taxe_id: tax,
        total: tot
      });

      totalHT += tot;
      if (tax === "TVA_19_25") {
        totalTTC += tot * 1.1925;
      } else {
        totalTTC += tot;
      }
    }

    const newDoc = await prisma.document.create({
      data: {
        client_id: parseInt(client_id),
        dossier_id: dossier_id ? parseInt(dossier_id) || null : null,
        type,
        numero,
        societe,
        total_ht: totalHT,
        total_ttc: Math.round(totalTTC),
        etat: etat || "BROUILLON",
        lines: {
          create: linesToCreate
        }
      },
    });

    // Enregistrement d'activité & mise à jour état pipeline à CLOTURE si disponible
    const finalDossierId = dossier_id ? parseInt(dossier_id) : null;
    let dNum = "";

    if (finalDossierId && !isNaN(finalDossierId)) {
      // Une facture finale fait passer un dossier « en facturation » à la clôture ; jamais depuis une autre étape
      const cur = await prisma.dossier.findUnique({ where: { id: finalDossierId }, select: { numero: true, pipeline_status: true } });
      if (cur?.pipeline_status === "FACTURATION") {
        await prisma.dossier.update({ where: { id: finalDossierId }, data: { pipeline_status: "CLOTURE" } });
      }
      dNum = cur?.numero || "";
    } else {
      // Recherche alternative de correspondance par numéro
      const allDossiers = await prisma.dossier.findMany({ select: { id: true, numero: true } });
      for (const d of allDossiers) {
        if (numero.toUpperCase().includes(d.numero.toUpperCase())) {
          dNum = d.numero;
          break;
        }
      }
    }

    if (dNum) {
      await prisma.activityLog.create({
        data: {
          user_id: req.session.userId,
          action: 'document.created',
          entity: 'dossier',
          entity_id: String(dNum),
          meta: JSON.stringify({
            numero: numero,
            montant: totalTTC || 0,
            type: type
          })
        }
      });
    }

    await logActivity(req.session.userId, "CREATION_DOCUMENT", "Document", newDoc.id);
    req.session.success_msg = `La facture ${numero} a été générée avec succès et le dossier est clôturé.`;

    if (finalDossierId && !isNaN(finalDossierId)) {
      res.redirect(`/dossiers/${finalDossierId}`);
    } else {
      res.redirect(`/facturation/${newDoc.id}`);
    }
  } catch (error) {
    console.error(error);
    req.session.error_msg = "Erreur lors de l'initialisation de la facture.";
    res.redirect("/facturation");
  }
});

app.post("/facturation/update-status/:id", requireAuth, requireModule("facturation"), async (req: any, res: any) => {
  try {
    const docId = parseInt(req.params.id);
    const { etat } = req.body;

    await prisma.document.update({
      where: { id: docId },
      data: { etat },
    });

    await logActivity(req.session.userId, "MAJ_FACTURE", "Document", docId);
    req.session.success_msg = "Statut comptable de la pièce modifié.";
    res.redirect(`/facturation/${docId}`);
  } catch (error) {
    console.error(error);
    req.session.error_msg = "Erreur d'actualisation de la facture.";
    res.redirect("/facturation");
  }
});

app.post("/facturation/delete/:id", requireAuth, requireModule("facturation"), async (req: any, res: any) => {
  try {
    const docId = parseInt(req.params.id);
    await prisma.document.delete({ where: { id: docId } });
    await logActivity(req.session.userId, "SUPPRESSION_DOCUMENT", "Document", docId);
    req.session.success_msg = "Pièce de facturation archivée et supprimée.";
    res.redirect("/facturation");
  } catch (error) {
    console.error(error);
    req.session.error_msg = "Erreur de suppression du document comptable.";
    res.redirect("/facturation");
  }
});

// Ajouter des lignes d'imputations
app.post("/facturation/:id/lines/new", requireAuth, requireModule("facturation"), async (req: any, res: any) => {
  try {
    const docId = parseInt(req.params.id);
    const { description, prix_unitaire, quantite, taxe_id } = req.body;

    if (!description || !prix_unitaire || !quantite) {
      req.session.error_msg = "Certains champs tarifaires de la prestation manquent.";
      return res.redirect(`/facturation/${docId}`);
    }

    const pu = parseFloat(prix_unitaire);
    const qty = parseInt(quantite);
    const itemTotal = pu * qty;

    await prisma.invoiceLine.create({
      data: {
        document_id: docId,
        description,
        prix_unitaire: pu,
        quantite: qty,
        taxe_id,
        total: itemTotal,
      },
    });

    // Mettre à jour les totaux globaux du Document
    const allLines = await prisma.invoiceLine.findMany({ where: { document_id: docId } });
    let totalHT = 0;
    let totalTTC = 0;

    allLines.forEach((line) => {
      totalHT += line.total;
      if (line.taxe_id === "TVA_19_25") {
        totalTTC += line.total * 1.1925; // 19.25% TVA Camerounaise standard
      } else {
        totalTTC += line.total; // exonéré (débours administratif)
      }
    });

    await prisma.document.update({
      where: { id: docId },
      data: {
        total_ht: totalHT,
        total_ttc: Math.round(totalTTC),
      },
    });

    await logActivity(req.session.userId, "AJOUT_LIGNE_FACTURE", "Document", docId);
    req.session.success_msg = "Prestation ajoutée à l'assiette comptable.";
    res.redirect(`/facturation/${docId}`);
  } catch (error) {
    console.error(error);
    req.session.error_msg = "Erreur d'imputation de ligne budgétaire.";
    res.redirect(`/facturation/${req.params.id}`);
  }
});

app.post("/facturation/:id/lines/delete/:lineId", requireAuth, requireModule("facturation"), async (req: any, res: any) => {
  try {
    const docId = parseInt(req.params.id);
    const lineId = parseInt(req.params.lineId);

    await prisma.invoiceLine.delete({ where: { id: lineId } });

    // recalculer
    const allLines = await prisma.invoiceLine.findMany({ where: { document_id: docId } });
    let totalHT = 0;
    let totalTTC = 0;

    allLines.forEach((line) => {
      totalHT += line.total;
      if (line.taxe_id === "TVA_19_25") {
        totalTTC += line.total * 1.1925;
      } else {
        totalTTC += line.total;
      }
    });

    await prisma.document.update({
      where: { id: docId },
      data: {
        total_ht: totalHT,
        total_ttc: Math.round(totalTTC),
      },
    });

    await logActivity(req.session.userId, "SUPPRESSION_LIGNE_FACTURE", "Document", docId);
    req.session.success_msg = "Prestation retirée de la facture.";
    res.redirect(`/facturation/${docId}`);
  } catch (error) {
    console.error(error);
    req.session.error_msg = "Erreur de suppression de la ligne.";
    res.redirect(`/facturation/${req.params.id}`);
  }
});

// Enregistrer des règlements Mobile Money, cash ou banque
app.post("/facturation/:id/payments/new", requireAuth, requireModule("facturation"), async (req: any, res: any) => {
  try {
    const docId = parseInt(req.params.id);
    const { montant, moyen, date_paiement } = req.body;

    const documentItem = await prisma.document.findUnique({
      where: { id: docId },
      include: { payments: true, client: true },
    });

    if (!documentItem || !montant) {
      req.session.error_msg = "Montant d'encaissement invalide.";
      return res.redirect(`/facturation/${docId}`);
    }

    const payAmt = parseFloat(montant);
    const sumPaid = documentItem.payments.reduce((sum, p) => sum + p.montant, 0);
    const remaining = documentItem.total_ttc - sumPaid;

    if (payAmt > remaining) {
      req.session.error_msg = "Le montant payé ne peut pas dépasser le solde restant dû !";
      return res.redirect(`/facturation/${docId}`);
    }

    const payDate = date_paiement ? new Date(date_paiement) : new Date();

    await prisma.payment.create({
      data: {
        document_id: docId,
        montant: payAmt,
        moyen,
        date_paiement: payDate,
      },
    });

    const clientNom = documentItem.client?.nom || "Client";
    const userSociete = documentItem.societe || "YM-TRANSIT";

    // Post to General Ledger double-entry system
    await postPaymentEcriture(prisma, {
      userId: req.session.userId,
      societe: userSociete,
      documentNumero: documentItem.numero,
      clientNom: clientNom,
      montant: payAmt,
      date: payDate,
      moyen: moyen || "ESPECES"
    });

    // Mettre à jour l'état si soldé
    if (Math.abs(remaining - payAmt) < 1) {
      await prisma.document.update({
        where: { id: docId },
        data: { etat: "PAYE" },
      });
    } else {
      await prisma.document.update({
        where: { id: docId },
        data: { etat: "EMIS" },
      });
    }

    await logActivity(req.session.userId, "RECEPTION_PAIEMENT", "Document", docId);
    req.session.success_msg = `Paiement enregistré de ${payAmt.toLocaleString()} FCFA !`;
    res.redirect(`/facturation/${docId}`);
  } catch (error) {
    console.error(error);
    req.session.error_msg = "Erreur de traitement comptable du versement.";
    res.redirect(`/facturation/${req.params.id}`);
  }
});

app.post("/facturation/:id/payments/delete/:paymentId", requireAuth, requireModule("facturation"), async (req: any, res: any) => {
  try {
    const docId = parseInt(req.params.id);
    const payId = parseInt(req.params.paymentId);

    await prisma.payment.delete({ where: { id: payId } });

    // Réévaluer le statut de réglé à émis par défaut si le paiement est annulé
    await prisma.document.update({
      where: { id: docId },
      data: { etat: "EMIS" },
    });

    await logActivity(req.session.userId, "ANNULATION_PAIEMENT", "Document", docId);
    req.session.success_msg = "Transaction de règlement annulée et défalquée.";
    res.redirect(`/facturation/${docId}`);
  } catch (error) {
    console.error(error);
    req.session.error_msg = "Erreur d'annulation du versement.";
    res.redirect(`/facturation/${req.params.id}`);
  }
});

// Générateur PDFKit dynamique localisé
app.get("/facturation/:id/pdf", requireAuth, requireModule("facturation"), async (req: any, res: any) => {
  try {
    const docId = parseInt(req.params.id);
    const docDb = await prisma.document.findUnique({
      where: { id: docId },
      include: {
        client: true,
        lines: true,
        payments: true,
        dossier: { select: { numero: true, numero_ordre: true, bl: true } },
      },
    });

    if (!docDb) {
      return res.status(404).send("Document introuvable.");
    }

    // Configurer la réponse HTTP
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${docDb.numero}.pdf"`);

    const doc = pdfSafe(new PDFDocument({ margin: 50 }));
    doc.pipe(res);

    // En-tête de l'entreprise
    doc.fillColor("#0f172a")
       .font("Helvetica-Bold")
       .fontSize(20)
       .text(docDb.societe, 50, 45);
    
    doc.fillColor("#334155")
       .font("Helvetica")
       .fontSize(9)
       .text("Service de Transit & Douane agréé CEMAC", 50, 70)
       .text("Rue de la Marine, Akwa, Douala, Cameroun", 50, 85)
       .text("Téléphone: +237 233 45 67 89 | E-mail: contact@ym-transit.cm", 50, 100);

    // Dessiner une ligne horizontale décorative
    doc.moveTo(50, 120).lineTo(562, 120).stroke("#cbd5e1");

    // Informations du client débiteur à droite
    doc.fillColor("#0f172a")
       .font("Helvetica-Bold")
       .fontSize(11)
       .text("FACTURÉ À :", 350, 135);
    
    doc.fillColor("#334155")
       .font("Helvetica-Bold")
       .fontSize(11)
       .text(docDb.client.nom, 350, 150, { width: 195 });
    // un nom de client long passe sur deux lignes : les lignes suivantes descendent d'autant
    const clientY = 150 + doc.heightOfString(docDb.client.nom, { width: 195 }) + 3;

    doc.font("Helvetica")
       .fontSize(9)
       .text(`N.I.U : ${docDb.client.niu || 'N/A'}`, 350, clientY, { width: 195 })
       .text(`R.C.C.M : ${docDb.client.rccm || 'N/A'}`, 350, clientY + 13, { width: 195 })
       .text(`Adresse : ${docDb.client.adresse || 'Cameroun'}`, 350, clientY + 26, { width: 195 });

    // Informations du document comptable
    doc.fillColor("#0f172a")
       .font("Helvetica-Bold")
       .fontSize(13)
       .text(`${docDb.type} COMPTABLE`, 50, 135);
    
    doc.fillColor("#334155")
       .font("Helvetica")
       .fontSize(9)
       .font("Helvetica-Bold")
       .text(`Facture N° : ${docDb.numero}`, 50, 155, { width: 280 })
       .text(docDb.dossier ? `Dossier N° : ${docDb.dossier.numero_ordre || "—"}` : "Dossier N° : —", 50, 170, { width: 280 })
       .font("Helvetica")
       .text(docDb.dossier ? `Réf. dossier : ${docDb.dossier.numero}${docDb.dossier.bl ? " · BL " + docDb.dossier.bl : ""}` : "", 50, 185, { width: 280 })
       .text(`Date d'émission : ${new Date(docDb.created_at).toLocaleDateString('fr-FR')}`, 50, 200)
       .text(`Statut actuel : ${docDb.etat}`, 50, 215);

    // Dessiner en-tête de tableau pour les lignes de factures
    const tableTop = Math.max(245, clientY + 50);
    doc.rect(50, tableTop, 512, 20).fill("#065f46");
    
    // Titres de colonnes en blanc
    doc.fillColor("#ffffff")
       .font("Helvetica-Bold")
       .fontSize(9)
       .text("Description de la prestation", 60, tableTop + 6)
       .text("P.U (FCFA)", 310, tableTop + 6)
       .text("Qté", 390, tableTop + 6)
       .text("Taxe", 430, tableTop + 6)
       .text("Total HT", 490, tableTop + 6);

    let currentY = tableTop + 20;

    // Remplir le tableau
    doc.fillColor("#334155").font("Helvetica").fontSize(9);
    
    if (docDb.lines && docDb.lines.length > 0) {
      docDb.lines.forEach((line) => {
        // Fond zébré optionnel
        doc.rect(50, currentY, 512, 20).fill(currentY % 40 === 0 ? "#f8fafc" : "#ffffff");
        
        doc.fillColor("#334155")
           .text(line.description, 60, currentY + 6)
           .text(line.prix_unitaire.toLocaleString('fr-FR'), 310, currentY + 6)
           .text(line.quantite.toString(), 395, currentY + 6)
           .text(line.taxe_id === 'TVA_19_25' ? '19.25%' : '0%', 430, currentY + 6)
           .font("Helvetica-Bold")
           .text(line.total.toLocaleString('fr-FR'), 490, currentY + 6)
           .font("Helvetica");
        
        currentY += 20;
      });
    } else {
      doc.text("Aucune ligne de prestation enregistrée.", 60, currentY + 10);
      currentY += 25;
    }

    doc.moveTo(50, currentY).lineTo(562, currentY).stroke("#cbd5e1");
    currentY += 15;

    // Totaux finals
    const totalRecAmt = docDb.payments ? docDb.payments.reduce((sum, p) => sum + p.montant, 0) : 0;
    const remains = docDb.total_ttc - totalRecAmt;

    doc.fillColor("#334155")
       .font("Helvetica")
       .fontSize(9)
       .text("Total Net HT :", 380, currentY)
       .font("Helvetica-Bold")
       .text(`${docDb.total_ht.toLocaleString('fr-FR')} FCFA`, 480, currentY);

    currentY += 15;
    const tvaVal = docDb.total_ttc - docDb.total_ht;
    doc.font("Helvetica")
       .text("TVA (19.25%) :", 380, currentY)
       .font("Helvetica-Bold")
       .text(`${tvaVal.toLocaleString('fr-FR')} FCFA`, 480, currentY);

    currentY += 18;
    // Cadre de surburlignage pour le TTC Net
    doc.rect(370, currentY - 4, 192, 20).fill("#ecfdf5");
    doc.fillColor("#065f46")
       .font("Helvetica-Bold")
       .fontSize(10)
       .text("TOTAL NET TTC :", 380, currentY + 2)
       .text(`${docDb.total_ttc.toLocaleString('fr-FR')} FCFA`, 480, currentY + 2);

    currentY += 25;
    doc.fillColor("#10b981")
       .font("Helvetica")
       .fontSize(9)
       .text("Montant déjà encaissé :", 380, currentY)
       .font("Helvetica-Bold")
       .text(`${totalRecAmt.toLocaleString('fr-FR')} FCFA`, 480, currentY);

    currentY += 15;
    doc.fillColor(remains > 0 ? "#ef4444" : "#64748b")
       .font("Helvetica")
       .text("Solde Restant Dû :", 380, currentY)
       .font("Helvetica-Bold")
       .text(`${remains.toLocaleString('fr-FR')} FCFA`, 480, currentY);

    // Zone de signature
    currentY += 50;
    doc.fillColor("#0f172a")
       .font("Helvetica-Bold")
       .fontSize(9)
       .text("Le Directeur Général / Signature autorisée", 350, currentY);
       
    doc.moveTo(350, currentY + 12).lineTo(530, currentY + 12).stroke("#94a3b8");

    // Conditions de règlement en bas
    doc.fillColor("#64748b")
       .font("Helvetica-Oblique")
       .fontSize(8)
       .text("Arrêté la présente facture à la somme TTC de :", 50, currentY)
       .font("Helvetica-BoldOblique")
       .text(`${docDb.total_ttc.toLocaleString('fr-FR')} Francs CFA.`, 50, currentY + 12);

    doc.font("Helvetica")
       .fontSize(8)
       .text("Conditions: Paiement exigible dans un délai de 15 jours à compter de la réception de la présente. Pénalités de retard applicables.", 50, 720, { align: "center" });

    doc.end();
  } catch (error) {
    console.error(error);
    res.status(500).send("Erreur lors de l'écriture ou génération du manifest de facturation au format PDF.");
  }
});

// ==================== 7. STOCK : page retirée (anciens liens renvoyés au tableau de bord) ====================
app.all(["/stock", "/stock/*"], requireAuth, (req: any, res: any) => res.redirect("/"));

// ==================== 8. NOTES AUDIT LOGS (ADMINISTRATEUR) ====================

app.get("/logs", requireAuth, requireSuperAdmin, async (req: any, res: any) => {
  try {
    const logsList = await prisma.activityLog.findMany({
      include: { user: true },
      orderBy: { created_at: "desc" },
    });

    res.render("logs/index", { logs: logsList });
  } catch (error) {
    console.error(error);
    res.status(500).send("Erreur d'accès à l'audit sécurisé.");
  }
});

// Routine de seeding des comptes de rôles YM-TRANSIT ERP
async function seedAccounts() {
  try {
    const seedData = [
      // 1. Administration (Top Management)
      {
        nom: "Abega",
        prenom: "PDG",
        email: "pdg@ym-transit.cm",
        password: "pdg123",
        role: "pdg",
        societe: "YM-TRANSIT"
      },
      {
        nom: "Fouda",
        prenom: "DG",
        email: "dg@ym-transit.cm",
        password: "dg123",
        role: "dg",
        societe: "YM-TRANSIT"
      },
      {
        nom: "Ngo",
        prenom: "DGA",
        email: "dga@ym-transit.cm",
        password: "dga123",
        role: "dga",
        societe: "YM-TRANSIT"
      },
      {
        nom: "Tchakounte",
        prenom: "DAF",
        email: "daf@ym-transit.cm",
        password: "daf123",
        role: "daf",
        societe: "YM-TRANSIT"
      },
      {
        nom: "Mvondo",
        prenom: "Auditeur 1",
        email: "auditeur1@ym-transit.cm",
        password: "auditeur1123",
        role: "auditeur1",
        societe: "YM-TRANSIT"
      },
      {
        nom: "Kamdem",
        prenom: "Auditeur 2",
        email: "auditeur2@ym-transit.cm",
        password: "auditeur2123",
        role: "auditeur2",
        societe: "YM-TRANSIT"
      },
      // 2. Transit / Opérations
      {
        nom: "Ndzana",
        prenom: "Secrétariat",
        email: "secretariat@ym-transit.cm",
        password: "secretariat123",
        role: "secretariat",
        societe: "YM-TRANSIT"
      },
      {
        nom: "Eboa",
        prenom: "GUCE",
        email: "guce@ym-transit.cm",
        password: "guce123",
        role: "guce",
        societe: "YM-TRANSIT"
      },
      {
        nom: "Talla",
        prenom: "Validation",
        email: "validation@ym-transit.cm",
        password: "validation123",
        role: "validation",
        societe: "YM-TRANSIT"
      },
      {
        nom: "Service Acconage",
        prenom: "Opérations",
        email: "acconage@ym-transit.cm",
        password: "acconage123",
        role: "acconage",
        societe: "YM-TRANSIT"
      },
      {
        nom: "Service Enlèvement et Livraison",
        prenom: "Opérations",
        email: "enlevement@ym-transit.cm",
        password: "enlevement123",
        role: "enlevement",
        societe: "YM-TRANSIT"
      },
      // 3. Finance & Facturation
      {
        nom: "Biya",
        prenom: "Facturation",
        email: "facturation@ym-transit.cm",
        password: "facturation123",
        role: "facturation",
        societe: "YM-TRANSIT"
      },
      {
        nom: "Atangana",
        prenom: "Fiscalité",
        email: "fiscalite@ym-transit.cm",
        password: "fiscalite123",
        role: "fiscalite",
        societe: "YM-TRANSIT"
      },
      {
        nom: "Bell",
        prenom: "Clôture",
        email: "cloture@ym-transit.cm",
        password: "cloture123",
        role: "cloture",
        societe: "YM-TRANSIT"
      },
      {
        nom: "Agent Payeur",
        prenom: "Caisse",
        email: "caisse@ym-transit.cm",
        password: "caisse123",
        role: "agent_payeur",
        societe: "YM-TRANSIT"
      },
      // 4. Autre
      {
        nom: "Yannick Abega",
        prenom: "Super Admin",
        email: "admin@ym-transit.cm",
        password: "admin123",
        role: "super_admin",
        societe: "YM-TRANSIT"
      },
      {
        nom: "Claire Ngo Ntamack",
        prenom: "Comptable Principal",
        email: "compta@ym-transit.cm",
        password: "compta123",
        role: "comptable",
        societe: "YM-TRANSIT"
      },
      {
        nom: "Saliou Ndoumbe",
        prenom: "Commercial Export",
        email: "commercial@ym-transit.cm",
        password: "commercial123",
        role: "commercial",
        societe: "YM-TRANSIT"
      },
      {
        nom: "Mamadou Bello",
        prenom: "Transitaire Opérationnel",
        email: "transit@ym-transit.cm",
        password: "transit123",
        role: "operationnel",
        societe: "YM-TRANSIT"
      },
      {
        nom: "Antoine Ndzana",
        prenom: "Magasinier Kribi",
        email: "magasin@ym-transit.cm",
        password: "magasin123",
        role: "magasinier",
        societe: "YM-TRANSIT"
      },
      {
        nom: "Auditeur Externe",
        prenom: "Lecture Seule",
        email: "lecture@ym-transit.cm",
        password: "lecture123",
        role: "lecture",
        societe: "YM-TRANSIT"
      },
      {
        nom: "Analyste Décisoire",
        prenom: "Analyste",
        email: "analyste@ym-transit.cm",
        password: "analyste123",
        role: "analyste",
        societe: "YM-TRANSIT"
      },
      {
        nom: "Directeur Financier",
        prenom: "Finances",
        email: "finances@ym-transit.cm",
        password: "finances123",
        role: "finances",
        societe: "YM-TRANSIT"
      },
      {
        nom: "Comptable Operations",
        prenom: "Comptabilité",
        email: "compta_ops@ym-transit.cm",
        password: "comptaops123",
        role: "comptable_ops",
        societe: "YM-TRANSIT"
      }
    ];

    // Les comptes de démarrage ne sont créés que tant que personne ne s'est encore connecté
    // (installation neuve). Ensuite, un compte supprimé ou renommé n'est jamais recréé avec
    // son mot de passe par défaut. On ne touche JAMAIS au mot de passe d'un compte existant,
    // et chaque compte créé doit changer son mot de passe à la première connexion.
    const alreadyUsed = await prisma.user.count({ where: { last_login: { not: null } } });
    if (alreadyUsed > 0) {
      console.log("[SEED] Application déjà utilisée : création des comptes initiaux ignorée.");
      return;
    }
    for (const item of seedData) {
      const exists = await prisma.user.findUnique({
        where: { email: item.email }
      });
      if (exists) continue;
      const hashedPassword = await bcryptjs.hash(item.password, 10);
      await prisma.user.create({
        data: {
          nom: item.nom,
          prenom: item.prenom,
          email: item.email,
          password: hashedPassword,
          role: item.role,
          societe: item.societe,
          actif: true,
          force_pwd_change: true,
          created_at: new Date()
        }
      });
      console.log(`[SEED] Compte initial créé : email="${item.email}" (Rôle: ${item.role}) - changement de mot de passe exigé`);
    }
  } catch (error) {
    console.error("[SEED ERROR] Impossible d'alimenter les comptes d'accès :", error);
  }
}

// Page 404 pour toute route inconnue (après toutes les routes)
app.use((req: any, res: any) => {
  if (!res.locals.user) return res.redirect("/login");
  res.status(404).render("errors/404");
});

// Erreur imprévue dans une route : on l'enregistre et on affiche une page d'erreur, le serveur continue
app.use((err: any, req: any, res: any, _next: any) => {
  console.error("[ERREUR]", req.method, req.originalUrl, err);
  if (res.headersSent) return;
  if (req.xhr || (req.headers.accept || "").includes("application/json") || req.is("application/json")) {
    return res.status(500).json({ ok: false, message: "Erreur serveur. L'équipe technique a été prévenue dans les journaux." });
  }
  res.status(500).render("errors/500", { error: err });
});

app.listen(PORT, "0.0.0.0", async () => {
  console.log(`YM-TRANSIT ERP is running on http://localhost:${PORT}`);
  await seedAccounts();
  await renouvelerApresMiseAJour().catch((e) => console.error("[MOTS DE PASSE]", e));
  await ensureDepartements().catch((e) => console.error("[SERVICES]", e));
  await ensureRegles().catch((e) => console.error("[CIRCUITS]", e));
  await ensureEmployes().catch((e) => console.error("[RH]", e));
  await ensureOrdresValidation().catch((e) => console.error("[VALIDATION]", e));
  await ensureNumerosDossier().catch((e) => console.error("[DOSSIERS]", e));
  await ensureRecus().catch((e) => console.error("[RECUS]", e));
  await ensureBanques().catch((e) => console.error("[BANQUES]", e));
  await ensureComptesPersonnes().catch((e) => console.error("[CAISSE]", e));
  initPush();
  if (process.env.DISABLE_REMINDERS !== "true") startScheduler();
});
