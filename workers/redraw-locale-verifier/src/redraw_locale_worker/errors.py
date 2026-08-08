class LocaleWorkerError(ValueError):
    """Base class for stable worker errors."""

    code = "LOCALE_WORKER_ERROR"

    def __init__(self, code=None, message=None):
        self.code = code or self.code
        super().__init__(message or self.code)


class ProtocolError(LocaleWorkerError):
    code = "LOCALE_VERIFY_REQUEST_INVALID"


class AudioInputError(LocaleWorkerError):
    code = "LOCALE_AUDIO_INPUT_INVALID"
