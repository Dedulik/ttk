class ApiError(Exception):
    """Ошибка API: превращается в JSON {"detail": "..."} с нужным кодом."""

    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail
