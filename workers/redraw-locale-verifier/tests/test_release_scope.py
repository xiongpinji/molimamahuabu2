import ast
import json
from pathlib import Path
import unittest


REPO_ROOT = Path(__file__).resolve().parents[3]
PACKAGE_ROOT = REPO_ROOT / "workers" / "redraw-locale-verifier" / "src" / "redraw_locale_worker"
SCOPE_PATH = REPO_ROOT / "deploy" / "release-scopes" / "redraw-locale-verifier.json"
SOURCE_PREFIX = "workers/redraw-locale-verifier/src/redraw_locale_worker/"


def local_import_closure(entrypoint):
    pending = [PACKAGE_ROOT / "__init__.py", entrypoint]
    closure = set()
    while pending:
        source_path = pending.pop()
        if source_path in closure:
            continue
        closure.add(source_path)
        tree = ast.parse(source_path.read_text(encoding="utf-8"), filename=str(source_path))
        for node in ast.walk(tree):
            if not isinstance(node, ast.ImportFrom) or node.level != 1 or not node.module:
                continue
            dependency = PACKAGE_ROOT / f"{node.module.split('.', 1)[0]}.py"
            if dependency.is_file() and dependency not in closure:
                pending.append(dependency)
    return closure


class ReleaseScopeTests(unittest.TestCase):
    def test_server_release_scope_contains_exact_transitive_local_source_closure(self):
        manifest = json.loads(SCOPE_PATH.read_text(encoding="utf-8"))
        actual = {
            path
            for path in manifest["allowedPaths"]
            if path.startswith(SOURCE_PREFIX)
        }
        expected = {
            source.relative_to(REPO_ROOT).as_posix()
            for source in local_import_closure(PACKAGE_ROOT / "server.py")
        }

        self.assertEqual(actual, expected)


if __name__ == "__main__":
    unittest.main()
