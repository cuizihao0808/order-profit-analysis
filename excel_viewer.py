import argparse
import json
import posixpath
import re
import threading
import webbrowser
import zipfile
from datetime import datetime, timedelta
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from xml.etree import ElementTree as ET


ROOT_DIR = Path(__file__).resolve().parent
DATA_DIR = ROOT_DIR / "data"
XML_NS = {
    "main": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "rel": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "pkgrel": "http://schemas.openxmlformats.org/package/2006/relationships",
}
DATE_NUMFMT_IDS = {
    14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57,
}
DATE_FORMAT_TOKEN_RE = re.compile(r"(?:^|[^\\])[ymdhis]", re.IGNORECASE)


def list_workbooks() -> list[Path]:
    if not DATA_DIR.exists():
        return []
    return sorted(path for path in DATA_DIR.iterdir() if path.suffix.lower() == ".xlsx")


def normalize_sheet_path(target: str) -> str:
    joined = posixpath.normpath(posixpath.join("xl", target))
    if joined.startswith("../"):
        raise ValueError("Invalid sheet path")
    return joined


def excel_serial_to_text(value: float) -> str:
    base = datetime(1899, 12, 30)
    actual = base + timedelta(days=value)
    if actual.time() == datetime.min.time():
        return actual.strftime("%Y-%m-%d")
    return actual.strftime("%Y-%m-%d %H:%M:%S")


def is_date_style(num_fmt_id: int, custom_formats: dict[int, str]) -> bool:
    if num_fmt_id in DATE_NUMFMT_IDS:
        return True
    custom_format = custom_formats.get(num_fmt_id)
    if not custom_format:
        return False
    return bool(DATE_FORMAT_TOKEN_RE.search(custom_format.replace('"', '')))


def get_shared_strings(archive: zipfile.ZipFile) -> list[str]:
    try:
        shared_root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
    except KeyError:
        return []

    values: list[str] = []
    for item in shared_root.findall("main:si", XML_NS):
        text_parts = [node.text or "" for node in item.findall(".//main:t", XML_NS)]
        values.append("".join(text_parts))
    return values


def get_style_map(archive: zipfile.ZipFile) -> dict[int, bool]:
    try:
        styles_root = ET.fromstring(archive.read("xl/styles.xml"))
    except KeyError:
        return {}

    custom_formats: dict[int, str] = {}
    numfmts = styles_root.find("main:numFmts", XML_NS)
    if numfmts is not None:
        for fmt in numfmts.findall("main:numFmt", XML_NS):
            num_fmt_id = fmt.get("numFmtId")
            format_code = fmt.get("formatCode")
            if num_fmt_id and format_code:
                custom_formats[int(num_fmt_id)] = format_code

    style_map: dict[int, bool] = {}
    cellxfs = styles_root.find("main:cellXfs", XML_NS)
    if cellxfs is None:
        return style_map

    for index, xf in enumerate(cellxfs.findall("main:xf", XML_NS)):
        num_fmt_id = int(xf.get("numFmtId", "0"))
        style_map[index] = is_date_style(num_fmt_id, custom_formats)
    return style_map


def parse_workbook_metadata(archive: zipfile.ZipFile) -> list[dict[str, str]]:
    workbook_root = ET.fromstring(archive.read("xl/workbook.xml"))
    rels_root = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
    relation_map = {
        rel.get("Id"): rel.get("Target", "")
        for rel in rels_root.findall("pkgrel:Relationship", XML_NS)
    }

    sheets: list[dict[str, str]] = []
    for sheet in workbook_root.findall("main:sheets/main:sheet", XML_NS):
        rel_id = sheet.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id")
        target = relation_map.get(rel_id or "")
        if not target:
            continue
        sheets.append(
            {
                "name": sheet.get("name", "Sheet"),
                "path": normalize_sheet_path(target),
            }
        )
    return sheets


def column_index_from_ref(cell_ref: str) -> int:
    letters = ""
    for char in cell_ref:
        if char.isalpha():
            letters += char
        else:
            break

    index = 0
    for char in letters.upper():
        index = index * 26 + ord(char) - ord("A") + 1
    return max(index - 1, 0)


