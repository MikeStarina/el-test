const http = require('http');
const https = require('https');
const { performance } = require('node:perf_hooks');

const IDLE_TIMEOUT_MS = 30_000;
const MAX_COUNT = 1000;

function download(url, index, count, timeoutMs = IDLE_TIMEOUT_MS) {
  const lib = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const started = performance.now();
    let bytes = 0;
    let timer = null;
    let lineOpen = false;
    let settled = false;
    let req;

    const stopProgress = () => {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      stopProgress();
      if (lineOpen) {
        process.stdout.write('\n');
        lineOpen = false;
      }
      err.index = index;
      reject(err);
      if (req && !req.destroyed) req.destroy();
    };

    const succeed = (result) => {
      if (settled) return;
      settled = true;
      stopProgress();
      req.setTimeout(0);
      process.stdout.write(`\r${index}/${count} ${result.bytes} B\n`);
      lineOpen = false;
      resolve(result);
    };

    req = lib.get(url, (res) => {
      if (res.statusCode < 200 || res.statusCode > 299) {
        const err = new Error(`HTTP ${res.statusCode}`);
        err.statusCode = res.statusCode;
        res.on('error', () => {});
        fail(err);
        return;
      }

      timer = setInterval(() => {
        process.stdout.write(`\r${index}/${count} ${bytes} B`);
        lineOpen = true;
      }, 200);

      res.on('data', (chunk) => {
        bytes += chunk.length;
      });

      res.on('end', () => {
        succeed({ bytes, ms: performance.now() - started });
      });

      res.on('error', (err) => {
        fail(err);
      });
    });

    req.setTimeout(timeoutMs, () => {
      fail(Object.assign(new Error('превышено время ожидания'), { index }));
    });

    req.on('error', (err) => {
      fail(err);
    });
  });
}

async function benchmark(url, count, timeoutMs = IDLE_TIMEOUT_MS) {
  let totalBytes = 0;
  let totalMs = 0;

  for (let i = 1; i <= count; i++) {
    const result = await download(url, i, count, timeoutMs);
    totalBytes += result.bytes;
    totalMs += result.ms;
  }

  return { totalBytes, totalMs };
}

function readArgs(argv) {
  const rawUrl = argv[2];
  if (!rawUrl) {
    return { error: 'usage: node index.js <url> [count]' };
  }

  let url;
  try {
    url = new URL(rawUrl);
  } catch (err) {
    return { error: err.message };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { error: `неподдерживаемая схема: ${url.protocol}` };
  }

  if (argv[3] === undefined) {
    return { url, count: 10 };
  }

  const count = Number(argv[3]);
  if (!/^[1-9]\d*$/.test(argv[3]) || !Number.isSafeInteger(count) || count > MAX_COUNT) {
    return { error: 'число запросов должно быть целым от 1 до 1000' };
  }

  return { url, count };
}

async function main(argv = process.argv) {
  const parsed = readArgs(argv);
  if (parsed.error) {
    console.error(parsed.error);
    process.exitCode = 1;
    return;
  }

  try {
    const { totalBytes, totalMs } = await benchmark(parsed.url, parsed.count);
    const mib = totalBytes / 1024 / 1024;
    const seconds = totalMs / 1000;
    console.log(`${(totalMs / parsed.count).toFixed(0)} ms`);
    console.log(`${mib.toFixed(2)} MiB`);
    console.log(`${(mib / seconds).toFixed(2)} MiB/s`);
  } catch (err) {
    if (err.statusCode != null) {
      console.error(`${err.index}/${parsed.count} HTTP ${err.statusCode}`);
    } else {
      console.error(`${err.index}/${parsed.count} ${err.message}`);
    }
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = { download, benchmark, main };
