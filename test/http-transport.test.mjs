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
  const port = String(33000 + Math.floor(Math.random() * 500));
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
    assert.match(await initializeResponse.text(), /"serverInfo"/);

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
  const port = String(33500 + Math.floor(Math.random() * 500));
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
    // The initialize RESULT must arrive, not just the headers. Before the
    // server.connect fix the headers came back and the body never did.
    const initializeBody = await initializeResponse.text();
    assert.match(initializeBody, /"serverInfo"/);
    assert.match(initializeBody, /"name":"mcp-arr"/);

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
    assert.match(await secondClientInit.text(), /"serverInfo"/);
    const secondSessionId = secondClientInit.headers.get("mcp-session-id");
    assert.ok(secondSessionId, "a second, independent client must get its own session id");
    assert.notEqual(secondSessionId, sessionId, "sessions must not be shared across independent clients");

    // GET/DELETE with an unknown session id must be answered promptly with a
    // client error, and the throwaway transport built to answer it must not
    // leak into the session map (the activeSessions check below).
    for (const method of ["GET", "DELETE"]) {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method,
        headers: {
          Accept: "application/json, text/event-stream",
          "Mcp-Session-Id": "00000000-0000-0000-0000-000000000000",
        },
        signal: AbortSignal.timeout(RESPONSE_DEADLINE_MS),
      });
      assert.ok(res.status >= 400 && res.status < 500, `${method} unknown session: ${res.status}`);
      await res.text();
    }
    // Those throwaway sessions are never registered.
    const afterHealth = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(afterHealth.activeSessions, 2);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit").catch(() => {});
  }
});

// MCP_ARR_TOOLS restricts tools/list AND tools/call, on both the stateless and
// the per-session path (eejd/mcp-arr#8).
test("MCP_ARR_TOOLS limits tools/list and rejects hidden tools on tools/call", async () => {
  const port = String(34000 + Math.floor(Math.random() * 500));
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      MCP_TRANSPORT: "http",
      HOST: "127.0.0.1",
      PORT: port,
      RADARR_URL: "http://127.0.0.1:1",
      RADARR_API_KEY: "test-key",
      MCP_ARR_TOOLS: "arr_status, radarr_get_movies",
      ARR_WRITE_GUARD: "off",
      ARR_TOOL_MODE: "flat",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });

  try {
    await waitForHealth(port);

    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(health.toolAllowlist, true);
    assert.equal(health.toolCount, 2);

    const addCall = {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "radarr_add_movie", arguments: {} },
    };
    const toolsList = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };

    // stateless (no session id)
    assert.deepEqual(Object.keys(await listTools(port)).sort(), ["arr_status", "radarr_get_movies"]);

    const callBody = await (await postMcp(port, addCall)).text();
    assert.match(callBody, /not found|Unknown tool/i);
    assert.match(callBody, /radarr_add_movie/);
    for (const hidden of ["search", "fetch", "arr_search_all"]) {
      const body = await (await postMcp(port, {
        jsonrpc: "2.0", id: 10, method: "tools/call",
        params: { name: hidden, arguments: { term: "x", id: "x" } },
      })).text();
      assert.match(body, /not found|Unknown tool/i, `${hidden} must be rejected`);
    }
    // positive control: an allowed tool still dispatches
    const okBody = await (await postMcp(port, {
      jsonrpc: "2.0", id: 11, method: "tools/call",
      params: { name: "arr_status", arguments: {} },
    })).text();
    assert.doesNotMatch(okBody, /not found|Unknown tool/i);
    assert.match(okBody, /"result"/);

    // per-session
    const init = await postMcp(port, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "mcp-arr-allowlist-test", version: "0.0.0" },
      },
    });
    const sessionId = init.headers.get("mcp-session-id");
    assert.ok(sessionId);
    await init.text();
    assert.deepEqual(Object.keys(await listTools(port, sessionId)).sort(), ["arr_status", "radarr_get_movies"]);
    const sessCall = await (await postMcp(port, addCall, sessionId)).text();
    assert.match(sessCall, /not found|Unknown tool/i);
    const sessOk = await (await postMcp(port, {
      jsonrpc: "2.0", id: 12, method: "tools/call",
      params: { name: "arr_status", arguments: {} },
    }, sessionId)).text();
    assert.doesNotMatch(sessOk, /not found|Unknown tool/i);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit").catch(() => {});
  }
});

