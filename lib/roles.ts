// Rôles proposés à la création d'un compte (même liste que Administration › Utilisateurs)
export const ROLE_GROUPS: { label: string; roles: [string, string][] }[] = [
  { label: "Direction", roles: [["pdg", "PDG"], ["dg", "DG"], ["dga", "DGA"], ["daf", "DAF"], ["auditeur1", "Auditeur 1"], ["auditeur2", "Auditeur 2"]] },
  { label: "Transit et opérations", roles: [["secretariat", "Secrétariat"], ["guce", "GUCE"], ["validation", "Validation"], ["acconage", "Acconage"], ["enlevement", "Enlèvement et livraison"]] },
  { label: "Finances", roles: [["facturation", "Facturation"], ["fiscalite", "Fiscalité"], ["cloture", "Clôture"], ["agent_payeur", "Caisse"], ["comptable", "Comptable"]] },
  { label: "Autres", roles: [["rh", "Ressources humaines"], ["analyste", "Analyste"], ["operationnel", "Opérationnel"], ["commercial", "Commercial"], ["lecture", "Lecture seule"]] },
];
export const ROLE_KEYS = ROLE_GROUPS.flatMap((g) => g.roles.map(([k]) => k));
// Rôles plus anciens, toujours reconnus par l'application et proposés par les cartes d'Utilisateurs
export const AUTRES_ROLES: [string, string][] = [["super_admin", "Super administrateur"], ["direction", "Direction de caisse"], ["finances", "Administration financière"], ["comptable_ops", "Comptabilité opérationnelle"], ["magasinier", "Magasinier"], ["validation_role", "Validation"]];
// Tous les rôles qu'on peut donner à un compte depuis Administration › Utilisateurs
export const TOUS_ROLES = [...ROLE_KEYS, ...AUTRES_ROLES.map(([k]) => k)];
export const roleLabel = (k: string) => [...ROLE_GROUPS.flatMap((g) => g.roles), ...AUTRES_ROLES].find(([x]) => x === k)?.[1] || k;
