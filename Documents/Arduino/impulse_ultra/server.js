const express = require('express');
const sqlite3 = require('sqlite3');
const bcrypt = require('bcrypt');
const bodyParser = require('body-parser');
const path = require('path');
const WebSocket = require('ws');
// mDNS for automatic server discovery
const mdns = require('multicast-dns');

const app = express();
const port = 3000;

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Serve static files from data directory
app.use(express.static(path.join(__dirname, 'data')));

// Database connection
const db = new sqlite3.Database('scores.db');

// In-memory scoring for current session
let currentScore = 0;
let measuring = false;
let baseline = 0; // Baseline acceleration when measurement starts
let baselineSet = false; // Flag to check if baseline is set

// Routes

// Register
app.post('/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password || username.length < 3 || password.length < 6) {
    return res.json({ success: false, message: '아이디는 3자 이상, 비밀번호는 6자 이상이어야 합니다.' });
  }

  bcrypt.hash(password, 10, (err, hash) => {
    if (err) return res.status(500).json({ error: 'Hash error' });

    db.run('INSERT INTO users (username, password_hash) VALUES (?, ?)', [username, hash], function(err) {
      if (err) {
        if (err.code === 'SQLITE_CONSTRAINT') {
          return res.json({ success: false, message: '이미 존재하는 아이디입니다.' });
        }
        return res.status(500).json({ error: 'Database error' });
      }
      res.json({ success: true, message: '회원가입 성공! 로그인해주세요.' });
    });
  });
});

// Login
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  db.get('SELECT id, password_hash FROM users WHERE username = ?', [username], (err, row) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    if (!row) return res.json({ success: false, message: '아이디나 비밀번호가 잘못되었습니다.' });

    bcrypt.compare(password, row.password_hash, (err, match) => {
      if (err) return res.status(500).json({ error: 'Hash error' });
      if (!match) return res.json({ success: false, message: '아이디나 비밀번호가 잘못되었습니다.' });
      res.json({ success: true, user_id: row.id, username });
    });
  });
});

// Reset score (start measurement)
app.get('/reset', (req, res) => {
  currentScore = 0;
  measuring = true;
  baseline = 0; // Reset baseline
  baselineSet = false; // Reset baseline flag
  res.json({ message: 'Score reset' });
});

// Get current score
app.get('/score', (req, res) => {
  res.json({ score: currentScore });
});

//// Receive sensor data from ESP32
app.post('/sensor', (req, res) => {
  if (!measuring) return res.json({ message: 'Not measuring' });

  const { accel_x, accel_y, accel_z } = req.body;
  // Compute impulse - simple: max magnitude
  const magnitude = Math.sqrt(accel_x**2 + accel_y**2 + accel_z**2);
  // Subtract gravity (assuming 9.81 m/s2 down z)
  const magnitude_adjusted = Math.abs(magnitude - 9.81);

  // Set baseline on first data, then calculate relative impact
  if (baseline === 0) {
    // First data - set as baseline (current position when measurement starts)
    baseline = magnitude_adjusted;
    console.log('Baseline set to:', baseline);
    currentScore = 0; // Score starts from 0
  } else {
    // Subsequent data - calculate relative impact from baseline
    const relativeImpact = Math.max(0, magnitude_adjusted - baseline);
    // Update currentScore based on impact difference - only if significant
    if (relativeImpact > 1.5) {
      currentScore = Math.max(currentScore, Math.floor(relativeImpact * 100)); // scale to points
    }
  }

  res.json({ message: 'Data received', score: currentScore });
});

// Get rankings
app.get('/rankings', (req, res) => {
  db.all(`SELECT username, best_score FROM users WHERE best_score > 0 ORDER BY best_score DESC LIMIT 10`, (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json({ rankings: rows });
  });
});

// Save score for user
app.post('/save-score', (req, res) => {
  const { user_id, score } = req.body;
  db.run('INSERT INTO scores (user_id, score) VALUES (?, ?)', [user_id, score], function(err) {
    if (err) return res.status(500).json({ error: 'Save error' });

    // Update best score
    db.run('UPDATE users SET best_score = MAX(best_score, ?) WHERE id = ?', [score, user_id]);

    res.json({ message: 'Score saved' });
  });
});

// Get user best score
app.get('/user-score/:user_id', (req, res) => {
  const user_id = req.params.user_id;
  db.get('SELECT best_score FROM users WHERE id = ?', [user_id], (err, row) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json({ score: row ? row.best_score : 0 });
  });
});

// Get all scores for a user
app.get('/user-scores/:user_id', (req, res) => {
  const user_id = req.params.user_id;
  db.all('SELECT score FROM scores WHERE user_id = ? ORDER BY timestamp', [user_id], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    const scores = rows.map(row => row.score);
    res.json({ scores: scores });
  });
});

// Get global statistics (all users' best scores, not individual measurements)
app.get('/global-stats', (req, res) => {
  db.all('SELECT best_score FROM users WHERE best_score > 0 ORDER BY best_score DESC', (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    if (rows.length === 0) {
      return res.json({ best_score: 0, average: 0 });
    }
    const bestScores = rows.map(row => row.best_score);
    const globalBestScore = bestScores[0]; // First item is highest since ordered DESC
    const globalAverage = Math.round(bestScores.reduce((a, b) => a + b, 0) / bestScores.length);
    res.json({ best_score: globalBestScore, average: globalAverage });
  });
});

const server = app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
  console.log(`Server available at: http://impulse-server.local:${port}`);
});

// Advertise server via mDNS
const mdns_server = mdns();
mdns_server.on('query', (query) => {
  // Respond to mDNS queries for our service
  const answers = [];
  query.questions.forEach((question) => {
    if (question.name === 'impulse-server') {
      answers.push({
        name: 'impulse-server',
        type: 'A',
        ttl: 300,
        data: server.address().address // Get local IP
      });
    }
  });
  mdns_server.respond(answers);
});

// WebSocket server for real-time sensor data
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log('ESP32 connected via WebSocket');

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'sensor' && measuring) {
        const { accel_x, accel_y, accel_z } = data;
        const magnitude = Math.sqrt(accel_x**2 + accel_y**2 + accel_z**2);
        const magnitude_adjusted = Math.abs(magnitude - 9.81);

        // Calculate relative impact using baseline
        if (!baselineSet) {
          // First WebSocket data - set as baseline
          baseline = magnitude_adjusted;
          baselineSet = true;
          console.log('WebSocket baseline set to:', baseline);
          currentScore = 0;
        } else {
          // Calculate relative impact from baseline
          const relativeImpact = magnitude_adjusted - baseline;
          // Optional: Uncomment for detailed debugging
          // console.log(`WS data: ${magnitude_adjusted}, baseline: ${baseline}, relative: ${relativeImpact}`);

          // Accumulate maximum impact during measurement (측정 시간 중 최대 충격량 추적)
          if (relativeImpact > 1.5) { // Only if there's significant impact beyond noise
            const impactScore = Math.floor(relativeImpact * 100);
            currentScore = Math.max(currentScore, impactScore);
            console.log('WS Updated max score:', currentScore, 'from impact:', relativeImpact);
          }
        }
      }
    } catch (err) {
      console.error('WebSocket message error:', err);
    }
  });

  ws.on('close', () => {
    console.log('ESP32 disconnected');
  });
});
