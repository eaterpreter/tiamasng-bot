// index.js (含每日雙榜自動發布功能 + 互動式複習提醒 + TTS)
// === 語言對應表 ===
const sub2lang = {
  '日語': 'ja', '日文': 'ja', 'japanese': 'ja', 'ja': 'ja', 'japan': 'ja', 'nihonggo': 'ja', '日本語': 'ja', '日': 'ja',
  '德語': 'de', '德文': 'de', 'german': 'de', 'de': 'de', 'germany': 'de', 'deutsch': 'de', 'deutschland': 'de', '德': 'de',
  '英文': 'en', '英語': 'en', 'english': 'en', 'en': 'en', 'america': 'en', '英': 'en',
  '俄語': 'ru', '俄文': 'ru', 'russian': 'ru', 'ru': 'ru', 'russia': 'ru', 'русский': 'ru', 'русский язык': 'ru', '俄': 'ru', 'рус': 'ru', 
  '法語': 'fr', '法文': 'fr', 'french': 'fr', 'fr': 'fr', 'france': 'fr', 'français': 'fr', 'française': 'fr', '法': 'fr',
  '西班牙語': 'es', '西班牙文': 'es', 'spanish': 'es', 'es': 'es', 'spain': 'es', 'espana': 'es', 'español': 'es', '西': 'es',
  '韓語': 'ko', '韓文': 'ko', 'korean': 'ko', 'ko': 'ko', 'korea': 'ko', '한국어': 'ko', '한국': 'ko', '韓': 'ko',
  // 不支援 zh-TW TTS 就別加
};

