import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Request, Response } from "express";
import { z } from "zod";
import chalk from "chalk";
import {
  currentConditions,
  forecast,
  activeAlerts,
  type ToolSuccess,
  type ToolFailure,
} from "./tools.js";

// ============================================================================
// Dev Logging Utilities
// ============================================================================

const isDev = process.env.NODE_ENV !== "production";

function timestamp(): string {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}

function formatLatency(ms: number): string {
  if (ms < 100) return chalk.green(`${ms}ms`);
  if (ms < 500) return chalk.yellow(`${ms}ms`);
  return chalk.red(`${ms}ms`);
}

function truncate(str: string, maxLen = 60): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + "...";
}

function logRequest(method: string, params?: unknown): void {
  if (!isDev) return;

  const paramsStr = params ? chalk.gray(` ${truncate(JSON.stringify(params))}`) : "";
  console.log(`${chalk.gray(`[${timestamp()}]`)} ${chalk.cyan("→")} ${method}${paramsStr}`);
}

function logResponse(method: string, result: unknown, latencyMs: number): void {
  if (!isDev) return;

  const latency = formatLatency(latencyMs);

  // For tool calls, show the result
  if (method === "tools/call" && result) {
    const resultStr = typeof result === "string" ? result : JSON.stringify(result);
    console.log(
      `${chalk.gray(`[${timestamp()}]`)} ${chalk.green("←")} ${truncate(resultStr)} ${chalk.gray(`(${latency})`)}`
    );
  } else {
    console.log(`${chalk.gray(`[${timestamp()}]`)} ${chalk.green("✓")} ${method} ${chalk.gray(`(${latency})`)}`);
  }
}

function logError(method: string, error: unknown, latencyMs: number): void {
  const latency = formatLatency(latencyMs);

  let errorMsg: string;
  if (error instanceof Error) {
    errorMsg = error.message;
  } else if (typeof error === "object" && error !== null) {
    // JSON-RPC error object has { code, message, data? }
    const rpcError = error as { message?: string; code?: number };
    errorMsg = rpcError.message || `Error ${rpcError.code || "unknown"}`;
  } else {
    errorMsg = String(error);
  }

  console.log(
    `${chalk.gray(`[${timestamp()}]`)} ${chalk.red("✖")} ${method} ${chalk.red(truncate(errorMsg))} ${chalk.gray(`(${latency})`)}`
  );
}

// ============================================================================
// MCP Server Setup
// ============================================================================

// Build a FRESH MCP server per request.
//
// In stateless streamable-HTTP mode the MCP SDK allows a Server to be connected
// to exactly ONE transport. Reusing a single module-scope instance throws
// "Already connected to a transport" on the second connection — and Cloud Run
// opens several (startup probe + real requests). So always create a new server
// (and a new transport) inside the request handler below.
function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "ec-weather-alerts",
    version: "1.0.0",
  });

  const locationSchema = z
    .string()
    .min(1)
    .describe(
      "Place to look up: a Canadian city name (e.g. 'Toronto'), 'lat,lon' coordinates (e.g. '43.65,-79.38'), or for active_alerts only a province code like 'ON'."
    );

  // Wrap a pure tool outcome into the MCP result shape.
  function toMcpResult(outcome: ToolSuccess | ToolFailure) {
    if (outcome.isError) {
      return { content: outcome.content, isError: true as const };
    }
    return {
      content: outcome.content,
      structuredContent: outcome.structuredContent,
    };
  }

  // current_conditions — ECCC city-page realtime conditions, nearest station.
  server.registerTool(
    "current_conditions",
    {
      title: "Current Conditions",
      description:
        "Live current weather conditions for a Canadian location from Environment Canada (temperature, feels-like, humidity, wind, condition, observation station).",
      inputSchema: {
        location: locationSchema,
      },
      outputSchema: {
        location_resolved: z.string(),
        temp_c: z.number().nullable(),
        feels_like_c: z.number().nullable(),
        humidity_pct: z.number().nullable(),
        wind_kph: z.number().nullable(),
        wind_direction: z.string().nullable(),
        condition: z.string(),
        observed_at: z.string().nullable(),
        station_name: z.string().nullable(),
        cached: z.boolean(),
      },
    },
    async ({ location }) => {
      const outcome = await currentConditions(location);
      return toMcpResult(outcome);
    }
  );

  // forecast — ECCC 5-day daily high/low forecast from the nearest city page.
  server.registerTool(
    "forecast",
    {
      title: "5-Day Forecast",
      description:
        "Environment Canada 5-day daily forecast (high/low in °C, condition, chance of precipitation) for a Canadian location.",
      inputSchema: {
        location: locationSchema,
      },
      outputSchema: {
        location_resolved: z.string(),
        periods: z.array(
          z.object({
            date: z.string(),
            high_c: z.number().nullable(),
            low_c: z.number().nullable(),
            condition: z.string(),
            pop_pct: z.number().nullable(),
          })
        ),
        issued_at: z.string().nullable(),
        cached: z.boolean(),
      },
    },
    async ({ location }) => {
      const outcome = await forecast(location);
      return toMcpResult(outcome);
    }
  );

  // active_alerts — live ECCC public weather alerts by location or province.
  server.registerTool(
    "active_alerts",
    {
      title: "Active Weather Alerts",
      description:
        "Currently active Environment Canada weather alerts for a Canadian location (city name or 'lat,lon'), or province-wide with a province code like 'ON'.",
      inputSchema: {
        location: locationSchema,
      },
      outputSchema: {
        alerts: z.array(
          z.object({
            event: z.string(),
            severity: z.string(),
            headline: z.string(),
            areas: z.array(z.string()),
            effective: z.string().nullable(),
            expires: z.string().nullable(),
            description: z.string(),
          })
        ),
        count: z.number(),
        cached: z.boolean(),
      },
    },
    async ({ location }) => {
      const outcome = await activeAlerts(location);
      return toMcpResult(outcome);
    }
  );

  return server;
}

