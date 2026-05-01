// Vercel requires Serverless Functions to live in the root `api/` directory.
// This file delegates to the actual backend handler.
module.exports = require("../backend/api/index.js");

