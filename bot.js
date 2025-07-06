require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder, PermissionFlagsBits, ChannelType, Events, ActivityType } = require('discord.js');
const fs = require('fs').promises;
const path = require('path');
const AsyncLock = require('async-lock');
const winston = require('winston');

// Initialize logging
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json(),
    ),
    transports: [
        new winston.transports.File({ filename: './logs/error.log', level: 'error' }),
        new winston.transports.File({ filename: './logs/combined.log' }),
        new winston.transports.Console(),
    ],
});

// Bot Configuration
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildModeration,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildPresences,
    ],
});

// Global state management
const globalState = {
    cooldowns: new Map(),
    activeDashboardUpdates: new Map(),
    ticketTimers: new Map(),
    databaseLocks: new Map(),
    lastStatsReset: Date.now(),
};

// Initialize async-lock
const lock = new AsyncLock();

// Utility Functions with enhanced security
class Utils {
    static parseTime(timeString) {
        if (!timeString || typeof timeString !== 'string') return null;
        const regex = /^(\d{1,4})([smhd])$/i;
        const match = timeString.match(regex);
        if (!match) return null;
        const value = parseInt(match[1], 10);
        const unit = match[2].toLowerCase();
        if (value <= 0 || value > 9999) return null;
        switch (unit) {
            case 's': return Math.min(value * 1000, 60000);
            case 'm': return Math.min(value * 60 * 1000, 3600000);
            case 'h': return Math.min(value * 60 * 60 * 1000, 86400000);
            case 'd': return Math.min(value * 24 * 60 * 60 * 1000, 604800000);
            default: return null;
        }
    }

    static isValidUserId(userId) {
        return typeof userId === 'string' && /^\d{17,19}$/.test(userId);
    }

    static sanitizeInput(input) {
        if (typeof input !== 'string') return '';
        return input.replace(/[<>@#&!`]/g, '').trim().slice(0, 100);
    }

    static sanitizeFilePath(input) {
        if (!this.isValidUserId(input)) return null;
        return input.replace(/[^0-9]/g, '');
    }

    static hasPermission(member, permission) {
        if (!member || !member.permissions) return false;
        return member.permissions.has(permission);
    }

    static async delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    static debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }
}

// Enhanced Database with atomic operations
class Database {
    constructor() {
        this.dataPath = './bot_data';
        this.maxGuildDataSize = 1024 * 1024; // 1MB limit per guild
        this.ensureDirectories();
    }

    async ensureDirectories() {
        const dirs = [this.dataPath, './transcripts', './backups', './exports', './logs'];
        for (const dir of dirs) {
            try {
                await fs.mkdir(dir, { recursive: true });
                logger.info(`✅ Created directory: ${dir}`);
            } catch (error) {
                logger.error(`❌ Failed to create directory ${dir}:`, error);
            }
        }
    }

    async acquireLock(guildId) {
        const lockKey = `db_${guildId}`;
        return lock.acquire(lockKey, async () => {
            globalState.databaseLocks.set(lockKey, Date.now());
            return () => globalState.databaseLocks.delete(lockKey);
        }, { timeout: 10000 });
    }

    async getGuildData(guildId) {
        const sanitizedId = Utils.sanitizeFilePath(guildId);
        if (!sanitizedId) {
            logger.warn(`Invalid guild ID: ${guildId}`);
            return this.getDefaultGuildData();
        }

        try {
            const release = await this.acquireLock(guildId);
            const filePath = path.join(this.dataPath, `${sanitizedId}.json`);
            try {
                const fileContent = await fs.readFile(filePath, 'utf8');
                if (!fileContent.trim()) {
                    logger.warn(`Empty guild data file for ${guildId}, using defaults`);
                    return this.getDefaultGuildData();
                }
                const data = JSON.parse(fileContent);
                if (Buffer.byteLength(fileContent, 'utf8') > this.maxGuildDataSize) {
                    logger.warn(`Guild data for ${guildId} exceeds size limit, resetting to defaults`);
                    return this.getDefaultGuildData();
                }
                release();
                return { ...this.getDefaultGuildData(), ...data };
            } catch (error) {
                if (error.code === 'ENOENT') {
                    release();
                    return this.getDefaultGuildData();
                }
                throw error;
            }
        } catch (error) {
            logger.error(`Failed to read guild data for ${guildId}:`, error);
            await this.createBackup(guildId, error);
            return this.getDefaultGuildData();
        }
    }

    async saveGuildData(guildId, data) {
        const sanitizedId = Utils.sanitizeFilePath(guildId);
        if (!sanitizedId) {
            logger.warn(`Invalid guild ID for save: ${guildId}`);
            return false;
        }
        if (!data || typeof data !== 'object') {
            logger.error(`Invalid data for guild ${guildId}`);
            return false;
        }

        try {
            const release = await this.acquireLock(guildId);
            const filePath = path.join(this.dataPath, `${sanitizedId}.json`);
            const dataToSave = { ...this.getDefaultGuildData(), ...data };
            const jsonString = JSON.stringify(dataToSave, null, 2);
            if (Buffer.byteLength(jsonString, 'utf8') > this.maxGuildDataSize) {
                logger.error(`Guild data for ${guildId} exceeds size limit`);
                return false;
            }
            const tempPath = `${filePath}.tmp`;
            let retries = 3;
            while (retries > 0) {
                try {
                    await fs.writeFile(tempPath, jsonString);
                    await fs.rename(tempPath, filePath);
                    release();
                    return true;
                } catch (error) {
                    retries--;
                    if (retries === 0) throw error;
                    await Utils.delay(100);
                }
            }
        } catch (error) {
            logger.error(`Failed to save guild data for ${guildId}:`, error);
            return false;
        }
    }

    async createBackup(guildId, error) {
        try {
            const sanitizedId = Utils.sanitizeFilePath(guildId);
            if (!sanitizedId) return;
            const corruptedPath = path.join('./backups', `corrupted_${sanitizedId}_${Date.now()}.json`);
            const originalPath = path.join(this.dataPath, `${sanitizedId}.json`);
            try {
                await fs.copyFile(originalPath, corruptedPath);
                const errorPath = `${corruptedPath}.error.txt`;
                await fs.writeFile(errorPath, `Error: ${error.message}\nStack: ${error.stack}\nTime: ${new Date().toISOString()}`);
                logger.info(`Backed up corrupted file to: ${corruptedPath}`);
            } catch (err) {
                if (err.code !== 'ENOENT') throw err;
            }
        } catch (backupError) {
            logger.error(`Failed to backup corrupted file:`, backupError);
        }
    }

    async cleanupOldGuilds() {
        try {
            const files = await fs.readdir(this.dataPath);
            const currentGuildIds = new Set(client.guilds.cache.keys());
            for (const file of files) {
                if (file.endsWith('.json')) {
                    const guildId = file.replace('.json', '');
                    if (!currentGuildIds.has(guildId)) {
                        const filePath = path.join(this.dataPath, file);
                        const archivePath = path.join('./backups', `archived_${guildId}_${Date.now()}.json`);
                        await fs.rename(filePath, archivePath);
                        logger.info(`Archived data for left guild: ${guildId}`);
                    }
                }
            }
        } catch (error) {
            logger.error('Error cleaning up old guild data:', error);
        }
    }

    getDefaultGuildData() {
        return {
            version: '2.0.0',
            automod: {
                antiSpam: {
                    enabled: false,
                    heatLevel: 3,
                    messageSimilarity: 0.8,
                    duplicateThreshold: 3,
                    mentionLimit: 5,
                    emojiLimit: 10,
                    characterLimit: 2000,
                    newlineLimit: 10,
                },
                contentFilter: {
                    enabled: false,
                    badWords: [],
                    nsfw: false,
                    links: {
                        enabled: false,
                        whitelist: [],
                        blacklist: [],
                        roleExceptions: [],
                    },
                    invites: {
                        enabled: false,
                        roleExceptions: [],
                    },
                },
                antiRaid: {
                    enabled: false,
                    joinLimit: 5,
                    timeWindow: 30,
                    panicMode: false,
                    panicModeActivated: 0,
                    joinGate: {
                        enabled: false,
                        minAccountAge: 7,
                        requireAvatar: false,
                    },
                },
                antiNuke: {
                    enabled: false,
                    massActionLimit: 5,
                    timeWindow: 60,
                    protectedRoles: [],
                    protectedChannels: [],
                },
            },
            tickets: {
                enabled: false,
                categories: [],
                autoClose: 24,
                staffRole: null,
                logChannel: null,
                transcripts: true,
            },
            logging: {
                messageLog: { enabled: false, channel: null },
                modLog: { enabled: false, channel: null },
                joinLeave: { enabled: false, channel: null },
                voiceLog: { enabled: false, channel: null },
            },
            stats: {
                actionsToday: 0,
                actionsWeek: 0,
                actionsTotal: 0,
                topViolations: {},
                lastReset: Date.now(),
                weeklyHistory: [],
                ticketsCreated: 0,
                ticketsClosed: 0,
            },
            channelRestrictions: {},
            serverLocked: false,
            warnings: {},
        };
    }
}

// Enhanced Anti-Spam
class SmartAntiSpam {
    constructor() {
        this.userHeat = new Map();
        this.messageHistory = new Map();
        this.maxEntries = 1000;
        this.rateLimit = new Map();
        this.cleanupInterval = setInterval(() => this.cleanupOldData(), 300000);
        this.persistenceInterval = setInterval(() => this.savePersistentData(), 600000);
    }

    cleanupOldData() {
        const now = Date.now();
        const cleanupTime = 300000;
        this.userHeat.forEach((data, userId) => {
            if (!data || now - (data.lastMessage || 0) > cleanupTime) {
                this.userHeat.delete(userId);
            }
        });
        this.rateLimit.forEach((timestamp, key) => {
            if (now - timestamp > cleanupTime) {
                this.rateLimit.delete(key);
            }
        });
        if (this.userHeat.size > this.maxEntries) {
            const entries = Array.from(this.userHeat.entries());
            entries.sort((a, b) => (b[1].lastMessage || 0) - (a[1].lastMessage || 0));
            this.userHeat.clear();
            entries.slice(0, Math.floor(this.maxEntries * 0.8)).forEach(([key, value]) => {
                this.userHeat.set(key, value);
            });
        }
    }

    async savePersistentData() {
        try {
            const persistentData = {
                userHeat: Array.from(this.userHeat.entries()),
                timestamp: Date.now(),
            };
            const dataPath = './bot_data/antispam_persistence.json';
            await fs.writeFile(dataPath, JSON.stringify(persistentData));
            logger.info('✅ Saved anti-spam persistence data');
        } catch (error) {
            logger.error('Failed to save anti-spam persistence data:', error);
        }
    }

