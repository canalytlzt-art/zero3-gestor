import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const openXmlReader = String.raw`
import json, posixpath, sys, zipfile
import xml.etree.ElementTree as ET
from io import BytesIO

main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
office_rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
package_rel = "http://schemas.openxmlformats.org/package/2006/relationships"
archive = zipfile.ZipFile(BytesIO(sys.stdin.buffer.read()))
bad = archive.testzip()
if bad:
    raise RuntimeError("Corrupt ZIP entry: " + bad)

workbook = ET.fromstring(archive.read("xl/workbook.xml"))
relationships = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
targets = {item.attrib["Id"]: item.attrib["Target"] for item in relationships.findall("{" + package_rel + "}Relationship")}
shared = []
if "xl/sharedStrings.xml" in archive.namelist():
    root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
    shared = ["".join(node.text or "" for node in item.findall(".//{" + main + "}t")) for item in root.findall("{" + main + "}si")]

names = []
strings = []
formula_cells = []
cell_count = 0
for sheet in workbook.findall(".//{" + main + "}sheet"):
    name = sheet.attrib["name"]
    names.append(name)
    rel_id = sheet.attrib["{" + office_rel + "}id"]
    target = targets[rel_id]
    path = target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join("xl", target))
    root = ET.fromstring(archive.read(path))
    for cell in root.findall(".//{" + main + "}c"):
        cell_count += 1
        formula = cell.find("{" + main + "}f")
        if formula is not None:
            formula_cells.append({"sheet": name, "cell": cell.attrib.get("r", "")})
        cell_type = cell.attrib.get("t")
        value = cell.find("{" + main + "}v")
        if cell_type == "s" and value is not None:
            strings.append(shared[int(value.text or "0")])
        elif cell_type == "inlineStr":
            strings.append("".join(node.text or "" for node in cell.findall(".//{" + main + "}t")))
        elif cell_type == "str" and value is not None:
            strings.append(value.text or "")

print(json.dumps({"sheetNames": names, "cellCount": cell_count, "strings": strings, "formulaCells": formula_cells}))
`;

export function assertWorkbookReadableIndependently(
  bytes: Buffer,
  expectedSheetNames: string[],
): { strings: string[]; cellCount: number } {
  const output = execFileSync(
    'python3',
    ['-c', openXmlReader],
    { input: bytes, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  );
  const result = JSON.parse(output) as {
    sheetNames: string[];
    cellCount: number;
    strings: string[];
    formulaCells: Array<{ sheet: string; cell: string }>;
  };
  assert.deepEqual(result.sheetNames, expectedSheetNames);
  assert.ok(result.cellCount > 0, 'the workbook must contain populated OOXML cells');
  assert.deepEqual(result.formulaCells, [], 'exported user text must not be stored as executable formulas');
  return { strings: result.strings, cellCount: result.cellCount };
}
