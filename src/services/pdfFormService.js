const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const path = require('path');
const fs = require('fs');

const FORMS_DIR = path.join(__dirname, '../assets/forms');
const BUCKET_NAME = process.env.MINIO_BUCKET || 'vbrm';
let MINIO_PUBLIC_URL = (process.env.MINIO_PUBLIC_URL || '').replace(/\/$/, '');
const STORAGE_PROVIDER = process.env.STORAGE_PROVIDER || 's3';

const TEMPLATES = {
  static_data:         path.join(FORMS_DIR, 'static_data_change_form.pdf'),
  dormant:             path.join(FORMS_DIR, 'dormant_account_activation_form.pdf'),
  transaction_profile: path.join(FORMS_DIR, 'transaction_profile_tp_form.pdf'),
};

const TYPE_TEMPLATES = {
  phone:              ['static_data'],
  email:              ['static_data'],
  address:            ['static_data'],
  account_activation: ['dormant', 'transaction_profile'],
};

// Page 3 (index 2) of static_data_change_form.pdf = Account Services Form
const STATIC_DATA_PAGE_INDEX = 2;

const MTB_BLUE  = rgb(0.02, 0.27, 0.52);
const MTB_GREEN = rgb(0.03, 0.47, 0.31);
const WHITE     = rgb(1, 1, 1);
const DARK      = rgb(0.1, 0.1, 0.1);
const GRAY      = rgb(0.45, 0.45, 0.45);
const LIGHT_BG  = rgb(0.95, 0.97, 1.0);
const LINE_CLR  = rgb(0.82, 0.82, 0.82);

async function buildCoverPage(pdfDoc, opts) {
  const {
    serviceType, customerId, accountNumber, customerName,
    managerName, managerEmail, approvedAt, changeDetails,
  } = opts;

  const page = pdfDoc.addPage([595.28, 841.89]);
  const { width, height } = page.getSize();
  const fR = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fB = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  // Header bar
  page.drawRectangle({ x: 0, y: height - 68, width, height: 68, color: MTB_BLUE });
  page.drawText('MUTUAL TRUST BANK PLC', {
    x: 30, y: height - 30, size: 15, font: fB, color: WHITE,
  });
  page.drawText('Digital Banking Service Record  •  Confidential', {
    x: 30, y: height - 46, size: 8.5, font: fR, color: rgb(0.75, 0.88, 1),
  });
  page.drawText(`Generated: ${approvedAt}`, {
    x: width - 175, y: height - 38, size: 8, font: fR, color: rgb(0.75, 0.88, 1),
  });

  // Service type badge
  const badgeY = height - 100;
  page.drawRectangle({ x: 30, y: badgeY - 4, width: width - 60, height: 26, color: MTB_GREEN });
  page.drawText(`SERVICE: ${serviceType.toUpperCase()}`, {
    x: 40, y: badgeY + 4, size: 10, font: fB, color: WHITE,
  });

  let y = badgeY - 26;

  const section = (title, rows) => {
    y -= 14;
    page.drawRectangle({ x: 30, y: y - 4, width: width - 60, height: 20, color: LIGHT_BG });
    page.drawRectangle({ x: 30, y: y - 4, width: 4,           height: 20, color: MTB_BLUE });
    page.drawText(title, { x: 40, y: y + 3, size: 8.5, font: fB, color: MTB_BLUE });
    y -= 20;

    rows.forEach(([label, value]) => {
      if (value === null || value === undefined || value === '') return;
      page.drawLine({
        start: { x: 30, y: y - 2 }, end: { x: width - 30, y: y - 2 },
        thickness: 0.3, color: LINE_CLR,
      });
      page.drawText(String(label), { x: 40,  y: y + 2, size: 8, font: fB, color: GRAY });
      const val = String(value);
      const maxLen = 90;
      if (val.length > maxLen) {
        page.drawText(val.substring(0, maxLen),            { x: 190, y: y + 2, size: 8, font: fR, color: DARK });
        page.drawText(val.substring(maxLen, maxLen * 2),   { x: 190, y: y - 8, size: 8, font: fR, color: DARK });
        y -= 18;
      } else {
        page.drawText(val, { x: 190, y: y + 2, size: 8, font: fR, color: DARK });
        y -= 14;
      }
    });
    y -= 6;
  };

  section('CUSTOMER INFORMATION', [
    ['Customer ID / Phone', customerId],
    ['Customer Name',       customerName || '—'],
    ['Account Number',      accountNumber || '—'],
  ]);

  section('CHANGE DETAILS', changeDetails);

  section('AUTHORIZED BY', [
    ['Manager',       managerName  || '—'],
    ['Manager Email', managerEmail || '—'],
    ['Approval Date', approvedAt],
    ['Channel',       'Video Banking — Digital Verification'],
  ]);

  // Footer
  page.drawLine({ start: { x: 30, y: 55 }, end: { x: width - 30, y: 55 }, thickness: 0.5, color: LINE_CLR });
  page.drawText('This is a system-generated digital record from Mutual Trust Bank PLC Video Banking Platform.', {
    x: 30, y: 43, size: 7, font: fR, color: GRAY,
  });
  page.drawText('FOR BANK USE ONLY — NOT FOR CUSTOMER DISTRIBUTION', {
    x: 30, y: 31, size: 7.5, font: fB, color: MTB_BLUE,
  });
}