    async loadPersistentData() {
        try {
            const dataPath = './bot_data/antispam_persistence.json';
            try {
                const data = JSON.parse(await fs.readFile(dataPath, 'utf8'));
                if (Date.now() - data.timestamp < 3600000) {
                    this.userHeat = new Map(data.userHeat);
                    logger.info('✅ Loaded anti-spam persistence data');
                }
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }
        } catch (error) {
            logger.error('Failed to load anti-spam persistence data:', error);
        }
    }

    async analyzeMessage(message, guildData) {
        if (!guildData?.automod?.antiSpam?.enabled || !message?.author?.id || !message?.content || message.author.bot) {
            return false;
        }
        const rateLimitKey = `spam_${message.author.id}_${message.guild.id}`;
        if (this.rateLimit.has(rateLimitKey)) {
            return false;
        }
        this.rateLimit.set(rateLimitKey, Date.now());
        setTimeout(() => this.rateLimit.delete(rateLimitKey), 500);

        try {
            const userId = message.author.id;
            const content = message.content.toLowerCase();
            const now = Date.now();
            if (!this.userHeat.has(userId)) {
                this.userHeat.set(userId, { heat: 0, lastMessage: now, messages: [] });
            }
            const userStats = this.userHeat.get(userId);
            const timeDiff = now - (userStats.lastMessage || now);
            if (timeDiff > 10000) {
                userStats.heat = Math.max(0, userStats.heat - Math.floor(timeDiff / 10000));
            }
            let spamScore = 0;
            if (userStats.messages && userStats.messages.includes(content)) {
                spamScore += 3;
            }
            if (timeDiff < 2000) spamScore += 2;
            if (content.length > (guildData.automod.antiSpam.characterLimit || 2000)) spamScore += 2;
            const emojiCount = (content.match(/<a?:[^:]+:\d+>/g) || []).length;
            if (emojiCount > (guildData.automod.antiSpam.emojiLimit || 10)) spamScore += 2;
            const mentionCount = (content.match(/<@[!&]?\d+>/g) || []).length;
            if (mentionCount > (guildData.automod.antiSpam.mentionLimit || 5)) spamScore += 3;
            const newlineCount = (content.match(/\n/g) || []).length;
            if (newlineCount > (guildData.automod.antiSpam.newlineLimit || 10)) spamScore += 2;
            userStats.heat = Math.min(userStats.heat + spamScore, 50);
            userStats.lastMessage = now;
            if (!userStats.messages) userStats.messages = [];
            userStats.messages.push(content);
            if (userStats.messages.length > 10) {
                userStats.messages.shift();
            }
            return userStats.heat >= (guildData.automod.antiSpam.heatLevel || 3);
        } catch (error) {
            logger.error('Error in spam analysis:', error);
            return false;
        }
    }

    clearUserHeat(userId) {
        if (Utils.isValidUserId(userId)) {
            this.userHeat.delete(userId);
        }
    }

    destroy() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
        if (this.persistenceInterval) {
            clearInterval(this.persistenceInterval);
            this.persistenceInterval = null;
        }
        this.savePersistentData();
        this.userHeat.clear();
        this.messageHistory.clear();
        this.rateLimit.clear();
    }
}

// Enhanced Content Filter
class ContentFilter {
    constructor() {
        this.compiledPattern = /(n[s5][f4][w\\\/]|p[o0]rn|[s5][e3][x\\\/])/gi;
        this.urlPattern = /https?:\/\/[^\s]+/gi;
        this.invitePattern = /discord\.gg\/[a-zA-Z0-9]+/gi;
    }

    analyzeContent(content, guildData, channel, member) {
        if (!guildData?.automod?.contentFilter?.enabled || !content || !channel || !member) {
            return { violation: false };
        }
        const violations = [];
        try {
            if (guildData.automod.contentFilter.links?.enabled) {
                const urls = content.match(this.urlPattern) || [];
                const hasException = guildData.automod.contentFilter.links.roleExceptions?.some((roleId) =>
                    member.roles?.cache?.has(roleId),
                );
                if (!hasException && urls.length > 0) {
                    for (const url of urls) {
                        try {
                            const urlObj = new URL(url);
                            const domain = urlObj.hostname.toLowerCase();
                            if (guildData.automod.contentFilter.links.blacklist?.includes(domain)) {
                                violations.push({ type: 'blacklisted_link', url, domain });
                                continue;
                            }
                            if (
                                guildData.automod.contentFilter.links.whitelist?.length > 0 &&
                                !guildData.automod.contentFilter.links.whitelist.includes(domain)
                            ) {
                                violations.push({ type: 'non_whitelisted_link', url, domain });
                            }
                        } catch (error) {
                            violations.push({ type: 'invalid_link', url });
                        }
                    }
                }
            }
            if (Array.isArray(guildData.automod.contentFilter.badWords) && guildData.automod.contentFilter.badWords.length > 0) {
                const lowerContent = content.toLowerCase();
                if (this.compiledPattern.test(lowerContent)) {
                    violations.push({ type: 'badword', word: 'filtered content' });
                } else {
                    for (const word of guildData.automod.contentFilter.badWords) {
                        if (typeof word === 'string' && lowerContent.includes(word.toLowerCase())) {
                            violations.push({ type: 'badword', word });
                            break;
                        }
                    }
                }
            }
            if (guildData.automod.contentFilter.invites?.enabled) {
                const hasInviteException = guildData.automod.contentFilter.invites.roleExceptions?.some((roleId) =>
                    member.roles?.cache?.has(roleId),
                );
                if (!hasInviteException && this.invitePattern.test(content)) {
                    violations.push({ type: 'discord_invite' });
                }
            }
        } catch (error) {
            logger.error('Error in content filter analysis:', error);
        }
        return {
            violation: violations.length > 0,
            violations,
        };
    }
}

// Enhanced Anti-Raid
class AntiRaid {
    constructor() {
        this.recentJoins = new Map();
        this.maxEntries = 100;
        this.rateLimit = new Map();
        this.cleanupInterval = setInterval(() => this.cleanupOldJoins(), 60000);
    }

    cleanupOldJoins() {
        const now = Date.now();
        const maxAge = 300000;
        this.recentJoins.forEach((joins, guildId) => {
            if (!Array.isArray(joins)) {
                this.recentJoins.delete(guildId);
                return;
            }
            const validJoins = joins.filter((join) => join && typeof join.timestamp === 'number' && now - join.timestamp < maxAge);
            if (validJoins.length === 0) {
                this.recentJoins.delete(guildId);
            } else {
                this.recentJoins.set(guildId, validJoins);
            }
        });
        this.rateLimit.forEach((timestamp, key) => {
            if (now - timestamp > maxAge) {
                this.rateLimit.delete(key);
            }
        });
        if (this.recentJoins.size > this.maxEntries) {
            const oldestEntries = Array.from(this.recentJoins.keys()).slice(0, Math.floor(this.maxEntries * 0.2));
            oldestEntries.forEach((key) => this.recentJoins.delete(key));
        }
    }

    analyzeJoin(member, guildData) {
        if (!guildData?.automod?.antiRaid?.enabled || !member?.guild?.id || !member.user) return false;
        const rateLimitKey = `raid_${member.id}_${member.guild.id}`;
        if (this.rateLimit.has(rateLimitKey)) {
            return false;
        }
        this.rateLimit.set(rateLimitKey, Date.now());
        setTimeout(() => this.rateLimit.delete(rateLimitKey), 500);

        try {
            const guildId = member.guild.id;
            const now = Date.now();
            if (!this.recentJoins.has(guildId)) {
                this.recentJoins.set(guildId, []);
            }
            const joins = this.recentJoins.get(guildId);
            const timeWindow = (guildData.automod.antiRaid.timeWindow || 30) * 1000;
            const validJoins = joins.filter((join) => join && typeof join.timestamp === 'number' && now - join.timestamp < timeWindow);
            validJoins.push({
                userId: member.id,
                timestamp: now,
                accountAge: now - member.user.createdTimestamp,
            });
            this.recentJoins.set(guildId, validJoins);
            if (validJoins.length > (guildData.automod.antiRaid.joinLimit || 5)) {
                return { type: 'mass_join', count: validJoins.length };
            }
            if (guildData.automod.antiRaid.joinGate?.enabled) {
                const minAge = (guildData.automod.antiRaid.joinGate.minAccountAge || 7) * 24 * 60 * 60 * 1000;
                const accountAge = now - member.user.createdTimestamp;
                if (accountAge < minAge) {
                    return { type: 'new_account', age: accountAge };
                }
                if (guildData.automod.antiRaid.joinGate.requireAvatar && !member.user.avatar) {
                    return { type: 'no_avatar' };
                }
            }
        } catch (error) {
            logger.error('Error in raid analysis:', error);
        }
        return false;
    }

    destroy() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
        this.recentJoins.clear();
        this.rateLimit.clear();
    }
}

// Enhanced Ticket System
class TicketSystem {
    constructor(client) {
        this.client = client;
        this.activeTickets = new Map();
        this.maxActiveTickets = 100;
    }

