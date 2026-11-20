// Stdio-only MCP relay. The host broker accepts only bounded task-container commands.
import { createInterface } from "node:readline";
const input = createInterface({ input: process.stdin });
const endpoint = process.env.TACK_EVAL_BRIDGE;
const token = process.env.TACK_EVAL_TOKEN;
for await (const line of input) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    continue;
  }
  if (request.id === undefined) continue;
  let response;
  try {
    if (request.method === "initialize")
      response = {
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "tack-eval-task", version: "1" },
      };
    else if (request.method === "tools/list")
      response = {
        tools: [
          {
            name: "exec",
            description:
              "Run argv in the isolated, networkless Tack task container. All task files are under /world. Use bash -c for shell operations. Never use this tool for the agent control container.",
            inputSchema: {
              type: "object",
              properties: {
                argv: { type: "array", items: { type: "string" }, minItems: 1 },
                cwd: { type: "string" },
              },
              required: ["argv", "cwd"],
              additionalProperties: false,
            },
          },
        ],
      };
    else if (request.method === "tools/call" && request.params.name === "exec") {
      const result = await fetch(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(request.params.arguments),
        signal: AbortSignal.timeout(35000),
      });
      response = {
        content: [{ type: "text", text: await result.text() }],
        isError: result.ok === false,
      };
    } else if (request.method === "ping") response = {};
    else throw new Error("Unsupported MCP method");
    process.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", id: request.id, result: response }) + "\n",
    );
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32603, message: String(error) },
      }) + "\n",
    );
  }
}
