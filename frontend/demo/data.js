// The demo's mailbox: fictional people and companies on reserved example domains (RFC 2606).
// Dates are relative to when the page opens, so the demo always looks recent.

import { PGP } from './pgpFixtures.js';

export const USER = {
  id: '00000000-0000-4000-8000-000000000001',
  username: 'maya',
  displayName: 'Maya Lindqvist',
};

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const ACCOUNTS = [
  { id: id(101), name: 'Brightwater', email: 'maya@brightwater.example.com', color: '#3b82f6', host: 'mail.brightwater.example.com' },
  { id: id(102), name: 'Personal', email: 'maya.lindqvist@example.org', color: '#10b981', host: 'imap.example.org' },
  { id: id(103), name: 'Fernhill Ceramics', email: 'hello@fernhill.example.net', color: '#f59e0b', host: 'mx.fernhill.example.net' },
];
export const [WORK, HOME, SHOP] = ACCOUNTS.map(a => a.id);

// Folders every account has, then its own.
export const STANDARD_FOLDERS = [
  ['INBOX', 'Inbox', '\\Inbox'],
  ['Drafts', 'Drafts', '\\Drafts'],
  ['Sent', 'Sent', '\\Sent'],
  ['Archive', 'Archive', '\\Archive'],
  ['Junk', 'Junk', '\\Junk'],
  ['Trash', 'Trash', '\\Trash'],
];
export const EXTRA_FOLDERS = {
  [WORK]: [['Clients', 'Clients'], ['Clients/Harbor & Pine', 'Harbor & Pine'], ['Clients/Oakline Bikes', 'Oakline Bikes'], ['Receipts', 'Receipts']],
  [HOME]: [['Travel', 'Travel'], ['Family', 'Family']],
  [SHOP]: [['Orders', 'Orders'], ['Suppliers', 'Suppliers']],
};

const P = {
  maya: ['Maya Lindqvist', 'maya@brightwater.example.com'],
  mayaHome: ['Maya Lindqvist', 'maya.lindqvist@example.org'],
  mayaShop: ['Maya at Fernhill', 'hello@fernhill.example.net'],
  jonas: ['Jonas Ferreira', 'jonas@brightwater.example.com'],
  priya: ['Priya Raman', 'priya@brightwater.example.com'],
  tomas: ['Tomás Okafor', 'tomas@brightwater.example.com'],
  lea: ['Léa Moreau', 'lea@brightwater.example.com'],
  harbor: ['Owen Callaghan', 'owen@harborandpine.example.com'],
  oakline: ['Sanne de Vries', 'sanne@oakline.example.net'],
  cloudberry: ['Cloudberry Hosting', 'billing@cloudberry.example.net'],
  pixel: ['The Pixel Post', 'digest@pixelpost.example.org'],
  elena: ['Elena Varga', 'elena@quillpress.example.org'],
  mum: ['Ingrid Lindqvist', 'ingrid.lindqvist@example.net'],
  sam: ['Sam Lindqvist', 'sam.l@example.com'],
  noor: ['Noor Haddad', 'noor.haddad@example.org'],
  rail: ['Nordrail Tickets', 'no-reply@nordrail.example.com'],
  bank: ['Fjord Savings', 'notifications@fjordsavings.example.com'],
  climb: ['Granite Climbing Club', 'events@graniteclub.example.org'],
  kiln: ['KilnWorks Supply', 'orders@kilnworks.example.net'],
  customer: ['Hannah Brooks', 'hannah.brooks@example.com'],
  customer2: ['Marco Bellini', 'marco.bellini@example.org'],
  market: ['Riverside Makers Market', 'stalls@riversidemakers.example.org'],
  plimail: ['Plimail Demo', 'welcome@plimail.example.com'],
};

const min = 60_000, hour = 60 * min, day = 24 * hour;

// Inline styles only, as mail clients expect: the body goes through the app's own frame.
const wrap = (inner, { width = 600, bg = '#ffffff' } = {}) => `<div style="background:${bg};padding:24px 0;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1f2933">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="${width}" cellpadding="0" cellspacing="0" style="max-width:${width}px;width:100%">${inner}</table>
</td></tr></table></div>`;

const para = text => text.split('\n\n').map(p => `<p style="margin:0 0 14px;line-height:1.55">${p.replace(/\n/g, '<br>')}</p>`).join('');
const personal = (text, sig) => `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;color:#1f2933">${para(text)}${sig ? `<p style="margin:18px 0 0;color:#6b7280;font-size:13px;line-height:1.4">${sig}</p>` : ''}</div>`;

const quote = (who, text) => `<blockquote style="margin:16px 0 0;padding:0 0 0 12px;border-left:3px solid #d1d5db;color:#6b7280">${who} wrote:<br>${para(text)}</blockquote>`;

