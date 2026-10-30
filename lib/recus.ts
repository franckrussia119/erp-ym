import prisma from "./prismaClient";
import { categorieLabel } from "./bons";

// Reçu de caisse : chaque bon payé reçoit un numéro (RC-2026-0001, repart à 1 chaque année) et un reçu
// imprimable que le bénéficiaire signe. La caisse saisit ensuite le n° du reçu papier signé.

async function prochain(annee: number) {
  const last = await prisma.bonProvisoir.findFirst({ where: { recu_numero: { startsWith: `RC-${annee}-` } }, orderBy: { recu_numero: "desc" }, select: { recu_numero: true } });
  const n = last?.recu_numero ? parseInt(last.recu_numero.split("-")[2]) || 0 : 0;
  return n + 1;
}

export async function attribuerRecu(bonId: number, date = new Date()): Promise<string | null> {
  const b = await prisma.bonProvisoir.findUnique({ where: { id: bonId }, select: { recu_numero: true } });
  if (!b || b.recu_numero) return b?.recu_numero || null;
  const annee = date.getFullYear();
  // Deux paiements simultanés : l'index unique et la mise à jour conditionnelle évitent un doublon
  for (let n = await prochain(annee), essai = 0; essai < 20; n++, essai++) {
    const numero = `RC-${annee}-${String(n).padStart(4, "0")}`;
    if (await prisma.bonProvisoir.count({ where: { recu_numero: numero } })) continue;
    try {
      const r = await prisma.bonProvisoir.updateMany({ where: { id: bonId, recu_numero: null }, data: { recu_numero: numero } });
      return r.count ? numero : (await prisma.bonProvisoir.findUnique({ where: { id: bonId }, select: { recu_numero: true } }))?.recu_numero || null;
    } catch { /* numéro pris entre-temps : on essaie le suivant */ }
  }
  return null;
}

// Au démarrage : les bons déjà payés reçoivent leur numéro de reçu, dans l'ordre de paiement
export async function ensureRecus() {
  const list = await prisma.bonProvisoir.findMany({ where: { recu_numero: null, etat: "APPROUVE" }, orderBy: [{ paye_at: "asc" }, { id: "asc" }], select: { id: true, paye_at: true, approved_at: true, created_at: true } });
  for (const b of list) await attribuerRecu(b.id, b.paye_at || b.approved_at || b.created_at);
  if (list.length) console.log(`[RECUS] ${list.length} numéro(s) de reçu attribué(s).`);
}

// Comment le bon a été émis : c'est le classement du registre des bons payés
export const ORIGINES: { key: string; label: string; icon: string; aide: string }[] = [
  { key: "DOSSIER", label: "Bons de dossier", icon: "bi-folder2-open", aide: "Émis depuis un dossier par les services" },
  { key: "DEBOURS", label: "Débours", icon: "bi-folder-plus", aide: "Émis depuis Dépenses internes sur un dossier" },
  { key: "SUPPLEMENT", label: "Bons supplémentaires", icon: "bi-plus-circle", aide: "Complément quand la dépense réelle a dépassé l'avance" },
  { key: "INTERNE", label: "Dépenses internes", icon: "bi-wallet2", aide: "Dépenses de la société, par catégorie" },
];

export function origineDe(b: { type: string; origine?: string | null; bon_parent_id?: number | null }) {
  if (b.bon_parent_id) return "SUPPLEMENT";
  if (b.type === "INTERNE") return "INTERNE";
  return b.origine === "DEBOURS" ? "DEBOURS" : "DOSSIER";
}

export const sousCategorie = (b: { type: string; categorie?: string | null }) => (b.type === "INTERNE" ? categorieLabel(b.categorie) : null);

// Montant en toutes lettres (francs CFA, sans décimales)
const UNITS = ["zéro", "un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf", "dix", "onze", "douze", "treize", "quatorze", "quinze", "seize", "dix-sept", "dix-huit", "dix-neuf"];
const TENS = ["", "", "vingt", "trente", "quarante", "cinquante", "soixante", "soixante", "quatre-vingt", "quatre-vingt"];

function moinsDeCent(n: number): string {
  if (n < 20) return UNITS[n];
  const t = Math.floor(n / 10), u = n % 10;
  if (t === 7 || t === 9) return TENS[t] + (t === 7 && u === 1 ? "-et-" : "-") + UNITS[10 + u];
  if (u === 0) return TENS[t] + (t === 8 ? "s" : "");
  return TENS[t] + (u === 1 && t !== 8 ? "-et-un" : "-" + UNITS[u]);
}

function moinsDeMille(n: number): string {
  const c = Math.floor(n / 100), r = n % 100;
  const cent = c === 0 ? "" : c === 1 ? "cent" : UNITS[c] + "-cent" + (r === 0 ? "s" : "");
  if (!r) return cent;
  return (cent ? cent + "-" : "") + moinsDeCent(r);
}

export function enLettres(montant: number): string {
  let n = Math.round(Math.abs(montant || 0));
  if (n === 0) return "zéro";
  const parts: string[] = [];
  const echelles: [number, string][] = [[1e9, "milliard"], [1e6, "million"]];
  for (const [v, mot] of echelles) {
    const q = Math.floor(n / v);
    if (q) { parts.push(moinsDeMille(q) + "-" + mot + (q > 1 ? "s" : "")); n %= v; }
  }
  const m = Math.floor(n / 1000);
  if (m) { parts.push(m === 1 ? "mille" : moinsDeMille(m).replace(/(cent|vingt)s$/, "$1") + "-mille"); n %= 1000; }
  if (n) parts.push(moinsDeMille(n));
  return parts.join("-");
}
