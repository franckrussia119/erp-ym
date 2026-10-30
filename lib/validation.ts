import { basePrisma } from "./prismaClient";

// Registre des déclarations validées (CAMCIS) : numéro d'ordre par mois, et dictionnaire des codes tarifaires.

export const APRES_VALIDATION = ["PAIEMENT_DROITS", "EN_TRAITEMENT", "BON_PROVISOIR", "BON_REEL", "FACTURATION", "CLOTURE", "ARCHIVE"];
export const REGISTRE_ROLES = ["validation", "validation_role", "guce", "super_admin", "pdg", "dg", "dga", "daf", "auditeur1", "auditeur2", "analyste"];
export const CODES_EDIT_ROLES = ["validation", "validation_role", "guce", "super_admin", "pdg", "dg", "dga"];

const pad = (n: number, l = 2) => String(n).padStart(l, "0");
export const moisCle = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

// N° d'ordre : AAAA-MM-NNN, la numérotation repart à 001 chaque mois. Un verrou évite deux fois le même numéro.
export async function attribuerOrdre(dossierId: number, quand = new Date()): Promise<string> {
  return basePrisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(424242)");
    const d = await tx.dossier.findUnique({ where: { id: dossierId }, select: { validation_ordre: true } });
    if (d?.validation_ordre) return d.validation_ordre; // dossier revalidé après un retour arrière : il garde son numéro
    const prefix = `${moisCle(quand)}-`;
    const last = await tx.dossier.findFirst({ where: { validation_ordre: { startsWith: prefix } }, orderBy: { validation_ordre: "desc" }, select: { validation_ordre: true } });
    const n = last?.validation_ordre ? parseInt(last.validation_ordre.slice(prefix.length), 10) + 1 : 1;
    const ordre = prefix + pad(n, 3);
    await tx.dossier.update({ where: { id: dossierId }, data: { validation_ordre: ordre, validation_at: quand } });
    return ordre;
  });
}

// Au démarrage : les dossiers déjà validés reçoivent leur numéro, dans l'ordre de leur validation
export async function ensureOrdresValidation() {
  const sans = await basePrisma.dossier.findMany({
    where: { validation_ordre: null, pipeline_status: { in: APRES_VALIDATION } },
    select: { id: true, camcis_date: true, created_at: true },
  });
  if (!sans.length) return;
  const logs = await basePrisma.activityLog.findMany({
    where: { action: "DOSSIER_VALIDATION_APPROUVEE", entity: "Dossier", entity_id: { in: sans.map((d) => String(d.id)) } },
    select: { entity_id: true, created_at: true }, orderBy: { created_at: "asc" },
  });
  const quand = new Map<number, Date>();
  for (const l of logs) { const id = Number(l.entity_id); if (id && !quand.has(id)) quand.set(id, l.created_at); }
  const liste = sans.map((d) => ({ id: d.id, at: quand.get(d.id) || d.camcis_date || d.created_at }))
    .sort((a, b) => a.at.getTime() - b.at.getTime() || a.id - b.id);
  for (const d of liste) await attribuerOrdre(d.id, d.at);
  console.log(`[VALIDATION] ${liste.length} dossier(s) validé(s) numéroté(s) dans le registre.`);
}

// Articles saisis à la validation : [{designation, code}]
export type Article = { designation: string; code: string };
export function lireArticles(body: any): Article[] {
  const arr = (v: any) => (Array.isArray(v) ? v : v === undefined ? [] : [v]);
  const des = arr(body.art_designation), codes = arr(body.art_code);
  const out: Article[] = [];
  des.forEach((d: any, i: number) => {
    const designation = String(d || "").trim().toUpperCase(), code = normCode(codes[i]);
    if (designation || code) out.push({ designation, code });
  });
  return out;
}
export const normCode = (c: any) => String(c || "").replace(/\s+/g, "").replace(/[^\dA-Za-z.]/g, "").toUpperCase();
export const parseArticles = (json?: string | null): Article[] => { try { const a = JSON.parse(json || "[]"); return Array.isArray(a) ? a : []; } catch { return []; } };

// Chaque code saisi enrichit le dictionnaire : on garde la première désignation, on compte les usages
export async function memoriserCodes(articles: Article[]) {
  for (const a of articles) {
    if (!a.code) continue;
    await basePrisma.codeTarifaire.upsert({
      where: { code: a.code },
      create: { code: a.code, designation: a.designation || a.code, usages: 1 },
      update: { usages: { increment: 1 } },
    });
  }
}
