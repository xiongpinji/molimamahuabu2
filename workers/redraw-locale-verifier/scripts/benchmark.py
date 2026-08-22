#!/usr/bin/env python3
import argparse
import json
import math
import os
import tempfile
from pathlib import Path


class BenchmarkError(ValueError):
    pass


def benchmark(fixture_path):
    payload = json.loads(Path(fixture_path).read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or payload.get("schema_version") != 1 or not isinstance(payload.get("samples"), list):
        raise BenchmarkError("BENCHMARK_FIXTURE_INVALID")
    samples = [_validate_sample(sample) for sample in payload["samples"]]
    latencies = sorted(sample["latency_ms"] for sample in samples)
    failures = {}
    for sample in samples:
        if sample["status"] != "ok":
            code = sample.get("error_code") or "UNKNOWN"
            failures[code] = failures.get(code, 0) + 1
    return {
        "schema_version": 1,
        "sample_count": len(samples),
        "latency_ms": {
            "p50": _percentile_nearest_rank(latencies, 50),
            "p95": _percentile_nearest_rank(latencies, 95),
            "max": max(latencies) if latencies else 0,
        },
        "peak_rss_bytes": max((sample["peak_rss_bytes"] for sample in samples), default=0),
        "cpu_seconds": round(sum(sample["cpu_seconds"] for sample in samples), 6),
        "failure_counts": dict(sorted(failures.items())),
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description="Benchmark synthetic redraw locale verifier fixture.")
    parser.add_argument("--fixture", required=True, help="Synthetic benchmark JSON index.")
    parser.add_argument("--output", required=True, help="Benchmark result JSON path.")
    args = parser.parse_args(argv)
    fixture = _safe_input_path(args.fixture)
    output = _safe_output_path(args.output)
    _atomic_write_json(output, benchmark(fixture))
    return 0


def _validate_sample(sample):
    if not isinstance(sample, dict) or sample.get("status") not in {"ok", "failed"}:
        raise BenchmarkError("BENCHMARK_SAMPLE_INVALID")
    required = ("latency_ms", "peak_rss_bytes", "cpu_seconds")
    for key in required:
        if key not in sample:
            raise BenchmarkError("BENCHMARK_SAMPLE_INVALID")
    result = dict(sample)
    for key in ("latency_ms", "peak_rss_bytes"):
        if type(result[key]) is not int or result[key] < 0:
            raise BenchmarkError("BENCHMARK_SAMPLE_INVALID")
    if type(result["cpu_seconds"]) not in {int, float} or not math.isfinite(result["cpu_seconds"]) or result["cpu_seconds"] < 0:
        raise BenchmarkError("BENCHMARK_SAMPLE_INVALID")
    return result


def _percentile_nearest_rank(sorted_values, percentile):
    if not sorted_values:
        return 0
    index = max(1, int((percentile / 100) * len(sorted_values) + 0.999999)) - 1
    return sorted_values[min(index, len(sorted_values) - 1)]


def _safe_input_path(value):
    path = Path(value).resolve(strict=True)
    if not path.is_file():
        raise BenchmarkError("BENCHMARK_FIXTURE_INVALID")
    return path


def _safe_output_path(value):
    path = Path(value)
    if path.exists() and path.is_dir():
        raise BenchmarkError("BENCHMARK_OUTPUT_INVALID")
    parent = path.parent if path.parent != Path("") else Path(".")
    parent.resolve(strict=True)
    return path


def _atomic_write_json(path, value):
    path = Path(path)
    parent = path.parent if path.parent != Path("") else Path(".")
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=parent, delete=False) as handle:
        tmp_name = handle.name
        json.dump(value, handle, ensure_ascii=True, sort_keys=True, indent=2, allow_nan=False)
        handle.write("\n")
    os.replace(tmp_name, path)


if __name__ == "__main__":
    raise SystemExit(main())
