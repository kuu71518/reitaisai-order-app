// Regenerate the distributable blank workbook with the Codex bundled runtime.
// Run with --runtime-modules <bundled node_modules path or a junction to it>.
// Artifact Tool and JSZip are authoring tools only; they are not app dependencies.
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { EVENT_GROUPS } from '../frontend/src/lib/eventGroups.js'

const argument = (name) => process.argv[process.argv.indexOf(name) + 1]
if (!process.argv.includes('--runtime-modules')) {
  throw new Error('Pass --runtime-modules with the Codex bundled node_modules path.')
}
const runtimeModules = path.resolve(argument('--runtime-modules'))
const runtimeRequire = createRequire(path.join(runtimeModules, '__member_template__.cjs'))
const { Workbook, SpreadsheetFile } = await import(pathToFileURL(runtimeRequire.resolve('@oai/artifact-tool')).href)
const { default: JSZip } = await import(pathToFileURL(runtimeRequire.resolve('jszip')).href)

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputPath = path.join(root, 'frontend/public/templates/member-import.xlsx')
const previewDir = path.join(root, 'output/playwright/member-template')
const workbook = Workbook.create()
const input = workbook.worksheets.add('メンバー追加')
const guide = workbook.worksheets.add('使い方')
const ink = '#262626'
const accent = '#6F3540'
const font = 'Meiryo'

input.showGridLines = false
input.tabColor = accent
input.getRange('A1:D101').format = {
  font: { name: font, size: 11, color: ink },
  verticalAlignment: 'center',
  horizontalAlignment: 'left',
  rowHeight: 26,
}
input.getRange('A1:D1').values = [['参加者名', 'DiscordユーザーID', 'グループ', '権限']]
input.getRange('A2:D101').format.numberFormat = '@'
input.getRange('A2:D101').format.fill = '#FFF9E8'
input.getRange('A1:A101').format.columnWidth = 28
input.getRange('B1:B101').format.columnWidth = 32
input.getRange('C1:C101').format.columnWidth = 26
input.getRange('D1:D101').format.columnWidth = 20
const table = input.tables.add('A1:D101', true, 'MemberImportTable')
table.showFilterButton = true
input.getRange('A1:D1').format = {
  fill: accent,
  font: { name: font, size: 11, bold: true, color: '#FFFFFF' },
  horizontalAlignment: 'center',
  verticalAlignment: 'center',
  rowHeight: 32,
  borders: { insideVertical: { style: 'thin', color: '#FFFFFF' } },
}
input.getRange('D2:D101').dataValidation = {
  rule: { type: 'list', values: ['一般参加者', '担当者'] },
}
input.getRange('C2:C101').dataValidation = {
  rule: { type: 'list', values: EVENT_GROUPS },
}
input.freezePanes.freezeRows(1)

guide.showGridLines = false
guide.tabColor = '#9E9691'
guide.getRange('A1:B24').format = {
  font: { name: font, size: 11, color: ink },
  verticalAlignment: 'center',
  horizontalAlignment: 'left',
  rowHeight: 25,
}
guide.getRange('A1:A24').format.columnWidth = 25
guide.getRange('B1:B24').format.columnWidth = 104
guide.getRange('A2').values = [['メンバー一括登録の使い方']]
guide.getRange('A2:B2').format.rowHeight = 38
guide.getRange('A2').format.font = { name: font, size: 16, bold: true, color: accent }
guide.getRange('A3:B3').format.borders = { bottom: { style: 'thin', color: accent } }

const instructions = [
  [4, '登録までの手順', ''],
  [5, '1. リストを作る', '「メンバー追加」シートの2〜101行に、1人につき1行で入力します。最大100人です。'],
  [6, '2. Excelで保存', '入力後は .xlsx 形式で保存します。シート名、1行目の見出し、列の順番を変えないでください。'],
  [7, '3. アプリで確認', '管理画面の一括登録からファイルを選び、プレビューで参加者・ID・グループ・権限を確認します。'],
  [8, '4. 一括登録', 'エラーのある行をExcelで直して再保存・再選択し、確認後に登録します。既存メンバーの変更には使いません。'],
  [10, '入力する内容', ''],
  [11, '参加者名', 'アプリに表示する名前を入力します。'],
  [12, 'DiscordユーザーID', '半角数字16〜22桁のユーザーIDを文字列で入力します。ユーザー名や表示名では登録できません。'],
  [13, 'グループ', `セルの選択肢から「${EVENT_GROUPS.join('」または「')}」を選びます。席が決まってから入力してください。`],
  [14, '権限', 'セルの選択肢から「一般参加者」または「担当者」を選びます。管理者はこのリストから登録できません。'],
  [16, 'IDの桁落ちを防ぐ', ''],
  [17, '文字列のまま入力', 'B列は「文字列」書式に設定済みです。半角の先頭アポストロフィ（\'）に続けてIDを入力しても文字列として保持できます。'],
  [18, 'コピーするとき', 'コピー元も文字列であることを確認し、「値のみ貼り付け」でテンプレートの書式を保ちます。'],
  [19, '桁が変わったとき', 'Excelは長い数値の後半を丸めることがあります。後から書式を文字列に変えても戻りません。DiscordからIDを取り直してください。'],
  [21, '入力と保存の注意', ''],
  [22, '空行と上限', '使わない行は4列とも空欄にします。100人を超える場合はファイルを分け、登録前に重複を確認してください。'],
  [23, 'セルの内容', '数式を使わず文字を入力してください。入力規則は貼り付けで上書きされる場合があるため、アプリのプレビューで必ず確認します。'],
  [24, 'リストの取扱い', '記入後のファイルには参加者情報が含まれます。運営に必要な人だけで取り扱ってください。'],
]
for (const [row, label, detail] of instructions) {
  guide.getRange(`A${row}:B${row}`).values = [[label, detail]]
  if (!detail) {
    guide.getRange(`A${row}:B${row}`).format = {
      fill: '#F0E8E8',
      font: { name: font, size: 11, bold: true, color: accent },
      rowHeight: 28,
    }
  } else {
    guide.getRange(`A${row}`).format.font.bold = true
    guide.getRange(`B${row}`).format.wrapText = true
    guide.getRange(`A${row}:B${row}`).format.rowHeight = detail.length > 60 ? 47 : 39
  }
}

