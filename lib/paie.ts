import { basePrisma } from "./prismaClient";

// Paie Cameroun : cotisations CNPS, IRPP et centimes additionnels, CFC, FNE, RAV, TDL.
// Tous les taux et barèmes sont réglables dans RH › Barème de paie (lois de finances successives) ;
// les valeurs ci-dessous ne sont que le point de départ et doivent être confirmées par le comptable.

export type Tranche = { jusqua: number | null; valeur: number }; // jusqu'à (inclus), null = au-delà
export type Bareme = {
  cnps_plafond: number;           // plafond mensuel des cotisations vieillesse et allocations familiales
  cnps_salarie: number;           // pension vieillesse, part salariale (%)
  cnps_pension_employeur: number; // pension vieillesse, part patronale (%)
  cnps_af_employeur: number;      // allocations familiales (%)
  cnps_at_employeur: number;      // accidents du travail (%) : 1,75 / 2,5 / 5 selon le risque
  irpp_abattement_frais: number;  // abattement pour frais professionnels (%)
  irpp_abattement_annuel: number; // abattement forfaitaire annuel (F)
  irpp_seuil_mensuel: number;     // salaire brut en dessous duquel l'IRPP n'est pas dû
  irpp_tranches: Tranche[];       // barème annuel (taux en %)
  cac: number;                    // centimes additionnels communaux (% de l'IRPP)
  cfc_salarie: number;            // crédit foncier, part salariale (%)
  cfc_employeur: number;          // crédit foncier, part patronale (%)
  fne_employeur: number;          // fonds national de l'emploi (%)
  rav: Tranche[];                 // redevance audiovisuelle : montant mensuel selon le brut
  tdl: Tranche[];                 // taxe de développement local : montant mensuel selon le salaire de base
  jours_mois: number;             // base de calcul d'une journée d'absence
};

export const BAREME_DEFAUT: Bareme = {
  cnps_plafond: 750000,
  cnps_salarie: 4.2,
  cnps_pension_employeur: 4.2,
  cnps_af_employeur: 7,
  cnps_at_employeur: 1.75,
  irpp_abattement_frais: 30,
  irpp_abattement_annuel: 500000,
  irpp_seuil_mensuel: 62000,
  irpp_tranches: [{ jusqua: 2000000, valeur: 10 }, { jusqua: 3000000, valeur: 15 }, { jusqua: 5000000, valeur: 25 }, { jusqua: null, valeur: 35 }],
  cac: 10,
  cfc_salarie: 1,
  cfc_employeur: 1.5,
  fne_employeur: 1,
  rav: [
    { jusqua: 50000, valeur: 0 }, { jusqua: 100000, valeur: 750 }, { jusqua: 200000, valeur: 1950 }, { jusqua: 300000, valeur: 3250 },
    { jusqua: 400000, valeur: 4550 }, { jusqua: 500000, valeur: 5850 }, { jusqua: 600000, valeur: 7150 }, { jusqua: 700000, valeur: 8450 },
    { jusqua: 800000, valeur: 9750 }, { jusqua: 900000, valeur: 11050 }, { jusqua: 1000000, valeur: 12350 }, { jusqua: null, valeur: 13000 },
  ],
  tdl: [
    { jusqua: 62000, valeur: 0 }, { jusqua: 75000, valeur: 250 }, { jusqua: 100000, valeur: 500 }, { jusqua: 125000, valeur: 750 },
    { jusqua: 150000, valeur: 1000 }, { jusqua: 200000, valeur: 1250 }, { jusqua: 250000, valeur: 1500 }, { jusqua: 300000, valeur: 2000 },
    { jusqua: 500000, valeur: 2250 }, { jusqua: null, valeur: 2500 },
  ],
  jours_mois: 30,
};

const CLE = "bareme_paie";
export async function getBareme(): Promise<Bareme> {
  const p = await basePrisma.parametre.findUnique({ where: { cle: CLE } }).catch(() => null);
  if (!p) return BAREME_DEFAUT;
  try { return { ...BAREME_DEFAUT, ...JSON.parse(p.valeur) }; } catch { return BAREME_DEFAUT; }
}
export async function setBareme(b: Bareme) {
  const valeur = JSON.stringify(b);
  await basePrisma.parametre.upsert({ where: { cle: CLE }, create: { cle: CLE, valeur }, update: { valeur } });
}

export type Prime = { libelle: string; montant: number; imposable: boolean };
export const parsePrimes = (s?: string | null): Prime[] => {
  try {
    const a = s ? JSON.parse(s) : [];
    return Array.isArray(a) ? a.map((p: any) => ({ libelle: String(p.libelle || "Prime").slice(0, 60), montant: Math.max(0, Math.round(Number(p.montant) || 0)), imposable: p.imposable !== false })).filter((p) => p.montant > 0) : [];
  } catch { return []; }
};

const r = (n: number) => Math.round(n);
const pct = (base: number, taux: number) => r((base * taux) / 100);
const parTranche = (montant: number, tranches: Tranche[]) => (tranches.find((t) => t.jusqua === null || montant <= t.jusqua) || { valeur: 0 }).valeur;

