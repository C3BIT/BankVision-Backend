/**
 * Email Service
 * Handles sending various email notifications
 */
const { transporter } = require("../configs/mail_smtp");
const { emailId } = require("../configs/variables");

const EMAIL_SENDER = `"Video Banking Support" <${emailId}>`;

/**
 * Generate a unique reference number
 * Format: VBRM-YYYYMMDD-XXXXX (e.g., VBRM-20251215-A7B2C)
 */
const generateReferenceNumber = () => {
  const date = new Date();
  const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
  const randomPart = Math.random().toString(36).substring(2, 7).toUpperCase();
  return `VBRM-${dateStr}-${randomPart}`;
};

/**
 * Format duration from seconds to readable string
 */
const formatDuration = (seconds) => {
  if (!seconds || seconds < 0) return '0 minutes';

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const parts = [];
  if (hours > 0) parts.push(`${hours} hour${hours > 1 ? 's' : ''}`);
  if (minutes > 0) parts.push(`${minutes} minute${minutes > 1 ? 's' : ''}`);
  if (secs > 0 && hours === 0) parts.push(`${secs} second${secs > 1 ? 's' : ''}`);

  return parts.length > 0 ? parts.join(' ') : '0 minutes';
};

/**
 * Send post-call summary email to customer
 * @param {object} callData - Call log data
 * @returns {Promise<boolean>} - Success status
 */
const sendPostCallSummaryEmail = async (callData) => {
  const {
    customerEmail,
    customerName,
    referenceNumber,
    managerName,
    startTime,
    endTime,
    duration,
    status
  } = callData;

  if (!customerEmail) {
    console.log('No customer email provided, skipping summary email');
    return false;
  }

  try {
    const callDate = new Date(startTime).toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });

    const callTime = new Date(startTime).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });

    const mailOptions = {
      from: EMAIL_SENDER,
      to: customerEmail,
      subject: `Video Banking Session Summary - Ref: ${referenceNumber}`,
      template: 'callSummary',
      context: {
        customerName: customerName || 'Valued Customer',
        referenceNumber,
        callDate,
        callTime,
        duration: formatDuration(duration),
        managerName: managerName || 'Our Representative',
        status: status === 'completed' ? 'Successfully Completed' : status,
        year: new Date().getFullYear()
      }
    };

    await transporter.sendMail(mailOptions);
    console.log(`Post-call summary email sent to ${customerEmail} - Ref: ${referenceNumber}`);
    return true;
  } catch (error) {
    console.error(`Failed to send post-call summary email: ${error.message}`);
    return false;
  }
};

/**
 * Send call reference number during the call
 * @param {object} data - Call data
 * @returns {Promise<boolean>} - Success status
 */
const sendCallReferenceEmail = async (data) => {
  const { customerEmail, customerName, referenceNumber, managerName } = data;

  if (!customerEmail) {
    return false;
  }

  try {
    const mailOptions = {
      from: EMAIL_SENDER,
      to: customerEmail,
      subject: `Your Video Banking Reference Number: ${referenceNumber}`,
      template: 'callReference',
      context: {
        customerName: customerName || 'Valued Customer',
        referenceNumber,
        managerName: managerName || 'Our Representative',
        year: new Date().getFullYear()
      }
    };

    await transporter.sendMail(mailOptions);
    console.log(`Reference number email sent to ${customerEmail}`);
    return true;
  } catch (error) {
    console.error(`Failed to send reference email: ${error.message}`);
    return false;
  }
};

module.exports = {
  generateReferenceNumber,
  formatDuration,
  sendPostCallSummaryEmail,
  sendCallReferenceEmail
};