workbook.recalculate()
const inspected = await workbook.inspect({ kind: 'table', range: 'メンバー追加!A1:D3', include: 'values,formulas', tableMaxRows: 3, tableMaxCols: 4 })
console.log(inspected.ndjson)
const errors = await workbook.inspect({ kind: 'match', searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!|#SPILL!|#CALC!', options: { useRegex: true, maxResults: 10 }, summary: 'template formula error scan' })
console.log(errors.ndjson)

await fs.mkdir(previewDir, { recursive: true })
for (const [sheetName, range, filename] of [['メンバー追加', 'A1:D12', 'input.png'], ['使い方', 'A1:B24', 'guide.png']]) {
  const preview = await workbook.render({ sheetName, range, scale: 1.5, format: 'png' })
  await fs.writeFile(path.join(previewDir, filename), new Uint8Array(await preview.arrayBuffer()))
}
await fs.mkdir(path.dirname(outputPath), { recursive: true })
const xlsx = await SpreadsheetFile.exportXlsx(workbook)
await xlsx.save(outputPath)
await fs.rename(`${outputPath}.inspect.ndjson`, path.join(previewDir, 'artifact-inspection.ndjson'))

// Artifact Tool does not expose print setup in this runtime. Add only native
// print metadata and explicit validation prompts to the newly exported archive.
const zip = await JSZip.loadAsync(await fs.readFile(outputPath))
const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const printing = '<x:printOptions horizontalCentered="1"/><x:pageMargins left="0.3" right="0.3" top="0.4" bottom="0.4" header="0.2" footer="0.2"/><x:pageSetup paperSize="9" orientation="portrait" fitToWidth="1" fitToHeight="0"/>'
for (const number of [1, 2]) {
  const member = `xl/worksheets/sheet${number}.xml`
  let xml = await zip.file(member).async('string')
  if (!xml.includes(`<x:worksheet xmlns:x="${ns}"`)) throw new Error(`Unexpected worksheet namespace: ${member}`)
  xml = xml.replace(/<x:printOptions\b[^>]*\/>|<x:pageMargins\b[^>]*\/>|<x:pageSetup\b[^>]*\/>/g, '')
  xml = xml.replace('</x:sheetPr>', '<x:pageSetUpPr fitToPage="1"/></x:sheetPr>')
  const insertion = xml.search(/<x:(?:drawing|legacyDrawing|legacyDrawingHF|picture|oleObjects|controls|webPublishItems|tableParts|extLst)\b/)
  xml = insertion >= 0 ? `${xml.slice(0, insertion)}${printing}${xml.slice(insertion)}` : xml.replace('</x:worksheet>', `${printing}</x:worksheet>`)
  if (number === 1) {
    xml = xml.replace(/<x:dataValidation\b[^>]*>/g, (tag) => {
      const clean = tag.replace(/\s(?:allowBlank|showInputMessage|showErrorMessage|showDropDown|errorStyle|errorTitle|error|promptTitle|prompt)="[^"]*"/g, '')
      const isGroup = tag.includes('sqref="C2:C101"')
      const title = isGroup ? 'グループ' : '権限'
      const message = isGroup ? `${EVENT_GROUPS.join('または')}を選んでください。` : '一般参加者または担当者を選んでください。'
      return clean.replace('>', ` allowBlank="1" showInputMessage="1" showErrorMessage="1" showDropDown="0" errorStyle="stop" errorTitle="${title}を選択してください" error="${message}" promptTitle="${title}" prompt="${message}">`)
    })
  }
  zip.file(member, xml)
}
let workbookXml = await zip.file('xl/workbook.xml').async('string')
const printNames = '<x:definedName name="_xlnm.Print_Area" localSheetId="0">\'メンバー追加\'!$A$1:$D$101</x:definedName><x:definedName name="_xlnm.Print_Titles" localSheetId="0">\'メンバー追加\'!$1:$1</x:definedName><x:definedName name="_xlnm.Print_Area" localSheetId="1">\'使い方\'!$A$1:$B$24</x:definedName>'
workbookXml = workbookXml.includes('</x:definedNames>') ? workbookXml.replace('</x:definedNames>', `${printNames}</x:definedNames>`) : workbookXml.replace('</x:sheets>', `</x:sheets><x:definedNames>${printNames}</x:definedNames>`)
zip.file('xl/workbook.xml', workbookXml)
const finalBytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
await fs.writeFile(outputPath, finalBytes)
console.log(JSON.stringify({ output: outputPath, bytes: finalBytes.length, sheets: ['メンバー追加', '使い方'], blankInputRows: 100 }))