const newsletterHtml = wrap(`
<tr><td style="padding:28px 32px;background:#111827;border-radius:12px 12px 0 0">
  <div style="font-size:12px;letter-spacing:.08em;color:#9ca3af">ISSUE 214 · THE PIXEL POST</div>
  <div style="font-size:26px;font-weight:700;color:#ffffff;margin-top:8px">Variable fonts, quiet interfaces, and a very good grid</div>
</td></tr>
<tr><td style="padding:28px 32px;background:#ffffff;border:1px solid #e5e7eb;border-top:0">
  ${para('Hi there,\n\nThis week we look at interfaces that get out of the way: three case studies on calm design, a practical guide to variable fonts on the web, and the grid system one studio has used unchanged for nine years.')}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 18px">
    <tr><td style="padding:16px;border-radius:10px;background:#eef2ff">
      <div style="font-weight:600;font-size:16px;margin-bottom:6px">1 · Designing for the second glance</div>
      <div style="color:#4b5563;line-height:1.5">Why the most-used screens in an app should be the least surprising ones, with examples from banking, mail and note-taking apps.</div>
    </td></tr>
    <tr><td style="height:10px"></td></tr>
    <tr><td style="padding:16px;border-radius:10px;background:#ecfdf5">
      <div style="font-weight:600;font-size:16px;margin-bottom:6px">2 · Variable fonts without the bloat</div>
      <div style="color:#4b5563;line-height:1.5">Subsetting, <code>font-display</code>, and when one variable file really does replace six static ones.</div>
    </td></tr>
    <tr><td style="height:10px"></td></tr>
    <tr><td style="padding:16px;border-radius:10px;background:#fff7ed">
      <div style="font-weight:600;font-size:16px;margin-bottom:6px">3 · The nine-year grid</div>
      <div style="color:#4b5563;line-height:1.5">A twelve-column grid, a 4px baseline and a stubborn refusal to add a thirteenth column.</div>
    </td></tr>
  </table>
  <a href="https://pixelpost.example.org/issues/214" style="display:inline-block;padding:11px 18px;background:#4f46e5;color:#ffffff;border-radius:8px;text-decoration:none;font-weight:600">Read the full issue</a>
</td></tr>
<tr><td style="padding:18px 32px;color:#9ca3af;font-size:12px;line-height:1.5">
  You get this because you subscribed at pixelpost.example.org. <a href="https://pixelpost.example.org/unsubscribe" style="color:#9ca3af">Unsubscribe</a>.
</td></tr>`, { bg: '#f3f4f6' });

const invoiceRows = [['Business VPS · 4 vCPU / 8 GB', '1', '€ 24.00'], ['Block storage · 200 GB', '1', '€ 8.00'], ['Daily snapshots', '1', '€ 3.20'], ['Managed DNS zone', '2', '€ 2.00']];
const invoiceHtml = wrap(`
<tr><td style="padding:24px 28px;border-bottom:3px solid #0ea5e9">
  <div style="font-size:20px;font-weight:700;color:#0c4a6e">☁ Cloudberry Hosting</div>
  <div style="color:#6b7280;font-size:13px;margin-top:4px">Invoice CB-2026-11-04821 · Paid</div>
</td></tr>
<tr><td style="padding:22px 28px">
  ${para('Hello Brightwater Studio,\n\nThanks for your payment. Here is the invoice for November. The amount was charged to the card ending in 4242.')}
  <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px;margin:6px 0 16px">
    <tr style="color:#6b7280;text-align:left"><th style="padding:8px 0;border-bottom:1px solid #e5e7eb">Item</th><th style="padding:8px 0;border-bottom:1px solid #e5e7eb;text-align:center">Qty</th><th style="padding:8px 0;border-bottom:1px solid #e5e7eb;text-align:right">Amount</th></tr>
    ${invoiceRows.map(([a, q, p]) => `<tr><td style="padding:9px 0;border-bottom:1px solid #f3f4f6">${a}</td><td style="text-align:center;border-bottom:1px solid #f3f4f6">${q}</td><td style="text-align:right;border-bottom:1px solid #f3f4f6">${p}</td></tr>`).join('')}
    <tr><td style="padding:10px 0;color:#6b7280">VAT 20 %</td><td></td><td style="text-align:right;color:#6b7280">€ 7.44</td></tr>
    <tr><td style="padding:4px 0;font-weight:700">Total</td><td></td><td style="text-align:right;font-weight:700">€ 44.64</td></tr>
  </table>
  <div style="font-size:12px;color:#9ca3af">Cloudberry Hosting · 12 Example Quay · billing@cloudberry.example.net</div>
</td></tr>`);

