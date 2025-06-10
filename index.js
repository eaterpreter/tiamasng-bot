// index.js (支援 slash 指令 + autocomplete + TTS + 排行榜 + 被動提醒)
const sub2lang = {
  '日語': 'ja', '日文': 'ja', 'japanese': 'ja', 'ja': 'ja', 'japan': 'ja', 'nihonggo': 'ja', '日本語': 'ja', '日': 'ja',
  '德語': 'de', '德文': 'de', 'german': 'de', 'de': 'de', 'germany': 'de', 'deutsch': 'de', 'deutschland': 'de', '德': 'de',
  '英文': 'en', '英語': 'en', 'english': 'en', 'en': 'en', 'america': 'en', '英': 'en',
  '俄語': 'ru', '俄文': 'ru', 'russian': 'ru', 'ru': 'ru', 'russia': 'ru', 'русский': 'ru', 'русский язык': 'ru', '俄': 'ru', 'рус': 'ru',
  '法語': 'fr', '法文': 'fr', 'french': 'fr', 'fr': 'fr', 'france': 'fr', 'français': 'fr', 'française': 'fr', '法': 'fr',
  '西班牙語': 'es', '西班牙文': 'es', 'spanish': 'es', 'es': 'es', 'spain': 'es', 'espana': 'es', 'español': 'es', '西': 'es',
  '韓語': 'ko', '韓文': 'ko', 'korean': 'ko', 'ko': 'ko', 'korea': 'ko', '한국어': 'ko', '한국': 'ko', '韓': 'ko',
};

const hoksip = require('./hoksip.js');
const { Client, GatewayIntentBits, Partials, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const fs = require('fs');
const schedule = require('node-schedule');
require('dotenv').config();

// 工具：標準化顯示句子
function displaySentence(row) {
  if (row.translation && row.translation.trim() && row.translation !== row.original) {
    return `${row.original}｜${row.translation}`;
  }
  return `${row.original}\n${row.translation || ''}`;
}

// === Discord bot 基本設定 ===
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

const audioExtensions = ['.mp3', '.wav', '.m4a', '.ogg', '.flac'];
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

// 打卡給金幣
function addPointWithStreak(userId) {
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
  fs.writeFileSync(userFile, JSON.stringify(users, null, 2));
  return { points: user.points, streakDay: user.streakDay, bonusGiven: bonus };
}

// === 傳統訊息打卡（省略，與原本相同）===
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  // ... 省略原本內容 ...
});

