const fs = require('fs');
const { EventEmitter } = require('events');
const { StringDecoder } = require('string_decoder');

// Player.log interleaves Unity noise with JSON payloads. A payload either sits on its
// header line ("[UnityCrossThreadLogger]==> EventJoin {...}") or on its own line right
// after a header ("[UnityCrossThreadLogger]10/3/2026 8:24:04 AM: Match to X: GreToClientEvent").
const HEADER_RE = /^\[(UnityCrossThreadLogger|Client GRE)\]/;
const MAX_CONTEXT = 600;
const MAX_PENDING_LINES = 20000;

class LogLineParser {
  constructor(onEntry, onRawLine) {
    this.onEntry = onEntry;
    this.onRawLine = onRawLine || (() => {});
    this.context = '';
    this.pending = null;
  }

  push(rawLine) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    this.onRawLine(line);

    const header = HEADER_RE.exec(line);
    if (header) {
      this.pending = null;
      const rest = line.slice(header[0].length);
      this.context = rest.slice(0, MAX_CONTEXT);
      const brace = rest.indexOf('{');
      if (brace !== -1) this.tryJson(rest.slice(0, brace), rest.slice(brace));
      return;
    }

    if (this.pending) {
      this.pending.lines.push(line);
      const trimmed = line.trimEnd();
      if (trimmed.endsWith('}')) {
        try {
          const json = JSON.parse(this.pending.lines.join('\n'));
          const { label } = this.pending;
          this.pending = null;
          this.emit(label, json);
        } catch {
          if (this.pending.lines.length > MAX_PENDING_LINES) this.pending = null;
        }
      }
      return;
    }

    if (line.startsWith('{')) {
      this.tryJson(this.context, line);
    } else if (line.length && this.context.length < MAX_CONTEXT) {
      this.context = `${this.context}\n${line}`.slice(0, MAX_CONTEXT);
    }
  }

  tryJson(label, text) {
    try {
      this.emit(label, JSON.parse(text));
    } catch {
      // Older clients pretty-print some payloads across several lines.
      this.pending = { label, lines: [text] };
    }
  }

  emit(label, json) {
    try {
      this.onEntry({ label, json });
    } catch (err) {
      console.error('[mtga-journal] failed to handle log entry:', label.slice(0, 80), err);
    }
  }
}

// Tails a log file, surviving MTGA restarts (which rotate Player.log to Player-prev.log).
class LogWatcher extends EventEmitter {
  constructor(filePath, { pollMs = 500 } = {}) {
    super();
    this.filePath = filePath;
    this.pollMs = pollMs;
    this.timer = null;
    this.resetState();
  }

  resetState() {
    this.offset = 0;
    this.decoder = new StringDecoder('utf8');
    this.partial = '';
    this.identity = null;
  }

  // Reads everything currently in the file synchronously, then follows new writes.
  start() {
    this.exists = fs.existsSync(this.filePath);
    if (this.exists) this.readNew();
    this.emit('caughtUp');
    this.timer = setInterval(() => this.poll(), this.pollMs);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  poll() {
    let stat;
    try {
      stat = fs.statSync(this.filePath);
    } catch {
      if (this.exists) {
        this.exists = false;
        this.emit('missing');
      }
      return;
    }
    if (!this.exists) this.exists = true;
    const identity = `${stat.ino}:${stat.birthtimeMs}`;
    if (stat.size < this.offset || (this.identity && identity !== this.identity)) {
      this.resetState();
      this.emit('rotated');
    }
    if (stat.size > this.offset) this.readNew();
  }

  readNew() {
    let fd;
    try {
      fd = fs.openSync(this.filePath, 'r');
      const stat = fs.fstatSync(fd);
      this.identity = `${stat.ino}:${stat.birthtimeMs}`;
      const chunk = Buffer.allocUnsafe(1 << 20);
      while (this.offset < stat.size) {
        const n = fs.readSync(fd, chunk, 0, chunk.length, this.offset);
        if (n <= 0) break;
        this.offset += n;
        this.consume(this.decoder.write(chunk.subarray(0, n)));
      }
    } catch (err) {
      this.emit('error', err);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  consume(text) {
    const parts = (this.partial + text).split('\n');
    this.partial = parts.pop();
    for (const line of parts) this.emit('line', line);
  }
}

// Convenience for one-shot parsing (tests, replay script, importing Player-prev.log).
function parseLogFile(filePath, onEntry, onRawLine) {
  const parser = new LogLineParser(onEntry, onRawLine);
  const text = fs.readFileSync(filePath, 'utf8');
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    parser.push(text.slice(start, end));
    start = end + 1;
  }
}

module.exports = { LogLineParser, LogWatcher, parseLogFile };