async function expectStartupFailure(env, pattern) {
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      MCP_TRANSPORT: "http",
      HOST: "127.0.0.1",
      PORT: String(34500 + Math.floor(Math.random() * 500)),
      ARR_WRITE_GUARD: "off",
      ...env,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => { stderr += c; });
  const timer = setTimeout(() => child.kill("SIGKILL"), RESPONSE_DEADLINE_MS);
  const [code, signal] = await once(child, "exit");
  clearTimeout(timer);
  assert.equal(signal, null, "server kept running instead of failing startup");
  assert.notEqual(code, 0);
  assert.match(stderr, pattern);
}

test("MCP_ARR_TOOLS naming an unknown tool fails startup", async () => {
  await expectStartupFailure(
    { MCP_ARR_TOOLS: "arr_status,not_a_tool" },
    /unknown tool\(s\): not_a_tool/,
  );
});

test("MCP_ARR_TOOLS set but blank fails startup (never fails open)", async () => {
  await expectStartupFailure({ MCP_ARR_TOOLS: " , " }, /names no tools/);
});

test("MCP_ARR_TOOLS is rejected with ARR_TOOL_MODE=progressive", async () => {
  await expectStartupFailure(
    { MCP_ARR_TOOLS: "arr_status", ARR_TOOL_MODE: "progressive" },
    /not supported with ARR_TOOL_MODE=progressive/,
  );
});

// eejd/mcp-arr#11: HTTP tools/list must advertise each tool's real inputSchema (a model needs the
// parameter names) and a readOnlyHint annotation derived from isWrite (clients that gate on the
// annotation fail closed for an unannotated tool).
async function listTools(port, sessionId) {
  const res = await postMcp(port, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, sessionId);
  const text = await res.text();
  const data = text.split("\n").find((l) => l.startsWith("data:"));
  const msg = JSON.parse(data ? data.slice(5) : text);
  return Object.fromEntries(msg.result.tools.map((t) => [t.name, t]));
}

test("tools/list carries inputSchema and readOnlyHint (real server, both HTTP paths)", async () => {
  const port = String(35500 + Math.floor(Math.random() * 400));
  const env = { ...process.env, MCP_TRANSPORT: "http", HOST: "127.0.0.1", PORT: port,
    RADARR_URL: "http://127.0.0.1:1", RADARR_API_KEY: "test-key" };
  delete env.MCP_ARR_TOOLS;
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: new URL("..", import.meta.url), env, stdio: ["ignore", "ignore", "pipe"] });
  try {
    await waitForHealth(port);
    const init = await postMcp(port, { jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "schema-test", version: "0.0.0" } } });
    const sessionId = init.headers.get("mcp-session-id");
    await init.text();
    for (const tools of [await listTools(port), await listTools(port, sessionId)]) {
      const get = tools["radarr_get_movies"];
      assert.deepEqual(Object.keys(get.inputSchema.properties).sort(), ["limit", "offset", "search"]);
      assert.deepEqual(tools["radarr_search"].inputSchema.required, ["term"]);
      assert.equal(get.annotations.readOnlyHint, true);
      assert.equal(tools["radarr_search"].annotations.readOnlyHint, true);   // lookup, not a write
      assert.equal(tools["radarr_add_movie"].annotations.readOnlyHint, false);
      assert.equal(tools["radarr_delete_queue_item"].annotations.readOnlyHint, false);
      for (const t of Object.values(tools)) {
        assert.equal(t.inputSchema.type, "object", t.name);
        assert.equal(typeof t.annotations.readOnlyHint, "boolean", t.name);
      }
    }
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

const RESPONSE_DEADLINE_MS = 5000;

function postMcp(port, payload, sessionId) {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    // Covers headers AND body: a response that sends headers but never a
    // result (the missing server.connect bug) aborts instead of hanging.
    signal: AbortSignal.timeout(RESPONSE_DEADLINE_MS),
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    },
    body: JSON.stringify(payload),
  });
}