const hoksip = require('./hoksip.js');
const { Client, GatewayIntentBits, Partials, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const fs = require('fs');
const path = require('path');
const schedule = require('node-schedule');
require('dotenv').config();

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

// 🟢 打卡給金幣
function addPointWithStreak(userId) {
  const now = new Date();
  const today = now.toISOString().split('T')[0];

  if (!users[userId]) {
    users[userId] = {
      points: 0,
      streakDay: 0,
      lastCheckInDate: '',
      todayBonusGiven: false,
      reviewBonusGiven: false,
      history: []
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
  return {
    points: user.points,
    streakDay: user.streakDay,
    bonusGiven: bonus
  };
}

// 🟢 監聽文字訊息
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  // === 音檔打卡區塊 ===
  if (message.attachments.size > 0) {
    for (const attachment of message.attachments.values()) {
      const ext = path.extname(attachment.name).toLowerCase();
      if (audioExtensions.includes(ext)) {
        const result = addPointWithStreak(message.author.id);
        const embed = new EmbedBuilder()
          .setColor(0x00AE86)
          .setTitle('✅ 你好棒！今天也聽到你的聲音了')
          .setDescription(`${message.author} 完成練習，獲得 **🪙+1** \n` +
            (result.bonusGiven > 0 ? `🎉 連續第 ${result.streakDay} 天打卡，加碼 **🪙+${result.bonusGiven}**\n` : '') +
            `目前總點數：**🪙${result.points}**\n連續練習天數：**${result.streakDay}天**`)
          .setFooter({ text: '點仔算 Tiamasng' });
        await message.reply({ embeds: [embed] });
        break;
      }
    }
    return;
  }

  // === 學習指令 ===
  const content = message.content.trim();

  // /newsub [科目名]
  if (content.startsWith('/newsub ')) {
    const sub = content.slice(8).trim();
    if (!sub) return message.reply('請輸入科目名稱！');
    hoksip.checkSubExist(message.author.id, sub, (err, exist) => {
      if (err) return message.reply('檢查科目時發生錯誤');
      if (exist) return message.reply('已經有這個科目了，換個名稱吧');
      return message.reply(`✅ 已新增科目「${sub}」！可用 /study ${sub} 新增內容`);
    });
    return;
  }

  // /study [科目名]
  if (content.startsWith('/study ')) {
    const sub = content.slice(7).trim();
    const ttsLang = sub2lang[sub];
    if (!sub) return message.reply('請輸入科目名稱！');
    if (!ttsLang) return message.reply(`⚠️ 不支援「${sub}」的語音，請聯絡管理員新增語言！`);
    message.reply('請輸入內容（每行一組「原文｜翻譯」），輸入 `完成` 結束');
    const filter = m => m.author.id === message.author.id;
    const collector = message.channel.createMessageCollector({ filter, time: 120000 });
    let lines = [];
    collector.on('collect', m => {
      if (m.content.trim() === '完成') {
        collector.stop('done');
        return;
      }
      lines.push(m.content);
    });
    collector.on('end', (collected, reason) => {
      if (reason === 'done') {
        let added = 0;
        lines.forEach(line => {
          let [original, translation = ''] = line.split('|').map(x => x.trim());
          if (original) {
            // 傳進 ttsLang
            hoksip.addSentence(message.author.id, original, translation, sub, sub2lang[sub], callback);
            added++;
          }
        });
        addPointWithStreak(message.author.id);
        message.reply(`✅ 已新增 ${added} 筆到科目「${sub}」！`);
      } else {
        message.reply('內容收集逾時或中斷，請重新輸入。');
      }
    });
    return;
  }

  // /review [科目名]
  if (content.startsWith('/review ')) {
    const sub = content.slice(8).trim();
    if (!sub) return message.reply('請輸入科目名稱！');
    hoksip.getDueSentences(message.author.id, sub, (err, rows) => {
      if (err) return message.reply('查詢失敗');
      if (!rows.length) return message.reply('目前沒有需要複習的內容！');
      addPointWithStreak(message.author.id);
      let i = 0;
      const ask = () => {
        if (i >= rows.length) return message.reply('複習結束！');
        const row = rows[i];
        message.reply(`\n${row.original}\n${row.translation}\n[請回覆 y 或 n]`).then(() => {
          const filter = m => m.author.id === message.author.id;
          message.channel.awaitMessages({ filter, max: 1, time: 60000, errors: ['time'] })
            .then(col => {
              const ans = col.first().content.trim().toLowerCase();
              hoksip.handleReviewResult(row.id, ans === 'y', false, () => {});
              i++; ask();
            }).catch(() => message.reply('逾時，中斷複習。'));
        });
      };
      ask();
    });
    return;
  }

  // /stats
  if (content === '/stats') {
    hoksip.getStats(message.author.id, (err, stats) => {
      if (err) return message.reply('統計查詢失敗');
      let out = '';
      for (let sub in stats) {
        let s = stats[sub];
        out += `【${sub}】\n不熟：${s.not_familiar}　有印象：${s.vague}　熟練：${s.mastered}\n`;
      }
      message.reply(out || '你還沒有任何學習內容！');
    });
    return;
  }
});

// 🟢 按鈕交互：複習/語音/可不可
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  const customId = interaction.customId;

  // 開始複習
  if (customId.startsWith('startReview_')) {
    const parts = customId.split('_');
    const userId = parts[1];
    const sub = parts[2];

    if (interaction.user.id !== userId) {
      return interaction.reply({ content: '這不是你的複習喔！', ephemeral: true });
    }

    const rowTTS = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`tts_off_${userId}_${sub}`)
          .setLabel('不用語音開始複習')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`tts_on_${userId}_${sub}`)
          .setLabel('語音複習')
          .setStyle(ButtonStyle.Success)
      );

    await interaction.update({
      content: `⏰ 今日該複習的句子如下（${sub}）\n請選擇複習模式：`,
      components: [rowTTS]
    });
    return;
  }

  // 複習 TTS on/off
  if (customId.startsWith('tts_on_') || customId.startsWith('tts_off_')) {
    const parts = customId.split('_');
    const ttsEnabled = customId.startsWith('tts_on_');
    const userId = parts[2];
    const sub = parts[3];

    if (interaction.user.id !== userId) {
      return interaction.reply({ content: '這不是你的複習喔！', ephemeral: true });
    }

    hoksip.getDueSentences(userId, sub, async (err, rows) => {
      if (err) {
        return interaction.update({ content: '查詢複習內容時發生錯誤', components: [] });
      }
      if (!rows.length) {
        return interaction.update({ content: '目前沒有需要複習的內容！', components: [] });
      }
      if (!users[userId].reviewBonusGiven) {
        addPointWithStreak(userId);
        users[userId].reviewBonusGiven = true;
        fs.writeFileSync(userFile, JSON.stringify(users, null, 2));
      }

      // --- 第一題 ---
      const row = rows[0];
      const reviewButtons = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId(`review_yes_${userId}_${sub}_0_${ttsEnabled}`)
            .setLabel('可 ✅')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`review_no_${userId}_${sub}_0_${ttsEnabled}`)
            .setLabel('不可 ❌')
            .setStyle(ButtonStyle.Danger)
        );
      let ttsMsg = '';
      if (ttsEnabled) {
        ttsMsg = row.tts_url ? `\n🔊 [語音播放連結](${row.tts_url})` : '\n(語音產生失敗或未支援)';
      }
      await interaction.update({
        content: `【複習 ${sub}】(1/${rows.length})\n${row.original}${ttsMsg}`,
        components: [reviewButtons]
      });
    });
    return;
  }

  // 可/不可按鈕
  if (customId.startsWith('review_yes_') || customId.startsWith('review_no_')) {
    const parts = customId.split('_');
    const userId = parts[2];
    const sub = parts[3];
    const currentIndex = parseInt(parts[4]);
    const ttsEnabled = parts[5] === 'true';
    const isCorrect = customId.startsWith('review_yes_');

    if (interaction.user.id !== userId) {
      return interaction.reply({ content: '這不是你的複習喔！', ephemeral: true });
    }

    hoksip.getDueSentences(userId, sub, async (err, rows) => {
      if (err || !rows.length) {
        return interaction.update({ content: '複習過程發生錯誤', components: [] });
      }
      const currentRow = rows[currentIndex];
      if (currentRow) {
        hoksip.handleReviewResult(currentRow.id, isCorrect, false, () => {});
      }
      const nextIndex = currentIndex + 1;
      if (nextIndex >= rows.length) {
        await interaction.update({
          content: `🎉 「${sub}」複習完成！\n共完成 ${rows.length} 個項目的複習。`,
          components: []
        });
        return;
      }
      const nextRow = rows[nextIndex];
      const reviewButtons = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId(`review_yes_${userId}_${sub}_${nextIndex}_${ttsEnabled}`)
            .setLabel('可 ✅')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`review_no_${userId}_${sub}_${nextIndex}_${ttsEnabled}`)
            .setLabel('不可 ❌')
            .setStyle(ButtonStyle.Danger)
        );
      let ttsMsg = '';
      if (ttsEnabled) {
        ttsMsg = nextRow.tts_url ? `\n🔊 [語音播放連結](${nextRow.tts_url})` : '\n(語音產生失敗或未支援)';
      }
      await interaction.update({
        content: `【複習 ${sub}】(${nextIndex + 1}/${rows.length})\n${nextRow.original}${ttsMsg}`,
        components: [reviewButtons]
      });
    });
    return;
  }
});

