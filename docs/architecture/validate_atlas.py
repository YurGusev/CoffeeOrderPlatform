#!/usr/bin/env python3
"""Проверка переносимого атласа без dependencies и подключений к сервисам."""
import hashlib
import json
from pathlib import Path
import re
import sys
from urllib.parse import unquote, urlsplit


def validate(directory):
    repo = directory.parents[1]
    manifest = json.loads((directory / "source-manifest.json").read_text())
    errors = []
    sources = {row["path"]: row for row in manifest["sources"]}
    if len(sources) != len(manifest["sources"]):
        errors.append("Дубликаты source paths")
    for rel, row in sources.items():
        path = Path(rel)
        if path.is_absolute() or ".." in path.parts or "secrets" in path.parts or path.name == ".env":
            errors.append(f"Запрещённый source path: {rel}")
            continue
        source = repo / path
        if not source.is_file():
            errors.append(f"Нет источника: {rel}")
            continue
        data = source.read_bytes()
        if hashlib.sha256(data).hexdigest() != row["sha256"]:
            errors.append(f"Source drift: {rel}")
        if len(data.splitlines()) != row["lines"]:
            errors.append(f"Изменилось число строк: {rel}")

    links = spans = diagrams = 0
    notes = sorted(directory.glob("*.md"))
    source_pattern = re.compile(
        r"(?P<path>(?:apps|packages|docs|config|contracts|scripts|tools|platform|verification|evidence)/"
        r"[^\s`<>|,;()\[\]【】]+?|AGENTS\.md|package\.json|compose\.yaml|Dockerfile)"
        r":L?(?P<start>\d+)(?:[-–]L?(?P<end>\d+))?"
    )
    for note in notes:
        text = note.read_text()
        for marker in ("[[", "file://", "/home/", "HERMES-CONTEXT-COMPRESSION", "[SKILL_PRUNED]", "AGE-SECRET-KEY-", "PRIVATE KEY-----"):
            if marker in text:
                errors.append(f"Непереносимый или запрещённый маркер {marker}: {note.name}")
        if not text.startswith("---\n") or "\n---\n" not in text[4:]:
            errors.append(f"Нет frontmatter: {note.name}")
        else:
            properties = text.split("---", 2)[1]
            for key in ("type", "project", "status", "source", "verified"):
                if not re.search(rf"^{key}:\s*\S", properties, re.M):
                    errors.append(f"Нет свойства {key}: {note.name}")
        if len(re.findall(r"^```.*$", text, re.M)) % 2:
            errors.append(f"Непарный code fence: {note.name}")
        diagrams += len(re.findall(r"^```mermaid\s*$", text, re.M))
        for link in re.finditer(r"\[[^\]\n]*\]\(([^\s)]+)\)", text):
            url = urlsplit(link[1])
            if url.scheme or not url.path:
                continue
            links += 1
            target = (note.parent / unquote(url.path)).resolve()
            if not target.is_relative_to(repo.resolve()) or not target.exists():
                errors.append(f"Нет локальной ссылки: {note.name}: {link[1]}")
            elif target.is_file() and re.fullmatch(r"L\d+(?:-L?\d+)?", url.fragment):
                numbers = [int(n) for n in re.findall(r"\d+", url.fragment)]
                if not 1 <= numbers[0] <= numbers[-1] <= len(target.read_bytes().splitlines()):
                    errors.append(f"Неверный line anchor: {note.name}: {link[1]}")
        for span in source_pattern.finditer(text):
            spans += 1
            rel = span["path"]
            start = int(span["start"])
            end = int(span["end"] or span["start"])
            if rel not in sources or not 1 <= start <= end <= sources[rel]["lines"]:
                errors.append(f"Неверный source span: {note.name}: {span[0]}")

    for path in directory.glob("*.json"):
        data = path.read_text()
        json.loads(data)
        if "/home/" in data or "file://" in data:
            errors.append(f"Локальный путь в JSON: {path.name}")
    schema = json.loads((directory / "schema-inventory.json").read_text())
    tables, fk_count, index_count, migrations = [], 0, 0, []
    for path in sorted((repo / "apps").glob("*/migrations/*.sql")):
        migrations.append(path)
        sql = path.read_text()
        tables.extend(re.findall(r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w.]+)", sql, re.I))
        fk_count += len(re.findall(r"\bREFERENCES\s+[\w.]+", sql, re.I))
        index_count += len(re.findall(r"CREATE\s+(?:UNIQUE\s+)?INDEX\s+", sql, re.I))
    expected = schema["summary"]
    if set(tables) != {row["qualified_name"] for row in schema["actual_tables"]}:
        errors.append("DDL таблицы не совпадают с inventory")
    for actual, key in ((len(migrations), "migration_files_present"), (len(tables), "actual_ddl_tables_in_sql"), (fk_count, "actual_fk_count"), (index_count, "named_secondary_index_count")):
        if actual != expected[key]:
            errors.append(f"SQL inventory drift: {key}")
    return {
        "status": "PASS" if not errors else "FAIL",
        "scope": "Статическая проверка источников, ссылок, структуры и SQL inventory; не runtime или Mermaid acceptance",
        "notes": len(notes), "sources": len(sources), "links": links,
        "source_spans": spans, "mermaid_blocks": diagrams,
        "migrations": len(migrations), "tables": len(tables), "foreign_keys": fk_count,
        "named_secondary_indexes": index_count, "errors": errors,
    }


if __name__ == "__main__":
    result = validate(Path(__file__).resolve().parent)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    sys.exit(0 if result["status"] == "PASS" else 1)
