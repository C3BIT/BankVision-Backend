const nodemailer = require("nodemailer");
const hbs = require("nodemailer-express-handlebars");
const path = require("path");
const { emailHost, emailPort, emailId, emailPassword } = require("./variables");

// Create transporter with better error handling
let transporter;

if (emailHost && emailId && emailPassword) {
  try {
    transporter = nodemailer.createTransport({
      host: emailHost,
      port: Number(emailPort) || 465,
      secure: Number(emailPort) === 465, // true for 465, false for other ports
      auth: {
        user: emailId,
        pass: emailPassword,
      },
      debug: true,
      logger: true,
      tls: {
        rejectUnauthorized: false,
        ciphers: 'SSLv3',
      },
      // Add connection timeout - increased for slower connections
      connectionTimeout: 30000, // 30 seconds
      greetingTimeout: 30000,
      socketTimeout: 30000,
      // Additional options for better compatibility
      requireTLS: false,
      debug: false,
      logger: false,
    });

    // Verify connection on startup (non-blocking, don't wait for it)
    console.log(`🔍 [DEBUG] SMTP Init: host=${emailHost}, user=${emailId}, passLength=${emailPassword ? emailPassword.length : 0}`);
    transporter.verify((error, success) => {
      if (error) {
        const maskedId = emailId ? emailId.replace(/(.{2}).*(@.*)/, "$1***$2") : 'unknown';
        console.error(`❌ Email transporter verification failed for ${emailHost} (${maskedId}):`, error.message);
        console.warn('⚠️ Email OTP may not work. Verification will be attempted on first send.');
        // Don't set transporter to null - let it try on actual send
      } else {
        console.log(`✅ Email transporter verified successfully for ${emailHost}`);
      }
    });
  } catch (error) {
    console.error('❌ Failed to create email transporter:', error.message);
    transporter = null;
  }
} else {
  console.warn('⚠️ Email credentials not configured (EMAIL_HOST, EMAIL_ID, EMAIL_PASSWORD)');
  console.warn('⚠️ Email OTP will not work. Please configure email settings in environment variables.');
  transporter = null;
}

const handlebarOptions = {
  viewEngine: {
    extName: ".hbs",
    partialsDir: path.resolve(__dirname, "../views"),
    layoutsDir: path.resolve(__dirname, "../views"),
    defaultLayout: false,
  },
  viewPath: path.resolve(__dirname, "../views"),
  extName: ".hbs",
};

if (transporter) {
  transporter.use("compile", hbs(handlebarOptions));
}

module.exports = { transporter };
