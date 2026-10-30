import { basePrisma } from "./prismaClient";

// Liens vers les autres plateformes de l'entreprise (ex. la plateforme de gestion des camions),
// affichés dans le menu et réglés dans Administration › Plateformes externes.
export type Lien = { nom: string; url: string; icone: string };
export const LIEN_ICONS = ["bi-truck", "bi-globe2", "bi-box-arrow-up-right", "bi-people", "bi-calculator", "bi-megaphone", "bi-boxes", "bi-geo-alt", "bi-telephone", "bi-envelope"];
const CLE = "liens_externes";
const DEFAULT_TRANSPORT_URL = "https://accounting.ym-transit.com"; // plateforme transport de l'entreprise
let cache: { at: number; liens: Lien[] } | null = null;

export const urlValide = (u: string) => { try { const x = new URL(u); return x.protocol === "https:" || x.protocol === "http:"; } catch { return false; } };

export async function getLiens(): Promise<Lien[]> {
  if (cache && Date.now() - cache.at < 60_000) return cache.liens;
  let liens: Lien[] = [];
  const p = await basePrisma.parametre.findUnique({ where: { cle: CLE } }).catch(() => null);
  if (p) { try { liens = JSON.parse(p.valeur); } catch { liens = []; } }
  // Avant tout réglage dans l'application : variable TRANSPORT_URL, sinon l'adresse de la plateforme transport
  else liens = [{ nom: "Transport (camions)", url: process.env.TRANSPORT_URL && urlValide(process.env.TRANSPORT_URL) ? process.env.TRANSPORT_URL : DEFAULT_TRANSPORT_URL, icone: "bi-truck" }];
  cache = { at: Date.now(), liens };
  return liens;
}

export async function setLiens(liens: Lien[]) {
  const valeur = JSON.stringify(liens);
  await basePrisma.parametre.upsert({ where: { cle: CLE }, create: { cle: CLE, valeur }, update: { valeur } });
  cache = null;
}
