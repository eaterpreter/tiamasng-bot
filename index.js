// index.js (無 TTS 純文字版 + slash + autocomplete + 排行榜 + 被動提醒)
const sub2lang = {
  // ...省略語言表...
  '日語': 'ja', '日文': 'ja', 'japanese': 'ja', 'ja': 'ja', '日本語': 'ja',
  '德語': 'de', '德文': 'de', 'german': 'de', 'de': 'de',
  '英文': 'en', '英語': 'en', 'english': 'en', 'en': 'en',
  '俄語': 'ru', '俄文': 'ru', 'russian': 'ru', 'ru': 'ru',
  '法語': 'fr', '法文': 'fr', 'french': 'fr', 'fr': 'fr',
  '西班牙語': 'es', '西班牙文': 'es', 'spanish': 'es', 'es': 'es',
  '韓語': 'ko', '韓文': 'ko', 'korean': 'ko', 'ko': 'ko',
};

const hoksip = require('./hoksip.js');
const { activeReviews, activeTests, raceSessions } = hoksip;
const khochhi = require('./khochhi.js');
const kong = require('./kong');
const { Client, GatewayIntentBits, Partials, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const fs = require('fs');
require('dotenv').config();
const { createAudioResource, demuxProbe } = require('@discordjs/voice');
const { createReadStream } = require('fs');
const { promisify } = require('util');
const { exec } = require('child_process');
const execAsync = promisify(exec);
const { addPointWithStreak, getTodayDate } = require('./utils');

// 輸入驗證
function validateSubject(sub) {
  if (!sub || typeof sub !== 'string') return false;
  if (sub.length > 50) return false;
  return true;
}

function validateContent(content) {
  if (!content || typeof content !== 'string') return false;
  if (content.length > 2000) return false; // Discord message limit
  return true;
}

// 標準化句子顯示
function displaySentence(row) {
  if (row.translation && row.translation.trim() && row.translation !== row.original) {
    return `${row.original}｜${row.translation}`;
  }
  return `${row.original}\n${row.translation || ''}`;
}

// 用戶資料同步
const userFileLock = new Map();

console.log("🔑 目前讀到的 TOKEN：", process.env.TOKEN);
console.log("✅ 準備連接 Discord...");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel, Partials.Message, Partials.User, Partials.GuildMember]
});

const userFile = './users.json';
let users = {};
if (fs.existsSync(userFile)) {
  users = JSON.parse(fs.readFileSync(userFile, 'utf8'));
}
const today = new Date().toISOString().split('T')[0];
for (const userId in users) {
  if (users[userId].reviewBonusGiven === undefined) users[userId].reviewBonusGiven = false;
  if (users[userId].lastCheckInDate !== today) users[userId].todayBonusGiven = false;
}
fs.writeFileSync(userFile, JSON.stringify(users, null, 2));

// Add point without streak (for interval-triggered tests)
async function addPoint(userId, actionType) {
  return updateUserData(userId, async (users) => {
    if (!users[userId]) {
      users[userId] = {
        points: 0, 
        streakDay: 0, 
        lastCheckInDate: '', 
        todayBonusGiven: false, 
        reviewBonusGiven: false, 
        history: [],
        lastActionTime: {},
        cooldowns: {
          test: 300000    // 5 minutes for interval tests
        }
      };
    }
    const user = users[userId];
    
    // Check cooldown
    const now = Date.now();
    const lastActionTime = user.lastActionTime[actionType] || 0;
    const cooldown = user.cooldowns[actionType] || 300000;
    
    if (now - lastActionTime < cooldown) {
      throw new Error('Action on cooldown');
    }
    
    // Update points and history
    user.points += 1;
    user.lastActionTime[actionType] = now;
    user.history.push({ 
      timestamp: new Date().toISOString(), 
      delta: 1,
      action: actionType
    });
    
    return { points: user.points, streakDay: user.streakDay, bonusGiven: 0 };
  });
}

