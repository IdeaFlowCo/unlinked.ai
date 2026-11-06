import JSZip from 'jszip'
export const XMLNS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const escape = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;')
export const inline = (ref, text) => `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escape(text)}</t></is></c>`
export const worksheet = rows => `<worksheet xmlns="${XMLNS}"><sheetData>${rows}</sheetData></worksheet>`
export async function workbook(overrides = {}) {
  const files = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
    'xl/workbook.xml': `<workbook xmlns="${XMLNS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Previous investors" sheetId="1" r:id="rId1"/><sheet name="Private other tab" sheetId="2" state="hidden" r:id="rId2"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': worksheet(`<row r="1">${inline('A1', 'Name')}${inline('B1', 'Comment')}<c r="C1" s="1"/></row><row r="2">${inline('A2', 'Synthetic Maya')}${inline('B2', 'Private comment 🙂')}<c r="C2" s="1"/></row><row r="3"/><row r="5">${inline('A5', 'Synthetic Jules')}</row>`),
    'xl/worksheets/sheet2.xml': worksheet(`<row r="1">${inline('A1', 'Name')}${inline('B1', 'Comment')}</row><row r="2">${inline('A2', 'Unselected Person')}${inline('B2', 'Unselected private text')}</row>`),
    ...overrides,
  }
  const zip = new JSZip()
  for (const [name, value] of Object.entries(files)) if (value !== null) zip.file(name, value, { date: new Date('2020-01-01T00:00:00Z') })
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}
export const workbookInput = bytes => ({ fileBase64: bytes.toString('base64'), filename: 'Synthetic investors.xlsx', sheet: 'Previous investors',
  listName: 'Synthetic previous investors', mapping: { name: 'Name', notes: ['Comment'] }, retainOriginalConfirmed: true })
