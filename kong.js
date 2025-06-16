const { EmbedBuilder } = require('discord.js');
const fs = require('fs');
const { promisify } = require('util');
const { exec } = require('child_process');
const execAsync = promisify(exec);
const { addPointWithStreak } = require('./utils');

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

// Handle audio message
async function handleAudioMessage(message) {
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
}

module.exports = {
  handleAudioMessage,
  getAudioDuration
};
