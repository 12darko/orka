---
name: security
description: Security-sensitive work - authentication, authorization, handling user input, secrets, file/shell/database access, crypto, dependencies - and security reviews. Use when code touches trust boundaries or the user asks about vulnerabilities.
---

# Security

## Principles
- Treat everything from outside the process as untrusted: request bodies, headers, query strings, files, environment, third-party API responses, LLM output.
- Validate input at the boundary (type, length, range, format, allow-lists), encode output for its context (HTML, SQL, shell, URL, JSON).
- Least privilege: minimal scopes, permissions, file access and network access.

## Common flaws to prevent
- Injection: parameterized queries only; never build SQL/shell/LDAP strings from input. Spawn processes with argument arrays, not a shell string.
- Path traversal: resolve paths and verify they stay inside the intended directory.
- XSS: rely on the framework's escaping; avoid `innerHTML`/`dangerouslySetInnerHTML` with untrusted data; set a Content-Security-Policy.
- AuthN/AuthZ: check authorization on the server for every request and object (no IDOR); hash passwords with bcrypt/scrypt/Argon2; constant-time comparison for tokens; secure, httpOnly, sameSite cookies.
- Secrets: never hardcode keys or log them; read from environment or a secret store; add patterns to `.gitignore`. If a secret was committed, tell the user to rotate it - deleting it from the file is not enough.
- Crypto: use vetted libraries and modern defaults (AES-GCM, SHA-256+, TLS); never invent schemes; use a CSPRNG for tokens.
- Deserialization and file uploads: restrict types and sizes, never deserialize untrusted data into arbitrary objects.
- SSRF: restrict outbound URLs built from input.
- Dependencies: prefer maintained packages; check advisories (`npm audit`, `pip-audit`, `dotnet list package --vulnerable`) when adding or upgrading.

## When reviewing
- Report each issue with location, exploit scenario, impact and fix, ordered by severity. Don't claim something is exploitable without tracing the data flow.
