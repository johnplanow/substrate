# Greeter — Epics (hardening-program fixture corpus)

## Epic 1: Core greeting API

### Story 1.1: Add farewell function

As a library consumer, I want a `farewell(name)` function so that I can say goodbye politely.

**Acceptance Criteria:**

1. `farewell(name: str) -> str` exists in `src/greeter/__init__.py` and returns `f"Goodbye, {name}!"`.
2. A pytest test in `tests/test_farewell.py` covers `farewell("world") == "Goodbye, world!"`.
3. The existing `greet` function and its test remain unchanged and passing.

### Story 1.2: Add shout function (verification-trip fixture)

As a library consumer, I want a `shout(name)` function that greets loudly.

**Acceptance Criteria:**

1. `shout(name: str) -> str` exists and returns `greet(name).upper()`.
2. A pytest test covers `shout("world") == "HELLO, WORLD!"`.
3. NOTE (harness contract, not an AC for the agent): stub-agent scenarios drive this story into verification failures — contamination, no-implementation, red-suite — to prove the gates fire.