const ticketHtml = wrap(`
<tr><td style="padding:22px 26px;background:#7f1d1d;color:#fff;border-radius:10px 10px 0 0">
  <div style="font-size:13px;opacity:.8">NORDRAIL · E-TICKET</div>
  <div style="font-size:22px;font-weight:700;margin-top:6px">Oslo S → Bergen</div>
</td></tr>
<tr><td style="padding:20px 26px;border:1px solid #e5e7eb;border-top:0;border-radius:0 0 10px 10px">
  <table width="100%" style="font-size:14px">
    <tr><td style="color:#6b7280">Departs</td><td style="color:#6b7280">Arrives</td><td style="color:#6b7280">Seat</td></tr>
    <tr><td style="font-size:18px;font-weight:600">08:25</td><td style="font-size:18px;font-weight:600">15:03</td><td style="font-size:18px;font-weight:600">Car 4 · 37</td></tr>
  </table>
  ${para('\nBooking reference <b>NR7-KQ2D</b>. Show this e-mail or the attached ticket on board. Have a good trip!')}
</td></tr>`);

const marketHtml = wrap(`
<tr><td style="padding:26px 30px;background:#fef3c7;border-radius:12px">
  <div style="font-size:22px;font-weight:700;color:#92400e">Riverside Makers Market · Winter edition</div>
  ${para('\nGood news, Fernhill Ceramics! Your stall application has been <b>accepted</b>.\n\nStall 14, Hall B · Saturday and Sunday, 10:00 to 17:00. Setup opens at 08:00 on Saturday.')}
  <ul style="line-height:1.7;margin:0 0 12px;padding-left:20px"><li>Tables are 180 × 80 cm</li><li>One power socket per stall</li><li>Card readers welcome, the hall Wi-Fi is free</li></ul>
  <div style="color:#92400e">See you there,<br>The Riverside team</div>
</td></tr>`);

const welcomeHtml = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;color:#1f2933;line-height:1.55">
<p style="margin:0 0 14px">Welcome! This is the real Plimail web app, running entirely in your browser with a made-up mailbox. Nothing you do here leaves this page, and a reload puts everything back.</p>
<p style="margin:0 0 8px"><b>Things to try</b></p>
<ul style="margin:0 0 14px;padding-left:20px">
<li>Switch between the three accounts, or read them together in All Inboxes.</li>
<li>Star, archive, move or delete messages, and reply to one: it lands in Sent.</li>
<li>Open the calendar: there is an invitation waiting for an answer.</li>
<li>Open the message from Elena Varga: it is OpenPGP-encrypted. The demo key's passphrase is <code style="background:#f3f4f6;padding:1px 5px;border-radius:4px">plimail-demo</code>.</li>
<li>Look through Settings: themes, passkeys, server filters, the out-of-office reply.</li>
</ul>
<p style="margin:0">When you are ready, Plimail installs on your own server with one Docker image.</p>
</div>`;

// Drawn into a PNG when opened (backend.js): an SVG attachment is, rightly, flagged as risky.
export const moodboardSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="600" viewBox="0 0 960 600">
<rect width="960" height="600" fill="#f5f1ea"/>
<rect x="40" y="40" width="420" height="250" rx="18" fill="#1e3a5f"/>
<rect x="500" y="40" width="420" height="120" rx="18" fill="#d97757"/>
<rect x="500" y="180" width="200" height="110" rx="18" fill="#e9c46a"/>
<rect x="720" y="180" width="200" height="110" rx="18" fill="#2a9d8f"/>
<rect x="40" y="320" width="880" height="240" rx="18" fill="#ffffff"/>
<text x="80" y="420" font-family="Georgia,serif" font-size="56" fill="#1e3a5f">Harbor &amp; Pine</text>
<text x="80" y="480" font-family="Helvetica,Arial,sans-serif" font-size="24" fill="#6b7280">Moodboard v3 · warm coast, quiet type</text>
<circle cx="830" cy="440" r="60" fill="#d97757"/>
</svg>`;

export const ATTACHMENT_FILES = {
  ticket: { type: 'text/plain', data: 'NORDRAIL E-TICKET\nOslo S -> Bergen\nBooking NR7-KQ2D\nCar 4, seat 37\n(This is demo data.)\n' },
  notes: { type: 'text/markdown', data: '# Q4 roadmap, notes\n\n- Ship the Harbor & Pine site by the 12th\n- Oakline: second round of logo sketches\n- Hire a junior designer in January\n' },
};

