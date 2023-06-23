// server.js


const express = require('express');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');

const app = express();

app.use(bodyParser.json());

app.listen(3000, () => console.log('Server listening on port 3000'));

app.use(express.static(__dirname));

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
    max: 300000 // Score should be no larger than 300000
  },
  language: String,
  WPM: Number,
  keystrokes: Number,
  typos: Number, 
  mode: String, 
  precision: Number, 
  timeElapsed: Number, 
  timestamp: { type: Date, default: Date.now, expires: '30d' } 
  

});



let supportedLanguages;
try {
  supportedLanguages = JSON.parse(fs.readFileSync('./words/languagelist.json', 'utf8'));
} catch (err) {
  console.error('Failed to load languages.json', err);
}

app.get('/languages', (req, res) => {
  res.send(supportedLanguages);
});

const Score = mongoose.model('Score', ScoreSchema);

let supportedWPMs = [30, 50, 100, 150, 200, 250, 300, 350, 400];
app.post('/score', async (req, res) => {
  const { token, keystrokes, timeElapsed, typos, mode, ...scoreData } = req.body; // Include typos and mode in destructuring

  // Token validation
  if (!tokens.includes(token)) {
    return res.status(403).send('Invalid token');
  }

    // Score validation
    if (!validateScore(scoreData.score, keystrokes, timeElapsed)) {
        return res.status(400).send('Invalid score');
    }

  // Additional input validations
  if (typeof scoreData.name !== 'string' || scoreData.name.length === 0 || scoreData.name.length > 30) {
    return res.status(400).send('Invalid name');
  }
  
  // Typos validation
  if (typeof typos !== 'number' || !Number.isInteger(typos) || typos < 0 || typos > keystrokes) {
    return res.status(400).send('Invalid typos');
  }

  // Mode validation
  if (typeof mode !== 'string' || !['rage', 'precision'].includes(mode)) {
    return res.status(400).send('Invalid mode');
  }
  
  // Calculate precision
  const precision = ((keystrokes - typos) / keystrokes) * 100;
  
  // Validate precision
  if (typeof precision !== 'number' || precision < 0 || precision > 100) {
    return res.status(400).send('Invalid precision');
  }
  
  if (typeof scoreData.score !== 'number' || !Number.isInteger(scoreData.score) || scoreData.score < 0 || scoreData.score > 300000) {
    return res.status(400).send('Invalid score');
  }

  if (!supportedLanguages.includes(scoreData.language)) {
    return res.status(400).send('Invalid language');
  }

  if (!supportedWPMs.includes(scoreData.WPM)) {
    return res.status(400).send('Invalid WPM');
  }

  // Create new scoreData including keystrokes and timeElapsed
  const newScoreData = {
    ...scoreData,
    keystrokes,
    timeElapsed,
    typos,
    mode,
    precision,
  };

  // Find the highest score for the given name, WPM, and language
  const highestScoreEntry = await Score.findOne({ name: scoreData.name, WPM: scoreData.WPM, language: scoreData.language }).sort({ score: -1 });

  if (highestScoreEntry) {
    const highestScore = highestScoreEntry.score;

    // If the new score is less than or equal to the highest score, return a response saying the new score should be higher.
    if (scoreData.score <= highestScore) {
      return res.status(400).send('Score should be higher than the previous best score');
    }

    // If the new score is higher, delete all scores with the same name, language, and WPM but with a score lower than the previous highest score
    await Score.deleteMany({ 
      name: scoreData.name, 
      WPM: scoreData.WPM, 
      language: scoreData.language, 
      score: { $lte: highestScore }
    });
  }

  

  const newScore = new Score(newScoreData);
  try {
    const score = await newScore.save();
    tokens = tokens.filter(t => t !== token);  // Remove the used token
    return res.status(200).send(score);
  } catch (err) {
    return res.status(500).send(err);
  }
});


try {
    var validateScore = require('./scoreValidator');
} catch (err) {
    console.warn('Score validator not found, score validation will be bypassed in this environment.');

    // Define a placeholder function that always returns true
    validateScore = () => true;
}

// import motivation.json
let motivationalMessages;
try {
  motivationalMessages = JSON.parse(fs.readFileSync('./words/motivation.json', 'utf8'));
} catch (err) {
  console.error('Failed to load motivation.json', err);
}

// modified leaderboard endpoint
app.get('/leaderboard/:language/:WPM', async (req, res) => {
  const WPM = Number(req.params.WPM);  // Ensure WPM is a number for matching
  if (!supportedWPMs.includes(WPM)) {
    const randomIndex = Math.floor(Math.random() * motivationalMessages.length);
    return res.status(200).send({ message: motivationalMessages[randomIndex] });
  }
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const skip = (page - 1) * limit;

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
          maxPrecision: { $max: "$precision" },  // Get maximum precision
          doc: { $first: "$$ROOT" }  // Keep the whole document of the first entry
        }
      },
      {
        $addFields: {
          "doc.score": "$maxScore",  // Replace the score in the document with the maximum score
          "doc.precision": "$maxPrecision"  // Replace the precision in the document with the maximum precision
        }
      },
      {
        $replaceRoot: {
          newRoot: "$doc"  // Replace the root document with the modified document
        }
      },
      {
        $sort: {
          score: -1,  // Sort by score in descending order
          precision: -1  // Sort by precision in descending order
        }
      },
      {
        $skip: skip
      },
      {
        $limit: limit
      }
    ]);

    return res.status(200).send(scores);
  } catch (err) {
    return res.status(500).send(err);
  }
});
