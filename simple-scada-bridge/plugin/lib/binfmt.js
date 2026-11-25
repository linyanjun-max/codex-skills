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
// Pages.spg - страницы, подстраницы и объекты экрана
//
// Формат восстановлен экспериментально: образцы нарисованы в редакторе, затем
// побайтово сопоставлены. Проверено на Simple-Scada 2.7.3.1 (Demo-64).
//
//   файл   = заголовок страницы + подстраница + u32 count + записи объектов
//   запись = [u16 type][u32 len(имя)][имя ASCII][тело]
//   type 0 = служебная запись: PageN, SubpageN, а также внутренние части
//            составных компонентов (Scale, Field у "Уровня")
//   1..18  = объекты экрана (см. ELEMENT_RU)
//
// Смещения внутри тела (body = offset + 6 + len(name)):
//   body+8    X, Y, W, H            (4 x float32)
//   body+40   цвет шрифта           (3 байта BGR)
//   body+45   цвет заливки          (3 байта BGR)
//   body+107  порядковый id объекта (u32, по +4 на объект)
//   body+111  основная переменная   ([u32 index][u32 0]; нет = FF x 8)
//   body+127  вторая переменная     (то же, «Доп. переменная»)
//   body+137  ТЕКСТ: u32 len + UTF-16LE
//   body+141  цвет границы          (3 байта BGR)
//   body+151 / +219  КНОПКА: имена состояний 1 и 2
//   body+171 / +235  КНОПКА: тексты состояний 1 и 2
//
// УРОКИ, за которые заплачено отладкой:
//  * id объекта читать и писать ТОЛЬКО по body+107. Поиск «любых u32 в
//    диапазоне 0x2400..0x2800» повреждает чужие поля: длина строки в 36..40
//    символов даёт 0x000024xx..0x000027xx, а цвет #24303A с соседним нулём -
//    0x00002430. Симптом: сервер пишет "Stream read error | subpage | page".
//  * «Уровень» - составная запись: за ней сразу идут служебные записи type 0
//    (Scale, Field). Клон обязан захватывать весь диапазон до следующей
//    записи с type != 0.
//  * размер страницы по умолчанию 1280 x 720, клиент масштабирует её под
//    экран (на 2560x1440 - ровно x2). Раскладку проектировать в 1280x720.
//  * Editor.exe держит проект в памяти: запись файла при открытом проекте
//    затирается следующим сохранением. Писать при закрытом редакторе.
//  * список проектов сервер читает при старте: новый каталог виден scada_run
//    только после перезапуска Server.exe.
//  * Demo-64 запускает не более одного проекта одновременно.
//  * проверить страницу без редактора можно так: перезапустить Server.exe,
//    scada_run start проекта и прочитать хвост Logs\Server-log.txt.
// ---------------------------------------------------------------------------
export const ELEMENT_RU = {
  1: 'Изображение', 2: 'Фигура', 3: 'Трубопровод', 4: 'Текст', 5: 'Поле',
  6: 'Шкала', 7: 'Кнопка', 8: 'Резервуар', 9: 'Уровень', 10: 'Временные тренды',
  11: 'Заслонка', 12: 'Линия', 13: 'Флажок', 14: 'Список', 15: 'Таблица',
  16: 'Календарь', 17: 'Список сообщений', 18: 'Расписание',
}

const BODY = {
  geometry: 8, fontColor: 40, fillColor: 45, objectId: 107,
  variable: 111, variable2: 127, caption: 137, borderColor: 141,
  btnName1: 151, btnText1: 171, btnName2: 219, btnText2: 235,
}

const MIN_ID = 0x2400
const MAX_ID = 0x3000

function scanMarks(buf) {
  const marks = []
  for (let i = 0; i + 8 < buf.length; i++) {
    const type = buf.readUInt16LE(i)
    if (type > 64) continue
    const n = buf.readUInt32LE(i + 2)
    if (n < 2 || n > 40 || i + 6 + n > buf.length) continue
    const name = buf.subarray(i + 6, i + 6 + n).toString('latin1')
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue
    marks.push({ offset: i, type: type, name: name, headerLength: 6 + n })
  }
  return marks
}

function elementEnd(marks, index, fallback) {
  for (let j = index + 1; j < marks.length; j++) {
    if (marks[j].type !== 0) return marks[j].offset
  }
  return fallback
}

