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
const { Client, GatewayIntentBits, Partials, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const fs = require('fs');
require('dotenv').config();
const { createAudioResource, demuxProbe } = require('@discordjs/voice');
const { createReadStream } = require('fs');
const { promisify } = require('util');
const { exec } = require('child_process');
const execAsync = promisify(exec);

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
async function updateUserData(userId, updateFn) {
  if (userFileLock.has(userId)) {
    await userFileLock.get(userId);
  }
  let resolveLock;
  const lock = new Promise(resolve => {
    resolveLock = resolve;
  });
  userFileLock.set(userId, lock);
  
  try {
    const users = JSON.parse(fs.readFileSync(userFile, 'utf8'));
    const result = await updateFn(users);
    fs.writeFileSync(userFile, JSON.stringify(users, null, 2));
    return result;
  } finally {
    userFileLock.delete(userId);
    resolveLock();
  }
}

console.log("🔑 目前讀到的 TOKEN：", process.env.TOKEN);
console.log("✅ 準備連接 Discord...");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
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

// Add point without streak (for reviews)
async function addPoint(userId) {
  return updateUserData(userId, async (users) => {
    if (!users[userId]) {
      users[userId] = {
        points: 0, streakDay: 0, lastCheckInDate: '', todayBonusGiven: false, reviewBonusGiven: false, history: []
      };
    }
    const user = users[userId];
    user.points += 1;
    user.history.push({ timestamp: new Date().toISOString(), delta: 1 });
    return { points: user.points, streakDay: user.streakDay, bonusGiven: 0 };
  });
}

// 打卡
async function addPointWithStreak(userId) {
  return updateUserData(userId, async (users) => {
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    if (!users[userId]) {
      users[userId] = {
        points: 0, streakDay: 0, lastCheckInDate: '', todayBonusGiven: false, reviewBonusGiven: false, history: []
      };
    }
    const user = users[userId];
    let bonus = 0;
    user.points += 1;
    if (!user.todayBonusGiven || user.lastCheckInDate !== today) {
      const lastDate = user.lastCheckInDate;
      const diffDays = lastDate ? Math.floor((new Date(today) - new Date(lastDate)) / (1000 * 60 * 60 * 24)) : Infinity;
      user.streakDay = diffDays === 1 ? user.streakDay + 1 : 1;
      if (user.streakDay % 10 === 0) bonus += 3;
      if (user.streakDay % 5 === 0) bonus += 2;
      if (user.streakDay % 3 === 0) bonus += 1;
      user.points += bonus;
      user.todayBonusGiven = true;
      user.lastCheckInDate = today;
    }
    user.history.push({ timestamp: now.toISOString(), delta: 1 + bonus });
    return { points: user.points, streakDay: user.streakDay, bonusGiven: bonus };
  });
}

// Add audio duration check function
async function getAudioDuration(filePath) {
  try {
    const { stdout } = await execAsync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`);
    return parseFloat(stdout);
  } catch (err) {
    console.error('Error getting audio duration:', err);
    if (err.code === 1 && err.stderr.includes('ffprobe')) {
      throw new Error('FFmpeg is not installed. Please install FFmpeg to process audio files.');
    }
    return 0;
  }
}

// Update the messageCreate event handler
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  
  // Check for audio attachments
  const audioFiles = message.attachments.filter(attachment => {
    const ext = attachment.name.toLowerCase().split('.').pop();
    return ['mp3', 'wav', 'm4a', 'ogg', 'flac'].includes(ext);
  });

  if (audioFiles.size > 0) {
    try {
      const result = await addPointWithStreak(message.author.id);
      if (!result || !result.points) {
        await message.reply('❌ 處理音檔時發生錯誤');
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle('✅ 錄音成功！')
        .setDescription(
          `✅ 你好棒！今天也練口說了\n` +
          `<@${message.author.id}> 獲得 🪙+1\n` +
          `${result.bonusGiven > 0 ? `🎉 連續第 ${result.streakDay} 天打卡，加碼 🪙+${result.bonusGiven}\n` : ''}` +
          `目前總點數：🪙${result.points}\n` +
          `連續練習天數：${result.streakDay}天`
        )
        .setFooter({ text: '點仔算 Tiamasng' });

      await message.reply({ embeds: [embed] });
    } catch (err) {
      console.error('Error processing audio file:', err);
      await message.reply('❌ 處理音檔時發生錯誤');
    }
  }
});

// ===== Slash指令、autocomplete、按鈕互動 =====
client.on('interactionCreate', async interaction => {
  try {
    // autocomplete
    if (interaction.isAutocomplete()) {
      const focusedValue = interaction.options.getFocused();
      const userId = interaction.user.id;
      hoksip.getUserSubjects(userId, (err, subjects) => {
        if (err) {
          console.error('Error getting subjects:', err);
          return interaction.respond([]);
        }
        const filtered = subjects
          .filter(s => s && s.includes(focusedValue))
          .slice(0, 25)
          .map(s => ({ name: s, value: s }));
        interaction.respond(filtered);
      });
      return;
    }

    // Slash指令
    if (interaction.isChatInputCommand()) {
      const { commandName, options, user } = interaction;

      // /help
      if (commandName === 'help') {
        return interaction.reply({
          flags: [],
          content:
`【Tiamasng 點仔算使用說明】
本 bot 支援「打卡累積金幣」、「學習記錄」和「自動複習提醒」等多功能！

🔹 **常用 Slash 指令：**
/newsub 科目名稱    ➜ 新增一個新科目
/study  科目名稱 內容（每行「原文 (任何符號) 翻譯」）  ➜ 新增學習內容
/review 科目名稱     ➜ 主動複習指定科目
/stats              ➜ 顯示所有科目統計

🔹 **自動提醒**：每日 09:00、21:00 主動提醒複習。
• 完成複習可獲得 🪙+1
• 可以點擊提醒訊息中的「關閉提醒」按鈕來關閉提醒
• 關閉後可隨時使用此指令重新開啟

🔹 **音檔打卡**：上傳音檔即可打卡，獲得 🪙+1
• 支援 mp3、wav、m4a、ogg、flac 格式
• 連續打卡有額外獎勵：
  - 每 3 天：🪙+1
  - 每 5 天：🪙+2
  - 每 10 天：🪙+3`
        });
      }

      // /newsub
      if (commandName === 'newsub') {
        const sub = options.getString('subject', true);
        if (!validateSubject(sub)) {
          return interaction.reply('❌ 科目名稱無效或太長');
        }
        hoksip.checkSubExist(user.id, sub, (err, exist) => {
          if (err) {
            console.error('Error checking subject:', err);
            return interaction.reply('❌ 檢查科目時發生錯誤');
          }
          if (exist) return interaction.reply('❌ 已經有這個科目了，換個名稱吧');
          hoksip.addSentence(user.id, '[placeholder]', '', sub, '', (err) => {
            if (err) {
              console.error('Error adding subject:', err);
              return interaction.reply('❌ 新增科目時發生錯誤');
            }
            interaction.reply(`✅ 已新增科目「${sub}」！可用 /study ${sub} 新增內容`);
          });
        });
      }

      // /study
      else if (commandName === 'study') {
        const sub = options.getString('subject', true);
        const content = options.getString('content', true);
        
        if (!validateSubject(sub)) {
          return interaction.reply('❌ 科目名稱無效或太長');
        }
        if (!validateContent(content)) {
          return interaction.reply('❌ 內容無效或太長');
        }

        let added = 0;
        let errors = 0;
        
        // First try to split by explicit line breaks
        let lines = content.split(/\r?\n/);
        
        // If no explicit line breaks found, try to detect natural line breaks
        if (lines.length === 1) {
          // Look for patterns like "word (reading) translation" or "word translation"
          lines = content.match(/[^\n]+?(?=\s*[^\n]+?(?:\s|$))/g) || [content];
        }
        
        // Filter out empty lines and process each line
        lines = lines.filter(line => line.trim());
        
        for (const line of lines) {
          // Split by any separator except commas, and trim each part
          let [original, translation = ''] = line.split(/[|｜:：\t、/~]/).map(x => x.trim());
          
          // If no separator found, try to split by space
          if (!translation && original.includes(' ')) {
            [original, translation] = original.split(/\s+/).map(x => x.trim());
          }
          
          if (original) {
            try {
              await new Promise((resolve, reject) => {
                hoksip.addSentence(user.id, original, translation, sub, '', (err) => {
                  if (err) reject(err);
                  else resolve();
                });
              });
              added++;
            } catch (err) {
              console.error('Error adding sentence:', err);
              errors++;
            }
          }
        }
        
        await addPointWithStreak(user.id);
        interaction.reply(`✅ 已新增 ${added} 筆到科目「${sub}」${errors > 0 ? `（${errors} 筆失敗）` : ''}`);
      }

      // /review
      else if (commandName === 'review') {
        const sub = options.getString('subject', true);
        if (!validateSubject(sub)) {
          return interaction.reply('❌ 科目名稱無效或太長');
        }
        
        await interaction.reply(`開始複習科目【${sub}】，請稍候...`);
        hoksip.getSentencesByDateBatches(user.id, sub, async (err, batches) => {
          if (err) {
            console.error('Error getting batches:', err);
            return interaction.followUp('❌ 查詢失敗');
          }
          if (!batches.length) return interaction.followUp('目前沒有任何內容可以複習！');
          
          let batchIdx = 0;
          function reviewBatch() {
            if (batchIdx >= batches.length) {
              return interaction.followUp({
                embeds: [new EmbedBuilder()
                  .setTitle(`✨ 複習結束！`)
                  .setDescription(`科目【${sub}】本批已複習完畢！`)
                  .setFooter({ text: '點仔算 Tiamasng' })],
                components: [new ActionRowBuilder().addComponents(
                  new ButtonBuilder().setCustomId('review_done').setLabel('結束').setStyle(ButtonStyle.Primary)
                )]
              });
            }
            const batch = batches[batchIdx];
            if (!batch || !batch.sentences.length) {
              batchIdx++;
              return reviewBatch();
            }
            // For initial command, use followUp
            sendReviewQuestion(interaction, user.id, sub, 0, batch, batches.length, () => {
              batchIdx++;
              reviewBatch();
            }, false);
          }
          reviewBatch();
        });
      }

      // /stats
      else if (commandName === 'stats') {
        const userId = interaction.user.id;
        hoksip.getStats(userId, (err, stats) => {
          if (err) {
            console.error('Error getting stats:', err);
            return interaction.reply({ 
              content: '❌ 獲取統計資料時發生錯誤', 
              flags: [64]
            });
          }

          if (!stats || Object.keys(stats).length === 0) {
            return interaction.reply({ 
              content: '❌ 您還沒有任何學習記錄', 
              flags: [64]
            });
          }

          const embed = new EmbedBuilder()
            .setTitle('【學習統計】')
            .setDescription(
              Object.entries(stats)
                .map(([sub, data]) => {
                  const total = data.not_familiar + data.vague + data.mastered;
                  const progress = total > 0 ? Math.round((data.mastered / total) * 100) : 0;
                  return `${sub}：${total}條\n` +
                         `　　✅ 已掌握：${data.mastered}條\n` +
                         `　　❓ 模糊：${data.vague}條\n` +
                         `　　❌ 不熟悉：${data.not_familiar}條\n` +
                         `　　📊 掌握度：${progress}%`;
                })
                .join('\n\n')
            )
            .setFooter({ text: '點仔算 Tiamasng' });

          interaction.reply({ 
            embeds: [embed], 
            flags: [] 
          });
        });
        return;
      }
      return;
    }

    // 按鈕互動
    if (interaction.isButton()) {
      const id = interaction.customId;
      // Handle review buttons
      if (id.startsWith('review_yes_') || id.startsWith('review_no_') || id.startsWith('review_delete_')) {
        const [flag, , userId, sub, date, idxStr] = id.split('_');
        if (interaction.user.id !== userId) return interaction.reply({ 
          content: '這不是你的複習！', 
          flags: [64]
        });
        
        const isCorrect = id.startsWith('review_yes_');
        const isDelete = id.startsWith('review_delete_');
        const idx = Number(idxStr);

        hoksip.getSentencesByDateBatches(userId, sub, async (err, batches) => {
          if (err) {
            console.error('Error getting batches:', err);
            return interaction.reply('❌ 查詢失敗');
          }
          const batch = batches.find(b => b.date === date);
          if (!batch) return interaction.reply('❌ 查無該日期內容！');
          const row = batch.sentences[idx];
          if (!row) return interaction.reply('❌ 查無該句內容！');
          
          try {
            if (isDelete) {
              await new Promise((resolve, reject) => {
                hoksip.deleteSentence(row.id, (err) => {
                  if (err) reject(err);
                  else resolve();
                });
              });
              await interaction.update({ content: '🗑️ 已刪除此句', embeds: [], components: [] });
            } else {
              await new Promise((resolve, reject) => {
                hoksip.handleReviewResult(row.id, isCorrect, false, (err) => {  // false for active review
                  if (err) reject(err);
                  else resolve();
                });
              });
            }

            // Check if there are more sentences in this batch
            if (idx + 1 < batch.sentences.length) {
              await sendReviewQuestion(interaction, userId, sub, idx + 1, batch, batches.length, null, true);
            } else {
              // Check if there are more batches
              const currentBatchIndex = batches.findIndex(b => b.date === date);
              if (currentBatchIndex + 1 < batches.length) {
                // Move to next batch
                const nextBatch = batches[currentBatchIndex + 1];
                await sendReviewQuestion(interaction, userId, sub, 0, nextBatch, batches.length, null, true);
              } else {
                // All batches are done
                const finalEmbed = new EmbedBuilder()
                  .setTitle('✨ 複習結束！')
                  .setDescription(`科目【${sub}】本批（${batch.date}）已複習完畢！`)
                  .setFooter({ text: '點仔算 Tiamasng' });

                const finalRow = new ActionRowBuilder().addComponents(
                  new ButtonBuilder()
                    .setCustomId('review_done')
                    .setLabel('結束')
                    .setStyle(ButtonStyle.Primary)
                );

                await interaction.update({ embeds: [finalEmbed], components: [finalRow] });
              }
            }
          } catch (err) {
            console.error('Error handling review result:', err);
            await interaction.update({ content: '❌ 處理複習結果時發生錯誤', embeds: [], components: [] });
          }
        });
      }
      // 結束按鈕
      else if (interaction.customId === 'review_done') {
        try {
          // Add points only when user clicks the done button
          const result = await addPointWithStreak(interaction.user.id);
          if (!result || !result.points) {
            await interaction.update({ 
              content: '❌ 處理複習結果時發生錯誤', 
              embeds: [], 
              components: [] 
            });
            return;
          }
          
          // First update the current message to remove buttons
          await interaction.update({ 
            content: '複習已結束，請繼續加油！', 
            embeds: [], 
            components: [] 
          });

          // Then send a new message with point gain announcement
          await interaction.channel.send({
            content: `✅ 你好棒！今天也完成複習了\n` +
                    `<@${interaction.user.id}> 完成練習，獲得 🪙+1\n` +
                    `${result.bonusGiven > 0 ? `🎉 連續第 ${result.streakDay} 天打卡，加碼 🪙+${result.bonusGiven}\n` : ''}` +
                    `目前總點數：🪙${result.points}\n` +
                    `連續練習天數：${result.streakDay}天`
          });
        } catch (err) {
          console.error('Error in review_done:', err);
          try {
            await interaction.update({ 
              content: '❌ 處理複習結果時發生錯誤', 
              embeds: [], 
              components: [] 
            });
          } catch (updateErr) {
            console.error('Error updating message:', updateErr);
          }
        }
      }
      return;
    }
  } catch (error) {
    console.error('Error in interaction:', error);
    await interaction.reply({ 
      content: '❌ 執行指令時發生錯誤，請稍後再試',
      flags: [64]
    }).catch(console.error);
  }
});

// ===== 輸出複習題卡 =====
async function sendReviewQuestion(interaction, userId, sub, idx, batch, totalBatches, batchFinishCallback, isButtonInteraction) {
  const row = batch.sentences[idx];
  const progress = Math.round((idx / batch.sentences.length) * 100);
  const progressBar = `[${'='.repeat(Math.floor(progress/10))}${progress%10 === 0 ? '' : '>'}${' '.repeat(10-Math.ceil(progress/10))}] ${progress}%`;
  
  const embed = new EmbedBuilder()
    .setTitle(`【複習 ${sub}】${batch.date} (${idx + 1}/${batch.sentences.length})`)
    .setDescription(`${displaySentence(row)}\n\n${progressBar}`)
    .setFooter({ 
      text: `本批共 ${batch.sentences.length} 句，${totalBatches > 1 ? `還有 ${totalBatches-1} 批較舊內容` : '已是最舊批次'}`
    });

  const rowBtn = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`review_yes_${userId}_${sub}_${batch.date}_${idx}`)
      .setLabel('可 ✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`review_no_${userId}_${sub}_${batch.date}_${idx}`)
      .setLabel('不可 ❌').setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`review_delete_${userId}_${sub}_${batch.date}_${idx}`)
      .setLabel('刪掉 🗑️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('review_done')
      .setLabel('結束').setStyle(ButtonStyle.Primary)
  );

  try {
    if (isButtonInteraction) {
      await interaction.update({ embeds: [embed], components: [rowBtn] });
    } else {
      await interaction.followUp({ embeds: [embed], components: [rowBtn] });
    }
    if (batchFinishCallback) interaction._batchFinishCallback = batchFinishCallback;
  } catch (err) {
    console.error('Error sending review question:', err);
    await interaction.followUp({ content: '❌ 發送複習題目時發生錯誤' });
  }
}

// Add automatic review reminders
function scheduleReviewReminders() {
  const now = new Date();
  const morning = new Date(now);
  morning.setHours(9, 0, 0, 0);
  const evening = new Date(now);
  evening.setHours(21, 0, 0, 0);

  // Convert to local timezone
  const localMorning = new Date(morning.getTime() - (now.getTimezoneOffset() * 60000));
  const localEvening = new Date(evening.getTime() - (now.getTimezoneOffset() * 60000));

  // Schedule morning reminder
  if (now < localMorning) {
    setTimeout(() => sendReviewReminders(), localMorning - now);
  }

  // Schedule evening reminder
  if (now < localEvening) {
    setTimeout(() => sendReviewReminders(), localEvening - now);
  }

  // Schedule next day's reminders
  const nextDay = new Date(now);
  nextDay.setDate(nextDay.getDate() + 1);
  nextDay.setHours(9, 0, 0, 0);
  const localNextDay = new Date(nextDay.getTime() - (now.getTimezoneOffset() * 60000));
  setTimeout(() => {
    scheduleReviewReminders();
  }, localNextDay - now);
}

// Passive review reminder (without streak)
async function sendReviewReminders() {
  const today = new Date().toISOString().split('T')[0];
  const users = JSON.parse(fs.readFileSync(userFile, 'utf8'));

  for (const [userId, userData] of Object.entries(users)) {
    try {
      // Skip if user has disabled reminders
      if (userData.remindersDisabled) continue;

      const stats = await new Promise((resolve, reject) => {
        hoksip.getStats(userId, (err, stats) => {
          if (err) reject(err);
          else resolve(stats);
        });
      });

      if (!stats || Object.keys(stats).length === 0) continue;

      // Add point for passive review (no streak)
      const result = await addPoint(userId);

      const embed = new EmbedBuilder()
        .setTitle('📚 要複習了嗎？')
        .setDescription(
          `今天要複習的有：\n${Object.entries(stats)
            .map(([sub, count]) => `• ${sub}: ${count} 句`)
            .join('\n')}\n\n` +
          `完成複習可獲得 🪙+1\n` +
          `目前總點數：🪙${result.points}`
        )
        .setFooter({ text: '點仔算 Tiamasng' });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`review_reminder_${userId}`)
          .setLabel('開始複習')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`disable_reminders_${userId}`)
          .setLabel('關閉提醒')
          .setStyle(ButtonStyle.Secondary)
      );

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

// Add reminder preference handling
client.on('interactionCreate', async interaction => {
  if (interaction.isButton()) {
    const [action, userId] = interaction.customId.split('_');
    
    if (action === 'disable_reminders') {
      if (interaction.user.id !== userId) {
        return interaction.reply({ 
          content: '這不是你的提醒！', 
          flags: [64]
        });
      }

      const users = JSON.parse(fs.readFileSync(userFile, 'utf8'));
      if (!users[userId]) {
        users[userId] = { points: 0, streakDay: 0, lastCheckInDate: '', todayBonusGiven: false, reviewBonusGiven: false, history: [] };
      }
      users[userId].remindersDisabled = true;
      fs.writeFileSync(userFile, JSON.stringify(users, null, 2));

      await interaction.update({
        content: '已關閉提醒功能，你可以隨時使用 `/help` 重新開啟',
        embeds: [],
        components: []
      });
    }
  }
});

// Start scheduling reminders when the bot is ready
client.once('ready', () => {
  console.log(`🤖 ${client.user.tag} 已上線！`);
  scheduleReviewReminders();
});

client.login(process.env.TOKEN);