    async createTicket(interaction, category = 'general') {
        if (!interaction?.guild?.id || !interaction?.user) return;
        try {
            if (!Utils.hasPermission(interaction.guild.members.me, PermissionFlagsBits.ManageChannels)) {
                return interaction.reply({
                    content: '❌ Bot lacks Manage Channels permission to create tickets!',
                    ephemeral: true,
                });
            }
            const guildData = await db.getGuildData(interaction.guild.id);
            if (!guildData.tickets.enabled) {
                return interaction.reply({ content: '❌ Ticket system is disabled!', ephemeral: true });
            }
            const existingTicket = Array.from(this.activeTickets.values()).find((t) => t.userId === interaction.user.id);
            if (existingTicket) {
                return interaction.reply({ content: '❌ You already have an active ticket!', ephemeral: true });
            }
            if (this.activeTickets.size >= this.maxActiveTickets) {
                return interaction.reply({ content: '❌ Too many active tickets! Please wait.', ephemeral: true });
            }
            const ticketId = `ticket-${Date.now()}`;
            const channelName = `${ticketId}-${Utils.sanitizeInput(interaction.user.username) || 'user'}`;
            const channel = await interaction.guild.channels.create({
                name: channelName,
                type: ChannelType.GuildText,
                permissionOverwrites: [
                    {
                        id: interaction.guild.id,
                        deny: [PermissionFlagsBits.ViewChannel],
                    },
                    {
                        id: interaction.user.id,
                        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
                    },
                ],
            });
            const embed = new EmbedBuilder()
                .setTitle('🎫 Support Ticket')
                .setDescription(`Ticket created by ${interaction.user}\nCategory: ${category}\nTicket ID: \`${ticketId}\`\n\nPlease describe your issue and wait for staff assistance.`)
                .setColor('#00ff00')
                .setTimestamp();
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('close_ticket')
                    .setLabel('Close Ticket')
                    .setStyle(ButtonStyle.Danger)
                    .setEmoji('🔒'),
            );
            await channel.send({ embeds: [embed], components: [row] });
            const ticketData = {
                userId: interaction.user.id,
                category,
                created: Date.now(),
                claimed: false,
                guildId: interaction.guild.id,
            };
            this.activeTickets.set(channel.id, ticketData);
            guildData.stats.ticketsCreated = (guildData.stats.ticketsCreated || 0) + 1;
            await db.saveGuildData(interaction.guild.id, guildData);
            await interaction.reply({ content: `✅ Ticket created: ${channel}`, ephemeral: true });
            if (guildData.tickets.autoClose > 0) {
                const timerId = setTimeout(() => {
                    this.autoCloseTicket(channel.id);
                }, guildData.tickets.autoClose * 60 * 60 * 1000);
                globalState.ticketTimers.set(channel.id, timerId);
            }
        } catch (error) {
            logger.error('Error creating ticket:', error);
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: '❌ Failed to create ticket!', ephemeral: true }).catch((e) => logger.error('Failed to send error reply:', e));
            }
        }
    }

    async closeTicket(channelId, closedBy) {
        const ticketData = this.activeTickets.get(channelId);
        if (!ticketData) return;
        try {
            const guild = this.client.guilds.cache.get(ticketData.guildId);
            if (!Utils.hasPermission(guild.members.me, PermissionFlagsBits.ManageChannels)) {
                logger.error(`Bot lacks Manage Channels permission to delete ticket channel ${channelId}`);
                return;
            }
            const timerId = globalState.ticketTimers.get(channelId);
            if (timerId) {
                clearTimeout(timerId);
                globalState.ticketTimers.delete(channelId);
            }
            const channel = this.client.channels.cache.get(channelId);
            if (channel) {
                await this.createTranscript(channel, ticketData);
                await Utils.delay(1000);
                await channel.delete('Ticket closed');
                const guildData = await db.getGuildData(ticketData.guildId);
                guildData.stats.ticketsClosed = (guildData.stats.ticketsClosed || 0) + 1;
                await db.saveGuildData(ticketData.guildId, guildData);
            }
            this.activeTickets.delete(channelId);
        } catch (error) {
            logger.error('Error closing ticket:', error);
        }
    }

    async createTranscript(channel, ticketData) {
        try {
            let allMessages = [];
            let lastId;
            while (true) {
                const options = { limit: 100 };
                if (lastId) options.before = lastId;
                const messages = await channel.messages.fetch(options);
                if (messages.size === 0) break;
                allMessages = allMessages.concat(Array.from(messages.values()));
                lastId = messages.last().id;
                if (messages.size < 100) break;
            }
            const transcript = allMessages
                .reverse()
                .map((m) => `[${m.createdAt.toISOString()}] ${m.author.tag}: ${m.content || '[No content/Embed]'}`)
                .join('\n');
            const filename = `./transcripts/${channel.id}_${Date.now()}.txt`;
            await fs.writeFile(filename, `Ticket Transcript\nTicket ID: ${channel.name}\nCreated: ${new Date(ticketData.created).toISOString()}\nCategory: ${ticketData.category}\n\n${transcript}`);
            logger.info(`✅ Transcript saved: ${filename}`);
        } catch (error) {
            logger.error('Error creating transcript:', error);
        }
    }

    autoCloseTicket(channelId) {
        const ticketData = this.activeTickets.get(channelId);
        if (ticketData && !ticketData.claimed) {
            this.closeTicket(channelId, 'System Auto-Close');
        }
    }

    cleanup() {
        for (const [channelId, timerId] of globalState.ticketTimers.entries()) {
            clearTimeout(timerId);
        }
        globalState.ticketTimers.clear();
    }
}

// Enhanced Admin Control Channel
class AdminControlChannel {
    static async ensureAdminChannel(guild) {
        if (!guild) return null;
        try {
            const botMember = guild.members.me;
            if (
                !botMember ||
                !Utils.hasPermission(botMember, PermissionFlagsBits.ManageChannels) ||
                !Utils.hasPermission(botMember, PermissionFlagsBits.ManageRoles)
            ) {
                logger.error(`Missing ManageChannels or ManageRoles permission in guild: ${guild.name}`);
                return null;
            }
            let adminChannel = guild.channels.cache.find((ch) => ch.name === 'admin-control' && ch.type === ChannelType.GuildText);
            if (!adminChannel) {
                const airtight = guild.roles.cache.find((r) => r.name === 'Airtight');
                if (!airtight) throw new Error('Airtight role not found');
                adminChannel = await guild.channels.create({
                    name: 'admin-control',
                    type: ChannelType.GuildText,
                    permissionOverwrites: [
                        {
                            id: guild.id,
                            deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
                        },
                        {
                            id: botMember.id,
                            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages],
                        },
                        {
                            id: airtight.id,
                            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages],
                        },
                    ],
                });
                await this.sendWelcomeMessage(adminChannel);
                logger.info(`✅ Created admin-control channel for guild: ${guild.name}`);
            }
            return adminChannel;
        } catch (error) {
            logger.error('Failed to create admin-control channel:', error);
            return null;
        }
    }

    static async sendWelcomeMessage(channel) {
        try {
            const welcomeEmbed = new EmbedBuilder()
                .setTitle('🛡️ ADMIN CONTROL CENTER')
                .setDescription('Welcome to the Ultimate Moderation Bot Control Panel!')
                .addFields(
                    {
                        name: '🎯 Quick Access',
                        value: '**Dashboard**: Main control panel\n**Setup**: Quick configuration\n**Emergency**: Instant lockdown controls',
                        inline: true,
                    },
                    {
                        name: '⚡ Features',
                        value: '**Smart AutoMod**: AI-powered protection\n**Ticket System**: Professional support\n**Advanced Logging**: Comprehensive monitoring',
                        inline: true,
                    },
                )
                .setColor('#ff6b6b')
                .setTimestamp();
            const welcomeRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('open_dashboard')
                    .setLabel('🎛️ Dashboard')
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId('quick_setup')
                    .setLabel('⚡ Setup')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId('emergency_lockdown')
                    .setLabel('🚨 Emergency')
                    .setStyle(ButtonStyle.Danger),
            );
            await channel.send({
                content: '**🎉 Admin Control Center Activated!**',
                embeds: [welcomeEmbed],
                components: [welcomeRow],
            });
        } catch (error) {
            logger.error('Error sending welcome message:', error);
        }
    }

    static updateDashboard = Utils.debounce(async function (channel, guildData, stats) {
        const updateKey = `dashboard_${channel.id}`;
        if (globalState.activeDashboardUpdates.has(updateKey)) {
            return;
        }
        globalState.activeDashboardUpdates.set(updateKey, Date.now());
        try {
            const embed = AdminControlChannel.createLiveDashboard(guildData, stats, channel.guild);
            const rows = AdminControlChannel.createDashboardControls();
            const messages = await channel.messages.fetch({ limit: 10 });
            let dashboardMessage = messages.find((m) => m.author.id === channel.client.user.id && m.embeds[0]?.title?.includes('LIVE DASHBOARD'));
            if (dashboardMessage && !dashboardMessage.deleted) {
                try {
                    await dashboardMessage.edit({ embeds: [embed], components: rows });
                } catch (editError) {
                    await channel.send({ embeds: [embed], components: rows });
                }
            } else {
                await channel.send({ embeds: [embed], components: rows });
            }
        } catch (error) {
            logger.error('Error updating dashboard:', error);
        } finally {
            globalState.activeDashboardUpdates.delete(updateKey);
        }
    }, 2000);

    static createLiveDashboard(guildData, stats, guild) {
        const now = new Date();
        let onlineMembers = 0;
        try {
            onlineMembers = guild.members.cache.filter((m) => m.presence?.status && m.presence.status !== 'offline').size;
        } catch (error) {
            onlineMembers = Math.floor(guild.memberCount * 0.3);
        }
        const panicMode = guildData.automod?.antiRaid?.panicMode;
        const panicDuration = panicMode && guildData.automod.antiRaid.panicModeActivated
            ? Math.floor((now.getTime() - guildData.automod.antiRaid.panicModeActivated) / 60000)
            : 0;
        return new EmbedBuilder()
            .setTitle('🛡️ LIVE DASHBOARD - ADMIN CONTROL CENTER')
            .setDescription('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
            .addFields(
                {
                    name: '📊 SERVER STATUS',
                    value: `🟢 **System**: ${panicMode ? `🚨 PANIC MODE (${panicDuration}m)` : 'PROTECTED'}\n👥 **Members**: ${guild.memberCount} | Online: ~${onlineMembers}\n⚡ **Actions Today**: ${stats.actionsToday || 0}`,
                    inline: true,
                },
                {
                    name: '🛡️ PROTECTION',
                    value: `${guildData.automod?.antiSpam?.enabled ? '🟢' : '🔴'} **Anti-Spam**: ${guildData.automod?.antiSpam?.enabled ? `Level ${guildData.automod.antiSpam.heatLevel}` : 'OFF'}\n${guildData.automod?.contentFilter?.enabled ? '🟢' : '🔴'} **Content Filter**: ${guildData.automod?.contentFilter?.enabled ? 'ACTIVE' : 'OFF'}\n${guildData.automod?.antiRaid?.enabled ? '🟢' : '🔴'} **Anti-Raid**: ${guildData.automod?.antiRaid?.enabled ? 'MONITORING' : 'OFF'}`,
                    inline: true,
                },
                {
                    name: '🎫 TICKETS',
                    value: `${guildData.tickets?.enabled ? '🟢' : '🔴'} **Status**: ${guildData.tickets?.enabled ? 'OPERATIONAL' : 'DISABLED'}\n🎟️ **Active**: ${ticketSystem.activeTickets.size}\n⏰ **Auto-Close**: ${guildData.tickets?.autoClose || 24}h`,
                    inline: true,
                },
                {
                    name: '⚡ PERFORMANCE',
                    value: `**Uptime**: ${Math.floor((client.uptime || 0) / 1000 / 60)}min\n**Memory**: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB\n**Guilds**: ${client.guilds.cache.size}`,
                    inline: true,
                },
                {
                    name: '📈 STATISTICS',
                    value: `**Week**: ${stats.actionsWeek || 0} actions\n**Total**: ${stats.actionsTotal || 0} actions\n**Tickets**: ${stats.ticketsCreated || 0}/${stats.ticketsClosed || 0}`,
                    inline: true,
                },
                {
                    name: '🔧 SYSTEM',
                    value: `**Locked**: ${guildData.serverLocked ? '🔒 YES' : '✅ NO'}\n**Version**: ${guildData.version || '1.0.0'}\n**Status**: ${panicMode ? '🚨 ALERT' : '✅ NORMAL'}`,
                    inline: true,
                },
            )
            .setColor(panicMode ? '#ff4444' : '#4CAF50')
            .setTimestamp()
            .setFooter({ text: `Last Updated: ${now.toLocaleTimeString()} | Bot Version 2.0.0` });
    }

    static createDashboardControls() {
        return [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('quick_setup')
                    .setLabel('⚡ Setup')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId('advanced_stats')
                    .setLabel('📊 Stats')
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId('emergency_lockdown')
                    .setLabel('🚨 Emergency')
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId('refresh_dashboard')
                    .setLabel('🔄 Refresh')
                    .setStyle(ButtonStyle.Secondary),
            ),
        ];
    }

    static isAdminControlChannel(channel) {
        return channel && channel.name === 'admin-control';
    }
}

