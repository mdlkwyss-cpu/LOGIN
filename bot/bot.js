const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  MessageFlags
} = require('discord.js');

const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');

try {
  require('dotenv').config({
    path: path.resolve(__dirname, '../.env.local')
  });
  require('dotenv').config({
    path: path.resolve(__dirname, '../.env')
  });
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const DATABASE_URL = process.env.DATABASE_URL;
const PREFIX = process.env.KEY_PREFIX || 'IRONE';

if (!TOKEN || !CLIENT_ID || !GUILD_ID || !DATABASE_URL) {
  console.error(
    'Missing required environment variables: DISCORD_TOKEN, DISCORD_CLIENT_ID, GUILD_ID, DATABASE_URL'
  );
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const dbReady = pool.query(`
  CREATE TABLE IF NOT EXISTS issued_keys (
    discord_user_id TEXT PRIMARY KEY,
    discord_tag TEXT NOT NULL,
    key TEXT NOT NULL UNIQUE,
    used BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    used_at TIMESTAMPTZ
  )
`);

function makeKey() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';

  for (let i = 0; i < 8; i++) {
    out += alphabet[crypto.randomInt(alphabet.length)];
  }

  return `${PREFIX}-${out}`;
}

async function createKeyFor(user) {
  await dbReady;

  const existing = await pool.query(
    'SELECT key FROM issued_keys WHERE discord_user_id = $1',
    [user.id]
  );

  if (existing.rowCount > 0) {
    return { existing: true, key: existing.rows[0].key };
  }

  while (true) {
    const key = makeKey();

    try {
      const inserted = await pool.query(
        `INSERT INTO issued_keys (discord_user_id, discord_tag, key)
         VALUES ($1, $2, $3)
         ON CONFLICT (discord_user_id) DO NOTHING
         RETURNING key`,
        [user.id, user.tag || user.username, key]
      );

      if (inserted.rowCount > 0) {
        return { existing: false, key: inserted.rows[0].key };
      }

      const found = await pool.query(
        'SELECT key FROM issued_keys WHERE discord_user_id = $1',
        [user.id]
      );

      if (found.rowCount > 0) {
        return { existing: true, key: found.rows[0].key };
      }
    } catch (error) {
      if (error.code === '23505') continue;
      throw error;
    }
  }
}

const OWNER_ID = '1467636497959223367';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [require('discord.js').Partials.Channel]
});

const command = new SlashCommandBuilder()
  .setName('key')
  .setDescription('Get your one-time IRONE key');

const rest = new REST({ version: '10' }).setToken(TOKEN);

async function registerCommand() {
  const globalCommands = await rest.get(
    Routes.applicationCommands(CLIENT_ID)
  );

  for (const existing of globalCommands) {
    if (existing.name === 'key') {
      await rest.delete(
        Routes.applicationCommand(CLIENT_ID, existing.id)
      );
      console.log('Removed old global /key command.');
    }
  }

  const guildRoute = Routes.applicationGuildCommands(
    CLIENT_ID,
    GUILD_ID
  );

  const guildCommands = await rest.get(guildRoute);
  const existingKey = guildCommands.find(
    item => item.name === 'key'
  );

  if (existingKey) {
    await rest.patch(
      Routes.applicationGuildCommand(
        CLIENT_ID,
        GUILD_ID,
        existingKey.id
      ),
      { body: command.toJSON() }
    );
  } else {
    await rest.post(guildRoute, {
      body: command.toJSON()
    });
  }

  console.log('Registered /key in configured Discord server.');
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  try {
    await dbReady;
    console.log('Neon PostgreSQL connected.');
    await registerCommand();
  } catch (error) {
    console.error('Bot initialization failed:', error.message);
    process.exit(1);
  }
});

client.on('interactionCreate', async interaction => {
  if (
    !interaction.isChatInputCommand() ||
    interaction.commandName !== 'key'
  ) {
    return;
  }

  if (interaction.guildId !== GUILD_ID) return;

  try {
    await interaction.deferReply({
      flags: MessageFlags.Ephemeral
    });

    const guild = await client.guilds.fetch(GUILD_ID);
    await guild.members.fetch(interaction.user.id);

    const result = await createKeyFor(interaction.user);

    if (result.existing) {
      return interaction.editReply({
        content:
          '⚠️ لقد طلبت مفتاحًا من قبل. لا يمكنك الحصول على مفتاح آخر.\n\n' +
          'إذا فقدت مفتاحك، فلن يتم إنشاء مفتاح جديد للحساب نفسه.'
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
      await interaction.editReply({
        content: '❌ حدث خطأ مؤقت. حاول لاحقًا.'
      }).catch(() => {});
    } else {
      await interaction.reply({
        content: '❌ حدث خطأ مؤقت. حاول لاحقًا.',
        flags: MessageFlags.Ephemeral
      }).catch(() => {});
    }
  }
});


client.on('messageCreate', async message => {
  if (message.author.bot || message.guild) return;

  try {
    if (message.author.id === OWNER_ID) {
      await message.reply(
        '🇸🇦 أهلًا بك يا مسؤول IRONE! أنا جاهز لاستقبال رسائلك.\n' +
        '🇬🇧 Hello IRONE admin! I am ready to receive your messages.'
      );
      return;
    }

    await message.reply(
      '🇸🇦 عذرًا، لا يمكنني التحدث معك عبر الرسائل الخاصة. ' +
      'يرجى التواصل مع المسؤول هنا:\n' +
      'https://discord.gg/Jb3ZBSYNd\n\n' +
      '🇬🇧 Sorry, I cannot chat with you through private messages. ' +
      'Please contact the administrator here:\n' +
      'https://discord.gg/Jb3ZBSYNd'
    );
  } catch (error) {
    console.error('DM reply failed:', error.message);
  }
});

client.login(TOKEN).catch(error => {
  console.error('Discord login failed:', error.message);
  process.exit(1);
});
