import { EventEmitter } from "events";

// Bus d'événements en mémoire : chaque écriture en base est relayée aux navigateurs connectés
// (Server-Sent Events, route /api/live) pour que les pages se mettent à jour sans rechargement.
export interface LiveEvent {
  t: "dossier" | "bon" | "caisse" | "tache" | "document" | "notif" | "chat" | "fil";
  k?: string;           // fiche concernée par une discussion (ex. "demande:12")
  id?: number | null;   // identifiant de l'objet modifié
  d?: number | null;    // dossier concerné, s'il y en a un
  u?: number | null;    // destinataire unique (notifications)
  by?: number | null;   // auteur du changement (ses propres pages ne se rafraîchissent pas)
}

export const liveBus = new EventEmitter();
liveBus.setMaxListeners(0);

// Regroupe les rafales (une transition écrit souvent 3 à 5 lignes) en un seul message par sujet
const pending = new Map<string, LiveEvent>();
let timer: NodeJS.Timeout | null = null;
export function liveEmit(ev: LiveEvent) {
  pending.set(`${ev.t}:${ev.id ?? ""}:${ev.d ?? ""}:${ev.u ?? ""}`, ev);
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    const batch = [...pending.values()];
    pending.clear();
    for (const e of batch) liveBus.emit("ev", e);
  }, 150);
}

// Modèle Prisma -> sujet et dossier concerné
const TOPIC: Record<string, LiveEvent["t"]> = {
  Dossier: "dossier", DossierFile: "dossier", DossierComment: "chat", Conteneur: "dossier", DossierStageLog: "dossier",
  BonProvisoir: "bon", BonReel: "bon",
  CaisseMouvement: "caisse", CaisseCloture: "caisse",
  Tache: "tache", TacheComment: "tache", SubTask: "tache",
  Document: "document", Payment: "document",
};
export function liveFromWrite(model: string, result: any, actor: number | null) {
  const t = TOPIC[model];
  if (!t) return;
  const r = result && typeof result === "object" && !Array.isArray(result) ? result : {};
  liveEmit({ t, id: typeof r.id === "number" ? r.id : null, d: model === "Dossier" ? r.id ?? null : r.dossier_id ?? null, by: actor });
}
