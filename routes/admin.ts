import { Router } from "express";
import { employePourUser } from "../lib/rh";
import bcryptjs from "bcryptjs";
import { requireAuth, requireSuperAdmin } from "./rbac";
import prisma from "../lib/prismaClient";
import path from "path";
import crypto from "crypto";
import { TOUS_ROLES, roleLabel } from "../lib/roles";
import { listBackups, createBackup, backupDir } from "../lib/backup";

const router = Router();

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
    console.error("Erreur de journalisation dans admin.ts :", error);
  }
}

// GET /admin/users - Liste des utilisateurs
router.get("/admin/users", requireAuth, requireSuperAdmin, async (req: any, res: any) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: { created_at: "desc" },
      include: { departement: { select: { nom: true, couleur: true, icone: true } } }
    });
    // Tous les employés (dossiers RH) et les comptes sans dossier : la liste du bouton « Assigner »
    const employes = await prisma.employe.findMany({ where: { actif: true }, include: { departement: { select: { nom: true } } }, orderBy: [{ nom: "asc" }, { prenom: "asc" }] });
    const lies = new Set(employes.map((e) => e.user_id).filter(Boolean));
    const personnes = [
      ...employes.map((e) => {
        const u = e.user_id ? users.find((x) => x.id === e.user_id) : null;
        return { cle: `e${e.id}`, nom: [e.nom, e.prenom].filter(Boolean).join(" "), poste: e.poste, service: e.departement?.nom || u?.departement?.nom || null, email: u?.email || e.email || "", userId: u?.id || null, role: u?.role || null, actif: u ? u.actif : null };
      }),
      ...users.filter((u) => !lies.has(u.id)).map((u) => ({ cle: `u${u.id}`, nom: [u.nom, u.prenom].filter(Boolean).join(" "), poste: null, service: u.departement?.nom || null, email: u.email, userId: u.id, role: u.role, actif: u.actif })),
    ].sort((a, b) => a.nom.localeCompare(b.nom, "fr"));
    res.render("admin/users/index", {
      users,
      personnes,
      roleLabel,
      motDePasse: "Ym-" + crypto.randomBytes(4).toString("hex"),
      path: "/admin/users",
      title: "Gestion des Utilisateurs",
      error_msg: req.session.error_msg || res.locals.error_msg || "",
      success_msg: req.session.success_msg || res.locals.success_msg || ""
    });
    // Nettoyer les messages flash
    req.session.error_msg = null;
    req.session.success_msg = null;
  } catch (error) {
    console.error("[ADMIN USERS] Erreur :", error);
    res.status(500).render("errors/500", { error });
  }
});

// GET /admin/users/create - Formulaire de création
router.get("/admin/users/create", requireAuth, requireSuperAdmin, async (req: any, res: any) => {
  res.render("admin/users/create", {
    services: await prisma.departement.findMany({ where: { actif: true }, orderBy: { ordre: "asc" } }),
    serviceChoisi: parseInt(req.query.departement_id) || null,
    path: "/admin/users",
    title: "Créer un Utilisateur"
  });
});

// POST /admin/users/create - Soumission de création
router.post("/admin/users/create", requireAuth, requireSuperAdmin, async (req: any, res: any) => {
  try {
    const { nom, prenom, email, password, role, societe } = req.body;

    if (!nom || !email || !password || !role || !societe) {
      req.session.error_msg = "Veuillez remplir tous les champs obligatoires.";
      return res.redirect("/admin/users/create");
    }

    // Vérifier si l'email existe déjà
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      req.session.error_msg = "Cette adresse email est déjà associée à un compte.";
      return res.redirect("/admin/users/create");
    }

    // Hasher le mot de passe
    const hashedPassword = await bcryptjs.hash(password, 10);

    const newUser = await prisma.user.create({
      data: {
        nom,
        prenom: prenom || null,
        email,
        password: hashedPassword,
        role,
        societe,
        actif: true,
        force_pwd_change: true, // Forcer le changement au premier login
        departement_id: parseInt(req.body.departement_id) || null,
        created_by: req.session.userId
      }
    });

    await employePourUser(newUser);
    await logActivity(req.session.userId, "CREATE_USER", "User", newUser.id);
    req.session.success_msg = `L'utilisateur ${nom} a été créé avec succès. Le changement de mot de passe sera exigé à sa première connexion.`;
    res.redirect("/admin/users");
  } catch (error) {
    console.error("[ADMIN USER CREATE] Erreur :", error);
    res.status(500).render("errors/500", { error });
  }
});

