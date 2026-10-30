import nodemailer from "nodemailer";

// E-mails sortants (facultatifs). Actifs seulement si SMTP_HOST est défini.
let transporter: nodemailer.Transporter | null = null;

export function mailEnabled(): boolean {
  return !!process.env.SMTP_HOST;
}

function getTransport() {
  if (!transporter && mailEnabled()) {
    const port = parseInt(process.env.SMTP_PORT || "587", 10);
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
  }
  return transporter;
}

const esc = (s: string) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

export async function sendMail(to: string | null | undefined, subject: string, lines: string[], link?: { url: string; label: string }) {
  const t = getTransport();
  if (!t || !to) return false;
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#0f172a">
    <div style="background:#059669;color:#fff;padding:16px 20px;border-radius:12px 12px 0 0;font-weight:bold">YM-TRANSIT</div>
    <div style="border:1px solid #e5e7eb;border-top:0;padding:20px;border-radius:0 0 12px 12px">
      ${lines.map((l) => `<p style="margin:0 0 12px">${esc(l)}</p>`).join("")}
      ${link ? `<p><a href="${esc(link.url)}" style="display:inline-block;background:#059669;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">${esc(link.label)}</a></p>` : ""}
    </div></div>`;
  try {
    await t.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text: lines.join("\n\n") + (link ? `\n\n${link.url}` : ""), html });
    return true;
  } catch (e) {
    console.error("[MAIL] Échec d'envoi :", e);
    return false;
  }
}
