import prisma from "./prismaClient";

// N° de dossier : attribué quand le secrétariat transmet au GUCE (ex. 2026-0001, repart à 1 chaque année).
// Avant le GUCE, un dossier n'a pas de numéro et ne compte pas dans les statistiques.

export const COMPTE = { numero_ordre: { not: null } } as const;

async function prochain(annee: number) {
  const last = await prisma.dossier.findFirst({ where: { numero_ordre: { startsWith: `${annee}-` } }, orderBy: { numero_ordre: "desc" }, select: { numero_ordre: true } });
  const n = last?.numero_ordre ? parseInt(last.numero_ordre.split("-")[1]) || 0 : 0;
  return n + 1;
}

export async function attribuerNumero(id: number, date = new Date()): Promise<string | null> {
  const d = await prisma.dossier.findUnique({ where: { id }, select: { numero_ordre: true } });
  if (!d || d.numero_ordre) return d?.numero_ordre || null;
  const annee = date.getFullYear();
  // Deux transmissions simultanées : la mise à jour conditionnelle et la vérification évitent un doublon
  for (let n = await prochain(annee), essai = 0; essai < 20; n++, essai++) {
    const numero = `${annee}-${String(n).padStart(4, "0")}`;
    if (await prisma.dossier.count({ where: { numero_ordre: numero } })) continue;
    const r = await prisma.dossier.updateMany({ where: { id, numero_ordre: null }, data: { numero_ordre: numero } });
    return r.count ? numero : (await prisma.dossier.findUnique({ where: { id }, select: { numero_ordre: true } }))?.numero_ordre || null;
  }
  return null;
}

// Au démarrage : les dossiers déjà passés au GUCE reçoivent leur numéro, dans l'ordre de création
export async function ensureNumerosDossier() {
  const list = await prisma.dossier.findMany({ where: { numero_ordre: null, pipeline_status: { not: "CREE" } }, orderBy: [{ created_at: "asc" }, { id: "asc" }], select: { id: true, created_at: true } });
  for (const d of list) await attribuerNumero(d.id, d.created_at);
  if (list.length) console.log(`[DOSSIERS] ${list.length} numéro(s) de dossier attribué(s).`);
}
