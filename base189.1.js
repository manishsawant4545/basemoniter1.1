import fs from 'fs';
import path from 'path';
import { ethers } from 'ethers';
import axios from 'axios';
import TelegramBot from 'node-telegram-bot-api';
import chalk from 'chalk';
import express from 'express';
import winston from 'winston';
import 'winston-daily-rotate-file';

// ===== Logging setup with daily rotation =====
const transport = new winston.transports.DailyRotateFile({
  filename: 'logs/base-monitor-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  maxSize: '20m',
  maxFiles: '14d',
});
export const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level}]: ${message}`)
  ),
  transports: [transport, new winston.transports.Console()],
});

// ===== Config =====
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;
const ALCHEMY_URL = process.env.ALCHEMY_URL;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BASE_FILE = 'BaseToken1.sol';
const SIMILARITY_THRESHOLD = 90; // percentage
const STATE_FILE = path.resolve('./state.json');

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, {
  polling: true,
  request: {
    agentOptions: {
      keepAlive: true,
      family: 4,
    },
  },
});
const BASE_CODE = fs.readFileSync(BASE_FILE, 'utf8');

// ==== State persistence ====
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state), 'utf8');
}

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  }
  return { lastBlock: 0 };
}

let { lastBlock } = loadState();

// ==== Logger helper to replace console ====
const log = {
  info: (msg) => logger.info(msg),
  warn: (msg) => logger.warn(msg),
  error: (msg) => logger.error(msg),
};

// ==== Express minimal HTTP server for keep-alive/ping ====
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Ethereum Monitor is running');
});

app.listen(PORT, () => {
  log.info(`Server listening on port ${PORT}`);
});

// ==== Utility functions ====
function calculateSimilaritypercent(basecode, targetcode) {
  const clean = (str) =>
    str
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('//*') && !line.startsWith('/*') && !line.startsWith('*'));

  const baseLines = clean(basecode);
  const targetLines = clean(targetcode);

  let matchCount = 0;
  baseLines.forEach((line) => {
    if (targetLines.includes(line)) matchCount++;
  });

  return Number(((matchCount / baseLines.length) * 100).toFixed(2));
}

function sendTelegramAlert(address, percent = null) {
  let msg = `HIGH SIMILARITY ALERT \n\nContract:${address}\nSimilarity:${percent}%\nCheck on Basescan:https://base.blockscout.com/address/${address}`;
  bot
    .sendMessage(TELEGRAM_CHAT_ID, msg)
    .then(() => log.info('Telegram alert sent!'))
    .catch((err) => log.error('Telegram error: ' + err.message));
}

function extractSourcesFromJSON(sourceCode) {
  try {
    const parsed = JSON.parse(sourceCode);
    if (parsed.sources) {
      return Object.values(parsed.sources)
        .map((obj) => obj.content)
        .filter(Boolean)
        .join('\n\n');
    }
    return sourceCode;
  } catch (error) {
    return sourceCode; // Not JSON
  }
}

async function robustFetchVerifiedSource(address, apiKey) {
  const url = `https://api.basescan.org/api?module=contract&action=getsourcecode&address=${address}&chainId=8453&apikey=${apiKey}`;
  const res = await axios.get(url);
    log.info(`Basescan API full response: ${JSON.stringify(res.data, null, 2)}`);
  if (res.data.status === '1' && res.data.result && res.data.result[0]) {
    let sourceCode = res.data.result[0].SourceCode;
    if (sourceCode && sourceCode.trim().length > 0) {
      if (sourceCode.trim().startsWith('{')) {
        sourceCode = extractSourcesFromJSON(sourceCode.trim());
      }
      return sourceCode;
    }
  }
  throw new Error('Source code not available or empty');
}

// ==== Telegram polling error handlers with reconnect logic ===============
let reconnectDelay = 5000;
const MAX_RECONNECT_DELAY = 60000;

bot.on('polling_error', async (error) => {
  log.error(`Polling error: ${error.code} - ${error.message}`);

  try {
    await bot.stopPolling();
  } catch (e) {
    log.error('Error stopping polling: ' + e.message);
  }

  if (error.code === 'ETELEGRAM' && error.message.includes('409 Conflict')) {
    log.error('Conflict detected: Another bot instance is running. Exiting process.');
    process.exit(1);
  }

  if (error.code === 'EFATAL') {
    log.error('Fatal polling error detected, attempting reconnect...');
    await new Promise((resolve) => setTimeout(resolve, 5000));
    try {
      await bot.startPolling();
      log.info('Polling restarted successfully');
      reconnectDelay = 5000;
    } catch (reconnectErr) {
      log.error('Failed to restart polling: ' + reconnectErr.message);
      process.exit(1);
    }
    return;
  }

  logger.info(`Reconnecting polling in ${reconnectDelay / 1000} seconds...`);
  await new Promise((resolve) => setTimeout(resolve, reconnectDelay));

  try {
    await bot.startPolling();
    log.info('Polling restarted successfully');
    reconnectDelay = 5000;
  } catch (err) {
    log.error('Reconnect failed: ' + err.message);
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
  }
});

// ==== Monitor Blocks with state persistence and error handling =====
async function monitorBlocks() {
  const provider = new ethers.JsonRpcProvider(ALCHEMY_URL);

  log.info('Monitoring Base chain for new contract deployments...');

  provider.on('block', async (blockNumber) => {
    if (blockNumber <= lastBlock) return;
    lastBlock = blockNumber;
    saveState({ lastBlock });

    log.info(chalk.yellow(`Checking block #${blockNumber}`));

    try {
      const block = await provider.getBlock(blockNumber, true);
      const transactions = block.prefetchedTransactions;

      for (const tx of transactions) {
        if (!tx.to) {
          const receipt = await provider.getTransactionReceipt(tx.hash);
          const contractAddress = receipt.contractAddress;
          log.info(chalk.cyan(`New contract deployed at: ${contractAddress}`));

          // Wait 20 seconds before attempting source fetch
          await new Promise((resolve) => setTimeout(resolve, 20000)); // 20 seconds delay

          try {
            const source = await robustFetchVerifiedSource(contractAddress, ETHERSCAN_API_KEY);
            if (source) {
              const similarity = calculateSimilaritypercent(BASE_CODE, source);
              log.info(chalk.magenta(`Source Similarity: ${similarity}%`));
              if (similarity >= SIMILARITY_THRESHOLD) {
                log.info(chalk.green('Similarity threshold met, alerting Telegram.'));
                sendTelegramAlert(contractAddress, similarity);
              } else {
                log.info('Similarity below threshold, no alert sent.');
              }
            } else {
              log.error(`No verified source available for this contract ${contractAddress}.`);
            }
          } catch (sourceErr) {
            log.error('Error fetching or processing source code: ' + sourceErr.message);
          }
        }
      }
    } catch (err) {
      log.error('Error in processing contract deployment: ' + err.message);
    }
  });
}

monitorBlocks();

