import fs from "fs";
import path from "path";
import webpush from "web-push";

// Notifications push (PWA). Les clés VAPID viennent de l'environnement ; à défaut elles sont
// générées une fois et gardées à côté de la base SQLite (volume persistant /app/data).
let ready = false;
let publicKey = "";

// Clés gardées sur le volume persistant /app/data (là où elles étaient avec l'ancienne base SQLite),
// pour que les abonnements push des téléphones restent valides d'un déploiement à l'autre
function keysFile(): string {
  const url = process.env.DATABASE_URL || "";
  const dbPath = url.startsWith("file:") ? url.slice(5) : "";
  const dataDir = process.env.DATA_PATH || "/app/data";
  const dir = dbPath ? path.dirname(path.resolve(dbPath)) : fs.existsSync(dataDir) ? dataDir : process.cwd();
  return path.join(dir, "vapid-keys.json");
}

export function initPush() {
  if (ready) return;
  let pub = process.env.VAPID_PUBLIC_KEY || "";
  let priv = process.env.VAPID_PRIVATE_KEY || "";
  if (!pub || !priv) {
    const file = keysFile();
    try {
      if (fs.existsSync(file)) {
        const k = JSON.parse(fs.readFileSync(file, "utf-8"));
        pub = k.publicKey; priv = k.privateKey;
      } else {
        const k = webpush.generateVAPIDKeys();
        fs.writeFileSync(file, JSON.stringify(k), { mode: 0o600 });
        pub = k.publicKey; priv = k.privateKey;
        console.log(`[PUSH] Clés VAPID générées dans ${file}`);
      }
    } catch (e) {
      console.error("[PUSH] Impossible de préparer les clés VAPID, notifications push désactivées :", e);
      return;
    }
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:admin@ym-transit.cm", pub, priv);
  publicKey = pub;
  ready = true;
}

export function vapidPublicKey(): string {
  initPush();
  return publicKey;
}

// Envoie une notification à tous les appareils abonnés d'un utilisateur.
// "db" est le client Prisma de base (sans hooks) pour éviter toute boucle.
export async function sendPushToUser(db: any, userId: number, payload: { title: string; body: string; url?: string; tag?: string }) {
  initPush();
  if (!ready) return;
  const subs = await db.pushSubscription.findMany({ where: { user_id: userId } });
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload),
        { TTL: 24 * 3600, urgency: "high" }
      );
    } catch (e: any) {
      if (e?.statusCode === 404 || e?.statusCode === 410) {
        await db.pushSubscription.delete({ where: { id: s.id } }).catch(() => {});
      } else {
        console.error("[PUSH] Échec d'envoi :", e?.statusCode || e?.message || e);
      }
    }
  }
}
