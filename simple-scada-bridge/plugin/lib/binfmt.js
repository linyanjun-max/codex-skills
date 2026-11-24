// Decoders for the Simple-Scada 2 project files that matter to the bridge:
//   Variables.svr  - variable definitions (editor source of truth)
//   Variables.svrr - runtime variable index (group, name, description)
//   Pages.spg      - pages, subpages and screen elements
//   Project.spr    - project settings (name, GUID, database, flags)
//   Trends.str / Messages.smg / Messages.smgr / Groups.seg / Windows.swn
//
// Everything here is grounded in byte-level analysis of the four projects that
// ship with this installation; the file formats are undocumented Delphi streams.
// The parser is deliberately conservative: a field is exposed only when its
// offset is proven, and unknown areas are returned as raw hex instead of being
// guessed. Edits rewrite only the proven bytes and the result is re-parsed.

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import path from 'node:path'

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

// 14-byte head of the fixed 32-byte record tail observed in Variables.svr:
//   ff ff | 04 00 00 00 | "0.##" (UTF-16) | 10 zero bytes | double 100.0
const VAR_TAIL_HEAD = Buffer.from('ffff0400000030002e0023002300', 'hex')

function readFileOrNull(p) {
  try { return existsSync(p) ? readFileSync(p) : null } catch (e) { return null }
}

function isPrintable(text) {
  for (const ch of text) {
    const c = ch.codePointAt(0)
    if (c < 32 && c !== 9) return false
    if (c === 0xfffd) return false
  }
  return text.length > 0
}

// ---------------------------------------------------------------------------
// Variables.svrr - compact runtime index: groups -> (name, id, description)
// ---------------------------------------------------------------------------
export function parseVariablesIndex(buf) {
  if (!buf || buf.length < 12) return { groups: [], items: [] }
  let o = 0
  const groupCount = buf.readUInt32LE(o); o += 4
  const groups = []
  const items = []
  for (let g = 0; g < groupCount; g++) {
    if (o + 4 > buf.length) break
    const nlen = buf.readUInt32LE(o); o += 4
    const name = buf.subarray(o, o + nlen).toString('utf8'); o += nlen
    groups.push(name)
    // Variables follow until the next group name. Each entry: u32 size, u32
    // nameLen, name, then an id/description block; the description is the last
    // UTF-16 string before the next entry, so scan forward for entry starts.
    const starts = []
    let p = o
    while (p + 8 <= buf.length) {
      const size = buf.readUInt32LE(p)
      const nl = buf.readUInt32LE(p + 4)
      if (nl < 1 || nl > 64 || p + 8 + nl > buf.length) break
      const candidate = buf.subarray(p + 8, p + 8 + nl).toString('utf8')
      if (!NAME_RE.test(candidate)) break
      starts.push({ start: p, size: size, name: candidate, nameEnd: p + 8 + nl })
      p = p + 8 + nl
      // skip the numeric block: find the UTF-16 description that follows
      let q = p
      let desc = ''
      while (q + 4 <= buf.length) {
        const n = buf.readUInt32LE(q)
        if (n > 0 && n <= 512 && q + 4 + n * 2 <= buf.length) {
          const text = buf.subarray(q + 4, q + 4 + n * 2).toString('utf16le')
          if (isPrintable(text)) { desc = text; q = q + 4 + n * 2; break }
        }
        q++
      }
      if (q === p) break
      items.push({ group: name, name: candidate, description: desc })
      p = q
    }
    o = p
  }
  return { groups: groups, items: items }
}

// ---------------------------------------------------------------------------
// Variables.svr - full variable records
// ---------------------------------------------------------------------------
function findRecordEnds(buf, firstRecordOffset) {
  const records = []
  let o = firstRecordOffset
  while (o + 8 <= buf.length) {
    const nlen = buf.readUInt32LE(o)
    if (nlen < 1 || nlen > 200 || o + 4 + nlen > buf.length) break
    const name = buf.subarray(o + 4, o + 4 + nlen).toString('utf8')
    if (!NAME_RE.test(name)) break
    const tail = buf.indexOf(VAR_TAIL_HEAD, o + 4 + nlen)
    if (tail < 0 || tail + 32 > buf.length) break
    const end = tail + 32
    records.push({ offset: o, name: name, tail: tail, end: end })
    o = end
  }
  return records
}

