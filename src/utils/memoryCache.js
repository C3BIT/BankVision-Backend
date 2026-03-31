const NodeCache = require("node-cache");

const userCache = new NodeCache();

module.exports = { userCache };