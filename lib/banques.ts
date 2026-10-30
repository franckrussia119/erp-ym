import { basePrisma } from "./prismaClient";

// Liste des banques de la société, gérée dans Administration › Banques
export const BANQUES_ROLES = ["super_admin", "pdg", "dg", "dga", "daf", "comptable", "finances"];
const DEPART = ["AFRILAND FIRST BANK", "SOCIÉTÉ GÉNÉRALE CAMEROUN (SGC)", "BICEC", "SCB CAMEROUN", "ECOBANK CAMEROUN", "UBA CAMEROUN", "CCA BANK", "BGFIBANK CAMEROUN"];

export async function ensureBanques() {
  if (await basePrisma.banque.count()) return;
  // Banques déjà saisies à la main sur des dossiers, puis les principales banques du pays
  const used = await basePrisma.dossier.findMany({ where: { droits_banque: { not: null } }, select: { droits_banque: true }, distinct: ["droits_banque"] });
  const deja = [...new Set(used.map((u) => String(u.droits_banque).trim().toUpperCase()).filter(Boolean))];
  // « AFRILAND » déjà saisi : on n'ajoute pas « AFRILAND FIRST BANK » en double
  const premierMot = (s: string) => s.split(/[\s(]+/)[0];
  const noms = [...deja, ...DEPART.filter((d) => !deja.some((u) => premierMot(u) === premierMot(d)))];
  let ordre = 0;
  for (const nom of noms) await basePrisma.banque.create({ data: { nom, ordre: ordre++ } }).catch(() => null);
  console.log(`[BANQUES] ${noms.length} banque(s) ajoutée(s) à la liste.`);
}

export const banquesActives = () => basePrisma.banque.findMany({ where: { actif: true }, orderBy: [{ ordre: "asc" }, { nom: "asc" }] });
