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
  const LOCK_TIMEOUT = 30000; // 30 seconds timeout
  if (userFileLock.has(userId)) {
    try {
      await Promise.race([
        userFileLock.get(userId),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Lock timeout')), LOCK_TIMEOUT)
        )
      ]);
    } catch (err) {
      console.error('Lock timeout for user:', userId);
      userFileLock.delete(userId);
    }
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
  } catch (err) {
    console.error('Error updating user data:', err);
    throw err;
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

// Use consistent timezone
function getTodayDate() {
  const now = new Date();
  return new Date(now.getTime() - (now.getTimezoneOffset() * 60000))
    .toISOString()
    .split('T')[0];
}

// Update point system to use consistent timezone (for manual actions)
async function addPointWithStreak(userId, actionType) {
  return updateUserData(userId, async (users) => {
    const today = getTodayDate();
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
          review: 300000, // 5 minutes
          audio: 300000   // 5 minutes
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
    
    // Update action time and history
    user.lastActionTime[actionType] = now;
    user.history.push({ 
      timestamp: new Date().toISOString(), 
      delta: 1 + bonus,
      action: actionType
    });
    
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
      const result = await addPointWithStreak(message.author.id, 'audio');
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
      if (err.message === 'Action on cooldown') {
        await message.reply('❌ 請稍等片刻再上傳音檔');
      } else {
        await message.reply('❌ 處理音檔時發生錯誤');
      }
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
/review 科目名稱     ➜ 複習指定科目（從最少複習的開始）
/test   科目名稱     ➜ 測試指定科目（有 [可][不可] 按鈕）
/race   科目名稱     ➜ 開始多人競賽（20題，最快答對最多者獲勝）
/delsub 科目名稱     ➜ 刪除指定科目及其所有內容
/stats              ➜ 顯示所有科目統計

🔹 **自動提醒**：每日 09:00、21:00 主動提醒測試。
• 完成測試可獲得 🪙+1
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

        // Send initial reply first
        await interaction.reply('開始處理學習內容，請稍候...');

        let added = 0;
        let errors = 0;
        
        // Split content by newlines and semicolons, then process each line
        const lines = content
          .split(/[\n;]/)  // Split by both newlines and semicolons
          .map(line => line.trim())
          .filter(line => line.length > 0);  // Remove empty lines
        
        // Process in chunks of 20 lines to avoid Discord's message length limit
        const chunkSize = 20;
        for (let i = 0; i < lines.length; i += chunkSize) {
          const chunk = lines.slice(i, i + chunkSize);
          
          for (const line of chunk) {
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
          
          // Send progress update for each chunk
          if (i + chunkSize < lines.length) {
            await interaction.followUp(`✅ 已處理 ${i + chunk.length} 筆，繼續處理中...`);
          }
        }
        
        await addPointWithStreak(user.id, 'study');
        await interaction.followUp(`✅ 已新增 ${added} 筆到科目「${sub}」${errors > 0 ? `（${errors} 筆失敗）` : ''}`);
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
          
          // Sort batches by review count and date
          batches.sort((a, b) => {
            // First sort by review count (ascending)
            const aAvgReviewCount = a.sentences.reduce((sum, s) => sum + (s.review_count || 0), 0) / a.sentences.length;
            const bAvgReviewCount = b.sentences.reduce((sum, s) => sum + (s.review_count || 0), 0) / b.sentences.length;
            if (aAvgReviewCount !== bAvgReviewCount) {
              return aAvgReviewCount - bAvgReviewCount;
            }
            // Then sort by date (descending)
            return new Date(b.date) - new Date(a.date);
          });
          
          // Mark review as active
          activeReviews.set(user.id, { sub, date: batches[0].date, idx: 0 });
          
          let batchIdx = 0;
          function reviewBatch() {
            if (batchIdx >= batches.length) {
              activeReviews.delete(user.id);
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
                         `　　✅ 會了！：${data.mastered}條\n` +
                         `　　❓ 有印象：${data.vague}條\n` +
                         `　　❌ 不懂：${data.not_familiar}條\n` +
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

      // /delsub
      else if (commandName === 'delsub') {
        const sub = options.getString('subject', true);
        if (!validateSubject(sub)) {
          return interaction.reply('❌ 科目名稱無效或太長');
        }

        // Create confirmation buttons
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`confirm_delsub_${user.id}_${sub}`)
            .setLabel('確認刪除')
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId(`cancel_delsub_${user.id}_${sub}`)
            .setLabel('取消')
            .setStyle(ButtonStyle.Secondary)
        );

        await interaction.reply({
          content: `⚠️ 確定要刪除科目「${sub}」及其所有內容嗎？此操作無法復原！`,
          components: [row]
        });
      }

      // /race
      else if (commandName === 'race') {
        const sub = options.getString('subject', true);
        if (!validateSubject(sub)) {
          return interaction.reply('❌ 科目名稱無效或太長');
        }

        // Create a new race session
        const raceId = `${interaction.user.id}_${Date.now()}`;
        const raceSessions = new Map();
        raceSessions.set(raceId, {
          initiator: interaction.user.id,
          subject: sub,
          participants: new Map(),
          currentQuestion: 0,
          totalQuestions: 20,
          startTime: Date.now()
        });

        // Get random sentences for options
        hoksip.getRandomSentences(sub, 60, async (err, sentences) => {
          if (err) {
            console.error('Error getting random sentences:', err);
            return interaction.reply('❌ 獲取題目時發生錯誤');
          }
          if (!sentences || sentences.length < 3) {
            return interaction.reply('❌ 題目數量不足，無法開始競賽');
          }

          const session = raceSessions.get(raceId);
          session.questions = sentences.slice(0, 20).map(s => ({
            original: s.original,
            translation: s.translation,
            options: []
          }));

          // Generate options for each question
          for (let i = 0; i < session.questions.length; i++) {
            const question = session.questions[i];
            const correctOption = question.translation;
            const otherOptions = sentences
              .filter(s => s.translation !== correctOption)
              .map(s => s.translation)
              .sort(() => Math.random() - 0.5)
              .slice(0, 2);
            
            question.options = [correctOption, ...otherOptions].sort(() => Math.random() - 0.5);
          }

          // Send first question
          await sendRaceQuestion(interaction, raceId, 0);
        });
      }

      return;
    }

    // 按鈕互動
    if (interaction.isButton()) {
      const [action, type, ...params] = interaction.customId.split('_');
      
      // Check if user can interact with this button
      if (!canUserInteract(interaction)) {
        return interaction.reply({ 
          content: '❌ 請先完成當前的活動', 
          flags: [64]
        });
      }

      // Validate button IDs
      if (action.startsWith('review_') && !validateReviewButtonId(interaction.customId)) {
        return interaction.reply({ 
          content: '❌ 無效的複習按鈕', 
          flags: [64]
        });
      }

      if (action.startsWith('test_') && !validateTestButtonId(interaction.customId)) {
        return interaction.reply({ 
          content: '❌ 無效的測試按鈕', 
          flags: [64]
        });
      }

      if (action.startsWith('race_') && !validateRaceButtonId(interaction.customId)) {
        return interaction.reply({ 
          content: '❌ 無效的競賽按鈕', 
          flags: [64]
        });
      }

      if (action === 'review_seen' || action === 'review_delete') {
        if (!validateReviewButtonId(interaction.customId)) {
          return interaction.reply({ 
            content: '❌ 無效的複習按鈕', 
            flags: [64]
          });
        }

        if (interaction.user.id !== params[0]) {
          return interaction.reply({ 
            content: '這不是你的複習！', 
            flags: [64]
          });
        }

        // Check if user already has an active review
        if (activeReviews.has(interaction.user.id)) {
          return interaction.reply({ 
            content: '❌ 請先完成當前的複習', 
            flags: [64]
          });
        }

        // Mark review as active
        activeReviews.set(interaction.user.id, { sub: params[1], date: params[2], idx: Number(params[3]) });

        try {
          const batches = await Promise.race([
            new Promise((resolve, reject) => {
              hoksip.getSentencesByDateBatches(params[0], params[1], (err, batches) => {
                if (err) reject(err);
                else resolve(batches);
              });
            }),
            timeout(5000) // 5 second timeout
          ]);

          const batch = batches.find(b => b.date === params[2]);
          if (!batch) {
            activeReviews.delete(interaction.user.id);
            return interaction.reply('❌ 查無該日期內容！');
          }

          const row = batch.sentences[Number(params[3])];
          if (!row) {
            activeReviews.delete(interaction.user.id);
            return interaction.reply('❌ 查無該句內容！');
          }

          const isCorrect = action === 'review_seen';
          const isDelete = action === 'review_delete';

          try {
            if (isDelete) {
              await Promise.race([
                new Promise((resolve, reject) => {
                  hoksip.deleteSentence(row.id, (err) => {
                    if (err) reject(err);
                    else resolve();
                  });
                }),
                timeout(5000)
              ]);

              // Update the message to show deletion
              await interaction.update({ 
                content: '🗑️ 已刪除此句', 
                embeds: [], 
                components: [] 
              });

              // Check if there are more sentences in this batch
              if (Number(params[3]) + 1 < batch.sentences.length) {
                // Wait a moment before showing the next question
                setTimeout(async () => {
                  try {
                    await sendReviewQuestion(interaction, params[0], params[1], Number(params[3]) + 1, batch, batches.length, null, true);
                  } catch (err) {
                    console.error('Error sending next question:', err);
                    await interaction.channel.send('❌ 發送下一題時發生錯誤');
                  }
                }, 1000);
              } else {
                // Check if there are more batches
                const currentBatchIndex = batches.findIndex(b => b.date === params[2]);
                if (currentBatchIndex + 1 < batches.length) {
                  // Wait a moment before showing the next batch
                  setTimeout(async () => {
                    try {
                      const nextBatch = batches[currentBatchIndex + 1];
                      await sendReviewQuestion(interaction, params[0], params[1], 0, nextBatch, batches.length, null, true);
                    } catch (err) {
                      console.error('Error sending next batch:', err);
                      await interaction.channel.send('❌ 發送下一批時發生錯誤');
                    }
                  }, 1000);
                } else {
                  // All batches are done
                  setTimeout(async () => {
                    try {
                      const finalEmbed = new EmbedBuilder()
                        .setTitle('✨ 複習結束！')
                        .setDescription(`科目【${params[1]}】本批（${params[2]}）已複習完畢！`)
                        .setFooter({ text: '點仔算 Tiamasng' });

                      const finalRow = new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                          .setCustomId('review_done')
                          .setLabel('結束')
                          .setStyle(ButtonStyle.Primary)
                      );

                      await interaction.channel.send({ 
                        embeds: [finalEmbed], 
                        components: [finalRow] 
                      });
                    } catch (err) {
                      console.error('Error sending completion message:', err);
                      await interaction.channel.send('❌ 發送完成訊息時發生錯誤');
                    }
                  }, 1000);
                }
              }
            } else {
              await Promise.race([
                new Promise((resolve, reject) => {
                  hoksip.handleReviewResult(row.id, isCorrect, false, (err) => {
                    if (err) reject(err);
                    else resolve();
                  });
                }),
                timeout(5000)
              ]);

              // Check if there are more sentences in this batch
              if (Number(params[3]) + 1 < batch.sentences.length) {
                await sendReviewQuestion(interaction, params[0], params[1], Number(params[3]) + 1, batch, batches.length, null, true);
              } else {
                // Check if there are more batches
                const currentBatchIndex = batches.findIndex(b => b.date === params[2]);
                if (currentBatchIndex + 1 < batches.length) {
                  // Move to next batch
                  const nextBatch = batches[currentBatchIndex + 1];
                  await sendReviewQuestion(interaction, params[0], params[1], 0, nextBatch, batches.length, null, true);
                } else {
                  // All batches are done
                  const finalEmbed = new EmbedBuilder()
                    .setTitle('✨ 複習結束！')
                    .setDescription(`科目【${params[1]}】本批（${params[2]}）已複習完畢！`)
                    .setFooter({ text: '點仔算 Tiamasng' });

                  const finalRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                      .setCustomId('review_done')
                      .setLabel('結束')
                      .setStyle(ButtonStyle.Primary)
                  );

                  await interaction.update({ 
                    embeds: [finalEmbed], 
                    components: [finalRow] 
                  });
                }
              }
            }
          } catch (err) {
            console.error('Error handling review result:', err);
            await interaction.update({ 
              content: '❌ 處理複習結果時發生錯誤', 
              embeds: [], 
              components: [] 
            });
          } finally {
            // Clear active review state
            activeReviews.delete(interaction.user.id);
          }
        } catch (err) {
          console.error('Error in review process:', err);
          activeReviews.delete(interaction.user.id);
          await interaction.reply({ 
            content: '❌ 複習過程發生錯誤，請重試', 
            flags: [64]
          });
        }
      }
      // 結束按鈕
      else if (action === 'review_done') {
        try {
          // Add points only when user clicks the done button
          const result = await addPointWithStreak(interaction.user.id, 'review');
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
            if (err.message === 'Action on cooldown') {
              await interaction.update({ 
                content: '❌ 請稍等片刻再完成複習', 
                embeds: [], 
                components: [] 
              });
            } else {
              await interaction.update({ 
                content: '❌ 處理複習結果時發生錯誤', 
                embeds: [], 
                components: [] 
              });
            }
          } catch (updateErr) {
            console.error('Error updating message:', updateErr);
          } finally {
            // Clear active review state
            activeReviews.delete(interaction.user.id);
          }
        }
      }

      // Add button handler for delsub confirmation
      else if (action === 'confirm_delsub' && type === 'delsub') {
        if (interaction.user.id !== params[0]) {
          return interaction.reply({ 
            content: '這不是你的科目！', 
            flags: [64]
          });
        }

        try {
          await new Promise((resolve, reject) => {
            hoksip.deleteSubject(params[0], params[1], (err) => {
              if (err) reject(err);
              else resolve();
            });
          });

          await interaction.update({
            content: `✅ 已刪除科目「${params[1]}」及其所有內容`,
            components: []
          });
        } catch (err) {
          console.error('Error deleting subject:', err);
          await interaction.update({
            content: '❌ 刪除科目時發生錯誤',
            components: []
          });
        }
      } else if (action === 'cancel_delsub' && type === 'delsub') {
        if (interaction.user.id !== params[0]) {
          return interaction.reply({ 
            content: '這不是你的科目！', 
            flags: [64]
          });
        }

        await interaction.update({
          content: '已取消刪除操作',
          components: []
        });
      }

      // Add race button handlers
      else if (action === 'race_answer' || action === 'race_end') {
        const [raceId, questionIndex, optionIndex] = params;
        const session = raceSessions.get(raceId);
        if (!session) return;

        const question = session.questions[questionIndex];
        const isCorrect = question.options[optionIndex] === question.translation;

        if (!session.participants.has(interaction.user.id)) {
          session.participants.set(interaction.user.id, { score: 0, answers: [] });
        }

        const participant = session.participants.get(interaction.user.id);
        if (!participant.answers.includes(questionIndex)) {
          participant.answers.push(questionIndex);
          if (isCorrect) {
            participant.score += 1;
          }
        }

        // Send next question if all participants have answered
        const allAnswered = Array.from(session.participants.values())
          .every(p => p.answers.includes(questionIndex));

        if (allAnswered) {
          await sendRaceQuestion(interaction, raceId, questionIndex + 1);
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
  if (!batch || !batch.sentences || idx >= batch.sentences.length) {
    if (isButtonInteraction) {
      await interaction.update({ 
        content: '❌ 無效的複習內容',
        embeds: [],
        components: []
      });
    } else {
      await interaction.followUp({ content: '❌ 無效的複習內容' });
    }
    return;
  }
  const row = batch.sentences[idx];
  const progress = Math.round((idx / batch.sentences.length) * 100);
  const progressBar = `[${'='.repeat(Math.floor(progress/10))}${progress%10 === 0 ? '' : '>'}${' '.repeat(10-Math.ceil(progress/10))}] ${progress}%`;
  
  const embed = new EmbedBuilder()
    .setTitle(`【複習 ${sub}】${batch.date} (${idx + 1}/${batch.sentences.length})`)
    .setDescription(`### ${row.original}\n\n${progressBar}`)
    .setFooter({ 
      text: `本批共 ${batch.sentences.length} 句，${totalBatches > 1 ? `還有 ${totalBatches-1} 批較舊內容` : '已是最舊批次'}`
    });

  const rowBtn = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`review_next_${userId}_${sub}_${batch.date}_${idx}`)
      .setLabel(row.translation || '無翻譯')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`review_delete_${userId}_${sub}_${batch.date}_${idx}`)
      .setLabel('刪掉 🗑️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('review_done')
      .setLabel('結束')
      .setStyle(ButtonStyle.Primary)
  );

  try {
    if (isButtonInteraction) {
      await interaction.update({ 
        embeds: [embed], 
        components: [rowBtn] 
      });
    } else {
      await interaction.followUp({ 
        embeds: [embed], 
        components: [rowBtn] 
      });
    }
    if (batchFinishCallback) interaction._batchFinishCallback = batchFinishCallback;
  } catch (err) {
    console.error('Error sending review question:', err);
    if (isButtonInteraction) {
      await interaction.update({ 
        content: '❌ 發送複習題目時發生錯誤',
        embeds: [],
        components: []
      });
    } else {
      await interaction.followUp({ content: '❌ 發送複習題目時發生錯誤' });
    }
  }
}

// Update reminder scheduling
function scheduleReviewReminders() {
  const now = new Date();
  const morning = new Date(now);
  morning.setHours(9, 0, 0, 0);
  const evening = new Date(now);
  evening.setHours(21, 0, 0, 0);

  // Convert to local timezone
  const localMorning = new Date(morning.getTime() - (now.getTimezoneOffset() * 60000));
  const localEvening = new Date(evening.getTime() - (now.getTimezoneOffset() * 60000));

  // Save next reminder time
  const nextReminder = now < localMorning ? localMorning : 
                      now < localEvening ? localEvening :
                      new Date(localMorning.getTime() + 24 * 60 * 60 * 1000);
  
  fs.writeFileSync('./next_reminder.json', JSON.stringify({
    nextReminder: nextReminder.toISOString()
  }));

  // Schedule next reminder
  const timeUntilNext = nextReminder - now;
  setTimeout(() => {
    sendTestReminders();
    scheduleReviewReminders();
  }, timeUntilNext);
}

// Load reminder schedule on startup
client.once('ready', () => {
  console.log(`🤖 ${client.user.tag} 已上線！`);
  try {
    if (fs.existsSync('./next_reminder.json')) {
      const { nextReminder } = JSON.parse(fs.readFileSync('./next_reminder.json', 'utf8'));
      const now = new Date();
      const next = new Date(nextReminder);
      if (next > now) {
        setTimeout(() => {
          sendTestReminders();
          scheduleReviewReminders();
        }, next - now);
        return;
      }
    }
  } catch (err) {
    console.error('Error loading reminder schedule:', err);
  }
  scheduleReviewReminders();
});

// Update test reminder function
async function sendTestReminders() {
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

      const embed = new EmbedBuilder()
        .setTitle('📚 要測試了嗎？')
        .setDescription(
          `今天要測試的有：\n${Object.entries(stats)
            .map(([sub, count]) => `• ${sub}: ${count} 句`)
            .join('\n')}\n\n` +
          `完成測試可獲得 🪙+1`
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

  try {
    if (isButtonInteraction) {
      // For button interactions, update the existing message
      await interaction.update({ 
        embeds: [embed], 
        components: [rowBtn] 
      });
    } else {
      // For initial command, use followUp
      await interaction.followUp({ 
        embeds: [embed], 
        components: [rowBtn] 
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

// Add state management for all sessions
const activeReviews = new Map();
const activeTests = new Map();
const raceSessions = new Map();

// Add session management functions
function isUserInSession(userId) {
  return activeReviews.has(userId) || activeTests.has(userId);
}

function isUserInRace(userId) {
  return Array.from(raceSessions.values()).some(session => 
    session.participants.has(userId)
  );
}

function canUserInteract(interaction) {
  const userId = interaction.user.id;
  const [action, type, ...params] = interaction.customId.split('_');
  
  // Race commands are always allowed
  if (action.startsWith('race_')) {
    return true;
  }
  
  // Check if user is in any session
  if (isUserInSession(userId)) {
    // Allow only their own session buttons or done buttons
    if (action === 'review_done' || action === 'test_done') {
      return true;
    }
    if (action.startsWith('review_') && params[0] === userId) {
      return true;
    }
    if (action.startsWith('test_') && params[0] === userId) {
      return true;
    }
    return false;
  }
  
  // If user is not in any session, they can only start new sessions
  return action === 'test_start' || action === 'review_start';
}

// Add timeout promise
function timeout(ms) {
  return new Promise((_, reject) => 
    setTimeout(() => reject(new Error('Operation timed out')), ms)
  );
}

// Add validation functions for button IDs
function validateReviewButtonId(id) {
  const parts = id.split('_');
  if (parts.length !== 6) return false;
  const [flag, , userId, sub, date, idxStr] = parts;
  if (!['review_next', 'review_delete'].includes(flag)) return false;
  if (!userId || !sub || !date || isNaN(Number(idxStr))) return false;
  return true;
}

function validateTestButtonId(id) {
  const parts = id.split('_');
  if (parts.length !== 6) return false;
  const [flag, , userId, sub, date, idxStr] = parts;
  if (!['test_yes', 'test_no'].includes(flag)) return false;
  if (!userId || !sub || !date || isNaN(Number(idxStr))) return false;
  return true;
}

function validateRaceButtonId(id) {
  const parts = id.split('_');
  if (parts.length !== 4) return false;
  const [flag, raceId, questionIndex, optionIndex] = parts;
  if (!['race_answer', 'race_end'].includes(flag)) return false;
  if (!raceId || isNaN(Number(questionIndex)) || isNaN(Number(optionIndex))) return false;
  return true;
}

// Add race question function
async function sendRaceQuestion(interaction, raceId, questionIndex) {
  const session = raceSessions.get(raceId);
  if (!session || questionIndex >= session.questions.length) {
    // Race is over
    const winner = Array.from(session.participants.entries())
      .sort((a, b) => b[1].score - a[1].score)[0];
    
    const embed = new EmbedBuilder()
      .setTitle('🏁 競賽結束！')
      .setDescription(
        winner ? 
          `🏆 獲勝者：<@${winner[0]}>\n得分：${winner[1].score}` :
          '沒有人完成競賽'
      )
      .setFooter({ text: '點仔算 Tiamasng' });

    await interaction.channel.send({ embeds: [embed] });
    raceSessions.delete(raceId);
    return;
  }

  const question = session.questions[questionIndex];
  const embed = new EmbedBuilder()
    .setTitle(`🏁 競賽題目 ${questionIndex + 1}/${session.questions.length}`)
    .setDescription(`讓我考考你，「${question.original}」是什麼意思？`)
    .setFooter({ text: '點仔算 Tiamasng' });

  const row = new ActionRowBuilder().addComponents(
    ...question.options.map((option, i) => 
      new ButtonBuilder()
        .setCustomId(`race_answer_${raceId}_${questionIndex}_${i}`)
        .setLabel(option)
        .setStyle(ButtonStyle.Primary)
    ),
    new ButtonBuilder()
      .setCustomId(`race_end_${raceId}`)
      .setLabel('結束競賽')
      .setStyle(ButtonStyle.Danger)
  );

  await interaction.channel.send({ embeds: [embed], components: [row] });
}

client.login(process.env.TOKEN);
