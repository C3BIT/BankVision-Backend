const swaggerJsdoc = require("swagger-jsdoc");

const options = {
  definition: {
    openapi: "3.0.3",
    info: {
      title: "BankVision (VBRM) API",
      version: "1.0.0",
      description:
        "Video banking / KYC verification platform API — customer queueing, video call orchestration, OTP and face/signature verification, CBS integration, and admin/supervisor endpoints.",
    },
    servers: [
      { url: "https://bv-api.feedquix.com/api", description: "UAT" },
      { url: "http://localhost:5094/api", description: "Local" },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
      schemas: {
        Error: {
          type: "object",
          properties: {
            status: { type: "string", example: "error" },
            message: { type: "string" },
          },
        },
        Success: {
          type: "object",
          properties: {
            status: { type: "string", example: "success" },
            message: { type: "string" },
            data: { type: "object" },
          },
        },
      },
    },
    security: [{ bearerAuth: [] }],
  },
  apis: ["./src/routes/*.js"],
};

module.exports = swaggerJsdoc(options);
