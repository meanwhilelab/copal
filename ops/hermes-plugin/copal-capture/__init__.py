"""copal-capture — Hermes plugin.

On session finalize, loads the session transcript from Hermes's SQLite store
and POSTs it to Copal's REST mirror (upsert by client_session_id). This is the
STRUCTURAL half of capture: facts were already written live via MCP tool calls
during the conversation; this safety-net preserves the raw transcript even when
the model forgot to call save_session.

Never blocks or raises into Hermes — all failures are logged and swallowed.

Install: copy this directory into the hermes-data volume at
/opt/data/plugins/copal-capture/ and create a `token` file (chmod 600) beside
this file containing Copal's hermes bearer token. Restart the container.
"""

import json
import logging
import urllib.request
from pathlib import Path

logger = logging.getLogger("copal-capture")

COPAL_URL = "https://your-copal-host/api/v1/sessions"
TOKEN_FILE = Path(__file__).parent / "token"
TIMEOUT_S = 15


def _token() -> str | None:
    try:
        return TOKEN_FILE.read_text().strip() or None
    except OSError:
        logger.warning("copal-capture: token file missing at %s", TOKEN_FILE)
        return None


def _render(messages: list[dict]) -> str:
    lines: list[str] = []
    for msg in messages:
        role = msg.get("role") or "unknown"
        content = msg.get("content")
        if isinstance(content, list):  # block-structured content
            content = " ".join(
                str(b.get("text", "")) for b in content if isinstance(b, dict)
            )
        if content is None:
            continue
        text = str(content).strip()
        if text:
            lines.append(f"{role}: {text}")
    return "\n".join(lines)


def _post(payload: dict, token: str) -> None:
    req = urllib.request.Request(
        COPAL_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
        logger.info("copal-capture: session posted (%s)", resp.status)


def _finalize(**kwargs) -> None:
    session_id = kwargs.get("session_id")
    if not session_id:
        return
    token = _token()
    if not token:
        return
    try:
        from hermes_state import SessionDB

        messages = SessionDB(read_only=True).get_messages(session_id)
        transcript = _render(messages)
        if not transcript.strip():
            logger.info("copal-capture: session %s empty, skipped", session_id)
            return
        _post(
            {
                "client_session_id": str(session_id),
                "transcript": transcript,
                "type": "chat",
            },
            token,
        )
    except Exception:  # noqa: BLE001 — must never break Hermes's lifecycle
        logger.exception("copal-capture: failed for session %s", session_id)


def register(ctx) -> None:
    ctx.register_hook("on_session_finalize", _finalize)
    logger.info("copal-capture: registered on_session_finalize")