function tryParse(val) {
  if (!val || typeof val !== 'string') return null;
  try { return JSON.parse(val); } catch { return null; }
}

function fmtDate(d) {
  const dd   = String(d.getDate()).padStart(2, '0');
  const mm   = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

// Draw text only when value is non-empty
function drawField(page, text, x, y, font, size = 8.5) {
  const t = String(text || '').trim();
  if (t) page.drawText(t, { x, y, size, font, color: rgb(0, 0, 0) });
}

// Overlay confirmed-coordinate data onto copied template pages
function overlayTemplateData(pages, templateKey, changeType, data, parsed, font) {
  const today  = fmtDate(new Date());
  const acctNo = (data.accountNumber || parsed?.accountNumber || '').trim();
  const name   = (data.customerName  || '').trim();
  const d      = (t, x, y, sz) => drawField(pages[0], t, x, y, font, sz);

  if (templateKey === 'dormant') {
    // Dormant Account Activation Form
    // Coordinates confirmed via test_dormant3
    d(today,                                          462, 696);
    d(acctNo,                                         440, 681);
    d(name,                                           440, 663);
    d(parsed?.dormancyReason || data.dormancyReason || '', 430, 525);
  }

  if (templateKey === 'transaction_profile') {
    // Transaction Profile Form
    // Coordinates confirmed via test_tp5
    d(data.branch || '',                              100, 748);
    d(acctNo,                                         395, 748);
    d(name,                                           430, 692);
    d(String(parsed?.estDepositCount  || data.estDepositCount  || ''), 320, 605);
    d(String(parsed?.estDepositAmount || data.estDepositAmount || ''), 395, 605);
    d(String(parsed?.estWithdrawCount  || data.estWithdrawCount  || ''), 320, 443);
    d(String(parsed?.estWithdrawAmount || data.estWithdrawAmount || ''), 395, 443);
  }

  if (templateKey === 'static_data') {
    // Account Services Form (page 3 of static_data_change_form.pdf)
    // Coordinates confirmed via test_static_ymap
    d(acctNo,  355, 733);
    d(today,   460, 755);
    d(name,    335, 718);

    if (changeType === 'address') {
      const newAddr = [
        parsed?.addressLine1, parsed?.addressLine2,
        parsed?.upazila, parsed?.district, parsed?.postCode,
      ].filter(Boolean).join(', ');
      d(data.oldValue || '',  130, 640);
      d(newAddr,              130, 595);
    } else if (changeType === 'phone') {
      d(data.newValue || '', 95, 536);
    } else if (changeType === 'email') {
      d(data.newValue || '', 400, 536);
    }
  }
}

async function uploadToStorage(pdfBytes, key) {
  if (STORAGE_PROVIDER === 'local') {
    const uploadDir = path.resolve(__dirname, '../../uploads/forms');
    fs.mkdirSync(uploadDir, { recursive: true });
    const filename = path.basename(key);
    fs.writeFileSync(path.join(uploadDir, filename), pdfBytes);
    return `${MINIO_PUBLIC_URL}/uploads/forms/${filename}`;
  }

  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const s3Client = require('../configs/s3Client');
  await s3Client.send(new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    Body: Buffer.from(pdfBytes),
    ContentType: 'application/pdf',
    ContentDisposition: `inline; filename="${path.basename(key)}"`,
  }));
  return `${MINIO_PUBLIC_URL}/${BUCKET_NAME}/${key}`;
}

