---
name: proofwright
description: Test a web app with Proofwright, step by step — a plan, test cases the tester approves, Playwright tests, a review, and proof that the tests can fail. Use when the tester asks to test or check something with Proofwright, or asks where they are or what's next.
---
# Proofwright

Use the `guide` tool of the proofwright MCP server.

- The tester wants something tested: call `guide` with request set to their exact words, then follow the session steps it returns. The steps are for you; don't show them to the tester.
- The tester asks where they are, or what's next: call `guide` without a request, and show them its answer as it is.
