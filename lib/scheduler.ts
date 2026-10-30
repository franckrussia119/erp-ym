import { dailyBackupIfDue } from "./backup";
import { basePrisma, notifyRoles, notifyUsers } from "./prismaClient";
import { STEPS, stepOf, hoursLate, MANAGEMENT_ROLES } from "./pipeline";
import { sendMail, mailEnabled } from "./mailer";
import { bonTitle, visaProgress, payable, ROLES_BY_VISA, CAISSE_ROLES } from "./bons";

// Vérifications périodiques : dossiers en retard, visas en attente, avances non justifiées.
const HOUR = 36e5;
const VISA_REMINDER_HOURS = parseInt(process.env.VISA_REMINDER_HOURS || "12", 10);
const JUSTIF_DAYS = parseInt(process.env.JUSTIFICATION_DAYS || "7", 10);

async function checkLateDossiers() {
  const active = STEPS.filter((s) => s.slaHours > 0).map((s) => s.key);
  const dossiers = await basePrisma.dossier.findMany({
    where: { pipeline_status: { in: active } },
    include: { client: { select: { nom: true } } },
  });
  for (const d of dossiers) {
    const late = hoursLate(d as any);
    if (!late) continue;
    // une alerte par jour au plus
    if (d.sla_alert_at && Date.now() - d.sla_alert_at.getTime() < 24 * HOUR) continue;
    const step = stepOf(d.pipeline_status);
    const retard = late >= 48 ? `${Math.round(late / 24)} jours` : `${late} h`;
    await notifyRoles([...step.owners, ...MANAGEMENT_ROLES], `⏰ Dossier ${d.numero} en retard`,
      `À l'étape « ${step.label} » avec ${retard} de retard sur le délai prévu (${d.client?.nom || "client"}).`,
      `/dossiers/${d.id}`, { skipActor: false });
    await basePrisma.dossier.update({ where: { id: d.id }, data: { sla_alert_at: new Date() } });
  }
}

async function remindVisas() {
  const limit = new Date(Date.now() - VISA_REMINDER_HOURS * HOUR);
  const bons = await basePrisma.bonProvisoir.findMany({
    where: { etat: "EN_ATTENTE", created_at: { lt: limit }, OR: [{ reminder_at: null }, { reminder_at: { lt: limit } }] },
    include: { dossier: { select: { numero: true } } },
  });
  for (const b of bons as any[]) {
    const missing = visaProgress(b).missing;
    const titre = bonTitle(b);
    const montant = `${Math.round(b.montant_demande).toLocaleString("fr-FR")} F`;
    if (missing.length && !payable(b)) {
      const roles = missing.flatMap((k) => ROLES_BY_VISA[k]);
      await notifyRoles(roles, `✍️ Rappel : visa attendu sur ${b.numero}`,
        `${titre} · ${montant} · ${b.objet}. En attente depuis ${Math.round((Date.now() - b.created_at.getTime()) / HOUR)} h.`,
        "/bons/visas", { skipActor: false });
      if (mailEnabled()) {
        const users = await basePrisma.user.findMany({ where: { role: { in: roles }, actif: true } });
        for (const u of users) {
          await sendMail(u.email, `Rappel : visa attendu sur le bon ${b.numero}`,
            [`Bonjour ${u.prenom || u.nom},`, `Le bon provisoire ${b.numero} (${titre}, ${montant}) attend votre visa.`]);
        }
      }
    } else {
      await notifyRoles(CAISSE_ROLES, `💵 Rappel : décaissement de ${b.numero}`,
        `${b.ordre_paiement_by ? "Paiement ordonné par " + b.ordre_paiement_by : "Tous les visas sont obtenus"}. ${titre} · ${montant}.`, `/bons/${b.id}`, { skipActor: false });
    }
    await basePrisma.bonProvisoir.update({ where: { id: b.id }, data: { reminder_at: new Date() } });
  }
}

async function remindJustifications() {
  const limit = new Date(Date.now() - JUSTIF_DAYS * 24 * HOUR);
  const again = new Date(Date.now() - 3 * 24 * HOUR);
  const bons = await basePrisma.bonProvisoir.findMany({
    where: { etat: "APPROUVE", bon_reel: null, approved_at: { lt: limit }, OR: [{ reminder_at: null }, { reminder_at: { lt: again } }] },
    include: { dossier: { select: { numero: true, id: true } } },
  });
  for (const b of bons) {
    const days = Math.round((Date.now() - (b.approved_at as Date).getTime()) / (24 * HOUR));
    const lien = `/depenses/${b.id}/justifier`;
    const titre = bonTitle(b);
    const msg = `Avance de ${Math.round(b.montant_demande).toLocaleString("fr-FR")} F décaissée il y a ${days} jours, sans bon réel.`;
    await notifyUsers([b.demandeur_id], `🧾 Justifiez l'avance ${b.numero}`, msg, lien);
    await notifyRoles(["daf"], `🧾 Avance non justifiée : ${b.numero}`, `${titre}. ${msg}`, lien, { skipActor: false });
    await basePrisma.bonProvisoir.update({ where: { id: b.id }, data: { reminder_at: new Date() } });
  }
}

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    await checkLateDossiers();
    await remindVisas();
    await remindJustifications();
    await dailyBackupIfDue();
  } catch (e) {
    console.error("[RAPPELS] Erreur :", e);
  } finally {
    running = false;
  }
}

export async function startScheduler() {
  // Dossiers existants sans date d'entrée dans l'étape : le chrono démarre maintenant,
  // pour ne pas envoyer d'alertes de retard sur tout l'historique au premier démarrage.
  await basePrisma.dossier.updateMany({ where: { stage_entered_at: null }, data: { stage_entered_at: new Date() } }).catch(() => {});
  const minutes = parseInt(process.env.REMINDER_INTERVAL_MINUTES || "15", 10);
  setTimeout(tick, 30 * 1000);
  setInterval(tick, minutes * 60 * 1000);
  console.log(`[RAPPELS] Vérification des retards et des visas toutes les ${minutes} min.`);
}