// Impôt annuel par tranches successives
export function irppAnnuel(revenu: number, tranches: Tranche[]) {
  let impot = 0, bas = 0;
  for (const t of tranches) {
    const haut = t.jusqua ?? Infinity;
    if (revenu > bas) impot += (Math.min(revenu, haut) - bas) * t.valeur / 100;
    bas = haut;
    if (revenu <= haut) break;
  }
  return impot;
}

export type Calcul = {
  base: number; retenue_absence: number; primes: Prime[]; brut: number; brut_imposable: number; non_imposable: number;
  cnps_base: number; cnps_salarie: number; net_imposable_annuel: number; irpp: number; cac: number; cfc: number; rav: number; tdl: number;
  total_retenues: number; avance: number; net: number;
  employeur: { pension: number; af: number; at: number; cfc: number; fne: number; total: number };
  cout_total: number;
  taux: { cnps: number; cac: number; cfc: number };
};

export function calculer(input: { salaire_base: number; jours_absence?: number; primes?: Prime[]; avance?: number }, b: Bareme): Calcul {
  const base = Math.max(0, input.salaire_base || 0);
  const retenue_absence = r(Math.min(base, (base / (b.jours_mois || 30)) * Math.max(0, input.jours_absence || 0)));
  const primes = input.primes || [];
  const imposables = primes.filter((p) => p.imposable).reduce((t, p) => t + p.montant, 0);
  const non_imposable = primes.filter((p) => !p.imposable).reduce((t, p) => t + p.montant, 0);
  const brut_imposable = base - retenue_absence + imposables;
  const brut = brut_imposable + non_imposable;

  const cnps_base = Math.min(brut_imposable, b.cnps_plafond);
  const cnps_salarie = pct(cnps_base, b.cnps_salarie);
  // Revenu net imposable : brut imposable moins frais professionnels et cotisation CNPS, sur l'année, moins l'abattement
  const net_imposable_annuel = Math.max(0, (brut_imposable * (1 - b.irpp_abattement_frais / 100) - cnps_salarie) * 12 - b.irpp_abattement_annuel);
  const irpp = brut_imposable < b.irpp_seuil_mensuel ? 0 : r(irppAnnuel(net_imposable_annuel, b.irpp_tranches) / 12);
  const cac = pct(irpp, b.cac);
  const cfc = pct(brut_imposable, b.cfc_salarie);
  const rav = parTranche(brut_imposable, b.rav);
  const tdl = parTranche(base, b.tdl);
  const total_retenues = cnps_salarie + irpp + cac + cfc + rav + tdl;
  const avance = Math.min(Math.max(0, r(input.avance || 0)), Math.max(0, brut - total_retenues));
  const net = brut - total_retenues - avance;

  const employeur = {
    pension: pct(cnps_base, b.cnps_pension_employeur),
    af: pct(cnps_base, b.cnps_af_employeur),
    at: pct(brut_imposable, b.cnps_at_employeur),
    cfc: pct(brut_imposable, b.cfc_employeur),
    fne: pct(brut_imposable, b.fne_employeur),
    total: 0,
  };
  employeur.total = employeur.pension + employeur.af + employeur.at + employeur.cfc + employeur.fne;
  return { base, retenue_absence, primes, brut, brut_imposable, non_imposable, cnps_base, cnps_salarie, net_imposable_annuel: r(net_imposable_annuel), irpp, cac, cfc, rav, tdl, total_retenues, avance, net, employeur, cout_total: brut + employeur.total, taux: { cnps: b.cnps_salarie, cac: b.cac, cfc: b.cfc_salarie } };
}

// Congés payés : 1,5 jour par mois de service (Code du travail), moins les congés annuels approuvés
export async function soldeConges(e: { id: number; user_id: number | null; date_embauche: Date | null; conges_report: number }) {
  // Mois de service complets depuis l'embauche
  let mois = 0;
  if (e.date_embauche) {
    const a = new Date(e.date_embauche), n = new Date();
    mois = Math.max(0, (n.getFullYear() - a.getFullYear()) * 12 + n.getMonth() - a.getMonth() - (n.getDate() < a.getDate() ? 1 : 0));
  }
  const acquis = mois * 1.5 + (e.conges_report || 0);
  let pris = 0;
  const historique: any[] = [];
  if (e.user_id) {
    const conges = await basePrisma.demande.findMany({ where: { demandeur_id: e.user_id, type: "CONGE", etat: "APPROUVEE" }, orderBy: { created_at: "desc" } });
    for (const c of conges) {
      const d = JSON.parse(c.donnees_json || "{}");
      historique.push({ id: c.id, numero: c.numero, motif: d.motif, du: d.du, au: d.au, jours: d.jours || 0 });
      if (d.motif === "Congé annuel") pris += d.jours || 0;
    }
  }
  return { acquis, pris, solde: acquis - pris, historique };
}

export const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
export const periodeLabel = (p: { mois: number; annee: number }) => `${MOIS[p.mois - 1]} ${p.annee}`;
