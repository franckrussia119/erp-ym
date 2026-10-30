import crypto from "crypto";
import { PrismaClient } from "@prisma/client";
import { currentUserId, baseUrl } from "./context";
import { sendPushToUser } from "./push";
import { sendMail, mailEnabled } from "./mailer";
import { stepOf } from "./pipeline";
import { liveEmit, liveFromWrite } from "./live";

// Client de base, sans hooks : utilisé par les hooks eux-mêmes pour éviter les boucles.
export const basePrisma = new PrismaClient();

// Crée des notifications et les pousse sur les appareils (PWA) des destinataires.
export async function notifyUsers(userIds: number[], titre: string, contenu: string, lien?: string) {
  const unique = [...new Set(userIds)];
  for (const uid of unique) {
    const n = await basePrisma.notification.create({ data: { user_id: uid, titre, contenu, lien: lien || null } });
    liveEmit({ t: "notif", u: uid });
    sendPushToUser(basePrisma, uid, { title: titre, body: contenu, url: lien || "/dashboard", tag: `notif-${n.id}` }).catch(() => {});
  }
}

export async function notifyRoles(roles: string[], titre: string, contenu: string, lien?: string, opts: { skipActor?: boolean } = {}) {
  if (!roles.length) return;
  const actor = currentUserId();
  const users = await basePrisma.user.findMany({ where: { role: { in: roles }, actif: true }, select: { id: true } });
  const ids = users.map((u) => u.id).filter((id) => !(opts.skipActor !== false && id === actor));
  await notifyUsers(ids, titre, contenu, lien);
}

export async function ensureTrackingToken(dossierId: number): Promise<string> {
  const d = await basePrisma.dossier.findUnique({ where: { id: dossierId }, select: { tracking_token: true } });
  if (d?.tracking_token) return d.tracking_token;
  const token = crypto.randomBytes(18).toString("base64url");
  await basePrisma.dossier.update({ where: { id: dossierId }, data: { tracking_token: token } });
  return token;
}

// Message au client (e-mail) avec le lien de suivi du dossier
export async function messageClient(dossierId: number, sujet: string, lignes: string[]) {
  if (!mailEnabled()) return;
  const d = await basePrisma.dossier.findUnique({ where: { id: dossierId }, include: { client: true } });
  if (!d?.client?.email) return;
  const token = await ensureTrackingToken(dossierId);
  const url = `${baseUrl()}/suivi/${token}`;
  await sendMail(d.client.email, `${sujet} · Dossier ${d.numero}`, [`Bonjour ${d.client.nom},`, ...lignes], { url, label: "Suivre mon dossier" });
}

// Étapes qui déclenchent un message au client
const CLIENT_MESSAGES: Record<string, string> = {
  GUCE: "Nous avons ouvert les formalités de votre dossier auprès du GUCE.",
  EN_TRAITEMENT: "Votre déclaration en douane a été validée sur CAMCIS. Les opérations portuaires commencent.",
  FACTURATION: "Les opérations sur votre marchandise sont terminées. Votre facture est en préparation.",
};

async function onStageChange(dossierId: number, from: string | null, to: string) {
  const actor = currentUserId();
  await basePrisma.dossierStageLog.create({ data: { dossier_id: dossierId, from_stage: from, to_stage: to, user_id: actor } });
  const d = await basePrisma.dossier.findUnique({ where: { id: dossierId }, include: { client: { select: { nom: true } } } });
  if (!d) return;
  const step = stepOf(to);
  if (step.owners.length) {
    const delai = step.slaHours ? ` Délai prévu : ${step.slaHours} h.` : "";
    await notifyRoles(step.owners, `📂 Dossier ${d.numero} à votre niveau`,
      `${d.client?.nom || "Client"} · étape « ${step.label} ».${delai}`, `/dossiers/${d.id}`);
  }
  if (CLIENT_MESSAGES[to]) {
    messageClient(dossierId, step.clientLabel, [CLIENT_MESSAGES[to]]).catch((e) => console.error("[CLIENT MSG]", e));
  }
}

const WRITES = new Set(["create", "update", "upsert", "delete", "createMany", "updateMany", "deleteMany"]);

// Centre de coût posé automatiquement quand l'écran ne l'a pas choisi
const DEPT_MODELS = new Set(["CaisseMouvement", "BonProvisoir", "Document", "FactureFournisseur", "Demande"]);
async function withDept(model: string, data: any) {
  if (data && data.departement_id === undefined && !data.departement) {
    const { autoDepartement } = await import("./departements");
    const id = await autoDepartement(model, data);
    if (id) data.departement_id = id;
  }
}

const prisma = basePrisma.$extends({
  query: {
    $allModels: {
      async create({ model, args, query }) {
        if (DEPT_MODELS.has(model)) await withDept(model, args.data);
        return query(args);
      },
      async createMany({ model, args, query }) {
        if (DEPT_MODELS.has(model)) for (const d of (Array.isArray(args.data) ? args.data : [args.data])) await withDept(model, d);
        return query(args);
      },
    },
    notification: {
      async create({ args, query }) {
        const n: any = await query(args);
        if (n?.user_id) liveEmit({ t: "notif", u: n.user_id });
        if (n?.user_id) {
          sendPushToUser(basePrisma, n.user_id, {
            title: n.titre, body: n.contenu, url: n.lien || "/dashboard", tag: `notif-${n.id}`,
          }).catch(() => {});
        }
        return n;
      },
    },
    dossier: {
      async create({ args, query }) {
        (args.data as any).stage_entered_at = new Date();
        const d: any = await query(args);
        if (d?.id) onStageChange(d.id, null, d.pipeline_status || "CREE").catch((e) => console.error("[STAGE]", e));
        return d;
      },
      async update({ args, query }) {
        const next = (args.data as any)?.pipeline_status;
        let prev: string | null = null;
        if (typeof next === "string") {
          const before = await basePrisma.dossier.findUnique({ where: args.where as any, select: { pipeline_status: true } });
          prev = before?.pipeline_status ?? null;
          if (prev !== next) {
            (args.data as any).stage_entered_at = new Date();
            (args.data as any).sla_alert_at = null;
          }
        }
        const d: any = await query(args);
        if (typeof next === "string" && prev !== next && d?.id) {
          onStageChange(d.id, prev, next).catch((e) => console.error("[STAGE]", e));
        }
        return d;
      },
    },
  },
}).$extends({
  // Toute écriture est annoncée aux pages ouvertes (mise à jour en direct)
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        const result = await query(args);
        if (WRITES.has(operation)) {
          try { liveFromWrite(model, result, currentUserId() ?? null); } catch {}
        }
        return result;
      },
    },
  },
});

export default prisma;
