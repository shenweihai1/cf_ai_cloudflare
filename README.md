# Student Enrollment Agent

A chat-based student enrollment application built on [Cloudflare Agents](https://developers.cloudflare.com/agents/) with [Workers AI](https://developers.cloudflare.com/workers-ai/) (Llama 3.3 70B). Students interact with a natural-language assistant to register, browse courses, enroll, drop courses, and check their enrollment status.

## Architecture

```
┌─────────────────────┐       WebSocket (state sync)       ┌──────────────────────────┐
│   React Chat UI     │◄─────────────────────────────────► │   EnrollmentAgent        │
│   (src/app.tsx)      │       HTTP POST /chat              │   (Durable Object)       │
│                     │──────────────────────────────────► │                          │
│   useAgent hook     │       HTTP GET /history             │   ┌──────────────────┐   │
│   for real-time     │◄────────────────────────────────── │   │  SQLite Database │   │
│   state updates     │                                    │   │  - students      │   │
└─────────────────────┘                                    │   │  - courses       │   │
                                                           │   │  - enrollments   │   │
                                                           │   │  - chat_history  │   │
                                                           │   └──────────────────┘   │
                                                           │                          │
                                                           │   ┌──────────────────┐   │
                                                           │   │  Workers AI      │   │
                                                           │   │  Llama 3.3 70B   │   │
                                                           │   │  + Tool Calling  │   │
                                                           │   └──────────────────┘   │
                                                           └──────────────────────────┘
```

**Key components:**

| Component | Technology | Purpose |
|---|---|---|
| LLM | Llama 3.3 70B via Workers AI | Natural language understanding and tool selection |
| Coordination | Durable Objects (Agent class) | Stateful request handling, tool execution loop |
| User Input | React chat UI with WebSocket | Real-time chat interface |
| State/Memory | SQLite (Durable Object storage) + `setState()` | Persistent data + real-time client sync |

## Project Structure

```
├── src/
│   ├── server.ts      # EnrollmentAgent Durable Object — chat endpoint, LLM tool loop, DB schema
│   ├── tools.ts       # 5 enrollment tools (register, list, enroll, drop, check) with validation
│   ├── utils.ts       # Shared types, interfaces, constants, seed course data
│   ├── app.tsx        # React chat UI component with WebSocket state sync
│   ├── client.tsx     # React DOM entry point
│   └── styles.css     # Chat UI styling
├── tests/
│   └── tools.test.ts  # 24 unit tests for enrollment business logic
├── wrangler.jsonc     # Cloudflare Workers config (AI binding, Durable Object, migrations)
├── package.json       # Dependencies and scripts
├── tsconfig.json      # TypeScript configuration
├── vite.config.ts     # Vite + Cloudflare plugin build config
├── vitest.config.ts   # Test runner config
├── index.html         # SPA entry point
└── env.d.ts           # Generated Cloudflare environment types
```

## Prerequisites

- [Node.js](https://nodejs.org/) v18 or later
- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier works)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (included as a dev dependency)

## Getting Started

### 1. Install dependencies

```bash
npm install
```

### 2. Run locally

```bash
npm run dev
```

This starts a local development server using Vite with the Cloudflare plugin. The app will be available at `http://localhost:5173` (or the port Vite selects).

> **Note:** Local development uses Cloudflare's local runtime (`workerd`) to emulate Durable Objects and Workers AI. Workers AI calls require network access to Cloudflare's inference API, so you need an internet connection and must be logged in to Wrangler (`npx wrangler login`) for the AI binding to work locally.

### 3. Deploy to Cloudflare

```bash
npm run deploy
```

This builds the project and deploys it to your Cloudflare account. The deployed URL will be printed in the terminal.

## Usage

Once the application is running, open it in your browser. You'll see a chat interface where you can interact with the enrollment assistant in natural language.

**Example conversation:**

```
You:       Show me available courses
Assistant: Available courses:
           - CS101: Introduction to Computer Science (Instructor: Dr. Smith, Enrolled: 0/30)
           - MATH201: Linear Algebra (Instructor: Dr. Johnson, Enrolled: 0/25)
           - ENG102: English Composition (Instructor: Prof. Williams, Enrolled: 0/35)
           - PHYS101: Physics I (Instructor: Dr. Brown, Enrolled: 0/20)
           - HIST101: World History (Instructor: Prof. Davis, Enrolled: 0/40)

You:       I'd like to register. My name is Alice and my email is alice@example.com
Assistant: Student registered successfully. Student ID: STU-A1B2C3, Name: Alice, Email: alice@example.com

You:       Enroll me in CS101
Assistant: Successfully enrolled student STU-A1B2C3 (Alice) in CS101 (Introduction to Computer Science).

You:       What courses am I enrolled in?
Assistant: Enrollments for Alice (STU-A1B2C3):
           - CS101: Introduction to Computer Science (Instructor: Dr. Smith)

You:       Drop CS101
Assistant: Successfully dropped student STU-A1B2C3 from course CS101.
```

### Available Operations

The assistant understands natural language and maps requests to these operations:

| Operation | What it does | Required info |
|---|---|---|
| **Register** | Create a new student account | Name, email |
| **List courses** | Show all courses with enrollment counts | None |
| **Enroll** | Add a student to a course | Student ID, course ID |
| **Drop** | Remove a student from a course | Student ID, course ID |
| **Check enrollment** | See all courses a student is in | Student ID |

## How It Works

1. **User sends a message** via the chat UI (`POST /agents/EnrollmentAgent/default/chat`).
2. **The agent builds context** from the last 20 chat messages and sends them to Llama 3.3 with tool definitions.
3. **Llama 3.3 decides** whether to call a tool or respond directly. If it calls a tool, the agent executes it against the SQLite database.
4. **Tool results are fed back** to the LLM so it can produce a natural-language response. This loop runs up to 5 rounds.
5. **The response is saved** to chat history and returned to the client.
6. **State is synced** to all connected WebSocket clients (course list, enrolled courses).

## Development

### Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start local dev server |
| `npm run build` | Build for production |
| `npm run deploy` | Build and deploy to Cloudflare |
| `npm test` | Run unit tests |
| `npm run test:watch` | Run tests in watch mode |
| `npm run types` | Regenerate `env.d.ts` from wrangler config |

### Running Tests

```bash
npm test
```

Tests use Vitest and cover the enrollment business logic (register, enroll, drop, list, check) with 24 test cases including validation rules and edge cases. The tests use an in-memory SQL mock that simulates the Durable Object's `sql` tagged-template API.

## Seed Data

The application comes pre-loaded with 5 courses:

| Course ID | Course Name | Instructor | Capacity |
|---|---|---|---|
| CS101 | Introduction to Computer Science | Dr. Smith | 30 |
| MATH201 | Linear Algebra | Dr. Johnson | 25 |
| ENG102 | English Composition | Prof. Williams | 35 |
| PHYS101 | Physics I | Dr. Brown | 20 |
| HIST101 | World History | Prof. Davis | 40 |

## License

MIT
