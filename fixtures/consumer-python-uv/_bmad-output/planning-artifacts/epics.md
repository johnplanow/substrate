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

### Story 1.5: Add exclaim function

As a library consumer, I want an `exclaim(name)` function for enthusiastic greetings.

**Acceptance Criteria:**

1. `exclaim(name: str) -> str` exists and returns `greet(name) + "!!"`.
2. A pytest test covers `exclaim("world") == "Hello, world!!!"`.
3. Existing functions and tests remain unchanged and passing.

### Story 1.6: Add initials function

As a library consumer, I want an `initials(full_name)` helper that extracts initials.

**Acceptance Criteria:**

1. `initials(full_name: str) -> str` exists and returns the first letter of each whitespace-separated word, uppercased, joined with no separator (e.g. `"Ada Lovelace"` → `"AL"`).
2. Pytest tests cover a two-word name and a single-word name.
3. Existing functions and tests remain unchanged and passing.

### Story 1.7: Add is_greeting predicate

As a library consumer, I want an `is_greeting(text)` predicate to recognize greetings this library produced.

**Acceptance Criteria:**

1. `is_greeting(text: str) -> bool` exists and returns True iff `text` starts with `"Hello, "` and ends with `"!"`.
2. Pytest tests cover one True case (`greet("x")`) and one False case (`"Goodbye, x!"`).
3. Existing functions and tests remain unchanged and passing.

### Story 1.8: Add greeting_length function

As a library consumer, I want `greeting_length(name)` so I can size UI fields.

**Acceptance Criteria:**

1. `greeting_length(name: str) -> int` exists and returns `len(greet(name))`.
2. A pytest test covers `greeting_length("ab") == len("Hello, ab!")`.
3. Existing functions and tests remain unchanged and passing.

### Story 1.9: Add reverse_greet function

As a library consumer, I want a playful `reverse_greet(name)` variant.

**Acceptance Criteria:**

1. `reverse_greet(name: str) -> str` exists and returns `greet(name)[::-1]`.
2. A pytest test covers `reverse_greet("ab") == "Hello, ab!"[::-1]`.
3. Existing functions and tests remain unchanged and passing.

### Story 1.10: Add greet_default function

As a library consumer, I want `greet_default()` for anonymous users.

**Acceptance Criteria:**

1. `greet_default() -> str` exists and returns `greet("friend")`.
2. A pytest test covers `greet_default() == "Hello, friend!"`.
3. Existing functions and tests remain unchanged and passing.
