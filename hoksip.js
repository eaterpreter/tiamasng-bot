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

module.exports = hoksip;
