import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { joinVoiceChannel, VoiceConnectionStatus, entersState } from '@discordjs/voice';
import { config } from './config.js';
import { logger } from './logger.js';
import { VoiceSession } from './session-manager.js';

const MOD = 'bridge';

// Active sessions: Map<guildId, VoiceSession>
const sessions = new Map();

// ─── Discord Client ────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ],
});

// ─── Slash Commands ────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('voicejoin')
    .setDescription('Join your current voice channel'),
  new SlashCommandBuilder()
    .setName('voiceleave')
    .setDescription('Leave the voice channel'),
  new SlashCommandBuilder()
    .setName('voicestatus')
    .setDescription('Show voice session status'),
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(config.discord.token);
  try {
    logger.info(MOD, 'Registering slash commands...');
    await rest.put(Routes.applicationCommands(client.user.id), {
      body: commands.map(c => c.toJSON()),
    });
    logger.info(MOD, 'Slash commands registered');
  } catch (err) {
    logger.error(MOD, 'Failed to register commands', err.message);
  }
}

// ─── Event Handlers ────────────────────────────────────────────────
client.once('ready', async () => {
  logger.info(MOD, `Logged in as ${client.user.tag} (${client.user.id})`);
  await registerCommands();
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, guildId, member } = interaction;

  switch (commandName) {
    case 'voicejoin':
      await handleJoin(interaction, guildId, member);
      break;
    case 'voiceleave':
      await handleLeave(interaction, guildId);
      break;
    case 'voicestatus':
      await handleStatus(interaction, guildId);
      break;
  }
});

async function handleJoin(interaction, guildId, member) {
  // Check if user is in a voice channel
  const voiceChannel = member?.voice?.channel;
  if (!voiceChannel) {
    await interaction.reply({ content: '❌ You need to be in a voice channel first.', ephemeral: true });
    return;
  }

  // Check concurrent limit
  if (sessions.size >= config.voice.maxConcurrent && !sessions.has(guildId)) {
    await interaction.reply({ content: '❌ Already in a voice session elsewhere. Use /voiceleave first.', ephemeral: true });
    return;
  }

  // If already in a session in this guild, leave first
  if (sessions.has(guildId)) {
    sessions.get(guildId).destroy('Rejoining a new channel');
    sessions.delete(guildId);
  }

  await interaction.deferReply();

  try {
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guildId,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false, // Must NOT be deaf to receive audio
      selfMute: false,
    });

    // Wait for connection to be ready
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);

    const session = new VoiceSession(voiceChannel.id, guildId, connection, client);
    sessions.set(guildId, session);

    // Handle disconnection
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        // Try to reconnect
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        // Can't reconnect — clean up
        logger.info(MOD, `Disconnected from voice in guild ${guildId}`);
        session.destroy('Disconnected');
        sessions.delete(guildId);
      }
    });

    connection.on(VoiceConnectionStatus.Destroyed, () => {
      sessions.delete(guildId);
    });

    await interaction.editReply(`🎙️ Joined **${voiceChannel.name}**! I'm listening.`);
    logger.info(MOD, `Joined voice channel: ${voiceChannel.name} (${voiceChannel.id}) in guild ${guildId}`);
  } catch (err) {
    logger.error(MOD, 'Failed to join voice channel', err.message);
    await interaction.editReply('❌ Failed to join voice channel. Try again.');
  }
}

async function handleLeave(interaction, guildId) {
  const session = sessions.get(guildId);
  if (!session) {
    await interaction.reply({ content: '❌ Not in a voice channel.', ephemeral: true });
    return;
  }

  session.destroy('Manual leave via /voiceleave');
  sessions.delete(guildId);
  await interaction.reply('👋 Left the voice channel.');
}

async function handleStatus(interaction, guildId) {
  const session = sessions.get(guildId);
  if (!session) {
    await interaction.reply({ content: 'Not currently in a voice session.', ephemeral: true });
    return;
  }

  const uptime = Math.round((Date.now() - session.createdAt) / 1000);
  const idle = Math.round((Date.now() - session.lastActivity) / 1000);
  const speakers = session.receivers.size;

  await interaction.reply({
    content: [
      `🎙️ **Voice Session Status**`,
      `• State: \`${session.state}\``,
      `• Channel: <#${session.channelId}>`,
      `• Uptime: ${uptime}s`,
      `• Last activity: ${idle}s ago`,
      `• Active speakers tracked: ${speakers}`,
      `• Queue depth: ${session.processingQueue.length}`,
    ].join('\n'),
    ephemeral: true,
  });
}

// ─── Graceful Shutdown ─────────────────────────────────────────────
function shutdown(signal) {
  logger.info(MOD, `Received ${signal}, shutting down...`);
  for (const [guildId, session] of sessions) {
    session.destroy('Bot shutting down');
    sessions.delete(guildId);
  }
  client.destroy();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ─── Start ─────────────────────────────────────────────────────────
if (!config.discord.token) {
  logger.error(MOD, 'DISCORD_TOKEN not set. Create .env from .env.example');
  process.exit(1);
}

logger.info(MOD, 'Starting Lodekeeper Voice Bridge...');
client.login(config.discord.token).catch((err) => {
  logger.error(MOD, 'Discord login failed', err.message);
  process.exit(1);
});
