// hoksip.js
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { promisify } = require('util');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { addPointWithStreak } = require('./utils');

// Add shared state
const activeReviews = new Map();
const activeTests = new Map();
const raceSessions = new Map();

// Input validation
function validateUserId(userId) {
  return typeof userId === 'string' && userId.length > 0 && userId.length <= 50;
}

function validateSubject(sub) {
  return typeof sub === 'string' && sub.length > 0 && sub.length <= 50;
}

function validateContent(content) {
  return typeof content === 'string' && content.length > 0 && content.length <= 2000;
}

// Database connection with proper error handling
const DB_PATH = path.join(__dirname, 'hoksip', 'hoksip.db');
let db;

// Connection pool configuration
const POOL_CONFIG = {
  max: 10, // Maximum number of connections
  min: 2,  // Minimum number of connections
  idleTimeoutMillis: 30000 // How long a connection can be idle before being removed
};

// Initialize database connection
async function initDB() {
  return new Promise((resolve, reject) => {
    db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) {
        console.error('❌ 無法連線到資料庫:', err.message);
        reject(err);
      } else {
        console.log('✅ 已連線到 hoksip/hoksip.db');
        
        // Enable foreign keys and other SQLite optimizations
        db.run('PRAGMA foreign_keys = ON');
        db.run('PRAGMA journal_mode = WAL');
        db.run('PRAGMA synchronous = NORMAL');
        
        resolve();
      }
    });
  });
}

// Proper database cleanup
process.on('SIGINT', () => {
  if (db) {
    db.close((err) => {
      if (err) {
        console.error('Error closing database:', err);
      } else {
        console.log('Database connection closed');
      }
      process.exit(0);
    });
  }
});