function readGeometry(buf, base) {
  if (base + 16 > buf.length) return null
  const x = buf.readFloatLE(base), y = buf.readFloatLE(base + 4)
  const width = buf.readFloatLE(base + 8), height = buf.readFloatLE(base + 12)
  if ([x, y, width, height].some(function (v) { return v !== v })) return null
  return { x: x, y: y, width: width, height: height }
}

function readColor(buf, off) {
  if (off + 3 > buf.length) return null
  return '#' + [buf[off + 2], buf[off + 1], buf[off]]
    .map(function (v) { return v.toString(16).padStart(2, '0') }).join('').toUpperCase()
}

function readUtf16(buf, off) {
  if (off + 4 > buf.length) return null
  const n = buf.readUInt32LE(off)
  if (n > 4000 || off + 4 + n * 2 > buf.length) return null
  return buf.subarray(off + 4, off + 4 + n * 2).toString('utf16le')
}

function readVariable(buf, off) {
  if (off + 8 > buf.length) return null
  const index = buf.readUInt32LE(off)
  if (index === 0xffffffff) return null
  return { index: index, flags: buf.readUInt32LE(off + 4) }
}

function decodeElement(buf, mark, end) {
  const body = mark.offset + mark.headerLength
  const el = {
    name: mark.name,
    type: mark.type,
    typeName: ELEMENT_RU[mark.type] || ('type ' + mark.type),
    offset: mark.offset,
    length: end - mark.offset,
    id: body + BODY.objectId + 4 <= buf.length ? buf.readUInt32LE(body + BODY.objectId) : null,
    geometry: readGeometry(buf, body + BODY.geometry),
    variable: readVariable(buf, body + BODY.variable),
    variable2: readVariable(buf, body + BODY.variable2),
    colors: {
      font: readColor(buf, body + BODY.fontColor),
      fill: readColor(buf, body + BODY.fillColor),
      border: readColor(buf, body + BODY.borderColor),
    },
  }
  if (mark.type === 4) el.caption = readUtf16(buf, body + BODY.caption)
  if (mark.type === 7) {
    el.caption = readUtf16(buf, body + BODY.btnText1)
    el.caption2 = readUtf16(buf, body + BODY.btnText2)
    el.stateName1 = readUtf16(buf, body + BODY.btnName1)
    el.stateName2 = readUtf16(buf, body + BODY.btnName2)
  }
  return el
}

export function parsePages(buf) {
  const warnings = []
  const marks = scanMarks(buf)
  if (!marks.length) {
    return { pages: [], objectNames: [], elements: 0, warnings: ['Pages.spg: записей не найдено (пустая страница)'] }
  }
  const pages = []
  const objectNames = []
  let page = null
  let sub = null
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i]
    if (m.type === 0) {
      if (/^Page\d*$/i.test(m.name)) {
        page = { name: m.name, offset: m.offset, subpages: [], elements: [] }
        pages.push(page)
        sub = null
      } else if (/^Subpage/i.test(m.name)) {
        sub = { name: m.name, offset: m.offset, elements: [] }
        if (!page) { page = { name: null, offset: 0, subpages: [], elements: [] }; pages.push(page) }
        page.subpages.push(sub)
      }
      continue
    }
    const end = elementEnd(marks, i, buf.length)
    const el = decodeElement(buf, m, end)
    if (sub) sub.elements.push(el)
    else if (page) page.elements.push(el)
    objectNames.push({ name: m.name, type: m.type, offset: m.offset })
  }
  const total = pages.reduce(function (n, p) {
    return n + p.elements.length + p.subpages.reduce(function (k, s) { return k + s.elements.length }, 0)
  }, 0)
  if (!total) warnings.push('Pages.spg: страница есть, объектов нет')
  return { pages: pages, objectNames: objectNames, elements: total, warnings: warnings }
}

// ---------------------------------------------------------------------------
// запись
// ---------------------------------------------------------------------------
function parsePageModel(buf) {
  const marks = scanMarks(buf)
  const elements = []
  const objectMarks = marks.filter(function (m) { return m.type !== 0 })
  let countOffset = buf.length - 4
  let tail = Buffer.alloc(0)
  if (objectMarks.length) {
    countOffset = objectMarks[0].offset - 4
    if (countOffset < 0) throw new Error('Pages.spg: не найдено поле количества объектов')
    for (const m of objectMarks) {
      const idx = marks.indexOf(m)
      const end = elementEnd(marks, idx, buf.length)
      elements.push({ name: m.name, type: m.type, raw: Buffer.from(buf.subarray(m.offset, end)) })
    }
    const lastIdx = marks.indexOf(objectMarks[objectMarks.length - 1])
    const lastEnd = elementEnd(marks, lastIdx, buf.length)
    tail = Buffer.from(buf.subarray(lastEnd))
  }
  return { header: Buffer.from(buf.subarray(0, countOffset)), countOffset: countOffset, elements: elements, tail: tail }
}

