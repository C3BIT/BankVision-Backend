const Joi = require("joi");

const createCustomerSchema = Joi.object({
  mobileNumber: Joi.string().max(15).required(),
  email: Joi.string().email().max(100).required(),
  name: Joi.string().max(50).required(),
  address: Joi.string().max(50).required(),
  branch: Joi.string().max(50).required(),
  profileImage: Joi.string().max(255).required(),
});

module.exports = { createCustomerSchema };
