require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder,
  PermissionFlagsBits: P, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ActivityType, MessageFlags,
} = require('discord.js');
const mc = require('minecraft-server-util');

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID, MC_HOST = 'play.xurosmp.net', MC_PORT = '25565' } = process.env;
const COLOR = 0x57f287;
const EPH = MessageFlags.Ephemeral;

const RULES = [
  '1. Kein Griefing oder Stehlen.',
  '2. Kein Hacking / keine unfairen Clients oder Exploits.',
  '3. Respektvoller Umgang miteinander.',
  '4. Kein Spam oder Werbung.',
  '5. Den Anweisungen des Teams folgen.',
].join('\n');

// ───────────── Speicher (JSON) ─────────────
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const FILE = path.join(DATA_DIR, 'config.json');
let db = {};
try { db = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
const cfg = (g) => (db[g] ||= { temp: {}, roles: {}, channels: {} });
const save = () => fs.writeFileSync(FILE, JSON.stringify(db, null, 2));

// ───────────── Befehle ─────────────
const user = (o, req = true) => o.setName('user').setDescription('Mitglied').setRequired(req);
const reason = (o) => o.setName('grund').setDescription('Grund').setRequired(false);

const commands = [
  new SlashCommandBuilder().setName('status').setDescription('Status des Minecraft-Servers'),
  new SlashCommandBuilder().setName('ip').setDescription('Server-IP anzeigen'),
  new SlashCommandBuilder().setName('regeln').setDescription('Serverregeln anzeigen'),
  new SlashCommandBuilder().setName('ping').setDescription('Bot-Latenz'),
  new SlashCommandBuilder().setName('setup').setDescription('Richtet den Discord-Server automatisch ein')
    .setDefaultMemberPermissions(P.Administrator),
  new SlashCommandBuilder().setName('voice').setDescription('Verwalte deinen Join-to-Create-Kanal')
    .addSubcommand((s) => s.setName('name').setDescription('Kanal umbenennen')
      .addStringOption((o) => o.setName('name').setDescription('Neuer Name').setRequired(true).setMaxLength(50)))
    .addSubcommand((s) => s.setName('limit').setDescription('Nutzerlimit setzen (0 = unbegrenzt)')
      .addIntegerOption((o) => o.setName('anzahl').setDescription('0-99').setRequired(true).setMinValue(0).setMaxValue(99)))
    .addSubcommand((s) => s.setName('lock').setDescription('Kanal sperren'))
    .addSubcommand((s) => s.setName('unlock').setDescription('Kanal entsperren')),
  new SlashCommandBuilder().setName('clear').setDescription('Nachrichten löschen')
    .addIntegerOption((o) => o.setName('anzahl').setDescription('1-100').setRequired(true).setMinValue(1).setMaxValue(100))
    .setDefaultMemberPermissions(P.ManageMessages),
  new SlashCommandBuilder().setName('kick').setDescription('Mitglied kicken')
    .addUserOption((o) => user(o)).addStringOption(reason).setDefaultMemberPermissions(P.KickMembers),
  new SlashCommandBuilder().setName('ban').setDescription('Mitglied bannen')
    .addUserOption((o) => user(o)).addStringOption(reason).setDefaultMemberPermissions(P.BanMembers),
  new SlashCommandBuilder().setName('timeout').setDescription('Mitglied stummschalten (Timeout)')
    .addUserOption((o) => user(o))
    .addIntegerOption((o) => o.setName('minuten').setDescription('Dauer in Minuten').setRequired(true).setMinValue(1).setMaxValue(40320))
    .addStringOption(reason).setDefaultMemberPermissions(P.ModerateMembers),
  new SlashCommandBuilder().setName('umfrage').setDescription('Erstellt eine Ja/Nein-Umfrage')
    .addStringOption((o) => o.setName('frage').setDescription('Frage').setRequired(true).setMaxLength(250)),
  new SlashCommandBuilder().setName('ankuendigung').setDescription('Sendet eine Ankündigung')
    .addStringOption((o) => o.setName('text').setDescription('Text').setRequired(true).setMaxLength(1800))
    .setDefaultMemberPermissions(P.ManageGuild),
].map((c) => c.toJSON());

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildVoiceStates],
});

