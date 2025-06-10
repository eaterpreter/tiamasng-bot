// hoksip.js
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = path.join(__dirname, 'hoksip', 'hoksip.db');
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('❌ 無法連線到資料庫:', err.message);
  } else {
    console.log('✅ 已連線到 hoksip/hoksip.db');
  }
});

// 初始化 sentences 表格（含 tts_url 欄位）
db.serialize(() => {
  db.run(`
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
      tts_url TEXT
    )
  `, (err) => {
    if (err) {
      console.error('❌ 建立資料表失敗:', err.message);
    } else {
      console.log('✅ sentences 資料表已初始化');
    }
  });
});

const hoksip = {
  // 新增句子（tts_url 可為 null/空字串）
  addSentence(user_id, original, translation, sub, tts_url = '', callback) {
    const now = new Date().toISOString().split('T')[0];
    db.run(
      `INSERT INTO sentences (user_id, original, translation, sub, yesCount, exe_date, next_date, review_count, success_count, tts_url)
       VALUES (?, ?, ?, ?, 0, ?, ?, 0, 0, ?)`,
      [user_id, original, translation, sub, now, now, tts_url],
      function (err) { callback && callback(err, this && this.lastID); }
    );
  },

  // 所有科目句子（給 debug / 批次查詢）
  getAllSentences(user_id, sub, callback) {
    db.all(
      `SELECT * FROM sentences WHERE user_id = ? AND sub = ? ORDER BY id ASC`,
      [user_id, sub],
      (err, rows) => callback(err, rows)
    );
  },

  // 【被動複習】抓今天到期的全部句子（next_date = 今天 && yesCount < 6），不分科
  getDueSentencesToday(user_id, callback) {
    const today = new Date().toISOString().split('T')[0];
    db.all(
      `SELECT * FROM sentences WHERE user_id = ? AND next_date = ? AND yesCount < 6 ORDER BY sub ASC, id ASC`,
      [user_id, today],
      (err, rows) => callback(err, rows)
    );
  },

  // 【主動複習】依科目，將同一 exe_date 分批（由近到遠）
  getSentencesByDateBatches(user_id, sub, callback) {
    db.all(
      'SELECT * FROM sentences WHERE user_id = ? AND sub = ? ORDER BY exe_date DESC, id ASC',
      [user_id, sub],
      (err, rows) => {
        if (err) return callback(err, null);
        // 批次分組
        const batchMap = {};
        rows.forEach(row => {
          const date = row.exe_date;
          if (!batchMap[date]) batchMap[date] = [];
          batchMap[date].push(row);
        });
        const sortedDates = Object.keys(batchMap).sort((a, b) => b.localeCompare(a));
        const batches = sortedDates.map(date => ({ date, sentences: batchMap[date] }));
        callback(null, batches);
      }
    );
  },

  // 回報複習結果（被動 isPassive=true，主動 isPassive=false）
  handleReviewResult(sentence_id, is_correct, isPassive, callback) {
    db.get(
      `SELECT yesCount FROM sentences WHERE id = ?`,
      [sentence_id],
      (err, row) => {
        if (err || !row) return callback && callback(err || new Error('找不到句子'));

        let yesCount = row.yesCount;
        let updateSql, next_date;
        const today = new Date().toISOString().split('T')[0];

        if (isPassive) {
          if (is_correct) yesCount = Math.min(yesCount + 1, 6);
          else yesCount = 0;
          const INTERVAL_RULES = [1, 2, 3, 5, 7, 10];
          const idx = Math.min(yesCount, INTERVAL_RULES.length - 1);
          next_date = new Date(Date.now() + INTERVAL_RULES[idx] * 86400000)
            .toISOString().split('T')[0];

          updateSql = `
            UPDATE sentences
            SET yesCount = ?, exe_date = ?, next_date = ?, review_count = review_count + 1,
                success_count = success_count + ?
            WHERE id = ?
          `;
        } else {
          updateSql = `
            UPDATE sentences
            SET review_count = review_count + 1
            WHERE id = ?
          `;
        }

        db.run(
          updateSql,
          isPassive
            ? [yesCount, today, next_date, is_correct ? 1 : 0, sentence_id]
            : [sentence_id],
          (err) => callback && callback(err)
        );
      }
    );
  },

  // 檢查科目有沒有重複
  checkSubExist(user_id, sub, callback) {
    db.get(
      `SELECT 1 FROM sentences WHERE user_id = ? AND sub = ? LIMIT 1`,
      [user_id, sub],
      (err, row) => callback(err, !!row)
    );
  },

  // 統計熟練度
  getStats(user_id, callback) {
    db.all(
      `SELECT sub, yesCount FROM sentences WHERE user_id = ?`,
      [user_id],
      (err, rows) => {
        if (err) return callback(err);
        const result = {};
        for (let row of rows) {
          if (!result[row.sub]) result[row.sub] = { not_familiar: 0, vague: 0, mastered: 0 };
          if (row.yesCount <= 2) result[row.sub].not_familiar++;
          else if (row.yesCount <= 5) result[row.sub].vague++;
          else result[row.sub].mastered++;
        }
        callback(null, result);
      }
    );
  },

  // autocomplete用：取得目前所有科目
  getUserSubjects(user_id, callback) {
    db.all(
      `SELECT DISTINCT sub FROM sentences WHERE user_id = ?`,
      [user_id],
      (err, rows) => {
        if (err) return callback(err, []);
        const subjects = rows.map(r => r.sub);
        callback(null, subjects);
      }
    );
  }
};

module.exports = hoksip;
