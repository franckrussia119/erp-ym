import prisma from "./prismaClient";

// Règles communes des bons provisoires (dossier ou dépense interne) : visas requis, libellés, liens.

export const VISA_KEYS = ["pdg", "dg", "dga", "daf", "audit"] as const;
export type VisaKey = typeof VISA_KEYS[number];

export const VISA_LABELS: Record<VisaKey, string> = { pdg: "PDG", dg: "DG", dga: "DGA", daf: "DAF", audit: "Audit" };
export const VISA_KEY_BY_ROLE: Record<string, VisaKey> = { pdg: "pdg", dg: "dg", dga: "dga", daf: "daf", auditeur1: "audit", auditeur2: "audit" };
export const ROLES_BY_VISA: Record<VisaKey, string[]> = { pdg: ["pdg"], dg: ["dg"], dga: ["dga"], daf: ["daf"], audit: ["auditeur1", "auditeur2"] };

export const CAISSE_ROLES = ["agent_payeur", "caisse"];
// Tout employé peut demander un bon dans un dossier (sauf le compte en lecture seule), tant que le dossier n'est pas clôturé
export const BON_DOSSIER_CLOSED = ["CLOTURE", "ARCHIVE"];
export const canRequestBon = (role: string, stage?: string | null) => role !== "lecture" && !BON_DOSSIER_CLOSED.includes(String(stage || ""));
// Page où le demandeur saisit son bon réel (dossier ou dépense interne)
export const justifyUrl = (b: { id: number }) => `/depenses/${b.id}/justifier`;
// Rôles qui peuvent ordonner à la caisse de payer avant la fin des visas
export const ORDRE_ROLES = ["pdg", "dg"];
export const NON_REQUIS = "Non requis";

// Dépenses internes : le DAF vise, puis le PDG ; l'audit vise aussi (comme sur tous les bons) ; le DG est informé
export const INTERNAL_PDG_THRESHOLD = parseFloat(process.env.INTERNAL_PDG_THRESHOLD || "500000") || 500000;
export const INTERNE_INFORMES = ["dg"];
// Visa qui doit précéder un autre sur un bon interne
export const VISA_AVANT: Partial<Record<VisaKey, VisaKey>> = { pdg: "daf" };

export const DEPENSE_CATEGORIES: { key: string; label: string; icon: string }[] = [
  { key: "INFORMATIQUE", label: "Informatique et matériel", icon: "bi-laptop" },
  { key: "FACTURE", label: "Facture (eau, électricité, internet…)", icon: "bi-lightning-charge" },
  { key: "SERVICE", label: "Prestation de service", icon: "bi-tools" },
  { key: "FOURNITURES", label: "Fournitures de bureau", icon: "bi-pencil" },
  { key: "TRANSPORT", label: "Transport et déplacement", icon: "bi-car-front" },
  { key: "LOYER", label: "Loyer et charges", icon: "bi-building" },
  { key: "SALAIRE", label: "Salaires et avances", icon: "bi-people" },
  { key: "ENTRETIEN", label: "Entretien et réparation", icon: "bi-wrench-adjustable" },
  { key: "AUTRE", label: "Autre dépense", icon: "bi-three-dots" },
];
export const categorieLabel = (k?: string | null) => DEPENSE_CATEGORIES.find((c) => c.key === k)?.label || k || "Dépense interne";

// Visas exigés pour un nouveau bon
export function requiredVisas(type: string, montant: number): VisaKey[] {
  if (type === "INTERNE") return ["daf", "pdg", "audit"];
  return [...VISA_KEYS];
}

// Données de création : les visas non requis sont marqués « Non requis » pour que la règle « tous les visas » reste unique
export function initialTicks(type: string, montant: number) {
  const req = requiredVisas(type, montant);
  const data: any = {};
  for (const k of VISA_KEYS) {
    if (!req.includes(k)) { data[`tick_${k}`] = true; data[`tick_${k}_by`] = NON_REQUIS; }
  }
  return data;
}

export const allVisas = (b: any) => VISA_KEYS.every((k) => b[`tick_${k}`]);
export const isRequired = (b: any, k: VisaKey) => b[`tick_${k}_by`] !== NON_REQUIS;
export function visaProgress(b: any) {
  const req = VISA_KEYS.filter((k) => isRequired(b, k));
  const done = req.filter((k) => b[`tick_${k}`]);
  return { required: req, done, missing: req.filter((k) => !b[`tick_${k}`]), total: req.length, count: done.length };
}
// La caisse peut payer quand tous les visas requis sont là, ou sur ordre du PDG/DG
export const payable = (b: any) => b.etat === "EN_ATTENTE" && (allVisas(b) || !!b.ordre_paiement_by);

export const bonTitle = (b: any) =>
  b.type === "INTERNE" || !b.dossier ? `Dépense interne · ${categorieLabel(b.categorie)}` : `Dossier ${b.dossier.numero}`;
export const bonLink = (b: any) => `/bons/${b.id}`;

// Titulaires de chaque visa (pour que la caisse sache qui appeler)
export async function visaHolders() {
  const users = await prisma.user.findMany({ where: { role: { in: ["pdg", "dg", "dga", "daf", "auditeur1", "auditeur2"] }, actif: true }, select: { nom: true, prenom: true, role: true } });
  const out: Record<string, string> = {};
  for (const u of users) {
    const k = VISA_KEY_BY_ROLE[u.role];
    const n = [u.prenom, u.nom].filter(Boolean).join(" ");
    out[k] = out[k] ? `${out[k]}, ${n}` : n;
  }
  return out;
}
