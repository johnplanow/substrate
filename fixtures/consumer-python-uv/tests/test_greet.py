from greeter import greet


def test_greet():
    assert greet("world") == "Hello, world!"
