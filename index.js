// index.js (支援 slash 指令 + 傳統訊息 + TTS + 排行榜 + 被動提醒)
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
const { Client, GatewayIntentBits, Partials, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, Collection } = require('discord.js');
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

// === 傳統訊息：可兼容舊指令 ===
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  // 音檔打卡
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
  const content = message.content.trim();
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
            hoksip.addSentence(message.author.id, original, translation, sub, () => {});
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

// === Slash指令 & 按鈕互動 ===
client.on('interactionCreate', async interaction => {
  // 斜線指令
  if (interaction.isChatInputCommand()) {
    const { commandName, options, user } = interaction;
    if (commandName === 'newsub') {
      const sub = options.getString('subject', true);
      hoksip.checkSubExist(user.id, sub, (err, exist) => {
        if (err) return interaction.reply('檢查科目時發生錯誤');
        if (exist) return interaction.reply('已經有這個科目了，換個名稱吧');
        interaction.reply(`✅ 已新增科目「${sub}」！可用 /study ${sub} 新增內容`);
      });
    }
    else if (commandName === 'study') {
      const sub = options.getString('subject', true);
      const content = options.getString('content', true); // 支援多行
      const ttsLang = sub2lang[sub];
      if (!ttsLang) return interaction.reply(`⚠️ 不支援「${sub}」的語音，請聯絡管理員新增語言！`);
      let added = 0;
      content.split('\n').forEach(line => {
        let [original, translation = ''] = line.split('|').map(x => x.trim());
        if (original) {
          hoksip.addSentence(user.id, original, translation, sub, () => {});
          added++;
        }
      });
      addPointWithStreak(user.id);
      interaction.reply(`✅ 已新增 ${added} 筆到科目「${sub}」！`);
    }
    else if (commandName === 'review') {
      const sub = options.getString('subject', true);
      hoksip.getDueSentences(user.id, sub, (err, rows) => {
        if (err) return interaction.reply('查詢失敗');
        if (!rows.length) return interaction.reply('目前沒有需要複習的內容！');
        addPointWithStreak(user.id);
        let i = 0;
        const ask = () => {
          if (i >= rows.length) return interaction.followUp('複習結束！');
          const row = rows[i];
          interaction.followUp(`${row.original}\n${row.translation}\n[請回覆 y 或 n]`).then(() => {
            const filter = m => m.author.id === user.id;
            interaction.channel.awaitMessages({ filter, max: 1, time: 60000, errors: ['time'] })
              .then(col => {
                const ans = col.first().content.trim().toLowerCase();
                hoksip.handleReviewResult(row.id, ans === 'y', false, () => {});
                i++; ask();
              }).catch(() => interaction.followUp('逾時，中斷複習。'));
          });
        };
        ask();
      });
    }
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
  if (!interaction.isButton()) return;
  const customId = interaction.customId;
  // (後面保留原本複習/tts按鈕互動全都支援)
  // ... 請保留你原本的複習/tts/按鈕處理程式碼 ...

  // ...（略）...
  // 請直接把你上面的「可/不可」那段拷貝過來，功能完全相容
});

// 🟢 ready 事件：每日排行榜、複習提醒（同原本）
client.once('ready', () => {
  console.log(`🤖 ${client.user.tag} 已上線！`);
  // ... 英雄榜與自動複習提醒原本程式碼無須異動 ...
});

client.login(process.env.TOKEN);
