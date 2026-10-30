import { Router } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import prisma from "../lib/prismaClient";
import { requireAuth, requireModule } from "./rbac";

const router = Router();

// Setup Multer for representant documents
const uploadDir = path.join(process.cwd(), "uploads", "representants");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const tempDir = path.join(uploadDir, "temp");
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

const repStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, tempDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const cleanedName = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, "_");
    cb(null, `${uniqueSuffix}-${cleanedName}`);
  }
});

const repUpload = multer({
  storage: repStorage,
  limits: { fileSize: 20 * 1024 * 1024 }
});

// Helper for activity logs
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

// GET /representants
router.get("/representants", requireAuth, async (req: any, res: any) => {
  try {
    const reps = await prisma.representant.findMany({
      where: { actif: true },
      include: {
        client_representants: {
          include: {
            client: true
          }
        },
        documents: true
      },
      orderBy: { nom: "asc" }
    });

    res.render("representants/index", { reps });
  } catch (error: any) {
    console.error("Erreur GET /representants :", error);
    res.status(500).send("Erreur lors de la récupération des représentants.");
  }
});

// GET /representants/create
router.get("/representants/create", requireAuth, async (req: any, res: any) => {
  try {
    const clients = await prisma.client.findMany({
      orderBy: { nom: "asc" }
    });
    res.render("representants/create", { clients });
  } catch (error: any) {
    console.error("Erreur GET /representants/create :", error);
    res.status(500).send("Erreur lors du chargement de la page de création.");
  }
});

// POST /representants/create
router.post(
  "/representants/create",
  requireAuth,
  repUpload.fields([
    { name: "fichier_cni_rep", maxCount: 1 },
    { name: "fichier_procu_rep", maxCount: 1 }
  ]),
  async (req: any, res: any) => {
    try {
      const { nom, prenom, tel, email, cni_numero, fonction, client_ids } = req.body;

      if (!nom) {
        return res.status(400).send("Le nom du représentant est requis.");
      }

      const newRep = await prisma.representant.create({
        data: {
          nom: nom.trim(),
          prenom: prenom ? prenom.trim() : null,
          tel: tel ? tel.trim() : null,
          email: email ? email.trim() : null,
          cni_numero: cni_numero ? cni_numero.trim() : null,
          fonction: fonction ? fonction.trim() : null,
          actif: true
        }
      });

      const repIdDir = path.join(uploadDir, String(newRep.id));
      if (!fs.existsSync(repIdDir)) {
        fs.mkdirSync(repIdDir, { recursive: true });
      }

      // Handle linked clients
      let selectedClients: number[] = [];
      if (client_ids) {
        if (Array.isArray(client_ids)) {
          selectedClients = client_ids.map((id: any) => parseInt(id)).filter((id: number) => !isNaN(id));
        } else {
          const parsed = parseInt(client_ids);
          if (!isNaN(parsed)) {
            selectedClients = [parsed];
          }
        }
      }

      let docClientId = 1;
      if (selectedClients.length > 0) {
        docClientId = selectedClients[0];
      } else {
        const defaultClient = await prisma.client.findFirst();
        if (defaultClient) {
          docClientId = defaultClient.id;
        }
      }

      const files = req.files as any;
      if (files) {
        if (files["fichier_cni_rep"] && files["fichier_cni_rep"][0]) {
          const file = files["fichier_cni_rep"][0];
          const destPath = path.join(repIdDir, file.filename);
          fs.renameSync(file.path, destPath);

          await prisma.clientDocument.create({
            data: {
              client_id: docClientId,
              user_id: req.session.userId,
              filename: file.filename,
              original: file.originalname,
              category: "CNI_REP",
              path: `/uploads/representants/${newRep.id}/${file.filename}`,
              comment: `CNI du représentant ${nom} ${prenom || ""}`.trim(),
              representant_id: newRep.id
            }
          });
        }

        if (files["fichier_procu_rep"] && files["fichier_procu_rep"][0]) {
          const file = files["fichier_procu_rep"][0];
          const destPath = path.join(repIdDir, file.filename);
          fs.renameSync(file.path, destPath);

          await prisma.clientDocument.create({
            data: {
              client_id: docClientId,
              user_id: req.session.userId,
              filename: file.filename,
              original: file.originalname,
              category: "PROCU_REP",
              path: `/uploads/representants/${newRep.id}/${file.filename}`,
              comment: `Procuration du représentant ${nom} ${prenom || ""}`.trim(),
              representant_id: newRep.id
            }
          });
        }
      }

      // Link clients
      for (const cId of selectedClients) {
        await prisma.clientRepresentant.create({
          data: {
            client_id: cId,
            representant_id: newRep.id,
            est_principal: false
          }
        }).catch((e) => console.error("Error creating ClientRepresentant relation:", e));
      }

      await logActivity(req.session.userId, "CREATION_REPRESENTANT", "Representant", newRep.id);
      req.session.success_msg = `✅ Représentant ${nom} créé avec succès.`;
      res.redirect(`/representants/${newRep.id}`);
    } catch (error: any) {
      console.error("Erreur POST /representants/create :", error);
      res.status(500).send("Erreur lors de la création du représentant.");
    }
  }
);

