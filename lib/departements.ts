import { basePrisma } from "./prismaClient";
import { currentUserId } from "./context";

// Services de l'entreprise (centres de coût). Créés au premier démarrage, modifiables dans Administration > Services.
export const DEFAULT_DEPARTEMENTS = [
  { code: "DIRECTION", nom: "Direction générale", couleur: "#065f46", icone: "bi-building", ordre: 1, description: "PDG, DG, DGA, audit et pilotage" },
  { code: "TRANSIT", nom: "Transit & douane", couleur: "#10b981", icone: "bi-box-seam", ordre: 2, description: "Dossiers de transit : secrétariat, GUCE, validation, acconage, enlèvement" },
  { code: "TRANSPORT", nom: "Transport routier", couleur: "#14b8a6", icone: "bi-truck", ordre: 3, description: "Camions, chauffeurs et missions" },
  { code: "FINANCE", nom: "Comptabilité & finance", couleur: "#059669", icone: "bi-calculator", ordre: 4, description: "Facturation, caisse, comptabilité, fiscalité" },
  { code: "RH", nom: "Ressources humaines", couleur: "#0d9488", icone: "bi-people", ordre: 5, description: "Personnel, congés et paie" },
  { code: "COMMERCIAL", nom: "Commercial & marketing", couleur: "#34d399", icone: "bi-megaphone", ordre: 6, description: "Prospects, clients et campagnes" },
  { code: "ACHATS", nom: "Achats & magasin", couleur: "#65a30d", icone: "bi-boxes", ordre: 7, description: "Achats, fournisseurs et stock" },
];

// Service par défaut selon le rôle (un employé peut ensuite être déplacé dans Administration > Utilisateurs)
export const ROLE_DEPARTEMENT: Record<string, string> = {
  super_admin: "DIRECTION", pdg: "DIRECTION", dg: "DIRECTION", dga: "DIRECTION", auditeur1: "DIRECTION", auditeur2: "DIRECTION",
  direction: "DIRECTION", analyste: "DIRECTION", lecture: "DIRECTION",
  secretariat: "TRANSIT", secretaire: "TRANSIT", guce: "TRANSIT", validation: "TRANSIT", validation_role: "TRANSIT",
  acconage: "TRANSIT", enlevement: "TRANSIT", operationnel: "TRANSIT",
  daf: "FINANCE", facturation: "FINANCE", finances: "FINANCE", comptable: "FINANCE", comptable_ops: "FINANCE",
  fiscalite: "FINANCE", cloture: "FINANCE", agent_payeur: "FINANCE", caisse: "FINANCE",
  rh: "RH", commercial: "COMMERCIAL", magasinier: "ACHATS", chauffeur: "TRANSPORT", transport: "TRANSPORT",
};

let cache: { at: number; byCode: Map<string, number> } | null = null;
export async function deptIdByCode(code: string): Promise<number | null> {
  if (!cache || Date.now() - cache.at > 60_000) {
    const all = await basePrisma.departement.findMany({ select: { id: true, code: true } });
    cache = { at: Date.now(), byCode: new Map(all.map((d) => [d.code, d.id])) };
  }
  return cache.byCode.get(code) ?? null;
}
export const clearDeptCache = () => { cache = null; };

async function userDept(userId: number | null | undefined): Promise<number | null> {
  if (!userId) return null;
  const u = await basePrisma.user.findUnique({ where: { id: userId }, select: { departement_id: true, role: true } });
  if (!u) return null;
  return u.departement_id ?? (ROLE_DEPARTEMENT[u.role] ? await deptIdByCode(ROLE_DEPARTEMENT[u.role]) : null);
}

// Centre de coût d'une écriture qui n'en précise pas : un dossier → Transit ; un bon → service du bon ;
// sinon le service de la personne qui saisit (ou du demandeur).
export async function autoDepartement(model: string, data: any): Promise<number | null> {
  if (data.dossier_id || data.dossier?.connect) return deptIdByCode("TRANSIT");
  if (model === "CaisseMouvement" && data.bon_id) {
    const b = await basePrisma.bonProvisoir.findUnique({ where: { id: data.bon_id }, select: { departement_id: true, dossier_id: true } });
    if (b?.departement_id) return b.departement_id;
    if (b?.dossier_id) return deptIdByCode("TRANSIT");
  }
  return userDept(data.demandeur_id ?? data.user_id ?? currentUserId());
}

