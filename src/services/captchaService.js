const crypto = require("crypto");
const { redisClient } = require("../configs/redis");

// Self-hosted CAPTCHA: no third-party service, no external network call, no
// API keys. Renders a short noisy SVG image server-side and verifies the
// answer against a short-lived, single-use cache entry keyed by a random id.
//
// Backed by the shared Redis instance (not an in-process cache) because the
// backend runs multiple pods behind a load balancer with no session
// affinity: the GET that creates the captcha and the POST that verifies it
// can land on different pods, so the store must be shared across them.
const CAPTCHA_TTL_SECONDS = 120;
const captchaKey = (captchaId) => `captcha:${captchaId}`;

const CAPTCHA_LENGTH = 5;
// Ambiguous characters (0/O, 1/I/l) are excluded so a human can reliably read it.
const CHARSET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const WIDTH = 150;
const HEIGHT = 50;

const randomInt = (min, max) => min + crypto.randomInt(max - min + 1);

const randomColor = () => {
  const h = randomInt(0, 359);
  return `hsl(${h}, 65%, 35%)`;
};

const generateText = () => {
  let text = "";
  for (let i = 0; i < CAPTCHA_LENGTH; i++) {
    text += CHARSET[crypto.randomInt(CHARSET.length)];
  }
  return text;
};

const buildSvg = (text) => {
  const charWidth = WIDTH / (text.length + 1);
  let glyphs = "";

  for (let i = 0; i < text.length; i++) {
    const x = charWidth * (i + 0.7);
    const y = randomInt(30, 38);
    const rotate = randomInt(-25, 25);
    const fontSize = randomInt(24, 30);
    glyphs += `<text x="${x}" y="${y}" font-size="${fontSize}" font-family="Verdana, sans-serif" font-weight="bold" fill="${randomColor()}" transform="rotate(${rotate} ${x} ${y})">${text[i]}</text>`;
  }

  let noiseLines = "";
  for (let i = 0; i < 5; i++) {
    noiseLines += `<line x1="${randomInt(0, WIDTH)}" y1="${randomInt(0, HEIGHT)}" x2="${randomInt(0, WIDTH)}" y2="${randomInt(0, HEIGHT)}" stroke="${randomColor()}" stroke-width="1" opacity="0.4" />`;
  }

  let noiseDots = "";
  for (let i = 0; i < 30; i++) {
    noiseDots += `<circle cx="${randomInt(0, WIDTH)}" cy="${randomInt(0, HEIGHT)}" r="1" fill="${randomColor()}" opacity="0.5" />`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}"><rect width="100%" height="100%" fill="#f4f4f4" />${noiseLines}${noiseDots}${glyphs}</svg>`;
};

const generateCaptcha = async () => {
  const text = generateText();
  const captchaId = crypto.randomUUID();
  await redisClient.set(captchaKey(captchaId), text.toUpperCase(), "EX", CAPTCHA_TTL_SECONDS);
  return { captchaId, svg: buildSvg(text) };
};

// Single-use: the entry is deleted on the first verification attempt whether
// it succeeds or fails, so a captured answer can't be replayed.
const verifyCaptcha = async (captchaId, answer) => {
  if (!captchaId || !answer) return false;
  const key = captchaKey(captchaId);
  const expected = await redisClient.get(key);
  await redisClient.del(key);
  if (!expected) return false;
  return String(answer).trim().toUpperCase() === expected;
};

module.exports = { generateCaptcha, verifyCaptcha };
