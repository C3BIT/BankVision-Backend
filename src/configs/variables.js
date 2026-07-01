require('dotenv').config({ override: true }); // Load from .env and override process.env

// Resolved before module.exports so per-API URLs can fall back to it
const _cbsCoreUrl = process.env.CBS_CORE_URL || "http://202.59.208.111:8090";

module.exports = {
  NODE_ENV: process.env.NODE_ENV || "production",
  PORT: process.env.PORT || 3000,
  jwtSecret: (() => {
    if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET environment variable is required');
    return process.env.JWT_SECRET;
  })(),
  JWT_EXPIRATION: process.env.JWT_EXPIRATION,

  // DB config
  DB_NAME: process.env.DB_NAME,
  DB_USER: process.env.DB_USER,
  DB_PASS: process.env.DB_PASS,
  DB_HOST: process.env.DB_HOST,
  DB_PORT: process.env.DB_PORT || 3306,

  // Face APIs
  MXFACE_KEY: process.env.MXFACE_KEY,
  MXFACE_API_URL: process.env.MXFACE_API_URL || "https://faceapi.mxface.ai/api/v3/face/",

  // Storage config
  STORAGE_PROVIDER: process.env.STORAGE_PROVIDER || "s3",
  MINIO_ENDPOINT: process.env.MINIO_ENDPOINT || "http://openvidu-minio:9000",
  MINIO_ACCESS_KEY: process.env.MINIO_ACCESS_KEY,
  MINIO_SECRET_KEY: process.env.MINIO_SECRET_KEY,
  MINIO_BUCKET: process.env.MINIO_BUCKET || "vbrm",
  MINIO_PUBLIC_URL: process.env.MINIO_PUBLIC_URL,
  MINIO_USE_SSL: process.env.MINIO_USE_SSL || "false",

  // DigitalOcean Spaces
  SPACES_BUCKET: process.env.SPACES_BUCKET,
  SPACES_KEY: process.env.SPACES_KEY,
  SPACES_SECRET: process.env.SPACES_SECRET,

  // AWS
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
  AWS_REGION: process.env.AWS_REGION || "us-east-1",

  // OpenCV Face Service
  OPENCV_SERVICE_URL: process.env.OPENCV_SERVICE_URL || "http://opencv-face-service:5097",

  // Redis
  REDIS_HOST: process.env.REDIS_HOST || "vbrm-redis",
  REDIS_PORT: process.env.REDIS_PORT || 6379,
  REDIS_PASSWORD: process.env.REDIS_PASSWORD,

  // CBS API (Production)
  CBS_API_KEY: process.env.CBS_API_KEY,
  CBS_API_URL: process.env.CBS_API_URL || "https://api.yourbank.com/v1",

  // MTB CBS — shared credentials & channel
  CBS_CORE_URL: _cbsCoreUrl,
  CBS_CHANNEL_ID: process.env.CBS_CHANNEL_ID || "101",
  CBS_USERNAME: process.env.CBS_USERNAME || "videobanking",
  CBS_PASSWORD: process.env.CBS_PASSWORD || "testmd5",

  // MTB CBS — per-API URLs (each falls back to CBS_CORE_URL + path if not set individually)
  // API 01 — getDetailAccountInfo
  CBS_URL_DETAIL_ACCOUNT: process.env.CBS_URL_DETAIL_ACCOUNT ||
    `${_cbsCoreUrl}/coreMiddleware/cbs/getDetailAccountInfo`,
  // API 02 — serExtensiveinfobymobileno
  CBS_URL_EXTENSIVE_INFO: process.env.CBS_URL_EXTENSIVE_INFO ||
    `${_cbsCoreUrl}/coreMiddleware/cbs/serExtensiveinfobymobileno`,
  // API 03 — serCusLinkeAccInfo
  CBS_URL_LINKED_ACC: process.env.CBS_URL_LINKED_ACC ||
    `${_cbsCoreUrl}/coreMiddleware/cbs/serCusLinkeAccInfo`,
  // API 04 — getUserIdentity
  CBS_URL_USER_IDENTITY: process.env.CBS_URL_USER_IDENTITY ||
    `${_cbsCoreUrl}/coreMiddleware/cbs/getUserIdentity`,
  // API 05 — sendEmail
  CBS_EMAIL_URL: process.env.CBS_EMAIL_URL ||
    `${_cbsCoreUrl}/coreMiddleware/notify/sendEmail`,
  // API 06 — sendSMS
  CBS_SMS_URL: process.env.CBS_SMS_URL ||
    `${_cbsCoreUrl}/coreMiddleware/notify/sendSMS`,
  // API 07 — getDebitCardEmailMobile
  CBS_CARD_URL: process.env.CBS_CARD_URL ||
    `${_cbsCoreUrl}/coreMiddleware/card/getDebitCardEmailMobile`,
  // API 08 — updateOMSCustomerEmailMobile
  CBS_OMS_URL: process.env.CBS_OMS_URL ||
    `${_cbsCoreUrl}/coreMiddleware/card/updateOMSCustomerEmailMobile`,
  // API 09 — UpdateCustomer
  CBS_UPDATE_URL: process.env.CBS_UPDATE_URL ||
    `${_cbsCoreUrl}/MTBCBSMiddleware/cbs/api/v1/UpdateCustomer/updatecustomer`,
  // API 10 — getCustomerPhoto
  CBS_URL_CUSTOMER_PHOTO: process.env.CBS_URL_CUSTOMER_PHOTO ||
    `${_cbsCoreUrl}/coreMiddleware/cbs/getCustomerPhoto`,
  // API 11 — getCustomerCards
  CBS_URL_CUSTOMER_CARDS: process.env.CBS_URL_CUSTOMER_CARDS ||
    `${_cbsCoreUrl}/coreMiddleware/card/getCustomerCards`,
  // API 12 — getCustomerSignature
  CBS_URL_CUSTOMER_SIGNATURE: process.env.CBS_URL_CUSTOMER_SIGNATURE ||
    `${_cbsCoreUrl}/coreMiddleware/cbs/getCustomerSignature`,
  // API 13 — setAccountActive
  CBS_URL_SET_ACCOUNT_ACTIVE: process.env.CBS_URL_SET_ACCOUNT_ACTIVE ||
    `${_cbsCoreUrl}/coreMiddleware/cbs/setAccountActive`,
  // API 14 — SaveAddressInfo
  CBS_URL_SAVE_ADDRESS: process.env.CBS_URL_SAVE_ADDRESS ||
    `${_cbsCoreUrl}/coreMiddleware/utility/common/SaveAddressInfo`,
  // API 15 — saveCustomerInfoLog
  CBS_URL_SAVE_CUSTOMER_INFO_LOG: process.env.CBS_URL_SAVE_CUSTOMER_INFO_LOG ||
    `${_cbsCoreUrl}/coreMiddleware/utility/common/saveCustomerInfoLog`,
  // API 16 — getCustomerPhoto (real bank path)
  CBS_URL_GET_CUSTOMER_PHOTO: process.env.CBS_URL_GET_CUSTOMER_PHOTO ||
    `${_cbsCoreUrl}/coreMiddleware/utility/common/getCustomerPhoto`,

  // MTB CBS — SMS settings
  CBS_SMS_USERNAME: process.env.CBS_SMS_USERNAME || "commonsmsuser",
  CBS_SMS_PASSWORD: process.env.CBS_SMS_PASSWORD || "test@sms",
  CBS_SMS_CHANNEL_ID: process.env.CBS_SMS_CHANNEL_ID || "101",
  CBS_SMS_EVENT: process.env.CBS_SMS_EVENT || "PIN",

  // MTB CBS — Email settings
  CBS_EMAIL_CHANNEL_ID: process.env.CBS_EMAIL_CHANNEL_ID || "101",
  CBS_FROM_EMAIL: process.env.CBS_FROM_EMAIL || "voc@mutualtrustbank.com",
  CBS_FROM_EMAIL_DISPLAY_NAME: process.env.CBS_FROM_EMAIL_DISPLAY_NAME || "VOC",
  CBS_EMAIL_EVENT: process.env.CBS_EMAIL_EVENT || "OTP",
  CBS_EMAIL_SUBJECT: process.env.CBS_EMAIL_SUBJECT || "BankVision OTP Verification",

  // MTB CBS — Account lookup filters
  CBS_ACC_TYPE: process.env.CBS_ACC_TYPE || "A",
  CBS_ACC_STATE: process.env.CBS_ACC_STATE || "O",

  // MTB CBS — OMS card settings
  CBS_OMS_CHANNEL_ID: process.env.CBS_OMS_CHANNEL_ID || "121",

  // MTB CBS — UpdateCustomer auth & metadata
  CBS_UPDATE_USERID: process.env.CBS_UPDATE_USERID || "",
  CBS_UPDATE_PASSWORD: process.env.CBS_UPDATE_PASSWORD || "",
  CBS_INST_NUMBER: process.env.CBS_INST_NUMBER || "",
  CBS_BRANCH_NUMBER: process.env.CBS_BRANCH_NUMBER || "",
  CBS_TELLER_NUMBER: process.env.CBS_TELLER_NUMBER || "",
  CBS_UUID_SOURCE: process.env.CBS_UUID_SOURCE || "SDU",
  CBS_UUID_SEQ_NO: process.env.CBS_UUID_SEQ_NO || "0001",
  CBS_FLAG4: process.env.CBS_FLAG4 || "Y",
  CBS_FLAG5: process.env.CBS_FLAG5 || "Y",
  CBS_DATAFIX_USER: process.env.CBS_DATAFIX_USER || "",
  CBS_APPROVE_USER: process.env.CBS_APPROVE_USER || "",
  CBS_DEFAULT_PURPOSE: process.env.CBS_DEFAULT_PURPOSE || "",
  CBS_DEFAULT_BUGID: process.env.CBS_DEFAULT_BUGID || "",
};