// GET /admin/users/edit/:id - Formulaire de modification
router.get("/admin/users/edit/:id", requireAuth, requireSuperAdmin, async (req: any, res: any) => {
  try {
    const userId = parseInt(req.params.id);
    const targetUser = await prisma.user.findUnique({ where: { id: userId } });

    if (!targetUser) {
      req.session.error_msg = "Utilisateur introuvable.";
      return res.redirect("/admin/users");
    }

    res.render("admin/users/edit", {
      targetUser,
      services: await prisma.departement.findMany({ where: { OR: [{ actif: true }, { id: targetUser.departement_id ?? -1 }] }, orderBy: { ordre: "asc" } }),
      path: "/admin/users",
      title: "Modifier l'Utilisateur"
    });
  } catch (error) {
    console.error("[ADMIN USER EDIT GET] Erreur :", error);
    res.status(500).render("errors/500", { error });
  }
});

// POST /admin/users/edit/:id - Traitement de la modification
router.post("/admin/users/edit/:id", requireAuth, requireSuperAdmin, async (req: any, res: any) => {
  try {
    const userId = parseInt(req.params.id);
    const { nom, prenom, email, role, societe, actif, force_pwd_change } = req.body;

    const existingUser = await prisma.user.findUnique({ where: { id: userId } });
    if (!existingUser) {
      req.session.error_msg = "Utilisateur introuvable.";
      return res.redirect("/admin/users");
    }

    // Vérifier l'unicité du mail
    if (email !== existingUser.email) {
      const emailDup = await prisma.user.findUnique({ where: { email } });
      if (emailDup) {
        req.session.error_msg = "Cet email est déjà pris par un autre utilisateur.";
        return res.redirect(`/admin/users/edit/${userId}`);
      }
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        nom,
        prenom: prenom || null,
        email,
        role,
        societe,
        actif: actif === "true" || actif === true,
        force_pwd_change: force_pwd_change === "true" || force_pwd_change === true,
        departement_id: parseInt(req.body.departement_id) || null
      }
    });

    await prisma.employe.updateMany({ where: { user_id: userId }, data: { departement_id: updated.departement_id } });

    // Si on a modifié l'utilisateur actuellement connecté, on synchronise sa session
    if (req.session.userId === userId) {
      req.session.user = updated;
    }

    await logActivity(req.session.userId, "UPDATE_USER", "User", userId);
    req.session.success_msg = `Utilisateur ${nom} mis à jour avec succès.`;
    res.redirect("/admin/users");
  } catch (error) {
    console.error("[ADMIN USER EDIT POST] Erreur :", error);
    res.status(500).render("errors/500", { error });
  }
});

// POST /admin/users/toggle/:id - Activer/Désactiver l'utilisateur
router.post("/admin/users/toggle/:id", requireAuth, requireSuperAdmin, async (req: any, res: any) => {
  try {
    const userId = parseInt(req.params.id);
    
    if (userId === req.session.userId) {
      req.session.error_msg = "Vous ne pouvez pas désactiver votre propre compte Super Administrateur.";
      return res.redirect("/admin/users");
    }

    const targetUser = await prisma.user.findUnique({ where: { id: userId } });
    if (!targetUser) {
      req.session.error_msg = "Utilisateur introuvable.";
      return res.redirect("/admin/users");
    }

    const nextState = !targetUser.actif;
    await prisma.user.update({
      where: { id: userId },
      data: { actif: nextState }
    });

    await logActivity(req.session.userId, nextState ? "ENABLE_USER" : "DISABLE_USER", "User", userId);
    req.session.success_msg = `Compte de ${targetUser.nom} ${nextState ? "Activé" : "Désactivé"} avec succès.`;
    res.redirect("/admin/users");
  } catch (error) {
    console.error("[ADMIN USER TOGGLE] Erreur :", error);
    res.status(500).render("errors/500", { error });
  }
});