// Initialize systems
const db = new Database();
const antiSpam = new SmartAntiSpam();
const contentFilter = new ContentFilter();
const antiRaid = new AntiRaid();
const ticketSystem = new TicketSystem(client);

// Cooldown function
function checkCooldown(userId, commandName, cooldownTime = 3000) {
    if (!Utils.isValidUserId(userId) || !commandName) return 0;
    const now = Date.now();
    const commandCooldowns = globalState.cooldowns.get(commandName) || new Map();
    if (commandCooldowns.has(userId)) {
        const expirationTime = commandCooldowns.get(userId) + cooldownTime;
        if (now < expirationTime) {
            return Math.ceil((expirationTime - now) / 1000);
        }
    }
    commandCooldowns.set(userId, now);
    globalState.cooldowns.set(commandName, commandCooldowns);
    return 0;
}

// Global cleanup
setInterval(() => {
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 1 day
    globalState.cooldowns.forEach((userCooldowns, commandName) => {
        userCooldowns.forEach((timestamp, userId) => {
            if (now - timestamp > 300000) {
                userCooldowns.delete(userId);
            }
        });
        if (userCooldowns.size === 0) {
            globalState.cooldowns.delete(commandName);
        }
    });
    globalState.activeDashboardUpdates.forEach((timestamp, updateKey) => {
        const guildId = updateKey.split('_')[1];
        if (!client.guilds.cache.has(guildId) || now - timestamp > maxAge) {
            globalState.activeDashboardUpdates.delete(updateKey);
        }
    });
    globalState.ticketTimers.forEach((timerId, channelId) => {
        const guildId = channelId.split('-')[0];
        if (!client.guilds.cache.has(guildId)) {
            clearTimeout(timerId);
            globalState.ticketTimers.delete(channelId);
        }
    });
    globalState.databaseLocks.forEach((timestamp, lockKey) => {
        if (now - timestamp > maxAge) {
            globalState.databaseLocks.delete(lockKey);
        }
    });
}, 6 * 60 * 60 * 1000); // Every 6 hours

// Slash Commands Registration
async function registerSlashCommands() {
    const commands = [
        new SlashCommandBuilder()
            .setName('panel')
            .setDescription('Open the admin control panel')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
        new SlashCommandBuilder()
            .setName('setup')
            .setDescription('Quick setup wizard for new servers')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
        new SlashCommandBuilder()
            .setName('dashboard')
            .setDescription('Force refresh the admin dashboard')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
        new SlashCommandBuilder()
            .setName('config')
            .setDescription('Configure bot settings')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .addSubcommand((subcommand) =>
                subcommand
                    .setName('antispam')
                    .setDescription('Configure anti-spam settings')
                    .addBooleanOption((option) =>
                        option.setName('enabled').setDescription('Enable/disable anti-spam').setRequired(true),
                    )
                    .addIntegerOption((option) =>
                        option.setName('heat_level').setDescription('Heat level threshold (1-10)').setMinValue(1).setMaxValue(10),
                    ),
            )
            .addSubcommand((subcommand) =>
                subcommand
                    .setName('contentfilter')
                    .setDescription('Configure content filter settings')
                    .addBooleanOption((option) =>
                        option.setName('enabled').setDescription('Enable/disable content filter').setRequired(true),
                    ),
            )
            .addSubcommand((subcommand) =>
                subcommand
                    .setName('antiraid')
                    .setDescription('Configure anti-raid settings')
                    .addBooleanOption((option) =>
                        option.setName('enabled').setDescription('Enable/disable anti-raid').setRequired(true),
                    )
                    .addIntegerOption((option) =>
                        option.setName('join_limit').setDescription('Maximum joins allowed in time window').setMinValue(1).setMaxValue(20),
                    ),
            )
            .addSubcommand((subcommand) => subcommand.setName('reset').setDescription('Reset all configuration to defaults')),
        new SlashCommandBuilder()
            .setName('ticket')
            .setDescription('Create a support ticket')
            .addStringOption((option) =>
                option
                    .setName('category')
                    .setDescription('Ticket category')
                    .addChoices(
                        { name: 'General Support', value: 'general' },
                        { name: 'Bug Report', value: 'bug' },
                        { name: 'Feature Request', value: 'feature' },
                        { name: 'Appeal', value: 'appeal' },
                        { name: 'Billing', value: 'billing' },
                    ),
            ),
        new SlashCommandBuilder()
            .setName('purge')
            .setDescription('Mass delete messages')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
            .addIntegerOption((option) =>
                option
                    .setName('amount')
                    .setDescription('Number of messages to delete')
                    .setRequired(true)
                    .setMinValue(1)
                    .setMaxValue(100),
            )
            .addUserOption((option) => option.setName('user').setDescription('Only delete messages from this user')),
        new SlashCommandBuilder()
            .setName('warn')
            .setDescription('Warn a user')
            .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
            .addUserOption((option) => option.setName('user').setDescription('User to warn').setRequired(true))
            .addStringOption((option) => option.setName('reason').setDescription('Reason for warning').setRequired(true)),
        new SlashCommandBuilder()
            .setName('warnings')
            .setDescription('View warnings for a user')
            .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
            .addUserOption((option) => option.setName('user').setDescription('User to check warnings for').setRequired(true)),
        new SlashCommandBuilder()
            .setName('clearwarnings')
            .setDescription('Clear all warnings for a user')
            .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
            .addUserOption((option) => option.setName('user').setDescription('User to clear warnings for').setRequired(true)),
        new SlashCommandBuilder()
            .setName('mute')
            .setDescription('Mute a user')
            .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
            .addUserOption((option) => option.setName('user').setDescription('User to mute').setRequired(true))
            .addStringOption((option) => option.setName('duration').setDescription('Duration (e.g., 1h, 30m, 1d)').setRequired(true))
            .addStringOption((option) => option.setName('reason').setDescription('Reason for mute')),
        new SlashCommandBuilder()
            .setName('unmute')
            .setDescription('Unmute a user')
            .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
            .addUserOption((option) => option.setName('user').setDescription('User to unmute').setRequired(true)),
        new SlashCommandBuilder()
            .setName('kick')
            .setDescription('Kick a user from the server')
            .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
            .addUserOption((option) => option.setName('user').setDescription('User to kick').setRequired(true))
            .addStringOption((option) => option.setName('reason').setDescription('Reason for kick')),
        new SlashCommandBuilder()
            .setName('ban')
            .setDescription('Ban a user from the server')
            .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
            .addUserOption((option) => option.setName('user').setDescription('User to ban').setRequired(true))
            .addStringOption((option) => option.setName('reason').setDescription('Reason for ban'))
            .addIntegerOption((option) =>
                option.setName('delete_days').setDescription('Days of messages to delete (0-7)').setMinValue(0).setMaxValue(7),
            ),
        new SlashCommandBuilder()
            .setName('unban')
            .setDescription('Unban a user from the server')
            .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
            .addStringOption((option) => option.setName('user_id').setDescription('User ID to unban').setRequired(true))
            .addStringOption((option) => option.setName('reason').setDescription('Reason for unban')),
        new SlashCommandBuilder()
            .setName('slowmode')
            .setDescription('Set channel slowmode')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
            .addIntegerOption((option) =>
                option
                    .setName('seconds')
                    .setDescription('Slowmode duration in seconds (0 to disable)')
                    .setRequired(true)
                    .setMinValue(0)
                    .setMaxValue(21600),
            )
            .addChannelOption((option) =>
                option.setName('channel').setDescription('Channel to apply slowmode (current channel if not specified)').addChannelTypes(ChannelType.GuildText),
            ),
        new SlashCommandBuilder()
            .setName('lockdown')
            .setDescription('Lock or unlock channels')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
            .addStringOption((option) =>
                option
                    .setName('action')
                    .setDescription('Lock or unlock')
                    .setRequired(true)
                    .addChoices(
                        { name: 'Lock Current Channel', value: 'lock' },
                        { name: 'Unlock Current Channel', value: 'unlock' },
                        { name: 'Lock All Channels', value: 'lockall' },
                        { name: 'Unlock All Channels', value: 'unlockall' },
                    ),
            )
            .addChannelOption((option) =>
                option.setName('channel').setDescription('Specific channel to lock/unlock').addChannelTypes(ChannelType.GuildText),
            ),
        new SlashCommandBuilder()
            .setName('stats')
            .setDescription('View server moderation statistics')
            .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
        new SlashCommandBuilder()
            .setName('userinfo')
            .setDescription('Get information about a user')
            .addUserOption((option) => option.setName('user').setDescription('User to get info about').setRequired(false)),
        new SlashCommandBuilder()
            .setName('export')
            .setDescription('Export server data')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .addStringOption((option) =>
                option
                    .setName('type')
                    .setDescription('Type of data to export')
                    .setRequired(true)
                    .addChoices(
                        { name: 'Warnings', value: 'warnings' },
                        { name: 'Statistics', value: 'stats' },
                        { name: 'Configuration', value: 'config' },
                        { name: 'All Data', value: 'all' },
                    ),
            ),
    ];
    try {
        logger.info('🔄 Started refreshing application (/) commands.');
        await client.application.commands.set(commands);
        logger.info(`✅ Successfully reloaded ${commands.length} application (/) commands.`);
    } catch (error) {
        logger.error('❌ Error registering slash commands:', error);
    }
}

// Bot Events
client.once(Events.ClientReady, async () => {
    logger.info(`🚀 ${client.user.tag} is online!`);
    logger.info(`📊 Serving ${client.guilds.cache.size} servers`);
    logger.info(`👥 Watching ${client.users.cache.size} users`);
    try {
        await antiSpam.loadPersistentData();
        await registerSlashCommands();
        await db.cleanupOldGuilds();
        client.user.setActivity('🛡️ Protecting servers', { type: ActivityType.Watching });
        logger.info('🎯 All systems initialized successfully!');
    } catch (error) {
        logger.error('❌ Error in ready event:', error);
    }
});