// ============================================================================
// Express App Setup
// ============================================================================

const app = express();
app.use(express.json());

// Health check endpoint (required for Cloud Run)
app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({ status: "healthy" });
});

// MCP endpoint with dev logging
app.post("/mcp", async (req: Request, res: Response) => {
  const startTime = Date.now();
  const body = req.body;

  // Extract method and params from JSON-RPC request
  const method = body?.method || "unknown";
  const params = body?.params;

  // Log incoming request
  if (method === "tools/call") {
    const toolName = params?.name || "unknown";
    const toolArgs = params?.arguments;
    logRequest(`tools/call ${chalk.bold(toolName)}`, toolArgs);
  } else if (method !== "notifications/initialized") {
    logRequest(method, params);
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  // Capture response body for logging
  let responseBody = "";
  const originalWrite = res.write.bind(res) as typeof res.write;
  const originalEnd = res.end.bind(res) as typeof res.end;

  res.write = function (chunk: unknown, encodingOrCallback?: BufferEncoding | ((error: Error | null | undefined) => void), callback?: (error: Error | null | undefined) => void) {
    if (chunk) {
      responseBody += typeof chunk === "string" ? chunk : Buffer.from(chunk as ArrayBuffer).toString();
    }
    return originalWrite(chunk as string, encodingOrCallback as BufferEncoding, callback);
  };

  res.end = function (chunk?: unknown, encodingOrCallback?: BufferEncoding | (() => void), callback?: () => void) {
    if (chunk) {
      responseBody += typeof chunk === "string" ? chunk : Buffer.from(chunk as ArrayBuffer).toString();
    }

    // Log response
    if (method !== "notifications/initialized") {
      const latency = Date.now() - startTime;

      try {
        const rpcResponse = JSON.parse(responseBody) as { result?: unknown; error?: unknown };

        if (rpcResponse?.error) {
          logError(method, rpcResponse.error, latency);
        } else if (method === "tools/call") {
          const content = (rpcResponse?.result as { content?: Array<{ text?: string }> })?.content;
          const resultText = content?.[0]?.text;
          logResponse(method, resultText, latency);
        } else {
          logResponse(method, null, latency);
        }
      } catch {
        logResponse(method, null, latency);
      }
    }

    return originalEnd(chunk as string, encodingOrCallback as BufferEncoding, callback);
  };

  res.on("close", () => {
    transport.close();
  });

  // Fresh server instance per request (see createMcpServer above) — required for
  // stateless streamable-HTTP so a second connection never reuses a transport.
  const server = createMcpServer();
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// JSON error handler (Express defaults to HTML errors)
app.use((_err: unknown, _req: Request, res: Response, _next: Function) => {
  res.status(500).json({ error: "Internal server error" });
});

// ============================================================================
// Start Server
// ============================================================================

const port = parseInt(process.env.PORT || "8080");
const httpServer = app.listen(port, () => {
  console.log();
  console.log(chalk.bold("MCP Server running on"), chalk.cyan(`http://localhost:${port}`));
  console.log(`  ${chalk.gray("Health:")} http://localhost:${port}/health`);
  console.log(`  ${chalk.gray("MCP:")}    http://localhost:${port}/mcp`);

  if (isDev) {
    console.log();
    console.log(chalk.gray("─".repeat(50)));
    console.log();
  }
});

// Graceful shutdown for Cloud Run (SIGTERM before kill)
process.on("SIGTERM", () => {
  console.log("Received SIGTERM, shutting down...");
  httpServer.close(() => {
    process.exit(0);
  });
});
