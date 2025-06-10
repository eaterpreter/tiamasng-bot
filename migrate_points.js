// migrate_points.js
const fs = require('fs');

const oldFile = './points.json';
const newFile = './users.json';

console.log("🚀 啟動轉換器...");

if (!fs.existsSync(oldFile)) {
  console.log('❌ 找不到 points.json，請確認檔案存在再試一次。');
  process.exit();
}

const oldData = JSON.parse(fs.readFileSync(oldFile, 'utf8'));
const newData = {};

for (const userId in oldData) {
  const point = oldData[userId];
  newData[userId] = {
    points: point,
    streakDay: 0,
    lastCheckInDate: '',
    todayBonusGiven: false,
    history: [
      {
        timestamp: new Date().toISOString(),
        delta: point
      }
    ]
  };
}

ffs.writeFileSync(newFile, JSON.stringify(newData, null, 2));
console.log(`✅ 已成功將 points.json 轉換成 users.json，使用者數：${Object.keys(newData).length}`);
