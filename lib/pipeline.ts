// Référentiel unique du circuit d'un dossier de transit.
// Utilisé par les routes (contrôles, notifications, délais) et par les vues (libellés, couleurs).

export type StepKey =
  | "CREE" | "GUCE" | "VALIDATION" | "PAIEMENT_DROITS" | "EN_TRAITEMENT" | "BON_PROVISOIR"
  | "BON_REEL" | "FACTURATION" | "CLOTURE" | "ARCHIVE";

export interface StepDef {
  key: StepKey;
  n: number;            // numéro d'étape (1..10), sert aussi à la couleur .step-c-N
  label: string;
  icon: string;
  owners: string[];     // rôles prévenus quand le dossier arrive à cette étape
  slaHours: number;     // délai normal de traitement ; 0 = pas de délai
  clientLabel: string;  // libellé affiché au client sur la page de suivi
}

export const STEPS: StepDef[] = [
  { key: "CREE", n: 1, label: "Créé", icon: "bi-plus-circle", owners: ["secretariat"], slaHours: 24,
    clientLabel: "Dossier ouvert" },
  { key: "GUCE", n: 2, label: "GUCE", icon: "bi-globe2", owners: ["guce"], slaHours: 48,
    clientLabel: "Formalités GUCE en cours" },
  { key: "VALIDATION", n: 3, label: "Validation CAMCIS", icon: "bi-patch-check", owners: ["validation"], slaHours: 24,
    clientLabel: "Déclaration en douane (CAMCIS)" },
  { key: "PAIEMENT_DROITS", n: 4, label: "Facture 1 & banque", icon: "bi-bank2", owners: ["facturation", "comptable", "finances"], slaHours: 48,
    clientLabel: "Paiement des droits de douane" },
  { key: "EN_TRAITEMENT", n: 5, label: "En traitement", icon: "bi-gear", owners: ["acconage", "enlevement"], slaHours: 72,
    clientLabel: "Opérations portuaires" },
  // Les visas des bons sont notifiés par le module Bons (lien direct vers le bon) : pas de doublon ici.
  { key: "BON_PROVISOIR", n: 6, label: "Bon provisoire", icon: "bi-receipt", owners: [], slaHours: 24,
    clientLabel: "Opérations portuaires" },
  { key: "BON_REEL", n: 7, label: "Bon réel", icon: "bi-cash-coin", owners: [], slaHours: 72,
    clientLabel: "Enlèvement et livraison" },
  { key: "FACTURATION", n: 8, label: "Facturation", icon: "bi-receipt-cutoff", owners: ["facturation", "comptable"], slaHours: 48,
    clientLabel: "Facturation" },
  { key: "CLOTURE", n: 9, label: "Clôture", icon: "bi-lock", owners: ["comptable_ops"], slaHours: 72,
    clientLabel: "Dossier terminé" },
  { key: "ARCHIVE", n: 10, label: "Archivé", icon: "bi-archive", owners: [], slaHours: 0,
    clientLabel: "Dossier terminé" },
];

// Étape précédente (retour arrière) et rôles autorisés à faire avancer chaque étape
export const PREVIOUS_STEP: Record<string, string> = {
  GUCE: "CREE", VALIDATION: "GUCE", PAIEMENT_DROITS: "VALIDATION", EN_TRAITEMENT: "PAIEMENT_DROITS",
  BON_PROVISOIR: "EN_TRAITEMENT", BON_REEL: "EN_TRAITEMENT", FACTURATION: "BON_REEL",
  CLOTURE: "FACTURATION", ARCHIVE: "CLOTURE",
};

export const STAGE_ACTORS: Record<string, string[]> = {
  CREE: ["secretariat", "secretaire", "super_admin", "pdg", "dg", "dga"],
  GUCE: ["guce", "super_admin", "pdg", "dg", "dga", "auditeur1"],
  VALIDATION: ["validation", "validation_role", "super_admin", "pdg", "dg", "dga", "auditeur1"],
  PAIEMENT_DROITS: ["facturation", "comptable", "finances", "daf", "agent_payeur", "caisse", "super_admin", "pdg", "dg", "dga"],
  FACTURATION: ["facturation", "comptable", "commercial", "super_admin", "comptable_ops", "finances", "pdg", "dg", "dga", "daf", "auditeur1"],
  CLOTURE: ["comptable_ops", "cloture", "super_admin", "direction", "comptable", "pdg", "dg", "dga", "daf", "auditeur1"],
};

export const STEP_BY_KEY: Record<string, StepDef> = Object.fromEntries(STEPS.map((s) => [s.key, s]));

export function stepOf(key?: string | null): StepDef {
  return STEP_BY_KEY[key || "CREE"] || STEPS[0];
}

// Rôles de direction prévenus quand un dossier dépasse son délai
export const MANAGEMENT_ROLES = ["pdg", "dg", "dga"];

// Délai dépassé ? Renvoie le nombre d'heures de retard (0 si dans les temps)
export function hoursLate(dossier: { pipeline_status: string; stage_entered_at?: Date | null; created_at: Date }): number {
  const step = stepOf(dossier.pipeline_status);
  if (!step.slaHours) return 0;
  const since = new Date(dossier.stage_entered_at || dossier.created_at).getTime();
  const elapsed = (Date.now() - since) / 36e5;
  return Math.max(0, Math.floor(elapsed - step.slaHours));
}

