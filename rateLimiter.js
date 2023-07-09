// rateLimiter.js

const rateLimit = require("express-rate-limit");

const scoreLimiter = rateLimit({
  windowMs: 10 * 500, // 5 seconds
  max: 1, // limit each IP to 1 request per windowMs
  message: "Too many score posted from this IP, please try again after 10 seconds"
});

module.exports = scoreLimiter;
