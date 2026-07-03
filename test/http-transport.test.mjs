import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

// Regression test for the HTTP transport's stateless fallback. `initialize`
// always issues a real Mcp-Session-Id (see the session-issuance test below,
// added for issue #1), but any request that omits the session header —
// notably every request from Claude Code, which never echoes it back — must
// still be served via a throwaway stateless McpServer rather than the SDK's
// stateful "400 Mcp-Session-Id header is required" rejection (the bug fixed
// in 1.6.5, reverting 1.6.3's fully-stateful design).
test("HTTP transport serves clients that omit the session header (stateless)", async () => {
  const port = String(33000 + Math.floor(Math.random() * 1000));
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      MCP_TRANSPORT: "http",
      HOST: "127.0.0.1",
      PORT: port,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  try {
    await waitForHealth(port);

    // initialize WITHOUT any session id (a stateless client)
    const initializeResponse = await postMcp(port, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "mcp-arr-test", version: "0.0.0" },
      },
    });
    assert.equal(initializeResponse.status, 200);

    // tools/list WITHOUT the Mcp-Session-Id header — the exact request the old
    // stateful transport rejected with 400. Must now succeed.
    const toolsResponse = await postMcp(port, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    assert.equal(
      toolsResponse.status,
      200,
      "a post-initialize request without a session header must succeed in stateless mode",
    );
    const body = await toolsResponse.text();
    assert.match(body, /"tools"/);
    assert.doesNotMatch(body, /Mcp-Session-Id header is required/);
    assert.doesNotMatch(body, /Stateless transport cannot be reused/);

    // a second independent request must also succeed (the shared server is
    // reconnected to a fresh transport per request)
    const secondResponse = await postMcp(port, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
      params: {},
    });
    assert.equal(secondResponse.status, 200);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit").catch(() => {});
  }

  assert.doesNotMatch(stderr, /Fatal error/);
});

// Regression test for issue #1: the old design (a single shared low-level
// `Server` behind a `runSerialized` mutex, `sessionIdGenerator: undefined`)
// never issued a session id, so session-aware clients (e.g. the Python `mcp`
// package under 2025-11-25 semantics) had no way to detect a dropped
// connection after a server restart or reconnect cleanly — every tool call
// silently returned empty results. The fix issues a real `Mcp-Session-Id` on
// `initialize` and routes subsequent same-session requests to a dedicated
// per-session McpServer.
test("HTTP transport issues a real session id and routes same-session requests to it", async () => {
  const port = String(33000 + Math.floor(Math.random() * 1000));
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      MCP_TRANSPORT: "http",
      HOST: "127.0.0.1",
      PORT: port,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });

  try {
    await waitForHealth(port);

    // initialize WITHOUT a session id — the transport must issue a real one.
    const initializeResponse = await postMcp(port, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "mcp-arr-session-test", version: "0.0.0" },
      },
    });
    assert.equal(initializeResponse.status, 200);
    const sessionId = initializeResponse.headers.get("mcp-session-id");
    assert.ok(sessionId, "initialize must return a real Mcp-Session-Id header");

    // tools/list WITH the issued session id must succeed, routed to the
    // same session's McpServer.
    const toolsResponse = await postMcp(
      port,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      sessionId,
    );
    assert.equal(toolsResponse.status, 200);
    const body = await toolsResponse.text();
    assert.match(body, /"tools"/);

    // The health endpoint should reflect one active session.
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    const healthBody = await health.json();
    assert.equal(healthBody.activeSessions, 1);

    // A second, independent client (no session id at all — e.g. Claude Code)
    // must still work via the stateless fallback and must NOT be attached to
    // the first client's session.
    const secondClientInit = await postMcp(port, {
      jsonrpc: "2.0",
      id: 3,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "mcp-arr-second-client", version: "0.0.0" },
      },
    });
    assert.equal(secondClientInit.status, 200);
    const secondSessionId = secondClientInit.headers.get("mcp-session-id");
    assert.ok(secondSessionId, "a second, independent client must get its own session id");
    assert.notEqual(secondSessionId, sessionId, "sessions must not be shared across independent clients");
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit").catch(() => {});
  }
});

async function waitForHealth(port) {
  const deadline = Date.now() + 5000;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        return;
      }
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`HTTP server did not become healthy: ${lastError}`);
}

function postMcp(port, payload, sessionId) {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    },
    body: JSON.stringify(payload),
  });
}