// GET /representants/:id
router.get("/representants/:id", requireAuth, async (req: any, res: any) => {
  try {
    const repId = parseInt(req.params.id);
    if (isNaN(repId)) {
      return res.redirect("/representants");
    }

    const rep = await prisma.representant.findUnique({
      where: { id: repId },
      include: {
        client_representants: {
          include: {
            client: true
          }
        },
        documents: true,
        dossiers: {
          include: {
            client: true
          },
          orderBy: { created_at: "desc" }
        }
      }
    });

    if (!rep) {
      return res.redirect("/representants");
    }

    const allClients = await prisma.client.findMany({
      orderBy: { nom: "asc" }
    });

    res.render("representants/detail", { rep, allClients });
  } catch (error: any) {
    console.error("Erreur GET /representants/:id :", error);
    res.status(500).send("Erreur lors de la récupération du représentant.");
  }
});

// GET /representants/:id/edit
router.get("/representants/:id/edit", requireAuth, async (req: any, res: any) => {
  try {
    const repId = parseInt(req.params.id);
    if (isNaN(repId)) {
      return res.redirect("/representants");
    }

    const rep = await prisma.representant.findUnique({
      where: { id: repId },
      include: {
        client_representants: true
      }
    });

    if (!rep) {
      return res.redirect("/representants");
    }

    res.render("representants/edit", { rep });
  } catch (error: any) {
    console.error("Erreur GET /representants/:id/edit :", error);
    res.status(500).send("Erreur de chargement du formulaire d'édition.");
  }
});

// POST /representants/:id/edit
router.post(
  "/representants/:id/edit",
  requireAuth,
  repUpload.fields([
    { name: "fichier_cni_rep", maxCount: 1 },
    { name: "fichier_procu_rep", maxCount: 1 }
  ]),
  async (req: any, res: any) => {
    try {
      const repId = parseInt(req.params.id);
      if (isNaN(repId)) {
        return res.redirect("/representants");
      }

      const { nom, prenom, tel, email, cni_numero, fonction } = req.body;

      if (!nom) {
        return res.status(400).send("Le nom du représentant est requis.");
      }

      const updatedRep = await prisma.representant.update({
        where: { id: repId },
        data: {
          nom: nom.trim(),
          prenom: prenom ? prenom.trim() : null,
          tel: tel ? tel.trim() : null,
          email: email ? email.trim() : null,
          cni_numero: cni_numero ? cni_numero.trim() : null,
          fonction: fonction ? fonction.trim() : null
        }
      });

      const repIdDir = path.join(uploadDir, String(repId));
      if (!fs.existsSync(repIdDir)) {
        fs.mkdirSync(repIdDir, { recursive: true });
      }

      const files = req.files as any;
      if (files) {
        // Find a fallback client ID associated with this representative or any client
        const firstRel = await prisma.clientRepresentant.findFirst({
          where: { representant_id: repId }
        });
        let docClientId = firstRel ? firstRel.client_id : 1;
        if (!firstRel) {
          const defaultClient = await prisma.client.findFirst();
          if (defaultClient) {
            docClientId = defaultClient.id;
          }
        }

        if (files["fichier_cni_rep"] && files["fichier_cni_rep"][0]) {
          const file = files["fichier_cni_rep"][0];
          const destPath = path.join(repIdDir, file.filename);
          fs.renameSync(file.path, destPath);

          // Delete old database records of category CNI_REP for this representant to replace
          await prisma.clientDocument.deleteMany({
            where: { representant_id: repId, category: "CNI_REP" }
          });

          await prisma.clientDocument.create({
            data: {
              client_id: docClientId,
              user_id: req.session.userId,
              filename: file.filename,
              original: file.originalname,
              category: "CNI_REP",
              path: `/uploads/representants/${repId}/${file.filename}`,
              comment: `CNI du représentant ${nom} ${prenom || ""}`.trim(),
              representant_id: repId
            }
          });
        }

        if (files["fichier_procu_rep"] && files["fichier_procu_rep"][0]) {
          const file = files["fichier_procu_rep"][0];
          const destPath = path.join(repIdDir, file.filename);
          fs.renameSync(file.path, destPath);

          // Delete old database records of category PROCU_REP for this representant to replace
          await prisma.clientDocument.deleteMany({
            where: { representant_id: repId, category: "PROCU_REP" }
          });

          await prisma.clientDocument.create({
            data: {
              client_id: docClientId,
              user_id: req.session.userId,
              filename: file.filename,
              original: file.originalname,
              category: "PROCU_REP",
              path: `/uploads/representants/${repId}/${file.filename}`,
              comment: `Procuration du représentant ${nom} ${prenom || ""}`.trim(),
              representant_id: repId
            }
          });
        }
      }

      await logActivity(req.session.userId, "MAJ_REPRESENTANT", "Representant", repId);
      req.session.success_msg = `✅ Représentant ${nom} mis à jour avec succès.`;
      res.redirect(`/representants/${repId}`);
    } catch (error: any) {
      console.error("Erreur POST /representants/:id/edit :", error);
      res.status(500).send("Erreur lors de la mise à jour du représentant.");
    }
  }
);

