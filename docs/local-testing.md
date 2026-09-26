# Running Generated Tests Locally

The in-browser test runner executes JavaScript tests only. Python and Java tests are generated as native templates because running those languages safely in the browser is not supported. Replace each `TODO` with the real input, expected result, and project-specific class or module details before relying on the test.

## Python

The generated test uses Python's standard-library `unittest`; no test package is required. Save the code under test as `solution.py` beside the generated `test_<function>.py` file, check that the import matches the function name, and adjust the test calls for the function's actual arguments.

For a function named `calculate`, run it with Python 3:

```bash
python -m unittest test_calculate.py
```

On systems where Python 3 is invoked as `python3`, use `python3 -m unittest test_calculate.py`.

## Java

The generated test uses JUnit 5. Replace `YourClass` with the class under test, adapt the method calls for the real constructor, arguments, and static/instance method, add the matching `package` declaration if needed, then put the file in `src/test/java` in a Maven project. Add JUnit Jupiter to the project's test dependencies if it is not already present. For example, add this under `<dependencies>` in `pom.xml`:

```xml
<dependency>
	<groupId>org.junit.jupiter</groupId>
	<artifactId>junit-jupiter</artifactId>
	<version>5.11.4</version>
	<scope>test</scope>
</dependency>
```

For Maven, use a recent Surefire plugin version that supports JUnit 5; see the [JUnit 5 user guide](https://junit.org/junit5/docs/current/user-guide/) for current configuration guidance.

Run the tests from the Maven project root:

```bash
mvn test
```

## JavaScript and TypeScript

Install Vitest in the project if needed, save the generated test beside the module it imports, and adjust the import to match your file layout. Run it with:

```bash
npx vitest run
```