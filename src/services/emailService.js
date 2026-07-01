const axios = require("axios");
const {
  CBS_EMAIL_URL, CBS_EMAIL_CHANNEL_ID, CBS_FROM_EMAIL, CBS_FROM_EMAIL_DISPLAY_NAME, CBS_EMAIL_EVENT,
  CBS_USERNAME, CBS_PASSWORD,
} = require("../configs/variables");

const generateReferenceNumber = () => {
  const date = new Date();
  const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
  const randomPart = Math.random().toString(36).substring(2, 7).toUpperCase();
  return `VBRM-${dateStr}-${randomPart}`;
};

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

const sendViaCBS = async ({ email, customerName, subject, content, refNo }) => {
  await axios.post(
    CBS_EMAIL_URL,
    {
      fromEmailDisplayName: CBS_FROM_EMAIL_DISPLAY_NAME,
      refNo,
      emailEvent: CBS_EMAIL_EVENT || "OTP",
      emailContent: content,
      emailSubject: subject,
      email,
      customerName: customerName || "Valued Customer",
      channelId: CBS_EMAIL_CHANNEL_ID || "101",
      fromEmail: CBS_FROM_EMAIL,
    },
    {
      timeout: 8000,
      auth: { username: CBS_USERNAME, password: CBS_PASSWORD },
    }
  );
};

const sendPostCallSummaryEmail = async (callData) => {
  const { customerEmail, customerName, referenceNumber, managerName, startTime, duration, status } = callData;

  if (!customerEmail) {
    console.log('No customer email provided, skipping summary email');
    return false;
  }

  try {
    const callDate = new Date(startTime).toLocaleDateString('en-BD', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });
    const callTime = new Date(startTime).toLocaleTimeString('en-BD', {
      hour: '2-digit', minute: '2-digit', hour12: true,
    });

    const content =
      `Dear ${customerName || 'Valued Customer'},\n\n` +
      `Your video banking session has been completed.\n\n` +
      `Reference Number: ${referenceNumber}\n` +
      `Date: ${callDate}\n` +
      `Time: ${callTime}\n` +
      `Duration: ${formatDuration(duration)}\n` +
      `Relationship Manager: ${managerName || 'Our Representative'}\n` +
      `Status: ${status === 'completed' ? 'Successfully Completed' : status}\n\n` +
      `Thank you for banking with Mutual Trust Bank.`;

    await sendViaCBS({
      email: customerEmail,
      customerName,
      subject: `Video Banking Session Summary - Ref: ${referenceNumber}`,
      content,
      refNo: referenceNumber,
    });

    console.log(`✅ Post-call summary sent to ${customerEmail} - Ref: ${referenceNumber}`);
    return true;
  } catch (error) {
    console.error(`❌ Failed to send post-call summary email: ${error.message}`);
    return false;
  }
};

const sendCallReferenceEmail = async (data) => {
  const { customerEmail, customerName, referenceNumber, managerName } = data;

  if (!customerEmail) return false;

  try {
    const content =
      `Dear ${customerName || 'Valued Customer'},\n\n` +
      `Your video banking session reference number is: ${referenceNumber}\n\n` +
      `Relationship Manager: ${managerName || 'Our Representative'}\n\n` +
      `Please keep this reference number for your records.\n\n` +
      `Thank you for banking with Mutual Trust Bank.`;

    await sendViaCBS({
      email: customerEmail,
      customerName,
      subject: `Your Video Banking Reference Number: ${referenceNumber}`,
      content,
      refNo: referenceNumber,
    });

    console.log(`✅ Reference email sent to ${customerEmail}`);
    return true;
  } catch (error) {
    console.error(`❌ Failed to send reference email: ${error.message}`);
    return false;
  }
};

module.exports = {
  generateReferenceNumber,
  formatDuration,
  sendPostCallSummaryEmail,
  sendCallReferenceEmail,
};
