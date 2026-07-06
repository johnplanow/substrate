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

### Story 1.3: Add whisper function (multi-story live corpus)

As a library consumer, I want a `whisper(name)` function that greets quietly.

**Acceptance Criteria:**

1. `whisper(name: str) -> str` exists and returns `greet(name).lower()`.
2. A pytest test covers `whisper("World") == "hello, world!"`.
3. Existing functions and tests remain unchanged and passing.

### Story 1.4: Add greet_many function (multi-story live corpus)

As a library consumer, I want a `greet_many(names)` function that greets a list of people.

**Acceptance Criteria:**

1. `greet_many(names: list[str]) -> list[str]` exists and returns `[greet(n) for n in names]`.
2. A pytest test covers `greet_many(["a", "b"]) == ["Hello, a!", "Hello, b!"]`.
3. Existing functions and tests remain unchanged and passing.
