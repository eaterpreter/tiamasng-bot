const fs = require('fs');

const userFile = './users.json';

function getTodayDate() {
  const now = new Date();
  return new Date(now.getTime() - (now.getTimezoneOffset() * 60000))
    .toISOString()
    .split('T')[0];
}

async function addPointWithStreak(userId) {
  try {
    const users = JSON.parse(fs.readFileSync(userFile, 'utf8'));
    const today = getTodayDate();
    
    // Initialize new user if needed
    if (!users[userId]) {
      users[userId] = {
        points: 0,
        streakDay: 0,
        lastCheckInDate: '',
        todayBonusGiven: false
      };
    }
    
    const user = users[userId];
    
    // Add base point
    user.points += 1;
    
    // Calculate bonus points
    let bonus = 0;
    if (!user.todayBonusGiven || user.lastCheckInDate !== today) {
      const lastDate = user.lastCheckInDate;
      const diffDays = lastDate ? Math.floor((new Date(today) - new Date(lastDate)) / (1000 * 60 * 60 * 24)) : Infinity;
      user.streakDay = diffDays === 1 ? user.streakDay + 1 : 1;
      
      // Bonus points for streaks
      if (user.streakDay % 10 === 0) bonus += 3;  // Every 10 days
      if (user.streakDay % 5 === 0) bonus += 2;   // Every 5 days
      if (user.streakDay % 3 === 0) bonus += 1;   // Every 3 days
      
      user.points += bonus;
      user.todayBonusGiven = true;
      user.lastCheckInDate = today;
    }
    
    // Save changes
    fs.writeFileSync(userFile, JSON.stringify(users, null, 2));
    
    return { 
      points: user.points, 
      streakDay: user.streakDay,
      bonusGiven: bonus 
    };
  } catch (err) {
    console.error('Error updating points:', err);
    throw err;
  }
}

module.exports = {
  getTodayDate,
  addPointWithStreak
}; 