// 🟢 ready 事件：每日排行榜、複習提醒
client.once('ready', () => {
  console.log(`🤖 ${client.user.tag} 已上線！`);

  // 英雄榜
  schedule.scheduleJob('0 9 * * *', () => {
    const now = new Date();
    const rangeStart = new Date(now);
    const rangeEnd = new Date(now);
    rangeStart.setHours(0, 0, 0, 0);
    rangeStart.setDate(rangeStart.getDate() - 1);
    rangeEnd.setHours(23, 59, 59, 999);

    const gains = [];
    for (const userId in users) {
      const user = users[userId];
      const earned = user.history?.filter(h => {
        const t = new Date(h.timestamp);
        return t >= rangeStart && t <= rangeEnd;
      }).reduce((sum, h) => sum + h.delta, 0) || 0;
      if (earned > 0) {
        gains.push({ userId, earned, total: user.points });
      }
    }
    const topDaily = gains.sort((a, b) => b.earned - a.earned).slice(0, 5);
    const topTotal = Object.entries(users).sort((a, b) => b[1].points - a[1].points)[0];
    const lines = topDaily.map((u, i) => `${i + 1}. <@${u.userId}>，昨天賺到 ${u.earned}🪙，現在總共 ${u.total}🪙`).join('\n');
    const kingLine = topTotal ? `🥇 <@${topTotal[0]}> 目前累積總金幣：${topTotal[1].points}🪙` : '目前還沒有王者出現！';
    const embed = new EmbedBuilder()
      .setColor(0xFFD700)
      .setTitle('🏆 今日帕魯英雄榜')
      .setDescription(`今天的勞動帕魯英雄有：\n${lines || '（目前無上榜者）'}\n\n👑 帕魯王者\n${kingLine}`)
      .setFooter({ text: '點仔算 Tiamasng' });
    const channel = client.channels.cache.get('851389863814234113');
    if (channel) channel.send({ embeds: [embed] });
  });

  // 自動複習提醒
  const CHANNEL_ID = '1325246375813840998';
  schedule.scheduleJob('0 9,21 * * *', async () => {
    console.log('[自動提醒] 開始檢查複習任務...');
    const channel = client.channels.cache.get(CHANNEL_ID);
    if (!channel) return console.log('找不到提醒用頻道');
    for (const userId in users) {
      if (typeof hoksip.getUserSubjects === 'function') {
        hoksip.getUserSubjects(userId, (err, subjects) => {
          if (err || !subjects.length) return;
          let summary = '';
          let totalDue = 0;
          let checked = 0;
          subjects.forEach(subject => {
            hoksip.getDueSentences(userId, subject, (err, dueRows) => {
              const n = (dueRows && dueRows.length) || 0;
              summary += `${subject}：${n} 條  `;
              totalDue += n;
              checked++;
              if (checked === subjects.length && totalDue > 0) {
                const rowButton = new ActionRowBuilder()
                  .addComponents(
                    new ButtonBuilder()
                      .setCustomId(`startReview_${userId}_全部`)
                      .setLabel('開始複習')
                      .setStyle(ButtonStyle.Primary)
                  );
                channel.send({
                  content: `<@${userId}> 📚 今日要複習的內容：\n${summary}`,
                  components: [rowButton]
                });
              }
            });
          });
        });
      }
    }
  });
});

client.login(process.env.TOKEN);
