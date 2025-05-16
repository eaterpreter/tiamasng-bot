// index.js (含每日雙榜自動發布功能)
const { Client, GatewayIntentBits, Partials, EmbedBuilder } = require('discord.js');
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
  if (users[userId].lastCheckInDate !== today) {
    users[userId].todayBonusGiven = false;
  }
}
fs.writeFileSync(userFile, JSON.stringify(users, null, 2));

function addPointWithStreak(userId) {
  const now = new Date();
  const today = now.toISOString().split('T')[0];

  if (!users[userId]) {
    users[userId] = {
      points: 0,
      streakDay: 0,
      lastCheckInDate: '',
      todayBonusGiven: false,
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

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.attachments.size) return;

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
});

client.once('ready', () => {
  console.log(`🤖 ${client.user.tag} 已上線！`);

  schedule.scheduleJob('* 9 * * *', () => {
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
});

client.login(process.env.TOKEN);
