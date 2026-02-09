const NodeCache = require("node-cache");
// TTL of 300 seconds (5 minutes) to give users enough time
const otpCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

module.exports = { otpCache };
