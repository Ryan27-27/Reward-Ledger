import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { logger } from '../logger.js';

let transport;
function getTransport() {
  if (!transport) {
    // No SMTP configured → log the message instead of sending (dev & tests). Point SMTP_URL at
    // Mailpit/Mailhog locally or SES/SendGrid/Postmark/Gmail in production.
    transport = config.smtpUrl ? nodemailer.createTransport(config.smtpUrl) : nodemailer.createTransport({ jsonTransport: true });
  }
  return transport;
}
export const sentLog = []; // only used by tests with the JSON transport

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n).toLocaleString('en-IN');

const shell = (title, inner, appUrl) => `<!doctype html><html><body style="margin:0;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 12px">
<table width="480" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:14px;padding:32px;max-width:480px">
<tr><td><div style="font-weight:700;font-size:18px;color:#4f46e5">● Pointwise</div>
<h2 style="margin:20px 0 8px;font-size:20px">${esc(title)}</h2>${inner}
<p style="margin:28px 0 0;font-size:12px;color:#888">You are receiving this because of activity on your Pointwise account. <a href="${esc(appUrl)}" style="color:#4f46e5">Open Pointwise</a></p>
</td></tr></table></td></tr></table></body></html>`;

const templates = {
  otp: (d) => {
    const why = { VERIFY_EMAIL: 'verify your email address', RESET_PASSWORD: 'reset your password', REDEEM: `confirm your redemption${d.context ? ` of ${d.context}` : ''}`, MONEY: `confirm ${d.context || 'this transaction'}` }[d.purpose];
    return {
      subject: `Your Pointwise code: ${d.code}`,
      text: `Hi ${d.name}, use ${d.code} to ${why}. It expires in ${d.ttlMin} minutes. If this wasn't you, ignore this email.`,
      html: shell('Your verification code', `<p>Use this code to ${esc(why)}:</p>
        <p style="font-size:34px;letter-spacing:8px;font-weight:700;margin:16px 0">${esc(d.code)}</p>
        <p style="color:#666">Expires in ${d.ttlMin} minutes. Never share this code — Pointwise will never ask for it.</p>`, d.appUrl),
    };
  },
  'ledger-movement': (d) => {
    const credit = d.direction === 'CREDIT';
    const sign = credit ? '+' : '−';
    const inr = d.currency === 'INR'; // amounts are paise for rupees, whole points otherwise
    const rs = (p) => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const amt = inr ? rs(d.amount) : `${fmt(d.amount)} points`;
    const bal = inr ? rs(d.balance) : fmt(d.balance);
    return {
      subject: `${d.title}: ${sign}${amt}`,
      text: `${d.title}\n${sign}${amt}\nReason: ${d.reason}\nNew balance: ${bal}\nReference: ${d.reference}\nTime: ${d.at}`,
      html: shell(d.title, `<p style="font-size:34px;font-weight:700;margin:8px 0;color:${credit ? '#059669' : '#dc2626'}">${sign}${inr ? rs(d.amount) : fmt(d.amount)} <span style="font-size:16px;color:#666">${inr ? '' : 'points'}</span></p>
        <table cellpadding="6" style="font-size:14px;border-top:1px solid #eee;width:100%">
        <tr><td style="color:#666">Reason</td><td>${esc(d.reason)}</td></tr>
        <tr><td style="color:#666">New balance</td><td><b>${bal}</b></td></tr>
        <tr><td style="color:#666">Reference</td><td style="font-family:monospace;font-size:12px">${esc(d.reference)}</td></tr>
        <tr><td style="color:#666">Time</td><td>${esc(new Date(d.at).toUTCString())}</td></tr></table>
        <p style="color:#666;font-size:13px">Don't recognise this? Change your password and contact support immediately.</p>`, d.appUrl),
    };
  },
  'password-changed': (d) => ({
    subject: 'Your Pointwise password was changed',
    text: `Hi ${d.name}, your password was just changed and other sessions were signed out. If this wasn't you, reset your password now.`,
    html: shell('Password changed', `<p>Hi ${esc(d.name)}, your password was just changed and all other sessions were signed out.</p><p style="color:#666">If this wasn't you, reset your password immediately.</p>`, d.appUrl),
  }),
  'account-status': (d) => ({
    subject: `Your Pointwise account was ${d.status}`,
    text: `Hi ${d.name}, your account was ${d.status}. Reason: ${d.reason}`,
    html: shell(`Account ${d.status}`, `<p>Hi ${esc(d.name)}, your rewards account was <b>${esc(d.status)}</b>.</p><p>Reason: ${esc(d.reason)}</p>`, d.appUrl),
  }),
};

export async function sendTemplated({ to, template, data }) {
  const build = templates[template];
  if (!build) throw new Error(`unknown email template ${template}`);
  const { subject, text, html } = build(data);
  const info = await getTransport().sendMail({ from: config.mailFrom, to, subject, text, html });
  if (!config.smtpUrl) {
    sentLog.push({ to, template, subject, text });
    if (sentLog.length > 200) sentLog.shift();
    if (!config.isTest) logger.info({ to, subject, preview: text.slice(0, 200) }, 'email (dev transport, not actually sent)');
  }
  return info;
}
