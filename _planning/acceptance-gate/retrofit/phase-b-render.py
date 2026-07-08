"""Phase B in-clone render driver (A3.2) — run INSIDE an income-sources clone
at a pinned SHA via `uv run python phase-b-render.py <scenario> <out-dir>`.

Scenarios:
  packet          seed one schema-valid dossier pair, compose weekly Packet (stub mail),
                  write the rendered email artifacts
  absence         same seed + an absences row covering today, compose, write a
                  compose-observation artifact + any produced email
  return-summary  seed an ENDED absence + undispatched auto_release_log rows + dossier
                  pair, compose, write the rendered email artifacts

Uses the repo's own modules (machine.*) — the REAL compose path, stub mailer only.
Never touches the repo's real ledger: LEDGER_PATH is set by this script to a temp file.
"""

import json
import os
import sqlite3
import sys
import tempfile
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

SCENARIO = sys.argv[1]
OUT = Path(sys.argv[2])
OUT.mkdir(parents=True, exist_ok=True)

scratch = tempfile.mkdtemp(prefix="phaseb-ledger-")
os.environ["LEDGER_PATH"] = os.path.join(scratch, "scratch.db")

from machine.ledger import db as ledger_db  # noqa: E402

conn = ledger_db.connect(os.environ["LEDGER_PATH"])
ledger_db.run_migrations(conn)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def table_columns(name: str) -> set:
    return {r[1] for r in conn.execute(f"PRAGMA table_info({name})").fetchall()}


def insert_row(table: str, values: dict) -> None:
    cols = table_columns(table)
    filtered = {k: v for k, v in values.items() if k in cols}
    placeholders = ", ".join(["?"] * len(filtered))
    conn.execute(
        f"INSERT INTO {table} ({', '.join(filtered.keys())}) VALUES ({placeholders})",
        list(filtered.values()),
    )
    conn.commit()


def seed_dossier(idx: int = 1) -> None:
    """One schema-valid signals+dossiers pair modeled on the PRD UJ-2 example.

    Superset of columns across the pinned SHAs; insert_row filters to the
    schema actually present at this commit. JSON blobs are fully formed so
    parse_dossier_row accepts them (a rejected dossier is silently dropped).
    """
    sig_id = f"01PHASEBSIG{idx:04d}XXXXXXXXXXXXX"[:26]
    dos_id = f"01PHASEBDOS{idx:04d}XXXXXXXXXXXXX"[:26]
    insert_row(
        "signals",
        {
            "id": sig_id,
            "state": "queued",
            "source": "phase-b",
            "url": "https://example.gov/licensing-rule",
            "title": "State licensing rule effective in 90 days",
            "created_at": now_iso(),
            "updated_at": now_iso(),
            "parsed_data": json.dumps({"summary": "Licensing rule strands ~4,000 small operators without a compliance workflow."}),
        },
    )
    insert_row(
        "dossiers",
        {
            "id": dos_id,
            "signal_id": sig_id,
            "state": "queued",
            "thesis": "A state licensing rule effective in 90 days strands ~4,000 small operators without a compliance workflow; a focused SaaS checklist product captures the scramble.",
            "unfair_advantage": "Operator can ship a compliance workflow in six weekend chunks before incumbents notice.",
            "pre_mortem": "Rule delayed by litigation; incumbents bundle compliance for free; operators ignore the deadline.",
            "act_by": (date.today() + timedelta(days=21)).isoformat(),
            "default_action": "defer",
            "fit_score": 0.82,
            "conservative_pl": json.dumps({"value": 60000.0, "comparables": ["permit-tracker SaaS at $48k/yr (https://example.com/comp1)"]}),
            "upside_ceiling": json.dumps({"ceiling_value": 400000.0, "trigger_conditions": ["enforcement begins on schedule", "no incumbent bundles compliance"]}),
            "effort_audit": json.dumps({"sources": ["https://example.gov/licensing-rule"], "provenance": "regulatory register scrape 2026-07-01", "numeric_source_flag": True, "downgrade_flags": []}),
            "builder_crowding": json.dumps({"assessment": "low", "competitors": ["permit-tracker"]}),
            "kill_criteria": json.dumps({"criteria": ["rule delayed past Q4"], "reversal_watch": ["litigation docket 26-889"]}),
            "signal_history": json.dumps([{"signal_id": sig_id, "event_type": "scored", "occurred_at": now_iso(), "summary": "scored 0.82 on ingest"}]),
            "created_at": now_iso(),
            "updated_at": now_iso(),
        },
    )


