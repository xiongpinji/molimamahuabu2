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
        self.count += len(value.encode("utf-8"))
        if self.count > self.limit:
            raise worker._stage_error("output_limit")
        return len(value)

    def flush(self):
        return None


@contextlib.contextmanager
def _discard_python_output():
    stdout_sink = _BoundedDiscard()
    stderr_sink = _BoundedDiscard()
    with contextlib.redirect_stdout(stdout_sink), contextlib.redirect_stderr(stderr_sink):
        yield


def _write_json(stdout, value):
    stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    stdout.flush()


def _fail():
    raise worker.ProtocolError(worker.ERROR_CODE)


def _trusted_text_load_stage(error):
    stage = worker._trusted_stage(error)
    if stage in worker._TEXT_LOAD_STAGES:
        return stage
    return None


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


def load_detector(model_lock):
    try:
        with _discard_python_output():
            _lock, components, runtimes = worker._validate_model_lock(model_lock)
            if not worker._same_file(sys.executable, runtimes["text"]["interpreter_abs_path"]):
                _fail()
    except Exception as exc:
        stage = _trusted_text_load_stage(exc)
        if stage == "output_limit":
            raise exc
        raise worker._stage_error("validate_lock") from None

    try:
        with _discard_python_output():
            return worker.PaddleTextDetectionAdapter(
                components["text_detector"]["artifact_abs_path"],
                worker._default_text_detector_factory,
            )
    except Exception as exc:
        stage = _trusted_text_load_stage(exc)
        if stage is not None:
            raise exc
        raise worker._stage_error("adapter_init") from None


def run_jsonl(stdin=None, stdout=None, stderr=None, detector=None, model_lock=None):
    stdin = stdin or sys.stdin
    stdout = stdout or sys.stdout
    stderr = stderr or sys.stderr
    handshake_succeeded = False
    try:
        if detector is None:
            detector = load_detector(model_lock)

        _write_json(stdout, _HANDSHAKE)
        handshake_succeeded = True
        expected_request_id = 1
        for line in stdin:
            if not line.endswith("\n"):
                _fail()
            request = json.loads(line)
            request_id, frame_path = _validate_request(request, expected_request_id)
            with _discard_python_output():
                texts = detector.detect_regions(frame_path)
            _write_json(stdout, {"request_id": request_id, "texts": _sanitize_texts(texts)})
            expected_request_id += 1
        return 0
    except Exception as exc:
        stage = None if handshake_succeeded else _trusted_text_load_stage(exc)
        if stage is None:
            stderr.write(worker.ERROR_CODE + "\n")
        else:
            stderr.write(f"{worker.ERROR_CODE} stage={stage}\n")
        stderr.flush()
        return 1


def parse_args(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if len(argv) != 3 or argv[0] != "run" or argv[1] != "--model-lock" or not argv[2]:
        _fail()
    return argparse.Namespace(model_lock=argv[2])


def main(argv=None):
    try:
        args = parse_args(argv)
    except Exception:
        sys.stderr.write(worker.ERROR_CODE + "\n")
        return 1
    return run_jsonl(model_lock=args.model_lock)


if __name__ == "__main__":
    raise SystemExit(main())