// Premier démarrage : services par défaut, employés rangés selon leur rôle, anciennes écritures affectées
export async function ensureDepartements() {
  // Pas de logistique dans l'entreprise : l'ancien code du service Achats est renommé, ainsi que l'ancien nom de la société
  await basePrisma.departement.updateMany({ where: { code: "LOGISTIQUE" }, data: { code: "ACHATS" } });
  for (const t of ["Client", "User", "Document", "EcritureComptable", "CompteComptable"]) {
    await basePrisma.$executeRawUnsafe(`UPDATE "${t}" SET societe = 'YM-TRANSIT' WHERE societe = 'YM-TRANSIT Transit & Logistics Ltd'`);
  }
  await basePrisma.$executeRawUnsafe(`UPDATE "PeriodeComptable" p SET societe = 'YM-TRANSIT' WHERE societe = 'YM-TRANSIT Transit & Logistics Ltd' AND NOT EXISTS (SELECT 1 FROM "PeriodeComptable" q WHERE q.mois = p.mois AND q.annee = p.annee AND q.societe = 'YM-TRANSIT')`);
  // Interface en une seule couleur : les services aux couleurs d'origine passent aux nuances de vert
  const anciennes: Record<string, string> = { "#0f172a": "#065f46", "#2563eb": "#10b981", "#ea580c": "#14b8a6", "#7c3aed": "#0d9488", "#db2777": "#34d399", "#ca8a04": "#65a30d" };
  for (const [a, b] of Object.entries(anciennes)) await basePrisma.departement.updateMany({ where: { couleur: a }, data: { couleur: b } });
  if ((await basePrisma.departement.count()) === 0) {
    await basePrisma.departement.createMany({ data: DEFAULT_DEPARTEMENTS });
    console.log(`[SERVICES] ${DEFAULT_DEPARTEMENTS.length} services créés.`);
  }
  clearDeptCache();
  const users = await basePrisma.user.findMany({ where: { departement_id: null }, select: { id: true, role: true } });
  for (const u of users) {
    const id = ROLE_DEPARTEMENT[u.role] ? await deptIdByCode(ROLE_DEPARTEMENT[u.role]) : null;
    if (id) await basePrisma.user.update({ where: { id: u.id }, data: { departement_id: id } });
  }
  const transit = await deptIdByCode("TRANSIT");
  let n = 0;
  if (transit) {
    n += (await basePrisma.bonProvisoir.updateMany({ where: { departement_id: null, dossier_id: { not: null } }, data: { departement_id: transit } })).count;
    n += (await basePrisma.caisseMouvement.updateMany({ where: { departement_id: null, dossier_id: { not: null } }, data: { departement_id: transit } })).count;
    n += (await basePrisma.document.updateMany({ where: { departement_id: null, dossier_id: { not: null } }, data: { departement_id: transit } })).count;
  }
  for (const b of await basePrisma.bonProvisoir.findMany({ where: { departement_id: null }, select: { id: true, demandeur_id: true } })) {
    const d = await userDept(b.demandeur_id); if (d) { await basePrisma.bonProvisoir.update({ where: { id: b.id }, data: { departement_id: d } }); n++; }
  }
  for (const m of await basePrisma.caisseMouvement.findMany({ where: { departement_id: null }, select: { id: true, bon_id: true, user_id: true } })) {
    const d = await autoDepartement("CaisseMouvement", m); if (d) { await basePrisma.caisseMouvement.update({ where: { id: m.id }, data: { departement_id: d } }); n++; }
  }
  if (n) console.log(`[SERVICES] ${n} écritures existantes rattachées à un service.`);
}

// Listes de choix et contrôle d'un service choisi dans un formulaire
export const servicesActifs = () => basePrisma.departement.findMany({ where: { actif: true }, orderBy: { ordre: "asc" }, select: { id: true, nom: true, couleur: true, icone: true } });
export async function pickDept(v: any): Promise<number | undefined> {
  const id = parseInt(v);
  if (!id) return undefined;
  return (await basePrisma.departement.findFirst({ where: { id, actif: true }, select: { id: true } }))?.id;
}
export const userDeptId = (userId: number) => userDept(userId);