def seed_absence(start: date, end: date) -> str:
    ab_id = "01PHASEBABSXXXXXXXXXXXXXXX"[:26]
    insert_row(
        "absences",
        {"id": ab_id, "start_date": start.isoformat(), "end_date": end.isoformat(), "note": "Portugal", "created_at": now_iso(), "updated_at": now_iso()},
    )
    return ab_id


def compose_and_capture(label: str) -> int:
    from machine.mailer import stub
    from machine.packet.compose import compose_packet

    config = None
    try:
        from machine.config.loader import load_config

        config = load_config()
    except Exception:
        config = None

    before = len(getattr(stub, "sent", []))
    try:
        import inspect

        sig = inspect.signature(compose_packet)
        kwargs = {}
        if "config" in sig.parameters:
            kwargs["config"] = config
        compose_packet(conn, stub, **kwargs)
    except TypeError:
        compose_packet(conn, stub, config)  # older positional shape
    sent = getattr(stub, "sent", [])[before:]
    for i, msg in enumerate(sent):
        (OUT / f"{label}-{i}-subject.txt").write_text(getattr(msg, "subject", "") or "")
        (OUT / f"{label}-{i}.html").write_text(getattr(msg, "html", "") or "")
        (OUT / f"{label}-{i}.txt").write_text(getattr(msg, "text", "") or "")
    # Schema-aware packets observation (columns drift across the pinned SHAs).
    pcols = sorted(table_columns("packets"))
    rows = conn.execute(f"SELECT {', '.join(pcols)} FROM packets ORDER BY rowid DESC LIMIT 1").fetchall()
    (OUT / f"{label}-observation.txt").write_text(
        f"scenario: {label}\ncompose_date_utc: {date.today().isoformat()}\n"
        f"emails_produced: {len(sent)}\n"
        f"latest_packets_row_columns: {pcols}\n"
        f"latest_packets_row: {rows[0] if rows else '(none)'}\n"
    )
    return len(sent)


def probe_dossier_validation() -> None:
    """Fail fast (loudly) if the seeded dossier won't survive parse_dossier_row —
    compose silently DROPS invalid dossiers, which would render an empty Packet
    and poison the judge run with a false artifact."""
    try:
        from machine.packet.schemas import parse_dossier_row
    except Exception as err:  # noqa: BLE001
        print(f"validation-probe: no parse_dossier_row at this SHA ({err}) — proceeding")
        return
    row = conn.execute("SELECT * FROM dossiers ORDER BY rowid DESC LIMIT 1").fetchone()
    cols = [d[0] for d in conn.execute("SELECT * FROM dossiers LIMIT 1").description]
    mapping = dict(zip(cols, row))
    try:
        parse_dossier_row(mapping)
        print("validation-probe: seeded dossier VALID")
    except Exception as err:  # noqa: BLE001
        print(f"validation-probe: seeded dossier INVALID — {err}", file=sys.stderr)
        sys.exit(3)


if SCENARIO == "packet":
    seed_dossier()
    probe_dossier_validation()
    n = compose_and_capture("packet-weekly")
    print(f"packet: {n} email(s) captured")
elif SCENARIO == "absence":
    seed_dossier()
    seed_absence(date.today() - timedelta(days=3), date.today() + timedelta(days=10))
    n = compose_and_capture("absence-compose")
    print(f"absence: {n} email(s) captured (0 = suppressed)")
elif SCENARIO == "return-summary":
    seed_dossier()
    ab_id = seed_absence(date.today() - timedelta(days=14), date.today() - timedelta(days=1))
    # auto_release_log is created lazily by machine.flags.auto_release (not a
    # migration). Ensure it exists at SHAs that have the module; at older SHAs
    # (nothing reads the log into compose anyway) skip the seed — the pre-fix
    # evidence is simply a Packet WITHOUT a return section.
    seeded_log = False
    try:
        from machine.flags import auto_release as _ar

        _ar._ensure_log_table(conn)  # noqa: SLF001
        insert_row(
            "auto_release_log",
            {
                "id": "01PHASEBRELXXXXXXXXXXXXXXX"[:26],
                "signal_id": "01PHASEBSIG0001XXXXXXXXXXXXX"[:26],
                "absence_id": ab_id,
                "release_type": "pre-claim-hold",
                "release_reason": "act-by could not survive the declared absence",
                "act_by": (date.today() - timedelta(days=5)).isoformat(),
                "released_at": now_iso(),
                "dispatched": 0,
            },
        )
        seeded_log = True
    except Exception as err:  # noqa: BLE001
        print(f"return-summary: auto_release_log seed skipped ({err})")
    n = compose_and_capture("return-packet")
    print(f"return-summary: {n} email(s) captured (log seeded: {seeded_log})")
else:
    print(f"unknown scenario {SCENARIO}", file=sys.stderr)
    sys.exit(2)