function bodyLength(raw) {
  return 6 + raw.readUInt32LE(2)
}

function replaceRange(raw, start, end, data) {
  return Buffer.concat([raw.subarray(0, start), data, raw.subarray(end)])
}

function withName(raw, name) {
  const n = raw.readUInt32LE(2)
  const len = Buffer.alloc(4)
  len.writeUInt32LE(name.length, 0)
  return Buffer.concat([raw.subarray(0, 2), len, Buffer.from(name, 'latin1'), raw.subarray(6 + n)])
}

function withGeometry(raw, g) {
  const out = Buffer.from(raw)
  const base = bodyLength(raw) + BODY.geometry
  if (g.x !== undefined) out.writeFloatLE(g.x, base)
  if (g.y !== undefined) out.writeFloatLE(g.y, base + 4)
  if (g.width !== undefined) out.writeFloatLE(g.width, base + 8)
  if (g.height !== undefined) out.writeFloatLE(g.height, base + 12)
  return out
}

function withId(raw, id) {
  const out = Buffer.from(raw)
  out.writeUInt32LE(id >>> 0, bodyLength(raw) + BODY.objectId)
  return out
}

function readId(raw) {
  const body = bodyLength(raw)
  if (body + BODY.objectId + 4 > raw.length) return null
  return raw.readUInt32LE(body + BODY.objectId)
}

function withVariable(raw, index, slot) {
  const out = Buffer.from(raw)
  const off = bodyLength(raw) + (slot === 2 ? BODY.variable2 : BODY.variable)
  if (index === null || index === undefined) {
    out.fill(0xff, off, off + 8)
  } else {
    out.writeUInt32LE(index >>> 0, off)
    out.writeUInt32LE(0, off + 4)
  }
  return out
}

function withColor(raw, which, hex) {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) throw new Error('цвет должен быть в виде #RRGGBB: ' + hex)
  const out = Buffer.from(raw)
  const off = bodyLength(raw) + BODY[which]
  out[off] = parseInt(hex.slice(5, 7), 16)
  out[off + 1] = parseInt(hex.slice(3, 5), 16)
  out[off + 2] = parseInt(hex.slice(1, 3), 16)
  return out
}

function withUtf16(raw, bodyOffset, text) {
  const off = bodyLength(raw) + bodyOffset
  if (off + 4 > raw.length) throw new Error('смещение текста вне записи')
  const n = raw.readUInt32LE(off)
  if (n > 4000 || off + 4 + n * 2 > raw.length) throw new Error('не найдено поле текста')
  const data = Buffer.alloc(4 + text.length * 2)
  data.writeUInt32LE(text.length, 0)
  data.write(text, 4, 'utf16le')
  return replaceRange(raw, off, off + 4 + n * 2, data)
}

function variableIndexByName(dir, name) {
  const file = path.join(dir, PROJECT_FILES.variables)
  if (!existsSync(file)) throw new Error('нет Variables.svr: имя переменной не разрешить')
  const parsed = parseVariables(readFileSync(file), false)
  for (const g of parsed.groups) {
    const i = g.variables.findIndex(function (v) { return v.name === name })
    if (i >= 0) return i
  }
  throw new Error('переменная не найдена: ' + name)
}


