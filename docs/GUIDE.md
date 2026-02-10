# Student Enrollment Agent — Codebase Guide

A beginner-friendly walkthrough of every file in this project, explaining *what* each piece does, *why* it was designed that way, and *how* all the components fit together.

## Table of Contents

1. [The Big Picture](#1-the-big-picture)
2. [How a Chat Message Flows Through the System](#2-how-a-chat-message-flows-through-the-system)
3. [Project File Map](#3-project-file-map)
4. [Configuration Files](#4-configuration-files)
5. [Source Code Walkthrough](#5-source-code-walkthrough)
6. [Tests](#6-tests)
7. [Key Design Decisions](#7-key-design-decisions)
8. [Glossary](#8-glossary)

---

## 1. The Big Picture

This application is a **chat-based student enrollment system**. A student opens a web page, types natural-language messages like "Show me available courses" or "Enroll me in CS101," and an AI assistant understands the request and carries it out.

Under the hood, three things cooperate:

| Layer | Technology | What it does |
|---|---|---|
| **Frontend** | React (single-page app) | Renders the chat UI, sends messages via HTTP, receives real-time state updates via WebSocket |
| **Backend** | Cloudflare Durable Object (`EnrollmentAgent`) | Receives messages, orchestrates the LLM, executes enrollment operations, persists data |
| **LLM** | Llama 3.3 70B on Workers AI | Reads the conversation, decides which tool to call (or responds directly), generates natural-language replies |

The backend is the brain. It runs on Cloudflare's edge network as a **Durable Object** — a small stateful server that keeps its own SQLite database and can hold WebSocket connections.

---

## 2. How a Chat Message Flows Through the System

Here is what happens when a user types "Enroll me in CS101" and presses Send:

```
1.  Browser (app.tsx)
    └─ POST /agents/EnrollmentAgent/default/chat  { message: "Enroll me in CS101" }

2.  Worker entry point (server.ts default export)
    └─ routeAgentRequest() routes to the EnrollmentAgent Durable Object

3.  EnrollmentAgent.onRequest()
    └─ Matches /chat endpoint → _handleChat()

4.  _handleChat()
    ├─ Saves user message to chat_history table
    ├─ Loads last 20 messages from chat_history
    └─ Calls _callLLM() with [system prompt, ...history]

5.  _callLLM()  — the tool-calling loop
    │
    │  Round 1:
    │  ├─ Sends messages + tool definitions to Llama 3.3 via env.AI.run()
    │  ├─ LLM returns: tool_calls: [{ name: "enroll_student", arguments: { student_id: "STU-ABC", course_id: "CS101" } }]
    │  ├─ Calls executeTool() → enrollStudent() → runs SQL INSERT + UPDATE
    │  └─ Adds tool result to messages
    │
    │  Round 2:
    │  ├─ Sends updated messages to LLM
    │  └─ LLM returns: { response: "Done! You're now enrolled in CS101." }
    │
    └─ Returns the text response

6.  _handleChat() continues
    ├─ Saves assistant message to chat_history table
    ├─ Calls _syncState() → queries courses + enrollments → setState()
    └─ Returns JSON { reply, state } to browser

7.  Browser (app.tsx)
    ├─ Appends assistant message to chat
    └─ WebSocket onStateUpdate fires → updates enrolled courses sidebar
```

The key insight is the **tool-calling loop** (step 5). The LLM doesn't just generate text — it can request that the server run functions (tools) on its behalf. The server executes those functions, feeds the results back to the LLM, and the LLM then writes a human-readable summary.

---

## 3. Project File Map

```
student-enrollment-agent/
│
├── src/                        # Application source code
│   ├── server.ts               # Backend: Durable Object agent + Worker entry point
│   ├── tools.ts                # Business logic: tool definitions + execution functions
│   ├── utils.ts                # Shared types, constants, seed data
│   ├── app.tsx                 # Frontend: React chat UI component
│   ├── client.tsx              # Frontend: React DOM mount point
│   └── styles.css              # Frontend: CSS styles
│
├── tests/
│   └── tools.test.ts           # Unit tests for enrollment logic (24 tests)
│
├── docs/
│   └── GUIDE.md                # This file
│
├── wrangler.jsonc              # Cloudflare Workers configuration
├── package.json                # NPM dependencies and scripts
├── tsconfig.json               # TypeScript compiler settings
├── vite.config.ts              # Vite build tool configuration
├── vitest.config.ts            # Vitest test runner configuration
├── index.html                  # HTML shell for the SPA
├── env.d.ts                    # Generated TypeScript environment types
├── .gitignore                  # Git exclusion rules
├── .dev.vars.example           # Example environment variables
├── README.md                   # Project overview and setup instructions
├── PROMPTS.md                  # AI prompt documentation
└── TODO.md                     # Task tracking
```

---

## 4. Configuration Files

### `wrangler.jsonc` — Cloudflare Workers Config

This is the most important config file. It tells Cloudflare how to run our application.

```jsonc
{
  "name": "student-enrollment-agent",   // Name shown in the Cloudflare dashboard
  "main": "src/server.ts",              // Entry point for the Worker
  "compatibility_date": "2025-12-17",   // Pin to this Workers runtime version
  "compatibility_flags": ["nodejs_compat"], // Enable Node.js built-ins

  "ai": { "binding": "AI" },            // Make Workers AI available as env.AI

  "assets": { "directory": "public" },   // Serve static files from public/

  "durable_objects": {
    "bindings": [{
      "name": "EnrollmentAgent",         // env.EnrollmentAgent binding name
      "class_name": "EnrollmentAgent"    // Must match the exported class name
    }]
  },

  "migrations": [{
    "tag": "v1",
    "new_sqlite_classes": ["EnrollmentAgent"]  // Enable SQLite for this DO
  }]
}
```

**Why these choices:**
- `ai.binding` gives us access to Cloudflare's hosted LLMs without API keys.
- `durable_objects` creates a stateful backend — unlike stateless Workers, a Durable Object keeps its SQLite database between requests.
- `migrations` with `new_sqlite_classes` enables the built-in SQLite feature on the Durable Object (introduced in late 2024). Without this, `this.sql` would not be available.

### `package.json` — Dependencies

Three runtime dependencies:
- **`agents`** — Cloudflare's Agents SDK. Provides the `Agent` base class, `routeAgentRequest()`, and the `useAgent` React hook.
- **`react` / `react-dom`** — The UI library.

Key dev dependencies:
- **`@cloudflare/vite-plugin`** — Integrates Vite with the Workers runtime so `npm run dev` works locally.
- **`wrangler`** — Cloudflare's CLI for deploying, running locally, and generating types.
- **`vitest`** — Test runner.

### `tsconfig.json` — TypeScript Settings

Notable settings:
- `skipLibCheck: true` — Required because `@cloudflare/workers-types` and DOM types partially conflict (e.g., both define `Request`, `Response`). Without this, the compiler would report errors in `node_modules`.
- `moduleResolution: "Bundler"` — Tells TypeScript that a bundler (Vite) will resolve imports, so it allows patterns like importing `.ts` files without extensions.
- `types: ["@cloudflare/workers-types", "node", "vite/client"]` — Brings in Cloudflare-specific globals (`Ai`, `DurableObjectNamespace`, etc.).

### `vite.config.ts` — Build Config

```ts
plugins: [cloudflare(), react()]
```

Two plugins:
1. **`cloudflare()`** — Handles the Workers runtime during development, compiles Durable Objects, and bundles the Worker for deployment.
2. **`react()`** — Enables JSX/TSX transformation and React Fast Refresh during development.

### `vitest.config.ts` — Test Config

```ts
test: {
  include: ["tests/**/*.test.ts"],
}
```

Uses standard Vitest (not `@cloudflare/vitest-pool-workers`) because our unit tests mock the SQL layer and don't need the full Workers runtime. This means tests run without Cloudflare authentication.

### `env.d.ts` — Type Declarations

Auto-generated by `wrangler types`. Declares the `Env` interface that TypeScript uses when you write `this.env.AI` or `this.env.EnrollmentAgent`. You should regenerate this file (`npm run types`) whenever you change `wrangler.jsonc`.

### `index.html` — SPA Shell

Standard single-page app HTML. The key line is:
```html
<script type="module" src="/src/client.tsx"></script>
```
Vite intercepts this during development and compiles the TSX on the fly.

---

## 5. Source Code Walkthrough

### `src/utils.ts` — Shared Types and Constants

This file defines the data model used across both frontend and backend:

**Types:**
- `Course` — A course with `id`, `name`, `instructor`, `capacity`, `enrolled_count`.
- `Student` — A student with `id`, `name`, `email`, `created_at`.
- `Enrollment` — A join record linking `student_id` to `course_id`.
- `EnrollmentState` — The lightweight state object synced to all connected clients via WebSocket. Contains the current student (if any), their enrolled course IDs, and the full course list.
- `ChatMessage` — A message in the chat (`role` is either `"user"` or `"assistant"`).

**Constants:**
- `INITIAL_STATE` — Default state for a fresh agent instance (no student, no enrollments, empty course list).
- `SEED_COURSES` — Five pre-defined courses (CS101, MATH201, ENG102, PHYS101, HIST101) that are inserted into the database on first startup.

**Why a separate utils file?** Types and constants are needed by both `server.ts` (backend) and `app.tsx` (frontend). Putting them in a shared file avoids duplication and ensures the frontend and backend always agree on data shapes.

### `src/tools.ts` — Enrollment Business Logic

This file contains two things:

1. **Tool descriptors** (`TOOL_DESCRIPTORS`) — JSON objects that describe each operation to the LLM. These are passed to Workers AI in the `tools` parameter of each inference call. The LLM reads these descriptions to decide which function to invoke.

2. **Tool execution functions** — The actual TypeScript functions that run against the database:
   - `registerStudent(sql, { name, email })` — Creates a student record. Checks for duplicate emails.
   - `listCourses(sql)` — Returns all courses with enrollment counts.
   - `enrollStudent(sql, { student_id, course_id })` — Validates student and course exist, checks capacity, prevents duplicates, then inserts an enrollment and increments the count.
   - `dropCourse(sql, { student_id, course_id })` — Verifies the enrollment exists, deletes it, decrements the count.
   - `checkEnrollment(sql, { student_id })` — JOINs enrollments with courses to list everything the student is enrolled in.
   - `executeTool(sql, name, args)` — Dispatcher that maps a tool name string to the right function.

**Why take `sql` as a parameter instead of importing it?** The `sql` tagged-template function lives on the Agent instance (`this.sql`). Passing it as a parameter makes these functions **testable** — tests can pass in a mock SQL function without needing a real Durable Object.

**Why are tool descriptors and execution functions in the same file?** They represent two sides of the same coin: the descriptor tells the LLM *what* a tool does, and the function *implements* it. Keeping them together makes it easy to add new tools.

### `src/server.ts` — The Agent (Backend Core)

This is the heart of the application. It has three parts:

#### Part 1: The system prompt and model config

```ts
const SYSTEM_PROMPT = `You are a helpful student enrollment assistant...`;
const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
```

The system prompt defines the LLM's personality and rules. It tells the model what tools are available and how to behave (be concise, confirm before acting, redirect off-topic questions). See `PROMPTS.md` for full details.

#### Part 2: The EnrollmentAgent class

```ts
export class EnrollmentAgent extends Agent<Env, EnrollmentState> { ... }
```

This extends the Agents SDK's `Agent` base class, parameterized with:
- `Env` — the environment bindings (AI, EnrollmentAgent namespace)
- `EnrollmentState` — the state type synced to clients

Key methods:

- **`onStart()`** — Runs when the Durable Object first wakes up. Creates the four SQLite tables (`students`, `courses`, `enrollments`, `chat_history`), seeds the courses if empty, and syncs state.

- **`onRequest(request)`** — HTTP request handler. Routes to:
  - `POST /chat` → `_handleChat()` — processes a user message through the LLM
  - `GET /history` → `_handleHistory()` — returns all past chat messages

- **`_handleChat(request)`** — The main flow: save the user message, build conversation context (system prompt + last 20 messages), call the LLM, save the assistant's reply, sync state, return the response.

- **`_callLLM(messages)`** — The tool-calling loop. Sends messages + tool definitions to Llama 3.3 via `env.AI.run()`. If the LLM returns `tool_calls`, it executes each one and feeds results back. This loops up to 5 times. Once the LLM returns a text `response`, that becomes the reply.

- **`_syncState()`** — Queries the database for courses and the current student's enrollments, then calls `this.setState()` to broadcast to all connected WebSocket clients.

#### Part 3: The Worker entry point

```ts
export default {
  async fetch(request, env, ctx) {
    return routeAgentRequest(request, env) || new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
```

`routeAgentRequest()` is the Agents SDK's router. It handles:
- **WebSocket connections** — URLs like `/agents/EnrollmentAgent/default` become WebSocket upgrades to the named Durable Object instance.
- **HTTP requests** — URLs like `/agents/EnrollmentAgent/default/chat` are forwarded to the Durable Object's `onRequest()` method.

The `"default"` in the URL is the instance name — all users share one Durable Object instance in this simple app.

### `src/app.tsx` — React Chat UI

The frontend is a single React component that does three things:

1. **WebSocket state sync** — The `useAgent` hook (from `agents/react`) opens a WebSocket to the Durable Object. Whenever the server calls `setState()`, the `onStateUpdate` callback fires and the UI updates the enrolled courses sidebar and course count.

2. **Chat via HTTP** — When the user presses Send, the component POSTs to `/agents/EnrollmentAgent/default/chat` and appends the response to the message list. It uses optimistic UI: the user's message appears immediately before the server responds.

3. **History loading** — On mount, a `GET /history` call loads past messages so the conversation persists across page reloads.

**Why HTTP for chat instead of WebSocket?** Workers AI responses can take a few seconds. A simple request/response pattern is easier to reason about than managing async WebSocket message ordering. The WebSocket is used only for lightweight state sync (course list updates, enrollment changes), not for chat messages.

### `src/client.tsx` — Entry Point

```ts
createRoot(document.getElementById("app")!).render(<App />);
```

Mounts the React app and imports `styles.css`. This is the file referenced by `index.html`.

### `src/styles.css` — Styling

Plain CSS with no preprocessor. Styles a mobile-friendly chat layout:
- `.chat-container` — Centered card with header, message area, sidebar, and input
- `.message.user` / `.message.assistant` — Chat bubbles aligned right/left with distinct colors
- `.message.system` — Centered yellow banner for the welcome message
- `.typing-indicator` — "Thinking..." indicator while waiting for the LLM
- `.sidebar` / `.course-tag` — Horizontal list of enrolled course badges

---

## 6. Tests

### `tests/tools.test.ts`

24 unit tests organized into 7 describe blocks:

| Block | Tests | What it covers |
|---|---|---|
| `Tool Descriptors` | 3 | Correct count, names, and structure of tool definitions |
| `registerStudent` | 2 | New registration, duplicate email rejection |
| `listCourses` | 3 | Normal listing, empty table, enrollment count display |
| `enrollStudent` | 5 | Happy path, missing student, missing course, duplicate enrollment, full course |
| `dropCourse` | 3 | Happy path, not-enrolled error, count decrement |
| `checkEnrollment` | 3 | Empty enrollments, multiple enrollments, missing student |
| `executeTool` | 3 | Dispatcher routing for known tools and unknown tool error |

**How the mock works:** Instead of running a real SQLite database, the tests use `createMockSql()` — an in-memory function that parses SQL template strings with regex and operates on plain JavaScript arrays. It supports `INSERT`, `SELECT` (with `WHERE`, `JOIN`), `UPDATE`, `DELETE`, and `COUNT(*)`. This is enough to test the enrollment logic without any external dependencies.

**Why not integration tests?** The `@cloudflare/vitest-pool-workers` package can run tests inside the Workers runtime with a real Durable Object, but it requires Cloudflare authentication. The unit tests cover the business logic thoroughly; integration testing can be added when auth is available.

---

## 7. Key Design Decisions

### Why Durable Objects instead of KV or D1?

Durable Objects give us three things in one:
1. **SQLite database** — relational data (students, courses, enrollments) with JOINs and transactions.
2. **WebSocket support** — real-time state sync to connected clients.
3. **Colocation** — the database and compute are in the same process, so queries are zero-latency.

KV is key-value only (no JOINs). D1 is a standalone database that requires network round-trips. For a small app that needs both relational data and real-time updates, Durable Objects are the simplest option.

### Why Llama 3.3 instead of GPT-4 or Claude?

Llama 3.3 70B is available through the Workers AI binding (`env.AI`), which means:
- **No API keys** — the binding is configured in `wrangler.jsonc`, no `.dev.vars` needed.
- **No external network calls** — the inference runs on Cloudflare's infrastructure.
- **Function calling support** — Llama 3.3 supports the `tools` parameter natively.

An external model could be used instead by installing an SDK (e.g., `@ai-sdk/openai`) and adding an API key to `.dev.vars`.

### Why separate state from chat history?

- **State** (`EnrollmentState`) is small, changes frequently, and is broadcast to all WebSocket clients. It contains only what the UI needs right now: course list and enrolled course IDs.
- **Chat history** is append-only, can grow large, and is stored in SQLite. Loading it happens once on page load via HTTP.

Keeping them separate prevents every message from being pushed to all clients and keeps the WebSocket payload small.

### Why a 20-message context window?

Llama 3.3 has a 24K token context window. 20 messages is a practical balance:
- Long enough for multi-turn conversations (register → browse → enroll → check)
- Short enough to fit comfortably within the token limit even with long tool-result responses

### Why pass `sql` as a function parameter?

The `Agent.sql` method is a tagged-template function bound to the Durable Object instance. Passing it as a parameter to tool functions makes the business logic **pure and testable** — tests inject a mock SQL function, and production code passes the real one via a wrapper lambda:

```ts
((strings, ...values) => this.sql(strings, ...values))
```

This lambda is needed because `this.sql.bind(this)` loses the generic type parameter.

### Why HTTP POST for chat instead of WebSocket messages?

The Workers AI call can take several seconds. Using HTTP request/response:
- Naturally handles the async wait (the fetch promise resolves when the LLM responds)
- Makes error handling straightforward (HTTP status codes)
- Avoids the complexity of correlating WebSocket request/response pairs

The WebSocket is reserved for the simpler task of pushing state updates.

---

## 8. Glossary

| Term | Meaning |
|---|---|
| **Agent** | A Durable Object that extends the Agents SDK's `Agent` class, providing built-in state management, WebSocket handling, and routing |
| **Durable Object (DO)** | A Cloudflare primitive: a stateful JavaScript object with its own storage that runs on the edge. Unlike Workers (stateless), DOs persist between requests |
| **Workers AI** | Cloudflare's hosted LLM inference service. Models are called via the `env.AI.run()` binding |
| **Function calling / Tool calling** | An LLM capability where the model can request that the host system execute a function (tool) and return the result, rather than generating a text response |
| **Tool descriptor** | A JSON Schema object that describes a tool's name, purpose, and parameters to the LLM |
| **`routeAgentRequest()`** | The Agents SDK's built-in router. Maps URLs like `/agents/<AgentName>/<instanceName>` to the correct Durable Object instance |
| **`useAgent` hook** | A React hook from `agents/react` that opens a WebSocket to an Agent and provides `onStateUpdate` callbacks |
| **`setState()`** | An Agent method that persists state to SQLite and broadcasts it to all connected WebSocket clients |
| **`this.sql`** | A tagged-template function on Agent instances that executes SQL against the Durable Object's embedded SQLite database |
| **Tagged template literal** | A JavaScript feature where a function is called with template string parts and interpolated values separately — e.g., `` sql`SELECT * FROM users WHERE id = ${id}` `` |
| **SSE** | Server-Sent Events — a streaming protocol. Used by Workers AI for streaming LLM responses (not used in this app, which uses non-streaming mode) |
| **Vite** | A fast JavaScript build tool. Used for both development (hot reload) and production builds |
| **Wrangler** | Cloudflare's CLI tool for developing, testing, and deploying Workers |
