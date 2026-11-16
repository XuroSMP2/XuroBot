const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

module.exports = function startDashboard(ctx) {
  const { client, cfg, save, P, ChannelType, AM } = ctx;
  const env = process.env;

  const missing = ['DASHBOARD_URL', 'CLIENT_SECRET', 'SESSION_SECRET', 'CLIENT_ID', 'GUILD_ID'].filter((k) => !env[k]);
  if (missing.length) {
    console.log(`Dashboard ist aus (fehlende Variablen: ${missing.join(', ')}).`);
    return;
  }

  const base = env.DASHBOARD_URL.replace(/\/+$/, '');
  const origin = new URL(base).origin;
  const secure = base.startsWith('https');
  const WEEK = 7 * 24 * 60 * 60 * 1000;
  const DASH_HTML = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');
  const LOGIN_HTML = `<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>xurosmp Dashboard</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#1a1b1e;color:#e8e9eb}
.box{text-align:center;padding:32px;background:#25262b;border-radius:16px;max-width:320px}
a{display:inline-block;margin-top:16px;padding:12px 20px;border-radius:10px;background:#5865f2;color:#fff;text-decoration:none;font-weight:600}</style></head>
<body><div class="box"><h1>⚙️ xurosmp</h1><p>Melde dich mit Discord an, um den Server zu verwalten.</p><a href="/login">Mit Discord anmelden</a></div></body></html>`;

  // ───────────── Signierte Cookies ─────────────
  const sign = (data) => crypto.createHmac('sha256', env.SESSION_SECRET).update(data).digest('base64url');
  const pack = (obj) => {
    const b = Buffer.from(JSON.stringify(obj)).toString('base64url');
    return `${b}.${sign(b)}`;
  };
  const unpack = (str) => {
    if (!str) return null;
    const [b, sig] = str.split('.');
    if (!b || !sig) return null;
    const exp = sign(b);
    if (sig.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp))) return null;
    try {
      const o = JSON.parse(Buffer.from(b, 'base64url').toString());
      return o.exp > Date.now() ? o : null;
    } catch { return null; }
  };
  const parseCookies = (req) => {
    const out = {};
    for (const part of (req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    return out;
  };
  const setCookie = (res, name, value, maxAgeSec) =>
    res.append('Set-Cookie', `${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`);
  const readSession = (req) => unpack(parseCookies(req).sid);

  // ───────────── App ─────────────
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' https://cdn.discordapp.com data:; frame-ancestors 'none'",
    });
    next();
  });
  app.use(express.json({ limit: '50kb' }));

  app.get('/', (req, res) => res.type('html').send(readSession(req) ? DASH_HTML : LOGIN_HTML));

  app.get('/login', (req, res) => {
    const state = crypto.randomBytes(16).toString('hex');
    setCookie(res, 'st', state, 600);
    const url = 'https://discord.com/oauth2/authorize?' + new URLSearchParams({
      client_id: env.CLIENT_ID, response_type: 'code', redirect_uri: `${base}/callback`, scope: 'identify', state, prompt: 'none',
    });
    res.redirect(url);
  });

  app.get('/callback', async (req, res) => {
    try {
      const { code, state } = req.query;
      if (!code || !state || state !== parseCookies(req).st) return res.status(400).send('Ungültige Anmeldung. Bitte erneut versuchen.');
      const tok = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: env.CLIENT_ID, client_secret: env.CLIENT_SECRET, grant_type: 'authorization_code',
          code: String(code), redirect_uri: `${base}/callback`,
        }),
      });
      if (!tok.ok) throw new Error(`Token-Anfrage fehlgeschlagen (${tok.status}). Stimmen CLIENT_SECRET und die Redirect-URL?`);
      const { access_token } = await tok.json();
      const me = await (await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${access_token}` } })).json();
      if (!me.id) throw new Error('Kein Benutzer erhalten');
      setCookie(res, 'sid', pack({ u: me.id, n: me.global_name || me.username, a: me.avatar, exp: Date.now() + WEEK }), WEEK / 1000);
      setCookie(res, 'st', '', 0);
      res.redirect('/');
    } catch (e) {
      console.error('Dashboard-Login:', e.message);
      res.status(500).send('Anmeldung fehlgeschlagen. Details stehen in den Railway-Logs.');
    }
  });

  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  app.get('/leaderboard', async (req, res) => {
    const g = client.guilds.cache.get(env.GUILD_ID);
    const c = g && cfg(g.id);
    const page = (body) => `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rangliste</title><style>:root{color-scheme:dark light}body{font-family:system-ui,sans-serif;margin:0;padding:24px;background:#0e1015;color:#eceff6}
@media(prefers-color-scheme:light){body{background:#f2f4f9;color:#1a1f2d}.row{background:#fff!important;border-color:#e2e6ef!important}}
main{max-width:720px;margin:0 auto}h1{margin:0 0 4px}p.s{color:#8d97ad;margin:0 0 20px}
.row{display:flex;align-items:center;gap:14px;padding:12px 14px;margin-bottom:10px;background:#1a1e29;border:1px solid #2a3042;border-radius:14px}
.rk{width:34px;text-align:center;font-weight:800;font-size:18px}.av{width:42px;height:42px;border-radius:50%;background:#2a3042}
.nm{flex:1;min-width:0;font-weight:700;word-break:break-word}.nm small{display:block;color:#8d97ad;font-weight:400}
.lv{background:linear-gradient(135deg,#6c7bff,#8f6bff);color:#fff;padding:6px 12px;border-radius:10px;font-weight:800}</style></head><body><main>${body}</main></body></html>`;
    if (!g || !c.publicLeaderboard) return res.status(404).type('html').send(page('<h1>🏆 Rangliste</h1><p class="s">Die Rangliste ist nicht öffentlich.</p>'));
    const top = Object.entries(ctx.getXp(c).users).sort((a, b) => b[1].xp - a[1].xp).slice(0, 25);
    const missing = top.map(([id]) => id).filter((id) => !g.members.cache.has(id));
    if (missing.length) await g.members.fetch({ user: missing.slice(0, 100) }).catch(() => {});
    const rows = top.map(([id, u], i) => {
      const m = g.members.cache.get(id);
      const info = ctx.xpInfo(u.xp);
      const av = m ? m.displayAvatarURL({ size: 64, extension: 'png' }) : '';
      return `<div class="row"><div class="rk">${['🥇', '🥈', '🥉'][i] || i + 1}</div>${av ? `<img class="av" src="${esc(av)}" alt="">` : '<div class="av"></div>'}
<div class="nm">${esc(m?.displayName || 'Ehemaliges Mitglied')}<small>${u.xp} XP</small></div><div class="lv">Level ${info.level}</div></div>`;
    }).join('');
    res.type('html').send(page(`<h1>🏆 Rangliste</h1><p class="s">${esc(g.name)} · Top 25 nach XP</p>${rows || '<p class="s">Noch niemand hat XP gesammelt.</p>'}`));
  });

  app.get('/logout', (req, res) => { setCookie(res, 'sid', '', 0); res.redirect('/'); });

  // ───────────── API ─────────────
  const api = express.Router();

  // CSRF-Schutz: nur eigene Seite, eigener Header
  api.use((req, res, next) => {
    if (req.method !== 'GET') {
      if (req.get('x-requested-with') !== 'dash') return res.status(403).json({ error: 'Ungültige Anfrage' });
      const o = req.get('origin');
      if (o && o !== origin) return res.status(403).json({ error: 'Ungültige Herkunft' });
    }
    next();
  });

  // Anmeldung + Berechtigung bei jeder Anfrage prüfen
  api.use(async (req, res, next) => {
    try {
      const sess = readSession(req);
      if (!sess) return res.status(401).json({ error: 'Nicht angemeldet' });
      const guild = client.guilds.cache.get(env.GUILD_ID);
      if (!guild) return res.status(503).json({ error: 'Der Bot ist noch nicht bereit oder nicht auf dem Server.' });
      const member = await guild.members.fetch(sess.u).catch(() => null);
      if (!member || !member.permissions.has(P.ManageGuild)) {
        return res.status(403).json({ error: 'Kein Zugriff: Du brauchst die Berechtigung „Server verwalten“.' });
      }
      req.sess = sess; req.guild = guild; req.member = member;
      next();
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
    console.error('Dashboard:', e.message);
    res.status(500).json({ error: e.message || 'Fehler' });
  });
  const audit = (req, t) => ctx.log(req.guild, `🌐 **${req.sess.n}** ${t}`);
  const isAdmin = (req) => req.member.permissions.has(P.Administrator);
  const text = (v, max) => String(v ?? '').trim().slice(0, max);
  let busy = false;
  const setupDone = (g) => { const c = cfg(g.id); return !!(c.channels.j2c && g.channels.cache.has(c.channels.j2c)); };

  api.get('/me', (req, res) => res.json({ name: req.sess.n, id: req.sess.u, avatar: req.sess.a, guild: req.guild.name }));

  api.get('/overview', wrap(async (req, res) => {
    const g = req.guild, c = cfg(g.id);
    const mc = await ctx.getStatus();
    const bots = g.members.cache.filter((m) => m.user.bot).size;
    res.json({
      guild: g.name, members: Math.max(g.memberCount - bots, 0), bots, channels: g.channels.cache.size,
      setup: setupDone(g),
      mc: mc.online ? { online: true, players: mc.res.players.online, max: mc.res.players.max, version: mc.res.version.name } : { online: false },
      persistent: ctx.backupInfo().persistent,
      aiAvailable: !!env.ANTHROPIC_API_KEY, ai: ctx.aiOn(c), guided: ctx.guidedOn(c), rulesGate: !!c.rulesGate, publicLeaderboard: !!c.publicLeaderboard,
    });
  }));

  api.post('/settings', wrap(async (req, res) => {
    const c = cfg(req.guild.id);
    if (typeof req.body.guided === 'boolean') c.guided = req.body.guided;
    if (typeof req.body.rulesGate === 'boolean') c.rulesGate = req.body.rulesGate;
    if (typeof req.body.publicLeaderboard === 'boolean') c.publicLeaderboard = req.body.publicLeaderboard;
    if (typeof req.body.ai === 'boolean') {
      if (!env.ANTHROPIC_API_KEY) return res.status(400).json({ error: 'Es fehlt die Variable ANTHROPIC_API_KEY.' });
      c.ai = req.body.ai;
    }
    save();
    res.json({ ok: true });
  }));

  api.get('/backup', (req, res) => res.json(ctx.backupInfo()));
  api.post('/backup', wrap(async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Dafür brauchst du Administrator-Rechte.' });
    await ctx.backupNow(req.guild, true);
    res.json({ ok: true, last: ctx.backupInfo().last });
  }));

  api.post('/setup', wrap(async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Dafür brauchst du Administrator-Rechte.' });
    if (setupDone(req.guild)) return res.status(400).json({ error: 'Der Server ist bereits eingerichtet.' });
    if (busy) return res.status(409).json({ error: 'Es läuft gerade eine andere Aktion.' });
    busy = true;
    try { await ctx.runSetup(req.guild); } finally { busy = false; }
    res.json({ ok: true });
  }));

  api.post('/reset', wrap(async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Dafür brauchst du Administrator-Rechte.' });
    if (text(req.body.confirm, 20).toUpperCase() !== 'LÖSCHEN') return res.status(400).json({ error: 'Bestätigung fehlt: Tippe LÖSCHEN.' });
    if (busy) return res.status(409).json({ error: 'Es läuft gerade eine andere Aktion.' });
    busy = true;
    try { res.json(await ctx.runReset(req.guild, !!req.body.rollen)); } finally { busy = false; }
  }));

  api.get('/channels', (req, res) => {
    const list = req.guild.channels.cache.filter((ch) => ch.type === ChannelType.GuildText)
      .map((ch) => ({ id: ch.id, name: ch.name })).sort((a, b) => a.name.localeCompare(b.name));
    res.json(list);
  });

  // Panels
  api.get('/panels', wrap(async (req, res) => {
    const g = req.guild, out = [];
    for (const p of cfg(g.id).panels ?? []) {
      const ch = g.channels.cache.get(p.channelId);
      const msg = ch && await ch.messages.fetch(p.messageId).catch(() => null);
      if (!msg || !ctx.isPanel(msg)) continue;
      const e = msg.embeds[0], b = msg.components[0].components[0];
      out.push({
        channelId: p.channelId, messageId: p.messageId, type: p.type, channel: ch.name,
        title: e.title || '', text: e.description || '', button: b.label || '', color: e.hexColor || '#57f287',
      });
    }
    res.json(out);
  }));

  api.post('/panels', wrap(async (req, res) => {
    const type = req.body.type === 'apply' ? 'apply' : 'ticket';
    const ch = req.guild.channels.cache.get(String(req.body.channelId));
    if (!ch || ch.type !== ChannelType.GuildText) return res.status(400).json({ error: 'Bitte wähle einen Textkanal.' });
    await ctx.createPanel(req.guild, ch, type, text(req.body.title, 100), text(req.body.text, 1500));
    res.json({ ok: true });
  }));

  const findPanel = async (req) => {
    const g = req.guild, c = cfg(g.id);
    const p = (c.panels ?? []).find((x) => x.channelId === req.params.channelId && x.messageId === req.params.messageId);
    if (!p) return {};
    const ch = g.channels.cache.get(p.channelId);
    const msg = ch && await ch.messages.fetch(p.messageId).catch(() => null);
    return { c, msg };
  };

  api.put('/panels/:channelId/:messageId', wrap(async (req, res) => {
    const { msg } = await findPanel(req);
    if (!msg || !ctx.isPanel(msg)) return res.status(404).json({ error: 'Panel nicht gefunden.' });
    await ctx.editPanelMessage(msg, {
      title: text(req.body.title, 100), text: text(req.body.text, 1500), button: text(req.body.button, 80), color: text(req.body.color, 7),
    });
    res.json({ ok: true });
  }));

  api.delete('/panels/:channelId/:messageId', wrap(async (req, res) => {
    const { c, msg } = await findPanel(req);
    if (!c) return res.status(404).json({ error: 'Panel nicht gefunden.' });
    if (msg) await msg.delete().catch(() => {});
    c.panels = c.panels.filter((x) => x.messageId !== req.params.messageId);
    save();
    res.json({ ok: true });
  }));

  // Auto-Antworten
  api.get('/faq', (req, res) => res.json(ctx.getFaq(cfg(req.guild.id))));

  api.post('/faq', wrap(async (req, res) => {
    const k = text(req.body.k, 50).toLowerCase(), a = text(req.body.a, 1000);
    if (!k || !a) return res.status(400).json({ error: 'Stichwort und Antwort werden gebraucht.' });
    const faq = ctx.getFaq(cfg(req.guild.id));
    const ex = faq.find((f) => f.k === k);
    if (ex) ex.a = a; else faq.push({ k, a });
    save();
    res.json({ ok: true });
  }));

  api.delete('/faq/:k', wrap(async (req, res) => {
    const faq = ctx.getFaq(cfg(req.guild.id));
    const i = faq.findIndex((f) => f.k === req.params.k.toLowerCase());
    if (i < 0) return res.status(404).json({ error: 'Stichwort nicht gefunden.' });
    faq.splice(i, 1); save();
    res.json({ ok: true });
  }));

  // AutoMod
  api.get('/automod', wrap(async (req, res) => {
    const rules = [...(await req.guild.autoModerationRules.fetch()).values()].filter((r) => r.name.startsWith(AM));
    const custom = rules.find((r) => r.name === AM + 'Eigene Wörter');
    res.json({
      rules: rules.map((r) => ({ name: r.name.slice(AM.length), enabled: r.enabled })),
      words: custom?.triggerMetadata?.keywordFilter ?? [],
    });
  }));
  api.post('/automod/setup', wrap(async (req, res) => res.json({ made: await ctx.setupAutoMod(req.guild) })));
  api.delete('/automod', wrap(async (req, res) => res.json({ removed: await ctx.removeAutoMod(req.guild) })));
  api.post('/automod/words', wrap(async (req, res) => {
    const word = text(req.body.word, 60);
    if (!word) return res.status(400).json({ error: 'Bitte ein Wort eingeben.' });
    res.json({ message: await ctx.changeWord(req.guild, word, req.body.add !== false) });
  }));

  // Ankündigung
  api.post('/announce', wrap(async (req, res) => {
    const body = text(req.body.text, 4000);
    if (!body) return res.status(400).json({ error: 'Bitte einen Text eingeben.' });
    const image = text(req.body.image, 500);
    if (image && !/^https:\/\/\S+$/i.test(image)) return res.status(400).json({ error: 'Die Bild-URL muss mit https:// beginnen.' });
    const ping = String(req.body.pingRoleId || '');
    if (ping && !req.guild.roles.cache.has(ping)) return res.status(400).json({ error: 'Rolle zum Pingen nicht gefunden.' });
    await ctx.announce(req.guild, String(req.body.channelId || ''), text(req.body.title, 100), body,
      { color: hexColor(req.body.color), image, footer: text(req.body.footer, 200), pingRoleId: ping });
    audit(req, `📢 hat eine Nachricht gesendet${text(req.body.title, 60) ? `: ${text(req.body.title, 60)}` : ''}`);
    res.json({ ok: true });
  }));

  // Tickets
  const TICKET = /^(ticket|apply):\d+$/;
  api.get('/tickets', (req, res) => {
    const g = req.guild;
    const list = [...g.channels.cache.values()].filter((ch) => ch.topic && TICKET.test(ch.topic)).map((ch) => {
      const [type, uid] = ch.topic.split(':');
      const m = g.members.cache.get(uid);
      return { id: ch.id, name: ch.name, type, user: m ? m.displayName : uid, created: ch.createdTimestamp };
    });
    res.json(list);
  });

  api.post('/tickets/:id/close', wrap(async (req, res) => {
    const ch = req.guild.channels.cache.get(req.params.id);
    if (!ch || !ch.topic || !TICKET.test(ch.topic)) return res.status(404).json({ error: 'Ticket nicht gefunden.' });
    const name = ch.name;
    await ch.delete(`Dashboard: ${req.sess.n}`);
    ctx.log(req.guild, `🔒 Ticket #${name} wurde im Dashboard von ${req.sess.n} geschlossen.`);
    res.json({ ok: true });
  }));

  // Aktivität, Verlauf
  const plain = (g, t) => String(t)
    .replace(/<@&(\d+)>/g, (m, id) => '@' + (g.roles.cache.get(id)?.name || 'Rolle'))
    .replace(/<@!?(\d+)>/g, (m, id) => '@' + (g.members.cache.get(id)?.displayName || 'Mitglied'))
    .replace(/<#(\d+)>/g, (m, id) => '#' + (g.channels.cache.get(id)?.name || 'kanal'))
    .replace(/<t:\d+(?::\w)?>/g, '').replace(/[*`]/g, '');
  api.get('/activity', (req, res) => res.json((cfg(req.guild.id).activity ?? []).slice(0, 30).map((a) => ({ t: a.t, text: plain(req.guild, a.text) }))));
  api.get('/history', (req, res) => res.json(cfg(req.guild.id).history ?? []));

  // Willkommensnachricht
  api.get('/welcome', (req, res) => {
    const c = cfg(req.guild.id);
    res.json({ config: ctx.welcomeConfig(c), defaultChannel: c.channels.welcome || '', server: req.guild.name, members: req.guild.memberCount,
      ip: `${env.MC_HOST || 'play.xurosmp.net'}${(env.MC_PORT || '25565') === '25565' ? '' : ':' + env.MC_PORT}` });
  });
  api.put('/welcome', wrap(async (req, res) => {
    const c = cfg(req.guild.id), b = req.body;
    const title = text(b.title, 256), body = text(b.text, 2000);
    if (!title || !body) return res.status(400).json({ error: 'Titel und Text dürfen nicht leer sein.' });
    const channelId = String(b.channelId || '');
    if (channelId && req.guild.channels.cache.get(channelId)?.type !== ChannelType.GuildText) return res.status(400).json({ error: 'Bitte wähle einen Textkanal.' });
    c.welcome = { enabled: !!b.enabled, title, text: body, color: hexColor(b.color, '#57f287'), channelId };
    save();
    audit(req, '👋 hat die Willkommensnachricht geändert');
    res.json({ ok: true });
  }));
  api.post('/welcome/test', wrap(async (req, res) => {
    const ok = await ctx.sendWelcome(req.member);
    if (!ok) return res.status(400).json({ error: 'Es konnte nichts gesendet werden: Willkommensnachricht ist aus oder es gibt keinen Kanal.' });
    res.json({ ok: true });
  }));

  // Button-Rollen
  api.post('/rolepanels', wrap(async (req, res) => {
    const ch = req.guild.channels.cache.get(String(req.body.channelId));
    if (!ch || ch.type !== ChannelType.GuildText) return res.status(400).json({ error: 'Bitte wähle einen Textkanal.' });
    const ids = Array.isArray(req.body.roleIds) ? req.body.roleIds.map(String).slice(0, 5) : [];
    for (const id of ids) {
      if (!editableRole(req, req.guild.roles.cache.get(id))) return res.status(403).json({ error: 'Eine der Rollen darfst du nicht verwalten.' });
    }
    await ctx.createRolePanel(req.guild, ch, text(req.body.title, 100), text(req.body.text, 1500), ids);
    audit(req, `🎭 hat ein Rollen-Panel in #${ch.name} erstellt`);
    res.json({ ok: true });
  }));

  // Moderation
  api.post('/moderation', wrap(async (req, res) => {
    const action = String(req.body.action);
    const need = { warn: P.ModerateMembers, timeout: P.ModerateMembers, kick: P.KickMembers, ban: P.BanMembers }[action];
    if (!need) return res.status(400).json({ error: 'Unbekannte Aktion.' });
    if (!req.member.permissions.has(need)) return res.status(403).json({ error: 'Dafür fehlt dir die Berechtigung.' });
    const r = await ctx.modAction(req.guild, req.member, String(req.body.userId), action, { reason: text(req.body.reason, 300), minutes: req.body.minutes });
    res.json({ ok: true, ...r });
  }));
  api.get('/warnings', wrap(async (req, res) => {
    const g = req.guild, warns = cfg(g.id).warns ?? {};
    const top = Object.entries(warns).filter(([, l]) => l.length).sort((a, b) => b[1].length - a[1].length).slice(0, 30);
    const missing = top.map(([id]) => id).filter((id) => !g.members.cache.has(id));
    if (missing.length) await g.members.fetch({ user: missing.slice(0, 100) }).catch(() => {});
    res.json({
      counts: Object.fromEntries(Object.entries(warns).map(([id, l]) => [id, l.length])),
      top: top.map(([id, l]) => ({ id, name: g.members.cache.get(id)?.displayName || `Unbekannt (${id})`, count: l.length })),
    });
  }));
  api.get('/warnings/:id', (req, res) => {
    const g = req.guild;
    res.json((cfg(g.id).warns?.[req.params.id] ?? []).map((w) => ({ at: w.at, reason: w.reason, by: g.members.cache.get(w.by)?.displayName || w.by })));
  });
  api.delete('/warnings/:id', wrap(async (req, res) => {
    if (!req.member.permissions.has(P.ModerateMembers)) return res.status(403).json({ error: 'Dafür fehlt dir die Berechtigung.' });
    const c = cfg(req.guild.id);
    if (c.warns) delete c.warns[req.params.id];
    save();
    audit(req, `🧹 hat die Verwarnungen von <@${req.params.id}> gelöscht`);
    res.json({ ok: true });
  }));

  // Ticket-Fragen
  api.get('/ticketquestions', (req, res) => res.json(ctx.ticketConfig(cfg(req.guild.id))));

  api.put('/ticketquestions/:cat', wrap(async (req, res) => {
    const c = cfg(req.guild.id);
    if (!ctx.ticketConfig(c)[req.params.cat]) return res.status(404).json({ error: 'Kategorie nicht gefunden.' });
    const qs = (Array.isArray(req.body.qs) ? req.body.qs : []).slice(0, 8)
      .map((q) => ({ label: text(q?.label, 45), q: text(q?.q, 400), optional: !!q?.optional }))
      .filter((q) => q.label && q.q);
    if (!qs.length) return res.status(400).json({ error: 'Mindestens eine Frage mit Titel und Text wird gebraucht.' });
    (c.ticketQuestions ??= {})[req.params.cat] = qs;
    save();
    audit(req, `📝 hat die Ticket-Fragen „${ctx.ticketConfig(c)[req.params.cat].label}“ geändert`);
    res.json({ ok: true });
  }));

  api.delete('/ticketquestions/:cat', wrap(async (req, res) => {
    const c = cfg(req.guild.id);
    if (c.ticketQuestions) delete c.ticketQuestions[req.params.cat];
    save();
    res.json({ ok: true });
  }));

  // Rollen und Mitglieder
  const editableRole = (req, role) => {
    const g = req.guild;
    if (!role || role.id === g.id || role.managed) return false;
    const me = g.members.me;
    if (!me || role.position >= me.roles.highest.position) return false;
    if (role.permissions.has(P.Administrator) && !req.member.permissions.has(P.Administrator)) return false;
    return g.ownerId === req.member.id || role.position < req.member.roles.highest.position;
  };
  const hexColor = (v, fallback = null) => /^#?[0-9a-f]{6}$/i.test(String(v ?? '').trim()) ? '#' + String(v).trim().replace('#', '').toLowerCase() : fallback;
  const roleDto = (req, r, core) => ({
    id: r.id, name: r.name, color: r.hexColor, hoist: r.hoist, mentionable: r.mentionable, members: r.members.size,
    managed: r.managed, editable: editableRole(req, r), admin: r.permissions.has(P.Administrator), core: core.has(r.id),
  });

  api.get('/roles', wrap(async (req, res) => {
    const g = req.guild;
    await g.roles.fetch();
    const core = new Set(Object.values(cfg(g.id).roles ?? {}));
    res.json([...g.roles.cache.values()].filter((r) => r.id !== g.id).sort((a, b) => b.position - a.position).map((r) => roleDto(req, r, core)));
  }));

  api.post('/roles', wrap(async (req, res) => {
    const name = text(req.body.name, 100);
    if (!name) return res.status(400).json({ error: 'Bitte gib einen Namen ein.' });
    await req.guild.roles.create({
      name, color: hexColor(req.body.color, '#99aab5'), hoist: !!req.body.hoist, mentionable: !!req.body.mentionable,
      permissions: [], reason: `Dashboard: ${req.sess.n}`,
    });
    audit(req, `hat die Rolle „${name}“ erstellt`);
    res.json({ ok: true });
  }));

  api.put('/roles/:id', wrap(async (req, res) => {
    const role = req.guild.roles.cache.get(req.params.id);
    if (!editableRole(req, role)) return res.status(403).json({ error: 'Diese Rolle darfst du nicht bearbeiten.' });
    const name = text(req.body.name, 100);
    if (!name) return res.status(400).json({ error: 'Der Name darf nicht leer sein.' });
    await role.edit({
      name, color: hexColor(req.body.color, role.hexColor), hoist: !!req.body.hoist, mentionable: !!req.body.mentionable,
      reason: `Dashboard: ${req.sess.n}`,
    });
    res.json({ ok: true });
  }));

  api.delete('/roles/:id', wrap(async (req, res) => {
    const role = req.guild.roles.cache.get(req.params.id);
    if (!editableRole(req, role)) return res.status(403).json({ error: 'Diese Rolle darfst du nicht löschen.' });
    if (Object.values(cfg(req.guild.id).roles ?? {}).includes(role.id)) {
      return res.status(400).json({ error: 'Diese Rolle nutzt der Bot (Setup). Lösche sie nicht, sonst funktionieren Teile des Bots nicht mehr.' });
    }
    audit(req, `hat die Rolle „${role.name}“ gelöscht`);
    await role.delete(`Dashboard: ${req.sess.n}`);
    res.json({ ok: true });
  }));

  api.get('/members', wrap(async (req, res) => {
    const g = req.guild;
    const q = text(req.query.q, 40).toLowerCase();
    if (q.length < 2) return res.json([]);
    const match = (m) => m.displayName.toLowerCase().includes(q) || m.user.username.toLowerCase().includes(q);
    let list = [...g.members.cache.values()].filter(match);
    if (list.length < 5) {
      const found = await g.members.fetch({ query: q, limit: 25 }).catch(() => null);
      if (found) list = [...new Map([...list, ...found.values()].map((m) => [m.id, m])).values()];
    }
    res.json(list.slice(0, 25).map((m) => ({
      id: m.id, name: m.displayName, user: m.user.username, bot: m.user.bot,
      avatar: m.displayAvatarURL({ size: 64, extension: 'png' }),
      roles: [...m.roles.cache.values()].filter((r) => r.id !== g.id).sort((a, b) => b.position - a.position)
        .map((r) => ({ id: r.id, name: r.name, color: r.hexColor })),
    })));
  }));

  const memberRole = (add) => wrap(async (req, res) => {
    const g = req.guild;
    const role = g.roles.cache.get(req.params.rid);
    if (!editableRole(req, role)) return res.status(403).json({ error: 'Diese Rolle darfst du nicht vergeben.' });
    const m = await g.members.fetch(req.params.uid).catch(() => null);
    if (!m) return res.status(404).json({ error: 'Mitglied nicht gefunden.' });
    if (add) await m.roles.add(role, `Dashboard: ${req.sess.n}`); else await m.roles.remove(role, `Dashboard: ${req.sess.n}`);
    res.json({ ok: true });
  });
  api.post('/members/:uid/roles/:rid', memberRole(true));
  api.delete('/members/:uid/roles/:rid', memberRole(false));

  // XP und Level
  const clampInt = (v, min, max) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : null; };

  api.get('/xp', wrap(async (req, res) => {
    const g = req.guild, x = ctx.getXp(cfg(g.id));
    const ranking = Object.entries(x.users).sort((a, b) => b[1].xp - a[1].xp);
    const top = ranking.slice(0, 50);
    const missing = top.map(([id]) => id).filter((id) => !g.members.cache.has(id));
    if (missing.length) await g.members.fetch({ user: missing.slice(0, 100) }).catch(() => {});
    res.json({
      settings: x.settings, publicLeaderboard: !!cfg(g.id).publicLeaderboard, publicUrl: `${base}/leaderboard`,
      rewards: [...x.rewards].sort((a, b) => a.level - b.level)
        .map((r) => ({ level: r.level, roleId: r.roleId, roleName: g.roles.cache.get(r.roleId)?.name || '(gelöscht)' })),
      total: ranking.length,
      leaderboard: top.map(([id, u], i) => {
        const info = ctx.xpInfo(u.xp);
        return { rank: i + 1, id, name: g.members.cache.get(id)?.displayName || `Unbekannt (${id})`, xp: u.xp, msgs: u.msgs || 0, ...info };
      }),
    });
  }));

  api.put('/xp/settings', wrap(async (req, res) => {
    const x = ctx.getXp(cfg(req.guild.id)), b = req.body, s = x.settings;
    if (typeof b.enabled === 'boolean') s.enabled = b.enabled;
    if (typeof b.announce === 'boolean') s.announce = b.announce;
    const min = clampInt(b.min, 1, 500), max = clampInt(b.max, 1, 500);
    const cooldown = clampInt(b.cooldown, 5, 3600), voice = clampInt(b.voice, 0, 500);
    if (min !== null) s.min = min;
    if (max !== null) s.max = max;
    if (s.max < s.min) s.max = s.min;
    if (cooldown !== null) s.cooldown = cooldown;
    if (voice !== null) s.voice = voice;
    save();
    res.json({ ok: true, settings: s });
  }));

  api.post('/xp/rewards', wrap(async (req, res) => {
    const level = clampInt(req.body.level, 1, 500);
    const role = req.guild.roles.cache.get(String(req.body.roleId));
    if (!level) return res.status(400).json({ error: 'Bitte gib ein Level von 1 bis 500 an.' });
    if (!editableRole(req, role)) return res.status(400).json({ error: 'Diese Rolle kann der Bot nicht vergeben.' });
    const x = ctx.getXp(cfg(req.guild.id));
    x.rewards = x.rewards.filter((r) => r.level !== level);
    x.rewards.push({ level, roleId: role.id });
    save();
    res.json({ ok: true });
  }));

  api.delete('/xp/rewards/:level', wrap(async (req, res) => {
    const x = ctx.getXp(cfg(req.guild.id));
    x.rewards = x.rewards.filter((r) => r.level !== Number(req.params.level));
    save();
    res.json({ ok: true });
  }));

  api.post('/xp/users/:id', wrap(async (req, res) => {
    const xp = clampInt(req.body.xp, 0, 10000000);
    if (xp === null) return res.status(400).json({ error: 'Bitte gib eine Zahl ein.' });
    const x = ctx.getXp(cfg(req.guild.id));
    (x.users[req.params.id] ??= { xp: 0 }).xp = xp;
    await ctx.applyRewards(req.guild, req.params.id);
    save();
    res.json({ ok: true });
  }));

  api.delete('/xp/users/:id', wrap(async (req, res) => {
    delete ctx.getXp(cfg(req.guild.id)).users[req.params.id];
    save();
    res.json({ ok: true });
  }));

  // Twitch
  const LOGIN = /^[a-z0-9_]{3,25}$/;
  api.get('/twitch', (req, res) => {
    const t = cfg(req.guild.id).twitch ?? {};
    res.json({
      configured: !!(env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET),
      channels: t.channels ?? [], live: Object.keys(t.live ?? {}),
      hasChannel: !!cfg(req.guild.id).channels.twitch,
    });
  });
  api.post('/twitch', wrap(async (req, res) => {
    const name = text(req.body.name, 100).toLowerCase().replace(/^https?:\/\/(www\.)?twitch\.tv\//, '').replace(/[/?#].*$/, '');
    if (!LOGIN.test(name)) return res.status(400).json({ error: 'Ungültiger Twitch-Name.' });
    const t = (cfg(req.guild.id).twitch ??= { channels: [], live: {}, last: {} });
    if (!t.channels.includes(name)) t.channels.push(name);
    save();
    res.json({ ok: true });
  }));
  api.delete('/twitch/:name', wrap(async (req, res) => {
    const t = cfg(req.guild.id).twitch;
    if (!t) return res.status(404).json({ error: 'Nicht gefunden.' });
    t.channels = t.channels.filter((n) => n !== req.params.name); delete t.live?.[req.params.name]; save();
    res.json({ ok: true });
  }));

  // Giveaways
  api.get('/giveaways', wrap(async (req, res) => {
    const g = req.guild;
    const name = (id) => g.members.cache.get(id)?.displayName || id;
    const list = Object.entries(cfg(g.id).giveaways ?? {}).map(([id, gw]) => ({
      id, channel: g.channels.cache.get(gw.channelId)?.name || '?', prize: gw.prize, endsAt: gw.endsAt, winners: gw.winners,
      entries: gw.entries.length, ended: gw.ended, winnerNames: (gw.winnerIds ?? []).map(name),
    })).sort((a, b) => b.endsAt - a.endsAt);
    res.json(list);
  }));

  api.post('/giveaways', wrap(async (req, res) => {
    const ms = ctx.parseDuration(req.body.duration);
    if (!ms) return res.status(400).json({ error: 'Ungültige Dauer. Beispiele: 30m, 2h, 1d, 1d12h (1 Minute bis 30 Tage).' });
    const prize = text(req.body.prize, 200);
    if (!prize) return res.status(400).json({ error: 'Bitte gib einen Preis ein.' });
    const ch = req.guild.channels.cache.get(String(req.body.channelId));
    if (!ch || ch.type !== ChannelType.GuildText) return res.status(400).json({ error: 'Bitte wähle einen Textkanal.' });
    const winners = Math.min(Math.max(parseInt(req.body.winners, 10) || 1, 1), 20);
    await ctx.startGiveaway(req.guild, ch, { prize, ms, winners, hostId: req.sess.u });
    audit(req, `hat ein Giveaway gestartet: ${prize}`);
    res.json({ ok: true });
  }));

  api.post('/giveaways/:id/end', wrap(async (req, res) => res.json({ winners: await ctx.endGiveaway(req.guild, req.params.id, false) })));
  api.post('/giveaways/:id/reroll', wrap(async (req, res) => res.json({ winners: await ctx.endGiveaway(req.guild, req.params.id, true) })));

  api.delete('/giveaways/:id', wrap(async (req, res) => {
    const c = cfg(req.guild.id);
    const gw = c.giveaways?.[req.params.id];
    if (!gw) return res.status(404).json({ error: 'Giveaway nicht gefunden.' });
    const ch = req.guild.channels.cache.get(gw.channelId);
    const msg = ch && await ch.messages.fetch(req.params.id).catch(() => null);
    if (msg) await msg.delete().catch(() => {});
    delete c.giveaways[req.params.id]; save();
    res.json({ ok: true });
  }));

  app.use('/api', api);
  app.use((err, req, res, next) => res.status(400).json({ error: 'Ungültige Anfrage' }));

  const port = Number(env.PORT) || 3000;
  app.listen(port, '0.0.0.0', () => console.log(`Dashboard läuft auf Port ${port} (${base})`));
};