// Each message: who, where, when (ms ago), and what. `thread` groups a conversation.
const SPECS = [
  // ── All Inboxes, newest first ───────────────────────────────────────────────
  { n: 1, acct: HOME, from: P.plimail, to: [P.mayaHome], ago: 4 * min, subject: 'Welcome to the Plimail demo', html: welcomeHtml, starred: true },
  { n: 2, acct: WORK, from: P.jonas, to: [P.maya, P.priya], ago: 22 * min, thread: 'roadmap', subject: 'Re: Q4 roadmap review', text: 'Agreed on moving the Oakline sketches up. Can we do Thursday at 10 instead of 11? I have a call with Harbor & Pine right after.\n\nJonas', quoted: [P.priya, 'I can take the Oakline logo round if Tomás is still on the website.'] },
  { n: 3, acct: WORK, from: P.harbor, to: [P.maya], cc: [P.jonas], ago: 48 * min, subject: 'Moodboard feedback', folder: 'INBOX', attach: [['moodboard-v3.png', 'moodboard', 'image/png', 48210]], text: 'Hi Maya,\n\nWe went through the moodboard with the whole team this morning, and the warm coastal palette is a clear favourite. Two small things:\n\n1. Could the serif be a little less formal? Something friendlier for the headings.\n2. The orange reads a bit strong next to the navy. Maybe soften it by a step.\n\nOtherwise we are thrilled. Looking forward to the first page layouts!\n\nBest,\nOwen\nHarbor & Pine' },
  { n: 4, acct: SHOP, from: P.customer, to: [P.mayaShop], ago: 1.6 * hour, subject: 'Custom order: a set of six mugs?', text: 'Hello!\n\nI bought one of your speckled blue mugs at the summer market and my partner has claimed it as theirs. Would you be able to make a set of six in the same glaze, maybe with a slightly bigger handle?\n\nNo rush, it is for a birthday in February.\n\nWarmly,\nHannah' },
  { n: 5, acct: WORK, from: P.lea, to: [P.maya], ago: 2.3 * hour, subject: 'Invitation: Design critique, Thursday 14:00', text: 'Léa Moreau invited you to "Design critique" on Thursday from 14:00 to 15:00 in the Studio (2nd floor).\n\nWe will look at the Harbor & Pine home page and the Oakline logo sketches. Bring one thing you are unsure about.\n\nAnswer from the calendar, or reply to this e-mail.', invite: true },
  { n: 6, acct: HOME, from: P.elena, to: [P.mayaHome], ago: 3.1 * hour, subject: 'Manuscript notes (encrypted)', pgp: 'encrypted' },
  { n: 7, acct: WORK, from: P.cloudberry, to: [P.maya], ago: 5 * hour, subject: 'Your November invoice CB-2026-11-04821', html: invoiceHtml, category: 'automated', read: true },
  { n: 8, acct: HOME, from: P.mum, to: [P.mayaHome], cc: [P.sam], ago: 7 * hour, thread: 'sunday', subject: 'Sunday lunch?', text: 'Hi love,\n\nAre you and Sam free for lunch this Sunday? I am making the fish soup Grandpa used to make, and there will be far too much of it.\n\nCome around one if you can.\n\nMum' },
  { n: 9, acct: WORK, from: P.tomas, to: [P.maya], ago: 9 * hour, thread: 'staging', subject: 'Harbor & Pine staging is up', text: 'Hey Maya,\n\nThe staging site is up at https://staging.harborandpine.example.com. The home page and the shop page are done, the journal is still placeholder copy.\n\nLighthouse is at 98 on mobile. I left two TODOs in the footer.\n\nTomás', read: true },
  { n: 10, acct: HOME, from: P.pixel, to: [P.mayaHome], ago: 20 * hour, subject: 'Variable fonts, quiet interfaces, and a very good grid', html: newsletterHtml, category: 'newsletter', unsubscribe: true },
  { n: 11, acct: SHOP, from: P.market, to: [P.mayaShop], ago: 26 * hour, subject: 'Your stall at the Winter Market is confirmed', html: marketHtml, starred: true, read: true },
  { n: 12, acct: WORK, from: P.oakline, to: [P.maya], ago: 30 * hour, subject: 'Logo round two', text: 'Hi Maya,\n\nThanks for the first sketches. We keep coming back to the one with the wheel inside the leaf. Could you explore that one further, with a version that works at small sizes on the bike frame?\n\nCheers,\nSanne', read: true },
  { n: 13, acct: HOME, from: P.elena, to: [P.mayaHome], ago: 2 * day, subject: 'Book club: signed reading list', pgp: 'signed', read: true },
  { n: 14, acct: HOME, from: P.rail, to: [P.mayaHome], ago: 2.2 * day, subject: 'Your e-ticket: Oslo S → Bergen', html: ticketHtml, attach: [['nordrail-ticket.txt', 'ticket', 'text/plain', 120]], category: 'automated', read: true },
  { n: 15, acct: SHOP, from: P.kiln, to: [P.mayaShop], ago: 2.5 * day, subject: 'Order KW-58213 has shipped', text: 'Hello Fernhill Ceramics,\n\nYour order has shipped:\n\n  2 × Stoneware clay, buff, 12.5 kg\n  1 × Celadon glaze, 1 kg\n  1 × Kiln shelf, 40 × 30 cm\n\nTracking: KW58213-EX. Expected delivery Thursday.\n\nKilnWorks Supply', category: 'automated', read: true },
  { n: 16, acct: HOME, from: P.climb, to: [P.mayaHome], ago: 3 * day, subject: 'New bouldering problems this weekend', text: 'Hi climbers,\n\nThe setters have been busy: twelve new problems in the cave, from V0 to V6, and the slab wall finally has its blue circuit back.\n\nMembers night is Wednesday, with pizza from 19:00.\n\nGranite Climbing Club', category: 'newsletter', read: true },
  { n: 17, acct: WORK, from: P.priya, to: [P.maya], ago: 3.4 * day, subject: 'Lunch & learn: accessible colour palettes', text: 'Hi all,\n\nNext Tuesday I will run a short lunch & learn on building colour palettes that pass contrast checks without looking washed out. Bring your laptop and a palette you love.\n\nPriya', read: true },
  { n: 18, acct: HOME, from: P.bank, to: [P.mayaHome], ago: 4 * day, subject: 'Your monthly statement is ready', text: 'Your statement for October is ready to view in online banking.\n\nFor your security we never ask for your password by e-mail.\n\nFjord Savings', category: 'automated', read: true },
  { n: 19, acct: SHOP, from: P.customer2, to: [P.mayaShop], ago: 5 * day, thread: 'vase', subject: 'Re: Large vase, glaze question', text: 'Perfect, the tenmoku it is. I will pick it up at the market.\n\nGrazie!\nMarco', read: true, quoted: [P.mayaShop, 'It comes in tenmoku or celadon. The tenmoku is darker, almost black where the glaze pools.'] },
  { n: 20, acct: WORK, from: P.jonas, to: [P.maya], ago: 6 * day, subject: 'Studio offsite in March', text: 'Hi team,\n\nSave the date: we are planning two days away in early March, somewhere with a big table and bad phone reception. Ideas welcome.\n\nJonas', read: true },
  { n: 21, acct: HOME, from: P.noor, to: [P.mayaHome], ago: 8 * day, subject: 'Photos from the coast', text: 'Maya! I finally sorted the photos from our weekend at the coast. The one of you on the rocks with the thermos is a keeper. I will send the album link tonight.\n\nNoor', read: true },

  // ── The roadmap conversation, started a day ago ─────────────────────────────
  { n: 30, acct: WORK, from: P.jonas, to: [P.maya, P.priya, P.tomas], ago: 26 * hour, thread: 'roadmap', subject: 'Q4 roadmap review', attach: [['q4-roadmap-notes.md', 'notes', 'text/markdown', 160]], text: 'Hi all,\n\nI put my notes for the Q4 roadmap in the attached file. Short version: Harbor & Pine ships first, Oakline moves up, and we hire in January.\n\nShall we review it together on Thursday at 11?\n\nJonas', read: true },
  { n: 31, acct: WORK, folder: 'Sent', from: P.maya, to: [P.jonas, P.priya, P.tomas], ago: 25 * hour, thread: 'roadmap', subject: 'Re: Q4 roadmap review', text: 'Thanks Jonas, the notes look right to me. Thursday works.\n\nOne question: do we want the Oakline sketches before or after the Harbor & Pine launch? I would rather not split Tomás across both in the same week.\n\nMaya', read: true },
  { n: 32, acct: WORK, from: P.priya, to: [P.maya, P.jonas, P.tomas], ago: 3 * hour, thread: 'roadmap', subject: 'Re: Q4 roadmap review', text: 'I can take the Oakline logo round if Tomás is still on the website. That way nobody is split.\n\nPriya', read: true },

  { n: 33, acct: HOME, folder: 'Sent', from: P.mayaHome, to: [P.mum], cc: [P.sam], ago: 5 * hour, thread: 'sunday', subject: 'Re: Sunday lunch?', text: 'Yes please! We will bring dessert. Sam says he will bring the bread, which means he will forget the bread.\n\nSee you at one.\nMaya', read: true },
  { n: 34, acct: HOME, from: P.sam, to: [P.mayaHome, P.mum], ago: 4.5 * hour, thread: 'sunday', subject: 'Re: Sunday lunch?', text: 'I will NOT forget the bread. Probably.\n\nSam', read: false },
  { n: 35, acct: SHOP, folder: 'Sent', from: P.mayaShop, to: [P.customer2], ago: 5.5 * day, thread: 'vase', subject: 'Re: Large vase, glaze question', text: 'Hi Marco,\n\nIt comes in tenmoku or celadon. The tenmoku is darker, almost black where the glaze pools. Both are food safe.\n\nMaya', read: true },
  { n: 36, acct: SHOP, from: P.customer2, to: [P.mayaShop], ago: 6 * day, thread: 'vase', folder: 'Archive', subject: 'Large vase, glaze question', text: 'Hello, I saw the large vase on your site. Which glazes does it come in?\n\nMarco', read: true },

  // ── Emoji reactions (RFC 9078 / Gmail): chips under the message they react to ──
  { n: 60, acct: WORK, from: P.jonas, to: [P.maya], cc: [P.priya, P.tomas], ago: 24.5 * hour, thread: 'roadmap', subject: 'Re: Q4 roadmap review', reactTo: 31, emoji: '👍', read: true },
  { n: 61, acct: WORK, from: P.tomas, to: [P.maya], cc: [P.jonas, P.priya], ago: 24 * hour, thread: 'roadmap', subject: 'Re: Q4 roadmap review', reactTo: 31, emoji: '👍', read: true },
  { n: 62, acct: WORK, folder: 'Sent', from: P.maya, to: [P.priya], cc: [P.jonas, P.tomas], ago: 2.5 * hour, thread: 'roadmap', subject: 'Re: Q4 roadmap review', reactTo: 32, emoji: '🙏', read: true },
  { n: 63, acct: HOME, from: P.mum, to: [P.sam], cc: [P.mayaHome], ago: 4.2 * hour, thread: 'sunday', subject: 'Re: Sunday lunch?', reactTo: 34, emoji: '😂', read: false },

  // ── Other folders ────────────────────────────────────────────────────────────
  { n: 40, acct: WORK, folder: 'Sent', from: P.maya, to: [P.harbor], ago: 2 * day, subject: 'Moodboard v3', attach: [['moodboard-v3.png', 'moodboard', 'image/png', 48210]], text: 'Hi Owen,\n\nHere is the third version of the moodboard. I leaned into the warm coast idea we talked about.\n\nMaya', read: true },
  { n: 41, acct: WORK, folder: 'Drafts', from: P.maya, to: [P.oakline], ago: 40 * min, subject: 'Logo round two: first look', text: 'Hi Sanne,\n\nA first look at the leaf and wheel direction, at three sizes...', read: true, draft: true },
  { n: 42, acct: WORK, folder: 'Archive', from: P.cloudberry, to: [P.maya], ago: 31 * day, subject: 'Your October invoice CB-2026-10-03377', html: invoiceHtml.replace('CB-2026-11-04821', 'CB-2026-10-03377').replace('November', 'October'), category: 'automated', read: true },
  { n: 43, acct: WORK, folder: 'Clients/Harbor & Pine', from: P.harbor, to: [P.maya], ago: 14 * day, subject: 'Kick-off notes', text: 'Thanks for a great kick-off yesterday! As promised, our brand values: calm, honest, salt-weathered.\n\nOwen', read: true },
  { n: 44, acct: WORK, folder: 'Clients/Oakline Bikes', from: P.oakline, to: [P.maya], ago: 12 * day, subject: 'Brief: new logo', text: 'Hi Maya, attached is our brief for the new Oakline logo. We would love a first round within three weeks.\n\nSanne', read: true },
  { n: 45, acct: WORK, folder: 'Receipts', from: P.cloudberry, to: [P.maya], ago: 61 * day, subject: 'Your September invoice CB-2026-09-02190', html: invoiceHtml.replace('CB-2026-11-04821', 'CB-2026-09-02190').replace('November', 'September'), category: 'automated', read: true },
  { n: 46, acct: WORK, folder: 'Junk', from: ['Prize Department', 'winner@lucky-draw.example.com'], to: [P.maya], ago: 1 * day, subject: 'You have WON a cruise!!!', text: 'Click here to claim your prize. Offer valid for 24 hours only.', read: false },
  { n: 47, acct: HOME, folder: 'Travel', from: P.rail, to: [P.mayaHome], ago: 40 * day, subject: 'Your e-ticket: Bergen → Oslo S', html: ticketHtml.replace('Oslo S → Bergen', 'Bergen → Oslo S'), category: 'automated', read: true },
  { n: 48, acct: HOME, folder: 'Family', from: P.mum, to: [P.mayaHome], ago: 20 * day, subject: 'Grandpa\'s fish soup recipe', text: 'Here it is, finally written down:\n\nCod, potatoes, leek, carrots, a good fish stock, cream, and far more dill than you think.\n\nMum', read: true },
  { n: 49, acct: HOME, folder: 'Trash', from: ['Deals Daily', 'deals@dealsdaily.example.com'], to: [P.mayaHome], ago: 2 * day, subject: '48 hours only: 30 % off everything', text: 'Big savings on things you did not know you needed.', category: 'promotion', read: true },
  { n: 50, acct: SHOP, folder: 'Orders', from: ['Fernhill shop', 'shop@fernhill.example.net'], to: [P.mayaShop], ago: 3 * day, subject: 'New order #1047: Speckled blue mug × 2', text: 'New order from Lena Strand.\n\n2 × Speckled blue mug, 34.00\nShipping 6.50\nTotal 74.50', category: 'automated', read: true },
  { n: 51, acct: SHOP, folder: 'Suppliers', from: P.kiln, to: [P.mayaShop], ago: 10 * day, subject: 'Price list 2027', text: 'Hello, our price list for next year is attached. Prices stay the same for orders placed before 31 January.\n\nKilnWorks Supply', read: true },
];