// ---------------------------------------------------------------------------
// Pièces obligatoires : un dossier ne peut pas quitter une étape tant qu'elles manquent.
// "files" = catégories de pièces jointes (DossierFile.category), "fields" = champs du dossier.
// ---------------------------------------------------------------------------
export const DOC_CATEGORIES: { key: string; label: string; icon: string }[] = [
  { key: "BL", label: "Connaissement (BL)", icon: "bi-file-earmark-text" },
  { key: "FAC", label: "Facture commerciale", icon: "bi-file-earmark-ruled" },
  { key: "LISTE_COLISAGE", label: "Liste de colisage", icon: "bi-box-seam" },
  { key: "SGS", label: "Attestation SGS", icon: "bi-patch-check" },
  { key: "DI", label: "Déclaration d'importation (DI)", icon: "bi-file-earmark-text" },
  { key: "BESC", label: "BESC", icon: "bi-file-earmark-text" },
  { key: "ANOR", label: "Certificat ANOR", icon: "bi-award" },
  { key: "ASSURANCE", label: "Quittance assurance", icon: "bi-shield-check" },
  { key: "RVC", label: "RVC", icon: "bi-receipt" },
  { key: "CAMCIS", label: "Déclaration CAMCIS", icon: "bi-bank" },
  { key: "QUITTANCE_DOUANE", label: "Quittance de douane", icon: "bi-cash-stack" },
  { key: "BAE", label: "Bon à enlever (BAE)", icon: "bi-unlock" },
  { key: "RECU_PORT", label: "Reçus du port", icon: "bi-anchor" },
  { key: "FACTURE", label: "Facture client", icon: "bi-file-earmark-ruled" },
  { key: "AUTRE", label: "Autre", icon: "bi-file-earmark-zip" },
];

export interface Requirement { key: string; label: string; type: "file" | "field"; }

// Ce qu'il faut avoir AVANT de quitter l'étape (clé = étape de départ)
export const REQUIRED_TO_LEAVE: Record<string, Requirement[]> = {
  CREE: [
    { key: "BL", label: "Connaissement (BL)", type: "file" },
    { key: "FAC", label: "Facture commerciale", type: "file" },
  ],
  GUCE: [
    { key: "ASSURANCE", label: "Quittance assurance", type: "file" },
  ],
  VALIDATION: [
    { key: "camcis_numero", label: "N° de déclaration CAMCIS", type: "field" },
    { key: "camcis_circuit", label: "Circuit de contrôle (vert, jaune, rouge)", type: "field" },
    { key: "gn_numero", label: "N° GN", type: "field" },
    { key: "dau_numero", label: "N° DAU", type: "field" },
    { key: "CAMCIS", label: "Déclaration CAMCIS", type: "file" },
  ],
  // Facture 1 (droits) envoyée au client puis droits payés à la banque : la quittance est saisie ici
  PAIEMENT_DROITS: [
    { key: "facture_droits", label: "Facture 1 (droits de douane)", type: "field" },
    { key: "camcis_quittance", label: "N° de quittance bancaire des droits", type: "field" },
    { key: "QUITTANCE_DOUANE", label: "Quittance de paiement des droits", type: "file" },
  ],
  // Le bon à enlever (BAE) se saisit quand il est disponible, mais il n'est pas obligatoire
};

export function requirementStatus(dossier: any, stage: string) {
  const reqs = REQUIRED_TO_LEAVE[stage] || [];
  const cats = new Set((dossier.files || []).map((f: any) => f.category));
  return reqs.map((r) => ({
    ...r,
    ok: r.type === "file" ? cats.has(r.key)
      : r.key === "facture_droits" ? (dossier.documents || []).some((doc: any) => doc.phase === "DROITS")
      : !!dossier[r.key],
  }));
}

export function missingRequirements(dossier: any, stage: string): string[] {
  const missing = requirementStatus(dossier, stage).filter((r) => !r.ok).map((r) => r.label);
  // Circuit rouge (ou jaune) : la visite douanière doit être terminée avant l'enlèvement
  if (stage === "BON_REEL" && ["ROUGE", "JAUNE"].includes(dossier.camcis_circuit) && !dossier.visite_terminee) {
    missing.push("Visite douanière terminée (circuit " + dossier.camcis_circuit.toLowerCase() + ")");
  }
  return missing;
}

// ---------------------------------------------------------------------------
// Rentabilité d'un dossier : avances, dépenses justifiées, facturé, encaissé.
// Attend un dossier chargé avec bons_provisoir, bons_reel et documents (+ payments).
// ---------------------------------------------------------------------------
export function dossierFinance(d: any) {
  const approved = (d.bons_provisoir || []).filter((b: any) => b.etat === "APPROUVE");
  const avances = approved.reduce((s: number, b: any) => s + (b.montant_demande || 0), 0);
  // avances décaissées dont le bon réel n'a pas encore été saisi
  const nonJustifie = approved.filter((b: any) => !b.bon_reel).reduce((s: number, b: any) => s + (b.montant_demande || 0), 0);
  // dépenses justifiées + droits de douane payés à la banque (refacturés au client en facture 1)
  const depenses = (d.bons_reel || []).reduce((s: number, b: any) => s + (b.montant_reel || 0), 0) + (d.droits_paye_montant || 0);
  const factures = (d.documents || []).filter((doc: any) => doc.type === "FACTURE");
  const facture = factures.reduce((s: number, doc: any) => s + (doc.total_ttc || 0), 0);
  const factureHT = factures.reduce((s: number, doc: any) => s + (doc.total_ht || 0), 0);
  const encaisse = factures.reduce(
    (s: number, doc: any) => s + (doc.payments || []).reduce((t: number, p: any) => t + (p.montant || 0), 0), 0);
  const aRecouvrer = Math.max(0, facture - encaisse);
  const marge = factureHT - depenses;          // la TVA collectée n'est pas une marge
  const nonFacture = Math.max(0, depenses - factureHT);
  return { avances, depenses, facture, encaisse, nonJustifie, aRecouvrer, marge, nonFacture };
}