// Initialize database schema
async function initSchema() {
  try {
    await db.run(`
      CREATE TABLE IF NOT EXISTS sentences (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        original TEXT NOT NULL,
        translation TEXT,
        sub TEXT,
        yesCount INTEGER DEFAULT 0,
        exe_date TEXT,
        next_date TEXT,
        review_count INTEGER DEFAULT 0,
        success_count INTEGER DEFAULT 0,
        tts_url TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Create indexes for better query performance
    await db.run('CREATE INDEX IF NOT EXISTS idx_user_sub ON sentences(user_id, sub)');
    await db.run('CREATE INDEX IF NOT EXISTS idx_next_date ON sentences(next_date)');
    
    console.log('✅ sentences 資料表已初始化');
  } catch (err) {
    console.error('❌ 建立資料表失敗:', err.message);
    throw err;
  }
}

// Initialize database and create promisified functions
let runAsync, getAsync, allAsync;

async function initialize() {
  await initDB();
  await initSchema();
  
  // Create promisified versions after db is initialized
  runAsync = promisify(db.run.bind(db));
  getAsync = promisify(db.get.bind(db));
  allAsync = promisify(db.all.bind(db));
}

// Call initialize immediately
initialize().catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});

const hoksip = {
  // Add sentence with proper validation
  addSentence(user_id, original, translation, sub, tts_url = '', callback) {
    if (!validateUserId(user_id) || !validateSubject(sub) || !validateContent(original)) {
      const err = new Error('Invalid input parameters');
      return callback && callback(err);
    }

    const now = new Date().toISOString().split('T')[0];
    db.run(
      `INSERT INTO sentences (user_id, original, translation, sub, yesCount, exe_date, next_date, review_count, success_count, tts_url)
       VALUES (?, ?, ?, ?, 0, ?, ?, 0, 0, ?)`,
      [user_id, original, translation, sub, now, now, tts_url],
      function (err) {
        if (err) {
          console.error('Error adding sentence:', err);
        }
        callback && callback(err, this && this.lastID);
      }
    );
  },

  // Get all sentences with pagination
  getAllSentences(user_id, sub, callback) {
    if (!validateUserId(user_id) || !validateSubject(sub)) {
      return callback(new Error('Invalid user_id or subject'), null);
    }

    db.all(
      `SELECT * FROM sentences 
       WHERE user_id = ? AND sub = ? 
       ORDER BY id ASC 
       LIMIT 1000`,
      [user_id, sub],
      (err, rows) => {
        if (err) {
          console.error('Error getting sentences:', err);
        }
        callback(err, rows);
      }
    );
  },

  // Get due sentences with proper error handling
  getDueSentencesToday(user_id, callback) {
    if (!validateUserId(user_id)) {
      return callback(new Error('Invalid user_id'), null);
    }

    const today = new Date().toISOString().split('T')[0];
    db.all(
      `SELECT * FROM sentences 
       WHERE user_id = ? AND next_date = ? AND yesCount < 6 
       ORDER BY sub ASC, id ASC`,
      [user_id, today],
      (err, rows) => {
        if (err) {
          console.error('Error getting due sentences:', err);
        }
        callback(err, rows);
      }
    );
  },

  // Get sentences by date batches with error handling
  getSentencesByDateBatches(user_id, sub, callback) {
    if (!validateUserId(user_id) || !validateSubject(sub)) {
      return callback(new Error('Invalid user_id or subject'), null);
    }

    db.all(
      'SELECT * FROM sentences WHERE user_id = ? AND sub = ? ORDER BY exe_date DESC, id ASC',
      [user_id, sub],
      (err, rows) => {
        if (err) {
          console.error('Error getting sentence batches:', err);
          return callback(err, null);
        }

        try {
          const batchMap = {};
          rows.forEach(row => {
            const date = row.exe_date;
            if (!batchMap[date]) batchMap[date] = [];
            batchMap[date].push(row);
          });
          const sortedDates = Object.keys(batchMap).sort((a, b) => b.localeCompare(a));
          const batches = sortedDates.map(date => ({ date, sentences: batchMap[date] }));
          callback(null, batches);
        } catch (err) {
          console.error('Error processing batches:', err);
          callback(err, null);
        }
      }
    );
  },

  // Handle review result with proper error handling
  handleReviewResult(sentence_id, is_correct, isPassive, callback) {
    if (typeof sentence_id !== 'number' || typeof is_correct !== 'boolean') {
      return callback(new Error('Invalid parameters'));
    }

    db.get(
      `SELECT yesCount, user_id, sub FROM sentences WHERE id = ?`,
      [sentence_id],
      (err, row) => {
        if (err) {
          console.error('Error getting sentence:', err);
          return callback(err);
        }
        if (!row) {
          return callback(new Error('Sentence not found'));
        }

        const today = new Date().toISOString().split('T')[0];
        let yesCount = row.yesCount || 0;
        let next_date = today;

        // Only update yesCount and next_date for passive review
        if (isPassive) {
          yesCount = is_correct ? yesCount + 1 : 0;
          const INTERVAL_RULES = [1, 2, 3, 5, 7, 10];
          const idx = Math.min(yesCount, INTERVAL_RULES.length - 1);
          next_date = new Date(Date.now() + INTERVAL_RULES[idx] * 86400000)
            .toISOString().split('T')[0];
        }

        // If yesCount reaches 6, mark as mastered and delete the sentence
        if (yesCount >= 6) {
          // Simply delete the sentence when mastered
          db.run('DELETE FROM sentences WHERE id = ?', [sentence_id], callback);
        } else {
          db.run(
            `UPDATE sentences 
             SET yesCount = ?, 
                 exe_date = ?, 
                 next_date = ?, 
                 review_count = review_count + 1,
                 success_count = success_count + ?
             WHERE id = ?`,
            [yesCount, today, next_date, is_correct ? 1 : 0, sentence_id],
            (err) => {
              if (err) {
                console.error('Error updating review result:', err);
              }
              callback && callback(err);
            }
          );
        }
      }
    );
  },

  // Check subject existence with validation
  checkSubExist(user_id, sub, callback) {
    if (!validateUserId(user_id) || !validateSubject(sub)) {
      return callback(new Error('Invalid user_id or subject'), false);
    }

    db.get(
      `SELECT 1 FROM sentences WHERE user_id = ? AND sub = ? LIMIT 1`,
      [user_id, sub],
      (err, row) => {
        if (err) {
          console.error('Error checking subject:', err);
        }
        callback(err, !!row);
      }
    );
  },

  // Get stats with proper error handling
  getStats(user_id, callback) {
    if (!validateUserId(user_id)) {
      return callback(new Error('Invalid user_id'), null);
    }

    db.all(`
      SELECT 
        sub,
        COUNT(CASE WHEN yesCount >= 6 THEN 1 END) as mastered,
        COUNT(CASE WHEN yesCount >= 3 AND yesCount < 6 THEN 1 END) as familiar,
        COUNT(CASE WHEN yesCount > 0 AND yesCount < 3 THEN 1 END) as not_familiar,
        COUNT(CASE WHEN yesCount = 0 THEN 1 END) as vague
      FROM sentences 
      WHERE user_id = ? 
      GROUP BY sub
    `, [user_id], (err, rows) => {
      if (err) {
        console.error('Error getting stats:', err);
        return callback(err, null);
      }

      const stats = {};
      rows.forEach(row => {
        stats[row.sub] = {
          mastered: row.mastered || 0,
          familiar: row.familiar || 0,
          not_familiar: row.not_familiar || 0,
          vague: row.vague || 0
        };
      });
      callback(null, stats);
    });
  },

  // Get user subjects with validation
  getUserSubjects(user_id, callback) {
    if (!validateUserId(user_id)) {
      return callback(new Error('Invalid user_id'), []);
    }

    db.all(
      `SELECT DISTINCT sub FROM sentences WHERE user_id = ?`,
      [user_id],
      (err, rows) => {
        if (err) {
          console.error('Error getting subjects:', err);
          return callback(err, []);
        }
        const subjects = rows.map(r => r.sub);
        callback(null, subjects);
      }
    );
  },

  // Add deleteSentence function
  deleteSentence(id, callback) {
    db.run('DELETE FROM sentences WHERE id = ?', [id], function(err) {
      if (err) {
        console.error('Error deleting sentence:', err);
        return callback(err);
      }
      callback(null);
    });
  }
};

// Add clearUserSession function
function clearUserSession(userId) {
  activeReviews.delete(userId);
  activeTests.delete(userId);
}

// ===== Review & Race Command Handlers =====

// Handle review and race commands
async function handleCommand(interaction) {
  const { commandName, options, user } = interaction;

  // /newsub
  if (commandName === 'newsub') {
    const sub = options.getString('subject', true);
    if (!validateSubject(sub)) {
      return interaction.reply('❌ 科目名稱無效或太長');
    }
    checkSubExist(user.id, sub, (err, exist) => {
      if (err) {
        console.error('Error checking subject:', err);
        return interaction.reply('❌ 檢查科目時發生錯誤');
      }
      if (exist) return interaction.reply('❌ 已經有這個科目了，換個名稱吧');
      addSentence(user.id, '[placeholder]', '', sub, '', (err) => {
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
              addSentence(user.id, original, translation, sub, '', (err) => {
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
    
    await addPointWithStreak(user.id);
    await interaction.followUp(`✅ 已新增 ${added} 筆到科目「${sub}」${errors > 0 ? `（${errors} 筆失敗）` : ''}`);
  }

  // /review
  else if (commandName === 'review') {
    const sub = options.getString('subject', true);
    if (!validateSubject(sub)) {
      return interaction.reply('❌ 科目名稱無效或太長');
    }
    
    // Clear any existing session first
    clearUserSession(interaction.user.id);
    
    await interaction.reply(`開始複習科目【${sub}】，請稍候...`);
    hoksip.getSentencesByDateBatches(interaction.user.id, sub, async (err, batches) => {
      if (err) {
        console.error('Error getting batches:', err);
        return interaction.followUp('❌ 查詢失敗');
      }
      if (!batches.length) return interaction.followUp('目前沒有任何內容可以複習！');
      
      // Sort batches by review count and date
      batches.sort((a, b) => {
        const aAvgReviewCount = a.sentences.reduce((sum, s) => sum + (s.review_count || 0), 0) / a.sentences.length;
        const bAvgReviewCount = b.sentences.reduce((sum, s) => sum + (s.review_count || 0), 0) / b.sentences.length;
        if (aAvgReviewCount !== bAvgReviewCount) {
          return aAvgReviewCount - bAvgReviewCount;
        }
        return new Date(b.date) - new Date(a.date);
      });
      
      // Mark review as active and store batches
      activeReviews.set(interaction.user.id, { 
        sub, 
        date: batches[0].date, 
        idx: 0,
        batchIdx: 0,
        batches 
      });
      
      // Send first question
      sendReviewQuestion(interaction, interaction.user.id, sub, 0, batches[0], batches.length, null, false);
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
    raceSessions.set(raceId, {
      initiator: interaction.user.id,
      subject: sub,
      participants: new Map(),
      currentQuestion: 0,
      totalQuestions: 20,
      startTime: Date.now()
    });

    // Get random sentences for options
    getRandomSentences(sub, 60, async (err, sentences) => {
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

  // /join
  else if (commandName === 'join') {
    const raceId = options.getString('race_id', true);
    const session = raceSessions.get(raceId);
    if (!session) {
      return interaction.reply('❌ 找不到該競賽');
    }
    if (session.participants.has(interaction.user.id)) {
      return interaction.reply('❌ 你已經加入該競賽');
    }
    session.participants.set(interaction.user.id, { score: 0, answers: [] });
    await interaction.reply(`✅ 已加入競賽！`);
  }

  // /start
  else if (commandName === 'start') {
    const raceId = options.getString('race_id', true);
    const session = raceSessions.get(raceId);
    if (!session) {
      return interaction.reply('❌ 找不到該競賽');
    }
    if (session.initiator !== interaction.user.id) {
      return interaction.reply('❌ 只有發起者可以開始競賽');
    }
    await sendRaceQuestion(interaction, raceId, 0);
  }
}

// Move handleAutocomplete outside the hoksip object
async function handleAutocomplete(interaction) {
  const { commandName } = interaction;
  
  if (commandName === 'review' || commandName === 'study') {
    const focusedValue = interaction.options.getFocused();
    
    // Get user's subjects using the hoksip object
    const subjects = await new Promise((resolve, reject) => {
      hoksip.getUserSubjects(interaction.user.id, (err, subjects) => {
        if (err) reject(err);
        else resolve(subjects);
      });
    });

    // Filter subjects based on user input
    const filtered = subjects
      .filter(subject => subject.toLowerCase().includes(focusedValue.toLowerCase()))
      .slice(0, 25); // Discord has a limit of 25 choices

    await interaction.respond(
      filtered.map(subject => ({ name: subject, value: subject }))
    );
  }
}

// Add sendReviewQuestion function
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
      .setCustomId(`review_seen_${userId}_${sub}_${batch.date}_${idx}`)
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

// Add button interaction handler
async function handleButtonInteraction(interaction) {
  const customId = interaction.customId;
  
  // Handle review buttons
  if (customId.startsWith('review_seen_') || customId.startsWith('review_delete_')) {
    const [, action, userId, sub, date, idx] = customId.split('_');
    const session = activeReviews.get(userId);
    
    if (!session) {
      return interaction.update({
        content: '❌ 複習階段已結束',
        embeds: [],
        components: []
      });
    }

    if (action === 'delete') {
      // Delete the sentence
      const sentence = session.batches[session.batchIdx].sentences[session.idx];
      hoksip.deleteSentence(sentence.id, async (err) => {
        if (err) {
          console.error('Error deleting sentence:', err);
          return interaction.update({
            content: '❌ 刪除失敗',
            embeds: [],
            components: []
          });
        }
        
        // Move to next sentence
        session.idx++;
        if (session.idx >= session.batches[session.batchIdx].sentences.length) {
          session.batchIdx++;
          session.idx = 0;
        }
        
        if (session.batchIdx >= session.batches.length) {
          activeReviews.delete(userId);
          return interaction.update({
            embeds: [new EmbedBuilder()
              .setTitle(`✨ 複習結束！`)
              .setDescription(`科目【${sub}】已複習完畢！`)
              .setFooter({ text: '點仔算 Tiamasng' })],
            components: [new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId('review_done').setLabel('結束').setStyle(ButtonStyle.Primary)
            )]
          });
        }
        
        // Send next question
        sendReviewQuestion(interaction, userId, sub, session.idx, session.batches[session.batchIdx], session.batches.length, null, true);
      });
    } else {
      // Mark as seen and move to next
      session.idx++;
      if (session.idx >= session.batches[session.batchIdx].sentences.length) {
        session.batchIdx++;
        session.idx = 0;
      }
      
      if (session.batchIdx >= session.batches.length) {
        activeReviews.delete(userId);
        return interaction.update({
          embeds: [new EmbedBuilder()
            .setTitle(`✨ 複習結束！`)
            .setDescription(`科目【${sub}】已複習完畢！`)
            .setFooter({ text: '點仔算 Tiamasng' })],
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('review_done').setLabel('結束').setStyle(ButtonStyle.Primary)
          )]
        });
      }
      
      // Send next question
      sendReviewQuestion(interaction, userId, sub, session.idx, session.batches[session.batchIdx], session.batches.length, null, true);
    }
  }
  // Handle review done button
  else if (customId === 'review_done') {
    const userId = interaction.user.id;
    activeReviews.delete(userId);

    // Add points for completing review
    addPointWithStreak(userId).then(({ points, streakDay, bonusGiven }) => {
      const bonusText = bonusGiven > 0 ? `\n🎉 連續第 ${streakDay} 天打卡，加碼 🪙+${bonusGiven}` : '';
      return interaction.reply({
        content: `複習已結束，請繼續加油！\n✅ 你好棒！今天也來複習了\n<@${userId}> 完成練習，獲得 🪙+1${bonusText}\n目前總點數：🪙${points}\n連續練習天數：${streakDay}天`,
        embeds: [],
        components: [],
        allowedMentions: { users: [userId] }
      });
    }).catch(err => {
      console.error('Error adding points:', err);
      return interaction.reply({
        content: `複習已結束，請繼續加油！\n✅ 你好棒！今天也來複習了\n<@${userId}> 完成練習，獲得 🪙+1\n目前總點數：查詢失敗\n連續練習天數：查詢失敗`,
        embeds: [],
        components: [],
        allowedMentions: { users: [userId] }
      });
    });
  }
}

// Export functions
module.exports = {
  addSentence: hoksip.addSentence,
  getAllSentences: hoksip.getAllSentences,
  getDueSentencesToday: hoksip.getDueSentencesToday,
  getSentencesByDateBatches: hoksip.getSentencesByDateBatches,
  handleReviewResult: hoksip.handleReviewResult,
  checkSubExist: hoksip.checkSubExist,
  getStats: hoksip.getStats,
  getUserSubjects: hoksip.getUserSubjects,
  deleteSentence: hoksip.deleteSentence,
  handleCommand,
  handleAutocomplete,
  handleButtonInteraction,
  sendReviewQuestion,
  activeReviews,
  activeTests,
  raceSessions
};