client.on(Events.GuildDelete, async (guild) => {
    logger.info(`📤 Left guild: ${guild.name} (${guild.id})`);
    try {
        const guildData = await db.getGuildData(guild.id);
        const archivePath = path.join('./backups', `left_guild_${guild.id}_${Date.now()}.json`);
        await fs.writeFile(archivePath, JSON.stringify(guildData, null, 2));
        logger.info(`📦 Archived data for left guild: ${guild.name}`);
        globalState.cooldowns.forEach((userCooldowns, commandName) => {
            userCooldowns.forEach((_, userId) => {
                if (userId.startsWith(guild.id)) {
                    userCooldowns.delete(userId);
                }
            });
            if (userCooldowns.size === 0) {
                globalState.cooldowns.delete(commandName);
            }
        });
        globalState.activeDashboardUpdates.forEach((_, updateKey) => {
            if (updateKey.includes(guild.id)) {
                globalState.activeDashboardUpdates.delete(updateKey);
            }
        });
        globalState.ticketTimers.forEach((timerId, channelId) => {
            if (channelId.includes(guild.id)) {
                clearTimeout(timerId);
                globalState.ticketTimers.delete(channelId);
            }
        });
        globalState.databaseLocks.forEach((_, lockKey) => {
            if (lockKey.includes(guild.id)) {
                globalState.databaseLocks.delete(lockKey);
            }
        });
    } catch (error) {
        logger.error('Error archiving guild data or cleaning global state:', error);
    }
});

client.on(Events.GuildUnavailable, (guild) => {
    logger.warn(`⚠️ Guild unavailable: ${guild.name} (${guild.id})`);
});

client.on(Events.MessageCreate, async (message) => {
    if (message.author?.bot || !message.guild || !message.content) return;
    try {
        const guildData = await db.getGuildData(message.guild.id);
        const member = message.member;
        if (!member || !guildData) return;
        if (Utils.hasPermission(member, PermissionFlagsBits.Administrator)) return;
        const messageKey = `msg_${message.author.id}_${message.guild.id}`;
        if (globalState.cooldowns.has(messageKey)) return;
        globalState.cooldowns.set(messageKey, Date.now());
        setTimeout(() => globalState.cooldowns.delete(messageKey), 1000);
        if (antiSpam.analyzeMessage(message, guildData)) {
            await message.delete().catch((e) => logger.error('Failed to delete message:', e));
            const userHeat = antiSpam.userHeat.get(message.author.id)?.heat || 0;
            if (userHeat > 15) {
                try {
                    await member.timeout(10 * 60 * 1000, 'Severe spam detected');
                    const muteMsg = await message.channel.send(`${message.author}, you have been muted for 10 minutes due to severe spam.`);
                    setTimeout(() => muteMsg.delete().catch(() => {}), 10000);
                } catch (error) {
                    const warningMsg = await message.channel.send(`${message.author}, severe spam detected! Please slow down.`);
                    setTimeout(() => warningMsg.delete().catch(() => {}), 5000);
                }
            } else {
                const msg = await message.channel.send(`${message.author}, slow down! Anti-spam triggered.`);
                setTimeout(() => msg.delete().catch(() => {}), 5000);
            }
            guildData.stats.actionsToday++;
            guildData.stats.actionsTotal = (guildData.stats.actionsTotal || 0) + 1;
            guildData.stats.topViolations.spam = (guildData.stats.topViolations.spam || 0) + 1;
            await db.saveGuildData(message.guild.id, guildData);
            return;
        }
        const filterResult = contentFilter.analyzeContent(message.content, guildData, message.channel, member);
        if (filterResult.violation) {
            await message.delete().catch((e) => logger.error('Failed to delete message:', e));
            const violationTypes = filterResult.violations.map((v) => v.type);
            let response = `${message.author}, your message was filtered: `;
            if (violationTypes.includes('non_whitelisted_link')) {
                response += 'Links are not allowed in this channel.';
            } else if (violationTypes.includes('blacklisted_link')) {
                response += 'This link is blocked.';
            } else if (violationTypes.includes('discord_invite')) {
                response += 'Discord invites are not allowed.';
            } else if (violationTypes.includes('badword')) {
                response += 'Inappropriate language detected.';
            } else {
                response += violationTypes.join(', ');
            }
            const filterMsg = await message.channel.send(response);
            setTimeout(() => filterMsg.delete().catch(() => {}), 5000);
            guildData.stats.actionsToday++;
            guildData.stats.actionsTotal = (guildData.stats.actionsTotal || 0) + 1;
            guildData.stats.topViolations.content = (guildData.stats.topViolations.content || 0) + 1;
            await db.saveGuildData(message.guild.id, guildData);
        }
    } catch (error) {
        logger.error('Error in message handler:', error);
    }
});

client.on(Events.GuildMemberAdd, async (member) => {
    if (!member?.guild?.id || !member.user) return;
    try {
        const guildData = await db.getGuildData(member.guild.id);
        const raidResult = antiRaid.analyzeJoin(member, guildData);
        if (raidResult) {
            if (raidResult.type === 'mass_join') {
                guildData.automod.antiRaid.panicMode = true;
                guildData.automod.antiRaid.panicModeActivated = Date.now();
                await db.saveGuildData(member.guild.id, guildData);
                const adminChannel = member.guild.channels.cache.find((ch) => ch.name === 'admin-control');
                if (adminChannel) {
                    const embed = new EmbedBuilder()
                        .setTitle('🚨 RAID DETECTED')
                        .setDescription(`**${raidResult.count}** users joined in **${guildData.automod.antiRaid.timeWindow}s**\n\n**PANIC MODE ACTIVATED**`)
                        .addFields({
                            name: '🛡️ Automatic Actions',
                            value: '• Anti-raid monitoring increased\n• Join gate activated\n• All new joins will be scrutinized',
                        })
                        .setColor('#ff0000')
                        .setTimestamp();
                    await adminChannel.send({ embeds: [embed] });
                }
            } else if (raidResult.type === 'new_account' || raidResult.type === 'no_avatar') {
                try {
                    await member.kick(`Join gate violation: ${raidResult.type}`);
                    const adminChannel = member.guild.channels.cache.find((ch) => ch.name === 'admin-control');
                    if (adminChannel) {
                        await adminChannel.send(`🛡️ **Join Gate**: Kicked ${member.user.tag} (${raidResult.type})`);
                    }
                } catch (kickError) {
                    logger.error('Failed to kick user in join gate:', kickError);
                }
            }
            guildData.stats.actionsToday++;
            guildData.stats.actionsTotal = (guildData.stats.actionsTotal || 0) + 1;
            await db.saveGuildData(member.guild.id, guildData);
        }
    } catch (error) {
        logger.error('Error in member join handler:', error);
    }
});

