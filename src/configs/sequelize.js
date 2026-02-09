const { Sequelize, Transaction } = require("sequelize");
const { DB_NAME, DB_USER, DB_PASS, DB_HOST, DB_PORT } = require("./variables");

const sequelize = new Sequelize(DB_NAME, DB_USER, DB_PASS, {
  host: DB_HOST,
  port: DB_PORT,
  dialect: "mysql",
  logging: false,
  dialectOptions: {
    decimalNumbers: true,
  },
  isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED,
});

(async () => {
  try {
    await sequelize.authenticate();
    console.log("✅ Database connected successfully.");
    await sequelize.sync({ force: false });
    console.log("✅ Tables synced successfully.");
  } catch (error) {
    console.error("❌ Unable to connect to the database:", error);
  }
})();

module.exports = sequelize;