def cell_text(cell: ET.Element, shared_strings: list[str], style_map: dict[int, bool]) -> str:
    cell_type = cell.get("t")
    style_index = int(cell.get("s", "0"))
    value_node = cell.find("main:v", XML_NS)

    if cell_type == "inlineStr":
        return "".join(node.text or "" for node in cell.findall(".//main:t", XML_NS))
    if value_node is None or value_node.text is None:
        return ""

    raw_value = value_node.text
    if cell_type == "s":
        try:
            return shared_strings[int(raw_value)]
        except (ValueError, IndexError):
            return raw_value
    if cell_type == "b":
        return "TRUE" if raw_value == "1" else "FALSE"
    if cell_type == "str":
        return raw_value

    if style_map.get(style_index):
        try:
            return excel_serial_to_text(float(raw_value))
        except ValueError:
            return raw_value

    return raw_value


def parse_sheet_rows(archive: zipfile.ZipFile, sheet_path: str, shared_strings: list[str], style_map: dict[int, bool]) -> list[list[str]]:
    sheet_root = ET.fromstring(archive.read(sheet_path))
    rows: list[list[str]] = []

    for row in sheet_root.findall("main:sheetData/main:row", XML_NS):
        row_values: list[str] = []
        for cell in row.findall("main:c", XML_NS):
            cell_ref = cell.get("r", "A1")
            column_index = column_index_from_ref(cell_ref)
            while len(row_values) <= column_index:
                row_values.append("")
            row_values[column_index] = cell_text(cell, shared_strings, style_map)
        rows.append(row_values)

    max_columns = max((len(row) for row in rows), default=0)
    for row in rows:
        if len(row) < max_columns:
            row.extend([""] * (max_columns - len(row)))
    return rows


def read_workbook(file_name: str) -> dict[str, object]:
    workbook_path = (DATA_DIR / file_name).resolve()
    if workbook_path.parent != DATA_DIR.resolve() or workbook_path.suffix.lower() != ".xlsx":
        raise FileNotFoundError(file_name)
    if not workbook_path.exists():
        raise FileNotFoundError(file_name)

    with zipfile.ZipFile(workbook_path) as archive:
        shared_strings = get_shared_strings(archive)
        style_map = get_style_map(archive)
        sheets = parse_workbook_metadata(archive)
        sheet_payloads = []
        for sheet in sheets:
            rows = parse_sheet_rows(archive, sheet["path"], shared_strings, style_map)
            sheet_payloads.append({"name": sheet["name"], "rows": rows})

    return {
        "file": workbook_path.name,
        "sheets": sheet_payloads,
    }


