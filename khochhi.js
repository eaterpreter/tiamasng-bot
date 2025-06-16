// ===== Interval Test Command Handlers =====
const fs = require('fs');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const hoksip = require('./hoksip.js');
const userFile = './users.json';

const INTERVAL_RULES = [1, 2, 3, 5, 7, 10]; // Days between reviews based on yesCount

// Add client reference
let client;

function setClient(discordClient) {
  client = discordClient;
}

// Handle interval test commands
async function handleCommand(interaction) {
  const { commandName, options, user } = interaction;

  // /test
  if (commandName === 'test') {
    const sub = options.getString('subject', true);
    if (!validateSubject(sub)) {
      return interaction.reply('❌ 科目名稱無效或太長');
    }

    // Clear any existing session first
    clearUserSession(interaction.user.id);

    await interaction.reply(`開始測試科目【${sub}】，請稍候...`);
    getDueSentences(user.id, sub, async (err, sentences) => {
      if (err) {
        console.error('Error getting due sentences:', err);
        return interaction.followUp('❌ 查詢失敗');
      }
      if (!sentences || sentences.length === 0) {
        return interaction.followUp('目前沒有任何內容可以測試！');
      }

      // Mark test as active
      activeTests.set(interaction.user.id, { sub, idx: 0 });

      // Send first question
      await sendTestQuestion(interaction, interaction.user.id, sub, 0, sentences);
    });
  }
}

// Add reminder system
async function sendTestReminders() {
  const today = new Date().toISOString().split('T')[0];
  const users = JSON.parse(fs.readFileSync(userFile, 'utf8'));

  for (const [userId, userData] of Object.entries(users)) {
    try {
      // Skip if user has disabled reminders
      if (userData.remindersDisabled) continue;

      // Get sentences that are due for review today (next_date == today)
      const dueSentences = await new Promise((resolve, reject) => {
        hoksip.getDueSentencesToday(userId, (err, sentences) => {
          if (err) reject(err);
          else resolve(sentences);
        });
      });

      // Skip if no due sentences
      if (!dueSentences || dueSentences.length === 0) continue;

      // Group sentences by subject and count them
      const subjectStats = dueSentences.reduce((acc, sentence) => {
        acc[sentence.sub] = (acc[sentence.sub] || 0) + 1;
        return acc;
      }, {});

      // Create reminder message
      const embed = new EmbedBuilder()
        .setTitle('📚 要測試了嗎？')
        .setDescription(
          `今天要測試的有：\n${Object.entries(subjectStats)
            .map(([sub, count]) => `• ${sub}: ${count} 句`)
            .join('\n')}\n\n` +
          `完成測試可獲得 🪙+1\n` +
          `如果今天沒有完成測試，明天會再次提醒`
        )
        .setFooter({ text: '點仔算 Tiamasng' });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`test_start_${userId}`)
          .setLabel('開始測試')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`disable_reminders_${userId}`)
          .setLabel('關閉提醒')
          .setStyle(ButtonStyle.Secondary)
      );

      // Send reminder to the review channel
      const channel = await client.channels.fetch(process.env.REVIEW_CHANNEL_ID);
      if (channel) {
        await channel.send({
          content: `<@${userId}>`,
          embeds: [embed],
          components: [row]
        });
      }
    } catch (err) {
      console.error('Error sending reminder:', err);
    }
  }
}

// Update reminder scheduling
function scheduleReviewReminders() {
  // Get current time in GMT+8
  const now = new Date();
  const gmt8Offset = 8 * 60; // GMT+8 in minutes
  const localOffset = now.getTimezoneOffset();
  
  // Convert current time to GMT+8
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

  // Convert next reminder time back to UTC for storage
  const nextReminderUTC = new Date(nextReminder.getTime() - (gmt8Offset + localOffset) * 60000);

  // Save next reminder time in UTC
  fs.writeFileSync('./next_reminder.json', JSON.stringify({
    nextReminder: nextReminderUTC.toISOString()
  }));

  // Calculate time until next reminder in milliseconds
  const timeUntilNext = nextReminder.getTime() - nowGMT8.getTime();
  
  // Log times in GMT+8
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
    sendTestReminders();
    scheduleReviewReminders();
  }, timeUntilNext);
}

// Export the command handler
module.exports = {
  handleCommand,
  sendTestReminders,
  scheduleReviewReminders,
  setClient
};