// === Slash指令、autocomplete、按鈕互動 ===
client.on('interactionCreate', async interaction => {
  // --- autocomplete 科目下拉選單（review, study） ---
  if (interaction.isAutocomplete()) {
    const focusedValue = interaction.options.getFocused();
    const userId = interaction.user.id;
    hoksip.getUserSubjects(userId, (err, subjects) => {
      if (err) return interaction.respond([]);
      const filtered = subjects
        .filter(s => s && s.includes(focusedValue))
        .slice(0, 25)
        .map(s => ({ name: s, value: s }));
      interaction.respond(filtered);
    });
    return;
  }

  // --- Slash 指令 ---
  if (interaction.isChatInputCommand()) {
    const { commandName, options, user } = interaction;

    // /help
    if (commandName === 'help') {
      return interaction.reply({
        ephemeral: false,  // 全員可見
        content:
`【Tiamasng 點仔算使用說明】
本 bot 支援「打卡累積金幣」、「學習記錄」和「自動複習提醒」等多功能！

🔹 **常用 Slash 指令：**
/newsub 科目名稱    ➜ 新增一個新科目
/study  科目名稱 內容（每行「原文｜翻譯」）  ➜ 新增學習內容
/review 科目名稱     ➜ 主動複習指定科目
/stats              ➜ 顯示所有科目統計

🔹 **語音學習**：所有語言內容自動產生 TTS 語音，支援多語。
🔹 **自動提醒**：每日 09:00、21:00 主動提醒複習。
🔹 **音檔打卡**：傳 mp3/wav/m4a/ogg/flac 檔自動累積金幣與連續天數！

🔹 **任何問題請 tag 管理員或 /help**

—— Powered by Tiamasng 點仔算`
      });
    }

    // /newsub
    if (commandName === 'newsub') {
      const sub = options.getString('subject', true);
      hoksip.checkSubExist(user.id, sub, (err, exist) => {
        if (err) return interaction.reply('檢查科目時發生錯誤');
        if (exist) return interaction.reply('已經有這個科目了，換個名稱吧');
        hoksip.addSentence(user.id, '[placeholder]', '', sub, () => {
          interaction.reply(`✅ 已新增科目「${sub}」！可用 /study ${sub} 新增內容`);
        });
      });
    }

    // /study
    else if (commandName === 'study') {
      const sub = options.getString('subject', true);
      const content = options.getString('content', true);
      const ttsLang = sub2lang[sub];
      if (!ttsLang) return interaction.reply(`⚠️ 不支援「${sub}」的語音，請聯絡管理員新增語言！`);
      let added = 0;
      // 支援多種分隔符
      content.split('\n').forEach(line => {
        let [original, translation = ''] = line.split(/[|｜:：\t、/~]/).map(x => x.trim());
        if (original) {
          hoksip.addSentence(user.id, original, translation, sub, ttsLang, () => {});
          added++;
        }
      });
      addPointWithStreak(user.id);
      interaction.reply(`✅ 已新增 ${added} 筆到科目「${sub}」！`);
    }

    // /review
    else if (commandName === 'review') {
      const sub = options.getString('subject', true);
      await interaction.reply(`開始複習科目【${sub}】，請稍候...`);
      hoksip.getSentencesByDateBatches(user.id, sub, async (err, batches) => {
        if (err) return interaction.followUp('查詢失敗');
        if (!batches.length) return interaction.followUp('目前沒有任何內容可以複習！');
        // ========== 由近至遠，全部批次都複習 ==========
        let batchIdx = 0;
        function reviewBatch() {
          if (batchIdx >= batches.length) {
            return interaction.followUp({
              embeds: [new EmbedBuilder()
                .setTitle(`複習結束！`)
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
      hoksip.getStats(user.id, (err, stats) => {
        if (err) return interaction.reply('統計查詢失敗');
        let out = '';
        for (let sub in stats) {
          let s = stats[sub];
          out += `【${sub}】\n不熟：${s.not_familiar}　有印象：${s.vague}　熟練：${s.mastered}\n`;
        }
        interaction.reply(out || '你還沒有任何學習內容！');
      });
    }
    return;
  }

  // === 按鈕互動 ===
  if (interaction.isButton()) {
    const id = interaction.customId;
    // 答題按鈕
    if (id.startsWith('review_yes_') || id.startsWith('review_no_')) {
      const [flag, , userId, sub, date, idxStr] = id.split('_');
      if (interaction.user.id !== userId) return interaction.reply({ content: '這不是你的複習！', ephemeral: true });
      const isCorrect = id.startsWith('review_yes_');
      const idx = Number(idxStr);

      hoksip.getSentencesByDateBatches(userId, sub, async (err, batches) => {
        if (err) return interaction.reply('查詢失敗');
        const batch = batches.find(b => b.date === date);
        if (!batch) return interaction.reply('查無該日期內容！');
        const row = batch.sentences[idx];
        hoksip.handleReviewResult(row.id, isCorrect, false, () => {});

        if (idx + 1 < batch.sentences.length) {
          await sendReviewQuestion(interaction, userId, sub, idx + 1, batch, batches.length, null, true);
        } else {
          // 本批次已結束，呼叫 callback 進下一天
          if (typeof interaction._batchFinishCallback === 'function') {
            return interaction._batchFinishCallback();
          }
          // fallback: 顯示已結束
          await interaction.reply({
            embeds: [new EmbedBuilder()
              .setTitle(`複習結束！`)
              .setDescription(`本批（${date}）已複習完畢。`)
              .setFooter({ text: '點仔算 Tiamasng' })],
            components: [new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId('review_done').setLabel('結束').setStyle(ButtonStyle.Primary)
            )]
          });
        }
      });
    }
    // 結束按鈕
    else if (interaction.customId === 'review_done') {
      await interaction.reply({ content: '複習已結束，請繼續加油！', embeds: [], components: [] });
    }
    return;
  }
});

// ===== 輸出複習題卡（自動語音/分隔符/按鈕/結束處理）=====
async function sendReviewQuestion(interaction, userId, sub, idx, batch, totalBatches, batchFinishCallback, useReplyInsteadOfFollowup) {
  const row = batch.sentences[idx];
  const embed = new EmbedBuilder()
    .setTitle(`【複習 ${sub}】${batch.date} (${idx + 1}/${batch.sentences.length})`)
    .setDescription(`${displaySentence(row)}${row.tts_url ? `\n[🔊 語音播放連結](${row.tts_url})` : ''}`)
    .setFooter({ text: `本批次共 ${batch.sentences.length} 句，${totalBatches > 1 ? `還有 ${totalBatches-1} 批較舊內容` : '已是最舊批次'}` });

  const rowBtn = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`review_yes_${userId}_${sub}_${batch.date}_${idx}`)
      .setLabel('可 ✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`review_no_${userId}_${sub}_${batch.date}_${idx}`)
      .setLabel('不可 ❌').setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('review_done')
      .setLabel('結束').setStyle(ButtonStyle.Primary)
  );
  if (useReplyInsteadOfFollowup && interaction.replied === false) {
    await interaction.reply({ embeds: [embed], components: [rowBtn], ephemeral: false });
  } else {
    await interaction.update({ embeds: [embed], components: [rowBtn], ephemeral: false });
  }
  // 存 callback 讓按鈕可以呼叫（進下一天）
  if (batchFinishCallback) interaction._batchFinishCallback = batchFinishCallback;
}

// === ready 事件（排行榜與提醒照原本寫法）===
client.once('ready', () => {
  console.log(`🤖 ${client.user.tag} 已上線！`);
  // ... 你的排行榜與自動複習提醒原本寫法 ...
});

client.login(process.env.TOKEN);
