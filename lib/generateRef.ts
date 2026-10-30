// Dernière référence émise par préfixe : deux pièces créées dans la même seconde
// reçoivent un suffixe (-2, -3…) au lieu d'entrer en collision.
const last: Record<string, { base: string; n: number }> = {};

export function generateRef(prefix: string): string {
  const now = new Date();
  const year  = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day   = String(now.getDate()).padStart(2, '0');
  const hour  = String(now.getHours()).padStart(2, '0');
  const min   = String(now.getMinutes()).padStart(2, '0');
  const sec   = String(now.getSeconds()).padStart(2, '0');
  const base = `${prefix}-${year}${month}${day}-${hour}${min}${sec}`;
  const prev = last[prefix];
  if (prev && prev.base === base) {
    prev.n += 1;
    return `${base}-${prev.n}`;
  }
  last[prefix] = { base, n: 1 };
  return base;
}