/**
 * Generate filled PDF(s) for a service change and upload to MinIO.
 * Returns array of public URLs.
 */
async function generateFormPDF(changeType, data) {
  const templateKeys = TYPE_TEMPLATES[changeType];
  if (!templateKeys || templateKeys.length === 0) return [];

  const now = new Date();
  const approvedAt = now.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
  const stamp = `${(data.customerId || 'unknown').replace(/\D/g, '')}_${now.getTime()}`;
  const parsed = tryParse(data.newValue);
  const urls = [];

  for (const key of templateKeys) {
    let serviceType   = changeType;
    let changeDetails = [];

    if (changeType === 'phone') {
      serviceType   = 'Mobile Number Update';
      changeDetails = [
        ['Previous Mobile', data.oldValue],
        ['New Mobile',      data.newValue],
      ];
    } else if (changeType === 'email') {
      serviceType   = 'Email Address Update';
      changeDetails = [
        ['Previous Email', data.oldValue],
        ['New Email',      data.newValue],
      ];
    } else if (changeType === 'address') {
      const addrType = parsed?.addressType || 'present';
      const label    = addrType.charAt(0).toUpperCase() + addrType.slice(1);
      serviceType    = `${label} Address Update`;
      const newAddr  = [parsed?.addressLine1, parsed?.addressLine2, parsed?.upazila, parsed?.district, parsed?.postCode].filter(Boolean).join(', ');
      changeDetails  = [
        ['Address Type',     label],
        ['Previous Address', data.oldValue || '—'],
        ['New Address',      newAddr || '—'],
      ];
    } else if (changeType === 'account_activation') {
      serviceType = 'Dormant Account Activation';
      if (key === 'dormant') {
        changeDetails = [
          ['Account Number',     data.accountNumber || parsed?.accountNumber || '—'],
          ['Reason for Dormancy', parsed?.dormancyReason || data.dormancyReason || '—'],
        ];
      } else {
        changeDetails = [
          ['Account Number',                       data.accountNumber || parsed?.accountNumber || '—'],
          ['Est. Monthly Deposits (Count)',         String(parsed?.estDepositCount   || data.estDepositCount   || '—')],
          ['Est. Monthly Deposits (Amount BDT)',    String(parsed?.estDepositAmount  || data.estDepositAmount  || '—')],
          ['Est. Monthly Withdrawals (Count)',      String(parsed?.estWithdrawCount  || data.estWithdrawCount  || '—')],
          ['Est. Monthly Withdrawals (Amount BDT)', String(parsed?.estWithdrawAmount || data.estWithdrawAmount || '—')],
          ['Reason for Dormancy',                  parsed?.dormancyReason || data.dormancyReason || '—'],
        ];
      }
    }

    const templateBytes = fs.readFileSync(TEMPLATES[key]);
    const templateDoc   = await PDFDocument.load(templateBytes);
    const outDoc        = await PDFDocument.create();

    await buildCoverPage(outDoc, {
      serviceType, approvedAt,
      customerId:    data.customerId,
      accountNumber: data.accountNumber || parsed?.accountNumber,
      customerName:  data.customerName,
      managerName:   data.managerName,
      managerEmail:  data.managerEmail,
      changeDetails,
    });

    const pageIndices = key === 'static_data'
      ? [Math.min(STATIC_DATA_PAGE_INDEX, templateDoc.getPageCount() - 1)]
      : Array.from({ length: templateDoc.getPageCount() }, (_, i) => i);

    const copied  = await outDoc.copyPages(templateDoc, pageIndices);
    const outFont = await outDoc.embedFont(StandardFonts.Helvetica);
    overlayTemplateData(copied, key, changeType, data, parsed, outFont);
    copied.forEach(p => outDoc.addPage(p));

    const pdfBytes  = await outDoc.save();
    const minioKey  = `forms/form_${changeType}_${key}_${stamp}.pdf`;
    const publicUrl = await uploadToStorage(pdfBytes, minioKey);
    urls.push(publicUrl);
  }

  return urls;
}

module.exports = { generateFormPDF };
