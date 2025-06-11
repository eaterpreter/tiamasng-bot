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
  const lock = new Promise(resolve => {
    userFileLock.set(userId, resolve);
  });
  try {
    const users = JSON.parse(fs.readFileSync(userFile, 'utf8'));
    await updateFn(users);
    fs.writeFileSync(userFile, JSON.stringify(users, null, 2));
  } finally {
    userFileLock.delete(userId);
    lock();
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
      const audioFile = audioFiles.first();
      const tempPath = `./temp_${Date.now()}_${audioFile.name}`;
      
      // Download the file
      const response = await fetch(audioFile.url);
      const buffer = await response.buffer();
      fs.writeFileSync(tempPath, buffer);
      
      // Check duration
      const duration = await getAudioDuration(tempPath);
      
      // Clean up temp file
      fs.unlinkSync(tempPath);
      
      if (duration >= 10) {
        const result = await addPointWithStreak(message.author.id);
        const embed = new EmbedBuilder()
          .setTitle('✅ 打卡成功！')
          .setDescription(
            `🪙 獲得 ${result.points} 點\n` +
            `連續 ${result.streakDay} 天${result.bonusGiven > 0 ? `\n🎉 額外獎勵 ${result.bonusGiven} 點！` : ''}\n` +
            `音檔長度：${Math.round(duration)}秒`
          )
          .setFooter({ text: '點仔算 Tiamasng' });

        await message.reply({ embeds: [embed] });
      } else {
        await message.reply('❌ 音檔長度需要超過 10 秒才能獲得點數');
      }
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
          ephemeral: false,
          content:
`【Tiamasng 點仔算使用說明】
本 bot 支援「打卡累積金幣」、「學習記錄」和「自動複習提醒」等多功能！

🔹 **常用 Slash 指令：**
/newsub 科目名稱    ➜ 新增一個新科目
/study  科目名稱 內容（每行「原文｜翻譯」）  ➜ 新增學習內容
/review 科目名稱     ➜ 主動複習指定科目
/stats              ➜ 顯示所有科目統計

🔹 **自動提醒**：每日 09:00、21:00 主動提醒複習。
🔹 **音檔打卡**：傳 mp3/wav/m4a/ogg/flac 檔自動累積金幣與連續天數！

🔹 **任何問題請 tag 管理員或 /help**

—— Powered by Tiamasng 點仔算`
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
        
        for (const line of content.split('\n')) {
          // Split by any separator except commas, and trim each part
          let [original, translation = ''] = line.split(/[|｜:：\t、/~]/).map(x => x.trim());
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
          
          // Add 1 point for starting a review session (with streak)
          const result = await addPointWithStreak(user.id);
          await interaction.followUp({
            embeds: [new EmbedBuilder()
              .setTitle('🎯 開始複習！')
              .setDescription(
                `🪙 獲得 ${result.points} 點\n` +
                `連續 ${result.streakDay} 天${result.bonusGiven > 0 ? `\n🎉 額外獎勵 ${result.bonusGiven} 點！` : ''}`
              )
              .setFooter({ text: '點仔算 Tiamasng' })]
          });
          
          let batchIdx = 0;
          function reviewBatch() {
            if (batchIdx >= batches.length) {
              return interaction.followUp({
                embeds: [new EmbedBuilder()
                  .setTitle(`✨ 複習結束！`)
                  .setDescription(`全部內容都已複習完畢。`)
                  .setFooter({ text: '點仔算 Tiamasng' })],
                components: [new ActionRowBuilder().addComponents(
                  new ButtonBuilder().setCustomId('review_done').setLabel('結束').setStyle(ButtonStyle.Primary)
                )],
                ephemeral: false
              });
            }
            const batch = batches[batchIdx];
            if (!batch || !batch.sentences.length) {
              batchIdx++;
              return reviewBatch();
            }
            sendReviewQuestion(interaction, user.id, sub, 0, batch, batches.length, () => {
              batchIdx++;
              reviewBatch();
            });
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
            return interaction.reply({ content: '❌ 獲取統計資料時發生錯誤', ephemeral: true });
          }

          if (!stats || Object.keys(stats).length === 0) {
            return interaction.reply({ content: '❌ 您還沒有任何學習記錄', ephemeral: true });
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

          interaction.reply({ embeds: [embed], ephemeral: false });
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
        if (interaction.user.id !== userId) return interaction.reply({ content: '這不是你的複習！', ephemeral: true });
        
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
          
          try {
            if (isDelete) {
              await new Promise((resolve, reject) => {
                hoksip.deleteSentence(row.id, (err) => {
                  if (err) reject(err);
                  else resolve();
                });
              });
              await interaction.reply('🗑️ 已刪除此句');
            } else {
              await new Promise((resolve, reject) => {
                hoksip.handleReviewResult(row.id, isCorrect, false, (err) => {  // false for active review
                  if (err) reject(err);
                  else resolve();
                });
              });
            }

            if (idx + 1 < batch.sentences.length) {
              await sendReviewQuestion(interaction, userId, sub, idx + 1, batch, batches.length, null, true);
            } else {
              if (typeof interaction._batchFinishCallback === 'function') {
                return interaction._batchFinishCallback();
              }
              await interaction.reply({
                embeds: [new EmbedBuilder()
                  .setTitle(`✨ 複習結束！`)
                  .setDescription(`本批（${date}）已複習完畢。`)
                  .setFooter({ text: '點仔算 Tiamasng' })],
                components: [new ActionRowBuilder().addComponents(
                  new ButtonBuilder().setCustomId('review_done').setLabel('結束').setStyle(ButtonStyle.Primary)
                )]
              });
            }
          } catch (err) {
            console.error('Error handling review result:', err);
            await interaction.reply('❌ 處理複習結果時發生錯誤');
          }
        });
      }
      // 結束按鈕
      else if (interaction.customId === 'review_done') {
        await interaction.reply({ content: '複習已結束，請繼續加油！', embeds: [], components: [] });
      }
      return;
    }
  } catch (error) {
    console.error('Error in interaction:', error);
    await interaction.reply({ 
      content: '❌ 執行指令時發生錯誤，請稍後再試',
      ephemeral: true 
    }).catch(console.error);
  }
});

