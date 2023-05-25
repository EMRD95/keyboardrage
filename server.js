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

let tokens = [];
app.get('/token', (req, res) => {
  const token = Math.random().toString(36).substring(2);
  tokens.push(token);
  res.send({ token });
});


const ScoreSchema = new mongoose.Schema({
  name: { 
    type: String, 
    maxlength: 30 // Name should be no longer than 30 characters
  },
  score: { 
    type: Number,
    max: 9999 // Score should be no larger than 9999
  },
  language: String,
  WPM: Number,
  timestamp: { type: Date, default: Date.now, expires: '30d' } 
});

const Score = mongoose.model('Score', ScoreSchema);


// POST /score endpoint to save a new score
app.post('/score', async (req, res) => {
  const { token, ...scoreData } = req.body;

  // Token validation
  if (!tokens.includes(token)) {
    return res.status(403).send('Invalid token');
  }

  // Additional input validations
  if (typeof scoreData.name !== 'string' || scoreData.name.length === 0 || scoreData.name.length > 30) {
    return res.status(400).send('Invalid name');
  }
  
  if (typeof scoreData.score !== 'number' || !Number.isInteger(scoreData.score) || scoreData.score < 0 || scoreData.score > 9999) {
    return res.status(400).send('Invalid score');
  }

  const supportedLanguages = [
    "english",
    "french",
    "albanian",
    "bulgarian",
    "catalan",
    "croatian",
    "czech",
    "danish",
    "dutch",
    "esperanto",
    "estonian",
    "finnish",
    "german",
    "hungarian",
    "irish",
    "italian",
    "latin",
    "latvian",
    "lithuanian",
    "macedonian",
    "polish",
    "portuguese",
    "romanian",
    "russian",
    "slovenian",
    "spanish",
    "swedish",
    "swiss_german",
    "welsh"
  ];
  if (!supportedLanguages.includes(scoreData.language)) {
    return res.status(400).send('Invalid language');
  }
  
  const supportedWPMs = [30, 50, 60, 70, 80, 100, 120, 130, 150, 180, 200, 220, 230, 250, 280, 300, 350, 400];
  if (!supportedWPMs.includes(scoreData.WPM)) {
    return res.status(400).send('Invalid WPM');
  }

  // Count the scores for the given name, WPM, and language
  const count = await Score.countDocuments({ name: scoreData.name, WPM: scoreData.WPM, language: scoreData.language });

  if (count >= 100) {
    // Delete the oldest score if there are already 100 scores
    const oldestScore = await Score.findOne({ name: scoreData.name, WPM: scoreData.WPM, language: scoreData.language }).sort({ timestamp: 1 });
    if (oldestScore) await oldestScore.remove();
  }

  const newScore = new Score(scoreData);
  try {
    const score = await newScore.save();
    tokens = tokens.filter(t => t !== token);  // Remove the used token
    return res.status(200).send(score);
  } catch (err) {
    return res.status(500).send(err);
  }
});



// GET /leaderboard/:language/:WPM endpoint to retrieve the leaderboard
app.get('/leaderboard/:language/:WPM', async (req, res) => {
  try {
    const scores = await Score.aggregate([
      {
        $match: {
          language: req.params.language,
          WPM: Number(req.params.WPM)  // Ensure WPM is a number for matching
        }
      },
      {
        $group: {
          _id: "$name",  // Group by name
          maxScore: { $max: "$score" },  // Get maximum score
          doc: { $first: "$$ROOT" }  // Keep the whole document of the first entry
        }
      },
      {
        $addFields: {
          "doc.score": "$maxScore"  // Replace the score in the document with the maximum score
        }
      },
      {
        $replaceRoot: {
          newRoot: "$doc"  // Replace the root document with the modified document
        }
      },
      {
        $sort: {
          score: -1  // Sort by score in descending order
        }
      },
      {
        $limit: 100  // Limit to 100 results
      }
    ]);

    return res.status(200).send(scores);
  } catch (err) {
    return res.status(500).send(err);
  }
});