const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, MessageFlags } = require('discord.js');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');

try {
  require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
} catch (error) {
  if (error && error.code !== 'MODULE_NOT_FOUND') throw error;
}

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const DB_FILE = process.env.DATABASE_FILE || path.resolve(__dirname, 'keys.db');
const PREFIX = process.env.KEY_PREFIX || 'IRONE';

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error('Missing required environment variable(s): DISCORD_TOKEN, DISCORD_CLIENT_ID, GUILD_ID');
  process.exit(1);
}

require('fs').mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS issued_keys (
  discord_user_id TEXT PRIMARY KEY,
  discord_tag TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,
  used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  used_at TEXT
);
`);

function makeKey() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 8; i++) out += alphabet[crypto.randomInt(alphabet.length)];
  return `${PREFIX}-${out}`;
}

const findUser = db.prepare('SELECT * FROM issued_keys WHERE discord_user_id = ?');
const insertKey = db.prepare(
  'INSERT INTO issued_keys (discord_user_id, discord_tag, key) VALUES (?, ?, ?)'
);

async function createKeyFor(user) {
  const existing = findUser.get(user.id);
  if (existing) return { existing: true, key: existing.key };

  while (true) {
    const key = makeKey();
    try {
      insertKey.run(user.id, user.tag || user.username, key);
      return { existing: false, key };
    } catch (error) {
      if (!String(error.message).includes('UNIQUE')) throw error;
    }
  }
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const command = new SlashCommandBuilder()
  .setName('key')
  .setDescription('Get your one-time IRONE key');
const rest = new REST({ version: '10' }).setToken(TOKEN);

async function registerCommand() {
  // Remove only an old GLOBAL /key if one exists; preserve every other command.
  const globalCommands = await rest.get(Routes.applicationCommands(CLIENT_ID));
  for (const existing of globalCommands) {
    if (existing.name === 'key') {
      await rest.delete(Routes.applicationCommand(CLIENT_ID, existing.id));
      console.log('Removed old global /key command.');
    }
  }

  // Create/update only /key in the configured server. Do not overwrite its other commands.
  const guildRoute = Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID);
  const guildCommands = await rest.get(guildRoute);
  const existingKey = guildCommands.find((item) => item.name === 'key');
  if (existingKey) {
    await rest.patch(Routes.applicationGuildCommand(CLIENT_ID, GUILD_ID, existingKey.id), {
      body: command.toJSON()
    });
  } else {
    await rest.post(guildRoute, { body: command.toJSON() });
  }
  console.log('Registered /key only in configured guild:', GUILD_ID);
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    await registerCommand();
  } catch (error) {
    console.error('Command registration failed:', error.message);
    process.exit(1);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'key') return;

  // Ignore invocations outside the configured Discord server.
  if (interaction.guildId !== GUILD_ID) return;

  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Replies are ephemeral, so only the requesting member can see them.
    const guild = await client.guilds.fetch(GUILD_ID);
    await guild.members.fetch(interaction.user.id);

    const result = await createKeyFor(interaction.user);
    if (result.existing) {
      return interaction.editReply({
        content: '⚠️ لقد طلبت مفتاحًا من قبل. لا يمكنك الحصول على مفتاح آخر.\n\nإذا فقدت مفتاحك، فلن يتم إنشاء مفتاح جديد للحساب نفسه.'
      });
    }

    return interaction.editReply({
      content:
        '✅ **تم الحصول على مفتاحك بنجاح!**\n\n' +
        '🔑 مفتاح IRONE الخاص بك:\n' +
        `\`${result.key}\`\n\n` +
        '⚠️ هذا المفتاح مرتبط بحساب Discord الخاص بك ويمكن استخدامه مرة واحدة فقط.'
    });
  } catch (error) {
    console.error('Failed to handle /key:', error.message);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: '❌ حدث خطأ مؤقت. حاول لاحقًا.' }).catch(() => {});
    } else {
      await interaction.reply({ content: '❌ حدث خطأ مؤقت. حاول لاحقًا.', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

client.login(TOKEN).catch((error) => {
  console.error('Discord login failed:', error.message);
  process.exit(1);
});
