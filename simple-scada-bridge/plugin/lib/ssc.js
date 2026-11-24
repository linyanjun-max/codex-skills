// Scripts.ssc codec for Simple-Scada 2.
//
// Verified layout (v2.6.12.3, decodes project_SwimmingPool\Scripts\Scripts.ssc
// byte-exactly and re-encodes to the same bytes):
//
//   header   23 bytes  (10 00 00 00 | 00 00 00 00 | 03 00 00 00 | "..\" NUL | 00 00 00 00 | 09 00 00)
//   record:  u32 id                     (not necessarily sequential: gaps appear after deletes)
//            u32 nameLen + UTF-16LE name (event/script name, e.g. "startButton_OnClick")
//            18 bytes of flags           (kept verbatim; byte0 = 01 for active records)
//            u32 lineCount
//            per line: u32 charCount + UTF-16LE text (newlines are never stored inside a line)
//
// Every script is one record; "Script_7" is the free-form script unit while
// e.g. "startButton_OnClick" is an object event handler.

const HEADER_LEN = 23
const FLAGS_LEN = 18

function readU32(buf, off) {
  if (off + 4 > buf.length) throw new Error('Scripts.ssc: truncated u32 at offset ' + off)
  return buf.readUInt32LE(off)
}

// Some projects (for example the bundled Demo-project) store scripts in a newer
// container: the header carries a named script group and the record framing
// differs, so the 23-byte-header reader below cannot decode them. Callers that
// must not fail on such projects use parseScriptsSafe().
export class ScriptsLayoutError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ScriptsLayoutError'
    this.code = 'SSC_LAYOUT_UNSUPPORTED'
  }
}

export function parseScriptsSafe(buf) {
  try {
    return { ok: true, model: parseScripts(buf) }
  } catch (e) {
    return {
      ok: false,
      error: e.message,
      code: e.code || 'SSC_PARSE_ERROR',
      note: 'this project uses a Scripts.ssc container variant that the bridge does not decode yet; scripts are unavailable for it (the standard 23-byte-header layout used by project_SwimmingPool / SwimmingPool_pql / final_project works)',
    }
  }
}

export function parseScripts(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf)
  if (buf.length < HEADER_LEN) throw new ScriptsLayoutError('Scripts.ssc: file shorter than the 23-byte header')
  const header = Buffer.from(buf.subarray(0, HEADER_LEN))
  const records = []
  let o = HEADER_LEN
  while (o < buf.length) {
    const start = o
    const id = readU32(buf, o); o += 4
    o += 4 // 4 reserved bytes, always zero in every observed file
    const nameLen = readU32(buf, o); o += 4
    if (nameLen > 4096 || o + nameLen * 2 > buf.length) {
      throw new ScriptsLayoutError('Scripts.ssc: implausible name length ' + nameLen + ' at offset ' + (o - 4))
    }
    const name = buf.subarray(o, o + nameLen * 2).toString('utf16le'); o += nameLen * 2
    const flags = Buffer.from(buf.subarray(o, o + FLAGS_LEN)); o += FLAGS_LEN
    const lineCount = readU32(buf, o); o += 4
    if (lineCount > 100000) throw new ScriptsLayoutError('Scripts.ssc: implausible line count ' + lineCount + ' in ' + name)
    const lines = []
    for (let i = 0; i < lineCount; i++) {
      const n = readU32(buf, o); o += 4
      if (n > 65535 || o + n * 2 > buf.length) throw new ScriptsLayoutError('Scripts.ssc: implausible line length in ' + name)
      lines.push(buf.subarray(o, o + n * 2).toString('utf16le')); o += n * 2
    }
    records.push({ start, id, name, flags: flags.toString('hex'), lines })
  }
  if (o !== buf.length) throw new ScriptsLayoutError('Scripts.ssc: trailing bytes after last record (' + (buf.length - o) + ')')
  return { header, records }
}

export function buildScripts(model) {
  const parts = [Buffer.from(model.header)]
  for (const rec of model.records) {
    const nameBuf = Buffer.from(rec.name, 'utf16le')
    const head = Buffer.alloc(12)
    head.writeUInt32LE(rec.id >>> 0, 0)
    head.writeUInt32LE(0, 4)
    head.writeUInt32LE(nameBuf.length / 2, 8)
    parts.push(head, nameBuf)
    const flags = Buffer.from(rec.flags || '0100020000000100006bffffff0100000000', 'hex')
    if (flags.length !== FLAGS_LEN) throw new Error('Scripts.ssc: flags for ' + rec.name + ' must be 18 bytes')
    parts.push(flags)
    const cnt = Buffer.alloc(4); cnt.writeUInt32LE(rec.lines.length, 0); parts.push(cnt)
    for (const line of rec.lines) {
      const lineBuf = Buffer.from(line, 'utf16le')
      if (lineBuf.length % 2 !== 0) throw new Error('Scripts.ssc: odd UTF-16 length in ' + rec.name)
      const n = Buffer.alloc(4); n.writeUInt32LE(lineBuf.length / 2, 0)
      parts.push(n, lineBuf)
    }
  }
  return Buffer.concat(parts)
}

// Script names must be valid PaxCompiler identifiers, because the editor turns
// them into procedure names / event bindings.
export const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export function findScript(model, name) {
  return model.records.find(function (r) { return r.name === name }) || null
}

export function listScripts(model) {
  return model.records.map(function (r) {
    return {
      id: r.id,
      name: r.name,
      lines: r.lines.length,
      chars: r.lines.reduce(function (a, l) { return a + l.length }, 0),
      source: r.lines.join('\n'),
    }
  })
}

// Replace a script body. `text` is split into lines the same way the editor
// stores them (no embedded newlines, CR stripped).
export function setScriptText(model, name, text) {
  const rec = findScript(model, name)
  if (!rec) throw new Error('script not found: ' + name)
  rec.lines = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  return rec
}

export function addScript(model, name, text, flags) {
  if (!NAME_RE.test(name)) throw new Error('invalid script name: ' + name + ' (must match ' + NAME_RE.source + ')')
  if (findScript(model, name)) throw new Error('script already exists: ' + name)
  const maxId = model.records.reduce(function (a, r) { return Math.max(a, r.id) }, -1)
  const rec = {
    id: maxId + 1,
    name: name,
    // 0x0a in byte 0 marks a free-form script unit (like Script_7); event
    // handlers use 0x01. Callers that know better can pass explicit flags.
    flags: flags || '0a1000000000010000e8420f000100000000',
    lines: String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n'),
  }
  model.records.push(rec)
  return rec
}

export function removeScript(model, name) {
  const i = model.records.findIndex(function (r) { return r.name === name })
  if (i < 0) throw new Error('script not found: ' + name)
  return model.records.splice(i, 1)[0]
}

export function renameScript(model, from, to) {
  if (!NAME_RE.test(to)) throw new Error('invalid script name: ' + to)
  if (findScript(model, to)) throw new Error('script already exists: ' + to)
  const rec = findScript(model, from)
  if (!rec) throw new Error('script not found: ' + from)
  rec.name = to
  return rec
}
