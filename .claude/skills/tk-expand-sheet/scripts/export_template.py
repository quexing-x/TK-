"""Fill the user-approved TK template while preserving its OOXML styles.

Input: {"workbooks": [{"name": "file.xlsx", "rows": [[7 text values], ...]}]}.
No network or live advertising operations. Uses Python standard library only.
"""
from __future__ import annotations
import argparse
import json
import pathlib
import re
import sys
import xml.etree.ElementTree as ET
import zipfile
from xml.sax.saxutils import escape, quoteattr

NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
N = {'s': NS}
HEADERS = ['推广系列名称', '广告组名称', '视频代码', '产品 URL', '年龄', '性别']
CELL = re.compile(r'<c\b([^>]*)>(.*?)</c>', re.S)

def shared_items(xml):
    items = re.findall(r'<si\b[^>]*(?:/>|>.*?</si>)', xml, re.S)
    assert len(items) == len(ET.fromstring(xml)), 'Unsupported shared-string serialization'
    return items

def compact_strings(parts):
    items = shared_items(parts['xl/sharedStrings.xml'].decode('utf-8'))
    mapping, selected, count = {}, [], 0
    def cell(match):
        nonlocal count
        attrs, body = match.groups()
        if not re.search(r'\bt="s"', attrs):
            return match.group(0)
        value = re.search(r'<v>(\d+)</v>', body)
        assert value, 'Shared-string cell has no index'
        old = int(value.group(1))
        assert old < len(items), 'Shared-string index invalid'
        if old not in mapping:
            mapping[old] = len(selected)
            selected.append(items[old])
        count += 1
        body = body[:value.start()] + f'<v>{mapping[old]}</v>' + body[value.end():]
        return f'<c{attrs}>{body}</c>'
    for name in parts:
        if name.startswith('xl/worksheets/') and name.endswith('.xml'):
            parts[name] = CELL.sub(cell, parts[name].decode('utf-8')).encode('utf-8')
    parts['xl/sharedStrings.xml'] = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<sst xmlns="{NS}" count="{count}" uniqueCount="{len(selected)}">'
        + ''.join(selected) + '</sst>').encode('utf-8')

def export(template, rows, output):
    with zipfile.ZipFile(template) as archive:
        infos = archive.infolist()
        parts = {i.filename: archive.read(i) for i in infos}
    styles = parts['xl/styles.xml']
    sheet_path = 'xl/worksheets/sheet1.xml'
    original = parts[sheet_path].decode('utf-8')
    data = ET.fromstring(original).find('s:sheetData', N)
    assert data is not None and len(data) >= 2, 'Template needs header and body prototype'
    strings = shared_items(parts['xl/sharedStrings.xml'].decode('utf-8'))
    texts = [''.join(ET.fromstring(si).itertext()) for si in strings]
    headers = [texts[int(c.find('s:v', N).text)] for c in data[0] if c.get('t') == 's']
    assert headers == HEADERS, 'Template header changed; inspect it before exporting'
    prototype = data[1]
    attrs_by_col = {re.sub(r'\d+$', '', c.get('r', '')): dict(c.attrib) for c in prototype}
    header = re.search(r'<row\b[^>]*\br="1"[^>]*>.*?</row>', original, re.S)
    assert header, 'Header row missing'
    contents = rows if rows is not None else [[''] * 7]
    # 与客户端 parseLaunchSheetTable 的两道闸门保持一致：
    # launchRows 的 zod schema 是 .max(500)，广告数是 MAX_LAUNCH_ADS_PER_IMPORT = 5000
    # （packages/core/src/launch.ts）。这里曾经写死 2000，比客户端严了一倍多，
    # 会把本来一张就够的表白白拆成两张。改这两个数前先去核对那两处。
    assert len(contents) <= 500, 'Split whole products above 500 rows'
    if rows is not None:
        assert sum(len([v for v in row[2].split(';') if v]) for row in rows) <= 5000, 'Split above 5000 ads'
    rendered = []
    for row_index, values in enumerate(contents, 2):
        assert len(values) == 7 and all(isinstance(v, str) for v in values), 'Expected seven text values'
        attrs = dict(prototype.attrib)
        attrs.update(r=str(row_index), spans='1:7')
        cells = []
        for col, value in zip('ABCDEFG', values):
            assert len(value) <= 32767 and not re.search(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', value)
            ca = dict(attrs_by_col.get(col, {}))
            ca['r'] = f'{col}{row_index}'
            for key in ['t', 'cm', 'vm']:
                ca.pop(key, None)
            inner = ''
            if value:
                ca['t'] = 's'
                index = len(strings)
                strings.append(f'<si><t xml:space="preserve">{escape(value)}</t></si>')
                inner = f'<v>{index}</v>'
            cells.append('<c' + ''.join(f' {k}={quoteattr(v)}' for k, v in ca.items()) + '>' + inner + '</c>')
        rendered.append('<row' + ''.join(f' {k}={quoteattr(v)}' for k, v in attrs.items()) + '>' + ''.join(cells) + '</row>')
    replacement = '<sheetData>' + header.group(0) + ''.join(rendered) + '</sheetData>'
    changed, matches = re.subn(r'<sheetData\b[^>]*>.*?</sheetData>', lambda _: replacement, original, count=1, flags=re.S)
    assert matches == 1
    changed = re.sub(r'<dimension\b[^>]*/>', f'<dimension ref="A1:G{len(contents) + 1}"/>', changed, count=1)
    parts[sheet_path] = changed.encode('utf-8')
    parts['xl/sharedStrings.xml'] = (f'<sst xmlns="{NS}">' + ''.join(strings) + '</sst>').encode('utf-8')
    compact_strings(parts)
    assert parts['xl/styles.xml'] == styles
    for name, value in parts.items():
        if name.endswith('.xml'):
            ET.fromstring(value)
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for info in infos:
            archive.writestr(info, parts[info.filename])

def main():
    sys.stdout.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--template', type=pathlib.Path, default=pathlib.Path(__file__).resolve().parent.parent / 'assets/TK广告批量创建模板.xlsx')
    parser.add_argument('--blank-template', type=pathlib.Path)
    parser.add_argument('--plan', type=pathlib.Path)
    parser.add_argument('--output-dir', type=pathlib.Path)
    args = parser.parse_args()
    if args.blank_template:
        export(args.template, None, args.blank_template)
        print(json.dumps({'blankTemplate': str(args.blank_template)}, ensure_ascii=False))
        return
    assert args.plan and args.output_dir, '--plan and --output-dir required'
    plan = json.loads(args.plan.read_text(encoding='utf-8-sig'))
    for book in plan['workbooks']:
        name = pathlib.Path(book['name']).name
        assert name == book['name'] and name.endswith('.xlsx')
        output = args.output_dir / name
        export(args.template, book['rows'], output)
        print(json.dumps({'output': str(output), 'rows': len(book['rows'])}, ensure_ascii=False))

if __name__ == '__main__':
    main()
