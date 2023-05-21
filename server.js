// server.js

const express = require('express');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const path = require('path');

// Initialize express app
const app = express();

// Set up body parser to parse JSON body data
app.use(bodyParser.json());

app.listen(3000, () => console.log('Server listening on port 3000'));

// Serve static files from the current directory
app.use(express.static(__dirname));

// Connect to MongoDB
mongoose.connect('mongodb://127.0.0.1:27017/typing_game', {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => {
  console.log('MongoDB Connected')
})
.catch(err => {
  console.error('Failed to connect to MongoDB', err)
});


const ScoreSchema = new mongoose.Schema({
  name: String,
  score: Number,
  language: String,
  WPM: Number,
  timestamp: { type: Date, default: Date.now, expires: '30d' }  // Add expires: '30d'
});

const Score = mongoose.model('Score', ScoreSchema);


// POST /score endpoint to save a new score
app.post('/score', async (req, res) => {
  const newScore = new Score(req.body);
  try {
    const score = await newScore.save();
    return res.status(200).send(score);
  } catch (err) {
    return res.status(500).send(err);
  }
});


// GET /leaderboard/:language/:WPM endpoint to retrieve the leaderboard
app.get('/leaderboard/:language/:WPM', async (req, res) => {
  try {
    const scores = await Score.find({ language: req.params.language, WPM: req.params.WPM })
      .sort({ score: -1 })
      .limit(100);
    return res.status(200).send(scores);
  } catch (err) {
    return res.status(500).send(err);
  }
});