const reply = (i, content) => i.reply({ content, flags: EPH });

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  const route = GUILD_ID ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID) : Routes.applicationCommands(CLIENT_ID);
  await rest.put(route, { body: commands });
  console.log('Slash-Befehle registriert.');
}

// ───────────── Minecraft-Status ─────────────
async function getStatus() {
  try { return { online: true, res: await mc.status(MC_HOST, Number(MC_PORT), { timeout: 5000 }) }; }
  catch { return { online: false }; }
}

async function updatePresence() {
  const { online, res } = await getStatus();
  client.user.setPresence({
    status: online ? 'online' : 'dnd',
    activities: [{
      name: online ? `${res.players.online}/${res.players.max} Spieler auf xurosmp` : 'xurosmp ist offline',
      type: ActivityType.Watching,
    }],
  });
}

async function updateStats() {
  const { online, res } = await getStatus();
  const name = online ? `📊・Spieler: ${res.players.online}/${res.players.max}` : '📊・Server offline';
  for (const guild of client.guilds.cache.values()) {
    const id = cfg(guild.id).channels.stats;
    const ch = id && guild.channels.cache.get(id);
    if (ch && ch.name !== name) ch.setName(name).catch(() => {});
  }
}

async function log(guild, text) {
  const id = cfg(guild.id).channels.logs;
  const ch = id && guild.channels.cache.get(id);
  if (ch) ch.send({ embeds: [new EmbedBuilder().setColor(0x5865f2).setDescription(text).setTimestamp()] }).catch(() => {});
}

// ───────────── /setup ─────────────
async function runSetup(guild) {
  const c = cfg(guild.id);
  await guild.roles.fetch();
  const everyone = guild.roles.everyone;
  const role = async (name, color, permissions = [], hoist = false) =>
    guild.roles.cache.find((r) => r.name === name) ??
    guild.roles.create({ name, color, permissions, hoist, reason: 'xurosmp Setup' });

  const admin = await role('Admin', 0xed4245, [P.Administrator], true);
  const mod = await role('Moderator', 0xe67e22,
    [P.KickMembers, P.BanMembers, P.ModerateMembers, P.ManageMessages, P.MoveMembers], true);
  const player = await role('Spieler', COLOR, [], true);

  const V = P.ViewChannel, S = P.SendMessages, H = P.ReadMessageHistory;
  const staff = { id: mod.id, allow: [V, S, H] };
  const pub = [{ id: everyone.id, allow: [V, H], deny: [S] }, staff];
  const priv = [{ id: everyone.id, deny: [V] }, { id: player.id, allow: [V, S, H] }, staff];
  const privRO = [{ id: everyone.id, deny: [V] }, { id: player.id, allow: [V, H], deny: [S] }, staff];
  const voicePriv = [{ id: everyone.id, deny: [V] }, { id: player.id, allow: [V, P.Connect, P.Speak] }, staff];
  const team = [{ id: everyone.id, deny: [V] }, staff, { id: admin.id, allow: [V, S, H] }];

  const cat = (name, ow) => guild.channels.create({ name, type: ChannelType.GuildCategory, permissionOverwrites: ow });
  const text = (name, parent, ow) =>
    guild.channels.create({ name, type: ChannelType.GuildText, parent: parent.id, permissionOverwrites: ow });
  const voice = (name, parent, ow) =>
    guild.channels.create({ name, type: ChannelType.GuildVoice, parent: parent.id, permissionOverwrites: ow });

  // INFO
  const info = await cat('📌・INFO', pub);
  const rules = await text('📜・regeln', info, pub);
  const news = await text('📢・ankündigungen', info, pub);
  const ipCh = await text('🌍・server-ip', info, pub);
  const verify = await text('✅・verifizierung', info, pub);
  const welcome = await text('👋・willkommen', info, pub);
  const stats = await voice('📊・Spieler: …', info, [{ id: everyone.id, allow: [V], deny: [P.Connect] }]);
  // COMMUNITY
  const comm = await cat('💬・COMMUNITY', priv);
  await text('💬・chat', comm, priv);
  await text('📷・screenshots', comm, priv);
  await text('🤖・bot-befehle', comm, priv);
  // SUPPORT
  const sup = await cat('🎫・SUPPORT', privRO);
  const ticketCh = await text('🎫・ticket-erstellen', sup, privRO);
  // VOICE
  const vc = await cat('🔊・VOICE', voicePriv);
  const j2c = await voice('➕・Join to Create', vc, voicePriv);
  await voice('🔊・Lobby', vc, voicePriv);
  await voice('🎵・Musik', vc, voicePriv);
  // TEAM
  const teamCat = await cat('🛠・TEAM', team);
  await text('🛠・team-chat', teamCat, team);
  const logs = await text('📋・logs', teamCat, team);

  // Nachrichten / Panels
  await rules.send({ embeds: [new EmbedBuilder().setColor(COLOR).setTitle('📜 xurosmp Regeln').setDescription(RULES)] });
  await ipCh.send({ embeds: [new EmbedBuilder().setColor(COLOR).setTitle('🌍 Server-IP')
    .setDescription(`\`${MC_HOST}${MC_PORT === '25565' ? '' : ':' + MC_PORT}\``)] });
  await verify.send({
    embeds: [new EmbedBuilder().setColor(COLOR).setTitle('✅ Verifizierung')
      .setDescription('Klicke auf den Button, um den Server freizuschalten.')],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('verify').setLabel('Verifizieren').setStyle(ButtonStyle.Success))],
  });
  await ticketCh.send({
    embeds: [new EmbedBuilder().setColor(COLOR).setTitle('🎫 Support')
      .setDescription('Brauchst du Hilfe? Klicke auf den Button, um ein Ticket zu öffnen.')],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ticket_open').setLabel('Ticket öffnen').setStyle(ButtonStyle.Primary))],
  });

  c.roles = { player: player.id, mod: mod.id, admin: admin.id };
  c.channels = {
    welcome: welcome.id, logs: logs.id, news: news.id, stats: stats.id, j2c: j2c.id, support: sup.id,
  };
  save();
  updateStats();
}