const addr = ([name, email]) => ({ name, email });

function snippetOf(spec) {
  if (spec.pgp === 'encrypted') return '-----BEGIN PGP MESSAGE-----';
  const text = spec.text || spec.html?.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ') || '';
  return text.replace(/\s+/g, ' ').trim().slice(0, 180);
}

export function buildMessages(now = Date.now()) {
  const uids = new Map();
  return SPECS.map((spec) => {
    const folder = spec.folder || 'INBOX';
    const key = `${spec.acct}:${folder}`;
    const uid = (uids.get(key) || 100) + 1;
    uids.set(key, uid);
    const messageId = `<demo-${spec.n}@plimail.example.com>`;
    const thread = spec.thread ? `<thread-${spec.thread}@plimail.example.com>` : messageId;
    let html = spec.html || null;
    let text = spec.text || null;
    if (spec.pgp === 'signed') { html = null; text = PGP.signedText; }
    if (spec.pgp === 'encrypted') { html = null; text = PGP.encryptedText; }
    // A reaction's body is the fallback other clients show (backend outgoingMail renderReactionMime).
    if (spec.emoji) {
      text = spec.emoji;
      html = `<div style="font-size:32px;line-height:1.25">${spec.emoji}</div><div style="font-family:sans-serif;font-size:14px;color:#555">${spec.from[0]} reacted ${spec.emoji} to your message</div>`;
    }
    if (!html && text && !spec.pgp) html = personal(text) + (spec.quoted ? quote(spec.quoted[0][0], spec.quoted[1]) : '');
    const attachments = (spec.attach || []).map(([filename, file, type, size], i) => ({
      part: String(i + 2), filename, type, size, disposition: 'attachment', file,
    }));
    if (spec.invite) attachments.push({ part: String(attachments.length + 2), filename: 'invite.ics', type: 'text/calendar', size: 900, disposition: 'attachment', file: 'invite' });
    return {
      id: id(1000 + spec.n),
      uid,
      account_id: spec.acct,
      folder,
      message_id: messageId,
      thread_id: thread,
      subject: spec.subject,
      from_name: spec.from[0],
      from_email: spec.from[1],
      to_addresses: spec.to.map(addr),
      cc_addresses: (spec.cc || []).map(addr),
      reply_to: [],
      in_reply_to: spec.reactTo ? `<demo-${spec.reactTo}@plimail.example.com>` : spec.thread && thread !== messageId ? thread : null,
      reaction_emoji: spec.emoji || null,
      thread_references: spec.thread && thread !== messageId ? [thread] : [],
      date: new Date(now - spec.ago).toISOString(),
      snippet: snippetOf(spec),
      is_read: spec.read ?? false,
      is_starred: spec.starred ?? false,
      is_draft: !!spec.draft,
      has_attachments: attachments.length > 0,
      category: spec.category || null,
      list_unsubscribe: spec.unsubscribe ? '<https://pixelpost.example.org/unsubscribe>' : null,
      list_unsubscribe_post: null,
      unsubscribed_at: null,
      delivery_addresses: [],
      has_contact_photo: false,
      body: { html, text, attachments, pgp: spec.pgp || null },
    };
  });
}

