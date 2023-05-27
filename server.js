// server.js


const express = require('express');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const path = require('path');

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
  timeElapsed: Number, // Add this line
  timestamp: { type: Date, default: Date.now, expires: '30d' } 
});



const Score = mongoose.model('Score', ScoreSchema);


app.post('/score', async (req, res) => {
	const { token, keystrokes, timeElapsed, ...scoreData } = req.body;

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
  
  if (typeof scoreData.score !== 'number' || !Number.isInteger(scoreData.score) || scoreData.score < 0 || scoreData.score > 9999) {
    return res.status(400).send('Invalid score');
  }

  const supportedLanguages = [
    "english",
    "french",
	"english_450k",
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

  // Create new scoreData including keystrokes and timeElapsed
  const newScoreData = {
    ...scoreData,
    keystrokes,
    timeElapsed,
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
      score: { $lte: highestScore } // note that I've changed $lt to $lte
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

function validateScore(score, keystrokes, timeElapsed) {
	// A simple rule might be that each score point requires at least 5 keystrokes
	// and takes at least 1 second (1000 ms)
	const minimumKeystrokes = score * 4;
	const minimumTimeElapsed = score * 140; // in milliseconds

	return keystrokes >= minimumKeystrokes && timeElapsed >= minimumTimeElapsed;
}

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