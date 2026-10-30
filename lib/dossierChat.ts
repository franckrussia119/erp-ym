import prisma, { notifyUsers } from "./prismaClient";
import { stepOf } from "./pipeline";
import { dossierTitle } from "./dossierName";

// Discussion d'un dossier : un groupe façon WhatsApp. Membres = toutes les personnes qui ont travaillé
// sur le dossier (création, étapes, pièces, bons, tâches, messages) + les responsables de l'étape en cours.

export interface ChatAttachment { name: string; original: string; mime: string; size: number; kind: "image" | "video" | "audio" | "file" }

export interface ChatItem {
  k: "msg" | "sys";
  id: string;
  cid?: number;
  at: string;
  uid?: number;
  nom?: string;
  role?: string;
  text: string;
  stage?: string;
  att?: ChatAttachment[];
  mentions?: { id: number; nom: string }[];
  reply?: { cid: number; nom: string; text: string } | null;
  deleted?: boolean;
  seen?: { uid: number; nom: string; at: string }[];
}

export const parseJson = <T>(j: string | null | undefined, dflt: T): T => { try { return j ? JSON.parse(j) : dflt; } catch { return dflt; } };
export const attKind = (mime: string): ChatAttachment["kind"] =>
  mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : "file";

const fullName = (u: any) => [u?.prenom, u?.nom].filter(Boolean).join(" ") || "Utilisateur";

export async function chatMembers(dossierId: number) {
  const d = await prisma.dossier.findUnique({
    where: { id: dossierId },
    select: {
      created_by: true, pipeline_status: true,
      stage_logs: { select: { user_id: true } },
      comments: { select: { user_id: true } },
      files: { select: { user_id: true } },
      bons_provisoir: { select: { demandeur_id: true } },
      taches: { select: { intervenant_id: true } },
    },
  });
  if (!d) return [];
  const ids = new Set<number>();
  const add = (v: any) => { if (typeof v === "number") ids.add(v); };
  add(d.created_by);
  d.stage_logs.forEach((x) => add(x.user_id));
  d.comments.forEach((x) => add(x.user_id));
  d.files.forEach((x) => add(x.user_id));
  d.bons_provisoir.forEach((x) => add(x.demandeur_id));
  d.taches.forEach((x) => add(x.intervenant_id));
  const owners = stepOf(d.pipeline_status).owners;
  return prisma.user.findMany({
    where: { actif: true, OR: [{ id: { in: [...ids] } }, ...(owners.length ? [{ role: { in: owners } }] : [])] },
    select: { id: true, nom: true, prenom: true, role: true },
    orderBy: { nom: "asc" },
  });
}

// Fil de la discussion : messages + changements d'étape (lignes « système » comme dans un groupe)
export async function chatFeed(dossierId: number): Promise<ChatItem[]> {
  const [comments, logs] = await Promise.all([
    prisma.dossierComment.findMany({
      where: { dossier_id: dossierId },
      include: { user: { select: { id: true, nom: true, prenom: true, role: true } }, seen: { orderBy: { seen_at: "asc" } } },
      orderBy: { created_at: "asc" },
    }),
    prisma.dossierStageLog.findMany({ where: { dossier_id: dossierId }, orderBy: { created_at: "asc" } }),
  ]);
  const uids = [...new Set([...logs.map((l) => l.user_id), ...comments.flatMap((c) => c.seen.map((x) => x.user_id))].filter((x): x is number => typeof x === "number"))];
  const users = uids.length ? await prisma.user.findMany({ where: { id: { in: uids } }, select: { id: true, nom: true, prenom: true } }) : [];
  const byId = new Map(users.map((u) => [u.id, u]));
  const byCid = new Map(comments.map((c) => [c.id, c]));
  const preview = (c: any) => c.deleted_at ? "Message supprimé" : (c.contenu || (parseJson<ChatAttachment[]>(c.attachments_json, []).length ? "📎 Pièce jointe" : "")).slice(0, 120);
  const items: ChatItem[] = [
    ...comments.map((c) => {
      const del = !!c.deleted_at;
      const r = c.reply_to_id ? byCid.get(c.reply_to_id) : null;
      return {
        k: "msg" as const, id: `m${c.id}`, cid: c.id, at: c.created_at.toISOString(), uid: c.user_id, nom: fullName(c.user), role: c.user?.role,
        text: del ? "" : c.contenu, stage: stepOf(c.stage).label, deleted: del,
        att: del ? [] : parseJson<ChatAttachment[]>(c.attachments_json, []),
        mentions: del ? [] : parseJson<{ id: number; nom: string }[]>(c.mentions_json, []),
        reply: !del && r ? { cid: r.id, nom: fullName(r.user), text: preview(r) } : null,
        seen: c.seen.filter((x) => x.user_id !== c.user_id).map((x) => ({ uid: x.user_id, nom: fullName(byId.get(x.user_id)), at: x.seen_at.toISOString() })),
      };
    }),
    ...logs.map((l) => {
      const who = l.user_id && byId.get(l.user_id) ? fullName(byId.get(l.user_id)) : "";
      const to = stepOf(l.to_stage).label;
      const text = !l.from_stage ? `${who || "Le secrétariat"} a ouvert le dossier` : `${who ? who + " a passé" : "Passage"} le dossier à l'étape « ${to} »`;
      return { k: "sys" as const, id: `s${l.id}`, at: l.created_at.toISOString(), text };
    }),
  ];
  return items.sort((a, b) => a.at.localeCompare(b.at));
}

// Marque comme vus tous les messages des autres ; renvoie le nombre de nouveaux accusés de lecture
export async function markChatSeen(dossierId: number, userId: number): Promise<number> {
  const unseen = await prisma.dossierComment.findMany({
    where: { dossier_id: dossierId, user_id: { not: userId }, deleted_at: null, seen: { none: { user_id: userId } } },
    select: { id: true },
  });
  if (!unseen.length) return 0;
  const now = new Date();
  await prisma.chatSeen.createMany({ data: unseen.map((c) => ({ comment_id: c.id, user_id: userId, dossier_id: dossierId, seen_at: now })) });
  return unseen.length;
}

// Nouveau message : tous les membres du groupe sont prévenus (sauf l'auteur) ; les personnes mentionnées le sont à part
export async function notifyChat(dossierId: number, authorId: number, text: string, mentionIds: number[] = []) {
  const [d, author, members] = await Promise.all([
    prisma.dossier.findUnique({ where: { id: dossierId }, select: { id: true, numero: true, client: { select: { nom: true } } } }),
    prisma.user.findUnique({ where: { id: authorId }, select: { nom: true, prenom: true } }),
    chatMembers(dossierId),
  ]);
  if (!d) return;
  const tagged = new Set(mentionIds.filter((id) => id !== authorId));
  const ids = members.map((m) => m.id).filter((id) => id !== authorId && !tagged.has(id));
  const extrait = text.length > 140 ? text.slice(0, 137) + "…" : text;
  const link = `/dossiers/${d.id}#chat`;
  if (tagged.size) await notifyUsers([...tagged], `🔔 ${fullName(author)} vous a mentionné`, `${dossierTitle(d)} : ${extrait}`, link);
  await notifyUsers(ids, `💬 ${dossierTitle(d)}`, `${fullName(author)} : ${extrait}`, link);
}