export function editPages(dir, action, payload, dryRun) {
  const file = path.join(dir, PROJECT_FILES.pages)
  if (!existsSync(file)) throw new Error('нет файла ' + file)
  const buf = readFileSync(file)
  const p = payload || {}

  if (action === 'set-caption') {
    const parsed = parsePages(buf)
    const page = parsed.pages[0]
    if (!page) throw new Error('страница не найдена')
    const nameEnd = page.offset + 6 + page.name.length
    const len = buf.readUInt32LE(nameEnd)
    if (len > 200 || nameEnd + 4 + len * 2 > buf.length) throw new Error('не удалось найти подпись страницы')
    const caption = p.caption || ''
    const data = Buffer.alloc(4 + caption.length * 2)
    data.writeUInt32LE(caption.length, 0)
    data.write(caption, 4, 'utf16le')
    const out = replaceRange(buf, nameEnd, nameEnd + 4 + len * 2, data)
    if (!dryRun) writeFileSync(file, out)
    return {
      action: 'set-caption', page: page.name, caption: caption, file: file, dryRun: !!dryRun,
      sizes: { before: buf.length, after: out.length, delta: out.length - buf.length },
    }
  }

  const model = parsePageModel(buf)
  const find = function (name) {
    const i = model.elements.findIndex(function (e) { return e.name === name })
    if (i < 0) throw new Error('объект не найден: ' + name)
    return i
  }

  if (action === 'list') {
    const parsed = parsePages(buf)
    return { action: 'list', file: file, elements: model.elements.length, pages: parsed.pages, warnings: parsed.warnings }
  }

  if (action === 'move') {
    const i = find(p.name)
    model.elements[i].raw = withGeometry(model.elements[i].raw,
      { x: p.x, y: p.y, width: p.width, height: p.height })
  } else if (action === 'text') {
    const i = find(p.name)
    const el = model.elements[i]
    if (el.type !== 4 && el.type !== 7) throw new Error('поле текста есть только у «Текст» и «Кнопка»')
    el.raw = withUtf16(el.raw, el.type === 7 ? BODY.btnText1 : BODY.caption, p.text || '')
  } else if (action === 'variable') {
    const i = find(p.name)
    let index = p.index
    if (index === undefined && p.variable) index = variableIndexByName(dir, p.variable)
    model.elements[i].raw = withVariable(model.elements[i].raw, index === undefined ? null : index, p.slot || 1)
  } else if (action === 'color') {
    const i = find(p.name)
    let raw = model.elements[i].raw
    if (p.fill) raw = withColor(raw, 'fillColor', p.fill)
    if (p.border) raw = withColor(raw, 'borderColor', p.border)
    if (p.font) raw = withColor(raw, 'fontColor', p.font)
    model.elements[i].raw = raw
  } else if (action === 'clone') {
    const from = find(p.from)
    let raw = Buffer.from(model.elements[from].raw)
    if (p.name) raw = withName(raw, p.name)
    raw = withGeometry(raw, { x: p.x, y: p.y, width: p.width, height: p.height })
    if (p.variable !== undefined) raw = withVariable(raw, variableIndexByName(dir, p.variable), 1)
    if (p.index !== undefined) raw = withVariable(raw, p.index, 1)
    if (p.text !== undefined) {
      raw = withUtf16(raw, model.elements[from].type === 7 ? BODY.btnText1 : BODY.caption, p.text)
    }
    raw = withId(raw, 0)                       // 0 = «выдать новый id ниже»
    model.elements.push({ name: p.name || p.from, type: model.elements[from].type, raw: raw })
  } else if (action === 'delete') {
    model.elements.splice(find(p.name), 1)
  } else {
    throw new Error('unknown page action: ' + action + ' (list | move | text | variable | color | clone | delete | set-caption)')
  }

  // выдать уникальные id только новым объектам, существующие не трогаем
  const used = new Set()
  let nextId = MIN_ID
  for (const el of model.elements) {
    const id = readId(el.raw)
    if (id !== null && id >= MIN_ID && id < MAX_ID) {
      used.add(id)
      if (id + 4 > nextId) nextId = id + 4
    }
  }
  for (const el of model.elements) {
    const id = readId(el.raw)
    if (id === null || id === 0 || id >= MAX_ID) {
      while (used.has(nextId)) nextId += 4
      el.raw = withId(el.raw, nextId)
      used.add(nextId)
      nextId += 4
    }
  }

  const count = Buffer.alloc(4)
  count.writeUInt32LE(model.elements.length, 0)
  const out = Buffer.concat([model.header, count]
    .concat(model.elements.map(function (e) { return e.raw }))
    .concat([model.tail]))
  if (!dryRun) writeFileSync(file, out)

  const reparsed = parsePages(out)
  return {
    action: action, file: file, dryRun: !!dryRun,
    elements: model.elements.length,
    objects: reparsed.elements,
    sizes: { before: buf.length, after: out.length, delta: out.length - buf.length },
    warnings: reparsed.warnings,
  }
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


export function editProjectSettings(dir, action, payload, dryRun) {
  throw new Error('project settings editing is not implemented: Project.spr flag bytes (web access, built-in OPC UA server, logging) are not mapped yet. Enable the UA server once in the editor: Проект -> Настройки.')
}
