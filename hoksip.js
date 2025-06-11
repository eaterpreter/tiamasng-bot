// hoksip.js
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { promisify } = require('util');

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

// Convert callback-based functions to promises
const runAsync = promisify(db.run.bind(db));
const getAsync = promisify(db.get.bind(db));
const allAsync = promisify(db.all.bind(db));

// Initialize database schema
async function initSchema() {
  try {
    await runAsync(`
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
    await runAsync('CREATE INDEX IF NOT EXISTS idx_user_sub ON sentences(user_id, sub)');
    await runAsync('CREATE INDEX IF NOT EXISTS idx_next_date ON sentences(next_date)');
    
    console.log('✅ sentences 資料表已初始化');
  } catch (err) {
    console.error('❌ 建立資料表失敗:', err.message);
    throw err;
  }
}

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
      `SELECT yesCount FROM sentences WHERE id = ?`,
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
          db.run('UPDATE subjects SET mastered = mastered + 1 WHERE user_id = ? AND sub = ?',
            [row.user_id, row.sub], function(err) {
              if (err) {
                console.error('Error updating mastered count:', err);
                return callback(err);
              }
              // Delete the sentence
              db.run('DELETE FROM sentences WHERE id = ?', [sentence_id], callback);
            });
        } else {
          db.run(
            `UPDATE sentences 
             SET yesCount = ?, 
                 exe_date = ?, 
                 next_date = ?, 
                 review_count = review_count + 1,
                 success_count = success_count + ?,
                 updated_at = CURRENT_TIMESTAMP
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

  // Get stats with error handling
  getStats(user_id, callback) {
    if (!validateUserId(user_id)) {
      return callback(new Error('Invalid user_id'), null);
    }

    db.all(
      `SELECT sub, yesCount FROM sentences WHERE user_id = ?`,
      [user_id],
      (err, rows) => {
        if (err) {
          console.error('Error getting stats:', err);
          return callback(err);
        }

        try {
          const result = {};
          for (let row of rows) {
            if (!result[row.sub]) {
              result[row.sub] = { not_familiar: 0, vague: 0, mastered: 0 };
            }
            if (row.yesCount <= 2) result[row.sub].not_familiar++;
            else if (row.yesCount <= 5) result[row.sub].vague++;
            else result[row.sub].mastered++;
          }
          callback(null, result);
        } catch (err) {
          console.error('Error processing stats:', err);
          callback(err);
        }
      }
    );
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
  },

  // Update getStats to include mastered count
  getStats(userId, callback) {
    db.all(`
      SELECT 
        sub,
        COUNT(CASE WHEN yes_count >= 6 THEN 1 END) as mastered,
        COUNT(CASE WHEN yes_count < 6 AND (yes_count + no_count) >= 3 AND (yes_count / (yes_count + no_count)) >= 0.7 THEN 1 END) as familiar,
        COUNT(CASE WHEN yes_count < 6 AND (yes_count + no_count) >= 3 AND (yes_count / (yes_count + no_count)) < 0.7 THEN 1 END) as not_familiar,
        COUNT(CASE WHEN yes_count < 6 AND (yes_count + no_count) < 3 THEN 1 END) as vague
      FROM sentences 
      WHERE user_id = ? 
      GROUP BY sub
    `, [userId], function(err, rows) {
      if (err) {
        console.error('Error getting stats:', err);
        return callback(err);
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
  }
};

// Initialize database on startup
initDB()
  .then(initSchema)
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });

module.exports = hoksip;