// Handle messages
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  await kong.handleAudioMessage(message);
});

// ===== Slash指令、autocomplete、按鈕互動 =====
client.on('interactionCreate', async (interaction) => {
    if (interaction.isAutocomplete()) {
    await hoksip.handleAutocomplete(interaction);
      return;
    }

  if (!interaction.isCommand()) return;

  const { commandName } = interaction;

  switch (commandName) {
    case 'newsub':
    case 'study':
    case 'review':
    case 'race':
    case 'join':
    case 'start':
      await hoksip.handleCommand(interaction);
      break;
    case 'test':
      await khochhi.handleCommand(interaction);
      break;
    default:
      await interaction.reply('Unknown command.');
  }
});

// Add button interaction handler
client.on('interactionCreate', async interaction => {
    if (interaction.isButton()) {
    await hoksip.handleButtonInteraction(interaction);
  }
});

// ===== 輸出複習題卡 =====

// Update reminder scheduling
function scheduleReviewReminders() {
  // Get current time in GMT+8
  const now = new Date();
  const gmt8Offset = 8 * 60; // GMT+8 in minutes
  const localOffset = now.getTimezoneOffset();
  const nowGMT8 = new Date(now.getTime() + (gmt8Offset + localOffset) * 60000);
  
  // Create target times in GMT+8 (9 AM and 9 PM)
  const morning = new Date(nowGMT8);
  morning.setHours(9, 0, 0, 0);
  
  const evening = new Date(nowGMT8);
  evening.setHours(21, 0, 0, 0);

  // Determine next reminder time
  let nextReminder;
  if (nowGMT8 < morning) {
    nextReminder = morning;
  } else if (nowGMT8 < evening) {
    nextReminder = evening;
              } else {
    // If it's past evening, schedule for next morning
    nextReminder = new Date(nowGMT8);
    nextReminder.setDate(nextReminder.getDate() + 1);
    nextReminder.setHours(9, 0, 0, 0);
  }

  // Convert back to UTC for storage
  const nextReminderUTC = new Date(nextReminder.getTime() - (gmt8Offset + localOffset) * 60000);

  // Save next reminder time in UTC
  fs.writeFileSync('./next_reminder.json', JSON.stringify({
    nextReminder: nextReminderUTC.toISOString()
  }));

  // Schedule next reminder
  const timeUntilNext = nextReminder - nowGMT8;
  console.log('Current time (GMT+8):', nowGMT8.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  console.log('Next reminder scheduled for (GMT+8):', nextReminder.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  console.log('Time until next reminder:', Math.floor(timeUntilNext / 1000 / 60), 'minutes');
  
  // Clear any existing timeout
  if (global.reminderTimeout) {
    clearTimeout(global.reminderTimeout);
  }
  
  // Set new timeout
  global.reminderTimeout = setTimeout(() => {
    const currentTime = new Date(now.getTime() + (gmt8Offset + localOffset) * 60000);
    console.log('Sending reminders at (GMT+8):', currentTime.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    khochhi.sendTestReminders();
    khochhi.scheduleReviewReminders();
  }, timeUntilNext);
}

// Update the reminder loading on startup
client.once('ready', () => {
  console.log(`🤖 ${client.user.tag} 已上線！`);
  
  // Pass client to khochhi.js
  khochhi.setClient(client);
  
  try {
    if (fs.existsSync('./next_reminder.json')) {
      const { nextReminder } = JSON.parse(fs.readFileSync('./next_reminder.json', 'utf8'));
  const now = new Date();
      const gmt8Offset = 8 * 60; // GMT+8 in minutes
      const localOffset = now.getTimezoneOffset();
      
      // Convert current time to GMT+8
      const nowGMT8 = new Date(now.getTime() + (gmt8Offset + localOffset) * 60000);
      
      // Convert stored UTC time to GMT+8
      const next = new Date(nextReminder);
      const nextGMT8 = new Date(next.getTime() + (gmt8Offset + localOffset) * 60000);
      
      if (nextGMT8 > nowGMT8) {
        console.log('Loading existing reminder schedule for:', nextGMT8.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
        const timeUntilNext = nextGMT8.getTime() - nowGMT8.getTime();
        console.log('Time until next reminder:', Math.floor(timeUntilNext / 1000 / 60), 'minutes');
        
        // Clear any existing timeout
        if (global.reminderTimeout) {
          clearTimeout(global.reminderTimeout);
        }
        
        // Set new timeout
        global.reminderTimeout = setTimeout(() => {
          const currentTime = new Date(now.getTime() + (gmt8Offset + localOffset) * 60000);
          console.log('Sending reminders at (GMT+8):', currentTime.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
          khochhi.sendTestReminders();
          khochhi.scheduleReviewReminders();
        }, timeUntilNext);
        return;
      }
    }
  } catch (err) {
    console.error('Error loading reminder schedule:', err);
  }
  khochhi.scheduleReviewReminders();
});

// Add test question function
async function sendTestQuestion(interaction, userId, sub, idx, batch, totalBatches, batchFinishCallback, isButtonInteraction) {
  if (!batch || !batch.sentences || idx >= batch.sentences.length) {
    if (isButtonInteraction) {
      await interaction.update({ 
        content: '❌ 無效的測試內容',
        embeds: [],
        components: []
      });
    } else {
      await interaction.followUp({ content: '❌ 無效的測試內容' });
    }
    return;
  }
  const row = batch.sentences[idx];
  const progress = Math.round((idx / batch.sentences.length) * 100);
  const progressBar = `[${'='.repeat(Math.floor(progress/10))}${progress%10 === 0 ? '' : '>'}${' '.repeat(10-Math.ceil(progress/10))}] ${progress}%`;
  
  const embed = new EmbedBuilder()
    .setTitle(`【測試 ${sub}】${batch.date} (${idx + 1}/${batch.sentences.length})`)
    .setDescription(`### ${row.original}\n${row.translation || ''}\n\n${progressBar}`)
    .setFooter({ 
      text: `本批共 ${batch.sentences.length} 句，${totalBatches > 1 ? `還有 ${totalBatches-1} 批較舊內容` : '已是最舊批次'}`
    });

  const rowBtn = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`test_yes_${userId}_${sub}_${batch.date}_${idx}`)
      .setLabel('可 ✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`test_no_${userId}_${sub}_${batch.date}_${idx}`)
      .setLabel('不可 ❌').setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('test_done')
      .setLabel('結束').setStyle(ButtonStyle.Primary)
  );

  const forceEndRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`force_end_${userId}`)
      .setLabel('強制結束所有活動')
      .setStyle(ButtonStyle.Danger)
  );

  try {
    if (isButtonInteraction) {
      await interaction.update({ 
        embeds: [embed], 
        components: [rowBtn, forceEndRow] 
      });
    } else {
      await interaction.followUp({ 
        embeds: [embed], 
        components: [rowBtn, forceEndRow] 
      });
    }
    if (batchFinishCallback) interaction._batchFinishCallback = batchFinishCallback;
  } catch (err) {
    console.error('Error sending test question:', err);
    if (isButtonInteraction) {
      await interaction.update({ 
        content: '❌ 發送測試題目時發生錯誤',
        embeds: [],
        components: []
      });
    } else {
      await interaction.followUp({ content: '❌ 發送測試題目時發生錯誤' });
    }
  }
}

// Update session management functions
function isUserInSession(userId) {
  return activeReviews.has(userId) || activeTests.has(userId);
}

function getSessionInfo(userId) {
  if (activeReviews.has(userId)) {
    const review = activeReviews.get(userId);
    return `複習科目【${review.sub}】`;
  } else if (activeTests.has(userId)) {
    const test = activeTests.get(userId);
    return `測試科目【${test.sub}】`;
  }
  return '無效的複習或測試';
}

client.login(process.env.TOKEN);