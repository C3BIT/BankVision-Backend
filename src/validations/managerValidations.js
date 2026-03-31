const Joi = require("joi");

const managerRegistrationSchema = Joi.object({
  name: Joi.string().max(50).required(),
  email: Joi.string().email().max(100).required(),
  password: Joi.string().min(6).max(255).required(),
});
const loginSchema = Joi.object({
  email: Joi.string().email().max(100).required(),
  password: Joi.string().min(6).max(255).required(),
});
module.exports = { managerRegistrationSchema, loginSchema };