client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.guild) return;
    try {
        const guildData = await db.getGuildData(interaction.guild.id);
        if (interaction.isButton()) {
            const cooldownTime = checkCooldown(interaction.user.id, interaction.customId, 2000);
            if (cooldownTime > 0) {
                return interaction.reply({
                    content: `⏰ Please wait ${cooldownTime} seconds before using this button again.`,
                    ephemeral: true,
                });
            }
            if (!['close_ticket', 'claim_ticket'].includes(interaction.customId)) {
                if (!AdminControlChannel.isAdminControlChannel(interaction.channel)) {
                    return interaction.reply({
                        content: '🚫 **Access Denied!** Admin controls are only available in the dedicated `#admin-control` channel.\nUse `/panel` command to access the dashboard.',
                        ephemeral: true,
                    });
                }
                if (!Utils.hasPermission(interaction.member, PermissionFlagsBits.Administrator)) {
                    return interaction.reply({
                        content: '🚫 **Access Denied!** You need Administrator permissions to use this feature.',
                        ephemeral: true,
                    });
                }
            }
            switch (interaction.customId) {
                case 'open_dashboard':
                    await AdminControlChannel.updateDashboard(interaction.channel, guildData, guildData.stats);
                    await interaction.reply({ content: '🎛️ Dashboard refreshed!', ephemeral: true });
                    break;
                case 'quick_setup':
                    const setupEmbed = new EmbedBuilder()
                        .setTitle('⚡ QUICK SETUP WIZARD')
                        .setDescription('Enable essential protection features with one click!')
                        .addFields({
                            name: '🛡️ Recommended Settings',
                            value: '• **Anti-Spam**: Level 3 (Moderate)\n• **Content Filter**: Basic protection\n• **Anti-Raid**: 5 joins/30s limit\n• **Ticket System**: General support\n• **Join Gate**: 7-day minimum account age',
                            inline: false,
                        })
                        .setColor('#4CAF50');
                    const setupRow = new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId('apply_recommended')
                            .setLabel('✅ Apply Settings')
                            .setStyle(ButtonStyle.Success),
                        new ButtonBuilder()
                            .setCustomId('cancel_setup')
                            .setLabel('❌ Cancel')
                            .setStyle(ButtonStyle.Secondary),
                    );
                    await interaction.reply({ embeds: [setupEmbed], components: [setupRow], ephemeral: true });
                    break;
                case 'apply_recommended':
                    guildData.automod.antiSpam.enabled = true;
                    guildData.automod.antiSpam.heatLevel = 3;
                    guildData.automod.contentFilter.enabled = true;
                    guildData.automod.antiRaid.enabled = true;
                    guildData.automod.antiRaid.joinLimit = 5;
                    guildData.automod.antiRaid.joinGate.enabled = true;
                    guildData.automod.antiRaid.joinGate.minAccountAge = 7;
                    guildData.tickets.enabled = true;
                    await db.saveGuildData(interaction.guild.id, guildData);
                    await AdminControlChannel.updateDashboard(interaction.channel, guildData, guildData.stats);
                    await interaction.update({
                        content: '✅ **Settings applied successfully!** Your server is now protected with:\n\n• Anti-spam protection (Level 3)\n• Content filtering\n• Anti-raid monitoring\n• Join gate (7-day minimum)\n• Ticket system',
                        embeds: [],
                        components: [],
                    });
                    break;
                case 'emergency_lockdown':
                    if (!Utils.hasPermission(interaction.guild.members.me, PermissionFlagsBits.ManageChannels)) {
                        return interaction.reply({
                            content: '❌ **Permission Error**: Bot lacks Manage Channels permission for emergency lockdown!',
                            ephemeral: true,
                        });
                    }
                    await interaction.deferReply({ ephemeral: true });
                    const channels = interaction.guild.channels.cache.filter((ch) => ch.type === ChannelType.GuildText);
                    let lockedCount = 0;
                    let failedCount = 0;
                    for (const [, channel] of channels) {
                        try {
                            if (channel.name !== 'admin-control') {
                                await channel.permissionOverwrites.edit(interaction.guild.id, {
                                    SendMessages: false,
                                });
                                lockedCount++;
                                await Utils.delay(100);
                            }
                        } catch (error) {
                            logger.error(`Failed to lock channel ${channel.name}:`, error);
                            failedCount++;
                        }
                    }
                    guildData.serverLocked = true;
                    guildData.stats.actionsToday++;
                    guildData.stats.actionsTotal = (guildData.stats.actionsTotal || 0) + 1;
                    await db.saveGuildData(interaction.guild.id, guildData);
                    await AdminControlChannel.updateDashboard(interaction.channel, guildData, guildData.stats);
                    await interaction.editReply({
                        content: `🔒 **EMERGENCY LOCKDOWN ACTIVATED**\n\n✅ Locked: ${lockedCount} channels\n${failedCount > 0 ? `❌ Failed: ${failedCount} channels\n` : ''}🔧 Use \`/lockdown unlockall\` to restore normal operations.`,
                    });
                    break;
                case 'refresh_dashboard':
                    await AdminControlChannel.updateDashboard(interaction.channel, guildData, guildData.stats);
                    await interaction.reply({ content: '🔄 Dashboard refreshed!', ephemeral: true });
                    break;
                case 'advanced_stats':
                    const topViolations = Object.entries(guildData.stats.topViolations || {})
                        .sort(([, a], [, b]) => b - a)
                        .slice(0, 5)
                        .map(([type, count]) => `• ${type}: ${count}`)
                        .join('\n') || 'None';
                    const weeklyAvg =
                        guildData.stats.weeklyHistory?.length > 0
                            ? Math.round(guildData.stats.weeklyHistory.reduce((a, b) => a + b, 0) / guildData.stats.weeklyHistory.length)
                            : 0;
                    const statsEmbed = new EmbedBuilder()
                        .setTitle('📊 Advanced Server Statistics')
                        .addFields(
                            { name: '⚡ Actions Today', value: (guildData.stats.actionsToday || 0).toString(), inline: true },
                            { name: '📈 Actions This Week', value: (guildData.stats.actionsWeek || 0).toString(), inline: true },
                            { name: '📊 Weekly Average', value: weeklyAvg.toString(), inline: true },
                            { name: '🎫 Tickets Created', value: (guildData.stats.ticketsCreated || 0).toString(), inline: true },
                            { name: '✅ Tickets Closed', value: (guildData.stats.ticketsClosed || 0).toString(), inline: true },
                            { name: '📈 Total Actions', value: (guildData.stats.actionsTotal || 0).toString(), inline: true },
                            { name: '🔧 Active Systems', value: `${Object.values(guildData.automod).filter((system) => system.enabled).length}/4`, inline: true },
                            { name: '🚨 Server Status', value: guildData.serverLocked ? '🔒 LOCKED' : '✅ NORMAL', inline: true },
                            { name: '🛡️ Panic Mode', value: guildData.automod.antiRaid.panicMode ? '🚨 ACTIVE' : '✅ NORMAL', inline: true },
                            { name: '🏆 Top Violations', value: topViolations, inline: false },
                        )
                        .setColor('#4CAF50')
                        .setTimestamp()
                        .setFooter({ text: `Stats since: ${new Date(guildData.stats.lastReset).toLocaleDateString()}` });
                    await interaction.reply({ embeds: [statsEmbed], ephemeral: true });
                    break;
                case 'close_ticket':
                    await interaction.reply({ content: '🔒 Closing ticket...', ephemeral: true });
                    await ticketSystem.closeTicket(interaction.channel.id, interaction.user.id);
                    break;
                case 'cancel_setup':
                    await interaction.update({
                        content: '❌ Setup cancelled.',
                        embeds: [],
                        components: [],
                    });
                    break;
                default:
                    await interaction.reply({ content: '❌ Unknown button!', ephemeral: true });
                    break;
            }
        } else if (interaction.isChatInputCommand()) {
            const { commandName } = interaction;
            const cooldownTime = checkCooldown(interaction.user.id, commandName, 3000);
            if (cooldownTime > 0) {
                return interaction.reply({
                    content: `⏰ Please wait ${cooldownTime} seconds before using this command again.`,
                    ephemeral: true,
                });
            }
            logger.info(`Command executed: ${commandName} by ${interaction.user.tag} in ${interaction.guild.name}`);
            await interaction.deferReply({ ephemeral: true });
            const guildData = await db.getGuildData(interaction.guild.id);
            switch (commandName) {
                case 'panel':
                    if (!Utils.hasPermission(interaction.member, PermissionFlagsBits.Administrator)) {
                        return interaction.editReply({
                            content: '🚫 You need Administrator permissions to use this command.',
                        });
                    }
                    const adminChannel = await AdminControlChannel.ensureAdminChannel(interaction.guild);
                    if (adminChannel) {
                        await AdminControlChannel.updateDashboard(adminChannel, guildData, guildData.stats);
                        await interaction.editReply({
                            content: `✅ Admin control panel created/updated in ${adminChannel}`,
                        });
                    } else {
                        await interaction.editReply({
                            content: '❌ Failed to create admin control panel!',
                        });
                    }
                    break;
                case 'setup':
                    if (!Utils.hasPermission(interaction.member, PermissionFlagsBits.Administrator)) {
                        return interaction.editReply({
                            content: '🚫 You need Administrator permissions to use this command.',
                        });
                    }
                    const setupEmbed = new EmbedBuilder()
                        .setTitle('⚡ QUICK SETUP WIZARD')
                        .setDescription('Enable essential protection features with one click!')
                        .addFields({
                            name: '🛡️ Recommended Settings',
                            value: '• **Anti-Spam**: Level 3 (Moderate)\n• **Content Filter**: Basic protection\n• **Anti-Raid**: 5 joins/30s limit\n• **Ticket System**: General support\n• **Join Gate**: 7-day minimum account age',
                            inline: false,
                        })
                        .setColor('#4CAF50');
                    const setupRow = new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId('apply_recommended')
                            .setLabel('✅ Apply Settings')
                            .setStyle(ButtonStyle.Success),
                        new ButtonBuilder()
                            .setCustomId('cancel_setup')
                            .setLabel('❌ Cancel')
                            .setStyle(ButtonStyle.Secondary),
                    );
                    await interaction.editReply({ embeds: [setupEmbed], components: [setupRow] });
                    break;
                case 'dashboard':
                    if (!Utils.hasPermission(interaction.member, PermissionFlagsBits.Administrator)) {
                        return interaction.editReply({
                            content: '🚫 You need Administrator permissions to use this command.',
                        });
                    }
                    const channel = interaction.guild.channels.cache.find((ch) => AdminControlChannel.isAdminControlChannel(ch));
                    if (!channel) {
                        return interaction.editReply({
                            content: '❌ Admin control channel not found! Use `/panel` to create it.',
                        });
                    }
                    await AdminControlChannel.updateDashboard(channel, guildData, guildData.stats);
                    await interaction.editReply({ content: '🔄 Dashboard refreshed!' });
                    break;
                case 'config':
                    if (!Utils.hasPermission(interaction.member, PermissionFlagsBits.Administrator)) {
                        return interaction.editReply({
                            content: '🚫 You need Administrator permissions to use this command.',
                        });
                    }
                    const subcommand = interaction.options.getSubcommand();
                    switch (subcommand) {
                        case 'antispam':
                            const antiSpamEnabled = interaction.options.getBoolean('enabled');
                            const heatLevel = interaction.options.getInteger('heat_level') || guildData.automod.antiSpam.heatLevel;
                            guildData.automod.antiSpam.enabled = antiSpamEnabled;
                            guildData.automod.antiSpam.heatLevel = heatLevel;
                            await db.saveGuildData(interaction.guild.id, guildData);
                            await interaction.editReply({
                                content: `✅ Anti-spam ${antiSpamEnabled ? 'enabled' : 'disabled'} with heat level ${heatLevel}.`,
                            });
                            break;
                        case 'contentfilter':
                            guildData.automod.contentFilter.enabled = interaction.options.getBoolean('enabled');
                            await db.saveGuildData(interaction.guild.id, guildData);
                            await interaction.editReply({
                                content: `✅ Content filter ${guildData.automod.contentFilter.enabled ? 'enabled' : 'disabled'}.`,
                            });
                            break;
                        case 'antiraid':
                            const antiRaidEnabled = interaction.options.getBoolean('enabled');
                            const joinLimit = interaction.options.getInteger('join_limit') || guildData.automod.antiRaid.joinLimit;
                            guildData.automod.antiRaid.enabled = antiRaidEnabled;
                            guildData.automod.antiRaid.joinLimit = joinLimit;
                            await db.saveGuildData(interaction.guild.id, guildData);
                            await interaction.editReply({
                                content: `✅ Anti-raid ${antiRaidEnabled ? 'enabled' : 'disabled'} with join limit ${joinLimit}.`,
                            });
                            break;
                        case 'reset':
                            guildData.automod = db.getDefaultGuildData().automod;
                            guildData.tickets = db.getDefaultGuildData().tickets;
                            await db.saveGuildData(interaction.guild.id, guildData);
                            await interaction.editReply({ content: '✅ Configuration reset to defaults.' });
                            break;
                    }
                    break;
                case 'ticket':
                    const category = interaction.options.getString('category') || 'general';
                    await ticketSystem.createTicket(interaction, category);
                    break;
                case 'purge':
                    if (!Utils.hasPermission(interaction.member, PermissionFlagsBits.ManageMessages)) {
                        return interaction.editReply({
                            content: '🚫 You need Manage Messages permission to use this command.',
                        });
                    }
                    if (!Utils.hasPermission(interaction.guild.members.me, PermissionFlagsBits.ManageMessages)) {
                        return interaction.editReply({
                            content: '❌ Bot lacks Manage Messages permission!',
                        });
                    }
                    const amount = interaction.options.getInteger('amount');
                    const targetUser = interaction.options.getUser('user');
                    const purgeChannel = interaction.channel;
                    let messages = await purgeChannel.messages.fetch({ limit: amount });
                    if (targetUser) {
                        messages = messages.filter((m) => m.author.id === targetUser.id);
                    }
                    await purgeChannel.bulkDelete(messages, true);
                    guildData.stats.actionsToday++;
                    guildData.stats.actionsTotal++;
                    await db.saveGuildData(interaction.guild.id, guildData);
                    await interaction.editReply({
                        content: `✅ Successfully deleted ${messages.size} messages.`,
                    });
                    break;
                case 'warn':
                    if (!Utils.hasPermission(interaction.member, PermissionFlagsBits.ModerateMembers)) {
                        return interaction.editReply({
                            content: '🚫 You need Moderate Members permission to use this command.',
                        });
                    }
                    const warnUser = interaction.options.getUser('user');
                    const warnReason = Utils.sanitizeInput(interaction.options.getString('reason'));
                    if (!guildData.warnings[warnUser.id]) guildData.warnings[warnUser.id] = [];
                    guildData.warnings[warnUser.id].push({
                        reason: warnReason,
                        timestamp: Date.now(),
                        moderator: interaction.user.id,
                    });
                    await db.saveGuildData(interaction.guild.id, guildData);
                    await interaction.editReply({
                        content: `✅ Warned ${warnUser.tag} for: ${warnReason}`,
                    });
                    try {
                        await warnUser.send(`⚠️ You were warned in ${interaction.guild.name} for: ${warnReason}`);
                    } catch (e) {
                        logger.warn(`Failed to DM warning to ${warnUser.tag}:`, e);
                    }
                    guildData.stats.actionsToday++;
                    guildData.stats.actionsTotal++;
                    await db.saveGuildData(interaction.guild.id, guildData);
                    break;
                case 'warnings':
                    if (!Utils.hasPermission(interaction.member, PermissionFlagsBits.ModerateMembers)) {
                        return interaction.editReply({
                            content: '🚫 You need Moderate Members permission to use this command.',
                        });
                    }
                                       case 'warnings':
                        if (!Utils.hasPermission(interaction.member, PermissionFlagsBits.ModerateMembers)) {
                            return interaction.editReply({
                                content: '🚫 You need Moderate Members permission to use this command.',
                            });
                        }
                        const warningsUser = interaction.options.getUser('user');
                        const userWarnings = guildData.warnings[warningsUser.id] || [];
                        if (userWarnings.length === 0) {
                            return interaction.editReply({
                                content: `✅ ${warningsUser.tag} has no warnings.`,
                            });
                        }
                        const warningsEmbed = new EmbedBuilder()
                            .setTitle(`⚠️ Warnings for ${warningsUser.tag}`)
                            .setDescription(
                                userWarnings
                                    .map((w, i) => `#${i + 1} | **Reason**: ${w.reason} | **By**: <@${w.moderator}> | **Time**: ${new Date(w.timestamp).toLocaleString()}`)
                                    .join('\n'),
                            )
                            .setColor('#ffaa00')
                            .setTimestamp();
                        await interaction.editReply({ embeds: [warningsEmbed] });
                        break;
                    case 'clearwarnings':
                        if (!Utils.hasPermission(interaction.member, PermissionFlagsBits.ModerateMembers)) {
                            return interaction.editReply({
                                content: '🚫 You need Moderate Members permission to use this command.',
                            });
                        }
                        const clearUser = interaction.options.getUser('user');
                        if (guildData.warnings[clearUser.id]) {
                            delete guildData.warnings[clearUser.id];
                            await db.saveGuildData(interaction.guild.id, guildData);
                            await interaction.editReply({
                                content: `✅ Cleared all warnings for ${clearUser.tag}.`,
                            });
                        } else {
                            await interaction.editReply({
                                content: `✅ ${clearUser.tag} has no warnings to clear.`,
                            });
                        }
                        guildData.stats.actionsToday++;
                        guildData.stats.actionsTotal++;
                        await db.saveGuildData(interaction.guild.id, guildData);
                        break;
                    case 'mute':
                        if (!Utils.hasPermission(interaction.member, PermissionFlagsBits.ModerateMembers)) {
                            return interaction.editReply({
                                content: '🚫 You need Moderate Members permission to use this command.',
                            });
                        }
                        if (!Utils.hasPermission(interaction.guild.members.me, PermissionFlagsBits.ModerateMembers)) {
                            return interaction.editReply({
                                content: '❌ Bot lacks Moderate Members permission!',
                            });
                        }
                        const muteUser = interaction.options.getUser('user');
                        const muteMember = await interaction.guild.members.fetch(muteUser.id).catch(() => null);
                        if (!muteMember) {
                            return interaction.editReply({ content: '❌ User not found in the server!' });
                        }
                        const durationString = interaction.options.getString('duration');
                        const muteReason = Utils.sanitizeInput(interaction.options.getString('reason') || 'No reason provided');
                        const durationMs = Utils.parseTime(durationString);
                        if (!durationMs) {
                            return interaction.editReply({ content: '❌ Invalid duration format! Use e.g., 1h, 30m, 1d.' });
                        }
                        await muteMember.timeout(durationMs, muteReason);
                        await interaction.editReply({
                            content: `✅ Muted ${muteUser.tag} for ${durationString}: ${muteReason}`,
                        });
                        try {
                            await muteUser.send(`🔇 You were muted in ${interaction.guild.name} for ${durationString}. Reason: ${muteReason}`);
                        } catch (e) {
                            logger.warn(`Failed to DM mute notification to ${muteUser.tag}:`, e);
                        }
                        guildData.stats.actionsToday++;
                        guildData.stats.actionsTotal++;
                        guildData.stats.topViolations.mute = (guildData.stats.topViolations.mute || 0) + 1;
                        await db.saveGuildData(interaction.guild.id, guildData);
                        break;
                    case 'unmute':
                        if (!Utils.hasPermission(interaction.member, PermissionFlagsBits.ModerateMembers)) {
                            return interaction.editReply({
                                content: '🚫 You need Moderate Members permission to use this command.',
                            });
                        }
                        if (!Utils.hasPermission(interaction.guild.members.me, PermissionFlagsBits.ModerateMembers)) {
                            return interaction.editReply({
                                content: '❌ Bot lacks Moderate Members permission!',
                            });
                        }
                        const unmuteUser = interaction.options.getUser('user');
                        const unmuteMember = await interaction.guild.members.fetch(unmuteUser.id).catch(() => null);
                        if (!unmuteMember) {
                            return interaction.editReply({ content: '❌ User not found in the server!' });
                        }
                        await unmuteMember.timeout(null, 'Unmuted by moderator');
                        await interaction.editReply({
                            content: `✅ Unmuted ${unmuteUser.tag}.`,
                        });
                        try {
                            await unmuteUser.send(`🔊 You were unmuted in ${interaction.guild.name}.`);
                        } catch (e) {
                            logger.warn(`Failed to DM unmute notification to ${unmuteUser.tag}:`, e);
                        }
                        guildData.stats.actionsToday++;
                        guildData.stats.actionsTotal++;
                        await db.saveGuildData(interaction.guild.id, guildData);
                        break;
                    case 'kick':
                        if (!Utils.hasPermission(interaction.member, PermissionFlagsBits.KickMembers)) {
                            return interaction.editReply({
                                content: '🚫 You need Kick Members permission to use this command.',
                            });
                        }
                        if (!Utils.hasPermission(interaction.guild.members.me, PermissionFlagsBits.KickMembers)) {
                            return interaction.editReply({
                                content: '❌ Bot lacks Kick Members permission!',
                            });
                        }
                        const kickUser = interaction.options.getUser('user');
                        const kickMember = await interaction.guild.members.fetch(kickUser.id).catch(() => null);
                        if (!kickMember) {
                            return interaction.editReply({ content: '❌ User not found in the server!' });
                        }
                        const kickReason = Utils.sanitizeInput(interaction.options.getString('reason') || 'No reason provided');
                        await kickMember.kick(kickReason);
                        await interaction.editReply({
                            content: `✅ Kicked ${kickUser.tag}. Reason: ${kickReason}`,
                        });
                        try {
                            await kickUser.send(`🚪 You were kicked from ${interaction.guild.name}. Reason: ${kickReason}`);
                        } catch (e) {
                            logger.warn(`Failed to DM kick notification to ${kickUser.tag}:`, e);
                        }
                        guildData.stats.actionsToday++;
                        guildData.stats.actionsTotal++;
                        guildData.stats.topViolations.kick = (guildData.stats.topViolations.kick || 0) + 1;
                        await db.saveGuildData(interaction.guild.id, guildData);
                        break;
                    case 'ban':
                        if (!Utils.hasPermission(interaction.member, PermissionFlagsBits.BanMembers)) {
                            return interaction.editReply({
                                content: '🚫 You need Ban Members permission to use this command.',
                            });
                        }
                        if (!Utils.hasPermission(interaction.guild.members.me, PermissionFlagsBits.BanMembers)) {
                            return interaction.editReply({
                                content: '❌ Bot lacks Ban Members permission!',
                            });
                        }
                        const banUser = interaction.options.getUser('user');
                        const banReason = Utils.sanitizeInput(interaction.options.getString('reason') || 'No reason provided');
                        const deleteDays = interaction.options.getInteger('delete_days') || 0;
                        await interaction.guild.bans.create(banUser.id, { reason: banReason, deleteMessageDays: deleteDays });
                        await interaction.editReply({
                            content: `✅ Banned ${banUser.tag}. Reason: ${banReason}`,
                        });
                        try {
                            await banUser.send(`🔨 You were banned from ${interaction.guild.name}. Reason: ${banReason}`);
                        } catch (e) {
                            logger.warn(`Failed to DM ban notification to ${banUser.tag}:`, e);
                        }
                        guildData.stats.actionsToday++;
                        guildData.stats.actionsTotal++;
                        guildData.stats.topViolations.ban = (guildData.stats.topViolations.ban || 0) + 1;
                        await db.saveGuildData(interaction.guild.id, guildData);
                        break;
                    case 'unban':
                        if (!Utils.hasPermission(interaction.member, PermissionFlagsBits.BanMembers)) {
                            return interaction.editReply({
                                content: '🚫 You need Ban Members permission to use this command.',
                            });
                        }
                        if (!Utils.hasPermission(interaction.guild.members.me, PermissionFlagsBits.BanMembers)) {
                            return interaction.editReply({
                                content: '❌ Bot lacks Ban Members permission!',
                            });
                        }
                        const unbanUserId = interaction.options.getString('user_id');
                        if (!Utils.isValidUserId(unbanUserId)) {
                            return interaction.editReply({ content: '❌ Invalid user ID!' });
                        }
                        const unbanReason = Utils.sanitizeInput(interaction.options.getString('reason') || 'No reason provided');
                        const banEntry = await interaction.guild.bans.fetch(unbanUserId).catch(() => null);
                        if (!banEntry) {
                            return interaction.editReply({ content: `❌ User <@${unbanUserId}> is not banned!` });
                        }
                        await interaction.guild.bans.remove(unbanUserId, unbanReason);
                        await interaction.editReply({
                            content: `✅ Unbanned <@${unbanUserId}>. Reason: ${unbanReason}`,
                        });
                        guildData.stats.actionsToday++;
                        guildData.stats.actionsTotal++;
                        await db.saveGuildData(interaction.guild.id, guildData);
                        break;
                    case 'slowmode':
                        if (!Utils.hasPermission(interaction.member, PermissionFlagsBits.ManageChannels)) {
                            return interaction.editReply({
                                content: '🚫 You need Manage Channels permission to use this command.',
                            });
                        }
                        if (!Utils.hasPermission(interaction.guild.members.me, PermissionFlagsBits.ManageChannels)) {
                            return interaction.editReply({
                                content: '❌ Bot lacks Manage Channels permission!',
                            });
                        }
                        const seconds = interaction.options.getInteger('seconds');
                        const slowmodeChannel = interaction.options.getChannel('channel') || interaction.channel;
                        if (slowmodeChannel.type !== ChannelType.GuildText) {
                            return interaction.editReply({ content: '❌ Slowmode can only be applied to text channels!' });
                        }
                        await slowmodeChannel.setRateLimitPerUser(seconds, 'Slowmode set by moderator');
                        await interaction.editReply({
                            content: `✅ Set slowmode to ${seconds} seconds in ${slowmodeChannel}.`,
                        });
                        guildData.stats.actionsToday++;
                        guildData.stats.actionsTotal++;
                        await db.saveGuildData(interaction.guild.id, guildData);
                        break;
                    case 'lockdown':
                        if (!Utils.hasPermission(interaction.member, PermissionFlagsBits.ManageChannels)) {
                            return interaction.editReply({
                                content: '🚫 You need Manage Channels permission to use this command.',
                            });
                        }
                        if (!Utils.hasPermission(interaction.guild.members.me, PermissionFlagsBits.ManageChannels)) {
                            return interaction.editReply({
                                content: '❌ Bot lacks Manage Channels permission!',
                            });
                        }
                        const action = interaction.options.getString('action');
                        const targetChannel = interaction.options.getChannel('channel') || interaction.channel;
                        let response = '';
                        let lockedCount = 0;
                        let failedCount = 0;
                        if (action === 'lock' || action === 'unlock') {
                            if (targetChannel.type !== ChannelType.GuildText) {
                                return interaction.editReply({ content: '❌ Lockdown can only be applied to text channels!' });
                            }
                            try {
                                await targetChannel.permissionOverwrites.edit(interaction.guild.id, {
                                    SendMessages: action === 'lock' ? false : null,
                                });
                                response = `✅ ${action === 'lock' ? 'Locked' : 'Unlocked'} ${targetChannel}.`;
                                lockedCount = 1;
                            } catch (error) {
                                logger.error(`Failed to ${action} channel ${targetChannel.name}:`, error);
                                failedCount = 1;
                                response = `❌ Failed to ${action} ${targetChannel}.`;
                            }
                        } else if (action === 'lockall' || action === 'unlockall') {
                            const channels = interaction.guild.channels.cache.filter((ch) => ch.type === ChannelType.GuildText && ch.name !== 'admin-control');
                            for (const [, channel] of channels) {
                                try {
                                    await channel.permissionOverwrites.edit(interaction.guild.id, {
                                        SendMessages: action === 'lockall' ? false : null,
                                    });
                                    lockedCount++;
                                    await Utils.delay(100); // Prevent rate limiting
                                } catch (error) {
                                    logger.error(`Failed to ${action} channel ${channel.name}:`, error);
                                    failedCount++;
                                }
                            }
                            guildData.serverLocked = action === 'lockall';
                            response = `✅ ${action === 'lockall' ? 'Locked' : 'Unlocked'} ${lockedCount} channels.${failedCount > 0 ? ` Failed: ${failedCount} channels.` : ''}`;
                        }
                        guildData.stats.actionsToday++;
                        guildData.stats.actionsTotal++;
                        await db.saveGuildData(interaction.guild.id, guildData);
                        await AdminControlChannel.updateDashboard(
                            interaction.guild.channels.cache.find((ch) => AdminControlChannel.isAdminControlChannel(ch)),
                            guildData,
                            guildData.stats,
                        );
                        await interaction.editReply({ content: response });
                        break;
                    case 'stats':
                        if (!Utils.hasPermission(interaction.member, PermissionFlagsBits.ModerateMembers)) {
                            return interaction.editReply({
                                content: '🚫 You need Moderate Members permission to use this command.',
                            });
                        }
                        const topViolations = Object.entries(guildData.stats.topViolations || {})
                            .sort(([, a], [, b]) => b - a)
                            .slice(0, 5)
                            .map(([type, count]) => `• ${type}: ${count}`)
                            .join('\n') || 'None';
                        const weeklyAvg =
                            guildData.stats.weeklyHistory?.length > 0
                                ? Math.round(guildData.stats.weeklyHistory.reduce((a, b) => a + b, 0) / guildData.stats.weeklyHistory.length)
                                : 0;
                        const statsEmbed = new EmbedBuilder()
                            .setTitle('📊 Server Moderation Statistics')
                            .addFields(
                                { name: '⚡ Actions Today', value: (guildData.stats.actionsToday || 0).toString(), inline: true },
                                { name: '📈 Actions This Week', value: (guildData.stats.actionsWeek || 0).toString(), inline: true },
                                { name: '📊 Weekly Average', value: weeklyAvg.toString(), inline: true },
                                { name: '🎫 Tickets Created', value: (guildData.stats.ticketsCreated || 0).toString(), inline: true },
                                { name: '✅ Tickets Closed', value: (guildData.stats.ticketsClosed || 0).toString(), inline: true },
                                { name: '📈 Total Actions', value: (guildData.stats.actionsTotal || 0).toString(), inline: true },
                                { name: '🏆 Top Violations', value: topViolations, inline: false },
                            )
                            .setColor('#4CAF50')
                            .setTimestamp()
                            .setFooter({ text: `Stats since: ${new Date(guildData.stats.lastReset).toLocaleDateString()}` });
                        await interaction.editReply({ embeds: [statsEmbed] });
                        break;
                    case 'userinfo':
                        const infoUser = interaction.options.getUser('user') || interaction.user;
                        const infoMember = await interaction.guild.members.fetch(infoUser.id).catch(() => null);
                        const userInfoEmbed = new EmbedBuilder()
                            .setTitle(`👤 User Information: ${infoUser.tag}`)
                            .setThumbnail(infoUser.displayAvatarURL())
                            .addFields(
                                { name: '🆔 User ID', value: infoUser.id, inline: true },
                                { name: '📅 Joined Discord', value: new Date(infoUser.createdTimestamp).toLocaleDateString(), inline: true },
                                {
                                    name: '📅 Joined Server',
                                    value: infoMember ? new Date(infoMember.joinedTimestamp).toLocaleDateString() : 'Not in server',
                                    inline: true,
                                },
                                {
                                    name: '🎭 Roles',
                                    value: infoMember ? infoMember.roles.cache.map((r) => r.name).join(', ') || 'None' : 'N/A',
                                    inline: false,
                                },
                                {
                                    name: '⚠️ Warnings',
                                    value: guildData.warnings[infoUser.id] ? guildData.warnings[infoUser.id].length.toString() : '0',
                                    inline: true,
                                },
                                {
                                    name: '🔇 Muted',
                                    value: infoMember && infoMember.isCommunicationDisabled() ? 'Yes' : 'No',
                                    inline: true,
                                },
                            )
                            .setColor('#4CAF50')
                            .setTimestamp();
                        await interaction.editReply({ embeds: [userInfoEmbed] });
                        break;
                    case 'export':
                        if (!Utils.hasPermission(interaction.member, PermissionFlagsBits.Administrator)) {
                            return interaction.editReply({
                                content: '🚫 You need Administrator permissions to use this command.',
                            });
                        }
                        const exportType = interaction.options.getString('type');
                        const exportPath = `./exports/export_${interaction.guild.id}_${Date.now()}.json`;
                        let exportData;
                        switch (exportType) {
                            case 'warnings':
                                exportData = { warnings: guildData.warnings };
                                break;
                            case 'stats':
                                exportData = { stats: guildData.stats };
                                break;
                            case 'config':
                                exportData = {
                                    automod: guildData.automod,
                                    tickets: guildData.tickets,
                                    logging: guildData.logging,
                                    channelRestrictions: guildData.channelRestrictions,
                                    serverLocked: guildData.serverLocked,
                                };
                                break;
                            case 'all':
                                exportData = guildData;
                                break;
                            default:
                                return interaction.editReply({ content: '❌ Invalid export type!' });
                        }
                        await fs.writeFile(exportPath, JSON.stringify(exportData, null, 2));
                        await interaction.editReply({
                            content: `✅ Data exported to server storage. Contact the bot developer to retrieve \`${exportPath}\`.`,
                        });
                        guildData.stats.actionsToday++;
                        guildData.stats.actionsTotal++;
                        await db.saveGuildData(interaction.guild.id, guildData);
                        break;
                    default:
                        await interaction.editReply({ content: '❌ Unknown command!' });
                        break;
                }
            }
        } catch (error) {
            logger.error(`Error handling interaction ${interaction.id}:`, error);
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: '❌ An error occurred while processing your request.', ephemeral: true }).catch((e) => logger.error('Failed to send error reply:', e));
            } else {
                await interaction.editReply({ content: '❌ An error occurred while processing your request.' }).catch((e) => logger.error('Failed to send error edit reply:', e));
            }
        }
    });

    // Periodic Stats Reset
    setInterval(async () => {
        try {
            const now = Date.now();
            const week = 7 * 24 * 60 * 60 * 1000;
            client.guilds.cache.forEach(async (guild) => {
                try {
                    const guildData = await db.getGuildData(guild.id);
                    if (now - guildData.stats.lastReset >= week) {
                        guildData.stats.weeklyHistory = guildData.stats.weeklyHistory || [];
                        guildData.stats.weeklyHistory.push(guildData.stats.actionsWeek || 0);
                        if (guildData.stats.weeklyHistory.length > 4) {
                            guildData.stats.weeklyHistory.shift();
                        }
                        guildData.stats.actionsToday = 0;
                        guildData.stats.actionsWeek = 0;
                        guildData.stats.lastReset = now;
                        await db.saveGuildData(guild.id, guildData);
                        logger.info(`Reset weekly stats for guild: ${guild.name}`);
                    }
                    if (guildData.automod.antiRaid.panicMode && now - guildData.automod.antiRaid.panicModeActivated > 2 * 60 * 60 * 1000) {
                        guildData.automod.antiRaid.panicMode = false;
                        guildData.automod.antiRaid.panicModeActivated = 0;
                        await db.saveGuildData(guild.id, guildData);
                        const adminChannel = guild.channels.cache.find((ch) => AdminControlChannel.isAdminControlChannel(ch));
                        if (adminChannel) {
                            await adminChannel.send('🟢 Panic mode deactivated. Server security level returned to normal.');
                            await AdminControlChannel.updateDashboard(adminChannel, guildData, guildData.stats);
                        }
                    }
                } catch (error) {
                    logger.error(`Error in stats reset for guild ${guild.name}:`, error);
                }
            });
        } catch (error) {
            logger.error('Error in stats reset interval:', error);
        }
    }, 3600000); // Every hour

    // Error Handling for Uncaught Exceptions
    process.on('unhandledRejection', (error) => {
        logger.error('Unhandled promise rejection:', error);
    });

    process.on('uncaughtException', (error) => {
        logger.error('Uncaught exception:', error);
    });

    // Bot Login
    client.login(process.env.BOT_TOKEN).catch((error) => {
        logger.error('❌ Failed to login:', error);
        process.exit(1);
    });