// POST /representants/:id/link-client
router.post("/representants/:id/link-client", requireAuth, async (req: any, res: any) => {
  try {
    const repId = parseInt(req.params.id);
    const clientId = parseInt(req.body.client_id);

    if (isNaN(repId) || isNaN(clientId)) {
      return res.status(400).json({ error: "Identifiant de client ou représentant invalide." });
    }

    const exists = await prisma.clientRepresentant.findUnique({
      where: {
        client_id_representant_id: {
          client_id: clientId,
          representant_id: repId
        }
      }
    });

    if (!exists) {
      await prisma.clientRepresentant.create({
        data: {
          client_id: clientId,
          representant_id: repId,
          est_principal: false
        }
      });
      await logActivity(req.session.userId, "LIAISON_REPRESENTANT_CLIENT", "Representant", repId);
    }

    res.json({ ok: true });
  } catch (error: any) {
    console.error("Erreur POST /representants/:id/link-client :", error);
    res.status(500).json({ error: error.message });
  }
});

// POST /representants/:id/unlink-client
router.post("/representants/:id/unlink-client", requireAuth, async (req: any, res: any) => {
  try {
    const repId = parseInt(req.params.id);
    const clientId = parseInt(req.body.client_id);

    if (isNaN(repId) || isNaN(clientId)) {
      return res.status(400).json({ error: "Identifiant de client ou représentant invalide." });
    }

    await prisma.clientRepresentant.delete({
      where: {
        client_id_representant_id: {
          client_id: clientId,
          representant_id: repId
        }
      }
    });

    await logActivity(req.session.userId, "DELIAISON_REPRESENTANT_CLIENT", "Representant", repId);
    res.json({ ok: true });
  } catch (error: any) {
    console.error("Erreur POST /representants/:id/unlink-client :", error);
    res.status(500).json({ error: error.message });
  }
});

// PATCH /representants/:id/toggle
router.patch("/representants/:id/toggle", requireAuth, async (req: any, res: any) => {
  try {
    const repId = parseInt(req.params.id);
    if (isNaN(repId)) {
      return res.status(400).json({ error: "Identifiant de représentant invalide." });
    }

    const rep = await prisma.representant.findUnique({
      where: { id: repId }
    });

    if (!rep) {
      return res.status(404).json({ error: "Représentant introuvable." });
    }

    const updated = await prisma.representant.update({
      where: { id: repId },
      data: { actif: !rep.actif }
    });

    await logActivity(req.session.userId, "TOGGLE_REPRESENTANT", "Representant", repId);
    res.json({ ok: true, actif: updated.actif });
  } catch (error: any) {
    console.error("Erreur PATCH /representants/:id/toggle :", error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/clients/:id/representants
router.get("/api/clients/:id/representants", requireAuth, async (req: any, res: any) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ error: "Identifiant de client invalide." });
    }

    const clientReps = await prisma.clientRepresentant.findMany({
      where: { client_id: id },
      include: {
        representant: {
          include: { documents: true }
        }
      }
    });

    const mapped = clientReps.map(cr => {
      return {
        id: cr.representant.id,
        nom: cr.representant.nom,
        prenom: cr.representant.prenom || "",
        fonction: cr.representant.fonction || "",
        cni_numero: cr.representant.cni_numero || "",
        est_principal: cr.est_principal,
        has_cni: cr.representant.documents.some(d => d.category === 'CNI_REP'),
        has_procu: cr.representant.documents.some(d => d.category === 'PROCU_REP')
      };
    });

    res.json(mapped);
  } catch (error: any) {
    console.error("Erreur GET /api/clients/:id/representants :", error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/representants
router.get("/api/representants", requireAuth, async (req: any, res: any) => {
  try {
    const reps = await prisma.representant.findMany({
      where: { actif: true },
      include: {
        documents: true,
        client_representants: {
          include: {
            client: true
          }
        }
      },
      orderBy: { nom: "asc" }
    });

    const mapped = reps.map(r => ({
      id: r.id,
      nom: r.nom,
      prenom: r.prenom || "",
      fonction: r.fonction || "",
      cni_numero: r.cni_numero || "",
      tel: r.tel || "",
      actif: r.actif,
      has_cni: r.documents.some(d => d.category === 'CNI_REP'),
      has_procu: r.documents.some(d => d.category === 'PROCU_REP'),
      clients: r.client_representants.map(cr => ({ id: cr.client.id, nom: cr.client.nom }))
    }));

    res.json(mapped);
  } catch (error: any) {
    console.error("Erreur GET /api/representants :", error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
