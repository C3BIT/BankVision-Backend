const bcrypt = require("bcryptjs");
const { Manager } = require("../models/Manager");

const registerManager = async ({ name, email, phone, password }) => {
  try {
    return await Manager.create({ name, email, phone, password });
  } catch (error) {
    throw error;
  }
};

const findManagerByEmail = async (email) => {
  return await Manager.findOne({ where: { email } });
};

module.exports = {
  findManagerByEmail,
  registerManager,
};