export const CONTACTS = [
  [P.jonas, 'Brightwater Studio', '+47 21 00 00 11', 18],
  [P.priya, 'Brightwater Studio', '+47 21 00 00 12', 15],
  [P.tomas, 'Brightwater Studio', null, 12],
  [P.lea, 'Brightwater Studio', null, 9],
  [P.harbor, 'Harbor & Pine', '+44 20 7946 0018', 11],
  [P.oakline, 'Oakline Bikes', '+31 20 555 0143', 7],
  [P.elena, 'Quill Press', null, 5],
  [P.mum, null, '+47 22 00 00 31', 22],
  [P.sam, null, '+47 22 00 00 32', 14],
  [P.noor, null, null, 6],
  [P.customer, null, null, 2],
  [P.customer2, null, null, 3],
].map(([[name, email], organization, phone, sends], i) => {
  const [first, ...rest] = name.split(' ');
  return {
    id: id(2000 + i),
    uid: `demo-contact-${i}`,
    display_name: name,
    first_name: first,
    last_name: rest.join(' '),
    primary_email: email,
    emails: [{ type: 'work', value: email }],
    phones: phone ? [{ type: 'mobile', value: phone }] : [],
    organization,
    notes: null,
    is_auto: false,
    send_count: sends,
    last_sent: null,
    etag: `etag-${i}`,
    created_at: '2026-03-02T09:00:00.000Z',
    updated_at: '2026-10-11T09:00:00.000Z',
    has_contact_photo: false,
  };
});