// ───────────── Interaktionen ─────────────
client.on('interactionCreate', async (i) => {
  try {
    if (!i.guild) return;
    const c = cfg(i.guild.id);

    // Buttons
    if (i.isButton()) {
      if (i.customId === 'verify') {
        if (!c.roles.player) return reply(i, 'Server ist nicht eingerichtet.');
        await i.member.roles.add(c.roles.player);
        return reply(i, '✅ Du wurdest verifiziert. Viel Spaß auf xurosmp!');
      }
      if (i.customId === 'ticket_open') {
        const existing = i.guild.channels.cache.find((ch) => ch.topic === `ticket:${i.user.id}`);
        if (existing) return reply(i, `Du hast bereits ein Ticket: ${existing}`);
        const ch = await i.guild.channels.create({
          name: `ticket-${i.user.username}`, type: ChannelType.GuildText, parent: c.channels.support,
          topic: `ticket:${i.user.id}`,
          permissionOverwrites: [
            { id: i.guild.id, deny: [P.ViewChannel] },
            { id: i.user.id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory] },
            { id: c.roles.mod, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory] },
          ],
        });
        await ch.send({
          content: `${i.user} <@&${c.roles.mod}>`,
          embeds: [new EmbedBuilder().setColor(COLOR).setDescription('Beschreibe dein Anliegen. Das Team meldet sich bald.')],
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('ticket_close').setLabel('Schließen').setStyle(ButtonStyle.Danger))],
        });
        log(i.guild, `🎫 Ticket ${ch} von ${i.user} geöffnet.`);
        return reply(i, `Dein Ticket: ${ch}`);
      }
      if (i.customId === 'ticket_close') {
        const allowed = i.member.roles.cache.has(c.roles.mod) || i.channel.topic === `ticket:${i.user.id}`
          || i.member.permissions.has(P.Administrator);
        if (!allowed) return reply(i, 'Dafür fehlt dir die Berechtigung.');
        await i.reply('Ticket wird in 5 Sekunden gelöscht …');
        log(i.guild, `🔒 Ticket #${i.channel.name} von ${i.user} geschlossen.`);
        return setTimeout(() => i.channel.delete().catch(() => {}), 5000);
      }
      return;
    }

    if (!i.isChatInputCommand()) return;
    const cmd = i.commandName;

    if (cmd === 'ping') return reply(i, `🏓 ${client.ws.ping} ms`);

    if (cmd === 'ip') {
      return i.reply({ embeds: [new EmbedBuilder().setColor(COLOR).setTitle('xurosmp IP')
        .setDescription(`\`${MC_HOST}${MC_PORT === '25565' ? '' : ':' + MC_PORT}\``)] });
    }
    if (cmd === 'regeln') {
      return i.reply({ embeds: [new EmbedBuilder().setColor(COLOR).setTitle('📜 xurosmp Regeln').setDescription(RULES)] });
    }
    if (cmd === 'status') {
      await i.deferReply();
      const { online, res } = await getStatus();
      const e = new EmbedBuilder().setTimestamp().setTitle('xurosmp Status');
      if (online) {
        e.setColor(COLOR).addFields(
          { name: 'Status', value: '🟢 Online', inline: true },
          { name: 'Spieler', value: `${res.players.online}/${res.players.max}`, inline: true },
          { name: 'Version', value: res.version.name, inline: true });
      } else e.setColor(0xed4245).addFields({ name: 'Status', value: '🔴 Offline' });
      return i.editReply({ embeds: [e] });
    }

    if (cmd === 'setup') {
      if (c.channels.j2c && i.guild.channels.cache.has(c.channels.j2c)) {
        return reply(i, 'Der Server ist bereits eingerichtet. Lösche zuerst die alten Kanäle, wenn du neu starten willst.');
      }
      await i.deferReply({ flags: EPH });
      await runSetup(i.guild);
      return i.editReply('✅ Setup fertig! Rollen, Kanäle, Verifizierung, Tickets und Join-to-Create sind eingerichtet.');
    }

    if (cmd === 'voice') {
      const vch = i.member.voice.channel;
      if (!vch || c.temp[vch.id] !== i.user.id) return reply(i, 'Du musst in deinem eigenen Join-to-Create-Kanal sein.');
      const sub = i.options.getSubcommand();
      if (sub === 'name') { await vch.setName(`🔊・${i.options.getString('name')}`); return reply(i, 'Umbenannt.'); }
      if (sub === 'limit') { await vch.setUserLimit(i.options.getInteger('anzahl')); return reply(i, 'Limit gesetzt.'); }
      if (sub === 'lock') { await vch.permissionOverwrites.edit(c.roles.player, { Connect: false }); return reply(i, '🔒 Gesperrt.'); }
      if (sub === 'unlock') { await vch.permissionOverwrites.edit(c.roles.player, { Connect: true }); return reply(i, '🔓 Entsperrt.'); }
    }

    if (cmd === 'clear') {
      const n = await i.channel.bulkDelete(i.options.getInteger('anzahl'), true);
      log(i.guild, `🧹 ${i.user} hat ${n.size} Nachrichten in ${i.channel} gelöscht.`);
      return reply(i, `🧹 ${n.size} Nachrichten gelöscht.`);
    }

    if (['kick', 'ban', 'timeout'].includes(cmd)) {
      const target = i.options.getMember('user');
      const why = i.options.getString('grund') || 'Kein Grund angegeben';
      if (!target) return reply(i, 'Mitglied nicht gefunden.');
      const higher = target.roles.highest.position >= i.member.roles.highest.position && i.guild.ownerId !== i.user.id;
      if (target.id === i.user.id || higher) return reply(i, 'Das darfst du bei diesem Mitglied nicht.');
      if (cmd === 'kick') {
        if (!target.kickable) return reply(i, 'Das kann ich nicht (Rollen-Hierarchie).');
        await target.kick(why);
      } else if (cmd === 'ban') {
        if (!target.bannable) return reply(i, 'Das kann ich nicht (Rollen-Hierarchie).');
        await target.ban({ reason: why });
      } else {
        if (!target.moderatable) return reply(i, 'Das kann ich nicht (Rollen-Hierarchie).');
        await target.timeout(i.options.getInteger('minuten') * 60_000, why);
      }
      log(i.guild, `🔨 **${cmd}**: ${target.user.tag} durch ${i.user}\nGrund: ${why}`);
      return reply(i, `✅ ${cmd} bei ${target.user.tag} ausgeführt.`);
    }

    if (cmd === 'umfrage') {
      await i.reply({ embeds: [new EmbedBuilder().setColor(COLOR).setTitle('📊 Umfrage')
        .setDescription(i.options.getString('frage')).setFooter({ text: `von ${i.user.username}` })] });
      const m = await i.fetchReply();
      await m.react('👍'); await m.react('👎');
      return;
    }

    if (cmd === 'ankuendigung') {
      const ch = i.guild.channels.cache.get(c.channels.news);
      if (!ch) return reply(i, 'Kein Ankündigungs-Kanal. Bitte zuerst /setup ausführen.');
      await ch.send({ embeds: [new EmbedBuilder().setColor(COLOR).setTitle('📢 Ankündigung')
        .setDescription(i.options.getString('text')).setTimestamp()] });
      return reply(i, 'Gesendet.');
    }
  } catch (err) {
    console.error(err);
    const msg = 'Es ist ein Fehler aufgetreten. Prüfe die Bot-Rechte.';
    if (i.deferred || i.replied) i.editReply(msg).catch(() => {}); else reply(i, msg).catch(() => {});
  }
});