// POST /admin/users/assigner - Donner un rôle à un employé existant : change le rôle de son compte,
// ou lui ouvre un compte de connexion s'il n'en a pas encore
router.post("/admin/users/assigner", requireAuth, requireSuperAdmin, async (req: any, res: any) => {
  const flash = (k: "error_msg" | "success_msg", m: string) => { req.session[k] = m; res.redirect("/admin/users"); };
  try {
    const role = String(req.body.role || "");
    if (!TOUS_ROLES.includes(role)) return flash("error_msg", "Rôle inconnu.");
    const [type, idTxt] = [String(req.body.personne || "").slice(0, 1), String(req.body.personne || "").slice(1)];
    const id = parseInt(idTxt);
    const emp = type === "e" ? await prisma.employe.findUnique({ where: { id: id || -1 } }) : null;
    const userId = type === "u" ? id : emp?.user_id;
    if (!userId && !emp) return flash("error_msg", "Choisissez un employé dans la liste.");

    if (userId) {
      const u = await prisma.user.findUnique({ where: { id: userId } });
      if (!u) return flash("error_msg", "Compte introuvable.");
      if (u.id === req.session.userId && role !== u.role) return flash("error_msg", "Vous ne pouvez pas changer votre propre rôle.");
      await prisma.user.update({ where: { id: u.id }, data: { role, actif: true } });
      await logActivity(req.session.userId, "ASSIGN_ROLE", "User", u.id);
      const qui = [u.prenom, u.nom].filter(Boolean).join(" ");
      return flash("success_msg", u.role === role
        ? `${qui} a déjà le rôle ${roleLabel(role)}${u.actif ? "" : " ; son compte est réactivé"}. Il se connecte avec ${u.email}.`
        : `${qui} passe de ${roleLabel(u.role)} à ${roleLabel(role)}${u.actif ? "" : " et son compte est réactivé"}. Il se connecte avec ${u.email}.`);
    }

    // Employé sans compte : on lui ouvre un compte lié à son dossier RH
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) return flash("error_msg", "Indiquez l'identifiant de connexion (e-mail) de l'employé.");
    if (password.length < 8) return flash("error_msg", "Le mot de passe provisoire doit faire au moins 8 caractères.");
    if (await prisma.user.findUnique({ where: { email } })) return flash("error_msg", `L'identifiant ${email} est déjà utilisé par un autre compte.`);
    const u = await prisma.user.create({
      data: { nom: emp!.nom, prenom: emp!.prenom, email, role, password: await bcryptjs.hash(password, 10), societe: req.session.user.societe || "YM-TRANSIT", actif: true, force_pwd_change: true, departement_id: emp!.departement_id, created_by: req.session.userId },
    });
    await prisma.employe.update({ where: { id: emp!.id }, data: { user_id: u.id, email: emp!.email || email } });
    await logActivity(req.session.userId, "CREATE_USER", "User", u.id);
    flash("success_msg", `${[emp!.prenom, emp!.nom].filter(Boolean).join(" ")} peut maintenant se connecter comme ${roleLabel(role)}. Identifiant : ${email} · mot de passe provisoire : ${password} (à changer à la première connexion).`);
  } catch (error) {
    console.error("[ADMIN USER ASSIGN] Erreur :", error);
    res.status(500).render("errors/500", { error });
  }
});

// POST /admin/users/reset-pwd/:id - Réinitialiser le mot de passe
router.post("/admin/users/reset-pwd/:id", requireAuth, requireSuperAdmin, async (req: any, res: any) => {
  try {
    const userId = parseInt(req.params.id);
    const { new_password } = req.body;

    if (!new_password || new_password.trim() === "") {
      req.session.error_msg = "Le nouveau mot de passe ne peut pas être vide.";
      return res.redirect("/admin/users");
    }

    const targetUser = await prisma.user.findUnique({ where: { id: userId } });
    if (!targetUser) {
      req.session.error_msg = "Utilisateur introuvable.";
      return res.redirect("/admin/users");
    }

    const hashedPassword = await bcryptjs.hash(new_password, 10);
    await prisma.user.update({
      where: { id: userId },
      data: {
        password: hashedPassword,
        force_pwd_change: true
      }
    });

    await logActivity(req.session.userId, "RESET_PASSWORD", "User", userId);
    req.session.success_msg = `Le mot de passe de ${targetUser.nom} a été réinitialisé. Le changement lui sera imposé.`;
    res.redirect("/admin/users");
  } catch (error) {
    console.error("[ADMIN USER RESET PWD] Erreur :", error);
    res.status(500).render("errors/500", { error });
  }
});

export default router;

// =====================================================================
// Sauvegardes (super admin) : liste, téléchargement, sauvegarde immédiate
// =====================================================================
router.get("/admin/sauvegardes", requireAuth, requireSuperAdmin, async (req: any, res: any) => {
  res.render("admin/sauvegardes", { title: "Sauvegardes", backups: listBackups(), dir: backupDir(), keep: parseInt(process.env.BACKUP_KEEP || "14", 10) });
});

router.post("/admin/sauvegardes", requireAuth, requireSuperAdmin, async (req: any, res: any) => {
  try {
    const b = await createBackup("manuel");
    await logActivity(req.session.userId, "SAUVEGARDE_MANUELLE", "Sauvegarde", b.name);
    req.session.success_msg = `Sauvegarde créée : ${b.name} (${Math.max(1, Math.round(b.size / 1024))} Ko).`;
  } catch (e: any) {
    console.error("[SAUVEGARDE] Échec :", e);
    req.session.error_msg = `La sauvegarde a échoué : ${e.message}`;
  }
  res.redirect("/admin/sauvegardes");
});

router.get("/admin/sauvegardes/:name", requireAuth, requireSuperAdmin, async (req: any, res: any) => {
  const name = path.basename(String(req.params.name));
  if (!listBackups().some((b) => b.name === name)) return res.status(404).send("Sauvegarde introuvable.");
  await logActivity(req.session.userId, "SAUVEGARDE_TELECHARGEE", "Sauvegarde", name);
  res.download(path.join(backupDir(), name), name);
});