export const CONTACT_GROUPS = [
  { id: id(3001), name: 'Studio team', source: 'local', members: [0, 1, 2, 3] },
  { id: id(3002), name: 'Family', source: 'local', members: [7, 8] },
];

export const CALENDAR_ACCOUNTS = [
  { id: id(4001), name: 'Brightwater', serverUrl: 'https://dav.brightwater.example.com/', username: 'maya', intervalMin: 15 },
  { id: id(4002), name: 'Personal', serverUrl: 'https://caldav.example.org/', username: 'maya.lindqvist', intervalMin: 15 },
];

export const CALENDARS = [
  { id: id(4101), accountId: id(4001), accountName: 'Brightwater', name: 'Work', serverName: 'work', displayName: null, ignored: false, color: '#3b82f6', visible: true, readOnly: false },
  { id: id(4102), accountId: id(4001), accountName: 'Brightwater', name: 'Studio holidays', serverName: 'holidays', displayName: null, ignored: false, color: '#8b5cf6', visible: true, readOnly: true },
  { id: id(4201), accountId: id(4002), accountName: 'Personal', name: 'Personal', serverName: 'personal', displayName: null, ignored: false, color: '#10b981', visible: true, readOnly: false },
  { id: id(4202), accountId: id(4002), accountName: 'Personal', name: 'Climbing', serverName: 'climbing', displayName: null, ignored: false, color: '#f97316', visible: true, readOnly: false },
];

