// Nom d'un dossier : le nom du client, avec le BL et le contenu juste en dessous.
// La référence unique (champ numero) est formée du nom du client et du BL, ex. SOFOMEUTEX-2548956656.

const clean = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();

export function dossierRef(clientNom: string, bl: string): string {
  // Sigle entre parenthèses s'il existe (ex. « … du Cameroun (SABC) » → SABC), sinon les premiers mots
  const sigle = /\(([^)]{2,15})\)/.exec(clientNom || "");
  let nom = clean(sigle ? sigle[1] : clientNom || "");
  if (!sigle) {
    const words = nom.split(" ");
    nom = words[0];
    for (const w of words.slice(1)) { if ((nom + "-" + w).length > 24) break; nom += "-" + w; }
  }
  nom = nom.replace(/ /g, "") || "CLIENT";
  const b = clean(bl || "").replace(/ /g, "");
  return b ? `${nom}-${b}` : nom;
}

// Ajoute -2, -3… si la référence existe déjà (même client, même BL)
export async function uniqueDossierRef(base: string, exists: (ref: string) => Promise<boolean>): Promise<string> {
  let ref = base;
  for (let n = 2; await exists(ref); n++) ref = `${base}-${n}`;
  return ref;
}

export const dossierTitle = (d: any) => (d?.client?.nom || d?.numero || "Dossier").toUpperCase();
export const dossierSub = (d: any) => [d?.bl ? `BL ${d.bl}` : "", d?.contenu || ""].filter(Boolean).join(" · ");
