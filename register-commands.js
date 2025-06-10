// register-commands.js
const { REST, Routes, SlashCommandBuilder } = require('discord.js');
require('dotenv').config();

const commands = [
  // 新增科目
  new SlashCommandBuilder()
    .setName('newsub')
    .setDescription('新增一個新科目')
    .addStringOption(option =>
      option.setName('subject')
        .setDescription('科目名稱')
        .setRequired(true)
    ),
  // 新增內容（支援 autocomplete）
  new SlashCommandBuilder()
    .setName('study')
    .setDescription('開始新增學習內容')
    .addStringOption(option =>
      option.setName('subject')
        .setDescription('請選擇現有科目')
        .setRequired(true)
        .setAutocomplete(true)    // ★ 加這一行
    )
    .addStringOption(option =>
      option.setName('content')
        .setDescription('請輸入要加入的內容（原文｜翻譯）')
        .setRequired(true)
    ),
  // 主動複習（支援 autocomplete）
  new SlashCommandBuilder()
    .setName('review')
    .setDescription('主動複習指定科目')
    .addStringOption(option =>
      option.setName('subject')
        .setDescription('請選擇現有科目')
        .setRequired(true)
        .setAutocomplete(true)    // ★ 加這一行
    ),
  // 統計
  new SlashCommandBuilder()
    .setName('stats')
    .setDescription('顯示所有科目統計'),
  // 說明指令
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('說明與功能總覽')
].map(cmd => cmd.toJSON());

// === 填你的 Bot ID 跟 Server ID ===
const CLIENT_ID = '1324942256259469404';
const GUILD_ID = '851389863315767337';

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

(async () => {
  try {
    console.log('⏳ 開始註冊 slash 指令...');
    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands }
    );
    console.log('✅ 註冊完成！');
  } catch (error) {
    console.error(error);
  }
})();