// Events for the week the demo opens in (Monday-based), as [calendar, day offset from Monday,
// start hour, duration in hours, summary, extra].
export function buildEvents(now = new Date()) {
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const at = (dayOffset, hourFloat) => {
    const d = new Date(monday);
    d.setDate(d.getDate() + dayOffset);
    d.setMinutes(Math.round(hourFloat * 60));
    return d;
  };
  const me = { name: 'Maya Lindqvist', email: 'maya@brightwater.example.com' };
  const rows = [
    [id(4101), 0, 9.5, 0.5, 'Studio stand-up', { recurrence: { freq: 'DAILY', interval: 1, until: null, count: null } }],
    [id(4101), 1, 9.5, 0.5, 'Studio stand-up', {}],
    [id(4101), 2, 9.5, 0.5, 'Studio stand-up', {}],
    [id(4101), 3, 9.5, 0.5, 'Studio stand-up', {}],
    [id(4101), 4, 9.5, 0.5, 'Studio stand-up', {}],
    [id(4101), 0, 13, 1.5, 'Harbor & Pine: page layouts', { location: 'Video call', organizerIsMe: true, attendees: [{ name: 'Owen Callaghan', email: 'owen@harborandpine.example.com', status: 'ACCEPTED' }] }],
    [id(4101), 1, 11, 1, 'Oakline logo review', { location: 'Meeting room Fjord' }],
    [id(4201), 1, 18.5, 1.5, 'Pottery class', { location: 'Fernhill studio' }],
    [id(4101), 2, 12, 1, 'Lunch & learn: colour palettes', { location: 'Kitchen', description: 'Priya runs a session on accessible colour palettes.' }],
    [id(4202), 2, 19, 2, 'Members night', { location: 'Granite Climbing Club' }],
    [id(4101), 3, 10, 1, 'Q4 roadmap review', { location: 'Studio (2nd floor)', organizerIsMe: false, organizer: { name: 'Jonas Ferreira', email: 'jonas@brightwater.example.com' }, myStatus: 'ACCEPTED' }],
    [id(4101), 3, 14, 1, 'Design critique', { location: 'Studio (2nd floor)', description: 'We will look at the Harbor & Pine home page and the Oakline logo sketches.', organizer: { name: 'Léa Moreau', email: 'lea@brightwater.example.com' }, myStatus: 'NEEDS-ACTION', invite: true }],
    [id(4101), 4, 15, 2, 'Harbor & Pine launch prep', {}],
    [id(4201), 4, 19.5, 2.5, 'Dinner with Noor', { location: 'Little Harbour Bistro' }],
    [id(4201), 6, 13, 3, 'Sunday lunch at Mum\'s', {}],
    [id(4202), 5, 10, 3, 'Bouldering', { location: 'Granite Climbing Club' }],
  ];
  const events = rows.map(([calendarId, d, h, dur, summary, extra], i) => {
    const start = at(d, h);
    const end = new Date(start.getTime() + dur * 3600_000);
    const organizer = extra.organizer || (extra.attendees ? me : null);
    const attendees = extra.attendees || (extra.organizer ? [{ ...me, status: extra.myStatus }] : []);
    return {
      id: `${id(5000 + i)}:`, eventId: id(5000 + i), calendarId, readOnly: false,
      uid: `demo-event-${i}@plimail.example.com`,
      summary, location: extra.location || null, description: extra.description || null, url: null,
      allDay: false, start: start.toISOString(), end: end.toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      status: 'CONFIRMED', organizer, attendees, reminderMinutes: 10,
      recurrence: null, custom: false, recurrenceId: null,
      organizerIsMe: extra.organizerIsMe ?? (organizer ? organizer.email === me.email : false),
      myStatus: extra.myStatus ?? null,
    };
  });
  // A holiday all-day event, and next week's offsite placeholder.
  const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const friday = at(4, 0), saturday = at(5, 0);
  events.push({
    id: `${id(5100)}:`, eventId: id(5100), calendarId: id(4102), readOnly: true, uid: 'demo-holiday@plimail.example.com',
    summary: 'Studio closes early', location: null, description: null, url: null, allDay: true,
    start: ymd(friday), end: ymd(saturday), timezone: null, status: 'CONFIRMED', organizer: null, attendees: [],
    reminderMinutes: null, recurrence: null, custom: false, recurrenceId: null, organizerIsMe: false, myStatus: null,
  });
  return events;
}
