const sqlite3 = require('sqlite3');
const db = new sqlite3.Database('scores.db');

// Create tables
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    best_score INTEGER DEFAULT 0
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    score INTEGER NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);

  // Insert sample users
  const bcrypt = require('bcrypt');
  const users = [
    { username: 'admin', password: 'admin123' },
    { username: 'user1', password: 'pass1' },
    { username: 'player1', password: 'player' },
    { username: 'player2', password: 'player' },
    { username: 'player3', password: 'player' },
    { username: 'player4', password: 'player' }
  ];

  let promises = users.map(user => {
    return new Promise((resolve, reject) => {
      bcrypt.hash(user.password, 10, (err, hash) => {
        if (err) reject(err);
        db.run('INSERT OR IGNORE INTO users (username, password_hash) VALUES (?, ?)', [user.username, hash], resolve);
      });
    });
  });

  Promise.all(promises).then(() => {
    // Insert sample scores
    db.run(`INSERT OR IGNORE INTO scores (user_id, score) VALUES
      ((SELECT id FROM users WHERE username = 'player1'), 1980000000),
      ((SELECT id FROM users WHERE username = 'player2'), 195),
      ((SELECT id FROM users WHERE username = 'player3'), 187),
      ((SELECT id FROM users WHERE username = 'player4'), 175)`);

    // Update best scores
    db.run(`UPDATE users SET best_score = (
      SELECT MAX(score) FROM scores WHERE user_id = users.id
    ) WHERE id IN (SELECT user_id FROM scores)`);

    console.log('Database initialized');
    db.close();
  }).catch(console.error);
});
