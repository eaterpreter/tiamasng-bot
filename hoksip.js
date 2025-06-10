// hoksip.js
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

// 保證資料庫在 hoksip/hoksip.db
const DB_PATH = path.join(__dirname, 'hoksip', 'hoksip.db');

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('❌ 無法連線到資料庫:', err.message);
  } else {
    console.log('✅ 已連線到 hoksip/hoksip.db');
  }
});

// 一開始自動建立表格（如果不存在）
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
      success_count INTEGER DEFAULT 0
    )
  `, (err) => {
    if (err) {
      console.error('❌ 建立資料表失敗:', err.message);
    } else {
      console.log('✅ sentences 資料表已初始化');
    }
  });
});

// 封裝對外 API
const hoksip = {
  // 新增句子
  addSentence(user_id, original, translation, sub, callback) {
    const now = new Date().toISOString().split('T')[0]; // yyyy-mm-dd
    db.run(
      `INSERT INTO sentences (user_id, original, translation, sub, yesCount, exe_date, next_date, review_count, success_count)
       VALUES (?, ?, ?, ?, 0, ?, ?, 0, 0)`,
      [user_id, original, translation, sub, now, now],
      function (err) {
        callback && callback(err, this && this.lastID);
      }
    );
  },

  // 查找指定使用者&科目下所有句子
  getAllSentences(user_id, sub, callback) {
    db.all(
      `SELECT * FROM sentences WHERE user_id = ? AND sub = ? ORDER BY id ASC`,
      [user_id, sub],
      (err, rows) => callback(err, rows)
    );
  },

  // 查找今天到期要複習的句子
  getDueSentences(user_id, sub, callback) {
    const today = new Date().toISOString().split('T')[0];
    db.all(
      `SELECT * FROM sentences WHERE user_id = ? AND sub = ? AND next_date <= ? AND yesCount < 6 ORDER BY next_date ASC`,
      [user_id, sub, today],
      (err, rows) => callback(err, rows)
    );
  },

  // 回報複習結果
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

  // 科目重複判斷
  checkSubExist(user_id, sub, callback) {
    db.get(
      `SELECT 1 FROM sentences WHERE user_id = ? AND sub = ? LIMIT 1`,
      [user_id, sub],
      (err, row) => callback(err, !!row)
    );
  },

  // 各熟練度統計
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

  // 取得現有科目清單（Autocomplete用）
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