// ===== 輸出複習題卡 =====
async function sendReviewQuestion(interaction, userId, sub, idx, batch, totalBatches, batchFinishCallback, useReplyInsteadOfFollowup) {
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

  if (useReplyInsteadOfFollowup && interaction.replied === false) {
    await interaction.reply({ embeds: [embed], components: [rowBtn], ephemeral: false });
  } else {
    await interaction.update({ embeds: [embed], components: [rowBtn], ephemeral: false });
  }
  if (batchFinishCallback) interaction._batchFinishCallback = batchFinishCallback;
}

// Add automatic review reminders
function scheduleReviewReminders() {
  const now = new Date();
  const morning = new Date(now);
  morning.setHours(9, 0, 0, 0);
  const evening = new Date(now);
  evening.setHours(21, 0, 0, 0);

  // Schedule morning reminder
  if (now < morning) {
    setTimeout(() => sendReviewReminders(), morning - now);
  }

  // Schedule evening reminder
  if (now < evening) {
    setTimeout(() => sendReviewReminders(), evening - now);
  }

  // Schedule next day's reminders
  const nextDay = new Date(now);
  nextDay.setDate(nextDay.getDate() + 1);
  nextDay.setHours(9, 0, 0, 0);
  setTimeout(() => {
    scheduleReviewReminders();
  }, nextDay - now);
}

// Passive review reminder (without streak)
async function sendReviewReminders() {
  const today = new Date().toISOString().split('T')[0];
  const users = JSON.parse(fs.readFileSync(userFile, 'utf8'));

  for (const [userId, userData] of Object.entries(users)) {
    try {
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
          `🪙 獲得 ${result.points} 點\n\n` +
          `今天要複習的有：\n${Object.entries(stats)
            .map(([sub, data]) => `${sub}：${data.not_familiar + data.vague + data.mastered}條`)
            .join('\n')}`
        )
        .setFooter({ text: '點仔算 Tiamasng' });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('start_review')
          .setLabel('開始複習')
          .setStyle(ButtonStyle.Primary)
      );

      const user = await client.users.fetch(userId);
      await user.send({ embeds: [embed], components: [row] });
    } catch (err) {
      console.error(`Error sending reminder to user ${userId}:`, err);
    }
  }
}

// Start scheduling reminders when the bot is ready
client.once('ready', () => {
  console.log(`🤖 ${client.user.tag} 已上線！`);
  scheduleReviewReminders();
});

client.login(process.env.TOKEN);