// ───────────── Join to Create ─────────────
client.on('voiceStateUpdate', async (oldS, newS) => {
  const guild = newS.guild;
  const c = cfg(guild.id);
  try {
    if (newS.channelId && newS.channelId === c.channels.j2c) {
      const member = newS.member;
      const ch = await guild.channels.create({
        name: `🔊・${member.displayName}`, type: ChannelType.GuildVoice, parent: newS.channel.parentId,
      });
      await ch.permissionOverwrites.edit(member.id, { ManageChannels: true, Connect: true, MoveMembers: true });
      c.temp[ch.id] = member.id; save();
      await member.voice.setChannel(ch);
    }
    if (oldS.channelId && c.temp[oldS.channelId] && oldS.channel && oldS.channel.members.size === 0) {
      await oldS.channel.delete().catch(() => {});
      delete c.temp[oldS.channelId]; save();
    }
  } catch (err) { console.error(err); }
});

// ───────────── Willkommen / Log ─────────────
client.on('guildMemberAdd', async (member) => {
  const c = cfg(member.guild.id);
  const ch = c.channels.welcome && member.guild.channels.cache.get(c.channels.welcome);
  if (ch) {
    ch.send({ embeds: [new EmbedBuilder().setColor(COLOR).setTitle('Willkommen bei xurosmp! 🎉')
      .setDescription(`Hey ${member}, schön dass du da bist!\nVerifiziere dich im Verifizierungs-Kanal.\nIP: \`${MC_HOST}\``)] });
  }
  log(member.guild, `📥 ${member.user.tag} ist beigetreten.`);
});
client.on('guildMemberRemove', (member) => log(member.guild, `📤 ${member.user.tag} hat den Server verlassen.`));

// ───────────── Start ─────────────
client.once('clientReady', async () => {
  console.log(`Eingeloggt als ${client.user.tag}`);
  for (const guild of client.guilds.cache.values()) {   // verwaiste Temp-Kanäle aufräumen
    const c = cfg(guild.id);
    for (const id of Object.keys(c.temp)) {
      const ch = guild.channels.cache.get(id);
      if (!ch) delete c.temp[id];
      else if (ch.members.size === 0) { ch.delete().catch(() => {}); delete c.temp[id]; }
    }
  }
  save();
  await updatePresence(); updateStats();
  setInterval(updatePresence, 60_000);
  setInterval(updateStats, 10 * 60_000);
});

(async () => { await registerCommands(); await client.login(DISCORD_TOKEN); })();
