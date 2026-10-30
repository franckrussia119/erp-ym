// Les polices standard des PDF (Helvetica) ne connaissent pas certains caractères produits par
// toLocaleString("fr-FR") : l'espace fine insécable des milliers s'affichait « / » (80 /000 F).
// On les remplace par des équivalents imprimables avant chaque écriture.
const MAP: [RegExp, string][] = [
  [/[    ]/g, " "],
  [/−/g, "-"],
  [/…/g, "..."],
];

export const pdfText = (s: any) => (typeof s === "string" ? MAP.reduce((t, [re, r]) => t.replace(re, r), s) : s);

export function pdfSafe<T extends { text: any; widthOfString: any; heightOfString: any }>(doc: T): T {
  for (const fn of ["text", "widthOfString", "heightOfString"] as const) {
    const orig = (doc as any)[fn].bind(doc);
    (doc as any)[fn] = (s: any, ...rest: any[]) => orig(pdfText(s), ...rest);
  }
  return doc;
}
