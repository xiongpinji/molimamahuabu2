from .protocol import HEX_SHA256_RE, SUPPORTED_LOCALE_PACK

MANIFEST_FIELDS = {
    "schema_version",
    "locale_pack",
    "model_manifest_sha256",
    "calibration_manifest_sha256",
}


def validate_manifest(value):
    if not isinstance(value, dict) or set(value) != MANIFEST_FIELDS:
        raise ValueError("LOCALE_MANIFEST_INVALID")
    if type(value["schema_version"]) is not int or value["schema_version"] != 1 or value["locale_pack"] != SUPPORTED_LOCALE_PACK:
        raise ValueError("LOCALE_MANIFEST_INVALID")
    for key in ("model_manifest_sha256", "calibration_manifest_sha256"):
        if not isinstance(value[key], str) or not HEX_SHA256_RE.fullmatch(value[key]):
            raise ValueError("LOCALE_MANIFEST_INVALID")
    return value