HTML_PAGE = """<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Excel 预览</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f3ea;
      --panel: rgba(255, 255, 255, 0.84);
      --panel-strong: rgba(255, 255, 255, 0.96);
      --text: #1f2937;
      --muted: #6b7280;
      --accent: #8a4b2a;
      --accent-soft: #ead5c7;
      --line: rgba(138, 75, 42, 0.18);
      --shadow: 0 18px 40px rgba(73, 46, 28, 0.12);
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: "Microsoft YaHei UI", "PingFang SC", sans-serif;
      color: var(--text);
      background:
        radial-gradient(circle at top left, rgba(202, 156, 118, 0.25), transparent 32%),
        linear-gradient(160deg, #f5efe4 0%, #f9f7f1 44%, #efe3d4 100%);
    }

    .shell {
      width: min(1200px, calc(100vw - 32px));
      margin: 24px auto;
      padding: 24px;
      border: 1px solid rgba(255, 255, 255, 0.5);
      border-radius: 24px;
      background: var(--panel);
      backdrop-filter: blur(18px);
      box-shadow: var(--shadow);
    }

    h1 {
      margin: 0 0 8px;
      font-size: clamp(28px, 4vw, 42px);
      line-height: 1.05;
      letter-spacing: -0.03em;
    }

    p {
      margin: 0;
      color: var(--muted);
    }

    .toolbar {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 16px;
      margin: 24px 0 18px;
    }

    .field {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .field label {
      font-size: 13px;
      color: var(--muted);
    }

    select {
      width: 100%;
      padding: 12px 14px;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: var(--panel-strong);
      color: var(--text);
      font-size: 15px;
      outline: none;
    }

    .meta {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      margin-bottom: 18px;
    }

    .pill {
      padding: 8px 12px;
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--accent);
      font-size: 13px;
    }

    .status {
      min-height: 24px;
      margin-bottom: 12px;
      color: var(--muted);
    }

    .table-wrap {
      overflow: auto;
      border-radius: 18px;
      border: 1px solid var(--line);
      background: var(--panel-strong);
    }

    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 720px;
    }

    th, td {
      padding: 10px 12px;
      border-bottom: 1px solid rgba(31, 41, 55, 0.08);
      border-right: 1px solid rgba(31, 41, 55, 0.06);
      text-align: left;
      white-space: nowrap;
      font-size: 14px;
    }

    th {
      position: sticky;
      top: 0;
      background: #fcfaf7;
      z-index: 1;
    }

    tr:nth-child(even) td {
      background: rgba(245, 239, 228, 0.52);
    }

    .empty {
      padding: 32px 18px;
      text-align: center;
      color: var(--muted);
    }
  </style>
</head>
<body>
  <main class="shell">
    <h1>data 目录 Excel 预览</h1>
    <p>自动读取 data 目录下的 xlsx 文件，可切换文件和工作表查看内容。</p>

    <section class="toolbar">
      <div class="field">
        <label for="fileSelect">选择文件</label>
        <select id="fileSelect"></select>
      </div>
      <div class="field">
        <label for="sheetSelect">选择工作表</label>
        <select id="sheetSelect"></select>
      </div>
    </section>

    <div class="meta">
      <div class="pill" id="fileCount">文件数: 0</div>
      <div class="pill" id="sheetInfo">工作表: 0</div>
      <div class="pill" id="rowInfo">数据行: 0</div>
    </div>

    <div class="status" id="status">正在加载文件列表...</div>
    <div class="table-wrap">
      <div id="tableHost" class="empty">暂无数据</div>
    </div>
  </main>

  <script>
    const state = {
      files: [],
      workbook: null,
      currentSheetIndex: 0,
    };

    const fileSelect = document.getElementById('fileSelect');
    const sheetSelect = document.getElementById('sheetSelect');
    const statusEl = document.getElementById('status');
    const tableHost = document.getElementById('tableHost');
    const fileCountEl = document.getElementById('fileCount');
    const sheetInfoEl = document.getElementById('sheetInfo');
    const rowInfoEl = document.getElementById('rowInfo');

    function setStatus(message) {
      statusEl.textContent = message;
    }

    function setEmpty(message) {
      tableHost.className = 'empty';
      tableHost.innerHTML = '';
      tableHost.textContent = message;
    }

    function fillSelect(select, items, formatter) {
      select.innerHTML = '';
      items.forEach((item, index) => {
        const option = document.createElement('option');
        option.value = String(index);
        option.textContent = formatter(item, index);
        select.appendChild(option);
      });
      select.disabled = items.length === 0;
    }

    function renderTable(rows) {
      if (!rows.length) {
        setEmpty('当前工作表没有可显示的数据');
        rowInfoEl.textContent = '数据行: 0';
        return;
      }

      const headerRow = rows[0];
      const bodyRows = rows.slice(1);
      const table = document.createElement('table');
      const thead = document.createElement('thead');
      const headerTr = document.createElement('tr');

      headerRow.forEach((value, index) => {
        const th = document.createElement('th');
        th.textContent = value || `列 ${index + 1}`;
        headerTr.appendChild(th);
      });

      thead.appendChild(headerTr);
      table.appendChild(thead);

      const tbody = document.createElement('tbody');
      bodyRows.forEach((row) => {
        const tr = document.createElement('tr');
        row.forEach((value) => {
          const td = document.createElement('td');
          td.textContent = value;
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);

      tableHost.className = '';
      tableHost.innerHTML = '';
      tableHost.appendChild(table);
      rowInfoEl.textContent = `数据行: ${Math.max(rows.length - 1, 0)}`;
    }

    function renderCurrentSheet() {
      if (!state.workbook || !state.workbook.sheets.length) {
        setEmpty('没有可显示的工作表');
        return;
      }

      const sheet = state.workbook.sheets[state.currentSheetIndex] || state.workbook.sheets[0];
      sheetInfoEl.textContent = `工作表: ${state.workbook.sheets.length}`;
      renderTable(sheet.rows || []);
      setStatus(`当前文件: ${state.workbook.file} / 当前工作表: ${sheet.name}`);
    }

    async function loadWorkbook(fileName) {
      setStatus(`正在读取 ${fileName} ...`);
      const response = await fetch(`/api/workbook?file=${encodeURIComponent(fileName)}`);
      if (!response.ok) {
        throw new Error('读取工作簿失败');
      }

      state.workbook = await response.json();
      state.currentSheetIndex = 0;
      fillSelect(sheetSelect, state.workbook.sheets, (sheet) => sheet.name);
      renderCurrentSheet();
    }

    async function loadFiles() {
      const response = await fetch('/api/files');
      if (!response.ok) {
        throw new Error('加载文件列表失败');
      }

      state.files = await response.json();
      fileCountEl.textContent = `文件数: ${state.files.length}`;
      fillSelect(fileSelect, state.files, (file) => file);

      if (!state.files.length) {
        sheetInfoEl.textContent = '工作表: 0';
        rowInfoEl.textContent = '数据行: 0';
        setEmpty('data 目录下没有找到 xlsx 文件');
        setStatus('请先把 xlsx 文件放进 data 目录');
        return;
      }

      await loadWorkbook(state.files[0]);
    }

    fileSelect.addEventListener('change', async (event) => {
      const fileName = state.files[Number(event.target.value)];
      if (!fileName) {
        return;
      }
      try {
        await loadWorkbook(fileName);
      } catch (error) {
        setStatus(error.message);
        setEmpty('文件加载失败');
      }
    });

    sheetSelect.addEventListener('change', (event) => {
      state.currentSheetIndex = Number(event.target.value) || 0;
      renderCurrentSheet();
    });

    loadFiles().catch((error) => {
      setStatus(error.message);
      setEmpty('初始化失败');
    });
  </script>
</body>
</html>
"""


class WorkbookHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/":
            self.respond_html(HTML_PAGE)
            return

        if parsed.path == "/api/files":
            files = [path.name for path in list_workbooks()]
            self.respond_json(files)
            return

        if parsed.path == "/api/workbook":
            params = parse_qs(parsed.query)
            file_name = params.get("file", [""])[0]
            if not file_name:
                self.respond_json({"error": "Missing file"}, status=HTTPStatus.BAD_REQUEST)
                return
            try:
                payload = read_workbook(file_name)
            except FileNotFoundError:
                self.respond_json({"error": "File not found"}, status=HTTPStatus.NOT_FOUND)
                return
            except zipfile.BadZipFile:
                self.respond_json({"error": "Invalid xlsx file"}, status=HTTPStatus.BAD_REQUEST)
                return
            self.respond_json(payload)
            return

        self.respond_json({"error": "Not found"}, status=HTTPStatus.NOT_FOUND)

    def log_message(self, format: str, *args) -> None:
        return

    def respond_html(self, html: str) -> None:
        encoded = html.encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def respond_json(self, payload: object, status: HTTPStatus = HTTPStatus.OK) -> None:
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


def run_check() -> int:
    files = list_workbooks()
    print(f"xlsx files: {len(files)}")
    if not files:
        return 0

    workbook = read_workbook(files[0].name)
    print(f"first file: {workbook['file']}")
    print(f"sheet count: {len(workbook['sheets'])}")
    if workbook["sheets"]:
        first_sheet = workbook["sheets"][0]
        print(f"first sheet: {first_sheet['name']}")
        print(f"row count: {len(first_sheet['rows'])}")
    return 0


def open_browser_later(host: str, port: int) -> None:
    url = f"http://{host}:{port}"
    threading.Timer(0.6, lambda: webbrowser.open(url)).start()


def main() -> int:
    parser = argparse.ArgumentParser(description="Preview xlsx files from the data directory.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--check", action="store_true", help="Validate workbook discovery and parsing, then exit.")
    args = parser.parse_args()

    if args.check:
        return run_check()

    server = ThreadingHTTPServer((args.host, args.port), WorkbookHandler)
    open_browser_later(args.host, args.port)
    print(f"Open http://{args.host}:{args.port} in your browser")
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())