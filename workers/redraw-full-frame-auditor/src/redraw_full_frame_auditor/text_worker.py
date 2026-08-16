import argparse
import contextlib
import io
import json
import pathlib
import sys


if __package__:
    from . import worker
else:
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
    from redraw_full_frame_auditor import worker


SCHEMA_VERSION = "redraw-full-frame-text-subprocess-v1"
MAX_SAFE_INTEGER = 9007199254740991
_HANDSHAKE = {"status": "ok", "schema_version": SCHEMA_VERSION}


class _BoundedDiscard(io.TextIOBase):
    def __init__(self, limit=1024 * 1024):
        self.limit = limit
        self.count = 0

    def writable(self):
        return True

    def write(self, value):
        if not isinstance(value, str):
            value = str(value)
        remaining = max(self.limit - self.count, 0)
        self.count += min(len(value), remaining)
        return len(value)

    def flush(self):
        return None


@contextlib.contextmanager
def _discard_python_output():
    sink = _BoundedDiscard()
    with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
        yield


def _write_json(stdout, value):
    stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    stdout.flush()


def _fail():
    raise worker.ProtocolError(worker.ERROR_CODE)


def _validate_request(value, expected_request_id):
    worker._exact_keys(value, ("request_id", "frame_path"))
    request_id = value["request_id"]
    if not isinstance(request_id, int) or isinstance(request_id, bool):
        _fail()
    if request_id != expected_request_id or request_id < 1 or request_id > MAX_SAFE_INTEGER:
        _fail()
    frame_path = value["frame_path"]
    if not isinstance(frame_path, str) or not frame_path:
        _fail()
    return request_id, frame_path


def _sanitize_texts(texts):
    if not isinstance(texts, list):
        _fail()
    return [worker._text_candidate(item) for item in texts]


def load_detector(model_artifact):
    with _discard_python_output():
        return worker.PaddleTextDetectionAdapter(model_artifact, worker._default_text_detector_factory)


def run_jsonl(stdin=None, stdout=None, stderr=None, detector=None, model_artifact=None):
    stdin = stdin or sys.stdin
    stdout = stdout or sys.stdout
    stderr = stderr or sys.stderr
    try:
        if detector is None:
            detector = load_detector(model_artifact)

        _write_json(stdout, _HANDSHAKE)
        data = stdin.read()
        if data and not data.endswith("\n"):
            _fail()

        expected_request_id = 1
        for line in data.splitlines():
            request = json.loads(line)
            request_id, frame_path = _validate_request(request, expected_request_id)
            with _discard_python_output():
                texts = detector.detect_regions(frame_path)
            _write_json(stdout, {"request_id": request_id, "texts": _sanitize_texts(texts)})
            expected_request_id += 1
        return 0
    except Exception:
        stderr.write(worker.ERROR_CODE + "\n")
        stderr.flush()
        return 1


def parse_args(argv=None):
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--model-artifact")
    args, unknown = parser.parse_known_args(argv)
    if unknown or not args.model_artifact:
        _fail()
    return args


def main(argv=None):
    try:
        args = parse_args(argv)
    except Exception:
        sys.stderr.write(worker.ERROR_CODE + "\n")
        return 1
    return run_jsonl(model_artifact=args.model_artifact)


if __name__ == "__main__":
    raise SystemExit(main())