function collectWideStrings(buf, from, to) {
  const out = []
  let o = from
  while (o + 4 <= to) {
    const n = buf.readUInt32LE(o)
    if (n >= 1 && n <= 512 && o + 4 + n * 2 <= to) {
      const text = buf.subarray(o + 4, o + 4 + n * 2).toString('utf16le')
      if (isPrintable(text) && /[A-Za-z\u0400-\u04ff0-9 ._#()/-]/.test(text)) {
        out.push({ offset: o, lengthField: n, text: text })
        o = o + 4 + n * 2
        continue
      }
    }
    o++
  }
  return out
}

// A group header is followed by a short preamble before the first record, so
// look for a record start within a small window instead of assuming alignment.
function findFirstRecord(buf, from, window) {
  const limit = Math.min(buf.length - 8, from + (window || 24))
  for (let o = from; o <= limit; o++) {
    const nl = buf.readUInt32LE(o)
    if (nl < 1 || nl > 200 || o + 4 + nl > buf.length) continue
    if (!NAME_RE.test(buf.subarray(o + 4, o + 4 + nl).toString('utf8'))) continue
    if (findRecordEnds(buf, o).length) return o
  }
  return -1
}

export function parseVariables(buf, includeRaw) {
  const warnings = []
  let o = 0
  const version = buf.readUInt32LE(o); o += 4
  const reserved = buf.readUInt32LE(o); o += 4
  const groupCount = buf.readUInt32LE(o); o += 4
  const groups = []
  let total = 0

  for (let g = 0; g < groupCount; g++) {
    if (o + 4 > buf.length) {
      warnings.push('group ' + (g + 1) + ' of ' + groupCount + ': file ended early')
      break
    }
    const nlen = buf.readUInt32LE(o); o += 4
    if (nlen > 512 || o + nlen > buf.length) {
      warnings.push('group ' + (g + 1) + ' of ' + groupCount + ': implausible group name length ' + nlen)
      break
    }
    const groupName = buf.subarray(o, o + nlen).toString('utf8'); o += nlen
    // 9-byte group preamble was observed (01 | u32 71 | u32 18); detect the
    // first record instead of hard-coding it.
    let first = findFirstRecord(buf, o, 64)
    if (first < 0) {
      first = o
      warnings.push('group "' + groupName + '": could not locate the first variable record')
    }
    const preamble = buf.subarray(o, first)
    const recs = findRecordEnds(buf, first)
    if (!recs.length) warnings.push('group "' + groupName + '": no variable records decoded')
    const vars = recs.map(function (r) {
      const body = buf.subarray(r.offset, r.end)
      const nameEnd = 4 + r.name.length
      const strings = collectWideStrings(buf, r.offset + nameEnd, r.tail)
      const labelled = strings.map(function (s, i) { return { index: i, text: s.text, offsetInRecord: s.offset - r.offset } })
      let description = ''
      if (labelled.length && !/^Noname/i.test(labelled[0].text)) description = labelled[0].text
      return {
        name: r.name,
        description: description,
        strings: labelled.map(function (s) { return s.text }),
        // absolute offsets of each wide string's u32 length field, needed for
        // surgical edits (record byte layout is otherwise unproven)
        stringFields: strings.map(function (s) { return s.offset }),
        record: {
          offset: r.offset,
          length: r.end - r.offset,
          // raw bytes are large: only emit them on request (includeRaw)
          hex: includeRaw ? body.toString('hex') : undefined,
        },
      }
    })
    total += vars.length
    groups.push({ name: groupName, preamble: preamble.toString('hex'), variables: vars })
    const lastEnd = recs.length ? recs[recs.length - 1].end : first
    o = lastEnd
    if (!recs.length || g === groupCount - 1) continue
    // A new group starts with u32 nameLen + printable UTF-8 name, immediately
    // followed by at least one decodable variable record. Both conditions are
    // required: several projects store "..\\" (the root group marker) as a name.
    let next = -1
    for (let cand = lastEnd; cand + 4 <= buf.length && cand - lastEnd <= 72; cand++) {
      const nl = buf.readUInt32LE(cand)
      if (nl < 1 || nl > 512 || cand + 4 + nl > buf.length) continue
      const raw = buf.subarray(cand + 4, cand + 4 + nl)
      const name = raw.toString('utf8')
      if (!name || Buffer.byteLength(name, 'utf8') !== raw.length) continue
      if (/[\u0000-\u001f\ufffd]/.test(name)) continue
      if (findFirstRecord(buf, cand + 4 + nl, 24) < 0) continue
      next = cand
      break
    }
    o = next >= 0 ? next : buf.length
  }

  if (version !== 8) warnings.push('unexpected Variables.svr header version ' + version + ' (expected 8)')
  return { version: version, reserved: reserved, groups: groups, total: total, warnings: warnings }
}

// ---------------------------------------------------------------------------
// Pages.spg is a nested Delphi stream: page/subpage headers followed by element
// records (~158 bytes each in project_SwimmingPool) that carry a u32-length-
// prefixed ASCII name, an element type id, geometry as singles and property
// blocks. The u32 length prefix makes object names reliably detectable, but the
// surrounding record fields are not mapped yet, so this reader returns the
// page/subpage skeleton plus the object-name index and editing is refused.
const PAGE_NAME_RE = /[A-Za-z_][A-Za-z0-9_]{2,40}/g

export function parsePages(buf) {
  const warnings = []
  const latin = buf.toString('latin1')
  const names = []
  let m
  PAGE_NAME_RE.lastIndex = 0
  while ((m = PAGE_NAME_RE.exec(latin)) !== null) {
    const start = m.index
    if (start < 4) continue
    if (buf.readUInt32LE(start - 4) !== m[0].length) continue
    const prev = start > 0 ? buf[start - 1] : 0
    if ((prev >= 48 && prev <= 57) || (prev >= 65 && prev <= 90) || (prev >= 97 && prev <= 122)) continue
    names.push({ name: m[0], offset: start })
  }

  const captions = []
  for (let i = 0; i + 6 < buf.length; i++) {
    const n = buf.readUInt32LE(i)
    if (n >= 2 && n <= 200 && i + 4 + n * 2 <= buf.length) {
      const text = buf.subarray(i + 4, i + 4 + n * 2).toString('utf16le')
      if (isPrintable(text) && /[A-Za-z\u0400-\u04ff]/.test(text)) {
        captions.push({ offset: i, text: text })
        i += 4 + n * 2 - 1
      }
    }
  }

  const captionFor = function (offset) {
    const hit = captions.find(function (c) { return c.offset > offset && c.offset - offset < 260 })
    return hit ? hit.text : null
  }

  const pages = []
  for (const item of names) {
    const isFirst = pages.length === 0
    if (!isFirst && !/^Page/i.test(item.name)) continue
    if (isFirst && /^Subpage/i.test(item.name)) continue
    pages.push({ name: item.name, offset: item.offset, caption: captionFor(item.offset), subpages: [], elements: [] })
  }
  for (const item of names) {
    if (!/^Subpage/i.test(item.name)) continue
    const target = pages[pages.length - 1]
    if (target) target.subpages.push({ name: item.name, offset: item.offset, caption: captionFor(item.offset), elements: [] })
  }

  const objectNames = names.filter(function (n) { return !/^(Page|Subpage)/i.test(n.name) })
  warnings.push('Pages.spg is partially decoded: the page/subpage skeleton and the object-name index are available; element type, geometry, per-element captions and variable bindings are not mapped yet, so pages are read-only in this build')
  if (!pages.length) warnings.push('Pages.spg: no page header decoded')
  return { pages: pages, objectNames: objectNames, captions: captions.slice(0, 200), warnings: warnings }
}

// ---------------------------------------------------------------------------
// Project.spr - project settings
// ---------------------------------------------------------------------------
export function parseProjectSettings(buf) {
  const out = { name: null, guid: null, db: {}, fields: {}, warnings: [] }
  // name: the first u32-length + ascii identifier string
  for (let o = 0; o + 8 < Math.min(buf.length, 200); o++) {
    const n = buf.readUInt32LE(o)
    if (n >= 2 && n <= 64 && o + 4 + n <= buf.length) {
      const text = buf.subarray(o + 4, o + 4 + n).toString('utf8')
      if (text.length > 1 && /^[\x20-\x7e]+$/.test(text)) { out.name = text; out.fields.nameOffset = o; break }
    }
  }
  // GUID: u32 0x24 followed by 36 UTF-16 chars
  for (let o = 0; o + 8 < buf.length; o++) {
    if (buf.readUInt32LE(o) === 0x24) {
      const text = buf.subarray(o + 4, o + 4 + 0x24 * 2).toString('utf16le')
      if (/^[0-9A-Fa-f-]{36}$/.test(text)) { out.guid = text; out.fields.guidOffset = o; break }
    }
  }
  // database strings after the GUID: host, db, user, password as u32+utf8
  if (out.fields.guidOffset) {
    let o = out.fields.guidOffset + 4 + 0x24 * 2
    const strings = []
    for (let i = 0; i < 6 && o + 4 <= buf.length; i++) {
      const n = buf.readUInt32LE(o)
      if (n > 200 || o + 4 + n > buf.length) break
      const text = buf.subarray(o + 4, o + 4 + n).toString('utf8')
      if (!/^[\x20-\x7e]*$/.test(text)) break
      strings.push({ offset: o, value: text })
      o += 4 + n
    }
    out.db = { host: strings[0] && strings[0].value, name: strings[1] && strings[1].value, user: strings[2] && strings[2].value, hasPassword: !!(strings[3] && strings[3].value) }
    out.fields.dbOffsets = strings.map(function (s) { return s.offset })
  }
  out.size = buf.length
  out.hex = buf.toString('hex')
  out.warnings.push('Project.spr flag bytes (web access, built-in OPC UA server, script logging) are not mapped yet, so project settings are read-only')
  return out
}

// ---------------------------------------------------------------------------
// project-level helpers
// ---------------------------------------------------------------------------
export const PROJECT_FILES = {
  variables: 'Variables.svr',
  variablesIndex: 'Variables.svrr',
  pages: 'Pages.spg',
  project: 'Project.spr',
  trends: 'Trends.str',
  messages: 'Messages.smg',
  messagesRead: 'Messages.smgr',
  groups: 'Groups.seg',
  windows: 'Windows.swn',
  scripts: path.join('Scripts', 'Scripts.ssc'),
  program: path.join('Scripts', 'Compiled', 'program.exs'),
}

export function readVariables(dir, includeRaw) {
  const file = path.join(dir, PROJECT_FILES.variables)
  if (!existsSync(file)) throw new Error('missing ' + file)
  const parsed = parseVariables(readFileSync(file), includeRaw)
  let index = null
  const indexFile = path.join(dir, PROJECT_FILES.variablesIndex)
  if (existsSync(indexFile)) {
    try { index = parseVariablesIndex(readFileSync(indexFile)) } catch (e) { index = null }
  }
  const items = []
  for (const g of parsed.groups) {
    for (const v of g.variables) {
      const rt = index ? index.items.find(function (it) { return it.name === v.name }) : null
      items.push({
        group: g.name,
        name: v.name,
        description: v.description || (rt ? rt.description : ''),
        strings: v.strings,
        record: { offset: v.record.offset, length: v.record.length },
      })
    }
  }
  return { file: file, groups: parsed.groups, total: parsed.total, items: items, warnings: parsed.warnings, index: index ? index.groups : [] }
}

export function readPages(dir) {
  const file = path.join(dir, PROJECT_FILES.pages)
  if (!existsSync(file)) return { pages: [], warnings: ['missing Pages.spg'] }
  return parsePages(readFileSync(file))
}

export function readProjectSettings(dir) {
  const file = path.join(dir, PROJECT_FILES.project)
  if (!existsSync(file)) return { warnings: ['missing Project.spr'] }
  return parseProjectSettings(readFileSync(file))
}

export function summarizeProject(dir) {
  const out = { files: {}, counts: {}, bytecode: null, warnings: [] }
  const add = function (key, rel) {
    const p = path.join(dir, rel)
    if (existsSync(p)) {
      const s = statSync(p)
      out.files[key] = { name: rel, size: s.size, mtime: new Date(s.mtimeMs).toISOString() }
      return true
    }
    return false
  }
  add('variables', PROJECT_FILES.variables)
  add('variablesIndex', PROJECT_FILES.variablesIndex)
  add('pages', PROJECT_FILES.pages)
  add('project', PROJECT_FILES.project)
  add('trends', PROJECT_FILES.trends)
  add('messages', PROJECT_FILES.messages)
  add('scripts', PROJECT_FILES.scripts)
  add('program', PROJECT_FILES.program)
  add('reports', 'Reports')

  try {
    const v = readVariables(dir)
    out.counts.variables = v.total
    out.counts.variableGroups = v.groups.length
    out.warnings.push.apply(out.warnings, v.warnings)
  } catch (e) { out.warnings.push('variables: ' + e.message) }

  try {
    const p = readPages(dir)
    out.counts.pages = p.pages.length
    out.counts.subpages = p.pages.reduce(function (a, pg) { return a + (pg.subpages || []).length }, 0)
    out.counts.objectNames = (p.objectNames || []).length
  } catch (e) { out.warnings.push('pages: ' + e.message) }

  const scriptsFile = path.join(dir, PROJECT_FILES.scripts)
  if (existsSync(scriptsFile)) {
    try {
      // imported lazily to keep this module free of cycles
      out.counts.scripts = countScripts(readFileSync(scriptsFile))
    } catch (e) { out.warnings.push('scripts: ' + e.message) }
  }

  const src = out.files.scripts
  const prog = out.files.program
  if (src && !prog) out.bytecode = { stale: true, reason: 'never compiled (no program.exs)' }
  else if (src && prog) {
    const stale = Date.parse(src.mtime) > Date.parse(prog.mtime) + 1000
    out.bytecode = {
      stale: stale,
      reason: stale ? 'Scripts.ssc is newer than the compiled bytecode' : 'bytecode is up to date',
      sourceMtime: src.mtime,
      programMtime: prog.mtime,
    }
  }
  return out
}

function countScripts(buf) {
  // structural count without depending on ssc.js (avoids an import cycle)
  let o = 23
  let n = 0
  while (o + 8 <= buf.length) {
    o += 8
    const nameLen = buf.readUInt32LE(o); o += 4
    if (nameLen < 1 || nameLen > 4096 || o + nameLen * 2 > buf.length) break
    o += nameLen * 2 + 18
    const lines = buf.readUInt32LE(o); o += 4
    if (lines > 100000) break
    for (let i = 0; i < lines; i++) {
      const len = buf.readUInt32LE(o); o += 4
      if (o + len * 2 > buf.length) return n
      o += len * 2
    }
    n++
  }
  return n
}

// ---------------------------------------------------------------------------
// edits (only proven fields; everything else is refused, never guessed)
// ---------------------------------------------------------------------------
function rewriteRecord(buf, record, replaceOffsetAbs, replaceLength, replacement) {
  return Buffer.concat([
    buf.subarray(0, replaceOffsetAbs),
    replacement,
    buf.subarray(replaceOffsetAbs + replaceLength),
  ])
}

export function editVariables(dir, action, payload, dryRun) {
  const file = path.join(dir, PROJECT_FILES.variables)
  if (!existsSync(file)) throw new Error('missing ' + file)
  const buf = readFileSync(file)
  const parsed = parseVariables(buf)
  const name = payload && payload.name
  if (!name) throw new Error('payload.name is required')
  if (action !== 'set') {
    throw new Error('variable action "' + action + '" is not implemented yet: adding and removing variables requires the full Variables.svr field map (records carry unproven flag/limit bytes). Supported now: action=set with a description.')
  }

  let target = null
  for (const g of parsed.groups) {
    const v = g.variables.find(function (x) { return x.name === name })
    if (v) { target = { group: g, variable: v }; break }
  }
  if (!target) throw new Error('variable not found: ' + name)

  const set = (payload && payload.set) || {}
  const supported = ['description']
  const unsupported = Object.keys(set).filter(function (k) { return supported.indexOf(k) < 0 })
  if (unsupported.length) {
    throw new Error('unsupported variable fields: ' + unsupported.join(', ') + '. Proven writable fields right now: ' + supported.join(', ') + '. Initial value/limits/type need the Variables.svr field map (see tmp/re report); edit them in the editor until then.')
  }
  if (set.description === undefined) throw new Error('nothing to change: pass set.description')

  const v = target.variable
  if (!v.strings.length || !v.stringFields || !v.stringFields.length) {
    throw new Error('variable "' + name + '" has no decoded wide-string fields; cannot place a description')
  }
  // The first wide string of a record is the description. Variables created
  // without one start with the "Noname server" placeholder instead, so an empty
  // description is written by inserting a new leading string.
  const hasRealDescription = !/^Noname/i.test(v.strings[0])
  const lengthFieldOffset = v.stringFields[0]
  const oldLen = buf.readUInt32LE(lengthFieldOffset)
  const oldBytes = 4 + oldLen * 2
  const replacement = Buffer.from(String(set.description), 'utf16le')
  const lenBuf = Buffer.alloc(4)
  lenBuf.writeUInt32LE(replacement.length / 2, 0)
  const out = Buffer.concat([
    buf.subarray(0, lengthFieldOffset),
    lenBuf,
    replacement,
    buf.subarray(lengthFieldOffset + (hasRealDescription ? oldBytes : 0)),
  ])
  // prove the rewrite: same variable list, new description, everything else same
  const re = parseVariables(out)
  const flat = []
  for (const g of re.groups) for (const x of g.variables) flat.push(x)
  const oldFlat = []
  for (const g of parsed.groups) for (const x of g.variables) oldFlat.push(x)
  if (flat.length !== oldFlat.length) throw new Error('internal check failed: variable count changed')
  const updated = flat.find(function (x) { return x.name === name })
  if (!updated || updated.strings[0] !== set.description) throw new Error('internal check failed: description not applied')
  if (!dryRun) writeFileSync(file, out)
  return {
    action: 'set',
    variable: name,
    fields: Object.keys(set),
    description: set.description,
    file: file,
    dryRun: !!dryRun,
    sizes: { before: buf.length, after: out.length, delta: out.length - buf.length },
  }
}

export function editPages(dir, action, payload, dryRun) {
  throw new Error('page editing is not implemented: Pages.spg element records are not fully mapped yet (names/captions are readable through scada_read what=pages). Modelling is available for variables descriptions and for scripts today.')
}

export function editProjectSettings(dir, action, payload, dryRun) {
  throw new Error('project settings editing is not implemented: Project.spr flag bytes (web access, built-in OPC UA server, logging) are not mapped yet. Enable the UA server once in the editor: Проект -> Настройки.')
}
